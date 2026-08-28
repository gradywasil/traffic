/**
 * Sweep-service tests (task O2 acceptance): the orchestration the optimizer
 * UI sits on —
 * - current-plan baseline: reused from the report when the current greens
 *   lie on the swept lattice ('in-report', no extra executor phase),
 *   measured as one extra paired candidate when they do not
 *   ('dedicated-run', one more executor.run phase);
 * - progress rebasing across phases (coarse → refine → baseline) is
 *   monotonic in `completed` and ends at `total`;
 * - cancellation propagates from `service.cancel()` to the active executor;
 * - the runtime worker fallback: a pre-progress environment failure re-runs
 *   once on the fallback executor; failures after progress and
 *   cancellations propagate unchanged.
 *
 * All sweeps run on scripted mock executors (the O1 contract surface), so
 * these tests are instant and deterministic.
 */
import { describe, expect, it } from 'vitest';
import type { IntersectionConfig } from '../../config';
import { createDefaultConfig } from '../../config';
import { getPreset } from '../../presets';
import type { SweepExecutor, SweepRunRequest } from '../../optimizer';
import { SweepCancelledError } from '../../optimizer';
import type { HeadlessRunResult } from '../../optimizer';
import { createOptimizerSweepService } from './sweep-service';
import type { OptimizerSweepProgress } from './sweep-service';

// ---------------------------------------------------------------------------
// Scripted mock executor (per-run deterministic objective, cancel-aware)
// ---------------------------------------------------------------------------

interface ScriptOptions {
  /** Delay seconds for a (candidateId, repIndex); default: greens sum × 0.1. */
  readonly delayFor?: (candidateId: string, repIndex: number, greens: readonly number[]) => number | null;
  /** Thrown from run() when set (environment / pairing failures). */
  readonly failWith?: Error;
  /** Reject with SweepCancelledError as soon as cancel() is called. */
  readonly cancelable?: boolean;
}

function runSummary(delay: number | null): HeadlessRunResult['runSummary'] {
  return {
    elapsedSeconds: 10,
    tripCount: delay === null ? 0 : 5,
    meanControlDelaySeconds: delay,
    meanStoppedSeconds: delay === null ? null : 1,
    throughputVehPerHour: delay === null ? null : 100,
    maxQueueCars: 2,
    maxQueuePerChain: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  };
}

class ScriptedExecutor implements SweepExecutor {
  readonly name: string;
  readonly runCount: number[] = []; // requests per run() call
  private cancelled = false;

  constructor(
    private readonly script: ScriptOptions = {},
    name = 'scripted',
  ) {
    this.name = name;
  }

  cancel(): void {
    this.cancelled = true;
  }

  async run(
    requests: readonly SweepRunRequest[],
    callbacks: { onResult?: (result: { runId: number; result: HeadlessRunResult }) => void } = {},
  ): Promise<readonly { runId: number; result: HeadlessRunResult }[]> {
    if (this.script.failWith) throw this.script.failWith;
    this.runCount.push(requests.length);
    const results: { runId: number; result: HeadlessRunResult }[] = [];
    for (const run of requests) {
      // One microtask per request — real executors never finish a sweep
      // inside the caller's synchronous slice, and the cancellation seam
      // below needs that asynchrony to be observable.
      await Promise.resolve();
      if (this.script.cancelable && this.cancelled) {
        throw new SweepCancelledError(results.length, requests.length);
      }
      const control = run.request.config.control;
      if (control.type !== 'signal') throw new Error('scripted executor requires signal configs');
      const greens = control.plan.phases.map((phase) => phase.greenSeconds);
      const candidateId = `g:${greens.join('+')}`;
      const delay =
        this.script.delayFor?.(candidateId, run.request.repIndex, greens) ??
        greens.reduce((sum, green) => sum + green, 0) * 0.1;
      const result: HeadlessRunResult = {
        runSummary: runSummary(delay),
        spawnDigestHex: `digest:${String(run.request.repIndex)}`,
        runHash: `hash:${candidateId}:${String(run.request.repIndex)}`,
        ticksRun: 100,
      };
      results.push({ runId: run.runId, result });
      callbacks.onResult?.({ runId: run.runId, result });
    }
    return results;
  }
}

