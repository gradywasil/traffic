/**
 * Q2 performance benchmark entry (benchmark.html) — the BROWSER half of the
 * performance & acceptance harness (plan task Q2). Not wired into the app UI;
 * a human opens the built page (dist/benchmark.html) and the protocol runs
 * automatically:
 *
 *   1. warm up the Q2 stress world (tests/perf/stress-config.ts) until it
 *      holds ≥150 concurrent cars — the acceptance bar's load floor;
 *   2. segment "1x": 10 s of requestAnimationFrame frames running the FULL
 *      app pipeline per frame — fixed-timestep sim tick, draw-list build,
 *      canvas rasterization (real 2-D context), metrics snapshot, ~1 Hz
 *      chart/headline/overlay gates — exactly what bootApp's render hook
 *      does (src/ui/app.ts), minus the control panel (no per-frame cost);
 *   3. segment "4x": same at the scope's maximum playback speed (worst-case
 *      steady tick rate: 4× ⇒ up to 1 tick per 60 Hz frame);
 *   4. segment "sweep": the DEFAULT optimizer sweep (app-default balanced
 *      preset, the real O2 service ⇒ real worker pool) started CONCURRENTLY
 *      with the still-running frame loop — frame-time percentiles during the
 *      sweep + sweep wall time (the O1 bar carried into Q2: ≥55 fps during
 *      sweep, sweep ≤30 s);
 *   5. results JSON printed to the page, console, and downloadable — the
 *      X1 acceptance run pastes it into tests/perf/EVIDENCE.md.
 *
 * Deterministic where determinism matters (fixed seed, fixed configs, fixed
 * protocol); only the frame-time samples are machine-dependent, which is the
 * point. Headless proxies for the same bars (node) live in
 * tests/perf/headless-measurements.test.ts; the frame-budget arithmetic is
 * shared verbatim (tests/perf/frame-budget.ts).
 */
import { defaultWorkerPoolSize } from './optimizer/executor';
import { getPreset } from './presets';
import { configureCanvas, paintFrame } from './render/painter';
import { WorldRenderer } from './render/renderer';
import { MetricsChart } from './ui/chart/metrics-chart';
import { EngineeringOverlay } from './ui/overlay/overlay-panel';
import { createOptimizerSweepService } from './ui/optimizer/sweep-service';
import { PlaybackController } from './ui/playback';
import { SimRuntime } from './ui/sim-runtime';
import {
  FRAME_BUDGET_MS,
  formatFrameStats,
  percentile,
  summarizeFrameTimes,
  worstCaseFrame,
} from '../tests/perf/frame-budget';
import {
  STRESS_CONFIG_ID,
  STRESS_TARGET_CONCURRENT_CARS,
  STRESS_WARMUP_TICKS,
  createStressConfig,
} from '../tests/perf/stress-config';

/** Wall-clock length of each speed segment (ms). */
const SEGMENT_WALL_MS = 10_000;
/** HUD fps meter window (frames) — mirrors app.ts's FpsMeter intent. */
const FPS_METER_SAMPLES = 120;

interface SegmentSamples {
  readonly label: string;
  readonly frameTimesMs: number[];
  readonly updateMs: number[]; // per-frame sim-update cost (0 or more ticks)
  readonly perTickMs: number[]; // cost of each individual runtime.step()
  readonly renderMs: number[]; // draw-list build + raster + snapshot + chart/overlay
  aliveMin: number;
  aliveMax: number;
}

interface SegmentReport {
  readonly label: string;
  readonly wallMs: number;
  readonly frames: number;
  readonly frameMs: ReturnType<typeof summarizeFrameTimes>;
  readonly updateMedianMs: number;
  readonly perTickMaxMs: number;
  readonly renderMedianMs: number;
  readonly renderP99Ms: number;
  readonly aliveMin: number;
  readonly aliveMax: number;
}

function requireCanvas(id: string): HTMLCanvasElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLCanvasElement)) throw new Error(`#${id} canvas element not found`);
  return element;
}

function requireElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLElement)) throw new Error(`#${id} element not found`);
  return element;
}

