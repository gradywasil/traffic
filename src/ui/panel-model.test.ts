/**
 * Panel-model unit tests (task U2 acceptance): every config field is
 * editable through the UI model; invalid edits are blocked (no event, issues
 * exposed); the config-change event carries the full new config.
 */
import { describe, expect, it } from 'vitest';
import { MIN_GREEN_SECONDS, validateConfig } from '../config';
import type { IntersectionConfig } from '../config';
import type { PanelEvent } from './panel-model';
import {
  PanelModel,
  cloneConfig,
  coerceTurnMixToLanes,
  lanesForCount,
  rescaleTurnMix,
} from './panel-model';
import { greenSplitSpace } from '../optimizer';
import { getPreset } from '../presets';

function balancedModel(): PanelModel {
  return new PanelModel(getPreset('balanced').config);
}

function recordEvents(model: PanelModel): PanelEvent[] {
  const events: PanelEvent[] = [];
  model.subscribe((event) => events.push(event));
  return events;
}

describe('PanelModel — every config field editable from the UI model', () => {
  it('spawn rate: all four arms editable, event carries the new config', () => {
    const model = balancedModel();
    const events = recordEvents(model);
    for (const arm of ['north', 'east', 'south', 'west'] as const) {
      model.setSpawnRate(arm, 700);
    }
    expect(events).toHaveLength(4);
    for (const event of events) {
      expect(event.type).toBe('config-change');
    }
    const final = (events[3] as { type: 'config-change'; config: IntersectionConfig }).config;
    for (const arm of ['north', 'east', 'south', 'west'] as const) {
      expect(final.arms[arm].spawnRateVehPerHour).toBe(700);
    }
    expect(model.config.arms.north.spawnRateVehPerHour).toBe(700);
    // The carried config is exactly the model's applied config.
    expect(final).toBe(model.config);
    // Every emitted config is valid (validation is the gate).
    expect(validateConfig(model.config)).toEqual([]);
  });

  it('turn mix: each direction editable, others rescale to keep sum 1', () => {
    const model = balancedModel();
    const events = recordEvents(model);
    model.setTurnMixPart('east', 'left', 0.5);
    const mix = model.config.arms.east.turnMix;
    expect(mix.left).toBeCloseTo(0.5, 10);
    expect(mix.left + mix.through + mix.right).toBeCloseTo(1, 10);
    // Balanced starts left .2 / through .55 / right .25: others keep their ratio.
    expect(mix.through / (mix.through + mix.right)).toBeCloseTo(0.55 / 0.8, 10);
    model.setTurnMixPart('east', 'through', 0.1);
    model.setTurnMixPart('east', 'right', 0.2);
    expect(events).toHaveLength(3);
    expect(validateConfig(model.config)).toEqual([]);
  });

  it('lane count: 1→3 grows with through-lane defaults, 3→1 truncates; mix coerced to served turns', () => {
    const model = balancedModel();
    const events = recordEvents(model);
    model.setLaneCount('south', 3);
    expect(model.config.arms.south.lanes).toHaveLength(3);
    expect(model.config.arms.south.lanes[2]?.designations).toEqual(['through']);
    model.setLaneCount('south', 1);
    const arm = model.config.arms.south;
    expect(arm.lanes).toHaveLength(1);
    // Balanced lane 0 is dedicated left; the 3-lane mix included through/right
    // — after truncation those probabilities must be coerced onto 'left'.
    expect(arm.turnMix.left).toBeCloseTo(1, 6);
    expect(events).toHaveLength(2);
    expect(validateConfig(model.config)).toEqual([]);
  });

  it('designations: editable per lane; removing the dedicated left flips leftMode and the ring', () => {
    const model = balancedModel();
    const events = recordEvents(model);
    // North loses its dedicated-left lane (lane 0 becomes left+through shared).
    model.setDesignations('north', 0, ['left', 'through']);
    const config = model.config;
    expect(config.control.type).toBe('signal');
    if (config.control.type !== 'signal') throw new Error('unreachable');
    // South still has a dedicated left → NS stays protected; only when BOTH
    // lose it does the axis flip. Remove south's too.
    model.setDesignations('south', 0, ['left', 'through']);
    const flipped = model.config;
    if (flipped.control.type !== 'signal') throw new Error('unreachable');
    expect(flipped.control.plan.leftMode.ns).toBe('permissive');
    expect(flipped.control.plan.leftMode.ew).toBe('protected');
    // Ring: [NS thru/right] -> [EW protected left] -> [EW thru/right]; greens
    // carried per phase kind (15/7/14), cycle refit.
    expect(flipped.control.plan.phases.map((phase) => phase.kind)).toEqual([
      'ns-through-right',
      'ew-protected-left',
      'ew-through-right',
    ]);
    expect(flipped.control.plan.phases.map((phase) => phase.greenSeconds)).toEqual([15, 7, 14]);
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(validateConfig(flipped)).toEqual([]);
  });

  it('control type: signal → all-way stop → back restores the stashed plan', () => {
    const model = balancedModel();
    const events = recordEvents(model);
    const presetConfig = getPreset('balanced').config;
    const planBefore =
      presetConfig.control.type === 'signal' ? structuredClone(presetConfig.control.plan) : null;
    model.setControlType('all-way-stop');
    expect(model.config.control.type).toBe('all-way-stop');
    expect(validateConfig(model.config)).toEqual([]);
    model.setControlType('signal');
    expect(model.config.control.type).toBe('signal');
    if (model.config.control.type !== 'signal') throw new Error('unreachable');
    expect(model.config.control.plan).toEqual(planBefore);
    expect(events.map((event) => event.type)).toEqual([
      'config-change',
      'config-change',
    ]);
  });

  it('green durations: each phase editable in integer seconds, cycle auto-refits coherently', () => {
    const model = balancedModel();
    const events = recordEvents(model);
    model.setGreenSeconds(0, 12); // NS protected left 7 → 12
    model.setGreenSeconds(1, 20); // NS through 15 → 20
    model.setGreenSeconds(2, 6);
    model.setGreenSeconds(3, 18);
    if (model.config.control.type !== 'signal') throw new Error('unreachable');
    const plan = model.config.control.plan;
    expect(plan.phases.map((phase) => phase.greenSeconds)).toEqual([12, 20, 6, 18]);
    // Change intervals per phase: yellow 3.3 + all-red 0.9 = 4.2 s; greens
    // 56 s + 4 x 4.2 = 72.8 s → cycle 73.
    expect(plan.cycleLengthSeconds).toBe(73);
    expect(validateConfig(model.config)).toEqual([]);
    expect(events).toHaveLength(4);
  });

  it('presets: all three applyable and valid', () => {
    const model = balancedModel();
    for (const id of ['light', 'balanced', 'gridlock-risk'] as const) {
      model.applyPreset(id);
      expect(validateConfig(model.config)).toEqual([]);
      expect(model.presetId).toBe(id);
    }
  });

  it('no-op edits emit nothing', () => {
    const model = balancedModel();
    const events = recordEvents(model);
    model.setSpawnRate('north', 550); // already 550 in balanced
    model.setControlType('signal');
    expect(events).toHaveLength(0);
    expect(model.issues).toEqual([]);
  });
});

