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

/**
 * One renderable piece of the sweep verdict sentence. `mono` marks numeric
 * segments (The Numbers Are Mono Rule); `strong` marks the verdict label.
 */
export interface OptimizerVerdictSegment {
  readonly text: string;
  readonly mono: boolean;
  readonly strong: boolean;
}

/** What the sweep concluded about the operator's current tuning. */
export type OptimizerVerdictKind = 'confirmed' | 'sweep-wins' | 'unmeasured';

/** The sweep's one-sentence judgment on the current plan (delight moment). */
export interface OptimizerVerdict {
  readonly kind: OptimizerVerdictKind;
  /** Mean control delay rank 1 saves vs the current plan (null = unmeasured). */
  readonly improvementSeconds: number | null;
  readonly segments: readonly OptimizerVerdictSegment[];
}

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
  /** Live current-plan delay text (rebased to the plan actually running). */
  readonly currentDelayText: string | null;
  /** The summary line's "Current plan: …" clause, composed (pure). */
  readonly currentLine: string;
  readonly verdict: OptimizerVerdict;
}

/** Why there is (or is not) a measured baseline for the RUNNING plan. */
export type VerdictCurrentInput =
  | { readonly status: 'measured'; readonly meanSeconds: number }
  | { readonly status: 'absent' }
  | { readonly status: 'unmeasured' };

/** The running plan's measured baseline, resolved against the report. */
export interface ResolvedCurrentPlan {
  readonly meanSeconds: number | null;
  readonly stdDevSeconds: number | null;
  readonly verdictInput: VerdictCurrentInput;
}

function formatSeconds(seconds: number): string {
  return `${seconds.toFixed(1)} s`;
}

/** Float-fuzz slack for "did any candidate actually beat the current plan?". */
const VERDICT_TIE_EPSILON_SECONDS = 1e-9;

const VERDICT_LABEL: OptimizerVerdictSegment = { text: 'Verdict — ', mono: false, strong: true };

/**
 * The sweep's judgment on the plan CURRENTLY RUNNING, in the product's
 * deadpan register (the brief: the optimizer "confirms or embarrasses").
 * `current` is resolved against the LIVE applied plan, so applying rank 1
 * flips the verdict to confirmed. A tie (within float fuzz) counts as
 * confirmed — nothing beat the plan.
 */
export function buildVerdict(
  rank1MeanSeconds: number | null,
  current: VerdictCurrentInput,
): OptimizerVerdict {
  if (rank1MeanSeconds === null) {
    return unmeasured('no completed trips to judge: raise a spawn rate and sweep again.');
  }
  if (current.status === 'absent') {
    return unmeasured('no signal plan is running: switch back from all-way stop, then sweep again.');
  }
  if (current.status === 'unmeasured') {
    return unmeasured('the running plan is not in this sweep: sweep again to judge it.');
  }
  const improvement = current.meanSeconds - rank1MeanSeconds; // > 0 ⇒ the sweep found better
  if (improvement <= VERDICT_TIE_EPSILON_SECONDS) {
    return {
      kind: 'confirmed',
      improvementSeconds: improvement,
      segments: [
        VERDICT_LABEL,
        { text: 'current plan confirmed: no swept candidate beat it on these seeds.', mono: false, strong: false },
      ],
    };
  }
  return {
    kind: 'sweep-wins',
    improvementSeconds: improvement,
    segments: [
      VERDICT_LABEL,
      { text: 'rank 1 cuts mean control delay by ', mono: false, strong: false },
      { text: formatSeconds(improvement), mono: true, strong: false },
      { text: ' vs the current plan.', mono: false, strong: false },
    ],
  };
}

function unmeasured(sentence: string): OptimizerVerdict {
  return {
    kind: 'unmeasured',
    improvementSeconds: null,
    segments: [VERDICT_LABEL, { text: sentence, mono: false, strong: false }],
  };
}

/**
 * Resolve the RUNNING plan's measured baseline: the report row matching the
 * applied greens, the sweep-time baseline when those greens are still
 * current, or an explicit "not measured" when the plan changed off-lattice.
 * `appliedGreens === null` means no signal plan is running (all-way stop).
 */
export function resolveCurrentPlan(
  outcome: OptimizerSweepOutcome,
  appliedGreens: readonly number[] | null,
): ResolvedCurrentPlan {
  if (appliedGreens === null) {
    return { meanSeconds: null, stdDevSeconds: null, verdictInput: { status: 'absent' } };
  }
  const inReport = outcome.report.ranked.find((row) => greensEqual(row.candidate.greens, appliedGreens));
  if (inReport !== undefined) {
    return {
      meanSeconds: inReport.meanControlDelaySeconds,
      stdDevSeconds: inReport.sampleStdDevSeconds,
      verdictInput:
        inReport.meanControlDelaySeconds === null
          ? { status: 'unmeasured' }
          : { status: 'measured', meanSeconds: inReport.meanControlDelaySeconds },
    };
  }
  if (greensEqual(outcome.current.greens, appliedGreens)) {
    return {
      meanSeconds: outcome.current.meanControlDelaySeconds,
      stdDevSeconds: outcome.current.sampleStdDevSeconds,
      verdictInput:
        outcome.current.meanControlDelaySeconds === null
          ? { status: 'unmeasured' }
          : { status: 'measured', meanSeconds: outcome.current.meanControlDelaySeconds },
    };
  }
  // Applied after the sweep (manual green edit): this plan has no number here.
  return { meanSeconds: null, stdDevSeconds: null, verdictInput: { status: 'unmeasured' } };
}

/** The summary's "Current plan: …" clause from the resolved baseline. */
function currentLineText(current: ResolvedCurrentPlan): string {
  if (current.verdictInput.status === 'absent') return 'Current plan: none (all-way stop is running)';
  if (current.meanSeconds === null) return 'Current plan: not measured in this sweep';
  const bits = [formatSeconds(current.meanSeconds)];
  if (current.stdDevSeconds !== null) bits.push(`± ${current.stdDevSeconds.toFixed(1)} s`);
  const source =
    current.verdictInput.status === 'unmeasured'
      ? 'not measured in this sweep'
      : 'measured on these seeds';
  return `Current plan: ${bits.join(' ')} (${source})`;
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
  const rank1 = outcome.report.ranked[0] ?? null;
  // The baseline is the plan RUNNING now, not the one the sweep started
  // from — applying a candidate re-baselines every "vs current" number.
  const live = resolveCurrentPlan(outcome, appliedGreens);
  const currentMean = live.meanSeconds;
  const rows: OptimizerRowView[] = outcome.report.ranked.map((row) => {
    const mean = row.meanControlDelaySeconds;
    const isCurrent = appliedGreens !== null && greensEqual(row.candidate.greens, appliedGreens);
    let deltaText: string | null = null;
    if (!isCurrent && mean !== null && currentMean !== null) {
      const delta = mean - currentMean;
      const sign = delta >= 0 ? '+' : '';
      deltaText = `${sign}${delta.toFixed(1)} s`;
    }
    return {
      rank: row.rank,
      candidateId: row.candidate.id,
      greens: row.candidate.greens,
      // Slash notation ("5/26/5/7") keeps a 4-phase label inside the row's
      // greens column at the 340px panel (layout pass).
      greensLabel: row.candidate.greens.join('/'),
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
    currentDelayText: live.meanSeconds === null ? null : formatSeconds(live.meanSeconds),
    currentLine: currentLineText(live),
    verdict: buildVerdict(rank1?.meanControlDelaySeconds ?? null, live.verdictInput),
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
