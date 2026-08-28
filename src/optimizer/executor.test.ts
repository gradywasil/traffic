/**
 * Sweep executor tests (task O1 acceptance):
 * - **Interface contract / result identity:** the worker pool (driven
 *   through fake `Worker` objects executing the REAL worker protocol
 *   handler) and the time-sliced fallback produce byte-identical results to
 *   each other and to a direct `executeHeadlessRun` — same candidates, same
 *   summaries, same hashes (the fallback MUST be result-identical to the
 *   pool; R2 Part A).
 * - **Worker wiring, honestly scoped:** vitest's node environment has no
 *   `Worker` global and cannot load a TS module worker (extension-less ESM
 *   imports), so the real `new Worker(new URL('./worker.ts',
 *   import.meta.url), { type: 'module' })` construction is exercised by the
 *   production build (Vite emits the worker chunk — validated in the
 *   production-log build evidence), while these tests drive the pool's
 *   queueing/protocol/cancellation through the real `handleWorkerMessage`.
 *   The default factory's node behavior (clear rejection pointing at the
 *   fallback) is asserted directly.
 * - **Cancellation** for both executors; chunking/yield behavior of the
 *   time-sliced path; error propagation.
 */
import { describe, expect, it } from 'vitest';
import type { IntersectionConfig } from '../config';
import { createDefaultConfig } from '../config';
import { greenSplitSpace } from './candidates';
import type { SweepRunRequest, SweepRunResult } from './executor';
import { SweepCancelledError } from './executor';
import { TimeSlicedExecutor } from './executor';
import { WorkerPoolExecutor, defaultWorkerPoolSize } from './executor';
import { executeHeadlessRun } from './run';
import type { HeadlessRunResult } from './run';
import type { WorkerInboundMessage, WorkerOutboundMessage } from './worker';
import { handleWorkerMessage } from './worker';

// ---------------------------------------------------------------------------
// Fake worker: implements the Worker surface the pool uses, running the REAL
// protocol handler. 'immediate' answers via a microtask (async like a real
// worker); 'buffered' holds messages until the test flushes (cancellation
// control).
// ---------------------------------------------------------------------------

class FakeSweepWorker {
  onmessage: ((event: { data: WorkerOutboundMessage }) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  posted: WorkerInboundMessage[] = [];
  private readonly inbox: WorkerInboundMessage[] = [];

  constructor(private readonly mode: 'immediate' | 'buffered' = 'immediate') {}

  postMessage(message: WorkerInboundMessage): void {
    this.posted.push(message);
    if (this.mode === 'immediate') {
      const reply = handleWorkerMessage(message);
      queueMicrotask(() => {
        if (!this.terminated) this.onmessage?.({ data: reply });
      });
    } else {
      this.inbox.push(message);
    }
  }

  /** Buffered mode only: deliver `count` queued messages synchronously. */
  flush(count = Number.POSITIVE_INFINITY): void {
    let delivered = 0;
    while (delivered < count && this.inbox.length > 0) {
      const message = this.inbox.shift();
      if (message === undefined) break;
      const reply = handleWorkerMessage(message);
      this.onmessage?.({ data: reply });
      delivered += 1;
    }
  }

  terminate(): void {
    this.terminated = true;
  }
}

const fakeWorkerFactory = (mode: 'immediate' | 'buffered', log?: FakeSweepWorker[]) => () => {
  const worker = new FakeSweepWorker(mode);
  log?.push(worker);
  return worker as unknown as Worker;
};

function smallSweepRequests(config: IntersectionConfig, candidateCount: number, reps: number, horizonSeconds: number): SweepRunRequest[] {
  const space = greenSplitSpace(config);
  const candidates = space.candidates.slice(0, candidateCount);
  const requests: SweepRunRequest[] = [];
  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    for (let repIndex = 0; repIndex < reps; repIndex += 1) {
      const candidate = candidates[candidateIndex];
      if (candidate === undefined) throw new Error('missing candidate');
      requests.push({
        runId: requests.length,
        request: {
          config: { ...config, control: { type: 'signal', plan: candidate.plan } },
          masterSeed: 20260827,
          repIndex,
          horizonSeconds,
        },
      });
    }
  }
  return requests;
}

const byRunId = (results: readonly SweepRunResult[]): HeadlessRunResult[] =>
  [...results].sort((a, b) => a.runId - b.runId).map((entry) => entry.result);

