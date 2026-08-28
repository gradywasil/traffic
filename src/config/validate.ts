/**
 * Config validation (task F2).
 *
 * `validateConfig` collects ALL problems (no fail-fast) so a user editing the
 * intersection sees every rejection reason at once. Each issue carries a config
 * path (e.g. `arms.north.lanes[1].designations`) and a plain-language message.
 * Validation is pure: it never throws on malformed input and never mutates.
 *
 * Semantic rules enforced (research R1):
 * - §5.1: lanes per arm 1-3; designations non-empty, unique, known; leftMode
 *   'protected' only with a dedicated left-only lane on that axis; phases must
 *   form the canonical NEMA-lite ring for the given leftMode.
 * - §5.2: integer-second greens >= g_min (5 s); greens + computed change
 *   intervals match the cycle length within a 0.5 s slack (integer greens
 *   cannot hit real-valued lost time exactly — R1 itself rounds 51.2 -> 51).
 * - Turn mix: probabilities in [0, 1], summing to 1, and coherent with the
 *   arm's lane designations (positive probability requires a lane serving it).
 */
import {
  ARM_IDS,
  AXIS_IDS,
  TURN_DIRECTIONS,
  armsOfAxis,
  hasDedicatedLeftLane,
  signalPhaseKinds,
  signalPlanDurationSeconds,
} from './model';
import type {
  AxisId,
  IntersectionConfig,
  LeftMode,
  SignalPlanConfig,
} from './model';

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

export function formatValidationIssue(issue: ValidationIssue): string {
  return `${issue.path}: ${issue.message}`;
}

// --- sanity bounds (committed values from research R1; P1 may retune) ---

export const MIN_LANES_PER_ARM = 1;
export const MAX_LANES_PER_ARM = 3;
/** g_min, research R1 §5.2 (optimizer candidate constraint; also the editing floor). */
export const MIN_GREEN_SECONDS = 5;
export const MIN_CYCLE_SECONDS = 20;
export const MAX_CYCLE_SECONDS = 180;
export const MAX_SPAWN_RATE_VEH_PER_HOUR = 3600;
export const MAX_CRUISE_SPEED_MPS = 40;
export const MAX_LANE_WIDTH_METERS = 10;
/** R1 evidence E1: timesteps below 0.5 s are essentially equivalent; 0.1 is committed. */
export const MAX_SIM_DT_SECONDS = 0.5;
export const TURN_MIX_SUM_TOLERANCE = 1e-6;
/**
 * Integer greens cannot exactly fill C - lost when lost time is real-valued
 * (R1 §5.2's own example: usable 51.2 s -> 51 s greens). Allow a half-second.
 */
export const MAX_CYCLE_DEVIATION_SECONDS = 0.5;

const TURN_DIRECTION_SET = new Set<string>(TURN_DIRECTIONS);
const PHASE_KIND_SET = new Set<string>(signalPhaseKinds({ ns: 'protected', ew: 'protected' }));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

interface NumberBounds {
  readonly min?: number;
  readonly max?: number;
  readonly exclusiveMin?: number;
  readonly integer?: boolean;
}

/** Validate one numeric field; push one issue per violated bound. Returns whether it is usable. */
function validateNumber(
  value: unknown,
  path: string,
  bounds: NumberBounds,
  issues: ValidationIssue[],
): boolean {
  if (!isFiniteNumber(value)) {
    issues.push({ path, message: `must be a finite number, got ${String(value)}` });
    return false;
  }
  let usable = true;
  if (bounds.integer === true && !Number.isInteger(value)) {
    issues.push({ path, message: `must be a whole number, got ${String(value)}` });
    usable = false;
  }
  if (bounds.exclusiveMin !== undefined && !(value > bounds.exclusiveMin)) {
    issues.push({ path, message: `must be > ${bounds.exclusiveMin}, got ${String(value)}` });
    usable = false;
  }
  if (bounds.min !== undefined && value < bounds.min) {
    issues.push({ path, message: `must be >= ${bounds.min}, got ${String(value)}` });
    usable = false;
  }
  if (bounds.max !== undefined && value > bounds.max) {
    issues.push({ path, message: `must be <= ${bounds.max}, got ${String(value)}` });
    usable = false;
  }
  return usable;
}

function typeName(value: unknown): string {
  if (Array.isArray(value)) return 'an array';
  if (value === null) return 'null';
  return `a ${typeof value}`;
}

/**
 * Validate a config. Empty result = valid. Structural defects (missing arms,
 * non-array lanes/phases, unknown enum values) produce issues, never throws —
 * configs may arrive half-edited from live UI state.
 */