describe('PanelModel — invalid edits are blocked or flagged', () => {
  it('clearing a lane to zero designations is flagged and NOT applied', () => {
    const model = balancedModel();
    const before = model.config;
    const events = recordEvents(model);
    model.setDesignations('north', 0, []);
    expect(model.issues.length).toBeGreaterThan(0);
    expect(model.issues.some((issue) => issue.path === 'arms.north.lanes[0].designations')).toBe(true);
    expect(events).toHaveLength(0);
    expect(model.config).toBe(before); // applied config unchanged
  });

  it('positive probability for an unserved turn is flagged, not emitted', () => {
    const model = balancedModel();
    const events = recordEvents(model);
    // First make north serve no left turn anywhere (the structural edit
    // coerces the mix, so it applies cleanly).
    model.setDesignations('north', 0, ['through', 'right']);
    expect(events).toHaveLength(1);
    // Now push left to 100%: no lane serves it — flagged, not applied.
    model.setTurnMixPart('north', 'left', 1);
    expect(model.issues.some((issue) => issue.path === 'arms.north.turnMix.left')).toBe(true);
    expect(events).toHaveLength(1);
    // The draft keeps the user's editing state; fixing it emits the full config.
    model.setTurnMixPart('north', 'left', 0);
    expect(model.issues).toEqual([]);
    expect(events).toHaveLength(2);
    expect(events[1]?.type).toBe('config-change');
    expect(validateConfig((events[1] as { config: IntersectionConfig }).config)).toEqual([]);
  });

  it('green below g_min is prevented by clamping to the F2 floor', () => {
    const model = balancedModel();
    model.setGreenSeconds(0, 2);
    if (model.config.control.type !== 'signal') throw new Error('unreachable');
    expect(model.config.control.plan.phases[0]?.greenSeconds).toBe(MIN_GREEN_SECONDS);
    expect(model.issues).toEqual([]);
  });

  it('greens large enough to exceed the 180 s cycle bound are flagged, not applied', () => {
    const model = balancedModel();
    const events = recordEvents(model);
    model.setGreenSeconds(0, 80); // 116 s greens -> cycle 133: still valid
    model.setGreenSeconds(1, 80); // 181 s greens -> cycle ~198 > 180: flagged
    model.setGreenSeconds(2, 80);
    model.setGreenSeconds(3, 80);
    expect(model.issues.some((issue) => issue.path.startsWith('control.plan'))).toBe(true);
    expect(events).toHaveLength(1); // only the first edit passed validation
  });

  it('initial config must be valid (constructor guards)', () => {
    const broken = cloneConfig(getPreset('balanced').config) as { dt: number } & IntersectionConfig;
    broken.dt = -1;
    expect(() => new PanelModel(broken)).toThrow(/invalid/);
  });
});

