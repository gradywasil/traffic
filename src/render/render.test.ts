/**
 * U1 renderer tests. Rendering itself is validated by inspecting the
 * deterministic draw list (the documented rendered-inspection proxy until a
 * real browser pass in D1/Q2): layer ordering, road-before-cars, car
 * command coverage with interpolated positions, and control devices
 * reflecting controller state at the tick. Pure helpers (behavior
 * classification, arrow glyphs, marking geometry) get direct unit tests.
 */
import { describe, expect, it } from 'vitest';
import type { TurnDirection } from '../config';
import { CAR_WIDTH_METERS, PX_PER_METER, worldToCanvas } from '../geom';
import { buildIntersectionGeometry } from '../geom';
import { getPreset } from '../presets/presets';
import { createControlSystem } from '../sim/control';
import type { SignalColor } from '../sim/control/signal';
import { Spawner } from '../sim/spawn';
import { createCarWorld } from '../sim/world';
import type { CarWorld } from '../sim/world';
import { classifyCarBehavior, classifyTurnSignal, TURN_SIGNAL_LEAD_METERS, turnSignalLit } from './behavior';
import { CAR_BEHAVIOR_COLORS, CAR_STROKE_COLOR, SIGNAL_LAMP_COLORS, TURN_SIGNAL_LAMP_COLOR } from './colors';
import { layerRank } from './drawlist';
import type { DrawCommand } from './drawlist';
import { arrowGlyphToWorld, laneArrowGlyph } from './arrows';
import { buildMarkings, expandDashes } from './markings';
import { WorldRenderer } from './renderer';
import type { ControlSystem } from '../sim/control';

const ALMOST = 1e-9;

function pipeline(config: ReturnType<typeof getPreset>['config'], ticks: number, seed = 7): {
  world: CarWorld;
  control: ControlSystem;
  renderer: WorldRenderer;
} {
  const geometry = buildIntersectionGeometry(config);
  const world = createCarWorld(geometry, config);
  const control = createControlSystem(geometry, config);
  const spawner = new Spawner(geometry, config, { masterSeed: seed });
  for (let t = 0; t < ticks; t += 1) {
    const constraints = control.step(world);
    world.step(constraints);
    spawner.step(world);
  }
  return { world, control, renderer: new WorldRenderer(geometry, config) };
}

function allWayStopConfig(): ReturnType<typeof getPreset>['config'] {
  const clone = structuredClone(getPreset('balanced').config);
  return { ...clone, control: { type: 'all-way-stop' } };
}

// --- behavior classification --------------------------------------------------

describe('classifyCarBehavior (pure sim-state derivation)', () => {
  const base = {
    phase: undefined,
    speedMps: 13.9,
    prevSpeedMps: 13.9,
    stopControl: false,
    isYieldLeft: false,
  } as const;

  it('IN_BOX phase → in-intersection regardless of motion', () => {
    expect(classifyCarBehavior({ ...base, phase: 'in-box', speedMps: 3.5, prevSpeedMps: 3.5 })).toBe(
      'in-intersection',
    );
  });

  it('PENDING + slow + stop control → yielding (FIFO right-of-way hold)', () => {
    expect(
      classifyCarBehavior({ ...base, phase: 'pending', speedMps: 0.2, prevSpeedMps: 0.4, stopControl: true }),
    ).toBe('yielding');
  });

  it('PENDING + slow + yield left under a signal → yielding (τ_clear gap wait)', () => {
    expect(
      classifyCarBehavior({ ...base, phase: 'pending', speedMps: 1.5, prevSpeedMps: 1.6, isYieldLeft: true }),
    ).toBe('yielding');
  });

  it('PENDING + slow signal-red through car → braking-queue, not yielding', () => {
    expect(classifyCarBehavior({ ...base, phase: 'pending', speedMps: 0.1, prevSpeedMps: 0.1 })).toBe(
      'braking-queue',
    );
  });

  it('PENDING + still rolling toward a yield → not yielding yet', () => {
    expect(
      classifyCarBehavior({ ...base, phase: 'pending', speedMps: 9.0, prevSpeedMps: 9.0, isYieldLeft: true }),
    ).toBe('cruise');
  });

  it('stopped or decelerating → braking-queue', () => {
    expect(classifyCarBehavior({ ...base, speedMps: 0.3, prevSpeedMps: 0.3 })).toBe('braking-queue');
    expect(classifyCarBehavior({ ...base, speedMps: 8.0, prevSpeedMps: 9.5 })).toBe('braking-queue');
  });

  it('steady speed → cruise', () => {
    expect(classifyCarBehavior({ ...base, speedMps: 13.9, prevSpeedMps: 13.9 })).toBe('cruise');
    expect(classifyCarBehavior({ ...base, speedMps: 13.9, prevSpeedMps: 13.86 })).toBe('cruise');
  });
});

