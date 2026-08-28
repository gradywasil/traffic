/**
 * Optimizer-model tests (task O2 acceptance):
 * - button state machine: idle → running → done | cancelled | failed, with
 *   every terminal state able to start again (no dead states), start refused
 *   while running / under all-way stop, cancel wired only while running;
 * - progress binding: N service callbacks ⇒ bounded render events (throttle
 *   window + first + final), latest values coalesced, never stale-rendered;
 * - results ranking display maps 1:1 to the sweep report (scripted mock
 *   executor feeding `runSweep`, then `buildResultsView`);
 * - apply path: the model routes the ranked plan through the injected apply
 *   seam; end-to-end, that seam is `PanelModel.applySignalPlan` — validation
 *   passes, exactly ONE config-change fires, `SimRuntime` classifies it as a
 *   plan-only LIVE change and the metrics window resets (observed);
 * - cancellation: UI returns to a startable state, partial results discarded.
 */
import { describe, expect, it } from 'vitest';
import { createDefaultConfig, validateConfig } from '../../config';
import type { IntersectionConfig, SignalPlanConfig, ValidationIssue } from '../../config';
import { getPreset } from '../../presets';
import { greenSplitSpace } from '../../optimizer';
import { runSweep } from '../../optimizer';
import type { SweepCandidate, SweepExecutor, SweepProgress, SweepRunRequest } from '../../optimizer';
import { SweepCancelledError } from '../../optimizer';
import type { HeadlessRunResult } from '../../optimizer';
import { PanelModel } from '../panel-model';
import type { PanelEvent } from '../panel-model';
import { SimRuntime } from '../sim-runtime';
import { buildResultsView, OptimizerModel } from './optimizer-model';
import type { OptimizerPhase } from './optimizer-model';
import type { OptimizerSweepOutcome, OptimizerSweepService } from './sweep-service';

// ---------------------------------------------------------------------------
// Fixtures: scripted service + scripted executor → scripted report
// ---------------------------------------------------------------------------

class ScriptableService implements OptimizerSweepService {
  runsStarted = 0;
  cancelCount = 0;
  lastConfig: IntersectionConfig | null = null;
  private progressSink: ((progress: SweepProgress) => void) | null = null;
  private resolveOutcome: ((outcome: OptimizerSweepOutcome) => void) | null = null;
  private rejectError: ((error: unknown) => void) | null = null;

  run(config: IntersectionConfig, onProgress: (progress: SweepProgress) => void): Promise<OptimizerSweepOutcome> {
    this.runsStarted += 1;
    this.lastConfig = config;
    this.progressSink = onProgress;
    return new Promise<OptimizerSweepOutcome>((resolve, reject) => {
      this.resolveOutcome = resolve;
      this.rejectError = reject;
    });
  }

  cancel(): void {
    this.cancelCount += 1;
  }

  emit(completed: number, total: number): void {
    this.progressSink?.({ completed, total });
  }

  finish(outcome: OptimizerSweepOutcome): void {
    const resolve = this.resolveOutcome;
    this.resolveOutcome = null;
    this.rejectError = null;
    resolve?.(outcome);
  }

  fail(error: unknown): void {
    const reject = this.rejectError;
    this.resolveOutcome = null;
    this.rejectError = null;
    reject?.(error);
  }
}

/** Mock executor over a scripted per-(candidate, rep) delay table. */
class FixtureExecutor implements SweepExecutor {
  readonly name = 'scripted';
  constructor(private readonly delays: ReadonlyMap<string, readonly (number | null)[]>) {}

  cancel(): void {}

  async run(
    requests: readonly SweepRunRequest[],
    callbacks: { onResult?: (result: { runId: number; result: HeadlessRunResult }) => void } = {},
  ): Promise<readonly { runId: number; result: HeadlessRunResult }[]> {
    return requests.map((run) => {
      const control = run.request.config.control;
      if (control.type !== 'signal') throw new Error('fixture executor requires signal configs');
      const candidateId = `g:${control.plan.phases.map((phase) => phase.greenSeconds).join('+')}`;
      const delay = (this.delays.get(candidateId) ?? [null])[run.request.repIndex] ?? null;
      const result: HeadlessRunResult = {
        runSummary: {
          elapsedSeconds: 10,
          tripCount: delay === null ? 0 : 5,
          meanControlDelaySeconds: delay,
          meanStoppedSeconds: delay === null ? null : 1,
          throughputVehPerHour: delay === null ? null : 100,
          maxQueueCars: 2,
          maxQueuePerChain: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        },
        spawnDigestHex: 'deadbeef:deadbeef',
        runHash: `hash:${candidateId}:${String(run.request.repIndex)}`,
        ticksRun: 100,
      };
      callbacks.onResult?.({ runId: run.runId, result });
      return { runId: run.runId, result };
    });
  }
}

