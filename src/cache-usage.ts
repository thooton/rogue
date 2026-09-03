import type { Usage } from "@earendil-works/pi-ai";

/**
 * Running prompt-cache totals for one process.
 *
 * Prompt caching is invisible from the outside: a request that reuses a cached
 * prefix looks exactly like one that rewrote it, and only the usage numbers the
 * provider returns tell them apart. A Rogue that has to pay for its own thinking
 * needs that distinction reported, not assumed, so the totals are accumulated
 * from the usage on every assistant message and surfaced per cycle.
 */
export interface CacheUsageTotals {
  /** Prompt tokens billed at full price because no cached prefix matched. */
  input: number;
  output: number;
  /** Prompt tokens served from a cached prefix. */
  cacheRead: number;
  /** Prompt tokens written into the cache for later requests to reuse. */
  cacheWrite: number;
  cost: number;
  requests: number;
}

export function emptyCacheUsage(): CacheUsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, requests: 0 };
}

export function addCacheUsage(totals: CacheUsageTotals, usage: Usage | undefined): CacheUsageTotals {
  if (!usage) return totals;
  return {
    input: totals.input + usage.input,
    output: totals.output + usage.output,
    cacheRead: totals.cacheRead + usage.cacheRead,
    cacheWrite: totals.cacheWrite + usage.cacheWrite,
    cost: totals.cost + usage.cost.total,
    requests: totals.requests + 1,
  };
}

/** Share of prompt tokens that came from the cache, in `[0, 1]`. */
export function cacheHitRate(totals: CacheUsageTotals): number {
  const prompt = totals.input + totals.cacheRead + totals.cacheWrite;
  return prompt === 0 ? 0 : totals.cacheRead / prompt;
}

function count(value: number): string {
  return value.toLocaleString("en-US");
}

/**
 * One line describing what caching actually saved. Cost is omitted when the
 * provider reports none, which is the normal case for subscription and OAuth
 * routes where the meaningful number is the hit rate rather than the bill.
 */
export function formatCacheUsage(totals: CacheUsageTotals): string {
  if (totals.requests === 0) return "no model requests";
  const parts = [
    `${count(totals.cacheRead)} cached`,
    `${count(totals.input)} uncached`,
    `${count(totals.cacheWrite)} written`,
    `${Math.round(cacheHitRate(totals) * 100)}% of prompt from cache`,
  ];
  if (totals.cost > 0) parts.push(`$${totals.cost.toFixed(4)}`);
  return parts.join(" · ");
}