/** Fails on first run (simulates workers unavailable/blocked at runtime). */
class FailingFirstRunExecutor extends ScriptedExecutor {
  constructor(message = 'WorkerPoolExecutor: Web Workers are unavailable in this environment') {
    super({ failWith: new Error(message) }, 'failing-pool');
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('optimizer sweep service — current-plan baseline', () => {
  it('reuses the report row when the current plan lies on the swept lattice (no extra phase)', async () => {
    // Default config is 2-phase with greens 26+26 — on the step-1 lattice.
    const config = createDefaultConfig();
    const executor = new ScriptedExecutor({}, 'primary');
    const service = createOptimizerSweepService({ createExecutor: () => executor });
    const outcome = await service.run(config, () => {});
    expect(executor.runCount).toHaveLength(1); // coarse only (2-phase: no refine, no dedicated run)
    expect(outcome.current.measured).toBe('in-report');
    const row = outcome.report.ranked.find((entry) => entry.candidate.id === 'g:26+26');
    expect(row).toBeDefined();
    expect(outcome.current.candidateId).toBe('g:26+26');
    expect(outcome.current.greens).toEqual([26, 26]);
    expect(outcome.current.meanControlDelaySeconds).toBe(row?.meanControlDelaySeconds);
    expect(outcome.report.executorName).toBe('primary');
  });

  it('measures an off-lattice current plan as one extra paired candidate (dedicated run)', async () => {
    // Balanced is 4-phase; its greens 7+15+7+14 are NOT on the step-5 lattice.
    const balanced = getPreset('balanced').config;
    const executor = new ScriptedExecutor({}, 'primary');
    const service = createOptimizerSweepService({
      createExecutor: () => executor,
      tuning: { reps: 2, horizonSeconds: 10 },
    });
    const outcome = await service.run(balanced, () => {});
    // coarse + refine + dedicated current-plan run
    expect(executor.runCount.length).toBe(3);
    const dedicatedRequests = executor.runCount[2];
    expect(dedicatedRequests).toBe(2); // one candidate × 2 reps
    expect(outcome.current.measured).toBe('dedicated-run');
    expect(outcome.current.candidateId).toBe('g:7+15+7+14');
    expect(outcome.current.meanControlDelaySeconds).not.toBeNull();
    // The current plan is NOT one of the ranked candidates.
    expect(outcome.report.ranked.some((entry) => entry.candidate.id === 'g:7+15+7+14')).toBe(false);
  });

  it('rejects non-signal configs up front without touching the executor', async () => {
    const stop: IntersectionConfig = { ...createDefaultConfig(), control: { type: 'all-way-stop' } };
    const executor = new ScriptedExecutor();
    const service = createOptimizerSweepService({ createExecutor: () => executor });
    await expect(service.run(stop, () => {})).rejects.toThrow(/signal/);
    expect(executor.runCount).toHaveLength(0);
  });
});

describe('optimizer sweep service — progress rebasing', () => {
  it('emits monotonic completed counts across phases, ending at total', async () => {
    const balanced = getPreset('balanced').config;
    const executor = new ScriptedExecutor();
    const service = createOptimizerSweepService({
      createExecutor: () => executor,
      tuning: { reps: 2, horizonSeconds: 10 },
    });
    const events: OptimizerSweepProgress[] = [];
    const outcome = await service.run(balanced, (progress) => events.push(progress));
    expect(events.length).toBeGreaterThan(0);
    for (let i = 1; i < events.length; i += 1) {
      const previous = events[i - 1];
      const current = events[i];
      if (previous === undefined || current === undefined) throw new Error('unreachable');
      expect(current.completed).toBeGreaterThanOrEqual(previous.completed);
    }
    const last = events[events.length - 1];
    if (last === undefined) throw new Error('no events');
    expect(last.completed).toBe(last.total);
    // Every phase's full extent is counted: total = report runs + dedicated reps.
    expect(last.total).toBe(outcome.report.totalRuns + 2);
  });
});

describe('optimizer sweep service — cancellation', () => {
  it('forwards cancel() to the active executor and propagates SweepCancelledError', async () => {
    const executor = new ScriptedExecutor({ cancelable: true }, 'cancelable');
    const service = createOptimizerSweepService({ createExecutor: () => executor });
    const attempt = service.run(createDefaultConfig(), () => {});
    service.cancel(); // synchronously after start, mid-microtask-processing
    await expect(attempt).rejects.toBeInstanceOf(SweepCancelledError);
  });

  it('cancel() is a no-op when idle', () => {
    const executor = new ScriptedExecutor({ cancelable: true });
    const service = createOptimizerSweepService({ createExecutor: () => executor });
    expect(() => service.cancel()).not.toThrow();
  });
});

describe('optimizer sweep service — runtime fallback to time-slicing', () => {
  it('retries once on the fallback executor when the primary fails before any progress', async () => {
    const primary = new FailingFirstRunExecutor();
    const fallback = new ScriptedExecutor({}, 'fallback');
    let fallbackCreated = false;
    const service = createOptimizerSweepService({
      createExecutor: () => primary,
      createFallbackExecutor: () => {
        fallbackCreated = true;
        return fallback;
      },
    });
    const outcome = await service.run(createDefaultConfig(), () => {});
    expect(fallbackCreated).toBe(true);
    expect(fallback.runCount.length).toBeGreaterThanOrEqual(1);
    expect(outcome.report.executorName).toBe('fallback');
    expect(outcome.current.measured).toBe('in-report');
  });

  it('propagates the original error when the primary already made progress', async () => {
    // Make progress (some results), then blow up mid-run.
    let runs = 0;
    const primary: SweepExecutor = {
      name: 'progress-then-fail',
      cancel() {},
      async run(requests, callbacks = {}) {
        runs += 1;
        const [first] = requests;
        if (first === undefined) throw new Error('empty');
        const result: HeadlessRunResult = {
          runSummary: runSummary(1),
          spawnDigestHex: 'd:d',
          runHash: 'h:0',
          ticksRun: 10,
        };
        callbacks.onResult?.({ runId: first.runId, result });
        throw new Error('sim core exploded mid-run');
      },
    };
    let fallbackCreated = false;
    const service = createOptimizerSweepService({
      createExecutor: () => primary,
      createFallbackExecutor: () => {
        fallbackCreated = true;
        return new ScriptedExecutor();
      },
    });
    await expect(service.run(createDefaultConfig(), () => {})).rejects.toThrow(/sim core exploded/);
    expect(fallbackCreated).toBe(false);
    expect(runs).toBeGreaterThan(0);
  });

  it('never falls back for cancellations (even with zero progress)', async () => {
    const primary = new ScriptedExecutor({ failWith: new SweepCancelledError(0, 6) }, 'primary');
    let fallbackCreated = false;
    const service = createOptimizerSweepService({
      createExecutor: () => primary,
      createFallbackExecutor: () => {
        fallbackCreated = true;
        return new ScriptedExecutor();
      },
    });
    await expect(service.run(createDefaultConfig(), () => {})).rejects.toBeInstanceOf(SweepCancelledError);
    expect(fallbackCreated).toBe(false);
  });
});