function fixtureCandidates(config: IntersectionConfig, count: number): readonly SweepCandidate[] {
  const candidates = greenSplitSpace(config).candidates.slice(0, count);
  if (candidates.length < count) throw new Error('fixture needs more candidates');
  return candidates;
}

/**
 * A scripted outcome: the first `count` lattice candidates of `config` with
 * hand-set per-rep delays (index 0 → {10,12}, 1 → {5,5}, 2 → {7,8}, 3 →
 * {3,null} ⇒ one unrankable row). `current` is taken from candidate 0's row
 * so "vs current" comparisons are hand-computable.
 */
async function scriptedOutcome(config: IntersectionConfig, count = 3, reps = 2): Promise<OptimizerSweepOutcome> {
  const candidates = fixtureCandidates(config, count);
  const script: Record<number, readonly (number | null)[]> = {
    0: [10, 12],
    1: [5, 5],
    2: [7, 8],
    3: [3, null],
  };
  const delays = new Map<string, readonly (number | null)[]>();
  candidates.forEach((candidate, index) => delays.set(candidate.id, script[index] ?? [1, 1]));
  const report = await runSweep(config, candidates, {
    executor: new FixtureExecutor(delays),
    reps,
    horizonSeconds: 10,
  });
  const currentRow = report.ranked.find((entry) => entry.candidate.id === candidates[0]?.id);
  if (currentRow === undefined) throw new Error('fixture current row missing');
  return {
    report,
    current: {
      candidateId: currentRow.candidate.id,
      greens: currentRow.candidate.greens,
      meanControlDelaySeconds: currentRow.meanControlDelaySeconds,
      varianceAcrossReps: currentRow.varianceAcrossReps,
      sampleStdDevSeconds: currentRow.sampleStdDevSeconds,
      measured: 'in-report',
    },
  };
}

interface ModelHarness {
  readonly model: OptimizerModel;
  readonly service: ScriptableService;
  readonly configState: { config: IntersectionConfig };
  readonly appliedPlans: SignalPlanConfig[];
  readonly clock: { tick: (ms: number) => void };
  applyIssues: readonly ValidationIssue[];
}

function makeHarness(config: IntersectionConfig = createDefaultConfig()): ModelHarness {
  const service = new ScriptableService();
  const clockState = { now: 0 };
  const configState = { config };
  const appliedPlans: SignalPlanConfig[] = [];
  let applyIssues: readonly ValidationIssue[] = [];
  const model = new OptimizerModel({
    service,
    getConfig: () => configState.config,
    applyPlan: (plan) => {
      appliedPlans.push(plan);
      return applyIssues;
    },
    now: () => clockState.now,
    progressIntervalMs: 150,
  });
  return {
    model,
    service,
    configState,
    appliedPlans,
    get applyIssues() {
      return applyIssues;
    },
    set applyIssues(value: readonly ValidationIssue[]) {
      applyIssues = value;
    },
    clock: { tick: (ms: number) => (clockState.now += ms) },
  };
}

