import { describe, expect, it } from 'vitest';
import type { IntersectionConfig, LaneConfig } from '../config';
import { createDefaultConfig } from '../config/defaults';
import { getPreset } from '../presets/presets';
import type { PresetId } from '../presets/presets';
import { buildIntersectionGeometry } from './geometry';
import type { IntersectionGeometry } from './geometry';
import { sampleAtS } from './curve';
import { findMovement } from './paths';
import type { MovementGeometry } from './paths';

function presetGeometry(id: PresetId): IntersectionGeometry {
  return buildIntersectionGeometry(structuredClone(getPreset(id).config));
}

function withLanes(lanes: readonly LaneConfig[]): IntersectionConfig {
  const base = createDefaultConfig();
  const arm = { ...base.arms.north, lanes, turnMix: { left: 0.25, through: 0.5, right: 0.25 } };
  return { ...base, arms: { north: arm, east: base.arms.north, south: base.arms.north, west: base.arms.north } };
}

function movement(geom: IntersectionGeometry, arm: string, lane: number, turn: string): MovementGeometry {
  const found = findMovement(geom.movements, arm as never, lane, turn as never);
  if (!found) throw new Error(`missing movement ${arm}:${lane}:${turn}`);
  return found;
}

function zoneBetween(geom: IntersectionGeometry, aId: string, bId: string) {
  const a = movement(geom, ...splitId(aId));
  return a.conflictZones.find((z) => z.otherMovementId === bId);
}

function splitId(id: string): [string, number, string] {
  const [arm, lane, turn] = id.split(':');
  return [arm!, Number(lane), turn!];
}

