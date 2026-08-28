/**
 * Optimizer sweep service (task O2): the async seam between the O1 sweep
 * harness and the optimizer UI. One call runs the DEFAULT sweep (coarse grid
 * + refinement) on the captured config AND guarantees a measured baseline for
 * the CURRENT plan, so the results panel can always compare "ranked
 * candidates vs current" on equal terms.
 *
 * ## Current-plan baseline (documented design)
 *
 * The sweep report only contains lattice candidates. The current plan's
 * greens may or may not lie on that lattice, so after the sweep the service
 * looks the current plan up in the report:
 * - found (`measured: 'in-report'`) — reuse the report row (determinism makes
 *   a dedicated re-run bit-identical, so this is purely saving 3 runs);
 * - missing (`measured: 'dedicated-run'`) — run the current plan as a single
 *   extra candidate through `runSweep` on the SAME executor and the SAME
 *   paired seeds (same masterSeed/reps/horizon ⇒ identical demand
 *   realizations per rep — the paired-seed comparison the town hall pins).
 *
 * ## Executor selection (R2 Part A, O2 contract)
 *
 * Default: `WorkerPoolExecutor` (feature-detected: `typeof Worker ===
 * 'function'`) so the live sim keeps its frame budget; fallback:
 * `TimeSlicedExecutor`. On top of the static feature-detect, a runtime
 * escape hatch: if the primary executor fails BEFORE the first completed run
 * and the failure is not a cancellation (e.g. worker construction blocked by
 * CSP), the whole sweep re-runs once on the fallback — deterministic, so a
 * partial first attempt costs nothing but time. Failures after progress, and
 * cancellations, always propagate unchanged.
 *
 * Progress: `{completed, total}` per completed run, rebased across phases
 * (sweep stage 2 and the dedicated current-plan run extend the totals); the
 * `total` can therefore grow mid-run — it is always the current phase's full
 * extent, never a lie.
 */
import type { IntersectionConfig, SignalPlanConfig } from '../../config';
import { SweepCancelledError, TimeSlicedExecutor, WorkerPoolExecutor } from '../../optimizer';
import { runDefaultSweep, runSweep } from '../../optimizer';
import type {
  CandidateSweepResult,
  SweepCandidate,
  SweepExecutor,
  SweepProgress,
  SweepReport,
} from '../../optimizer';

/** How the current plan's baseline number was obtained (see module doc). */
export type CurrentPlanMeasurement = 'in-report' | 'dedicated-run';

/** The current plan, measured under the sweep's paired seeds. */
export interface OptimizerCurrentPlanResult {
  readonly candidateId: string;
  readonly greens: readonly number[];
  readonly meanControlDelaySeconds: number | null;
  readonly varianceAcrossReps: number | null;
  readonly sampleStdDevSeconds: number | null;
  readonly measured: CurrentPlanMeasurement;
}

/** What one finished optimizer run produces for the UI. */
export interface OptimizerSweepOutcome {
  readonly report: SweepReport;
  readonly current: OptimizerCurrentPlanResult;
}

export type OptimizerSweepProgress = SweepProgress;

export interface OptimizerSweepService {
  /**
   * Run the default sweep + current-plan baseline on `config` (captured at
   * call time — later config edits do not redirect a running sweep).
   * Rejects with `SweepCancelledError` on `cancel()`.
   */
  run(config: IntersectionConfig, onProgress: (progress: OptimizerSweepProgress) => void): Promise<OptimizerSweepOutcome>;
  /** Abort the in-flight run (no-op when idle). */
  cancel(): void;
}

/** Tuning passthrough (defaults: O1's masterSeed 1, 3 reps, 45 s horizon). */
export interface OptimizerSweepTuning {
  readonly masterSeed?: number;
  readonly reps?: number;
  readonly horizonSeconds?: number;
}

export interface OptimizerServiceOptions {
  /** Primary executor factory (default: worker pool, feature-detected). */
  readonly createExecutor?: () => SweepExecutor;
  /** Runtime-fallback executor factory (default: time-sliced). */
  readonly createFallbackExecutor?: () => SweepExecutor;
  /** Sweep tuning overrides (tests, Q2 perf harness). */
  readonly tuning?: OptimizerSweepTuning;
}

/**
 * The current config's plan as a sweep candidate — the same id/greens/plan
 * construction the O1 candidate space uses, so report-row lookup by id is
 * exact. Throws for non-signal configs (a sweep requires a signal plan).
 */
