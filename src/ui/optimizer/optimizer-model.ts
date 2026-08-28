/**
 * Optimizer UI model (task O2): the pure, DOM-free state machine behind the
 * optimizer panel — the same discipline as U2's PanelModel (no DOM, no
 * unsealed clocks, unit-testable in node).
 *
 * ## State machine (acceptance: no dead states)
 *
 * `idle → running → done | cancelled | failed`, and EVERY terminal state
 * (`idle`, `done`, `cancelled`, `failed`) can `start()` again — `running`
 * alone refuses (returns false, keeps the run). `cancel()` is only wired
 * while running; the phase flips to `cancelled` when the service rejects
 * with `SweepCancelledError`.
 *
 * ## Cancellation semantics (documented choice)
 *
 * Partial results are DISCARDED, not shown: a sweep is only rankable with
 * its full paired-seed candidate set (every candidate must have run against
 * every rep's shared demand realization), so a half-finished ranking would
 * be actively misleading. The status line says so; `results` stays null.
 *
 * ## Progress binding (acceptance: bounded DOM writes)
 *
 * The service fires one progress callback per completed run; the model
 * stores the LATEST values but only emits a render event when (a) it is the
 * first callback, (b) ≥ `progressIntervalMs` (default 150 ms) passed since
 * the last emitted one, or (c) the callback is final (`completed ===
 * total`). N callbacks therefore produce at most ~N·step/interval + 2
 * renders, and the last render always carries the newest numbers
 * (coalescing: skipped callbacks never render stale values later). Terminal
 * transitions (`done`/`cancelled`/`failed`) always render regardless.
 *
 * ## Apply path (acceptance)
 *
 * `apply(rank)` routes the candidate's plan through the injected
 * `applyPlan` seam — in the app that is `PanelModel.applySignalPlan`, i.e.
 * the U2 validation-gated commit path: one `config-change` carrying a
 * plan-only diff (live apply + metrics reset downstream). Issues returned
 * by the seam are surfaced verbatim (`applyIssues`); the optimizer never
 * mutates the config itself.
 */
import type { IntersectionConfig, SignalPlanConfig, ValidationIssue } from '../../config';
import { SweepCancelledError } from '../../optimizer';
import type { SweepProgress } from '../../optimizer';
import type { OptimizerSweepOutcome, OptimizerSweepService } from './sweep-service';

export type OptimizerPhase = 'idle' | 'running' | 'done' | 'cancelled' | 'failed';