describe('crossing conflicts (R1 §4.1)', () => {
  it('cross-axis through movements conflict, with the zone bracketing the crossing point', () => {
    const geom = presetGeometry('balanced');
    const zone = zoneBetween(geom, 'north:1:through', 'east:1:through');
    expect(zone).toBeDefined();
    const through = movement(geom, 'north', 1, 'through');
    // Paths cross at (−5.25, −5.25) → s = 120 − 5.25 = 114.75 on the north path.
    let crossingS = Infinity;
    for (const sample of through.samples) {
      if (Math.hypot(sample.x + 5.25, sample.y + 5.25) < 0.5) crossingS = sample.s;
    }
    expect(crossingS).toBeLessThan(Infinity);
    expect(zone!.sEnter).toBeLessThan(crossingS);
    expect(zone!.sExit).toBeGreaterThan(crossingS);
    // Symmetric attachment: the zone appears on the east movement too.
    const east = movement(geom, 'east', 1, 'through');
    expect(east.conflictZones.some((z) => z.otherMovementId === 'north:1:through')).toBe(true);
  });

  it('opposing left conflicts with oncoming through (R1: through paths conflict with opposing-left)', () => {
    const geom = presetGeometry('balanced');
    expect(zoneBetween(geom, 'north:0:left', 'south:1:through')).toBeDefined();
    expect(zoneBetween(geom, 'south:0:left', 'north:1:through')).toBeDefined();
  });

  it('protected opposing lefts do NOT conflict with each other (they pass left-to-left)', () => {
    const geom = presetGeometry('balanced');
    expect(zoneBetween(geom, 'north:0:left', 'south:0:left')).toBeUndefined();
  });

  it('every through movement of every preset has at least one conflict zone', () => {
    for (const id of ['light', 'balanced', 'gridlock-risk'] as const) {
      const geom = presetGeometry(id);
      for (const m of geom.movements) {
        if (m.turn === 'through') {
          expect(m.conflictZones.length, `${m.id} (${id})`).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe('exclusions (R1 §4.1: same-arm/diagonal non-conflicting pairs yield empty sets)', () => {
  it('same-lane movements (shared lane) never conflict — car-following owns the divergence', () => {
    const geom = presetGeometry('light'); // single shared lane per arm
    for (const m of geom.movements) {
      for (const z of m.conflictZones) {
        const [otherArm, otherLane] = splitId(z.otherMovementId);
        expect(`${otherArm}:${otherLane}`, `${m.id} vs ${z.otherMovementId}`).not.toBe(`${m.arm}:${m.laneIndex}`);
      }
    }
  });

  it('same-arm, different-lane movements without shared exits never conflict', () => {
    const geom = presetGeometry('balanced');
    expect(zoneBetween(geom, 'north:0:left', 'north:1:through')).toBeUndefined();
    expect(zoneBetween(geom, 'north:0:left', 'north:1:right')).toBeUndefined();
    expect(zoneBetween(geom, 'north:1:through', 'north:1:right')).toBeUndefined();
  });
});

describe('merge conflicts (R1 §4.1: merge zones cover shared exit lanes)', () => {
  it('right turns merge with the cross-arm movements feeding the same exit lane', () => {
    const geom = presetGeometry('balanced');
    // north:1:right and east:1:through both feed west-arm exit lane 1 (y = −5.25).
    expect(zoneBetween(geom, 'north:1:right', 'east:1:through')).toBeDefined();
    // north:1:through and west:1:right both feed south-arm exit lane 1 (x = −5.25).
    expect(zoneBetween(geom, 'north:1:through', 'west:1:right')).toBeDefined();
  });

  it('clamped lane counts (3-lane arm into 1-lane exit) produce merge zones between through lanes', () => {
    const config = withLanes([{ designations: ['through'] }, { designations: ['through'] }, { designations: ['through', 'right'] }]);
    const geom = buildIntersectionGeometry(config);
    // All three north through movements clamp to exit lane 0 of the 1-lane arms.
    expect(zoneBetween(geom, 'north:0:through', 'north:1:through')).toBeDefined();
    expect(zoneBetween(geom, 'north:0:through', 'north:2:through')).toBeDefined();
    expect(zoneBetween(geom, 'north:1:through', 'north:2:through')).toBeDefined();
    // Merge zones sit past the stop line (inside the box / on the exit).
    const zone = zoneBetween(geom, 'north:0:through', 'north:2:through')!;
    expect(zone.sEnter).toBeGreaterThan(movement(geom, 'north', 0, 'through').stopLineS);
  });
});

describe('zone structure and conservatism', () => {
  it('zones have valid s-intervals within path bounds, sorted per movement, unique ids', () => {
    const geom = presetGeometry('balanced');
    const ids = new Set<string>();
    for (const zone of geom.conflictZones) {
      ids.add(zone.id);
      expect(zone.movements).toHaveLength(2);
      expect(zone.movements[0].movementId).not.toBe(zone.movements[1].movementId);
      for (const interval of zone.movements) {
        const m = movement(geom, ...splitId(interval.movementId));
        expect(interval.sEnter).toBeGreaterThanOrEqual(0);
        expect(interval.sExit).toBeLessThanOrEqual(m.lengthMeters);
        expect(interval.sEnter).toBeLessThan(interval.sExit);
      }
      expect(zone.polygon.length).toBeGreaterThanOrEqual(3);
      for (const corner of zone.polygon) {
        expect(Number.isFinite(corner.x)).toBe(true);
        expect(Number.isFinite(corner.y)).toBe(true);
      }
    }
    expect(ids.size).toBe(geom.conflictZones.length);
    for (const m of geom.movements) {
      let prevEnter = -Infinity;
      for (const z of m.conflictZones) {
        expect(z.sEnter).toBeGreaterThanOrEqual(prevEnter);
        prevEnter = z.sEnter;
        expect(ids.has(z.zoneId)).toBe(true);
      }
    }
  });

  it('zone polygons cover the conflicting path samples (conservative superset)', () => {
    const geom = presetGeometry('balanced');
    const zone = geom.conflictZones.find(
      (z) => z.movements[0].movementId === 'north:1:through' && z.movements[1].movementId === 'east:1:through',
    );
    expect(zone).toBeDefined();
    const through = movement(geom, 'north', 1, 'through');
    // Every path sample inside the zone's s-interval lies inside (or on) the polygon.
    for (const sample of through.samples) {
      if (sample.s >= zone!.movements[0].sEnter && sample.s <= zone!.movements[0].sExit) {
        expect(pointInPolygon(sample.x, sample.y, zone!.polygon)).toBe(true);
      }
    }
    // The crossing point itself is covered.
    expect(pointInPolygon(-5.25, -5.25, zone!.polygon)).toBe(true);
  });

  it('zones keep opposing same-axis through paths apart (parallel lanes never conflict)', () => {
    const geom = presetGeometry('balanced');
    expect(zoneBetween(geom, 'north:1:through', 'south:1:through')).toBeUndefined();
    expect(zoneBetween(geom, 'east:1:through', 'west:1:through')).toBeUndefined();
  });
});

function pointInPolygon(x: number, y: number, polygon: readonly { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

describe('zone access for claim arbitration (F5 contract)', () => {
  it('exposes zone boundaries usable as virtual-leader positions via sampleAtS', () => {
    const geom = presetGeometry('balanced');
    const through = movement(geom, 'north', 1, 'through');
    for (const z of through.conflictZones) {
      const entry = sampleAtS(through.samples, z.sEnter);
      expect(Number.isFinite(entry.x)).toBe(true);
      const exit = sampleAtS(through.samples, z.sExit);
      expect(exit.s).toBeCloseTo(z.sExit, 9);
      // Rear-bumper clearance arithmetic: s ≥ sExit + len + margin is derivable.
      expect(z.sExit + 5.0 + 1).toBeGreaterThan(z.sEnter);
    }
  });
});
