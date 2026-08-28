/**
 * Sweep executors (task O1) — R2 Part A's committed architecture:
 * a `SweepExecutor` interface with two implementations,
 * `WorkerPoolExecutor` (default: dedicated module-worker pool) and
 * `TimeSlicedExecutor` (fallback: main-thread, budgeted chunks).
 *
 * Both executors are RESULT-IDENTICAL by construction: they drive the same
 * `createHeadlessRun` handle over the same pure tick sequence — the pool in
 * a worker thread via `handleWorkerMessage`, the fallback in budgeted
 * chunks between event-loop yields. Neither chunk boundaries nor worker
 * scheduling touch simulation state (R2 Part C rule 1), which the contract
 * test asserts directly.
 *
 * Cancellation: `cancel()` aborts the in-flight `run()` — the pool
 * terminates its workers and rejects immediately with
 * `SweepCancelledError`; the time-sliced executor stops at the next chunk
 * boundary (chunk <= budget, default 4 ms) and rejects the same way.
 * `cancel()` before/after a run is a no-op; a new `run()` starts fresh.
 *
 * Clock note: `performance.now`/`setTimeout` appear HERE only (budgeting is
 * harness work — explicitly allowed by R2 Part A; the sim core stays
 * wall-clock-free).
 */
import type { HeadlessRunRequest, HeadlessRunResult } from './run';
import { createHeadlessRun } from './run';
import type { WorkerInboundMessage, WorkerOutboundMessage } from './worker';

/** One unit of sweep work: a (config, rep) run to the horizon. */
export interface SweepRunRequest {
  readonly runId: number;
  readonly request: HeadlessRunRequest;
}

export interface SweepRunResult {
  readonly runId: number;
  readonly result: HeadlessRunResult;
}

export interface SweepRunCallbacks {
  /** Called once per completed run, in completion order (not runId order). */
  readonly onResult?: (result: SweepRunResult) => void;
}

export interface SweepExecutor {
  readonly name: string;
  /**
   * Execute all requests. Resolves with one result per request (any
   * completion ORDER — consumers key by runId). Rejects on the first failed
   * run, on `cancel()` (SweepCancelledError), and when the executor's
   * execution environment is unavailable.
   */
  run(requests: readonly SweepRunRequest[], callbacks?: SweepRunCallbacks): Promise<readonly SweepRunResult[]>;
  /** Abort the in-flight run (no-op when idle). */
  cancel(): void;
}

/** Rejection shape for cancelled sweeps; `completed` counts finished runs. */
export class SweepCancelledError extends Error {
  readonly completed: number;
  readonly total: number;
  constructor(completed: number, total: number) {
    super(`sweep cancelled after ${String(completed)}/${String(total)} runs`);
    this.name = 'SweepCancelledError';
    this.completed = completed;
    this.total = total;
  }
}

// ---------------------------------------------------------------------------
// Worker pool (default executor)
// ---------------------------------------------------------------------------

/** Factory seam so the pool's queue/protocol logic is testable headlessly. */
export type SweepWorkerFactory = () => Worker;

/**
 * The Vite-recommended worker construction (R2 Part A pitfalls): the
 * `new URL(...)` sits directly inside the `new Worker(...)` call and the
 * options are a static literal — never built conditionally. Vite detects
 * this pattern and emits `./worker.ts` as a separate worker chunk.
 */
function createDefaultSweepWorker(): Worker {
  return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
}

/**
 * Pool size per R2 Part A: clamp(hardwareConcurrency − 1, 2, 6) — keep one
 * logical core for the main thread (live sim + render), never fewer than 2,
 * never more than 6 (thermals/oversubscription).
 */
export function defaultWorkerPoolSize(): number {
  const reported =
    typeof navigator === 'object' &&
    navigator !== null &&
    typeof navigator.hardwareConcurrency === 'number' &&
    navigator.hardwareConcurrency > 0
      ? navigator.hardwareConcurrency
      : 4; // conservative fallback when the hint is missing
  return Math.min(6, Math.max(2, Math.floor(reported) - 1));
}

export interface WorkerPoolOptions {
  /** Worker count (default `defaultWorkerPoolSize()`, capped by the work). */
  readonly workerCount?: number;
  /** Worker factory (default: the Vite static-literal module worker). */
  readonly workerFactory?: SweepWorkerFactory;
}

export class WorkerPoolExecutor implements SweepExecutor {
  readonly name = 'worker-pool';

  private readonly workerCount: number;
  private readonly workerFactory: SweepWorkerFactory;
  private readonly usingDefaultFactory: boolean;
  private abort: (() => void) | null = null;

