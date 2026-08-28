/**
 * Signal controller tests (task F5 acceptance): phase timing EXACT for a
 * 2-phase and a 4-phase plan — ring transitions at exact tick boundaries,
 * derived yellow/all-red durations from config, full-cycle periodicity,
 * per-movement indications/authority (incl. protected vs permissive left
 * handling), the §3.1 dilemma-zone rule, and the yellow-end window.
 */
import { describe, expect, it } from 'vitest';
import type { IntersectionConfig, SignalPhaseKind } from '../../config';
import { phaseChangeIntervals } from '../../config';
import { createDefaultConfig } from '../../config/defaults';
import { getPreset } from '../../presets';
import { buildIntersectionGeometry } from '../../geom';
import type { IntersectionGeometry } from '../../geom';
import { SignalController } from './signal';
import type { RingStage } from './signal';

const DT = 0.1;

function movementIndexOf(geometry: IntersectionGeometry, arm: string, lane: number, turn: string): number {
  const index = geometry.movements.findIndex((m) => m.id === `${arm}:${String(lane)}:${turn}`);
  if (index < 0) throw new Error(`movement ${arm}:${String(lane)}:${turn} not found`);
  return index;
}

/** Independently computed expected stage list (config helpers, not the controller). */
function expectedStages(config: IntersectionConfig): RingStage[] {
  if (config.control.type !== 'signal') throw new Error('signal config required');
  const stages: RingStage[] = [];
  let startTick = 0;
  for (const phase of config.control.plan.phases) {
    const intervals = phaseChangeIntervals(config, phase.kind);
    for (const [stage, seconds] of [
      ['green', phase.greenSeconds],
      ['yellow', intervals.yellowSeconds],
      ['all-red', intervals.allRedSeconds],
    ] as const) {
      const durationTicks = Math.round(seconds / DT);
      stages.push({ phaseIndex: stages.length === 0 ? 0 : 0, kind: phase.kind, stage, startTick, durationTicks });
      startTick += durationTicks;
    }
  }
  // Fix phaseIndex per phase group (three stages per phase).
  let phaseIndex = 0;
  for (let i = 0; i < stages.length; i += 3) {
    for (let k = 0; k < 3; k += 1) {
      Object.assign(stages[i + k] as { phaseIndex: number }, { phaseIndex });
    }
    phaseIndex += 1;
  }
  return stages;
}

function assertRingExact(config: IntersectionConfig, label: string): void {
  const geometry = buildIntersectionGeometry(config);
  const controller = new SignalController(geometry, config);
  const expected = expectedStages(config);
  const cycle = expected.reduce((sum, stage) => sum + stage.durationTicks, 0);

  // Structure: green/yellow/all-red per phase, cumulative starts, exact ticks.
  expect(controller.cycleTicks, `${label} cycle`).toBe(cycle);
  expect(controller.stages.map((s) => s.stage)).toEqual(expected.map((s) => s.stage));
  expect(controller.stages.map((s) => s.kind)).toEqual(expected.map((s) => s.kind));
  expect(controller.stages.map((s) => s.startTick)).toEqual(expected.map((s) => s.startTick));
  expect(controller.stages.map((s) => s.durationTicks)).toEqual(expected.map((s) => s.durationTicks));

  // Full walk: every tick of two full cycles lands in the expected stage with
  // the exact tick offset — transitions land on exact tick boundaries.
  for (const stage of expected) {
    for (let k = 0; k < stage.durationTicks; k += 1) {
      for (const cycleOffset of [0, cycle]) {
        const tick = stage.startTick + k + cycleOffset;
        const state = controller.stageAtTick(tick);
        expect(state.kind, `${label} tick ${String(tick)} kind`).toBe(stage.kind);
        expect(state.stage, `${label} tick ${String(tick)} stage`).toBe(stage.stage);
        expect(state.phaseIndex, `${label} tick ${String(tick)} phase`).toBe(stage.phaseIndex);
        expect(state.tickIntoStage, `${label} tick ${String(tick)} into`).toBe(k);
        expect(state.ticksRemainingInStage, `${label} tick ${String(tick)} remaining`).toBe(
          stage.durationTicks - k,
        );
      }
    }
  }

  // Periodicity across cycles (pure function of tick).
  for (const tick of [0, 1, 17, cycle - 1, cycle, 3 * cycle + 5]) {
    const a = controller.stageAtTick(tick);
    const b = controller.stageAtTick(tick + cycle);
    expect(a).toEqual(b);
  }
}