describe('worker protocol (real handler)', () => {
  it('executes a run and returns {runId, result}; imports of worker.ts are side-effect free under node', () => {
    const request = smallSweepRequests(createDefaultConfig(), 1, 1, 5)[0] as SweepRunRequest;
    const reply = handleWorkerMessage({ kind: 'run', runId: request.runId, request: request.request });
    expect(reply.kind).toBe('result');
    if (reply.kind !== 'result') return;
    expect(reply.runId).toBe(0);
    expect(reply.result.ticksRun).toBe(50);
    expect(reply.result.runHash).toMatch(/^[0-9a-f]{8}:[0-9a-f]{8}$/);
  });

  it('reports failures as {kind: "error"} without throwing', () => {
    const config = createDefaultConfig();
    const reply = handleWorkerMessage({
      kind: 'run',
      runId: 3,
      request: { config, masterSeed: 1, repIndex: 0, horizonSeconds: 10.05 },
    });
    expect(reply).toMatchObject({ kind: 'error', runId: 3 });
    expect(reply.kind === 'error' && reply.message).toMatch(/tick grid/);
  });
});

describe('executor interface contract (result identity)', () => {
  const config = createDefaultConfig();
  const requests = smallSweepRequests(config, 3, 2, 8); // 3 candidates × 2 reps, 80 ticks each

  // Explicit timeouts (Q2 test-infra hardening, Q1 precedent): these run the
  // full executor paths over the request set; under the suite's file
  // parallelism a worker can be descheduled for seconds (observed > 5 s on
  // this 4P+4E machine), which the 5 s default misreads as a failure.
  it('worker pool (real protocol handler) ≡ direct execution', { timeout: 60_000 }, async () => {
    const direct = requests.map((run) => executeHeadlessRun(run.request));
    const pool = new WorkerPoolExecutor({ workerFactory: fakeWorkerFactory('immediate'), workerCount: 3 });
    const results = await pool.run(requests);
    expect(results.length).toBe(requests.length);
    expect(byRunId(results)).toEqual(direct);
  });

  it('time-sliced fallback ≡ worker pool ≡ direct (chunking never changes results)', { timeout: 60_000 }, async () => {
    const direct = requests.map((run) => executeHeadlessRun(run.request));
    const pool = new WorkerPoolExecutor({ workerFactory: fakeWorkerFactory('immediate'), workerCount: 2 });
    const sliced = new TimeSlicedExecutor({ chunkBudgetMs: 0, yieldToEventLoop: () => Promise.resolve() });
    const [poolResults, slicedResults] = await Promise.all([
      pool.run(requests),
      sliced.run([...requests].reverse()), // even the request ORDER may differ
    ]);
    expect(byRunId(poolResults)).toEqual(direct);
    expect(byRunId(slicedResults)).toEqual(direct);
  });

  it('time-sliced chunking actually yields (one tick per chunk at zero budget)', async () => {
    let yields = 0;
    const sliced = new TimeSlicedExecutor({ chunkBudgetMs: 0, yieldToEventLoop: () => { yields += 1; return Promise.resolve(); } });
    const results = await sliced.run(smallSweepRequests(config, 2, 1, 5));
    expect(results.length).toBe(2);
    expect(yields).toBe(2 * 50 - 2); // every tick except each run's final one
  });

  it('pool fans out across workers and reports every result exactly once', async () => {
    const seen: number[] = [];
    const pool = new WorkerPoolExecutor({ workerFactory: fakeWorkerFactory('immediate'), workerCount: 4 });
    const results = await pool.run(requests, { onResult: (result) => seen.push(result.runId) });
    expect(seen.length).toBe(requests.length);
    expect(new Set(seen).size).toBe(requests.length);
    expect(results.map((r) => r.runId).sort((a, b) => a - b)).toEqual([...requests.keys()]);
  });
});

