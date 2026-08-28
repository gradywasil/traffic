/**
 * Headless performance measurements (task Q2) — the node-side proxies for the
 * acceptance bar, run on the build machine and recorded in the production-log
 * (plan Q2: "measured numbers recorded in production-log; targets met or
 * deviation documented"; risk note: "machine variance — measure on build
 * machine, note hardware").
 *
 * What node CAN measure honestly here:
 *  - per-tick cost of the FULL app pipeline (SimRuntime.step: control →
 *    world → spawner → metrics) at the guaranteed ≥150-car stress load;
 *  - draw-list BUILD cost at that load (renderer.frame — scene + command
 *    list; rasterization is excluded: node has no canvas — disclosed);
 *  - per-tick cost of a sweep run (the unit the TimeSlicedExecutor chunks)
 *    and the frame-budget arithmetic (tests/perf/frame-budget.ts) fed with
 *    the measured numbers: worst-case executor chunk vs a 16.6 ms frame;
 *  - default-sweep wall time on the fallback executor (opt-in, see below).
 *
 * What node CANNOT measure (browser benchmark page, benchmark.html, filled
 * in by X1's run — see tests/perf/EVIDENCE.md): rAF frame-time percentiles
 * with real rasterization on a real canvas, and fps during a REAL worker-pool
 * sweep. Those slots stay open in the evidence document.
 *
 * ## Timing-honesty protocol (why the assertions are split the way they are)
 *
 * Vitest runs test FILES in parallel; on this 8-core (4P+4E) machine the
 * suite keeps ~7 workers busy and a worker scheduled onto an efficiency core
 * (or starved mid-test) runs single-threaded code 2–30× slower — measured:
 * sweeps 14–16 s standalone vs 29–31 s in-suite; a 0.022 ms-median sweep
 * tick with a 6.2 ms max; a 0.16 ms-median draw-list build whose p99 hit
 * 5.4 ms during sustained starvation. Under that, ANY timing-distribution
 * assertion can fail regardless of margin. Therefore:
 *  - the EVIDENCE NUMBERS and ALL timing bars (F4's < 4 ms/tick, U1's
 *    < 4 ms render build, the chunk ≤ 30%-of-frame arithmetic, the sweep
 *    ≤ 30 s walls) come from the GATED STANDALONE invocation, where the file
 *    runs without cross-file contention:
 *        Q2_SWEEP=1 npx vitest run tests/perf/headless-measurements.test.ts
 *        Q2_SWEEP=1 npx vitest run src/optimizer/sweep.perf.test.ts
 *  - the DEFAULT suite run still executes every measurement and PRINTS the
 *    numbers, but asserts only DETERMINISTIC properties (the ≥150-car load
 *    floor — a sim-outcome guarantee independent of machine speed — plus
 *    sample-count/shape checks). O1's in-suite per-tick guards (median < 1,
 *    p99 < 4 vs a 0.011 ms measured value) keep their ~90× margins.
 */
import { describe, expect, it } from 'vitest';
import { createDefaultConfig } from '../../src/config';
import { TimeSlicedExecutor, defaultWorkerPoolSize } from '../../src/optimizer/executor';
import { createHeadlessRun } from '../../src/optimizer/run';
import { runDefaultSweep } from '../../src/optimizer/sweep';
import { getPreset } from '../../src/presets';
import { WorldRenderer } from '../../src/render/renderer';
import { SimRuntime } from '../../src/ui/sim-runtime';
import { FRAME_BUDGET_MS, chunkWorstCase, percentile, worstCaseFrame } from './frame-budget';
import { STRESS_TARGET_CONCURRENT_CARS, STRESS_WARMUP_TICKS, createStressConfig } from './stress-config';

/** Measured-window size for the per-tick distributions (300 s of sim time). */
const MEASURE_TICKS = 3000;
/** Draw-list builds to time (≈10 s of frames at 60 Hz). */
const MEASURE_BUILDS = 600;

/** Opt-in gate for the sweep wall-time measurements (see module doc). */
declare const process: { readonly env: Record<string, string | undefined> } | undefined;
const sweepRequested = (): boolean => typeof process !== 'undefined' && process.env.Q2_SWEEP === '1';