/** Deterministic microtask pump; then asserts the phase. */
async function untilPhase(model: OptimizerModel, phase: OptimizerPhase): Promise<void> {
  for (let i = 0; i < 1000 && model.phase !== phase; i += 1) await Promise.resolve();
  expect(model.phase).toBe(phase);
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

describe('OptimizerModel — state machine (no dead states)', () => {
  it('starts idle: startable, not cancellable, no results', () => {
    const { model } = makeHarness();
    expect(model.phase).toBe('idle');
    expect(model.canStart).toBe(true);
    expect(model.canCancel).toBe(false);
    expect(model.results).toBeNull();
    expect(model.startBlockedReason).toBeNull();
  });

  it('start → running; a second start is refused; cancel is wired', () => {
    const { model } = makeHarness();
    expect(model.start()).toBe(true);
    expect(model.phase).toBe('running');
    expect(model.canStart).toBe(false);
    expect(model.canCancel).toBe(true);
    expect(model.start()).toBe(false);
    model.cancel();
    expect(model.phase).toBe('running'); // flips when the service rejects
  });

  it('running → done: results exposed; done can start again (stale results cleared)', async () => {
    const { model, service } = makeHarness();
    const outcome = await scriptedOutcome(createDefaultConfig());
    model.start();
    service.finish(outcome);
    await untilPhase(model, 'done');
    expect(model.results).not.toBeNull();
    expect(model.canStart).toBe(true);
    expect(model.canCancel).toBe(false);
    // Restart from done — no dead state.
    expect(model.start()).toBe(true);
    expect(model.phase).toBe('running');
    expect(model.results).toBeNull(); // stale results discarded while running
    service.finish(outcome);
    await untilPhase(model, 'done');
    expect(service.runsStarted).toBe(2);
    expect(model.results?.rows.length).toBe(3);
  });

  it('running → cancelled: UI returns to a startable state, partial results discarded', async () => {
    const { model, service } = makeHarness();
    model.start();
    service.emit(4, 24);
    model.cancel();
    expect(service.cancelCount).toBe(1);
    service.fail(new SweepCancelledError(4, 24));
    await untilPhase(model, 'cancelled');
    expect(model.canStart).toBe(true);
    expect(model.canCancel).toBe(false);
    expect(model.results).toBeNull();
    expect(model.cancelledAfterCompleted).toBe(4);
    // Cancel while not running is a no-op.
    model.cancel();
    expect(service.cancelCount).toBe(1);
    // And cancelled can start again.
    expect(model.start()).toBe(true);
    service.fail(new SweepCancelledError(0, 24));
    await untilPhase(model, 'cancelled');
  });

  it('running → failed: error surfaced, still startable', async () => {
    const { model, service } = makeHarness();
    model.start();
    service.fail(new Error('worker exploded'));
    await untilPhase(model, 'failed');
    expect(model.errorText).toContain('worker exploded');
    expect(model.results).toBeNull();
    expect(model.canStart).toBe(true);
  });

  it('refuses to start under all-way stop (and reports why)', () => {
    const stop: IntersectionConfig = { ...createDefaultConfig(), control: { type: 'all-way-stop' } };
    const { model, service } = makeHarness(stop);
    expect(model.startBlockedReason).not.toBeNull();
    expect(model.canStart).toBe(false);
    expect(model.start()).toBe(false);
    expect(service.runsStarted).toBe(0);
    expect(model.phase).toBe('idle');
  });

  it('captures the config at start time (the sweep runs on that snapshot)', () => {
    const { model, service, configState } = makeHarness();
    configState.config = getPreset('balanced').config;
    model.start();
    expect(service.lastConfig).toBe(configState.config);
  });
});

// ---------------------------------------------------------------------------
// Progress binding (throttled renders)
// ---------------------------------------------------------------------------

describe('OptimizerModel — progress binding (bounded renders)', () => {
  it('a frozen clock renders only the first and final callbacks (bounded DOM writes)', () => {
    const { model, service } = makeHarness();
    const events: unknown[] = [];
    model.subscribe(() => events.push(null));
    model.start();
    const before = events.length;
    for (let completed = 1; completed <= 50; completed += 1) service.emit(completed, 50);
    // First push renders; pushes 2..49 are skipped; push 50 is final → renders.
    expect(events.length - before).toBe(2);
    // The model still holds the LATEST values (coalesced).
    expect(model.progress).toEqual({ completed: 50, total: 50 });
  });

  it('N callbacks with a moving clock produce ≤ N/interval + 3 renders', () => {
    const { model, service, clock } = makeHarness();
    const events: unknown[] = [];
    model.subscribe(() => events.push(null));
    model.start();
    const before = events.length;
    for (let completed = 1; completed <= 1000; completed += 1) {
      clock.tick(1);
      service.emit(completed, 1000);
    }
    const renders = events.length - before;
    expect(renders).toBeLessThanOrEqual(Math.ceil(1000 / 150) + 3); // ≤ ~10 for N=1000
    expect(renders).toBeGreaterThanOrEqual(4); // progress must still flow
    expect(model.progress).toEqual({ completed: 1000, total: 1000 });
  });

  it('skipped callbacks never render stale values (latest wins)', () => {
    const { model, service, clock } = makeHarness();
    const seen: SweepProgress[] = [];
    model.subscribe(() => {
      if (model.progress !== null) seen.push(model.progress);
    });
    model.start();
    for (let completed = 1; completed <= 9; completed += 1) service.emit(completed, 100); // 1 renders
    clock.tick(1000);
    service.emit(10, 100); // window opens — renders the LATEST (10), not 2..9
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[seen.length - 1]).toEqual({ completed: 10, total: 100 });
    expect(seen.some((progress) => progress.completed < 10 && progress.completed > 1)).toBe(false);
  });

  it('elapsed tracks the injected clock', () => {
    const { model, service, clock } = makeHarness();
    model.start();
    clock.tick(2500);
    service.emit(1, 10);
    expect(model.elapsedMs).toBe(2500);
  });
});