export function validateConfig(config: IntersectionConfig): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isRecord(config)) {
    issues.push({ path: 'config', message: 'must be a config object' });
    return issues;
  }
  validateNumber(config.dt, 'dt', { exclusiveMin: 0, max: MAX_SIM_DT_SECONDS }, issues);
  validateGeometry(config.geometry, issues);
  validateModelParams(config.modelParams, issues);
  validateArms(config.arms, issues);
  // Change-interval math reads arm geometry; only run it when the arms are structurally usable.
  validateControl(config, issues, armsAreStructurallyUsable(config.arms));
  return issues;
}

function validateGeometry(geometry: unknown, issues: ValidationIssue[]): void {
  if (!isRecord(geometry)) {
    issues.push({ path: 'geometry', message: 'must be a geometry config object' });
    return;
  }
  validateNumber(
    geometry.laneWidthMeters,
    'geometry.laneWidthMeters',
    { exclusiveMin: 0, max: MAX_LANE_WIDTH_METERS },
    issues,
  );
}

function validateModelParams(params: unknown, issues: ValidationIssue[]): void {
  if (!isRecord(params)) {
    issues.push({ path: 'modelParams', message: 'must be a model parameter block (R1 §3.1)' });
    return;
  }
  validateNumber(params.cruiseSpeedMps, 'modelParams.cruiseSpeedMps', { exclusiveMin: 0 }, issues);
  validateNumber(params.timeHeadwaySeconds, 'modelParams.timeHeadwaySeconds', { exclusiveMin: 0 }, issues);
  validateNumber(params.maxAccelerationMps2, 'modelParams.maxAccelerationMps2', { exclusiveMin: 0 }, issues);
  validateNumber(params.comfortableDecelMps2, 'modelParams.comfortableDecelMps2', { exclusiveMin: 0 }, issues);
  validateNumber(params.minGapMeters, 'modelParams.minGapMeters', { exclusiveMin: 0 }, issues);
  validateNumber(params.accelerationExponent, 'modelParams.accelerationExponent', { min: 1 }, issues);
  validateNumber(params.carLengthMeters, 'modelParams.carLengthMeters', { exclusiveMin: 0 }, issues);
  validateNumber(params.emergencyDecelMps2, 'modelParams.emergencyDecelMps2', { exclusiveMin: 0 }, issues);
  validateNumber(params.hardMinGapMeters, 'modelParams.hardMinGapMeters', { min: 0 }, issues);
  validateNumber(params.lateralAccelMps2, 'modelParams.lateralAccelMps2', { exclusiveMin: 0 }, issues);
  validateNumber(params.yellowReactionSeconds, 'modelParams.yellowReactionSeconds', { min: 0 }, issues);
  validateNumber(params.yellowDecelMps2, 'modelParams.yellowDecelMps2', { exclusiveMin: 0 }, issues);

  const emergency = params.emergencyDecelMps2;
  const comfortable = params.comfortableDecelMps2;
  if (isFiniteNumber(emergency) && isFiniteNumber(comfortable) && emergency < comfortable) {
    issues.push({
      path: 'modelParams.emergencyDecelMps2',
      message: `must be >= comfortableDecelMps2 (${comfortable}); the emergency bound is the hard decel limit (R1 §3.1)`,
    });
  }
  const minGap = params.minGapMeters;
  const hardMinGap = params.hardMinGapMeters;
  if (isFiniteNumber(minGap) && isFiniteNumber(hardMinGap) && minGap < hardMinGap) {
    issues.push({
      path: 'modelParams.minGapMeters',
      message: `must be >= hardMinGapMeters (${hardMinGap}); the IDM queue gap cannot sit below the hard floor`,
    });
  }
}

/** Whether all four arms exist as objects with array lanes (enough for derived-geometry math). */
function armsAreStructurallyUsable(arms: unknown): boolean {
  if (!isRecord(arms)) return false;
  return ARM_IDS.every((armId) => {
    const arm = arms[armId];
    return isRecord(arm) && Array.isArray(arm.lanes);
  });
}

function validateArms(arms: unknown, issues: ValidationIssue[]): void {
  if (!isRecord(arms)) {
    issues.push({ path: 'arms', message: 'must be an arm config keyed by north/east/south/west' });
    return;
  }
  for (const armId of ARM_IDS) {
    validateArm(arms[armId], armId, issues);
  }
}