describe('phase timing exact (acceptance)', () => {
  it('2-phase plan (permissive lefts): exact ring on the tick grid', () => {
    assertRingExact(createDefaultConfig(), '2-phase');
  });

  it('4-phase plan with protected lefts: exact ring on the tick grid', () => {
    assertRingExact(getPreset('balanced').config, '4-phase');
  });

  it('4-phase ring serves phases in NEMA-lite order', () => {
    const config = getPreset('balanced').config;
    const controller = new SignalController(buildIntersectionGeometry(config), config);
    const kinds: SignalPhaseKind[] = [];
    for (const stage of controller.stages) {
      if (stage.stage === 'green' && kinds[kinds.length - 1] !== stage.kind) kinds.push(stage.kind);
    }
    expect(kinds).toEqual(['ns-protected-left', 'ns-through-right', 'ew-protected-left', 'ew-through-right']);
  });

  it('change intervals match the committed arithmetic (y = 1.0 + v/(2·3.0), r = (W+len)/v)', () => {
    const config = createDefaultConfig();
    const controller = new SignalController(buildIntersectionGeometry(config), config);
    // Default: v = 13.9 → yellow = 1.0 + 13.9/6 = 3.3166… → 3.3 s = 33 ticks.
    // 1-lane cross street → W = 3.5 → all-red = 8.5/13.9 = 0.6115… → 0.6 s = 6 ticks.
    expect(controller.stages[1]?.stage).toBe('yellow');
    expect(controller.stages[1]?.durationTicks).toBe(33);
    expect(controller.stages[2]?.stage).toBe('all-red');
    expect(controller.stages[2]?.durationTicks).toBe(6);
  });
});

describe('indications and grant authority per movement', () => {
  it('2-phase permissive: lefts ride the through phase as yield movements', () => {
    const config = createDefaultConfig();
    const geometry = buildIntersectionGeometry(config);
    const controller = new SignalController(geometry, config);
    const nLeft = movementIndexOf(geometry, 'north', 0, 'left');
    const nThrough = movementIndexOf(geometry, 'north', 0, 'through');
    const eThrough = movementIndexOf(geometry, 'east', 0, 'through');

    expect(controller.movementGrantMode(nLeft, 0)).toBe('green-yield');
    expect(controller.movementGrantMode(nThrough, 0)).toBe('green-protected');
    expect(controller.movementGrantMode(eThrough, 0)).toBe('none'); // EW red during NS green
    expect(controller.indication(nLeft, 0)).toBe('green');
    expect(controller.indication(eThrough, 0)).toBe('red');

    // NS yellow (green 26 s → ticks 260..292): served movements yellow.
    expect(controller.movementGrantMode(nThrough, 260)).toBe('yellow-protected');
    expect(controller.movementGrantMode(nLeft, 260)).toBe('yellow-yield');
    expect(controller.indication(nThrough, 260)).toBe('yellow');
    expect(controller.indication(eThrough, 260)).toBe('red');

    // All-red (ticks 293..298): everything red.
    expect(controller.movementGrantMode(nThrough, 295)).toBe('none');
    expect(controller.movementGrantMode(eThrough, 295)).toBe('none');
    expect(controller.indication(nThrough, 295)).toBe('red');

    // EW green (299..): mirror image.
    expect(controller.movementGrantMode(eThrough, 300)).toBe('green-protected');
    expect(controller.movementGrantMode(nThrough, 300)).toBe('none');
  });

  it('4-phase protected: lefts served in their own phase only (protected-only)', () => {
    const config = getPreset('balanced').config;
    const geometry = buildIntersectionGeometry(config);
    const controller = new SignalController(geometry, config);
    const nLeft = movementIndexOf(geometry, 'north', 0, 'left'); // dedicated lane 0
    const nThrough = movementIndexOf(geometry, 'north', 1, 'through');

    // P0 green (ticks 0..69): protected lefts only.
    expect(controller.movementGrantMode(nLeft, 0)).toBe('green-protected');
    expect(controller.movementGrantMode(nThrough, 0)).toBe('none');
    // P1 green (ticks 112..261): through/right; lefts protected-only → red.
    expect(controller.movementGrantMode(nThrough, 120)).toBe('green-protected');
    expect(controller.movementGrantMode(nLeft, 120)).toBe('none');
    expect(controller.indication(nLeft, 120)).toBe('red');
    // EW protected-left phase (304..373): south/west lefts green, NS none.
    const wLeft = movementIndexOf(geometry, 'west', 0, 'left');
    expect(controller.movementGrantMode(wLeft, 310)).toBe('green-protected');
    expect(controller.movementGrantMode(nThrough, 310)).toBe('none');
  });
});