export function currentPlanCandidate(config: IntersectionConfig): SweepCandidate {
  if (config.control.type !== 'signal') {
    throw new Error(`the optimizer requires control.type 'signal', got '${String(config.control.type)}'`);
  }
  const plan: SignalPlanConfig = config.control.plan;
  const greens = plan.phases.map((phase) => phase.greenSeconds);
  return {
    id: `g:${greens.join('+')}`,
    greens,
    plan: {
      cycleLengthSeconds: plan.cycleLengthSeconds,
      leftMode: { ns: plan.leftMode.ns, ew: plan.leftMode.ew },
      phases: plan.phases.map((phase) => ({ kind: phase.kind, greenSeconds: phase.greenSeconds })),
    },
  };
}

/** The report row whose candidate is `config`'s current plan, if present. */
export function findCurrentRow(report: SweepReport, config: IntersectionConfig): CandidateSweepResult | null {
  const candidate = currentPlanCandidate(config);
  return report.ranked.find((row) => row.candidate.id === candidate.id) ?? null;
}

function currentFromRow(row: CandidateSweepResult, measured: CurrentPlanMeasurement): OptimizerCurrentPlanResult {
  return {
    candidateId: row.candidate.id,
    greens: row.candidate.greens,
    meanControlDelaySeconds: row.meanControlDelaySeconds,
    varianceAcrossReps: row.varianceAcrossReps,
    sampleStdDevSeconds: row.sampleStdDevSeconds,
    measured,
  };
}

function createDefaultExecutorFactory(): () => SweepExecutor {
  // Feature-detect (O2 contract): dedicated workers when the platform has
  // them, budgeted time-slicing otherwise. The static-literal worker
  // construction stays inside executor.ts (Vite's emission pattern).
  return typeof Worker === 'function' ? () => new WorkerPoolExecutor() : () => new TimeSlicedExecutor();
}

export function createOptimizerSweepService(options: OptimizerServiceOptions = {}): OptimizerSweepService {
  const createPrimary = options.createExecutor ?? createDefaultExecutorFactory();
  const createFallback = options.createFallbackExecutor ?? (() => new TimeSlicedExecutor());
  const tuning: OptimizerSweepTuning = options.tuning ?? {};
  let active: SweepExecutor | null = null;

  /**
   * Rebase per-phase progress into one monotonic run count: each sweep
   * phase (coarse stage, refine stage, dedicated current-plan run) reports
   * `{1..T}` with its own `T`; on a phase switch (total changed, or the
   * count restarted) the previous phase's total is folded into the base, so
   * `completed` never goes backwards and `total` is the full known extent.
   */
  function makeProgressRebaser(onProgress: (progress: OptimizerSweepProgress) => void): (progress: SweepProgress) => void {
    let base = 0;
    let lastTotal: number | null = null;
    let lastCompleted = 0;
    return (progress) => {
      if (lastTotal !== null && (progress.total !== lastTotal || progress.completed < lastCompleted)) {
        base += lastTotal;
      }
      lastTotal = progress.total;
      lastCompleted = progress.completed;
      onProgress({ completed: base + progress.completed, total: base + progress.total });
    };
  }

  async function runPhases(
    config: IntersectionConfig,
    executor: SweepExecutor,
    onProgress: (progress: OptimizerSweepProgress) => void,
  ): Promise<OptimizerSweepOutcome> {
    active = executor;
    try {
      const reportProgress = makeProgressRebaser(onProgress);
      const report = await runDefaultSweep(config, { executor, ...tuning, onProgress: reportProgress });
      const inReport = findCurrentRow(report, config);
      if (inReport !== null) {
        return { report, current: currentFromRow(inReport, 'in-report') };
      }
      // Current plan is off the swept lattice: measure it as one extra
      // candidate on the same executor / seeds; progress continues the count.
      const baseline = await runSweep(config, [currentPlanCandidate(config)], {
        executor,
        ...tuning,
        onProgress: reportProgress,
      });
      const row = baseline.ranked[0];
      if (row === undefined) throw new Error('current-plan baseline sweep produced no rows');
      return { report, current: currentFromRow(row, 'dedicated-run') };
    } finally {
      if (active === executor) active = null;
    }
  }

  return {
    async run(config, onProgress) {
      if (config.control.type !== 'signal') {
        throw new Error(`the optimizer requires control.type 'signal', got '${String(config.control.type)}'`);
      }
      let completed = 0;
      const trackProgress = (progress: OptimizerSweepProgress): void => {
        completed = Math.max(completed, progress.completed);
        onProgress(progress);
      };
      try {
        return await runPhases(config, createPrimary(), trackProgress);
      } catch (error) {
        if (error instanceof SweepCancelledError) throw error;
        if (completed > 0) throw error;
        // Environment-style failure before any result (worker construction
        // blocked, module load refused, …): one deterministic retry on the
        // fallback executor, from scratch.
        completed = 0;
        return await runPhases(config, createFallback(), trackProgress);
      }
    },
    cancel(): void {
      active?.cancel();
    },
  };
}
