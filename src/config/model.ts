/**
 * Intersection configuration model (task F2).
 *
 * These types are the single source of truth for everything a user can design
 * about the intersection: fixed 4-arm topology, per-arm lanes (1-3) with
 * per-lane turn designations, per-arm spawn rate + turn mix, and the
 * intersection-level control (fixed-time signal plan OR all-way stop).
 *
 * Research commitments encoded here (docs/ultron/research/track-a-traffic-micro-model.md):
 * - §3.1 global dt = 0.1 s and the Guarded-IDM parameter block;
 * - §5.1 NEMA-lite sequential ring with 2-4 phases, integer-second greens,
 *   yellow/all-red computed from geometry (never configured, never swept);
 * - §9 config additions: leftMode per axis, cycleLength, per-arm cruise speed.
 */

/** Turn directions a lane may serve (combinations allowed, duplicates not). */
export type TurnDirection = 'left' | 'through' | 'right';

export const TURN_DIRECTIONS = ['left', 'through', 'right'] as const;

/**
 * Fixed arm identities, listed in the canonical order used for FIFO ticket
 * tiebreaks (research R1 §4.2: arm order N, E, S, W, then lane index).
 */
export type ArmId = 'north' | 'east' | 'south' | 'west';

export const ARM_IDS = ['north', 'east', 'south', 'west'] as const;

/** Signal axes: NS (north + south) and EW (east + west). */
export type AxisId = 'ns' | 'ew';

export const AXIS_IDS = ['ns', 'ew'] as const;

/** Committed fixed simulation timestep (research R1 §3.1; matches F1's SIM_DT). */
export const DEFAULT_SIM_DT_SECONDS = 0.1;

export function axisOfArm(armId: ArmId): AxisId {
  return armId === 'north' || armId === 'south' ? 'ns' : 'ew';
}

export function crossAxis(axis: AxisId): AxisId {
  return axis === 'ns' ? 'ew' : 'ns';
}

/**
 * A single lane and the turns it serves. `lanes[i]` with index 0 is the
 * leftmost lane from the approaching driver's perspective (F3 geometry input).
 */
export interface LaneConfig {
  readonly designations: readonly TurnDirection[];
}

/** Per-arm spawn turn split. Probabilities are >= 0 and sum to 1 (within tolerance). */
export interface TurnMix {
  readonly left: number;
  readonly through: number;
  readonly right: number;
}

export interface ArmConfig {
  /** 1-3 lanes, leftmost first. */
  readonly lanes: readonly LaneConfig[];
  /** Mean demand rate in vehicles/hour (Poisson-style spawning, task F6). */
  readonly spawnRateVehPerHour: number;
  /** Which spawned cars take which turn; must be coherent with `lanes`. */
  readonly turnMix: TurnMix;
  /**
   * Operational cruise speed on this arm's approach (R1 §9). The nominal
   * design speed shared by all arms lives in `ModelParams.cruiseSpeedMps`.
   */
  readonly cruiseSpeedMps: number;
}

export type ArmsConfig = Readonly<Record<ArmId, ArmConfig>>;

export function armsOfAxis(arms: ArmsConfig, axis: AxisId): readonly ArmConfig[] {
  return axis === 'ns' ? [arms.north, arms.south] : [arms.east, arms.west];
}

/** How left turns are served on an axis (research R1 §5.1). */
export type LeftMode = 'protected' | 'permissive';

/**
 * Ring slots of the NEMA-lite sequential ring (research R1 §5.1):
 * [NS protected left?] -> NS through/right -> [EW protected left?] -> EW through/right.
 */
export type SignalPhaseKind =
  | 'ns-protected-left'
  | 'ns-through-right'
  | 'ew-protected-left'
  | 'ew-through-right';

export interface SignalPhaseConfig {
  readonly kind: SignalPhaseKind;
  /** Green duration in whole seconds (R1 §5.2: integer-second splits; the optimizer sweeps these). */
  readonly greenSeconds: number;
}