// ---------------------------------------------------------------------------
// Results view mapping (1:1 with the sweep report)
// ---------------------------------------------------------------------------

describe('buildResultsView — ranking display maps 1:1 to the sweep report', () => {
  it('rows preserve report order/count; best marked; delays/spreads/deltas hand-verified', async () => {
    // Hand math (scripted delays): g:6+46 {5,5} → 5.0 ± 0.0 (best);
    // g:7+45 {7,8} → 7.5 ± 0.7; g:5+47 {10,12} → 11.0 ± 1.4 (current).
    const config = createDefaultConfig();
    const outcome = await scriptedOutcome(config, 3);
    const appliedGreens = outcome.current.greens; // [5, 47]
    const view = buildResultsView(outcome, appliedGreens, 8400);

    expect(view.rows.map((row) => row.candidateId)).toEqual(outcome.report.ranked.map((row) => row.candidate.id));
    expect(view.rows.map((row) => row.rank)).toEqual([1, 2, 3]);

    const [best, middle, current] = view.rows;
    if (best === undefined || middle === undefined || current === undefined) throw new Error('rows missing');

    expect(best.candidateId).toBe('g:6+46');
    expect(best.isBest).toBe(true);
    expect(best.isCurrent).toBe(false);
    expect(best.delayText).toBe('5.0 s');
    expect(best.spreadText).toBe('± 0.0 s');
    expect(best.deltaText).toBe('-6.0 s vs current');

    expect(middle.candidateId).toBe('g:7+45');
    expect(middle.delayText).toBe('7.5 s');
    expect(middle.spreadText).toBe('± 0.7 s');
    expect(middle.deltaText).toBe('-3.5 s vs current');

    expect(current.candidateId).toBe('g:5+47');
    expect(current.isCurrent).toBe(true);
    expect(current.delayText).toBe('11.0 s');
    expect(current.spreadText).toBe('± 1.4 s');
    expect(current.deltaText).toBeNull(); // the current row carries the marker instead

    expect(view.currentDelayText).toBe('11.0 s');
    expect(view.currentSpreadText).toBe('± 1.4 s');
    expect(view.candidateCount).toBe(3);
    expect(view.totalRuns).toBe(6);
    expect(view.executorName).toBe('scripted');
    expect(view.reps).toBe(2);
    expect(view.horizonSeconds).toBe(10);
    expect(view.elapsedMs).toBe(8400);
  });

  it('unrankable (trip-less) candidates render em-dashes without delta', async () => {
    const config = createDefaultConfig();
    const outcome = await scriptedOutcome(config, 4);
    const view = buildResultsView(outcome, [99, 99], 0);
    const last = view.rows[view.rows.length - 1];
    if (last === undefined) throw new Error('missing row');
    expect(last.delayMeanSeconds).toBeNull();
    expect(last.delayText).toBe('—');
    expect(last.spreadText).toBeNull();
    expect(last.deltaText).toBeNull();
    expect(last.isBest).toBe(false);
  });

  it('the current marker follows the applied greens (null under all-way stop)', async () => {
    const config = createDefaultConfig();
    const outcome = await scriptedOutcome(config, 3);
    const marked = buildResultsView(outcome, [6, 46], 0); // the best row's greens
    expect(marked.rows[0]?.isCurrent).toBe(true);
    const none = buildResultsView(outcome, null, 0);
    expect(none.rows.some((row) => row.isCurrent)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Apply path (model seam + end-to-end through PanelModel and SimRuntime)
// ---------------------------------------------------------------------------

describe('OptimizerModel — apply', () => {
  it('routes the ranked plan through the apply seam and records blocking issues', async () => {
    const harness = makeHarness();
    const { model, service, appliedPlans } = harness;
    const outcome = await scriptedOutcome(createDefaultConfig(), 3);
    model.start();
    service.finish(outcome);
    await untilPhase(model, 'done');

    expect(model.apply(1)).toEqual([]);
    expect(appliedPlans).toHaveLength(1);
    expect(appliedPlans[0]).toBe(outcome.report.ranked[0]?.candidate.plan);
    expect(model.applyIssues).toBeNull();

    harness.applyIssues = [{ path: 'control.plan', message: 'nope' }];
    const issues = model.apply(2);
    expect(issues).toEqual([{ path: 'control.plan', message: 'nope' }]);
    expect(model.applyIssues).toEqual(issues);
    // Unknown rank / no results → null, seam untouched.
    expect(model.apply(99)).toBeNull();
    expect(appliedPlans).toHaveLength(2);
  });

  it('end-to-end: PanelModel validation → ONE config-change → SimRuntime live apply + metrics reset', async () => {
    const balanced = getPreset('balanced').config;
    const panel = new PanelModel(balanced);
    const runtime = new SimRuntime(balanced);

    // Accumulate stats under the current plan (90 sim-seconds).
    for (let tick = 0; tick < 900; tick += 1) runtime.step();
    const before = runtime.metrics.snapshot();
    expect(before.tripCount).toBeGreaterThan(0);

    const events: PanelEvent[] = [];
    panel.subscribe((event) => events.push(event));

    const harness = makeHarness(balanced);
    const model = new OptimizerModel({
      service: harness.service,
      getConfig: () => panel.config,
      applyPlan: (plan) => panel.applySignalPlan(plan),
      now: () => 0,
    });
    const outcome = await scriptedOutcome(balanced, 3);
    model.start();
    harness.service.finish(outcome);
    await untilPhase(model, 'done');

    const issues = model.apply(1);
    expect(issues).toEqual([]); // validation passed through the panel model

    // Exactly one config-change, carrying the full validated config.
    expect(events).toHaveLength(1);
    const event = events[0];
    if (event === undefined || event.type !== 'config-change') throw new Error('expected config-change');
    expect(validateConfig(event.config)).toEqual([]);
    const appliedGreens = outcome.report.ranked[0]?.candidate.greens;
    const beforeGreens = balanced.control.type === 'signal' ? balanced.control.plan.phases.map((p) => p.greenSeconds) : [];
    expect(appliedGreens).not.toEqual(beforeGreens); // phase durations change measurably
    if (event.config.control.type !== 'signal') throw new Error('expected signal');
    expect(event.config.control.plan.phases.map((phase) => phase.greenSeconds)).toEqual(appliedGreens);
    // The applied plan survives config inspection on the panel model.
    const panelPlan = panel.config.control.type === 'signal' ? panel.config.control.plan : null;
    expect(panelPlan?.phases.map((phase) => phase.greenSeconds)).toEqual(appliedGreens);

    // Live semantics + metrics reset, exactly as the app's config-change handler does.
    const result = runtime.applyConfig(event.config);
    expect(result.scope).toBe('live');
    expect(result.controlChanged).toBe(true);
    expect(result.geometryRebuilt).toBe(false);
    const runtimePlan = runtime.config.control.type === 'signal' ? runtime.config.control.plan : null;
    expect(runtimePlan?.phases.map((phase) => phase.greenSeconds)).toEqual(appliedGreens);
    const after = runtime.metrics.snapshot();
    expect(after.tripCount).toBe(0); // stats window reset observed
    expect(after.elapsedSinceResetSeconds).toBeLessThan(before.timeSeconds);

    // Re-applying the same plan emits nothing new (idempotent commit).
    expect(model.apply(1)).toEqual([]);
    expect(events).toHaveLength(1);
  });

  it('end-to-end: applying under all-way stop is blocked with issues, no config-change', async () => {
    const balanced = getPreset('balanced').config;
    const panel = new PanelModel(balanced);
    const events: PanelEvent[] = [];
    panel.subscribe((event) => events.push(event));
    panel.setControlType('all-way-stop');
    expect(events).toHaveLength(1);

    // The sweep itself ran on the (signal) balanced snapshot; only the APPLY
    // path hits the panel, whose control type is now all-way stop.
    const harness = makeHarness(balanced);
    const model = new OptimizerModel({
      service: harness.service,
      getConfig: () => balanced,
      applyPlan: (plan) => panel.applySignalPlan(plan),
      now: () => 0,
    });
    const outcome = await scriptedOutcome(balanced, 3);
    model.start();
    harness.service.finish(outcome);
    await untilPhase(model, 'done');

    const issues = model.apply(1);
    expect(issues).not.toBeNull();
    expect(issues?.length).toBeGreaterThan(0);
    expect(model.applyIssues).toEqual(issues);
    expect(events).toHaveLength(1); // nothing new applied
  });
});
