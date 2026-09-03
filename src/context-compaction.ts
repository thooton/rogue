import {
  createCompactionSummaryMessage,
  estimateContextTokens,
  estimateTokens,
  generateSummary,
  type AgentMessage,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Api, Model, Models } from "@earendil-works/pi-ai";

export const MAX_COMPACTION_THRESHOLD_TOKENS = 150_000;
export const COMPACTION_CONTEXT_RATIO = 0.75;
export const COMPACTION_RESERVE_TOKENS = 16_384;
export const COMPACTION_RECENT_TOKENS = 20_000;

export interface ContextCompactionRecord {
  createdAt: string;
  tokensBefore: number;
  thresholdTokens: number;
  summarizedMessages: number;
  retainedMessages: number;
}

/**
 * Everything needed to keep a restarted Rogue's model-facing context identical
 * to the one it had before it was killed. Without this a restart would resend
 * the whole transcript and pay to summarize it again.
 */
export interface ContextCompactionState {
  compactedThrough: number;
  summary?: string;
  summaryTokensBefore: number;
  summaryCreatedAt: number;
  records: ContextCompactionRecord[];
}

export function compactionThreshold(contextWindow: number): number {
  const modelThreshold = contextWindow > 0
    ? Math.floor(contextWindow * COMPACTION_CONTEXT_RATIO)
    : MAX_COMPACTION_THRESHOLD_TOKENS;
  return Math.min(MAX_COMPACTION_THRESHOLD_TOKENS, modelThreshold);
}

function retainedTailStart(messages: AgentMessage[], keepTokens: number): number {
  let tokens = 0;
  let start = messages.length;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    tokens += estimateTokens(messages[index]!);
    start = index;
    if (tokens >= keepTokens) break;
  }
  // Keep complete conversational turns so a tool result is never separated
  // from the assistant tool call that produced it.
  while (start > 0 && messages[start]?.role !== "user") start -= 1;
  return start;
}

export function createAutomaticContextCompactor(options: {
  models: Models;
  getModel: () => Model<Api>;
  thinkingLevel?: ThinkingLevel;
  summarize?: (messages: AgentMessage[], previousSummary: string | undefined, signal?: AbortSignal) => Promise<string>;
  /** Called whenever compaction state changes, so it can be persisted immediately. */
  onChange?: (state: ContextCompactionState) => void | Promise<void>;
}) {
  let compactedThrough = 0;
  let compactedAnchor: AgentMessage | undefined;
  let summary: string | undefined;
  let summaryTokensBefore = 0;
  let summaryCreatedAt = 0;
  const records: ContextCompactionRecord[] = [];

  const snapshot = (): ContextCompactionState => ({
    compactedThrough,
    summary,
    summaryTokensBefore,
    summaryCreatedAt,
    records: records.slice(),
  });

  const resetIfTranscriptChanged = async (messages: AgentMessage[]): Promise<void> => {
    if (compactedThrough > messages.length || (compactedAnchor && messages[compactedThrough - 1] !== compactedAnchor)) {
      compactedThrough = 0;
      compactedAnchor = undefined;
      summary = undefined;
      summaryTokensBefore = 0;
      summaryCreatedAt = 0;
      records.length = 0;
      await options.onChange?.(snapshot());
    }
  };

  const compose = (messages: AgentMessage[]): AgentMessage[] => summary
    ? [createCompactionSummaryMessage(summary, summaryTokensBefore, summaryCreatedAt), ...messages.slice(compactedThrough)]
    : messages;

  const summarize = options.summarize ?? (async (messages, previousSummary, signal) => {
    const model = options.getModel();
    const result = await generateSummary(
      messages,
      options.models,
      model,
      COMPACTION_RESERVE_TOKENS,
      signal,
      "Preserve the Rogue's identity, durable decisions, active work, network relationships, resource state, and exact next actions.",
      previousSummary,
      options.thinkingLevel,
    );
    if (!result.ok) throw result.error;
    return result.value;
  });

  return {
    records,
    snapshot,
    /**
     * Adopt persisted state from a previous process. `messages` must be the
     * transcript the state was captured against, because the compacted prefix
     * is tracked by identity of its last message.
     */
    restore(state: ContextCompactionState | undefined, messages: AgentMessage[]): void {
      compactedThrough = 0;
      compactedAnchor = undefined;
      summary = undefined;
      summaryTokensBefore = 0;
      summaryCreatedAt = 0;
      records.length = 0;
      if (!state || state.compactedThrough <= 0 || state.compactedThrough > messages.length) return;
      compactedThrough = state.compactedThrough;
      compactedAnchor = messages[compactedThrough - 1];
      summary = state.summary;
      summaryTokensBefore = state.summaryTokensBefore;
      summaryCreatedAt = state.summaryCreatedAt;
      records.push(...state.records);
    },
    thresholdTokens: () => compactionThreshold(options.getModel().contextWindow),
    async transform(messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> {
      await resetIfTranscriptChanged(messages);
      const current = compose(messages);
      const tokensBefore = estimateContextTokens(current).tokens;
      const thresholdTokens = compactionThreshold(options.getModel().contextWindow);
      if (tokensBefore < thresholdTokens) return current;

      const uncompacted = messages.slice(compactedThrough);
      const keepTokens = Math.min(COMPACTION_RECENT_TOKENS, Math.max(1_000, Math.floor(thresholdTokens / 4)));
      const tailStart = retainedTailStart(uncompacted, keepTokens);
      if (tailStart <= 0) return current;

      try {
        const messagesToSummarize = uncompacted.slice(0, tailStart);
        summary = await summarize(messagesToSummarize, summary, signal);
        summaryTokensBefore = tokensBefore;
        summaryCreatedAt = Date.now();
        compactedThrough += tailStart;
        compactedAnchor = messages[compactedThrough - 1];
        records.push({
          createdAt: new Date().toISOString(),
          tokensBefore,
          thresholdTokens,
          summarizedMessages: messagesToSummarize.length,
          retainedMessages: messages.length - compactedThrough,
        });
        await options.onChange?.(snapshot());
        return compose(messages);
      } catch {
        // transformContext must always provide a safe context. A failed summary
        // is retried on the next request rather than breaking the agent loop.
        return current;
      }
    },
  };
}
