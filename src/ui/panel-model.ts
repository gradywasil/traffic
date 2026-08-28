/**
 * Panel UI model (task U2): the pure, DOM-free state machine behind the
 * control panel. Every user-editable `IntersectionConfig` field is an action
 * here; every action runs F2's `validateConfig` before anything is applied,
 * so the panel can only ever emit VALID configs as `config-change` events
 * (invalid drafts are kept for the user to fix and their `ValidationIssue`s
 * are exposed for display — the "prevented or clearly flagged" stance).
 *
 * Binding rules (documented choices, see production-log T-U2):
 * - The model holds a DRAFT config (the user's live editing state, possibly
 *   invalid) and the APPLIED config (the last valid state, what the app runs).
 *   An action that leaves the draft valid AND different emits one
 *   `config-change` carrying the full new config; edit-while-running is a
 *   stream of these events, applied live by `SimRuntime`.
 * - Turn-mix edits rescale the other two parts to keep the sum at exactly 1
 *   (fixup on the largest part kills float drift against F2's 1e-6 tolerance).
 *   Setting a positive probability for a turn no lane serves is NOT silently
 *   fixed here — it is flagged (the issue names the arm and turn).
 * - Lane-count/designation edits DO coerce the mix (zeroing probabilities of
 *   turns that lost their lane, then renormalizing) and harmonize the signal
 *   plan (`leftMode` re-derived via F2's `defaultLeftModes`, ring rebuilt,
 *   greens carried over per phase kind, cycle auto-refit) — structural edits
 *   should keep the intersection runnable, not strand the user in red tape.
 * - Green durations are integer seconds ≥ g_min (F2's `MIN_GREEN_SECONDS`,
 *   enforced by clamp before validation) and the cycle length auto-refits to
 *   `round(greens + computed change intervals)` — integer greens cannot hit
 *   real-valued lost time exactly (R1 §5.2), F2 allows 0.5 s slack.
 * - Switching control type to all-way stop stashes the signal plan and
 *   switching back restores it (the "compare control types" journey should
 *   not cost the user their tuning).
 *
 * Pure TypeScript: no DOM, no clocks, no randomness — unit-testable in node.
 */
import {
  MAX_SPAWN_RATE_VEH_PER_HOUR,
  MIN_GREEN_SECONDS,
  MIN_LANES_PER_ARM,
  MAX_LANES_PER_ARM,
  TURN_DIRECTIONS,
  defaultLeftModes,
  signalPhaseKinds,
  signalPlanDurationSeconds,
  validateConfig,
} from '../config';
import type {
  ArmId,
  ControlConfig,
  IntersectionConfig,
  LaneConfig,
  LeftMode,
  SignalPlanConfig,
  TurnDirection,
  TurnMix,
  ValidationIssue,
} from '../config';
import { stableStringify } from '../geom';
import { PRESETS } from '../presets';
import type { PresetId } from '../presets';
import type { PlaybackSpeed } from './playback';

/** Green defaults for ring phases that appear without a carried-over value. */
const DEFAULT_PROTECTED_LEFT_GREEN_SECONDS = 10;
const DEFAULT_THROUGH_GREEN_SECONDS = 25;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface PanelConfigEvent {
  readonly type: 'config-change';
  /** The full, validated new config (a fresh object owned by the receiver). */
  readonly config: IntersectionConfig;
}

export interface PanelPauseEvent {
  readonly type: 'pause';
  readonly paused: boolean;
}

export interface PanelSpeedEvent {
  readonly type: 'speed';
  readonly speed: PlaybackSpeed;
}

export interface PanelSelectEvent {
  readonly type: 'select';
  readonly arm: ArmId | null;
  readonly laneIndex: number | null;
}

/**
 * The draft changed WITHOUT applying (invalid edit kept for the user to fix,
 * or an invalid draft fixed back to the applied config). Pure UI signal: the
 * panel re-reads `issues` — without this event an invalid edit would change
 * model state the DOM never shows (found in the polish pass).
 */