function stats(values: readonly number[]): string {
  return (
    `median ${percentile(values, 0.5).toFixed(4)} / p95 ${percentile(values, 0.95).toFixed(4)} / ` +
    `p99 ${percentile(values, 0.99).toFixed(4)} / max ${Math.max(...values).toFixed(4)} ms`
  );
}

describe('Q2 headless measurements (stress load: >=150 concurrent cars)', () => {
  it(
    'per-tick cost of the full pipeline at >=150 concurrent cars (node)',
    { timeout: 120_000 },
    () => {
      const runtime = new SimRuntime(createStressConfig(), { masterSeed: 1, capacity: 512 });
      for (let tick = 1; tick <= STRESS_WARMUP_TICKS; tick += 1) runtime.step();

      const ticks: number[] = [];
      let aliveMin = Number.POSITIVE_INFINITY;
      let aliveMax = 0;
      for (let tick = 1; tick <= MEASURE_TICKS; tick += 1) {
        const t0 = performance.now();
        runtime.step();
        ticks.push(performance.now() - t0);
        const alive = runtime.world.store.count;
        if (alive < aliveMin) aliveMin = alive;
        if (alive > aliveMax) aliveMax = alive;
      }
      const median = percentile(ticks, 0.5);
      const p99 = percentile(ticks, 0.99);
      console.info(
        `[q2-perf] sim tick (SimRuntime.step) over ${String(MEASURE_TICKS)} ticks at alive ` +
          `${String(aliveMin)}–${String(aliveMax)} (target >= ${String(STRESS_TARGET_CONCURRENT_CARS)}): ${stats(ticks)}`,
      );
      // The load floor held for every measured tick — DETERMINISTIC (sim
      // outcome is machine-independent), always asserted.
      expect(aliveMin).toBeGreaterThanOrEqual(STRESS_TARGET_CONCURRENT_CARS);
      expect(ticks.length).toBe(MEASURE_TICKS);
      // F4's committed bar (150 cars < 4 ms/tick): asserted only in the
      // gated standalone run — a starving worker (E-core pinning under the
      // suite's file parallelism) can degrade timings 10–30× and would fail
      // ANY margin (observed p99 inflation to 33× the standalone value).
      if (sweepRequested()) {
        expect(median).toBeLessThan(2);
        expect(p99).toBeLessThan(4);
      }
    },
  );

  it(
    'draw-list build cost at >=150 cars (node; rasterization EXCLUDED — disclosed)',
    { timeout: 120_000 },
    () => {
      const runtime = new SimRuntime(createStressConfig(), { masterSeed: 1, capacity: 512 });
      for (let tick = 1; tick <= STRESS_WARMUP_TICKS; tick += 1) runtime.step();
      const renderer = new WorldRenderer(runtime.geometry, runtime.config);
      expect(runtime.world.store.count).toBeGreaterThanOrEqual(STRESS_TARGET_CONCURRENT_CARS);

      const builds: number[] = [];
      const snapshots: number[] = [];
      let commands = 0;
      for (let i = 0; i < MEASURE_BUILDS; i += 1) {
        const alpha = (i % 10) / 10; // sweep interpolation positions
        let t0 = performance.now();
        const list = renderer.frame(runtime.world, runtime.control, alpha, { fps: 60, frameMs: 16.7 });
        builds.push(performance.now() - t0);
        commands += list.length;
        // The app's render hook also snapshots metrics every frame (chart gate
        // + overlay consume it); measure that cost alongside.
        t0 = performance.now();
        runtime.metrics.snapshot();
        snapshots.push(performance.now() - t0);
      }
      const buildMedian = percentile(builds, 0.5);
      const buildP99 = percentile(builds, 0.99);
      console.info(
        `[q2-perf] draw-list build (renderer.frame) over ${String(MEASURE_BUILDS)} frames at ` +
          `${String(runtime.world.store.count)} cars, ${String(Math.round(commands / MEASURE_BUILDS))} commands/frame: ${stats(builds)}`,
      );
      console.info(`[q2-perf] metrics snapshot per frame: median ${percentile(snapshots, 0.5).toFixed(4)} ms`);
      // U1's bar (render pass < 4 ms at 150 cars), asserted in the gated
      // standalone run only (see the per-tick test's note); paintFrame
      // (browser-only) is measured by benchmark.html.
      expect(commands).toBeGreaterThan(0);
      if (sweepRequested()) {
        expect(buildMedian).toBeLessThan(2);
        expect(buildP99).toBeLessThan(4);
      }
    },
  );

  it('frame-budget arithmetic from the measured numbers (worst-case chunk vs 16.6 ms)', () => {
    // Per-tick cost of a SWEEP run (the unit the time-sliced executor chunks)
    // on the app-default preset the optimizer sweeps (balanced).
    const handle = createHeadlessRun({
      config: getPreset('balanced').config,
      masterSeed: 1,
      repIndex: 0,
      horizonSeconds: 45,
    });
    const sweepTicks: number[] = [];
    while (!handle.isDone()) {
      const t0 = performance.now();
      handle.step();
      sweepTicks.push(performance.now() - t0);
    }
    handle.finish();
    const sweepMax = Math.max(...sweepTicks);

    // Live-sim per-tick cost at stress load (short form — the full
    // distribution is the first test's evidence).
    const runtime = new SimRuntime(createStressConfig(), { masterSeed: 1, capacity: 512 });
    for (let tick = 1; tick <= STRESS_WARMUP_TICKS; tick += 1) runtime.step();
    const liveTicks: number[] = [];
    for (let tick = 1; tick <= 600; tick += 1) {
      const t0 = performance.now();
      runtime.step();
      liveTicks.push(performance.now() - t0);
    }
    const liveMax = Math.max(...liveTicks);
    const liveMedian = percentile(liveTicks, 0.5);

    // Draw-list build p99 from the same session (short form).
    const renderer = new WorldRenderer(runtime.geometry, runtime.config);
    const builds: number[] = [];
    for (let i = 0; i < 200; i += 1) {
      const t0 = performance.now();
      renderer.frame(runtime.world, runtime.control, (i % 10) / 10, null);
      builds.push(performance.now() - t0);
    }
    const buildP99 = percentile(builds, 0.99);

    // The chunk claim (O1's carried-over Q2 bar): a 4 ms time-sliced chunk
    // cannot overshoot by more than one tick ⇒ worst case 4 + maxTick ms.
    const chunk = chunkWorstCase({ chunkBudgetMs: 4, perTickMaxMs: sweepMax });
    console.info(
      `[q2-perf] sweep per-tick (balanced preset, ${String(sweepTicks.length)} ticks): ${stats(sweepTicks)}` +
        ` ⇒ 4 ms chunk worst case ${chunk.worstCaseMs.toFixed(3)} ms = ${(chunk.frameFraction * 100).toFixed(1)}% of a ${FRAME_BUDGET_MS.toFixed(1)} ms frame (headroom ${chunk.headroomMs.toFixed(2)} ms)`,
    );

    // Additive worst-case frames, both executor regimes. Steady 60 Hz at ≤4×
    // speed is at most 1 tick per frame; the stall-catch-up cap (10 ticks at
    // dt = 0.1 s) is quoted as the pathological case.
    const steady = worstCaseFrame({
      sim: { perTickMs: liveMax, maxTicksPerFrame: 1 },
      renderP99Ms: buildP99,
    });
    const withFallbackSweep = worstCaseFrame({
      sim: { perTickMs: liveMax, maxTicksPerFrame: 1 },
      chunk: { chunkBudgetMs: 4, perTickMaxMs: sweepMax },
      renderP99Ms: buildP99,
    });
    const stallCatchUp = worstCaseFrame({
      sim: { perTickMs: liveMax, maxTicksPerFrame: 10 },
      renderP99Ms: buildP99,
    });
    console.info(
      `[q2-perf] worst-case 60 Hz frame, worker-pool sweep (chunk 0): sim ${steady.simMs.toFixed(3)} + build ${steady.renderMs.toFixed(3)} = ${steady.worstCaseTotalMs.toFixed(3)} ms ⇒ headroom ${steady.headroomMs.toFixed(2)} ms (${(steady.headroomFractionOfFrame * 100).toFixed(0)}% of frame)`,
    );
    console.info(
      `[q2-perf] worst-case 60 Hz frame, time-sliced sweep: sim ${withFallbackSweep.simMs.toFixed(3)} + chunk ${withFallbackSweep.chunkMs.toFixed(3)} + build ${withFallbackSweep.renderMs.toFixed(3)} = ${withFallbackSweep.worstCaseTotalMs.toFixed(3)} ms ⇒ headroom ${withFallbackSweep.headroomMs.toFixed(2)} ms`,
    );
    console.info(
      `[q2-perf] pathological stall catch-up (10 ticks/frame cap): ${stallCatchUp.worstCaseTotalMs.toFixed(3)} ms — may exceed one frame by design (backlog is shed, not death-spiraled); steady-state sim median ${liveMedian.toFixed(4)} ms/tick`,
    );

    // Timing bars assert in the gated standalone run only (module doc: a
    // starving worker degrades even p99 inputs 10–30×, which would fail any
    // margin under the suite's file parallelism); the console lines above
    // always carry the measured numbers.
    if (sweepRequested()) {
      const chunkP99 = chunkWorstCase({ chunkBudgetMs: 4, perTickMaxMs: percentile(sweepTicks, 0.99) });
      const withFallbackSweepP99 = worstCaseFrame({
        sim: { perTickMs: percentile(liveTicks, 0.99), maxTicksPerFrame: 1 },
        chunk: { chunkBudgetMs: 4, perTickMaxMs: percentile(sweepTicks, 0.99) },
        renderP99Ms: buildP99,
      });
      // The committed arithmetic bar: worst-case chunk ≤ ~30% of a frame
      // (both the max-based protocol number and its p99 sibling).
      expect(chunk.worstCaseMs).toBeLessThanOrEqual(0.3 * FRAME_BUDGET_MS);
      expect(chunkP99.worstCaseMs).toBeLessThan(FRAME_BUDGET_MS / 3);
      // Steady worst-case frame (no sweep) leaves ≥ 12 ms headroom (Q2 warn
      // bar), and the fallback-sweep worst case fits the frame budget.
      expect(steady.headroomMs).toBeGreaterThanOrEqual(12);
      expect(withFallbackSweep.worstCaseTotalMs).toBeLessThan(FRAME_BUDGET_MS);
      expect(withFallbackSweepP99.worstCaseTotalMs).toBeLessThan(FRAME_BUDGET_MS);
    }
  });
});

