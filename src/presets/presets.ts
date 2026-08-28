/**
 * Built-in presets (task F2): light / balanced / gridlock-risk, the three
 * demand scenarios from the approved scope, each with a distinct spawn
 * pressure and chart signature (undersaturated -> loading -> oversaturated).
 *
 * Values are research-informed placeholders pending P1 tuning (plan risk note):
 * cycle lengths commit to the R1 §9 preset set (50 / 60 / 80 s); change
 * intervals are never specified here — they are computed from geometry.
 *
 * Presets are shared module singletons and therefore deep-frozen; consumers
 * that want an editable config must clone (e.g. structuredClone / spread).
 */
import { DEFAULT_GEOMETRY, DEFAULT_MODEL_PARAMS, DEFAULT_SIM_DT_SECONDS } from '../config';
import type {
  ArmConfig,
  ArmsConfig,
  IntersectionConfig,
  SignalPlanConfig,
} from '../config';

export type PresetId = 'light' | 'balanced' | 'gridlock-risk';

export interface Preset {
  readonly id: PresetId;
  readonly name: string;
  readonly description: string;
  readonly config: IntersectionConfig;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** All presets are 4-way symmetric — one arm config stamped onto all four arms. */
function symmetricArms(arm: ArmConfig): ArmsConfig {
  return { north: arm, east: arm, south: arm, west: arm };
}

function makeConfig(arms: ArmsConfig, plan: SignalPlanConfig): IntersectionConfig {
  return {
    dt: DEFAULT_SIM_DT_SECONDS,
    geometry: { ...DEFAULT_GEOMETRY },
    modelParams: { ...DEFAULT_MODEL_PARAMS },
    arms,
    control: { type: 'signal', plan },
  };
}

const CRUISE = DEFAULT_MODEL_PARAMS.cruiseSpeedMps; // 13.9 m/s on every arm (P1-tunable)

// --- arms -------------------------------------------------------------------

/** Single shared lane per arm: permissive lefts, 2-phase ring. */
const lightArm: ArmConfig = {
  lanes: [{ designations: ['left', 'through', 'right'] }],
  spawnRateVehPerHour: 250,
  turnMix: { left: 0.2, through: 0.6, right: 0.2 },
  cruiseSpeedMps: CRUISE,
};

/** Dedicated left lane + through/right lane: protected-left 4-phase ring. */
const balancedArm: ArmConfig = {
  lanes: [{ designations: ['left'] }, { designations: ['through', 'right'] }],
  spawnRateVehPerHour: 550,
  turnMix: { left: 0.2, through: 0.55, right: 0.25 },
  cruiseSpeedMps: CRUISE,
};

/** Same geometry as balanced, double the demand: oversaturated by design. */
const gridlockArm: ArmConfig = {
  lanes: [{ designations: ['left'] }, { designations: ['through', 'right'] }],
  spawnRateVehPerHour: 1100,
  turnMix: { left: 0.15, through: 0.7, right: 0.15 },
  cruiseSpeedMps: CRUISE,
};

// --- signal plans (integer-second greens; intervals computed, not stored) ---
// Cycle arithmetic at defaults, per phase: yellow 3.3 s; all-red 0.6 s with a
// 1-lane cross street (light), 0.9 s with 2 lanes (balanced/gridlock).
// light:    2 x (3.3 + 0.6) = 7.8 lost; greens 21 + 21 = 42; total 49.8 ~= 50.
// balanced: 4 x (3.3 + 0.9) = 16.8 lost; greens 7 + 15 + 7 + 14 = 43; total 59.8 ~= 60.
// gridlock: 4 x (3.3 + 0.9) = 16.8 lost; greens 10 + 22 + 10 + 21 = 63; total 79.8 ~= 80.

const lightPlan: SignalPlanConfig = {
  cycleLengthSeconds: 50,
  leftMode: { ns: 'permissive', ew: 'permissive' },
  phases: [
    { kind: 'ns-through-right', greenSeconds: 21 },
    { kind: 'ew-through-right', greenSeconds: 21 },
  ],
};

const balancedPlan: SignalPlanConfig = {
  cycleLengthSeconds: 60,
  leftMode: { ns: 'protected', ew: 'protected' },
  phases: [
    { kind: 'ns-protected-left', greenSeconds: 7 },
    { kind: 'ns-through-right', greenSeconds: 15 },
    { kind: 'ew-protected-left', greenSeconds: 7 },
    { kind: 'ew-through-right', greenSeconds: 14 },
  ],
};

const gridlockPlan: SignalPlanConfig = {
  cycleLengthSeconds: 80,
  leftMode: { ns: 'protected', ew: 'protected' },
  phases: [
    { kind: 'ns-protected-left', greenSeconds: 10 },
    { kind: 'ns-through-right', greenSeconds: 22 },
    { kind: 'ew-protected-left', greenSeconds: 10 },
    { kind: 'ew-through-right', greenSeconds: 21 },
  ],
};

const presets: readonly Preset[] = [
  {
    id: 'light',
    name: 'Light',
    description:
      'Light demand on single shared lanes; permissive lefts, 2-phase ring, C = 50 s. Short queues, delays near free-flow.',
    config: makeConfig(symmetricArms(lightArm), lightPlan),
  },
  {
    id: 'balanced',
    name: 'Balanced',
    description:
      'Moderate demand with a dedicated left lane per arm; protected-left 4-phase ring, C = 60 s. Queues form on red and clear each cycle.',
    config: makeConfig(symmetricArms(balancedArm), balancedPlan),
  },
  {
    id: 'gridlock-risk',
    name: 'Gridlock risk',
    description:
      'Demand beyond capacity on the balanced geometry; C = 80 s. Queues grow cycle over cycle — the timing sweep has real work to do.',
    config: makeConfig(symmetricArms(gridlockArm), gridlockPlan),
  },
];

/** The three presets, deep-frozen, in display order. */
export const PRESETS: readonly Preset[] = presets.map((preset) => deepFreeze(preset));

export function isPresetId(value: unknown): value is PresetId {
  return presets.some((preset) => preset.id === value);
}

/** Look up a frozen preset by id. */
export function getPreset(id: PresetId): Preset {
  const preset = PRESETS.find((candidate) => candidate.id === id);
  if (preset === undefined) throw new Error(`unknown preset '${String(id)}'`);
  return preset;
}
