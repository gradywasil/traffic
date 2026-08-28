import { describe, expect, it } from 'vitest';
import { totalSpawnRateVehPerHour, validateConfig } from '../config';
import type { IntersectionConfig } from '../config';
import { PRESETS, getPreset, isPresetId } from './presets';
import type { PresetId } from './presets';

const light = getPreset('light');
const balanced = getPreset('balanced');
const gridlock = getPreset('gridlock-risk');

describe('presets: inventory', () => {
  it('exports exactly the three planned presets in order', () => {
    expect(PRESETS.map((preset) => preset.id)).toEqual(['light', 'balanced', 'gridlock-risk']);
  });

  it('getPreset throws on unknown ids; isPresetId discriminates', () => {
    expect(isPresetId('light')).toBe(true);
    expect(isPresetId('balanced')).toBe(true);
    expect(isPresetId('gridlock-risk')).toBe(true);
    expect(isPresetId('heavier')).toBe(false);
    expect(() => getPreset('heavier' as PresetId)).toThrow(/unknown preset/);
  });
});

describe('presets: validation round-trips', () => {
  it('each preset passes validation, including through a JSON copy', () => {
    for (const preset of PRESETS) {
      expect(validateConfig(preset.config)).toEqual([]);
      const copy = JSON.parse(JSON.stringify(preset.config)) as IntersectionConfig;
      expect(validateConfig(copy)).toEqual([]);
    }
  });

  it('a preset stays valid when control is switched to all-way stop', () => {
    const config: IntersectionConfig = { ...balanced.config, control: { type: 'all-way-stop' } };
    expect(validateConfig(config)).toEqual([]);
  });

  it('all presets run the committed dt = 0.1 s with signalized control', () => {
    for (const preset of PRESETS) {
      expect(preset.config.dt).toBe(0.1);
      expect(preset.config.control.type).toBe('signal');
    }
  });

  it('keeps 1-3 lanes on every arm of every preset', () => {
    for (const preset of PRESETS) {
      for (const arm of Object.values(preset.config.arms)) {
        expect(arm.lanes.length).toBeGreaterThanOrEqual(1);
        expect(arm.lanes.length).toBeLessThanOrEqual(3);
      }
    }
  });
});

describe('presets: distinct demand signatures', () => {
  it('commits the research cycle lengths 50/60/80 s (R1 §9)', () => {
    const cycles = PRESETS.map((preset) =>
      preset.config.control.type === 'signal' ? preset.config.control.plan.cycleLengthSeconds : 0,
    );
    expect(cycles).toEqual([50, 60, 80]);
  });

  it('has strictly increasing spawn pressure, per arm and intersection-wide', () => {
    const perArm = [light, balanced, gridlock].map(
      (preset) => preset.config.arms.north.spawnRateVehPerHour,
    );
    expect(perArm[0]).toBeLessThan(perArm[1]!);
    expect(perArm[1]).toBeLessThan(perArm[2]!);
    expect(perArm).toEqual([250, 550, 1100]);

    const totals = [light, balanced, gridlock].map((preset) =>
      totalSpawnRateVehPerHour(preset.config),
    );
    expect(totals).toEqual([1000, 2200, 4400]);
  });

  it('serves heavier presets with dedicated left lanes (4-phase ring); light stays permissive (2-phase)', () => {
    const ringOf = (preset: typeof light): readonly string[] => {
      if (preset.config.control.type !== 'signal') throw new Error('preset must be signalized');
      return preset.config.control.plan.phases.map((phase) => phase.kind);
    };
    expect(ringOf(light)).toEqual(['ns-through-right', 'ew-through-right']);
    expect(ringOf(balanced)).toEqual([
      'ns-protected-left',
      'ns-through-right',
      'ew-protected-left',
      'ew-through-right',
    ]);
    expect(ringOf(gridlock)).toEqual([
      'ns-protected-left',
      'ns-through-right',
      'ew-protected-left',
      'ew-through-right',
    ]);
  });
});

describe('presets: immutability', () => {
  it('is deeply frozen — shared references cannot be mutated', () => {
    for (const preset of PRESETS) {
      expect(Object.isFrozen(preset.config)).toBe(true);
      expect(Object.isFrozen(preset.config.arms)).toBe(true);
      expect(Object.isFrozen(preset.config.arms.north)).toBe(true);
      expect(Object.isFrozen(preset.config.control)).toBe(true);
      expect(() => {
        (preset.config as { dt: number }).dt = 0.5;
      }).toThrow();
    }
  });
});