export interface SignalPlanConfig {
  /** Nominal cycle length in whole seconds (presets commit 50 / 60 / 80 s, R1 §9). */
  readonly cycleLengthSeconds: number;
  /** Left service per axis; 'protected' requires a dedicated left-only lane on that axis. */
  readonly leftMode: Readonly<Record<AxisId, LeftMode>>;
  /** The ring, in canonical order, containing exactly the phases implied by `leftMode`. */
  readonly phases: readonly SignalPhaseConfig[];
}

export interface SignalControlConfig {
  readonly type: 'signal';
  readonly plan: SignalPlanConfig;
}

/**
 * All-way stop (scope): full stop, first-come-first-served departure, right
 * tiebreak for simultaneous stops, left yields oncoming through traffic.
 * The semantics are enforced by F5; the config carries no extra data.
 */
export interface AllWayStopControlConfig {
  readonly type: 'all-way-stop';
}

export type ControlConfig = SignalControlConfig | AllWayStopControlConfig;

/**
 * Guarded-IDM + turn-speed + change-interval constants (research R1 §3.1 and
 * §5.1). Defaults live in `defaults.ts`; field docs repeat the committed values.
 */
export interface ModelParams {
  /** v_c: nominal design cruise speed in m/s (13.9 = 50 km/h). */
  readonly cruiseSpeedMps: number;
  /** T: IDM desired time headway in s (1.1). */
  readonly timeHeadwaySeconds: number;
  /** a: IDM maximum acceleration in m/s^2 (1.3). */
  readonly maxAccelerationMps2: number;
  /** b: IDM comfortable deceleration in m/s^2 (2.0). */
  readonly comfortableDecelMps2: number;
  /** s0: IDM minimum standing gap in m (2.0; queue spacing at rest). */
  readonly minGapMeters: number;
  /** delta: IDM acceleration exponent (4). */
  readonly accelerationExponent: number;
  /** len: car length in m (5.0; footprint for conflict padding and renders). */
  readonly carLengthMeters: number;
  /** b_e: emergency deceleration, hard bound on |decel| every tick (6.0 m/s^2). */
  readonly emergencyDecelMps2: number;
  /** s_min: hard floor on net bumper gap, the clamp/assert threshold (0.5 m). */
  readonly hardMinGapMeters: number;
  /** a_lat: comfortable lateral acceleration for turn speed (1.7 m/s^2). */
  readonly lateralAccelMps2: number;
  /** t_r: driver perception-reaction time in the yellow formula (1.0 s, R1 §5.1). */
  readonly yellowReactionSeconds: number;
  /** a_y: deceleration rate in the yellow formula (3.0 m/s^2, R1 §5.1). */
  readonly yellowDecelMps2: number;
}

/**
 * Geometry inputs the config owns. F3 extends this with derived geometry
 * (arm lengths, path polygons, conflict zones); the width constants here feed
 * the R1 §5.1 change-interval formulas at config time.
 */
export interface GeometryConfig {
  /** Lane width in meters (3.5 default; sets cross-street width W for all-red). */
  readonly laneWidthMeters: number;
}

export interface IntersectionConfig {
  /** Fixed simulation timestep in seconds (R1 §3.1 commits 0.1). */
  readonly dt: number;
  readonly geometry: GeometryConfig;
  readonly modelParams: ModelParams;
  readonly arms: ArmsConfig;
  readonly control: ControlConfig;
}

// ---------------------------------------------------------------------------
// Derived helpers (pure functions of a config; validation lives in validate.ts)
// ---------------------------------------------------------------------------

/** A dedicated (left-only) lane; shared lanes do not qualify (R1 §5.1). */
export function isDedicatedLeftLane(lane: LaneConfig): boolean {
  const designations = lane.designations;
  return Array.isArray(designations) && designations.length === 1 && designations[0] === 'left';
}

export function hasDedicatedLeftLane(arm: ArmConfig): boolean {
  return Array.isArray(arm.lanes) && arm.lanes.some(isDedicatedLeftLane);
}

