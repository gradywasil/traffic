/**
 * Sweep orchestration tests (task O1 acceptance):
 * - ranking correctness hand-verified on a scripted mock objective (mean of
 *   rep means, sample variance, null-ranking, id tiebreak);
 * - paired-seed assertion (identical spawnDigest across candidates per rep;
 *   violation throws; different reps differ) — end-to-end on the real sim;
 * - progress reporting (completed/total, monotonic);
 * - cancellation propagation; invalid candidate rejection;
 * - determinism: identical full sweeps ⇒ identical reports;
 * - two-stage default sweep on a 4-phase preset (coarse + refine, bounded).
 */
import { describe, expect, it } from 'vitest';
import type { IntersectionConfig } from '../config';
import { createDefaultConfig } from '../config';
import { getPreset } from '../presets';
import { greenSplitSpace } from './candidates';
import type { SweepCandidate } from './candidates';
import type { SweepExecutor, SweepRunRequest } from './executor';
import { SweepCancelledError } from './executor';
import { TimeSlicedExecutor } from './executor';
import type { HeadlessRunResult } from './run';
import { PairingViolationError } from './sweep';
import { runDefaultSweep } from './sweep';
import { runSweep } from './sweep';
import type { SweepProgress, SweepReport } from './sweep';

// ---------------------------------------------------------------------------
// Mock executor: scripted per-run results (the "scripted mock objective")
// ---------------------------------------------------------------------------

interface MockScript {
  /** Delay seconds per rep for each candidate key (candidate id). */
  readonly delays: ReadonlyMap<string, readonly (number | null)[]>;
  readonly spawnDigest?: (repIndex: number, candidateId: string) => string;
  readonly failWith?: Error;
}

function mockRunSummary(meanDelay: number | null): HeadlessRunResult['runSummary'] {
  return {
    elapsedSeconds: 10,
    tripCount: meanDelay === null ? 0 : 5,
    meanControlDelaySeconds: meanDelay,
    meanStoppedSeconds: meanDelay === null ? null : 1,
    throughputVehPerHour: meanDelay === null ? null : 100,
    maxQueueCars: 2,
    maxQueuePerChain: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  };
}

class MockExecutor implements SweepExecutor {
  readonly name = 'mock';
  readonly progressLog: SweepProgress[] = [];
  readonly seenRequests: SweepRunRequest[] = [];

  constructor(private readonly script: MockScript) {}

  cancel(): void {
    // cancellation path is covered via failWith / real executors
  }

  async run(
    requests: readonly SweepRunRequest[],
    callbacks: { onResult?: (result: { runId: number; result: HeadlessRunResult }) => void } = {},
  ): Promise<readonly { runId: number; result: HeadlessRunResult }[]> {
    if (this.script.failWith) throw this.script.failWith;
    const results: { runId: number; result: HeadlessRunResult }[] = [];
    for (const run of requests) {
      this.seenRequests.push(run);
      const control = run.request.config.control;
      if (control.type !== 'signal') throw new Error('mock executor requires signal configs');
      const candidateId = `g:${control.plan.phases.map((phase) => phase.greenSeconds).join('+')}`;
      const delays = this.script.delays.get(candidateId);
      const repDelays = delays ?? [null];
      const delay = repDelays[run.request.repIndex] ?? null;
      const digest =
        this.script.spawnDigest?.(run.request.repIndex, candidateId) ?? 'deadbeef:deadbeef';
      const result: HeadlessRunResult = {
        runSummary: mockRunSummary(delay),
        spawnDigestHex: digest,
        runHash: `hash:${candidateId}:${String(run.request.repIndex)}`,
        ticksRun: 100,
      };
      results.push({ runId: run.runId, result });
      callbacks.onResult?.({ runId: run.runId, result });
      this.progressLog.push({ completed: results.length, total: requests.length });
    }
    return results;
  }
}

const instantExecutorOptions = { chunkBudgetMs: 0, yieldToEventLoop: () => Promise.resolve() } as const;