// --- arrow glyphs ---------------------------------------------------------------

describe('laneArrowGlyph (designation arrows, lane-local meters)', () => {
  const LANE_HALF = 1.75; // 3.5 m default lane width

  it('fits every designation combination of the presets inside the lane width', () => {
    const combos: readonly (readonly TurnDirection[])[] = [
      ['left'],
      ['through'],
      ['right'],
      ['left', 'through', 'right'],
      ['left', 'through'],
      ['through', 'right'],
      ['left', 'right'],
    ];
    for (const designations of combos) {
      const glyph = laneArrowGlyph(designations);
      expect(glyph.maxAbsLateral).toBeLessThanOrEqual(LANE_HALF + ALMOST);
      expect(glyph.heads).toHaveLength(designations.length);
      for (const head of glyph.heads) expect(head).toHaveLength(3);
    }
  });

  it('through-only arrow is straight (no lateral excursion)', () => {
    const glyph = laneArrowGlyph(['through']);
    for (const stroke of glyph.strokes) {
      for (const p of stroke) expect(Math.abs(p.y)).toBeLessThanOrEqual(ALMOST);
    }
    for (const head of glyph.heads) {
      for (const p of head) expect(Math.abs(p.y)).toBeLessThanOrEqual(0.95 + ALMOST);
    }
  });

  it('left and right single-turn arrows are mirror images (y → −y)', () => {
    const left = laneArrowGlyph(['left']);
    const right = laneArrowGlyph(['right']);
    const mirror = (p: { x: number; y: number }) => ({ x: p.x, y: p.y === 0 ? 0 : -p.y });
    expect(left.strokes.map((s) => s.map(mirror))).toEqual(right.strokes);
    expect(left.heads.map((h) => h.map(mirror))).toEqual(right.heads);
    // And the left bend is on the left (negative lateral) side.
    for (const head of left.heads) {
      for (const p of head) expect(p.y).toBeLessThanOrEqual(-ALMOST);
    }
  });

  it('rejects empty designations loudly', () => {
    expect(() => laneArrowGlyph([])).toThrow();
  });

  it('arrowGlyphToWorld maps local +x onto the travel heading and (0,0) onto the origin', () => {
    const glyph = laneArrowGlyph(['through']);
    const origin = { x: 10, y: -4 };
    const u = { x: 0, y: 1 };
    const r = { x: -1, y: 0 };
    const world = arrowGlyphToWorld(glyph, origin, u, r);
    const shaft = world.strokes[0];
    expect(shaft).toBeDefined();
    if (shaft !== undefined) {
      // Shaft starts at local (0.3, 0) and ends at (4.0, 0).
      expect(shaft[0]).toEqual({ x: origin.x + u.x * 0.3, y: origin.y + u.y * 0.3 });
      const tip = shaft[shaft.length - 1];
      if (tip !== undefined) expect(tip).toEqual({ x: origin.x + u.x * 4, y: origin.y + u.y * 4 });
    }
  });
});

// --- markings -------------------------------------------------------------------