function validateArm(arm: unknown, armId: (typeof ARM_IDS)[number], issues: ValidationIssue[]): void {
  const basePath = `arms.${armId}`;
  if (!isRecord(arm)) {
    issues.push({ path: basePath, message: 'arm config is missing' });
    return;
  }
  const availableTurns = validateLanes(arm.lanes, basePath, issues);
  validateNumber(
    arm.spawnRateVehPerHour,
    `${basePath}.spawnRateVehPerHour`,
    { min: 0, max: MAX_SPAWN_RATE_VEH_PER_HOUR },
    issues,
  );
  validateNumber(
    arm.cruiseSpeedMps,
    `${basePath}.cruiseSpeedMps`,
    { exclusiveMin: 0, max: MAX_CRUISE_SPEED_MPS },
    issues,
  );
  validateTurnMix(arm.turnMix, basePath, armId, availableTurns, issues);
}

/** Validate the lane list; return the set of turn directions the arm's lanes actually serve. */
function validateLanes(lanes: unknown, basePath: string, issues: ValidationIssue[]): ReadonlySet<string> {
  const availableTurns = new Set<string>();
  if (!Array.isArray(lanes)) {
    issues.push({ path: `${basePath}.lanes`, message: `must be an array of lanes, got ${typeName(lanes)}` });
    return availableTurns;
  }
  if (lanes.length < MIN_LANES_PER_ARM || lanes.length > MAX_LANES_PER_ARM) {
    issues.push({
      path: `${basePath}.lanes`,
      message: `must contain between ${MIN_LANES_PER_ARM} and ${MAX_LANES_PER_ARM} lanes, got ${lanes.length}`,
    });
  }
  lanes.forEach((lane, index) => {
    const lanePath = `${basePath}.lanes[${index}]`;
    if (!isRecord(lane)) {
      issues.push({ path: lanePath, message: 'lane config must be an object with a designations array' });
      return;
    }
    const designations = lane.designations;
    const designationsPath = `${lanePath}.designations`;
    if (!Array.isArray(designations) || designations.length === 0) {
      issues.push({
        path: designationsPath,
        message: 'must list at least one turn designation (left/through/right)',
      });
      return;
    }
    const seen = new Set<string>();
    for (const designation of designations) {
      if (typeof designation !== 'string' || !TURN_DIRECTION_SET.has(designation)) {
        issues.push({
          path: designationsPath,
          message: `unknown turn designation '${String(designation)}'; expected left, through or right`,
        });
        continue;
      }
      if (seen.has(designation)) {
        issues.push({ path: designationsPath, message: `duplicate turn designation '${designation}'` });
        continue;
      }
      seen.add(designation);
      availableTurns.add(designation);
    }
  });
  return availableTurns;
}

function validateTurnMix(
  turnMix: unknown,
  basePath: string,
  armId: (typeof ARM_IDS)[number],
  availableTurns: ReadonlySet<string>,
  issues: ValidationIssue[],
): void {
  const mixPath = `${basePath}.turnMix`;
  if (!isRecord(turnMix)) {
    issues.push({ path: mixPath, message: 'must be an object with left/through/right probabilities' });
    return;
  }
  const parts = [
    ['left', turnMix.left],
    ['through', turnMix.through],
    ['right', turnMix.right],
  ] as const;
  let sum = 0;
  let allValid = true;
  for (const [direction, probability] of parts) {
    const ok = validateNumber(probability, `${mixPath}.${direction}`, { min: 0, max: 1 }, issues);
    if (!ok || typeof probability !== 'number') {
      allValid = false;
      continue;
    }
    sum += probability;
    if (probability > 0 && !availableTurns.has(direction)) {
      issues.push({
        path: `${mixPath}.${direction}`,
        message: `probability ${probability} has no lane serving '${direction}' on arm '${armId}'`,
      });
    }
  }
  if (allValid && Math.abs(sum - 1) > TURN_MIX_SUM_TOLERANCE) {
    issues.push({ path: mixPath, message: `probabilities must sum to 1, got ${sum}` });
  }
}

function validateControl(config: IntersectionConfig, issues: ValidationIssue[], armsUsable: boolean): void {
  const control = config.control;
  if (!isRecord(control)) {
    issues.push({
      path: 'control',
      message: "must be a control config with type 'signal' or 'all-way-stop'",
    });
    return;
  }
  if (control.type === 'all-way-stop') return; // FIFO/left-yield semantics are F5's; no plan to validate
  if (control.type !== 'signal') {
    issues.push({
      path: 'control.type',
      message: `must be 'signal' or 'all-way-stop', got '${String(control.type)}'`,
    });
    return;
  }
  validateSignalPlan(config, control.plan, issues, armsUsable);
}

