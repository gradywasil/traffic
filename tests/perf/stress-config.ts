/**
 * Q2 stress configuration: a VALIDATED signal config engineered to guarantee
 * ≥ 150 concurrent cars — the load floor the acceptance bar names
 * ("60fps rendering with 150+ concurrent cars"; town-hall §"Success measures").
 *
 * Why the presets alone are not enough: the gridlock-risk preset saturates at
 * ~90–115 alive cars (its 2-lane approaches fill and the spawner holds the
 * surplus in per-lane virtual entry queues OUTSIDE the world — spillback, by
 * design). Reaching 150+ CONCURRENT cars therefore needs more queue storage,
 * not just more demand: this config uses the scope's maximum 3 lanes per arm
 * (12 approach lanes × ~113 m of approach each ≈ 190 jam-spacing slots) with
 * demand far beyond capacity so every approach stays full for the whole
 * measurement window.
 *
 * Everything else is production machinery unchanged: default geometry,
 * protected-left 4-phase ring (a dedicated left lane exists on every arm, so
 * protected is the F2 default leftMode), integer-second greens, cycle
 * deviation ≤ 0.5 s. `validateConfig` passes with zero issues (asserted in
 * stress-config.test.ts), so the config runs through the real SimRuntime,
 * renderer and optimizer without any harness-only code paths.
 *
 * ONE model parameter deviates from the R1 §3.1 defaults, disclosed here:
 * `minGapMeters` 2.0 → 1.2 (queue jam spacing 7.0 → 6.2 m). Model params are
 * P1-tunable by scope; this one was tuned because at default spacing the
 * 120 m approaches saturate at a steady state of 145–162 alive cars — the
 * floor DIPS below 150. At 1.2 the steady state is 157–179 (measured;
 * stress-config.test.ts pins the guarantee), comfortably above the bar. The
 * deviation makes the benchmark HARDER, not easier: every per-car cost (sim
 * tick, draw-list build, rasterization) scales with car count, and the
 * measured load is ~169 concurrent vs the bar's 150.
 *
 * Deterministic: fixed values, no randomness — same config every call (deep
 * fresh each time; callers may mutate their copy).
 */
import { DEFAULT_GEOMETRY, DEFAULT_MODEL_PARAMS, DEFAULT_SIM_DT_SECONDS, validateConfig } from '../../src/config';
import type { ArmConfig, ArmsConfig, IntersectionConfig, SignalPlanConfig } from '../../src/config';

/** The acceptance bar's concurrent-car floor (town-hall §"Success measures"). */
export const STRESS_TARGET_CONCURRENT_CARS = 150;

/** Config identity for evidence records (NOT a UI preset; harness-only). */
export const STRESS_CONFIG_ID = 'q2-stress';

/** Demand per arm (veh/h). 4 × 2200 = 8800 veh/h offered — far beyond the
 * ring's capacity on every movement, so approaches stay saturated. */
export const STRESS_SPAWN_RATE_VEH_PER_HOUR = 2200;

/** Disclosed deviation from the R1 §3.1 defaults (see module doc). */
export const STRESS_MIN_GAP_METERS = 1.2;

/**
 * How many ticks of warmup reliably reach the load floor (measured; the
 * stress-config test asserts the guarantee, this constant only sizes
 * harness warmups): approaches fill to jam density within ~120 s.
 */
export const STRESS_WARMUP_TICKS = 1500;

const STRESS_ARM: ArmConfig = {
  // Left-exclusive / through-exclusive / through+right: the scope's full
  // lane model on one arm. Through demand round-robins across the two
  // through-serving lanes (F6 lane assignment), so both fill.
  lanes: [{ designations: ['left'] }, { designations: ['through'] }, { designations: ['through', 'right'] }],
  spawnRateVehPerHour: STRESS_SPAWN_RATE_VEH_PER_HOUR,
  turnMix: { left: 0.15, through: 0.7, right: 0.15 },
  cruiseSpeedMps: DEFAULT_MODEL_PARAMS.cruiseSpeedMps,
};

// 4-phase ring at C = 80 s. Change intervals are computed from geometry, not
// stored: y = 1 + 13.9/(2·3.0) = 3.32 s; all-red = (W + len)/13.9 with the
// 3-lane cross street W = 10.5 m ⇒ 1.12 s. Lost = 4 × 4.44 = 17.73 s;
// greens 10+22+10+20 = 62 ⇒ total 79.73 s, deviation 0.27 s ≤ 0.5 (validated).
const STRESS_PLAN: SignalPlanConfig = {
  cycleLengthSeconds: 80,
  leftMode: { ns: 'protected', ew: 'protected' },
  phases: [
    { kind: 'ns-protected-left', greenSeconds: 10 },
    { kind: 'ns-through-right', greenSeconds: 22 },
    { kind: 'ew-protected-left', greenSeconds: 10 },
    { kind: 'ew-through-right', greenSeconds: 20 },
  ],
};

/** A fresh, mutable, validated stress config (3 lanes/arm, oversaturated). */
export function createStressConfig(): IntersectionConfig {
  const arms: ArmsConfig = {
    north: structuredClone(STRESS_ARM),
    east: structuredClone(STRESS_ARM),
    south: structuredClone(STRESS_ARM),
    west: structuredClone(STRESS_ARM),
  };
  return {
    dt: DEFAULT_SIM_DT_SECONDS,
    geometry: { ...DEFAULT_GEOMETRY },
    // minGap 1.2 (disclosed deviation, module doc): denser jam packing so the
    // ≥150 concurrent floor HOLDS instead of oscillating through it.
    modelParams: { ...DEFAULT_MODEL_PARAMS, minGapMeters: STRESS_MIN_GAP_METERS },
    arms,
    control: { type: 'signal', plan: structuredClone(STRESS_PLAN) },
  };
}

/** Validate-and-throw accessor for harnesses that want the guard up front. */
export function createValidatedStressConfig(): IntersectionConfig {
  const config = createStressConfig();
  const issues = validateConfig(config);
  if (issues.length > 0) {
    throw new Error(`stress config is invalid: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`);
  }
  return config;
}