describe('buildMarkings + expandDashes', () => {
  const geometry = buildIntersectionGeometry(getPreset('balanced').config);
  const markings = buildMarkings(geometry);

  it('expands dashes deterministically: 3 m on, 6 m off, phase-aligned at t0', () => {
    expect(expandDashes(0, 20)).toEqual([0, 9, 18].filter((s) => s + 3 <= 20));
    expect(expandDashes(5, 26)).toEqual([5, 14, 23]);
  });

  it('produces the full marking set for the balanced preset (2 lanes/arm)', () => {
    expect(markings.roadPolygons).toHaveLength(5); // 4 arms + box
    expect(markings.edgeLines).toHaveLength(8); // 2 per arm
    expect(markings.centerLines).toHaveLength(8); // double yellow, 2 per arm
    expect(markings.stopBars).toHaveLength(8); // one per approach lane
    expect(markings.laneDividers.length).toBeGreaterThan(0); // 1 divider line/arm, dashed
  });

  it('stop bars match the F3 stop-line segments of approach lanes', () => {
    const expected = geometry.lanePolygons
      .filter((lane) => lane.side === 'approach' && lane.stopLineSegment !== undefined)
      .map((lane) => lane.stopLineSegment?.map((p) => ({ ...p })));
    expect(markings.stopBars).toEqual(expected);
  });
});

// --- frame structure: the rendered-inspection proxy ------------------------------

function carCommands(commands: readonly DrawCommand[]) {
  return commands.filter((c) => c.kind === 'fillRotRoundRect');
}