export interface OptimizerModelOptions {
  /** The sweep runner (see sweep-service.ts). */
  readonly service: OptimizerSweepService;
  /** The APPLIED config at sweep start (the sweep runs on this snapshot). */
  readonly getConfig: () => IntersectionConfig;
  /**
   * Apply seam: install a candidate's signal plan through the U2 panel
   * model (validation-gated). Returns the issues that blocked the apply;
   * empty means applied.
   */
  readonly applyPlan: (plan: SignalPlanConfig) => readonly ValidationIssue[];
  /** Clock seam (default `performance.now`; tests inject a fake). */
  readonly now?: () => number;
  /** Minimum wall-clock ms between progress renders (default 150). */
  readonly progressIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// Results view model (pure mapping — display strings computed once)
// ---------------------------------------------------------------------------

/** One ranked plan, ready for the DOM (values verbatim from the report). */
export interface OptimizerRowView {
  readonly rank: number;
  readonly candidateId: string;
  readonly greens: readonly number[];
  readonly greensLabel: string;
  readonly delayMeanSeconds: number | null;
  readonly delayText: string;
  readonly spreadText: string | null;
  readonly deltaText: string | null;
  readonly isBest: boolean;
  readonly isCurrent: boolean;
  readonly plan: SignalPlanConfig;
}

export interface OptimizerResultsView {
  readonly rows: readonly OptimizerRowView[];
  readonly candidateCount: number;
  readonly totalRuns: number;
  readonly executorName: string;
  readonly reps: number;
  readonly horizonSeconds: number;
  readonly elapsedMs: number;
  readonly currentDelayText: string | null;
  readonly currentSpreadText: string | null;
  readonly currentMeasuredLabel: string;
}

function formatSeconds(seconds: number): string {
  return `${seconds.toFixed(1)} s`;
}

function greensEqual(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function appliedPlanGreens(config: IntersectionConfig): readonly number[] | null {
  return config.control.type === 'signal' ? config.control.plan.phases.map((phase) => phase.greenSeconds) : null;
}

/**
 * Map a sweep outcome to display rows, 1:1 with `report.ranked` (same order,
 * same count). `appliedGreens` (the live applied plan's greens, null under
 * all-way stop) drives the "current" marker, so the marker follows applies
 * and manual edits — the "observe improvement" loop end of the journey.
 */
export function buildResultsView(
  outcome: OptimizerSweepOutcome,
  appliedGreens: readonly number[] | null,
  elapsedMs: number,
): OptimizerResultsView {
  const current = outcome.current;
  const currentMean = current.meanControlDelaySeconds;
  const rows: OptimizerRowView[] = outcome.report.ranked.map((row) => {
    const mean = row.meanControlDelaySeconds;
    const isCurrent = appliedGreens !== null && greensEqual(row.candidate.greens, appliedGreens);
    let deltaText: string | null = null;
    if (!isCurrent && mean !== null && currentMean !== null) {
      const delta = mean - currentMean;
      const sign = delta >= 0 ? '+' : '';
      deltaText = `${sign}${delta.toFixed(1)} s vs current`;
    }
    return {
      rank: row.rank,
      candidateId: row.candidate.id,
      greens: row.candidate.greens,
      greensLabel: row.candidate.greens.join(' + '),
      delayMeanSeconds: mean,
      delayText: mean === null ? '—' : formatSeconds(mean),
      spreadText: row.sampleStdDevSeconds === null ? null : `± ${row.sampleStdDevSeconds.toFixed(1)} s`,
      deltaText,
      isBest: row.rank === 1,
      isCurrent,
      plan: row.candidate.plan,
    };
  });
  return {
    rows,
    candidateCount: outcome.report.candidateCount,
    totalRuns: outcome.report.totalRuns,
    executorName: outcome.report.executorName,
    reps: outcome.report.reps,
    horizonSeconds: outcome.report.horizonSeconds,
    elapsedMs,
    currentDelayText: currentMean === null ? null : formatSeconds(currentMean),
    currentSpreadText: current.sampleStdDevSeconds === null ? null : `± ${current.sampleStdDevSeconds.toFixed(1)} s`,
    currentMeasuredLabel:
      current.measured === 'in-report' ? 'measured in sweep' : 'measured as extra paired runs',
  };
}

// ---------------------------------------------------------------------------
// OptimizerModel
// ---------------------------------------------------------------------------

export class OptimizerModel {
  private phaseState: OptimizerPhase = 'idle';
  private readonly service: OptimizerSweepService;
  private readonly getConfig: () => IntersectionConfig;
  private readonly applyPlan: (plan: SignalPlanConfig) => readonly ValidationIssue[];
  private readonly now: () => number;
  private readonly progressIntervalMs: number;
  private readonly listeners: (() => void)[] = [];

  private resultsState: OptimizerSweepOutcome | null = null;
  private resultsElapsedMs = 0;
  private progressState: SweepProgress | null = null;
  private startedAtMs = 0;
  private lastProgressRenderAt: number | null = null;
  private errorTextState: string | null = null;
  private applyIssuesState: readonly ValidationIssue[] | null = null;
  private lastCancelledCompleted: number | null = null;

  constructor(options: OptimizerModelOptions) {
    this.service = options.service;
    this.getConfig = options.getConfig;
    this.applyPlan = options.applyPlan;
    this.now = options.now ?? (() => performance.now());
    this.progressIntervalMs = options.progressIntervalMs ?? 150;
  }

  // --- read side -----------------------------------------------------------

  get phase(): OptimizerPhase {
    return this.phaseState;
  }

  get isRunning(): boolean {
    return this.phaseState === 'running';
  }

  /** Terminal states (and idle) can always start a fresh sweep — no dead states. */
  get canStart(): boolean {
    return this.phaseState !== 'running' && this.startBlockedReason === null;
  }

  get canCancel(): boolean {
    return this.phaseState === 'running';
  }

  /** Why a sweep cannot start right now (null = it can). */
  get startBlockedReason(): string | null {
    const config = this.getConfig();
    return config.control.type === 'signal'
      ? null
      : 'Switch the control type to signal to optimize its timings.';
  }

  /** Latest progress (values coalesced; rendered events are throttled). */
  get progress(): SweepProgress | null {
    return this.progressState;
  }

  /** Elapsed wall-clock ms since the current/last sweep started. */
  get elapsedMs(): number {
    return this.phaseState === 'idle' ? 0 : this.now() - this.startedAtMs;
  }

  get errorText(): string | null {
    return this.errorTextState;
  }

  /** Issues from the last blocked apply (null = none / applied cleanly). */
  get applyIssues(): readonly ValidationIssue[] | null {
    return this.applyIssuesState;
  }

  /** Completed-run count at the moment of the last cancellation (for status). */
  get cancelledAfterCompleted(): number | null {
    return this.lastCancelledCompleted;
  }

  /**
   * The last finished sweep's outcome (stable object identity — the view
   * rebuild key), or null while running/idle/cancelled.
   */
  get outcome(): OptimizerSweepOutcome | null {
    return this.resultsState;
  }

  /** Candidate id of the row matching the APPLIED plan (null = none). */
  get appliedCandidateId(): string | null {
    const outcome = this.resultsState;
    if (outcome === null) return null;
    const greens = appliedPlanGreens(this.getConfig());
    if (greens === null) return null;
    const row = outcome.report.ranked.find((entry) => greensEqual(entry.candidate.greens, greens));
    return row?.candidate.id ?? null;
  }

  /** Display rows for the last finished sweep (null while running/idle). */
  get results(): OptimizerResultsView | null {
    if (this.resultsState === null) return null;
    return buildResultsView(this.resultsState, appliedPlanGreens(this.getConfig()), this.resultsElapsedMs);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  // --- actions ---------------------------------------------------------------

  /**
   * Start the default sweep on the CURRENT applied config. Returns false (and
   * changes nothing) while a sweep runs or the config has no signal plan.
   */
  start(): boolean {
    if (this.phaseState === 'running') return false;
    if (this.startBlockedReason !== null) return false;
    this.phaseState = 'running';
    this.resultsState = null;
    this.resultsElapsedMs = 0;
    this.progressState = null;
    this.errorTextState = null;
    this.applyIssuesState = null;
    this.lastCancelledCompleted = null;
    this.startedAtMs = this.now();
    this.lastProgressRenderAt = null;
    this.emit();
    void this.settle(
      this.service.run(this.getConfig(), (progress) => this.onProgress(progress)),
    );
    return true;
  }

  /** Request cancellation; the phase flips when the service rejects. */
  cancel(): void {
    if (this.phaseState !== 'running') return;
    this.service.cancel();
  }

  /**
   * Apply the ranked plan with the given rank through the apply seam.
   * Returns the seam's issues (empty = applied), or null when there is
   * nothing to apply from (no results / unknown rank).
   */
  apply(rank: number): readonly ValidationIssue[] | null {
    const outcome = this.resultsState;
    if (outcome === null) return null;
    const row = outcome.report.ranked.find((entry) => entry.rank === rank);
    if (row === undefined) return null;
    const issues = this.applyPlan(row.candidate.plan);
    this.applyIssuesState = issues.length > 0 ? issues : null;
    this.emit();
    return issues;
  }

  /** The applied config changed (apply, edit, preset) — refresh markers. */
  notifyConfigChanged(): void {
    this.emit();
  }

  // --- internals ---------------------------------------------------------------

  private onProgress(progress: SweepProgress): void {
    this.progressState = { completed: progress.completed, total: progress.total };
    const nowMs = this.now();
    const isFinal = progress.completed >= progress.total;
    if (isFinal || this.lastProgressRenderAt === null || nowMs - this.lastProgressRenderAt >= this.progressIntervalMs) {
      this.lastProgressRenderAt = nowMs;
      this.emit();
    }
  }

  private async settle(promise: Promise<OptimizerSweepOutcome>): Promise<void> {
    try {
      const outcome = await promise;
      if (this.phaseState !== 'running') return;
      this.resultsState = outcome;
      this.resultsElapsedMs = this.now() - this.startedAtMs;
      this.progressState = null;
      this.phaseState = 'done';
      this.emit();
    } catch (error) {
      if (this.phaseState !== 'running') return;
      this.progressState = null;
      this.resultsState = null;
      if (error instanceof SweepCancelledError) {
        this.lastCancelledCompleted = error.completed;
        this.phaseState = 'cancelled';
        this.errorTextState = null;
      } else {
        this.phaseState = 'failed';
        this.errorTextState = error instanceof Error ? error.message : String(error);
      }
      this.emit();
    }
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
