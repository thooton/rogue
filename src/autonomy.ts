export interface AutonomousCycleResult {
  cycle: number;
  ok: boolean;
  output?: string;
  error?: string;
}

export interface AutonomousLoopOptions {
  intervalMs: number;
  maxIntervalMs?: number;
  getIntervalMs?: () => number | Promise<number>;
  maxCycles?: number;
  signal?: AbortSignal;
  runCycle: (prompt: string, cycle: number) => Promise<string | undefined>;
  onCycleStart?: (cycle: number) => void | Promise<void>;
  onCycleResult?: (result: AutonomousCycleResult) => void | Promise<void>;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export interface AutonomousLoopResult {
  attempted: number;
  completed: number;
  failed: number;
  aborted: boolean;
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

export async function runAutonomousLoop(options: AutonomousLoopOptions): Promise<AutonomousLoopResult> {
  const wait = options.wait ?? abortableWait;
  let attempted = 0;
  let completed = 0;
  let failed = 0;
  let consecutiveFailures = 0;

  while (!options.signal?.aborted && (options.maxCycles === undefined || attempted < options.maxCycles)) {
    const cycle = attempted + 1;
    attempted = cycle;
    await options.onCycleStart?.(cycle);

    let result: AutonomousCycleResult;
    try {
      const output = await options.runCycle(buildAutonomousCyclePrompt(cycle), cycle);
      completed += 1;
      consecutiveFailures = 0;
      result = { cycle, ok: true, output };
    } catch (error) {
      failed += 1;
      consecutiveFailures += 1;
      result = {
        cycle,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    await options.onCycleResult?.(result);

    if (options.signal?.aborted || (options.maxCycles !== undefined && attempted >= options.maxCycles)) break;
    const configuredInterval = options.getIntervalMs ? await options.getIntervalMs() : options.intervalMs;
    const multiplier = result.ok ? 1 : Math.min(2 ** (consecutiveFailures - 1), 8);
    // Continuous mode should not become a hot failure loop when credentials or
    // a provider are unavailable; successful cycles still have truly no delay.
    const baseInterval = !result.ok && configuredInterval === 0 ? 1_000 : configuredInterval;
    const waitMs = Math.min(baseInterval * multiplier, options.maxIntervalMs ?? Number.POSITIVE_INFINITY);
    await wait(waitMs, options.signal);
  }

  return { attempted, completed, failed, aborted: options.signal?.aborted ?? false };
}