describe('Q2 default-sweep wall time on the fallback executor (opt-in: Q2_SWEEP=1)', () => {
  // Kept OUT of the default suite on purpose (module doc): two full sweeps
  // add ~40 s of CPU-heavy work that competes with O1's sweep timing tests
  // under vitest's file parallelism and can push THEM over their 30 s bars.
  // The suite's standing coverage of the ≤30 s fallback bar is O1's own
  // src/optimizer/sweep.perf.test.ts; these runs produce the Q2 evidence
  // numbers for BOTH configs the app can default to (starter config and the
  // balanced preset the UI boots with).

  it.runIf(sweepRequested())(
    'default config (43 candidates) — fallback executor wall ≤ 30 s',
    { timeout: 180_000 },
    async () => {
      await measureSweepWall('default config', createDefaultConfig());
    },
  );

  it.runIf(sweepRequested())(
    'balanced preset (the app default; larger 4-phase lattice) — fallback executor wall ≤ 30 s',
    { timeout: 180_000 },
    async () => {
      await measureSweepWall('balanced preset', getPreset('balanced').config);
    },
  );
});

async function measureSweepWall(label: string, config: ReturnType<typeof createDefaultConfig>): Promise<void> {
  const executor = new TimeSlicedExecutor(); // default 4 ms chunks — O2's fallback path
  const started = performance.now();
  const report = await runDefaultSweep(config, { executor, horizonSeconds: 45, reps: 3, masterSeed: 1 });
  const wallMs = performance.now() - started;
  const poolSize = defaultWorkerPoolSize();
  const perRunMs = wallMs / report.totalRuns;
  const browserPoolEstimateMs = perRunMs * Math.ceil(report.totalRuns / poolSize);
  console.info(
    `[q2-perf] default sweep (${label}) on time-sliced executor: ${String(report.candidateCount)} candidates × ${String(report.reps)} reps = ${String(report.totalRuns)} runs, wall ${(wallMs / 1000).toFixed(2)} s; ` +
      `browser ${String(poolSize)}-worker pool estimate ≈ ${(browserPoolEstimateMs / 1000).toFixed(2)} s (excl. worker startup) — measured for real by benchmark.html`,
  );
  // The committed bar: default sweep completes ≤ 30 s.
  expect(wallMs).toBeLessThan(30_000);
  expect(report.ranked.length).toBeGreaterThan(0);
  expect(report.ranked[0]?.meanControlDelaySeconds).not.toBeNull();
}
