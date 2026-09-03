/** Base pause after a failed cycle. Successful cycles never pause. */
export const FAILURE_BACKOFF_MS = 1_000;
/** Ceiling for the failure backoff, so an agent that can run again does so soon. */
export const MAX_FAILURE_BACKOFF_MS = 60_000;

export interface AutonomousCycleRequest {
  cycle: number;
  /** Wakeup text for a new cycle; absent when an interrupted cycle is resumed. */
  prompt?: string;
  /** True when this cycle continues a transcript that a previous process left mid-turn. */
  resume: boolean;
}

export interface AutonomousCycleResult {
  cycle: number;
  ok: boolean;
  resumed: boolean;
  output?: string;
  error?: string;
}

export interface AutonomousLoopOptions {
  /** Cycle number for the first cycle this process runs. Defaults to 1. */
  startCycle?: number;
  /**
   * Consulted before each cycle. When it returns true the cycle continues an
   * unanswered turn instead of sending a new wakeup, which is what happens
   * after a restart and after a cycle the model never got to answer.
   */
  shouldResume?: () => boolean | Promise<boolean>;
  maxCycles?: number;
  failureBackoffMs?: number;
  maxFailureBackoffMs?: number;
  signal?: AbortSignal;
  runCycle: (request: AutonomousCycleRequest) => Promise<string | undefined>;
  onCycleStart?: (request: AutonomousCycleRequest) => void | Promise<void>;
  onCycleResult?: (result: AutonomousCycleResult) => void | Promise<void>;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export interface AutonomousLoopResult {
  attempted: number;
  completed: number;
  failed: number;
  aborted: boolean;
  /** Cycle number the next process should start from. */
  nextCycle: number;
}

export function buildAutonomousCyclePrompt(cycle: number): string {
  return `Autonomous wakeup #${cycle}, please continue`;
}

export async function abortableWait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0 || signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Run wake cycles back to back for as long as the process lives.
 *
 * There is no cadence to configure: a cycle ends and the next one begins. Only
 * consecutive failures pause the loop, and only so an agent whose provider is
 * unreachable waits instead of spinning; the delay is capped so it resumes
 * promptly once it can run again. A cycle the agent never answered — because
 * the provider failed, or because the previous process was killed — is retried
 * as a continuation rather than buried under another wakeup.
 */
export async function runAutonomousLoop(options: AutonomousLoopOptions): Promise<AutonomousLoopResult> {
  const wait = options.wait ?? abortableWait;
  const backoff = options.failureBackoffMs ?? FAILURE_BACKOFF_MS;
  const maxBackoff = options.maxFailureBackoffMs ?? MAX_FAILURE_BACKOFF_MS;
  let cycle = options.startCycle ?? 1;
  let attempted = 0;
  let completed = 0;
  let failed = 0;
  let consecutiveFailures = 0;

  while (!options.signal?.aborted && (options.maxCycles === undefined || attempted < options.maxCycles)) {
    const resume = (await options.shouldResume?.()) === true;
    const request: AutonomousCycleRequest = {
      cycle,
      prompt: resume ? undefined : buildAutonomousCyclePrompt(cycle),
      resume,
    };
    attempted += 1;
    await options.onCycleStart?.(request);

    let result: AutonomousCycleResult;
    try {
      const output = await options.runCycle(request);
      completed += 1;
      consecutiveFailures = 0;
      result = { cycle, ok: true, resumed: resume, output };
    } catch (error) {
      failed += 1;
      consecutiveFailures += 1;
      result = {
        cycle,
        ok: false,
        resumed: resume,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    await options.onCycleResult?.(result);
    // A failed attempt leaves the current wakeup unanswered. Retrying it is
    // still the same logical cycle, whether the retry happens now or after a
    // process restart. Advance only after the agent completed the turn.
    if (result.ok) cycle += 1;

    if (options.signal?.aborted || (options.maxCycles !== undefined && attempted >= options.maxCycles)) break;
    if (!result.ok) await wait(Math.min(backoff * 2 ** (consecutiveFailures - 1), maxBackoff), options.signal);
  }

  return { attempted, completed, failed, aborted: options.signal?.aborted ?? false, nextCycle: cycle };
}