describe('ranking on a scripted mock objective (hand-verified)', () => {
  const config = createDefaultConfig();
  const candidates = greenSplitSpace(config).candidates.slice(0, 5); // g:5+47 … g:9+43

  function scriptFor(delaysByGreens: Record<string, readonly (number | null)[]>): MockScript {
    const map = new Map<string, readonly (number | null)[]>();
    for (const [greens, delays] of Object.entries(delaysByGreens)) map.set(`g:${greens}`, delays);
    return { delays: map };
  }

  it('ranks by mean of rep means; reports hand-computed sample variance', async () => {
    // Hand math: A=g:5+47 reps {10,12} → mean 11, var ((−1)²+(1)²)/1 = 2;
    // B=g:6+46 reps {5,5} → 5, var 0; C=g:7+45 reps {7,8} → 7.5, var 0.5.
    const executor = new MockExecutor(scriptFor({ '5+47': [10, 12], '6+46': [5, 5], '7+45': [7, 8] }));
    const report = await runSweep(config, candidates.slice(0, 3), { executor, reps: 2, horizonSeconds: 10 });
    expect(report.ranked.map((entry) => entry.candidate.id)).toEqual(['g:6+46', 'g:7+45', 'g:5+47']);
    expect(report.ranked.map((entry) => entry.rank)).toEqual([1, 2, 3]);
    expect(report.ranked[0]?.meanControlDelaySeconds).toBe(5);
    expect(report.ranked[1]?.meanControlDelaySeconds).toBe(7.5);
    expect(report.ranked[2]?.meanControlDelaySeconds).toBe(11);
    expect(report.ranked[0]?.varianceAcrossReps).toBe(0);
    expect(report.ranked[1]?.varianceAcrossReps).toBeCloseTo(0.5, 12);
    expect(report.ranked[2]?.varianceAcrossReps).toBeCloseTo(2, 12);
    expect(report.ranked[2]?.sampleStdDevSeconds).toBeCloseTo(Math.sqrt(2), 12);
    expect(report.ranked[0]?.totalTrips).toBe(10); // 5 per rep × 2 reps
    expect(report.ranked[0]?.meanThroughputVehPerHour).toBe(100);
    expect(report.ranked[0]?.meanMaxQueueCars).toBe(2);
  });

  it('breaks ties by candidate id and ranks trip-less (null) candidates last', async () => {
    const executor = new MockExecutor(
      scriptFor({
        '5+47': [7.5, 7.5],
        '6+46': [7.5, 7.5],
        '7+45': [1, 1],
        '8+44': [3, null], // one trip-less rep → unrankable numerically
        '9+43': [2, 2],
      }),
    );
    const report = await runSweep(config, candidates, { executor, reps: 2, horizonSeconds: 10 });
    expect(report.ranked.map((entry) => entry.candidate.id)).toEqual([
      'g:7+45', // 1
      'g:9+43', // 2
      'g:5+47', // 7.5, id 'g:5+47' < 'g:6+46'
      'g:6+46', // 7.5
      'g:8+44', // null → last
    ]);
    expect(report.ranked[4]?.meanControlDelaySeconds).toBeNull();
    expect(report.ranked[4]?.varianceAcrossReps).toBeNull();
  });

  it('single rep ⇒ zero variance reported as null (n−1 undefined)', async () => {
    const executor = new MockExecutor(scriptFor({ '5+47': [4], '6+46': [3] }));
    const report = await runSweep(config, candidates.slice(0, 2), { executor, reps: 1, horizonSeconds: 10 });
    expect(report.ranked[0]?.candidate.id).toBe('g:6+46');
    expect(report.ranked[0]?.varianceAcrossReps).toBeNull();
  });

  it('progress fires once per run, monotonic, ending at total', async () => {
    const executor = new MockExecutor(scriptFor({ '5+47': [1, 1], '6+46': [2, 2], '7+45': [3, 3] }));
    const events: SweepProgress[] = [];
    const report = await runSweep(config, candidates.slice(0, 3), {
      executor,
      reps: 2,
      horizonSeconds: 10,
      onProgress: (progress) => events.push(progress),
    });
    expect(events.length).toBe(6);
    expect(events.map((event) => event.completed)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(events[5]?.total).toBe(6);
    expect(report.totalRuns).toBe(6);
  });

  it('pairs request runIds candidate-major, rep-minor; exposes shared pairing digests', async () => {
    const executor = new MockExecutor(scriptFor({ '5+47': [1, 1], '6+46': [2, 2] }));
    const report = await runSweep(config, candidates.slice(0, 2), { executor, reps: 2, horizonSeconds: 10 });
    expect(executor.seenRequests.map((run) => [run.request.repIndex, run.runId])).toEqual([
      [0, 0],
      [1, 1],
      [0, 2],
      [1, 3],
    ]);
    expect(report.pairing).toEqual([
      { repIndex: 0, spawnDigestHex: 'deadbeef:deadbeef' },
      { repIndex: 1, spawnDigestHex: 'deadbeef:deadbeef' },
    ]);
  });

  it('throws PairingViolationError when a rep sees distinct spawn digests across candidates', async () => {
    const executor = new MockExecutor({
      delays: new Map([['5+47', [1, 1]], ['6+46', [2, 2]]]),
      spawnDigest: (repIndex, candidateId) => `${candidateId}:${String(repIndex)}`, // candidate-dependent → violation
    });
    const attempted = runSweep(config, candidates.slice(0, 2), { executor, reps: 2, horizonSeconds: 10 });
    const error = await attempted.then(
      () => null,
      (thrown: unknown) => (thrown instanceof PairingViolationError ? thrown : null),
    );
    expect(error).not.toBeNull();
    expect(error?.repIndex).toBe(0);
    expect(error?.digests.length).toBe(2);
  });

  it('propagates executor cancellation rejections', async () => {
    const executor = new MockExecutor({ delays: new Map(), failWith: new SweepCancelledError(2, 6) });
    await expect(
      runSweep(config, candidates.slice(0, 3), { executor, reps: 2, horizonSeconds: 10 }),
    ).rejects.toBeInstanceOf(SweepCancelledError);
  });

  it('rejects non-signal configs and empty candidate lists up front', async () => {
    const stop: IntersectionConfig = { ...createDefaultConfig(), control: { type: 'all-way-stop' } };
    const executor = new MockExecutor({ delays: new Map() });
    await expect(runSweep(stop, candidates.slice(0, 1), { executor, horizonSeconds: 10 })).rejects.toThrow(/signal/);
    await expect(runSweep(createDefaultConfig(), [], { executor, horizonSeconds: 10 })).rejects.toThrow(/at least one candidate/);
    await expect(
      runSweep(createDefaultConfig(), candidates.slice(0, 1), { executor, reps: 0, horizonSeconds: 10 }),
    ).rejects.toThrow(/reps/);
  });
});

// ---------------------------------------------------------------------------
// Real sweeps (time-sliced executor, small horizons — the full sim path)
// ---------------------------------------------------------------------------

function projection(report: SweepReport): unknown {
  return {
    ranked: report.ranked.map((entry) => ({
      id: entry.candidate.id,
      rank: entry.rank,
      mean: entry.meanControlDelaySeconds,
      variance: entry.varianceAcrossReps,
      hashes: entry.reps.map((rep) => rep.runHash),
      summaries: entry.reps.map((rep) => rep.runSummary),
    })),
    pairing: report.pairing,
    stages: report.stages,
  };
}

describe('real paired-seed sweep (time-sliced executor)', () => {
  const config = createDefaultConfig();

  it('asserts the pairing contract end-to-end: identical digests per rep across candidates; reps differ', async () => {
    const space = greenSplitSpace(config);
    const candidates: readonly SweepCandidate[] = [
      space.candidates[0],
      space.candidates[21],
      space.candidates[42],
    ].map((candidate) => {
      if (candidate === undefined) throw new Error('missing candidate');
      return candidate;
    });
    const report = await runSweep(config, candidates, {
      executor: new TimeSlicedExecutor(instantExecutorOptions),
      masterSeed: 777,
      reps: 2,
      horizonSeconds: 60, // long enough for completed trips even on the starved (5 s green) split
    });
    expect(report.pairing.length).toBe(2);
    expect(report.pairing[0]?.spawnDigestHex).not.toBe(report.pairing[1]?.spawnDigestHex); // reps differ
    for (const entry of report.ranked) {
      expect(entry.reps[0]?.spawnDigestHex).toBe(report.pairing[0]?.spawnDigestHex);
      expect(entry.reps[1]?.spawnDigestHex).toBe(report.pairing[1]?.spawnDigestHex);
      expect(entry.reps[0]?.ticksRun).toBe(600);
      expect(entry.meanControlDelaySeconds).not.toBeNull();
    }
    // Different plans genuinely produced different runs (hashes differ per candidate).
    expect(new Set(report.ranked.map((entry) => entry.reps[0]?.runHash)).size).toBe(3);
  });

  it('determinism: an identical re-run yields an identical report', { timeout: 60_000 }, async () => {
    const space = greenSplitSpace(config);
    const options = {
      executor: new TimeSlicedExecutor(instantExecutorOptions),
      masterSeed: 424242,
      reps: 2,
      horizonSeconds: 12,
    } as const;
    const first = await runSweep(config, space.candidates.slice(0, 6), options);
    const second = await runSweep(config, space.candidates.slice(0, 6), options);
    expect(projection(second)).toEqual(projection(first));
  });

  it('cancellation mid-sweep rejects cleanly (real executor)', async () => {
    const space = greenSplitSpace(config);
    const executor = new TimeSlicedExecutor({
      chunkBudgetMs: 0,
      yieldToEventLoop: () => {
        executor.cancel();
        return Promise.resolve();
      },
    });
    await expect(
      runSweep(config, space.candidates.slice(0, 4), { executor, reps: 2, horizonSeconds: 12 }),
    ).rejects.toBeInstanceOf(SweepCancelledError);
  });

  it('default sweep on a 2-phase config: single exhaustive stage, 43 candidates, deterministic', async () => {
    const options = {
      executor: new TimeSlicedExecutor(instantExecutorOptions),
      masterSeed: 1,
      reps: 2,
      horizonSeconds: 12,
    } as const;
    const first = await runDefaultSweep(config, options);
    expect(first.candidateCount).toBe(43);
    expect(first.stages.length).toBe(1);
    expect(first.stages[0]?.label).toMatch(/exhaustive/);
    expect(first.ranked[0]?.rank).toBe(1);
    const second = await runDefaultSweep(config, options);
    expect(projection(second)).toEqual(projection(first));
  }, 60_000);

  it('default sweep on a 4-phase preset: coarse + refine stages, bounded ≤ 96, all validated', async () => {
    const balanced = getPreset('balanced').config;
    const report = await runDefaultSweep(balanced, {
      executor: new TimeSlicedExecutor(instantExecutorOptions),
      masterSeed: 2,
      reps: 1,
      horizonSeconds: 45,
    });
    expect(report.stages.length).toBe(2);
    expect(report.stages[0]?.label).toMatch(/coarse/);
    expect(report.stages[1]?.label).toMatch(/refined/);
    expect(report.candidateCount).toBeLessThanOrEqual(96);
    expect(report.candidateCount).toBeGreaterThan(35); // coarse 35 + refinement
    for (const entry of report.ranked) {
      expect(entry.config.control.type).toBe('signal');
      const greens = entry.candidate.greens.reduce((a, b) => a + b, 0);
      expect(greens).toBe(43);
    }
    // The refinement actually explored beyond the coarse lattice.
    const coarse = new Set(greenSplitSpace(balanced).candidates.map((candidate) => candidate.id));
    expect(report.ranked.some((entry) => !coarse.has(entry.candidate.id))).toBe(true);
  }, 120_000);
});