describe('draw-list frame: signal preset (balanced)', () => {
  const { world, control, renderer } = pipeline(getPreset('balanced').config, 600); // 60 s
  const alpha = 0.5;
  const scene = renderer.buildScene(world, control, alpha);
  const commands = renderer.buildFrame(scene);

  it('has cars on the road by 60 s', () => {
    expect(world.store.count).toBeGreaterThan(0);
    expect(scene.cars).toHaveLength(world.store.count);
  });

  it('draws layers in order: background → road → markings → control → cars → hud', () => {
    let last = -1;
    for (const command of commands) {
      const rank = layerRank(command.layer);
      expect(rank).toBeGreaterThanOrEqual(last);
      last = rank;
    }
  });

  it('draws the road before any car (road painted under cars)', () => {
    let lastRoad = -1;
    let firstCar = Number.POSITIVE_INFINITY;
    commands.forEach((command, index) => {
      if (command.layer === 'road') lastRoad = Math.max(lastRoad, index);
      if (command.layer === 'cars') firstCar = Math.min(firstCar, index);
    });
    expect(lastRoad).toBeGreaterThanOrEqual(0);
    expect(firstCar).toBeLessThan(commands.length);
    expect(lastRoad).toBeLessThan(firstCar);
  });

  it('emits exactly one oriented body per live car, at the interpolated pose', () => {
    const bodies = carCommands(commands);
    expect(bodies).toHaveLength(world.store.count);
    const sceneCars = scene.cars;
    bodies.forEach((command, i) => {
      if (command.kind !== 'fillRotRoundRect') return;
      const car = sceneCars[i];
      expect(car).toBeDefined();
      if (car === undefined) return;
      const expected = worldToCanvas({ x: car.x, y: car.y });
      expect(command.x).toBeCloseTo(expected.x, 6);
      expect(command.y).toBeCloseTo(expected.y, 6);
      expect(command.angle).toBeCloseTo(Math.atan2(car.hy, car.hx), 6);
      expect(command.lengthPx).toBeCloseTo(car.lengthMeters * PX_PER_METER, 6);
      expect(command.widthPx).toBeCloseTo(CAR_WIDTH_METERS * PX_PER_METER, 6);
      expect(Object.values(CAR_BEHAVIOR_COLORS)).toContain(command.color);
    });
  });

  it('interpolates: alpha = 0 and alpha = 1 match the prev/curr tick poses', () => {
    const scene0 = renderer.buildScene(world, control, 0);
    const scene1 = renderer.buildScene(world, control, 1);
    const store = world.store;
    scene0.cars.forEach((car, i) => {
      const pose = world.carPose(i, 0);
      expect(car.x).toBeCloseTo(pose.x - pose.hx * car.lengthMeters / 2, 9);
    });
    scene1.cars.forEach((car, i) => {
      const pose = world.carPose(i, 1);
      expect(car.x).toBeCloseTo(pose.x - pose.hx * car.lengthMeters / 2, 9);
    });
    expect(scene0.cars).toHaveLength(store.count);
  });

  it('signal-head lamps reflect the controller indication at the render tick', () => {
    expect(scene.indications).not.toBeNull();
    const indications = scene.indications;
    if (indications === null) return;
    // Expected lamp multiset, derived independently from movement geometry:
    // per approach lane, one arrow lamp if it serves left, one ball lamp otherwise.
    const expected: string[] = [];
    const layout = renderer.geometry.layout;
    for (const armId of Object.keys(layout.arms) as (keyof typeof layout.arms)[]) {
      const arm = layout.arms[armId];
      const lanes = renderer.config.arms[armId].lanes;
      for (let laneIndex = 0; laneIndex < arm.laneCount; laneIndex += 1) {
        const designations = lanes[laneIndex]?.designations ?? [];
        if (designations.includes('left')) {
          const m = renderer.geometry.movements.findIndex(
            (movement) => movement.arm === armId && movement.laneIndex === laneIndex && movement.turn === 'left',
          );
          if (m >= 0) expected.push(SIGNAL_LAMP_COLORS[indications[m] as SignalColor]);
        }
        const ballIdx = renderer.geometry.movements.findIndex(
          (movement) =>
            movement.arm === armId && movement.laneIndex === laneIndex && movement.turn !== 'left',
        );
        if (ballIdx >= 0) expected.push(SIGNAL_LAMP_COLORS[indications[ballIdx] as SignalColor]);
      }
    }
    const lampCommands = commands.filter(
      (command) =>
        command.layer === 'control' &&
        (command.kind === 'fillCircle' ||
          (command.kind === 'fillPolygon' && command.points.length === 3)),
    );
    const actual = lampCommands.map((command) =>
      command.kind === 'fillCircle' ? command.color : command.color,
    );
    expect(actual.length).toBe(expected.length);
    for (const color of ['green', 'yellow', 'red'] as const) {
      const hex = SIGNAL_LAMP_COLORS[color];
      expect(actual.filter((c) => c === hex).length).toBe(expected.filter((c) => c === hex).length);
    }
  });

  it('shows no stop-sign octagons in signal mode', () => {
    const controlLayer = commands.filter((c) => c.layer === 'control');
    // Octagon = fillPolygon with 8 points.
    expect(controlLayer.filter((c) => c.kind === 'fillPolygon' && c.points.length === 8)).toHaveLength(0);
  });

  it('is deterministic: two builds from the same state are identical', () => {
    const again = renderer.buildFrame(renderer.buildScene(world, control, alpha));
    expect(again).toEqual(commands);
  });

  it('keeps every emitted point inside the 1280×720 logical canvas', () => {
    for (const command of commands) {
      if (command.kind === 'fillPolygon' || command.kind === 'strokePolyline') {
        for (const p of command.points) {
          expect(p.x).toBeGreaterThanOrEqual(0);
          expect(p.x).toBeLessThanOrEqual(1280);
          expect(p.y).toBeGreaterThanOrEqual(0);
          expect(p.y).toBeLessThanOrEqual(720);
        }
      } else if (command.kind === 'fillRotRoundRect') {
        const halfLen = Math.max(command.lengthPx, command.widthPx) / 2 + 2;
        expect(command.x).toBeGreaterThan(-halfLen);
        expect(command.x).toBeLessThan(1280 + halfLen);
        expect(command.y).toBeGreaterThan(-halfLen);
        expect(command.y).toBeLessThan(720 + halfLen);
      }
    }
  });
});