describe('PanelModel — preset identity', () => {
  it('edits move the model to custom; re-applying a preset restores identity', () => {
    const model = balancedModel();
    expect(model.presetId).toBe('balanced');
    model.setSpawnRate('west', 600);
    expect(model.presetId).toBe('custom');
    model.applyPreset('balanced');
    expect(model.presetId).toBe('balanced');
  });
});

describe('PanelModel — playback and selection events', () => {
  it('pause/toggle/speed/select emit and reflect state', () => {
    const model = balancedModel();
    const events = recordEvents(model);
    model.togglePaused();
    expect(model.paused).toBe(true);
    model.setSpeed(4);
    expect(model.speed).toBe(4);
    model.setSpeed(0.5);
    model.setPaused(false);
    model.select('east', 1);
    expect(model.selection).toEqual({ arm: 'east', laneIndex: 1 });
    model.select(null);
    expect(model.selection).toEqual({ arm: null, laneIndex: null });
    expect(events.map((event) => event.type)).toEqual([
      'pause',
      'speed',
      'speed',
      'pause',
      'select',
      'select',
    ]);
  });

  it('config edits still emit while paused (edit-while-running is config-domain)', () => {
    const model = balancedModel();
    model.setPaused(true);
    const events = recordEvents(model);
    model.setSpawnRate('north', 400);
    expect(events.map((event) => event.type)).toEqual(['config-change']);
  });
});

describe('turn-mix helpers', () => {
  it('rescaleTurnMix keeps the exact sum and preserves other ratios', () => {
    const rescaled = rescaleTurnMix({ left: 0.2, through: 0.55, right: 0.25 }, 'right', 0.5);
    expect(rescaled.left + rescaled.through + rescaled.right).toBeCloseTo(1, 12);
    expect(rescaled.right).toBe(0.5);
    expect(rescaled.left + rescaled.through).toBeCloseTo(0.5, 12);
    expect(rescaled.left / rescaled.through).toBeCloseTo(0.2 / 0.55, 10);
  });

  it('rescaleTurnMix parks the remainder on through when both others are zero', () => {
    const rescaled = rescaleTurnMix({ left: 1, through: 0, right: 0 }, 'left', 0.3);
    expect(rescaled).toEqual({ left: 0.3, through: 0.7, right: 0 });
  });

  it('coerceTurnMixToLanes zeroes unserved turns and renormalizes', () => {
    const coerced = coerceTurnMixToLanes(
      { left: 0.2, through: 0.55, right: 0.25 },
      [{ designations: ['through'] }],
    );
    expect(coerced).toEqual({ left: 0, through: 1, right: 0 });
    const partial = coerceTurnMixToLanes(
      { left: 0.2, through: 0.55, right: 0.25 },
      [{ designations: ['left'] }, { designations: ['through', 'right'] }],
    );
    expect(partial.left).toBeCloseTo(0.2, 10);
    expect(partial.through + partial.right).toBeCloseTo(0.8, 10);
    expect(partial.through / partial.right).toBeCloseTo(0.55 / 0.25, 10);
  });

  it('coerceTurnMixToLanes falls back to a single served turn when all zero', () => {
    expect(
      coerceTurnMixToLanes({ left: 0, through: 0, right: 0 }, [{ designations: ['left'] }]),
    ).toEqual({ left: 1, through: 0, right: 0 });
  });

  it('lanesForCount clamps to the F2 bounds and appends through-only lanes', () => {
    const one = [{ designations: ['left', 'through', 'right'] as const }];
    expect(lanesForCount(one, 0)).toHaveLength(1);
    expect(lanesForCount(one, 9)).toHaveLength(3);
    const grown = lanesForCount(one, 3);
    expect(grown[1]?.designations).toEqual(['through']);
    expect(grown[2]?.designations).toEqual(['through']);
  });
});