function waitWall(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeSegment(samples: SegmentSamples, wallMs: number): SegmentReport {
  return {
    label: samples.label,
    wallMs,
    frames: samples.frameTimesMs.length,
    frameMs: summarizeFrameTimes(samples.frameTimesMs),
    updateMedianMs: percentile(samples.updateMs, 0.5),
    perTickMaxMs: Math.max(...samples.perTickMs, 0),
    renderMedianMs: percentile(samples.renderMs, 0.5),
    renderP99Ms: percentile(samples.renderMs, 0.99),
    aliveMin: samples.aliveMin,
    aliveMax: samples.aliveMax,
  };
}

function segmentToJson(report: SegmentReport): Record<string, unknown> {
  return {
    label: report.label,
    wallSeconds: Number((report.wallMs / 1000).toFixed(2)),
    frames: report.frames,
    meanFps: Number(report.frameMs.meanFps.toFixed(1)),
    p99Fps: Number(report.frameMs.p99Fps.toFixed(1)),
    frameMs: {
      median: Number(report.frameMs.medianMs.toFixed(2)),
      p95: Number(report.frameMs.p95Ms.toFixed(2)),
      p99: Number(report.frameMs.p99Ms.toFixed(2)),
      max: Number(report.frameMs.maxMs.toFixed(2)),
    },
    longFramesOver20ms: report.frameMs.longFrames,
    updateMedianMs: Number(report.updateMedianMs.toFixed(3)),
    perTickMaxMs: Number(report.perTickMaxMs.toFixed(3)),
    renderMedianMs: Number(report.renderMedianMs.toFixed(3)),
    renderP99Ms: Number(report.renderP99Ms.toFixed(3)),
    aliveCars: { min: report.aliveMin, max: report.aliveMax },
  };
}

async function runBenchmark(): Promise<void> {
  const status = requireElement('bench-status');
  const resultsPre = requireElement('results');
  const download = requireElement('download');
  const rerun = document.getElementById('rerun');
  const setStatus = (text: string, cls = ''): void => {
    status.textContent = text;
    status.className = cls;
  };

  // --- world + the app's exact per-frame pipeline (app.ts's render hook) ---
  const runtime = new SimRuntime(createStressConfig(), { masterSeed: 1, capacity: 512 });
  const renderer = new WorldRenderer(runtime.geometry, runtime.config);
  let ctx = configureCanvas(requireCanvas('world'));
  const metricsChart = new MetricsChart({
    canvas: requireCanvas('wait-chart'),
    container: requireElement('headline-stats'),
  });
  const overlay = new EngineeringOverlay(requireElement('engineering-overlay'));
  window.addEventListener('resize', () => {
    ctx = configureCanvas(requireCanvas('world'));
  });

  // HUD fps meter (rolling window, like app.ts's FpsMeter).
  const fpsSamples: number[] = [];
  const hud = (): { fps: number; frameMs: number } => {
    if (fpsSamples.length === 0) return { fps: 0, frameMs: 0 };
    const total = fpsSamples.reduce((sum, dt) => sum + dt, 0);
    return { fps: fpsSamples.length / total, frameMs: (total / fpsSamples.length) * 1000 };
  };

  // Active segment collector (null between segments).
  let collector: SegmentSamples | null = null;
  let skipNextFrameInterval = false;

  const playback = new PlaybackController({
    fixedDt: runtime.config.dt,
    update: () => {
      if (collector === null) {
        runtime.step();
        return;
      }
      const t0 = performance.now();
      runtime.step();
      const cost = performance.now() - t0;
      collector.updateMs.push(cost);
      collector.perTickMs.push(cost);
    },
    render: (alpha, frameDt) => {
      const t0 = performance.now();
      const meter = hud();
      const commands = renderer.frame(runtime.world, runtime.control, alpha, {
        fps: meter.fps,
        frameMs: meter.frameMs,
      });
      paintFrame(ctx, commands);
      const snapshot = runtime.metrics.snapshot();
      metricsChart.frame(snapshot);
      overlay.frame(snapshot, runtime.config);
      if (frameDt > 0) {
        fpsSamples.push(frameDt);
        if (fpsSamples.length > FPS_METER_SAMPLES) fpsSamples.shift();
      }
      if (collector !== null) {
        collector.renderMs.push(performance.now() - t0);
        const alive = runtime.world.store.count;
        if (alive < collector.aliveMin) collector.aliveMin = alive;
        if (alive > collector.aliveMax) collector.aliveMax = alive;
      }
    },
  });

  // Persistent rAF loop (the app's own driving pattern).
  let lastTimestamp: number | null = null;
  requestAnimationFrame(function frame(timestampMs: number): void {
    if (collector !== null) {
      if (skipNextFrameInterval) {
        skipNextFrameInterval = false;
      } else if (lastTimestamp !== null) {
        collector.frameTimesMs.push(timestampMs - lastTimestamp);
      }
    }
    lastTimestamp = timestampMs;
    playback.frame(timestampMs);
    requestAnimationFrame(frame);
  });

  const startSegment = (label: string): SegmentSamples => {
    const samples: SegmentSamples = {
      label,
      frameTimesMs: [],
      updateMs: [],
      perTickMs: [],
      renderMs: [],
      aliveMin: Number.POSITIVE_INFINITY,
      aliveMax: 0,
    };
    collector = samples;
    skipNextFrameInterval = true; // never count the segment-boundary gap
    return samples;
  };

  // --- 1. warmup to the load floor ------------------------------------------
  setStatus(`warming up (${String(STRESS_WARMUP_TICKS)} ticks)…`);
  // Warmup: run the FULL tick budget, exactly like stress-config.test.ts —
  // its every-tick floor guarantee is defined post-full-warmup. Exiting at
  // the first ≥150 crossing measures a mid-ramp transient that can still
  // dip below the floor (X1 first run: warmup ended at exactly 150, the 1×
  // segment then dipped to 145 before settling at 159+).
  for (let tick = 0; tick < STRESS_WARMUP_TICKS; tick += 1) {
    runtime.step();
  }
  // Guarantee (stress-config.test.ts): post-warmup the floor HOLDS. If this
  // machine somehow dipped below, extend once, then record honestly.
  for (let tick = 0; tick < STRESS_WARMUP_TICKS && runtime.world.store.count < STRESS_TARGET_CONCURRENT_CARS; tick += 1) {
    runtime.step();
  }
  const warmupAlive = runtime.world.store.count;

  const segments: SegmentReport[] = [];

  // --- 2. steady 1x segment ---------------------------------------------------
  setStatus('measuring: 1× speed, full pipeline…');
  playback.setSpeed(1);
  let seg = startSegment('1x');
  let t0 = performance.now();
  await waitWall(SEGMENT_WALL_MS);
  segments.push(summarizeSegment(seg, performance.now() - t0));

  // --- 3. 4x speed segment ----------------------------------------------------
  setStatus('measuring: 4× speed, full pipeline…');
  playback.setSpeed(4);
  seg = startSegment('4x');
  t0 = performance.now();
  await waitWall(SEGMENT_WALL_MS);
  segments.push(summarizeSegment(seg, performance.now() - t0));

  // --- 4. concurrent default sweep (real worker pool) ------------------------
  setStatus('measuring: default optimizer sweep concurrent with the frame loop…');
  playback.setSpeed(1);
  const sweepService = createOptimizerSweepService(); // browser default: worker pool
  seg = startSegment('sweep');
  t0 = performance.now();
  const outcome = await sweepService.run(getPreset('balanced').config, (progress) => {
    setStatus(`sweep running: ${String(progress.completed)}/${String(progress.total)} runs — frame loop still measured…`);
  });
  const sweepWallMs = performance.now() - t0;
  const sweepSegment = summarizeSegment(seg, sweepWallMs);
  segments.push(sweepSegment);
  collector = null;

  // --- 5. compose results -----------------------------------------------------
  const steady1x = segments[0] as SegmentReport;
  const speed4x = segments[1] as SegmentReport;
  const canvas = requireCanvas('world');
  const headroomSteady = worstCaseFrame({
    sim: { perTickMs: steady1x.perTickMaxMs, maxTicksPerFrame: 1 },
    renderP99Ms: steady1x.renderP99Ms,
  });
  const headroom4x = worstCaseFrame({
    sim: { perTickMs: speed4x.perTickMaxMs, maxTicksPerFrame: 1 },
    renderP99Ms: speed4x.renderP99Ms,
  });

  const results = {
    schema: 'q2-benchmark/1',
    meta: {
      date: new Date().toISOString(),
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency ?? null,
      sweepWorkerPoolSize: defaultWorkerPoolSize(),
      devicePixelRatio: window.devicePixelRatio,
      canvasCssPx: { width: canvas.clientWidth, height: canvas.clientHeight },
      frameBudgetMs: Number(FRAME_BUDGET_MS.toFixed(2)),
      segmentWallSeconds: SEGMENT_WALL_MS / 1000,
    },
    load: {
      configId: STRESS_CONFIG_ID,
      targetConcurrentCars: STRESS_TARGET_CONCURRENT_CARS,
      warmupTicks: STRESS_WARMUP_TICKS,
      aliveAtWarmupEnd: warmupAlive,
      note: 'stress config guarantees the >=150 floor post-warmup (tests/perf/stress-config.ts); aliveCars.min per segment proves it held during measurement',
    },
    segments: segments.map(segmentToJson),
    sweep: {
      preset: 'balanced (app default)',
      executor: outcome.report.executorName,
      candidates: outcome.report.candidateCount,
      totalRuns: outcome.report.totalRuns,
      reps: outcome.report.reps,
      horizonSeconds: outcome.report.horizonSeconds,
      wallSeconds: Number((sweepWallMs / 1000).toFixed(2)),
      bestCandidateId: outcome.report.ranked[0]?.candidate.id ?? null,
      bestMeanControlDelaySeconds:
        outcome.report.ranked[0]?.meanControlDelaySeconds === null || outcome.report.ranked[0]?.meanControlDelaySeconds === undefined
          ? null
          : Number(outcome.report.ranked[0]?.meanControlDelaySeconds.toFixed(3)),
    },
    frameBudgetArithmetic: {
      source: 'tests/perf/frame-budget.ts (shared with the headless tests)',
      steady1xWorstCaseMs: Number(headroomSteady.worstCaseTotalMs.toFixed(3)),
      steady1xHeadroomMs: Number(headroomSteady.headroomMs.toFixed(2)),
      speed4xWorstCaseMs: Number(headroom4x.worstCaseTotalMs.toFixed(3)),
      speed4xHeadroomMs: Number(headroom4x.headroomMs.toFixed(2)),
      note: 'per-frame worst case = perTickMax × 1 update + renderP99 (worker-pool sweep contributes 0 main-thread chunk; the time-sliced fallback bound is quoted from the headless measurements)',
    },
    bars: {
      render60fpsAt150PlusCars: {
        pass: steady1x.frameMs.meanFps >= 55 && steady1x.aliveMin >= STRESS_TARGET_CONCURRENT_CARS,
        detail: `mean ${steady1x.frameMs.meanFps.toFixed(1)} fps at ${String(steady1x.aliveMin)}–${String(steady1x.aliveMax)} cars (bar: ≥55 fps at ≥150 cars; 60 fps target)`,
      },
      chart1HzWithoutFrameDrops: {
        pass: steady1x.frameMs.meanFps >= 55,
        detail: 'chart/headline/overlay ran inside every measured frame (part of renderMs); sim-time gate limits redraws to ~1 Hz at 1× speed',
      },
      defaultSweepUnder30sNoDrops: {
        pass: sweepWallMs <= 30_000 && sweepSegment.frameMs.meanFps >= 55,
        detail: `sweep ${Number((sweepWallMs / 1000).toFixed(2))} s, ${Number(sweepSegment.frameMs.meanFps.toFixed(1))} fps during (bars: ≤30 s, ≥55 fps)`,
      },
    },
  };

  const json = JSON.stringify(results, null, 2);
  resultsPre.textContent = json;
  console.info('[q2-benchmark] results:\n' + json);
  for (const report of segments) console.info(formatFrameStats(`[q2-benchmark] ${report.label}`, report.frameMs));
  const blob = new Blob([json], { type: 'application/json' });
  if (rerun instanceof HTMLButtonElement) {
    rerun.disabled = false;
    rerun.addEventListener('click', () => window.location.reload());
  }
  if (download instanceof HTMLAnchorElement) {
    download.href = URL.createObjectURL(blob);
    download.hidden = false;
  }
  const bars = results.bars as Record<string, { pass: boolean; detail: string }>;
  const allPass = Object.values(bars).every((bar) => bar.pass);
  setStatus(
    allPass
      ? `done — all bars pass (${Object.entries(bars).map(([k, v]) => `${k}: ${String(v.pass)}`).join(', ')})`
      : `done — bars: ${Object.entries(bars).map(([k, v]) => `${k} ${v.pass ? 'PASS' : 'FAIL'}`).join(', ')}`,
    allPass ? 'done' : 'failed',
  );
}

runBenchmark().catch((error: unknown) => {
  const status = document.getElementById('bench-status');
  if (status !== null) {
    status.textContent = `benchmark failed: ${error instanceof Error ? error.message : String(error)}`;
    status.className = 'failed';
  }
  console.error('[q2-benchmark] failed', error);
});