describe('draw-list frame: all-way-stop preset', () => {
  const { world, control, renderer } = pipeline(allWayStopConfig(), 300); // 30 s
  const scene = renderer.buildScene(world, control, 0.5);
  const commands = renderer.buildFrame(scene);

  it('draws exactly four stop-sign octagons (one per arm) and no signal lamps', () => {
    const controlLayer = commands.filter((c) => c.layer === 'control');
    const octagons = controlLayer.filter(
      (c) => c.kind === 'fillPolygon' && c.points.length === 8,
    );
    expect(octagons).toHaveLength(4);
    expect(controlLayer.filter((c) => c.kind === 'fillCircle')).toHaveLength(0);
    expect(scene.indications).toBeNull();
    expect(scene.controlType).toBe('all-way-stop');
  });

  it('has live cars drawn with behavior colors', () => {
    expect(world.store.count).toBeGreaterThan(0);
    const bodies = carCommands(commands);
    expect(bodies).toHaveLength(world.store.count);
    const palette = Object.values(CAR_BEHAVIOR_COLORS);
    for (const body of bodies) {
      if (body.kind === 'fillRotRoundRect') expect(palette).toContain(body.color);
    }
  });

  it('stop signs sit on the right shoulder outside the road edge of their arm', () => {
    const layout = renderer.geometry.layout;
    const octagons = commands.filter(
      (c) => c.kind === 'fillPolygon' && c.layer === 'control' && c.points.length === 8,
    );
    expect(octagons).toHaveLength(4);
    for (const sign of octagons) {
      if (sign.kind !== 'fillPolygon') continue;
      const cx = sign.points.reduce((s, p) => s + p.x, 0) / sign.points.length;
      const cy = sign.points.reduce((s, p) => s + p.y, 0) / sign.points.length;
      // World position back from canvas px.
      const wx = (cx - 640) / PX_PER_METER;
      const wy = (cy - 360) / PX_PER_METER;
      // Distance from the intersection center along one axis ≈ stop-line distance.
      const alongAxis = Math.max(Math.abs(wx), Math.abs(wy));
      const lateral = Math.min(Math.abs(wx), Math.abs(wy));
      const minLateral = Math.min(
        ...Object.values(layout.arms).map((arm) => arm.laneCount * layout.laneWidthMeters + 2),
      );
      expect(lateral).toBeGreaterThan(minLateral - 1);
      expect(alongAxis).toBeGreaterThan(5);
      expect(alongAxis).toBeLessThan(30);
    }
  });
});

describe('scene behavior states appear in real runs (signal preset)', () => {
  it('produces at least one non-cruise car over a red phase (queue or yielding)', () => {
    // 21 s NS green first: by tick 60 (6 s into EW waiting) queues exist.
    const { world, control, renderer } = pipeline(getPreset('balanced').config, 260);
    const scene = renderer.buildScene(world, control, 0.5);
    const behaviors = new Set(scene.cars.map((car) => car.behavior));
    expect(scene.cars.length).toBeGreaterThan(0);
    expect(behaviors.size).toBeGreaterThan(1);
  });

  it('marks in-box cars as in-intersection exactly when their phase is in-box', () => {
    const { world, control, renderer } = pipeline(getPreset('balanced').config, 600);
    const scene = renderer.buildScene(world, control, 0.5);
    scene.cars.forEach((car) => {
      const record = control.claims.recordOf(car.entityId);
      const expected = record?.phase === 'in-box';
      if (expected) expect(car.behavior).toBe('in-intersection');
    });
    // And the classification is a pure read: rebuilding gives the same result.
    expect(renderer.buildScene(world, control, 0.5)).toEqual(scene);
  });
});

// --- turn-signal lamps (delight pass: the world declares its intentions) -------

describe('classifyTurnSignal (pure path-window derivation)', () => {
  it('through cars never signal', () => {
    expect(classifyTurnSignal('through', 50, 40, 55)).toBeNull();
  });

  it('left cars signal from the lead distance through the end of the turn', () => {
    expect(classifyTurnSignal('left', 40, 40, 55)).toBe('left'); // at the stop line
    expect(classifyTurnSignal('left', 40 - TURN_SIGNAL_LEAD_METERS, 40, 55)).toBe('left'); // window opens
    expect(classifyTurnSignal('left', 40 - TURN_SIGNAL_LEAD_METERS - 0.01, 40, 55)).toBeNull(); // too far
    expect(classifyTurnSignal('left', 55, 40, 55)).toBe('left'); // curve end, still turning
    expect(classifyTurnSignal('left', 55.01, 40, 55)).toBeNull(); // straightened out — blinker off
  });

  it('right cars signal on the same window', () => {
    expect(classifyTurnSignal('right', 30, 40, 50)).toBe('right');
  });
});

