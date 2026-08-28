import { describe, expect, it } from 'vitest';
import type { IntersectionConfig, LaneConfig } from '../config';
import { ARM_IDS } from '../config';
import { createDefaultConfig } from '../config/defaults';
import { getPreset } from '../presets/presets';
import type { PresetId } from '../presets/presets';
import {
  buildIntersectionGeometry,
  fitsLogicalCanvas,
  geometryCanvasBounds,
  getMovement,
  worldToCanvas,
} from './geometry';
import { findNonFinite, stableStringify } from './serialize';

const SHARED: LaneConfig = { designations: ['left', 'through', 'right'] };
const THREE_LANE: LaneConfig[] = [
  { designations: ['left'] },
  { designations: ['through'] },
  { designations: ['through', 'right'] },
];

function presetConfig(id: PresetId): IntersectionConfig {
  return structuredClone(getPreset(id).config);
}

function withLanes(lanes: readonly LaneConfig[]): IntersectionConfig {
  const base = createDefaultConfig();
  const arm = { ...base.arms.north, lanes };
  return { ...base, arms: { north: arm, east: arm, south: arm, west: arm } };
}

describe('determinism: same config ⇒ identical stable serialization', () => {
  for (const id of ['light', 'balanced', 'gridlock-risk'] as const) {
    it(`preset '${id}' serializes identically across independent builds`, () => {
      const first = buildIntersectionGeometry(presetConfig(id));
      const second = buildIntersectionGeometry(structuredClone(presetConfig(id)));
      expect(stableStringify(first)).toBe(stableStringify(second));
    });
  }

  it('is invariant to config key insertion order', () => {
    const config = presetConfig('balanced');
    const reversed = reverseKeys(structuredClone(config));
    expect(stableStringify(buildIntersectionGeometry(config))).toBe(
      stableStringify(buildIntersectionGeometry(reversed)),
    );
  });

  it('is invariant to the control type (geometry depends only on arms/params)', () => {
    const signal = presetConfig('light');
    const stop: IntersectionConfig = { ...structuredClone(signal), control: { type: 'all-way-stop' } };
    expect(stableStringify(buildIntersectionGeometry(signal))).toBe(
      stableStringify(buildIntersectionGeometry(stop)),
    );
  });

  it('stableStringify sorts keys and normalizes -0', () => {
    expect(stableStringify({ b: 1, a: [2, { z: -0, y: 3 }] })).toBe('{"a":[2,{"y":3,"z":0}],"b":1}');
    expect(() => stableStringify({ x: Number.NaN })).toThrow();
    expect(() => stableStringify({ x: Infinity })).toThrow();
  });
});

describe('finiteness (R2: no NaN/±Infinity may reach the run-hash world)', () => {
  it('every number in every preset geometry is finite', () => {
    for (const id of ['light', 'balanced', 'gridlock-risk'] as const) {
      expect(findNonFinite(buildIntersectionGeometry(presetConfig(id))), id).toEqual([]);
    }
  });

  it('combo and lane-shape configs are finite too', () => {
    for (const config of [
      createDefaultConfig(),
      withLanes([SHARED]),
      withLanes(THREE_LANE),
      withLanes([{ designations: ['right'] }]),
      withLanes([{ designations: ['left', 'through'] }, { designations: ['through'] }]),
    ]) {
      expect(findNonFinite(buildIntersectionGeometry(config))).toEqual([]);
    }
  });
});