// ---------------------------------------------------------------------------
// applySignalPlan (O2: the optimizer's one-click apply path through the U2
// panel model — one plan-only config-change, validation-gated)
// ---------------------------------------------------------------------------

describe('PanelModel — applySignalPlan (optimizer apply path)', () => {
  it('installs a swept plan in ONE commit: one config-change, plan-only diff, cycle coherent', () => {
    const model = balancedModel();
    const events = recordEvents(model);
    const candidate = greenSplitSpace(getPreset('balanced').config).candidates[0];
    if (candidate === undefined) throw new Error('no candidate');

    const issues = model.applySignalPlan(candidate.plan);
    expect(issues).toEqual([]);
    expect(events).toHaveLength(1);
    const event = events[0];
    if (event === undefined || event.type !== 'config-change') throw new Error('expected config-change');
    if (event.config.control.type !== 'signal') throw new Error('expected signal');
    expect(event.config.control.plan.phases.map((phase) => phase.greenSeconds)).toEqual([...candidate.greens]);
    // Plan-only: everything the sweep froze is untouched.
    expect(event.config.arms).toEqual(model.draft.arms);
    expect(event.config.geometry).toEqual(model.draft.geometry);
    expect(validateConfig(model.config)).toEqual([]);
    // The applied plan survives config inspection.
    if (model.config.control.type !== 'signal') throw new Error('unreachable');
    expect(model.config.control.plan.phases.map((phase) => phase.greenSeconds)).toEqual([...candidate.greens]);
  });

  it('keeps unrelated draft edits (a concurrent spawn-rate change rides along)', () => {
    const model = balancedModel();
    model.setSpawnRate('north', 800); // one event
    const candidate = greenSplitSpace(getPreset('balanced').config).candidates[1];
    if (candidate === undefined) throw new Error('no candidate');
    const events = recordEvents(model);
    const issues = model.applySignalPlan(candidate.plan);
    expect(issues).toEqual([]);
    expect(events).toHaveLength(1);
    const config = events[0]?.type === 'config-change' ? events[0].config : null;
    expect(config?.arms.north.spawnRateVehPerHour).toBe(800);
    expect(config?.control.type).toBe('signal');
  });

  it('re-applying the current plan is a no-op (no event)', () => {
    const model = balancedModel();
    const preset = getPreset('balanced').config;
    if (preset.control.type !== 'signal') throw new Error('unreachable');
    const events = recordEvents(model);
    expect(model.applySignalPlan(preset.control.plan)).toEqual([]);
    expect(events).toHaveLength(0);
    expect(model.issues).toEqual([]);
  });

  it('is blocked under all-way stop (issue returned, no event)', () => {
    const model = balancedModel();
    model.setControlType('all-way-stop'); // stashes the plan
    const candidate = greenSplitSpace(getPreset('balanced').config).candidates[0];
    if (candidate === undefined) throw new Error('no candidate');
    const events = recordEvents(model);
    const issues = model.applySignalPlan(candidate.plan);
    expect(issues.length).toBeGreaterThan(0);
    expect(events).toHaveLength(0);
    expect(model.config.control.type).toBe('all-way-stop');
  });

  it('is blocked while the draft is invalid (pending user edit) and emits nothing', () => {
    const model = balancedModel();
    model.setDesignations('north', 0, []); // invalid draft: empty designations
    expect(model.issues.length).toBeGreaterThan(0);
    const candidate = greenSplitSpace(getPreset('balanced').config).candidates[0];
    if (candidate === undefined) throw new Error('no candidate');
    const events = recordEvents(model);
    const issues = model.applySignalPlan(candidate.plan);
    expect(issues.length).toBeGreaterThan(0);
    expect(events).toHaveLength(0);
  });
});