describe('turnSignalLit (deterministic 1 Hz sim-time cadence)', () => {
  it('is lit the first half of each sim second, dark the second', () => {
    expect(turnSignalLit(0)).toBe(true);
    expect(turnSignalLit(0.4999)).toBe(true);
    expect(turnSignalLit(0.5)).toBe(false);
    expect(turnSignalLit(0.9)).toBe(false);
    expect(turnSignalLit(1.0)).toBe(true); // wraps
  });
});

describe('draw-list frame: turn-signal lamps', () => {
  // Heavy demand + turn mix ⇒ turning cars inside the signal window.
  const { world, control, renderer } = pipeline(getPreset('gridlock-risk').config, 900); // 90 s
  const scene = renderer.buildScene(world, control, 0.5);
  const signalers = scene.cars.filter((car) => car.turnSignal !== null);

  function lampSquares(frame: ReturnType<WorldRenderer['buildFrame']>, color: string) {
    return frame.filter(
      (command): command is Extract<DrawCommand, { kind: 'fillPolygon' }> =>
        command.kind === 'fillPolygon' && command.layer === 'cars' && command.color === color,
    );
  }

  it('real runs have turning cars inside the signal window', () => {
    expect(signalers.length).toBeGreaterThan(0);
    expect(signalers.every((car) => car.turnSignal === 'left' || car.turnSignal === 'right')).toBe(true);
  });

  it('emits one dark housing per signaling corner; lamps light only on the lit half-cycle', () => {
    const lit = turnSignalLit(scene.timeSeconds);
    const frame = renderer.buildFrame(scene);
    const housings = lampSquares(frame, CAR_STROKE_COLOR);
    const lamps = lampSquares(frame, TURN_SIGNAL_LAMP_COLOR);
    // Two corners (front + rear) per signaling car, dark housings always.
    expect(housings.length).toBe(2 * signalers.length);
    expect(lamps.length).toBe(lit ? 2 * signalers.length : 0);
  });

  it('a left turner blinks on its left side (the geometry driver-side convention)', () => {
    const frame = renderer.buildFrame(scene);
    const housings = lampSquares(frame, CAR_STROKE_COLOR);
    // Housings are emitted per car in scene order: pairs [rear, front].
    let leftChecked = 0;
    let rightChecked = 0;
    signalers.forEach((car, k) => {
      const center = worldToCanvas({ x: car.x, y: car.y });
      for (const housing of [housings[2 * k], housings[2 * k + 1]]) {
        if (housing === undefined) throw new Error('housing missing');
        const centroid = housing.points.reduce((acc, p) => ({ x: acc.x + p.x / 4, y: acc.y + p.y / 4 }), { x: 0, y: 0 });
        // Driver-left of heading (hy, -hx) — same relation the geometry's
        // leftOf uses; canvas shares the world's orientation (uniform scale).
        const lateral = (centroid.x - center.x) * car.hy - (centroid.y - center.y) * car.hx;
        if (car.turnSignal === 'left') {
          expect(lateral).toBeGreaterThan(0);
          leftChecked += 1;
        } else {
          expect(lateral).toBeLessThan(0);
          rightChecked += 1;
        }
      }
    });
    expect(leftChecked + rightChecked).toBe(2 * signalers.length);
  });

  it('the blink is a pure function of sim time (determinism, pause honesty)', () => {
    const now = renderer.buildFrame(scene);
    expect(renderer.buildFrame(scene)).toEqual(now); // same time ⇒ same frame
    // Half a sim second later the lamps toggle, housings do not.
    const later = renderer.buildFrame({ ...scene, timeSeconds: scene.timeSeconds + 0.5 });
    const lampsBefore = lampSquares(now, TURN_SIGNAL_LAMP_COLOR).length;
    const lampsAfter = lampSquares(later, TURN_SIGNAL_LAMP_COLOR).length;
    expect(lampsAfter).not.toBe(lampsBefore);
    expect(lampSquares(later, CAR_STROKE_COLOR).length).toBe(lampSquares(now, CAR_STROKE_COLOR).length);
  });
});