export interface PanelDraftEvent {
  readonly type: 'draft-change';
}

export type PanelEvent = PanelConfigEvent | PanelPauseEvent | PanelSpeedEvent | PanelSelectEvent | PanelDraftEvent;

export type PanelEventListener = (event: PanelEvent) => void;

/** Which (arm, lane) the canvas/editor selection points at (null = none). */
export interface PanelSelection {
  readonly arm: ArmId | null;
  readonly laneIndex: number | null;
}

// ---------------------------------------------------------------------------
// Config edit helpers (pure)
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Exact-sum fixup: nudge the largest part so the three probabilities sum to
 * exactly 1 (kills float drift against F2's TURN_MIX_SUM_TOLERANCE = 1e-6).
 */
function withExactSum(parts: Record<TurnDirection, number>): TurnMix {
  const sum = parts.left + parts.through + parts.right;
  let largest: TurnDirection = 'through';
  for (const candidate of TURN_DIRECTIONS) {
    if (parts[candidate] > parts[largest]) largest = candidate;
  }
  parts[largest] += 1 - sum;
  return { left: parts.left, through: parts.through, right: parts.right };
}

/**
 * Set one turn-mix part and rescale the other two so the sum stays exactly 1.
 * If both other parts are already 0, the remainder parks on 'through' when it
 * is one of them (else the first other direction).
 */
export function rescaleTurnMix(current: TurnMix, direction: TurnDirection, fraction: number): TurnMix {
  const value = clamp(fraction, 0, 1);
  const parts: Record<TurnDirection, number> = {
    left: current.left,
    through: current.through,
    right: current.right,
  };
  parts[direction] = value;
  const others = TURN_DIRECTIONS.filter((candidate) => candidate !== direction);
  const a = others[0] ?? direction;
  const b = others[1] ?? direction;
  const otherSum = parts[a] + parts[b];
  const remaining = 1 - value;
  if (otherSum > 0) {
    const scale = remaining / otherSum;
    parts[a] *= scale;
    parts[b] *= scale;
  } else {
    const fallback = a === 'through' ? a : b === 'through' ? b : a;
    parts[fallback] = remaining;
  }
  return withExactSum(parts);
}

/**
 * Coerce a mix onto the turns a lane list actually serves: probabilities of
 * turns with no serving lane are zeroed, the rest renormalized. Structural
 * edits (lane count / designations) use this; direct mix edits are flagged
 * instead (see module doc). Degenerate all-zero results fall back to a single
 * 1.0 on 'through' (or the first served turn).
 */
export function coerceTurnMixToLanes(mix: TurnMix, lanes: readonly LaneConfig[]): TurnMix {
  const served = new Set<TurnDirection>();
  for (const lane of lanes) for (const designation of lane.designations) served.add(designation);
  const zeroed: Record<TurnDirection, number> = {
    left: served.has('left') ? mix.left : 0,
    through: served.has('through') ? mix.through : 0,
    right: served.has('right') ? mix.right : 0,
  };
  const sum = zeroed.left + zeroed.through + zeroed.right;
  if (sum > 0) {
    return withExactSum({
      left: zeroed.left / sum,
      through: zeroed.through / sum,
      right: zeroed.right / sum,
    });
  }
  const fallback: TurnDirection = served.has('through')
    ? 'through'
    : served.has('left')
      ? 'left'
      : 'right';
  return {
    left: fallback === 'left' ? 1 : 0,
    through: fallback === 'through' ? 1 : 0,
    right: fallback === 'right' ? 1 : 0,
  };
}

/** Lane list for a new lane count: truncate, or append a through-only lane. */
export function lanesForCount(current: readonly LaneConfig[], count: number): readonly LaneConfig[] {
  const clamped = Math.round(clamp(count, MIN_LANES_PER_ARM, MAX_LANES_PER_ARM));
  if (clamped <= current.length) return current.slice(0, clamped);
  const grown = [...current];
  while (grown.length < clamped) {
    grown.push({ designations: ['through'] });
  }
  return grown;
}

/** Freshly built signal plan for the arms' derived leftMode, keeping greens per phase kind. */
function harmonizedPlan(
  armsLanes: IntersectionConfig['arms'],
  previous: SignalPlanConfig | null,
): SignalPlanConfig {
  const previousGreens = new Map(previous?.phases.map((phase) => [phase.kind, phase.greenSeconds]));
  const leftMode: Readonly<Record<'ns' | 'ew', LeftMode>> = defaultLeftModes(armsLanes);
  const phases = signalPhaseKinds(leftMode).map((kind) => ({
    kind,
    greenSeconds:
      previousGreens.get(kind) ??
      (kind === 'ns-protected-left' || kind === 'ew-protected-left'
        ? DEFAULT_PROTECTED_LEFT_GREEN_SECONDS
        : DEFAULT_THROUGH_GREEN_SECONDS),
  }));
  const plan: SignalPlanConfig = { cycleLengthSeconds: 0, leftMode, phases };
  return plan;
}

/**
 * Auto-refit the cycle length to the plan's real duration (integer greens +
 * computed change intervals), keeping F2's cycle-coherence rule green by
 * construction (|total − round(total)| ≤ 0.5 s).
 */
function refitCycle(config: IntersectionConfig): IntersectionConfig {
  if (config.control.type !== 'signal') return config;
  const plan = config.control.plan;
  const cycle = Math.round(signalPlanDurationSeconds(config, plan));
  return {
    ...config,
    control: { type: 'signal', plan: { ...plan, cycleLengthSeconds: cycle } },
  };
}

/**
 * Rebuild the signal plan coherently after a lane-structure change:
 * leftMode re-derived (protected iff a dedicated left-only lane exists,
 * R1 §5.1), ring rebuilt, greens carried per phase kind, cycle refit.
 * No-op under all-way stop (the plan comes back on switch, see the stash).
 */
export function harmonizeSignalPlan(config: IntersectionConfig): IntersectionConfig {
  if (config.control.type !== 'signal') return config;
  const plan = harmonizedPlan(config.arms, config.control.plan);
  return refitCycle({ ...config, control: { type: 'signal', plan } });
}

// ---------------------------------------------------------------------------
// PanelModel
// ---------------------------------------------------------------------------

/**
 * Clone a config into a fully MUTABLE, DE-ALIASED draft. The presets stamp
 * one shared `ArmConfig` object onto all four arms (`symmetricArms`), and
 * `structuredClone` preserves shared references — cloning that way would
 * leave three arms aliased to one object, where an in-place edit on one arm
 * would silently leak into the others. Per-arm clones break the aliasing.
 */
export function cloneConfig(config: IntersectionConfig): IntersectionConfig {
  return {
    ...structuredClone(config),
    arms: {
      north: structuredClone(config.arms.north),
      east: structuredClone(config.arms.east),
      south: structuredClone(config.arms.south),
      west: structuredClone(config.arms.west),
    },
  };
}

export class PanelModel {
  private draftState: IntersectionConfig;
  private appliedState: IntersectionConfig;
  private issuesState: readonly ValidationIssue[] = [];
  private pausedState = false;
  private speedState: PlaybackSpeed = 1;
  private selectionState: PanelSelection = { arm: null, laneIndex: null };
  /** Signal plan remembered across switches to all-way stop. */
  private stashedPlan: SignalPlanConfig | null = null;
  private readonly listeners: PanelEventListener[] = [];

  constructor(initial: IntersectionConfig) {
    const issues = validateConfig(initial);
    if (issues.length > 0) {
      throw new Error(`initial panel config is invalid: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`);
    }
    // Presets are shared deep-frozen singletons — the draft must be mutable.
    this.draftState = cloneConfig(initial);
    this.appliedState = cloneConfig(initial);
  }

  // --- read side -----------------------------------------------------------

  /** The last VALID config (what the running simulation should be using). */
  get config(): IntersectionConfig {
    return this.appliedState;
  }

  /** The live editing state (possibly invalid; see `issues`). */
  get draft(): IntersectionConfig {
    return this.draftState;
  }

  /** Validation issues of the current draft (empty = valid). */
  get issues(): readonly ValidationIssue[] {
    return this.issuesState;
  }

  get paused(): boolean {
    return this.pausedState;
  }

  get speed(): PlaybackSpeed {
    return this.speedState;
  }

  get selection(): PanelSelection {
    return this.selectionState;
  }

  /** Which preset the APPLIED config equals, or 'custom' after any edit. */
  get presetId(): PresetId | 'custom' {
    const applied = stableStringify(this.appliedState);
    for (const preset of PRESETS) {
      if (stableStringify(preset.config) === applied) return preset.id;
    }
    return 'custom';
  }

  subscribe(listener: PanelEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  // --- config actions (each ends in commit()) -------------------------------

  setSpawnRate(arm: ArmId, vehPerHour: number): void {
    this.mutateArm(arm, (current) => ({
      ...current,
      spawnRateVehPerHour: clamp(vehPerHour, 0, MAX_SPAWN_RATE_VEH_PER_HOUR),
    }));
  }

  setTurnMixPart(arm: ArmId, direction: TurnDirection, fraction: number): void {
    this.mutateArm(arm, (current) => ({
      ...current,
      turnMix: rescaleTurnMix(current.turnMix, direction, fraction),
    }));
  }

  setLaneCount(arm: ArmId, count: number): void {
    this.mutateArmStructure(arm, (current) => {
      const lanes = lanesForCount(current.lanes, count);
      return { ...current, lanes, turnMix: coerceTurnMixToLanes(current.turnMix, lanes) };
    });
  }

  /** Replace one lane's designations (must stay non-empty; flagged if not). */
  setDesignations(arm: ArmId, laneIndex: number, designations: readonly TurnDirection[]): void {
    this.mutateArmStructure(arm, (current) => {
      const lanes = current.lanes.map((lane, index) =>
        index === laneIndex ? { designations: [...designations] } : lane,
      );
      return { ...current, lanes, turnMix: coerceTurnMixToLanes(current.turnMix, lanes) };
    });
  }

  setControlType(type: ControlConfig['type']): void {
    if (type === this.draftState.control.type) return;
    if (type === 'all-way-stop') {
      if (this.draftState.control.type === 'signal') this.stashedPlan = this.draftState.control.plan;
      this.draftState = { ...this.draftState, control: { type: 'all-way-stop' } };
    } else {
      const plan = this.stashedPlan ?? harmonizedPlan(this.draftState.arms, null);
      this.draftState = refitCycle({ ...this.draftState, control: { type: 'signal', plan } });
    }
    this.commit();
  }

  /** Set one phase's green (integer seconds, clamped to g_min); cycle auto-refits. */
  setGreenSeconds(phaseIndex: number, seconds: number): void {
    if (this.draftState.control.type !== 'signal') return;
    const plan = this.draftState.control.plan;
    const phases = plan.phases.map((phase, index) =>
      index === phaseIndex
        ? { kind: phase.kind, greenSeconds: Math.max(MIN_GREEN_SECONDS, Math.round(seconds)) }
        : { kind: phase.kind, greenSeconds: phase.greenSeconds },
    );
    this.draftState = refitCycle({
      ...this.draftState,
      control: { type: 'signal', plan: { ...plan, phases } },
    });
    this.commit();
  }

  /**
   * Replace the WHOLE signal plan in one commit — the optimizer's one-click
   * apply path (task O2). Unlike per-phase `setGreenSeconds` this installs a
   * swept candidate as a single plan-only diff: one `config-change` carrying
   * the full config, which `SimRuntime` applies LIVE (ring retarget + stats
   * reset — the O2/town-hall "apply counts as config change" semantics).
   * Draft fields other than the plan are untouched; the caller's pending
   * invalid edits, if any, still block the commit (returned as issues).
   * Returns the issues that prevented the apply; empty = applied (or already
   * current — `commit()` emits nothing for an identical config).
   */
  applySignalPlan(plan: SignalPlanConfig): readonly ValidationIssue[] {
    if (this.draftState.control.type !== 'signal') {
      return [
        {
          path: 'control.type',
          message: 'cannot apply a signal plan while the control type is all-way stop',
        },
      ];
    }
    const next = refitCycle({
      ...this.draftState,
      control: {
        type: 'signal',
        plan: {
          cycleLengthSeconds: plan.cycleLengthSeconds,
          leftMode: { ns: plan.leftMode.ns, ew: plan.leftMode.ew },
          phases: plan.phases.map((phase) => ({ kind: phase.kind, greenSeconds: phase.greenSeconds })),
        },
      },
    });
    const issues = validateConfig(next);
    if (issues.length > 0) return issues;
    this.draftState = next;
    this.commit();
    return [];
  }

  applyPreset(id: PresetId): void {
    const preset = PRESETS.find((candidate) => candidate.id === id);
    if (preset === undefined) throw new Error(`unknown preset '${String(id)}'`);
    this.draftState = cloneConfig(preset.config);
    this.commit();
  }

  // --- playback + selection actions -----------------------------------------

  setPaused(paused: boolean): void {
    this.pausedState = paused;
    this.emit({ type: 'pause', paused });
  }

  togglePaused(): void {
    this.setPaused(!this.pausedState);
  }

  setSpeed(speed: PlaybackSpeed): void {
    if (speed === this.speedState) return;
    this.speedState = speed;
    this.emit({ type: 'speed', speed });
  }

  /** Select an arm/lane (canvas click) or deselect (null). */
  select(arm: ArmId | null, laneIndex: number | null = null): void {
    this.selectionState = { arm, laneIndex };
    this.emit({ type: 'select', arm, laneIndex });
  }

  // --- internals -------------------------------------------------------------

  private mutateArm(arm: ArmId, edit: (current: IntersectionConfig['arms'][ArmId]) => IntersectionConfig['arms'][ArmId]): void {
    this.draftState = {
      ...this.draftState,
      arms: { ...this.draftState.arms, [arm]: edit(this.draftState.arms[arm]) },
    };
    this.commit();
  }

  /**
   * Structural arm edit (lanes/designations): after the edit the signal plan
   * must be re-harmonized (leftMode ↔ dedicated lanes, ring shape).
   */
  private mutateArmStructure(
    arm: ArmId,
    edit: (current: IntersectionConfig['arms'][ArmId]) => IntersectionConfig['arms'][ArmId],
  ): void {
    this.draftState = {
      ...this.draftState,
      arms: { ...this.draftState.arms, [arm]: edit(this.draftState.arms[arm]) },
    };
    this.draftState = harmonizeSignalPlan(this.draftState);
    this.commit();
  }

  /**
   * Validate the draft; if valid AND different from the applied config,
   * promote it and emit one `config-change` with the full new config.
   * Invalid drafts are kept (user state) with issues exposed — and emit a
   * `draft-change` so the panel renders them (and clears them when fixed).
   */
  private commit(): void {
    const prevIssueCount = this.issuesState.length;
    this.issuesState = validateConfig(this.draftState);
    if (this.issuesState.length > 0) {
      this.emit({ type: 'draft-change' });
      return;
    }
    if (stableStringify(this.draftState) === stableStringify(this.appliedState)) {
      // No config change, but a previously-flagged draft may just have been
      // fixed — the issues list must clear.
      if (prevIssueCount > 0) this.emit({ type: 'draft-change' });
      return;
    }
    this.appliedState = cloneConfig(this.draftState);
    this.emit({ type: 'config-change', config: this.appliedState });
  }

  private emit(event: PanelEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}
