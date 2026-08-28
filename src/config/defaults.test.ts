import { describe, expect, it } from 'vitest';
import { DEFAULT_GEOMETRY, DEFAULT_MODEL_PARAMS, createDefaultConfig } from './defaults';
import { defaultLeftModes } from './model';
import { validateConfig } from './validate';

describe('model parameter defaults (R1 §3.1 committed constants)', () => {
  it('matches the research record exactly', () => {
    expect(DEFAULT_MODEL_PARAMS).toEqual({
      cruiseSpeedMps: 13.9, // v_c
      timeHeadwaySeconds: 1.1, // T
      maxAccelerationMps2: 1.3, // a
      comfortableDecelMps2: 2.0, // b
      minGapMeters: 2.0, // s0
      accelerationExponent: 4, // delta
      carLengthMeters: 5.0, // len
      emergencyDecelMps2: 6.0, // b_e
      hardMinGapMeters: 0.5, // s_min
      lateralAccelMps2: 1.7, // a_lat
      yellowReactionSeconds: 1.0, // t_r (R1 §5.1)
      yellowDecelMps2: 3.0, // a_y (R1 §5.1)
    });
  });

  it('geometry defaults to 3.5 m lanes (reproduces R1 §5.1 all-red arithmetic)', () => {
    expect(DEFAULT_GEOMETRY.laneWidthMeters).toBe(3.5);
  });
});

describe('createDefaultConfig', () => {
  it('produces a valid config (round-trips validation with zero issues)', () => {
    expect(validateConfig(createDefaultConfig())).toEqual([]);
  });

  it('is permissive-left 2-phase by default (single shared lane per arm)', () => {
    const config = createDefaultConfig();
    expect(defaultLeftModes(config.arms)).toEqual({ ns: 'permissive', ew: 'permissive' });
    if (config.control.type !== 'signal') throw new Error('default config must be signalized');
    expect(config.control.plan.leftMode).toEqual({ ns: 'permissive', ew: 'permissive' });
    expect(config.control.plan.phases.map((phase) => phase.kind)).toEqual([
      'ns-through-right',
      'ew-through-right',
    ]);
  });

  it('returns a fresh, mutable object on each call (presets are the frozen ones)', () => {
    const a = createDefaultConfig();
    const b = createDefaultConfig();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
    (a.arms.north as { spawnRateVehPerHour: number }).spawnRateVehPerHour = 123;
    expect(a.arms.north.spawnRateVehPerHour).toBe(123);
    expect(b.arms.north.spawnRateVehPerHour).toBe(300);
  });
});
