/**
 * Sane defaults (task F2): the committed research constants and a helper that
 * builds a valid starter `IntersectionConfig`.
 */
import { DEFAULT_SIM_DT_SECONDS, defaultLeftModes } from './model';
import type { ArmConfig, ArmsConfig, GeometryConfig, IntersectionConfig, ModelParams } from './model';

/**
 * Research R1 §3.1 committed constants (v_c, T, a, b, s0, delta, len, b_e,
 * s_min, a_lat) plus the §5.1 change-interval constants (t_r, a_y). P1-tunable
 * later via the engineering overlay, but the defaults are fixed by research.
 */
export const DEFAULT_MODEL_PARAMS: ModelParams = {
  cruiseSpeedMps: 13.9,
  timeHeadwaySeconds: 1.1,
  maxAccelerationMps2: 1.3,
  comfortableDecelMps2: 2.0,
  minGapMeters: 2.0,
  accelerationExponent: 4,
  carLengthMeters: 5.0,
  emergencyDecelMps2: 6.0,
  hardMinGapMeters: 0.5,
  lateralAccelMps2: 1.7,
  yellowReactionSeconds: 1.0,
  yellowDecelMps2: 3.0,
};

/**
 * 3.5 m lanes. Cross-check against R1 §5.1's own arithmetic: 3 lanes -> W =
 * 10.5 m -> all-red = (W + len)/v_c = 1.1 s, exactly the record's example.
 */
export const DEFAULT_GEOMETRY: GeometryConfig = {
  laneWidthMeters: 3.5,
};

/**
 * Build a fresh, valid, fully mutable starter config: one shared lane per arm
 * (permissive lefts -> 2-phase ring), gentle demand, C = 60 s with equal
 * splits. The result round-trips `validateConfig` with zero issues.
 */
export function createDefaultConfig(): IntersectionConfig {
  const arm: ArmConfig = {
    lanes: [{ designations: ['left', 'through', 'right'] }],
    spawnRateVehPerHour: 300,
    turnMix: { left: 0.25, through: 0.5, right: 0.25 },
    cruiseSpeedMps: DEFAULT_MODEL_PARAMS.cruiseSpeedMps,
  };
  const arms: ArmsConfig = { north: arm, east: arm, south: arm, west: arm };
  return {
    dt: DEFAULT_SIM_DT_SECONDS,
    geometry: { ...DEFAULT_GEOMETRY },
    modelParams: { ...DEFAULT_MODEL_PARAMS },
    arms,
    control: {
      type: 'signal',
      plan: {
        cycleLengthSeconds: 60,
        leftMode: defaultLeftModes(arms), // permissive/permissive: shared lanes only
        // Greens 26 + 26 = 52 s; change intervals 2 x (3.3 + 0.6) = 7.8 s; total 59.8 s.
        phases: [
          { kind: 'ns-through-right', greenSeconds: 26 },
          { kind: 'ew-through-right', greenSeconds: 26 },
        ],
      },
    },
  };
}