/**
 * R1 §5.1 left-service default: protected iff any arm on the axis has a
 * dedicated left-only lane (permissive otherwise — a shared lane cannot be
 * given a protected phase).
 */
export function defaultLeftModes(arms: ArmsConfig): Readonly<Record<AxisId, LeftMode>> {
  return {
    ns: armsOfAxis(arms, 'ns').some(hasDedicatedLeftLane) ? 'protected' : 'permissive',
    ew: armsOfAxis(arms, 'ew').some(hasDedicatedLeftLane) ? 'protected' : 'permissive',
  };
}

export function phaseAxis(kind: SignalPhaseKind): AxisId {
  return kind === 'ns-protected-left' || kind === 'ns-through-right' ? 'ns' : 'ew';
}

/** The canonical ring for a leftMode setting: 2 phases (no protected lefts) up to 4. */
export function signalPhaseKinds(leftMode: Readonly<Record<AxisId, LeftMode>>): readonly SignalPhaseKind[] {
  const kinds: SignalPhaseKind[] = [];
  if (leftMode.ns === 'protected') kinds.push('ns-protected-left');
  kinds.push('ns-through-right');
  if (leftMode.ew === 'protected') kinds.push('ew-protected-left');
  kinds.push('ew-through-right');
  return kinds;
}

/**
 * Change intervals for a phase, computed from geometry per R1 §5.1 and rounded
 * to the 0.1 s simulation tick grid:
 * - yellow = t_r + v/(2·a_y), using the FASTEST approach speed on the axis
 *   (longest stopping distance needs the longest yellow);
 * - all-red = (W + len)/v, using the SLOWEST approach speed on the axis
 *   (slowest car needs the longest clearance) and W = cross-street width =
 *   laneWidth × lane count of the widest cross-axis arm.
 * Example at defaults: yellow = 1.0 + 13.9/6 = 3.3 s; all-red at a 3-lane
 * cross street = (10.5 + 5)/13.9 = 1.1 s (matches the R1 §5.1 arithmetic).
 * Never user-settable, never swept by the optimizer.
 */
export interface PhaseChangeIntervals {
  readonly yellowSeconds: number;
  readonly allRedSeconds: number;
}

function roundToTickSeconds(seconds: number): number {
  return Math.round(seconds * 10) / 10;
}

export function phaseChangeIntervals(
  config: IntersectionConfig,
  kind: SignalPhaseKind,
): PhaseChangeIntervals {
  const own = armsOfAxis(config.arms, phaseAxis(kind));
  const cross = armsOfAxis(config.arms, crossAxis(phaseAxis(kind)));
  const fastestCruise = Math.max(...own.map((arm) => arm.cruiseSpeedMps));
  const slowestCruise = Math.min(...own.map((arm) => arm.cruiseSpeedMps));
  const crossStreetWidthMeters =
    config.geometry.laneWidthMeters * Math.max(...cross.map((arm) => arm.lanes.length));
  const params = config.modelParams;
  return {
    yellowSeconds: roundToTickSeconds(
      params.yellowReactionSeconds + fastestCruise / (2 * params.yellowDecelMps2),
    ),
    allRedSeconds: roundToTickSeconds(
      (crossStreetWidthMeters + params.carLengthMeters) / slowestCruise,
    ),
  };
}

/** Total ring duration: sum of (green + yellow + all-red) across all phases. */
export function signalPlanDurationSeconds(
  config: IntersectionConfig,
  plan: SignalPlanConfig,
): number {
  let total = 0;
  for (const phase of plan.phases) {
    const intervals = phaseChangeIntervals(config, phase.kind);
    total += phase.greenSeconds + intervals.yellowSeconds + intervals.allRedSeconds;
  }
  return total;
}

/** Aggregate demand across all four arms (veh/h) — the "spawn pressure" of a config. */
export function totalSpawnRateVehPerHour(config: IntersectionConfig): number {
  let total = 0;
  for (const armId of ARM_IDS) total += config.arms[armId].spawnRateVehPerHour;
  return total;
}