  constructor(options: WorkerPoolOptions = {}) {
    this.workerCount = options.workerCount ?? defaultWorkerPoolSize();
    this.workerFactory = options.workerFactory ?? createDefaultSweepWorker;
    this.usingDefaultFactory = options.workerFactory === undefined;
  }

  cancel(): void {
    if (this.abort !== null) this.abort();
  }

  run(
    requests: readonly SweepRunRequest[],
    callbacks: SweepRunCallbacks = {},
  ): Promise<readonly SweepRunResult[]> {
    if (requests.length === 0) return Promise.resolve([]);
    if (this.usingDefaultFactory && typeof Worker !== 'function') {
      return Promise.reject(
        new Error(
          'WorkerPoolExecutor: Web Workers are unavailable in this environment ' +
            '(no global Worker) — fall back to TimeSlicedExecutor (R2 Part A escape hatch)',
        ),
      );
    }
    return new Promise<readonly SweepRunResult[]>((resolve, reject) => {
      const queue = [...requests];
      const results: SweepRunResult[] = [];
      const workers: Worker[] = [];
      let settled = false;

      const settle = (finish: () => void): void => {
        if (settled) return;
        settled = true;
        this.abort = null;
        for (const worker of workers) worker.terminate();
        finish();
      };
      this.abort = () => settle(() => reject(new SweepCancelledError(results.length, requests.length)));

      const pump = (worker: Worker): void => {
        if (settled) return;
        const next = queue.shift();
        if (next === undefined) return;
        worker.postMessage({ kind: 'run', runId: next.runId, request: next.request } satisfies WorkerInboundMessage);
      };

      const spawnCount = Math.max(1, Math.min(this.workerCount, requests.length));
      for (let i = 0; i < spawnCount; i += 1) {
        const worker = this.workerFactory();
        workers.push(worker);
        worker.onmessage = (event: MessageEvent<WorkerOutboundMessage>): void => {
          if (settled) return;
          const message = event.data;
          if (message.kind === 'error') {
            settle(() => reject(new Error(`sweep worker failed on run ${String(message.runId)}: ${message.message}`)));
            return;
          }
          const result: SweepRunResult = { runId: message.runId, result: message.result };
          results.push(result);
          callbacks.onResult?.(result);
          if (results.length >= requests.length) {
            settle(() => resolve([...results]));
            return;
          }
          pump(worker);
        };
        worker.onerror = (event: ErrorEvent): void => {
          settle(() => reject(new Error(`sweep worker crashed: ${event.message}`)));
        };
        pump(worker);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Time-sliced fallback executor
// ---------------------------------------------------------------------------

export interface TimeSlicedOptions {
  /**
   * Wall-clock budget per chunk in ms (default 4 — R2 Part A's "~4 ms/frame
   * when live"). A chunk always advances AT LEAST one tick, so tiny budgets
   * degrade to one tick per yield, never to a stuck loop.
   */
  readonly chunkBudgetMs?: number;
  /** Yield seam (default: macrotask boundary via setTimeout(0)). */
  readonly yieldToEventLoop?: () => Promise<void>;
}

const defaultYieldToEventLoop = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

export class TimeSlicedExecutor implements SweepExecutor {
  readonly name = 'time-sliced';

  private readonly chunkBudgetMs: number;
  private readonly yieldToEventLoop: () => Promise<void>;
  private cancelled = false;

  constructor(options: TimeSlicedOptions = {}) {
    this.chunkBudgetMs = options.chunkBudgetMs ?? 4;
    this.yieldToEventLoop = options.yieldToEventLoop ?? defaultYieldToEventLoop;
  }

  cancel(): void {
    this.cancelled = true;
  }

  async run(
    requests: readonly SweepRunRequest[],
    callbacks: SweepRunCallbacks = {},
  ): Promise<readonly SweepRunResult[]> {
    this.cancelled = false;
    const results: SweepRunResult[] = [];
    for (const run of requests) {
      if (this.cancelled) throw new SweepCancelledError(results.length, requests.length);
      const handle = createHeadlessRun(run.request);
      while (!handle.isDone()) {
        const chunkStart = performance.now();
        do {
          handle.step();
        } while (!handle.isDone() && performance.now() - chunkStart < this.chunkBudgetMs);
        if (this.cancelled) throw new SweepCancelledError(results.length, requests.length);
        if (!handle.isDone()) await this.yieldToEventLoop();
      }
      const result: SweepRunResult = { runId: run.runId, result: handle.finish() };
      results.push(result);
      callbacks.onResult?.(result);
    }
    return results;
  }
}
