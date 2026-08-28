import { describe, expect, it } from 'vitest';
import { createDefaultConfig } from './defaults';
import {
  ARM_IDS,
  DEFAULT_SIM_DT_SECONDS,
  armsOfAxis,
  axisOfArm,
  defaultLeftModes,
  hasDedicatedLeftLane,
  phaseChangeIntervals,
  signalPhaseKinds,
  signalPlanDurationSeconds,
  totalSpawnRateVehPerHour,
} from './model';
import type { ArmConfig, ArmsConfig, IntersectionConfig, LaneConfig } from './model';

function armWithLanes(lanes: readonly LaneConfig[], cruiseSpeedMps = 13.9): ArmConfig {
  return {
    lanes,
    spawnRateVehPerHour: 300,
    turnMix: { left: 0.25, through: 0.5, right: 0.25 },
    cruiseSpeedMps,
  };
}

function configWithArms(arms: ArmsConfig): IntersectionConfig {
  return { ...createDefaultConfig(), arms };
}

const SHARED_LANE: LaneConfig = { designations: ['left', 'through', 'right'] };

describe('config model constants', () => {
  it('fixes the canonical arm order used for FIFO tiebreaks (R1 §4.2: N, E, S, W)', () => {
    expect(ARM_IDS).toEqual(['north', 'east', 'south', 'west']);
  });

  it('commits the research timestep: dt = 0.1 s, used verbatim by the default config (F1 loop)', () => {
    expect(DEFAULT_SIM_DT_SECONDS).toBe(0.1);
    expect(createDefaultConfig().dt).toBe(DEFAULT_SIM_DT_SECONDS);
  });

  it('maps arms to signal axes', () => {
    expect(axisOfArm('north')).toBe('ns');
    expect(axisOfArm('south')).toBe('ns');
    expect(axisOfArm('east')).toBe('ew');
    expect(axisOfArm('west')).toBe('ew');
    expect(armsOfAxis(createDefaultConfig().arms, 'ns')).toHaveLength(2);
    expect(armsOfAxis(createDefaultConfig().arms, 'ew')).toHaveLength(2);
  });
});

describe('dedicated left lanes and leftMode defaults (R1 §5.1, §9)', () => {
  it('detects a dedicated left-only lane; shared lanes do not qualify', () => {
    expect(
      hasDedicatedLeftLane(
        armWithLanes([{ designations: ['left'] }, { designations: ['through', 'right'] }]),
      ),
    ).toBe(true);
    expect(hasDedicatedLeftLane(armWithLanes([{ designations: ['left', 'through'] }]))).toBe(false);
  });

  it('defaults leftMode to protected iff the axis has a dedicated left lane', () => {
    expect(defaultLeftModes(createDefaultConfig().arms)).toEqual({ ns: 'permissive', ew: 'permissive' });
    const split = armWithLanes([{ designations: ['left'] }, { designations: ['through', 'right'] }]);
    const arms: ArmsConfig = { north: split, east: split, south: split, west: split };
    expect(defaultLeftModes(arms)).toEqual({ ns: 'protected', ew: 'protected' });
  });
});

describe('NEMA-lite ring derivation (R1 §5.1)', () => {
  it('produces the 2-phase ring when permissive and the canonical 4-phase ring when protected', () => {
    expect(signalPhaseKinds({ ns: 'permissive', ew: 'permissive' })).toEqual([
      'ns-through-right',
      'ew-through-right',
    ]);
    expect(signalPhaseKinds({ ns: 'protected', ew: 'permissive' })).toEqual([
      'ns-protected-left',
      'ns-through-right',
      'ew-through-right',
    ]);
    expect(signalPhaseKinds({ ns: 'protected', ew: 'protected' })).toEqual([
      'ns-protected-left',
      'ns-through-right',
      'ew-protected-left',
      'ew-through-right',
    ]);
  });
});

describe('change intervals computed from geometry (R1 §5.1)', () => {
  it('yellow = t_r + v/(2·a_y) = 3.3 s at 13.9 m/s (t_r = 1.0, a_y = 3.0), tick-rounded', () => {
    expect(phaseChangeIntervals(createDefaultConfig(), 'ns-through-right').yellowSeconds).toBe(3.3);
  });

  it('all-red = (W + len)/v grows with cross-street lanes: 0.6 / 0.9 / 1.1 s at 1/2/3 lanes', () => {
    const oneLane = createDefaultConfig();
    expect(phaseChangeIntervals(oneLane, 'ns-through-right').allRedSeconds).toBe(0.6);

    const twoLanes = configWithArms({
      north: armWithLanes([{ designations: ['left'] }, { designations: ['through', 'right'] }]),
      east: armWithLanes([{ designations: ['left'] }, { designations: ['through', 'right'] }]),
      south: armWithLanes([{ designations: ['left'] }, { designations: ['through', 'right'] }]),
      west: armWithLanes([{ designations: ['left'] }, { designations: ['through', 'right'] }]),
    });
    expect(phaseChangeIntervals(twoLanes, 'ns-through-right').allRedSeconds).toBe(0.9);

    const threeLanes = configWithArms({
      north: armWithLanes([
        { designations: ['left'] },
        { designations: ['through'] },
        { designations: ['through', 'right'] },
      ]),
      east: armWithLanes([
        { designations: ['left'] },
        { designations: ['through'] },
        { designations: ['through', 'right'] },
      ]),
      south: armWithLanes([
        { designations: ['left'] },
        { designations: ['through'] },
        { designations: ['through', 'right'] },
      ]),
      west: armWithLanes([
        { designations: ['left'] },
        { designations: ['through'] },
        { designations: ['through', 'right'] },
      ]),
    });
    // R1 §5.1's own example: "all-red ≈ 1.1 s at 3 lanes".
    expect(phaseChangeIntervals(threeLanes, 'ns-through-right').allRedSeconds).toBe(1.1);
  });

  it('yellow uses the fastest arm on the axis; all-red uses the slowest (conservative)', () => {
    const fast = armWithLanes([SHARED_LANE], 13.9);
    const slow = armWithLanes([SHARED_LANE], 10);
    const config = configWithArms({ north: fast, south: slow, east: fast, west: fast });
    const intervals = phaseChangeIntervals(config, 'ns-through-right');
    // Fastest (13.9): yellow would be 2.7 s if computed from the slow arm.
    expect(intervals.yellowSeconds).toBe(3.3);
    // Slowest (10): all-red would be 0.6 s if computed from the fast arm.
    expect(intervals.allRedSeconds).toBe(0.9);
  });
});

describe('plan duration and spawn pressure', () => {
  it('totals greens plus computed change intervals: 26 + 26 greens + 2×(3.3 + 0.6) = 59.8 s', () => {
    const config = createDefaultConfig();
    if (config.control.type !== 'signal') throw new Error('default config must be signalized');
    expect(signalPlanDurationSeconds(config, config.control.plan)).toBeCloseTo(59.8, 10);
  });

  it('totalSpawnRateVehPerHour sums all four arms', () => {
    expect(totalSpawnRateVehPerHour(createDefaultConfig())).toBe(1200);
  });
});