function validateSignalPlan(
  config: IntersectionConfig,
  plan: unknown,
  issues: ValidationIssue[],
  armsUsable: boolean,
): void {
  const planPath = 'control.plan';
  if (!isRecord(plan)) {
    issues.push({ path: planPath, message: 'signal control requires a signal plan' });
    return;
  }
  const cycleOk = validateNumber(
    plan.cycleLengthSeconds,
    `${planPath}.cycleLengthSeconds`,
    { integer: true, min: MIN_CYCLE_SECONDS, max: MAX_CYCLE_SECONDS },
    issues,
  );

  // leftMode per axis (R1 §5.1): 'protected' needs a dedicated left-only lane on the axis.
  const leftMode = plan.leftMode;
  const leftModePath = `${planPath}.leftMode`;
  let leftModeOk = true;
  if (!isRecord(leftMode)) {
    issues.push({
      path: leftModePath,
      message: "must give 'protected' or 'permissive' for each axis (ns, ew)",
    });
    leftModeOk = false;
  } else {
    for (const axis of AXIS_IDS) {
      const mode = leftMode[axis];
      if (mode !== 'protected' && mode !== 'permissive') {
        issues.push({
          path: `${leftModePath}.${axis}`,
          message: `must be 'protected' or 'permissive', got '${String(mode)}'`,
        });
        leftModeOk = false;
        continue;
      }
      if (mode === 'protected' && armsUsable) {
        const axisArms = armsOfAxis(config.arms, axis);
        const usableArms = axisArms.filter((arm) => arm !== undefined && typeof arm === 'object');
        if (usableArms.length === axisArms.length && !usableArms.some((arm) => hasDedicatedLeftLane(arm))) {
          issues.push({
            path: `${leftModePath}.${axis}`,
            message: `'protected' requires a dedicated left-only lane on the ${
              axis === 'ns' ? 'north or south' : 'east or west'
            } arm (R1 §5.1)`,
          });
        }
      }
    }
  }

  // Phases: kinds, greens, ring order (R1 §5.1/§5.2).
  const phases = plan.phases;
  const phasesPath = `${planPath}.phases`;
  if (!Array.isArray(phases)) {
    issues.push({ path: phasesPath, message: 'must be an array of phases in ring order' });
    return;
  }
  const kinds: string[] = [];
  let greensOk = true;
  phases.forEach((phase, index) => {
    const phasePath = `${phasesPath}[${index}]`;
    if (!isRecord(phase)) {
      issues.push({ path: phasePath, message: 'phase must be an object with kind and greenSeconds' });
      greensOk = false;
      return;
    }
    if (typeof phase.kind !== 'string' || !PHASE_KIND_SET.has(phase.kind)) {
      issues.push({
        path: `${phasePath}.kind`,
        message: `unknown phase kind '${String(phase.kind)}'; expected one of ${[...PHASE_KIND_SET].join(', ')}`,
      });
      greensOk = false;
    } else {
      kinds.push(phase.kind);
    }
    const greenOk = validateNumber(
      phase.greenSeconds,
      `${phasePath}.greenSeconds`,
      { integer: true, min: MIN_GREEN_SECONDS },
      issues,
    );
    if (!greenOk) greensOk = false;
  });
  if (phases.length === 0) {
    issues.push({ path: phasesPath, message: 'must contain at least one green phase' });
  }

  if (leftModeOk) {
    const expected = signalPhaseKinds(leftMode as unknown as Readonly<Record<AxisId, LeftMode>>);
    const matchesRing =
      kinds.length === expected.length && expected.every((kind, index) => kinds[index] === kind);
    if (!matchesRing) {
      issues.push({
        path: phasesPath,
        message: `phases must form the NEMA-lite ring [${expected.join(' -> ')}] for this leftMode, got [${kinds.join(' -> ')}] (R1 §5.1)`,
      });
    }
  }

  // Cycle coherence: greens + computed change intervals ~= cycle length.
  if (cycleOk && greensOk && leftModeOk && armsUsable) {
    const total = signalPlanDurationSeconds(config, plan as unknown as SignalPlanConfig);
    const cycle = plan.cycleLengthSeconds as number;
    const deviation = Math.abs(total - cycle);
    if (deviation > MAX_CYCLE_DEVIATION_SECONDS) {
      issues.push({
        path: planPath,
        message: `greens + change intervals total ${total.toFixed(1)} s but cycleLengthSeconds is ${cycle} (deviation ${deviation.toFixed(1)} s, max allowed ${MAX_CYCLE_DEVIATION_SECONDS} s)`,
      });
    }
  }
}