describe('canvas fit (acceptance: geometry fits 1280×720)', () => {
  it('maps the world center to the canvas center', () => {
    expect(worldToCanvas({ x: 0, y: 0 })).toEqual({ x: 640, y: 360 });
  });

  it('all presets fit with visible margins', () => {
    for (const id of ['light', 'balanced', 'gridlock-risk'] as const) {
      const bounds = geometryCanvasBounds(buildIntersectionGeometry(presetConfig(id)));
      expect(bounds.minX, id).toBeGreaterThanOrEqual(0);
      expect(bounds.minY, id).toBeGreaterThanOrEqual(0);
      expect(bounds.maxX, id).toBeLessThanOrEqual(1280);
      expect(bounds.maxY, id).toBeLessThanOrEqual(720);
      expect(fitsLogicalCanvas(buildIntersectionGeometry(presetConfig(id)))).toBe(true);
    }
  });

  it('fits at 3 lanes (widest roads) and the road is clearly visible', () => {
    const geom = buildIntersectionGeometry(withLanes(THREE_LANE));
    expect(fitsLogicalCanvas(geom)).toBe(true);
    const bounds = geometryCanvasBounds(geom);
    // Vertical extent ≈ 2 × 120 m × 2.9 px/m = 696 px — big but inside 720.
    expect(bounds.maxY - bounds.minY).toBeGreaterThan(600);
    expect(bounds.maxY - bounds.minY).toBeLessThanOrEqual(720);
    // A lane reads as ~10 px (3.5 m × 2.9 px/m).
    const lane = geom.lanePolygons.find((p) => p.arm === 'north' && p.side === 'approach')!;
    const [a, b] = lane.polygon;
    const aPx = worldToCanvas(a!);
    const bPx = worldToCanvas(b!);
    expect(Math.hypot(aPx.x - bPx.x, aPx.y - bPx.y)).toBeGreaterThan(8);
  });
});

describe('facade completeness', () => {
  it('getMovement resolves every designation and rejects non-designated combos', () => {
    const geom = buildIntersectionGeometry(presetConfig('balanced'));
    expect(getMovement(geom, 'north', 0, 'left')).toBeDefined();
    expect(getMovement(geom, 'north', 1, 'through')).toBeDefined();
    expect(getMovement(geom, 'north', 1, 'right')).toBeDefined();
    expect(getMovement(geom, 'north', 1, 'left')).toBeUndefined(); // lane 1 has no left
    expect(getMovement(geom, 'north', 2, 'through')).toBeUndefined(); // only 2 lanes
  });

  it('exposes stop lines, lane polygons and warnings', () => {
    const geom = buildIntersectionGeometry(presetConfig('balanced'));
    expect(geom.movements).toHaveLength(12);
    expect(geom.lanePolygons).toHaveLength(16);
    const approach = geom.lanePolygons.filter((p) => p.side === 'approach');
    for (const lane of approach) expect(lane.stopLineSegment).toBeDefined();
    expect(geom.conflictZones.length).toBeGreaterThan(0);
    expect(geom.warnings).toEqual([]); // presets are constraint-clean
  });

  it('movement ids cover every (arm, lane, designation) exactly once', () => {
    for (const id of ['light', 'balanced', 'gridlock-risk'] as const) {
      const config = presetConfig(id);
      const geom = buildIntersectionGeometry(config);
      const expected: string[] = [];
      for (const armId of ARM_IDS) {
        config.arms[armId].lanes.forEach((lane, laneIndex) => {
          for (const turn of lane.designations) expected.push(`${armId}:${laneIndex}:${turn}`);
        });
      }
      expect(geom.movements.map((m) => m.id).sort()).toEqual([...expected].sort());
    }
  });
});

describe('warnings for constraint-violating configs (never throws)', () => {
  it('flags short approaches when cruise speed is raised', () => {
    const config = presetConfig('balanced');
    const arms = {
      north: { ...config.arms.north, cruiseSpeedMps: 25 },
      east: { ...config.arms.east, cruiseSpeedMps: 25 },
      south: { ...config.arms.south, cruiseSpeedMps: 25 },
      west: { ...config.arms.west, cruiseSpeedMps: 25 },
    };
    const warnings = buildIntersectionGeometry({ ...config, arms }).warnings;
    expect(warnings.some((w) => w.kind === 'approach-storage')).toBe(true);
    expect(warnings.filter((w) => w.kind === 'approach-storage')).toHaveLength(4);
  });

  it('keeps default and preset configs warning-free', () => {
    expect(buildIntersectionGeometry(createDefaultConfig()).warnings).toEqual([]);
    for (const id of ['light', 'balanced', 'gridlock-risk'] as const) {
      expect(buildIntersectionGeometry(presetConfig(id)).warnings).toEqual([]);
    }
  });
});

/** Deep-copy with every object's keys inserted in reverse order. */
function reverseKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reverseKeys) as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).reverse()) {
      out[key] = reverseKeys((value as Record<string, unknown>)[key]);
    }
    return out as T;
  }
  return value;
}