describe('cancellation', () => {
  it('pool: terminates workers, rejects with SweepCancelledError, counts completed runs', async () => {
    const workers: FakeSweepWorker[] = [];
    const executor = new WorkerPoolExecutor({ workerFactory: fakeWorkerFactory('buffered', workers), workerCount: 2 });
    const requests = smallSweepRequests(createDefaultConfig(), 4, 2, 6); // 8 runs
    let results = 0;
    const promise = executor.run(requests, { onResult: () => { results += 1; } });
    expect(workers.length).toBe(2);
    (workers[0] as FakeSweepWorker).flush(1); // exactly one run completes (synchronously)
    executor.cancel();
    const error = await promise.then(
      () => null,
      (thrown: unknown) => (thrown instanceof SweepCancelledError ? thrown : null),
    );
    expect(error).not.toBeNull();
    expect(error?.completed).toBe(1);
    expect(error?.total).toBe(8);
    expect(workers.every((worker) => worker.terminated)).toBe(true);
    // Results landing after cancellation are ignored (workers terminated).
    (workers[1] as FakeSweepWorker).flush();
    expect(results).toBe(1);
  });

  it('time-sliced: stops at the next chunk boundary and rejects with the completed count', async () => {
    const requests = smallSweepRequests(createDefaultConfig(), 3, 1, 4); // 3 runs × 40 ticks
    let yields = 0;
    // Cancel from inside the yield seam — the executor notices right after
    // (self-capture: the closure runs long after the binding initializes).
    const executor = new TimeSlicedExecutor({
      chunkBudgetMs: 0,
      yieldToEventLoop: () => {
        yields += 1;
        if (yields === 5) executor.cancel();
        return Promise.resolve();
      },
    });
    const outcomes: number[] = [];
    const error = await executor.run(requests, { onResult: (result) => outcomes.push(result.runId) }).then(
      () => null,
      (thrown: unknown) => (thrown instanceof SweepCancelledError ? thrown : null),
    );
    expect(error).not.toBeNull();
    expect(error?.completed).toBe(0); // mid-first-run cancellation
    expect(yields).toBeLessThanOrEqual(6); // stopped at the boundary after the 5th yield (+1 chunk)
    expect(outcomes.length).toBe(0);
  });

  it('cancel() when idle is a no-op; a later run() starts fresh', async () => {
    const executor = new TimeSlicedExecutor({ chunkBudgetMs: 0, yieldToEventLoop: () => Promise.resolve() });
    executor.cancel(); // idle — must not poison the next run
    const results = await executor.run(smallSweepRequests(createDefaultConfig(), 1, 1, 3));
    expect(results.length).toBe(1);
  });
});

describe('failure propagation', () => {
  it('pool rejects when a worker reports an error for a run', async () => {
    const executor = new WorkerPoolExecutor({ workerFactory: fakeWorkerFactory('immediate'), workerCount: 1 });
    const config = createDefaultConfig();
    await expect(
      executor.run([{ runId: 9, request: { config, masterSeed: 1, repIndex: 0, horizonSeconds: 10.05 } }]),
    ).rejects.toThrow(/run 9.*tick grid/);
  });

  it('time-sliced propagates run failures (invalid config rejected up front)', async () => {
    const executor = new TimeSlicedExecutor({ chunkBudgetMs: 1, yieldToEventLoop: () => Promise.resolve() });
    const base = createDefaultConfig();
    if (base.control.type !== 'signal') throw new Error('unreachable');
    const bad: IntersectionConfig = {
      ...base,
      control: {
        type: 'signal',
        plan: {
          ...base.control.plan,
          phases: [
            { kind: 'ns-through-right' as const, greenSeconds: 2 },
            { kind: 'ew-through-right' as const, greenSeconds: 50 },
          ],
        },
      },
    };
    await expect(executor.run([{ runId: 0, request: { config: bad, masterSeed: 1, repIndex: 0, horizonSeconds: 5 } }])).rejects.toThrow(
      /invalid/,
    );
  });
});

describe('environment capability', () => {
  // Under vitest's node environment there is no Worker global — the default
  // factory must fail LOUDLY with the fallback named (O2 catches this and
  // uses TimeSlicedExecutor). In a browser this test simply doesn't run.
  it.runIf(typeof Worker === 'undefined')('default factory rejects with the fallback pointer when Workers are unavailable', async () => {
    const executor = new WorkerPoolExecutor();
    await expect(executor.run(smallSweepRequests(createDefaultConfig(), 1, 1, 3))).rejects.toThrow(
      /Web Workers are unavailable.*TimeSlicedExecutor/s,
    );
  });

  it('pool size follows clamp(hardwareConcurrency − 1, 2, 6)', () => {
    // Node 24 exposes navigator.hardwareConcurrency; assert the clamp shape
    // against the real navigator (the fallback path is covered implicitly).
    const size = defaultWorkerPoolSize();
    expect(size).toBeGreaterThanOrEqual(2);
    expect(size).toBeLessThanOrEqual(6);
    if (typeof navigator === 'object' && navigator !== null && typeof navigator.hardwareConcurrency === 'number' && navigator.hardwareConcurrency > 1) {
      expect(size).toBe(Math.min(6, Math.max(2, navigator.hardwareConcurrency - 1)));
    }
  });
});
