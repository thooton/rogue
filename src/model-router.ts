import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type Model,
  type Models,
  type SimpleStreamOptions,
  type Api,
} from "@earendil-works/pi-ai";
import type { RogueConfigStore } from "./config.js";

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
  onFailover?: (notice: ModelFailoverNotice) => void;
}) {
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
        const source = options.models.streamSimple(model, context, streamOptions);
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
