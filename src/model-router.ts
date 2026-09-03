import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type CacheRetention,
  type Context,
  type Model,
  type Models,
  type SimpleStreamOptions,
  type Api,
} from "@earendil-works/pi-ai";
import type { RogueConfigStore } from "./config.js";

/**
 * Prompt cache retention requested for every agent request.
 *
 * A Rogue sends the same growing prefix — system prompt, tool definitions, and
 * an append-only transcript — on every request it ever makes, so the prefix is
 * worth keeping cached. Pi defaults to "short", which is a five-minute
 * Anthropic TTL: long enough for back-to-back turns, but not for a slow tool
 * call, a failure backoff, or a restart, and those are exactly the gaps an
 * unattended agent hits. "long" asks for the longest retention each provider
 * offers (Anthropic `cache_control.ttl: "1h"`, OpenAI `prompt_cache_retention:
 * "24h"`) so the prefix survives them.
 */
export const DEFAULT_CACHE_RETENTION: CacheRetention = "long";

const RECOVERABLE = /credit|quota|billing|payment|402|429|rate.?limit|overload|unavailable|timeout|timed out|network|fetch failed|authentication|api.?key|token expired/i;

export interface ModelFailoverNotice {
  from: string;
  to: string;
  reason: string;
}

export interface ModelRouteAttempt {
  route: string;
  reason: string;
}

function describe(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}

/**
 * Every route in the chain failed. The terminal error only names the last
 * provider tried, which hides the failure that started the failover, so the
 * surfaced message lists each attempt in the order it was made.
 */
function summarizeAttempts(attempts: ModelRouteAttempt[]): string {
  if (attempts.length === 1) return attempts[0]!.reason;
  const detail = attempts.map((attempt) => `${attempt.route}: ${attempt.reason}`).join(" · ");
  return `All ${attempts.length} model routes failed · ${detail}`;
}

function withErrorMessage(message: AssistantMessage, errorMessage: string): AssistantMessage {
  return { ...message, errorMessage };
}

function setupErrorMessage(model: Model<Api>, errorMessage: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage,
    timestamp: Date.now(),
  };
}

export function createFailoverStream(options: {
  models: Models;
  config: RogueConfigStore;
  primary: Model<Api>;
  /** When false, only the primary route is used and configured fallbacks are ignored. */
  allowFailover?: boolean;
  /** Prompt cache retention requested per route. Defaults to {@link DEFAULT_CACHE_RETENTION}. */
  cacheRetention?: CacheRetention;
  onFailover?: (notice: ModelFailoverNotice) => void;
}) {
  const cacheRetention = options.cacheRetention ?? DEFAULT_CACHE_RETENTION;
  return (_requestedModel: Model<Api>, context: Context, streamOptions?: SimpleStreamOptions) => {
    const output = createAssistantMessageEventStream();
    void (async () => {
      const candidates: Model<Api>[] = [options.primary];
      if (options.allowFailover !== false) {
        for (const route of await options.config.listProviders()) {
          const model = options.models.getModel(route.provider, route.model);
          if (!model) continue;
          if (candidates.some((existing) => existing.provider === model.provider && existing.id === model.id)) continue;
          candidates.push(model);
        }
      }

      const attempts: ModelRouteAttempt[] = [];
      for (let index = 0; index < candidates.length; index += 1) {
        const model = candidates[index]!;
        const buffered: AssistantMessageEvent[] = [];
        // Every agent request funnels through here, so this is the one place
        // that has to ask for caching. An explicit caller preference wins; the
        // agent loop never sets one, which is why Pi's "short" default would
        // otherwise apply to every request a Rogue makes.
        const source = options.models.streamSimple(model, context, {
          ...streamOptions,
          cacheRetention: streamOptions?.cacheRetention ?? cacheRetention,
        });
        for await (const event of source) buffered.push(event);
        const terminal = buffered.at(-1);
        if (terminal?.type !== "error") {
          for (const event of buffered) output.push(event);
          return;
        }
        const reason = terminal.error.errorMessage ?? "provider request failed";
        attempts.push({ route: describe(model), reason });
        const next = candidates[index + 1];
        if (!next || terminal.reason === "aborted" || !RECOVERABLE.test(reason)) {
          for (const event of buffered.slice(0, -1)) output.push(event);
          output.push({
            ...terminal,
            error: withErrorMessage(terminal.error, summarizeAttempts(attempts)),
          });
          return;
        }
        const notice = {
          from: describe(model),
          to: describe(next),
          reason,
        };
        await options.config.recordFailover(notice);
        options.onFailover?.(notice);
        context.messages.push({
          role: "user",
          content: [{
            type: "text",
            text: `[Rogue runtime notice: ${notice.from} became unavailable (${reason}). The system is falling back to ${notice.to}. Continue the preceding task and account for this provider change.]`,
          }],
          timestamp: Date.now(),
        });
      }
    })().catch((error: unknown) => {
      // The router itself failed. Terminate the stream rather than reissuing the
      // request, which would bill a second call and race events into this stream.
      const reason = error instanceof Error ? error.message : String(error);
      output.push({
        type: "error",
        reason: "error",
        error: setupErrorMessage(options.primary, `Rogue model router failed: ${reason}`),
      });
    });
    return output;
  };
}