describe('dilemma-zone rule (§3.1, owned by F5)', () => {
  const config = createDefaultConfig();
  const controller = new SignalController(buildIntersectionGeometry(config), config);
  // Comfortable stopping distance at 13.9 m/s with b = 2.0: 13.9²/4 = 48.3025 m.
  const STOP_DISTANCE = (13.9 * 13.9) / 4;

  it('may enter on yellow only when a comfortable stop is impossible', () => {
    expect(controller.dilemmaEligible(13.9, STOP_DISTANCE - 0.1)).toBe(true); // cannot stop
    expect(controller.dilemmaEligible(13.9, STOP_DISTANCE)).toBe(false); // exactly able to stop → stop
    expect(controller.dilemmaEligible(13.9, STOP_DISTANCE + 0.1)).toBe(false);
    expect(controller.dilemmaEligible(0, 0.1)).toBe(false);
    expect(controller.dilemmaEligible(8, 10)).toBe(true); // 8²/4 = 16 > 10 → cannot stop
    expect(controller.dilemmaEligible(8, 16.1)).toBe(false);
    expect(controller.dilemmaEligible(8, 15.9)).toBe(true);
  });
});

describe('yellow-end window (imminent-entry rule input)', () => {
  it('counts down green + yellow, then yellow, then 0', () => {
    const config = createDefaultConfig();
    const controller = new SignalController(buildIntersectionGeometry(config), config);
    // Green 260 ticks, yellow 33: at tick 0 the car has (260 + 33)·0.1 = 29.3 s.
    expect(controller.secondsUntilYellowEnd(0)).toBeCloseTo(29.3, 9);
    expect(controller.secondsUntilYellowEnd(250)).toBeCloseTo(4.3, 9);
    expect(controller.secondsUntilYellowEnd(260)).toBeCloseTo(3.3, 9);
    expect(controller.secondsUntilYellowEnd(292)).toBeCloseTo(0.1, 9);
    expect(controller.secondsUntilYellowEnd(295)).toBe(0); // all-red
  });

  it('wraps absolute ticks into the cycle (regression: unwrapped stage math killed all grants after cycle 1)', () => {
    const config = createDefaultConfig();
    const controller = new SignalController(buildIntersectionGeometry(config), config);
    const cycle = controller.cycleTicks; // 598 at defaults
    for (const tick of [0, 1, 17, 250, 299, 560, 597]) {
      expect(controller.secondsUntilYellowEnd(tick + cycle)).toBeCloseTo(controller.secondsUntilYellowEnd(tick), 12);
      expect(controller.secondsUntilYellowEnd(tick + 7 * cycle)).toBeCloseTo(controller.secondsUntilYellowEnd(tick), 12);
    }
    expect(controller.secondsUntilYellowEnd(cycle + 250)).toBeCloseTo(4.3, 9);
  });
});
