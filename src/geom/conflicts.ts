/**
 * Intersection conflict zones (task F3), implementing research R1 §4.1:
 * for each movement pair, the footprint-padded crossing/merging regions
 * along both paths — a conservative superset of true geometric overlap.
 * These are the exact zones the F5 claim system arbitrates (exclusivity,
 * virtual leaders at zone boundaries, rear-bumper clearance).
 *
 * Footprint model: a car is its bounding capsule — a center segment of
 * length (len − width) along the heading, swept by radius width/2. Two
 * footprints overlap iff the center segments come within `carWidth`. Paths
 * are scanned at 0.5 m; the conflict threshold pads by the scan step, so
 * sub-sample car positions are covered conservatively.
 *
 * Same-(arm, lane) movement pairs are excluded (R1: same-arm divergence is
 * handled by car-following on the shared approach lane); same-arm pairs on
 * different lanes are computed — merge zones from shared exit lanes appear
 * there (R1: "merge zones cover shared exit lanes").
 */
import {
  CAR_WIDTH_METERS,
  CONFLICT_SAMPLE_STRIDE,
  CONFLICT_SEARCH_BACK_METERS,
  EXIT_MERGE_SPAN_METERS,
  PATH_SAMPLE_STEP_METERS,
  ZONE_POLYGON_PAD_METERS,
  ZONE_RUN_MERGE_GAP_METERS,
} from './constants';
import { segmentDistance } from './curve';
import type { PathSample } from './curve';
import type { MovementConflictZone, MovementId } from './paths';
import { itemAt, vadd, vscale, vlen, vsub } from './vec';
import type { Vec2 } from './vec';

/** The subset of MovementGeometry the conflict computation reads. */
export interface ConflictPathInput {
  readonly id: MovementId;
  readonly arm: string;
  readonly laneIndex: number;
  readonly samples: readonly PathSample[];
  readonly stopLineS: number;
  readonly curveEndS: number;
  readonly lengthMeters: number;
}

export interface ZoneInterval {
  readonly movementId: MovementId;
  readonly sEnter: number;
  readonly sExit: number;
}

export interface ConflictZone {
  readonly id: string;
  /** The two movements sharing the zone, in canonical movement order. */
  readonly movements: readonly [ZoneInterval, ZoneInterval];
  /** Conservative world-space polygon (convex hull of the overlap, padded). */
  readonly polygon: readonly Vec2[];
}

export interface ConflictComputation {
  readonly zones: readonly ConflictZone[];
  /** Per movement: zones on that movement, sorted by sEnter then zone id. */
  readonly perMovement: ReadonlyMap<MovementId, readonly MovementConflictZone[]>;
}

interface ScanWindow {
  readonly samples: readonly PathSample[];
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

const CONFLICT_STEP = PATH_SAMPLE_STEP_METERS * CONFLICT_SAMPLE_STRIDE;

function scanWindow(movement: ConflictPathInput, carLengthMeters: number): ScanWindow {
  const sLo = Math.max(0, movement.stopLineS - CONFLICT_SEARCH_BACK_METERS - carLengthMeters);
  const sHi = Math.min(movement.lengthMeters, movement.curveEndS + EXIT_MERGE_SPAN_METERS + carLengthMeters);
  const samples: PathSample[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < movement.samples.length; i += CONFLICT_SAMPLE_STRIDE) {
    const sample = itemAt(movement.samples, i);
    if (sample.s < sLo || sample.s > sHi) continue;
    samples.push(sample);
    if (sample.x < minX) minX = sample.x;
    if (sample.y < minY) minY = sample.y;
    if (sample.x > maxX) maxX = sample.x;
    if (sample.y > maxY) maxY = sample.y;
  }
  return { samples, minX, minY, maxX, maxY };
}

export function computeConflictZones(
  movements: readonly ConflictPathInput[],
  carLengthMeters: number,
): ConflictComputation {
  const halfLen = Math.max(0, (carLengthMeters - CAR_WIDTH_METERS) / 2);
  const threshold = CAR_WIDTH_METERS + CONFLICT_STEP;
  const rejectDx = threshold + 2 * halfLen;
  const windows = movements.map((movement) => scanWindow(movement, carLengthMeters));
  // Conservative AABB expansion: capsule ⊆ disk(sample, halfLen); two disks
  // closer than `threshold` require centers within 2·(halfLen + threshold).
  const aabbPad = halfLen + threshold;

  interface PendingZone {
    readonly a: ZoneInterval;
    readonly b: ZoneInterval;
    readonly points: readonly Vec2[];
  }
  const pending: PendingZone[] = [];

  for (let i = 0; i < movements.length; i += 1) {
    const a = itemAt(movements, i);
    const wa = itemAt(windows, i);
    for (let j = i + 1; j < movements.length; j += 1) {
      const b = itemAt(movements, j);
      if (a.arm === b.arm && a.laneIndex === b.laneIndex) continue; // shared approach lane
      const wb = itemAt(windows, j);
      if (
        wa.maxX + aabbPad < wb.minX - aabbPad ||
        wb.maxX + aabbPad < wa.minX - aabbPad ||
        wa.maxY + aabbPad < wb.minY - aabbPad ||
        wb.maxY + aabbPad < wa.minY - aabbPad
      ) {
        continue; // windows cannot interact
      }
      collectPairZones(a, wa, b, wb, halfLen, threshold, rejectDx, pending);
    }
  }

  const zones: ConflictZone[] = pending.map((zone, index) => ({
    id: `zone-${index}`,
    movements: [zone.a, zone.b],
    polygon: zonePolygon(zone.points),
  }));

  const perMovement = new Map<MovementId, MovementConflictZone[]>();
  for (const movement of movements) perMovement.set(movement.id, []);
  const bucket = (id: MovementId): MovementConflictZone[] => {
    const list = perMovement.get(id);
    if (list === undefined) throw new Error(`unknown movement id '${id}'`);
    return list;
  };
  for (const zone of zones) {
    const [first, second] = zone.movements;
    bucket(first.movementId).push({ zoneId: zone.id, otherMovementId: second.movementId, sEnter: first.sEnter, sExit: first.sExit });
    bucket(second.movementId).push({ zoneId: zone.id, otherMovementId: first.movementId, sEnter: second.sEnter, sExit: second.sExit });
  }
  for (const list of perMovement.values()) {
    list.sort((p, q) => (p.sEnter !== q.sEnter ? p.sEnter - q.sEnter : p.zoneId < q.zoneId ? -1 : 1));
  }

  return { zones, perMovement };
}

function collectPairZones(
  a: ConflictPathInput,
  wa: ScanWindow,
  b: ConflictPathInput,
  wb: ScanWindow,
  halfLen: number,
  threshold: number,
  rejectDx: number,
  out: { a: ZoneInterval; b: ZoneInterval; points: readonly Vec2[] }[],
): void {
  const nA = wa.samples.length;
  const nB = wb.samples.length;
  if (nA === 0 || nB === 0) return;
  const flags = new Uint8Array(nA);
  const bMin = new Int32Array(nA).fill(-1);
  const bMax = new Int32Array(nA).fill(-1);

  for (let ia = 0; ia < nA; ia += 1) {
    const sa = itemAt(wa.samples, ia);
    const a1 = { x: sa.x - sa.hx * halfLen, y: sa.y - sa.hy * halfLen };
    const a2 = { x: sa.x + sa.hx * halfLen, y: sa.y + sa.hy * halfLen };
    for (let ib = 0; ib < nB; ib += 1) {
      const sb = itemAt(wb.samples, ib);
      if (Math.abs(sa.x - sb.x) > rejectDx) continue;
      const b1 = { x: sb.x - sb.hx * halfLen, y: sb.y - sb.hy * halfLen };
      const b2 = { x: sb.x + sb.hx * halfLen, y: sb.y + sb.hy * halfLen };
      if (segmentDistance(a1, a2, b1, b2) <= threshold) {
        flags[ia] = 1;
        const lo = bMin[ia] ?? -1;
        const hi = bMax[ia] ?? -1;
        if (lo < 0 || ib < lo) bMin[ia] = ib;
        if (ib > hi) bMax[ia] = ib;
      }
    }
  }

  // Merge flagged runs separated by ≤ the gap tolerance (in samples).
  const maxGap = Math.ceil(ZONE_RUN_MERGE_GAP_METERS / CONFLICT_STEP);
  let start = -1;
  let gap = 0;
  for (let ia = 0; ia <= nA; ia += 1) {
    const flagged = ia < nA && flags[ia] === 1;
    if (flagged) {
      if (start < 0) start = ia;
      gap = 0;
    } else if (start >= 0) {
      gap += 1;
      if (ia >= nA || gap > maxGap) {
        emitZone(a, wa, b, wb, start, ia - gap, bMin, bMax, out);
        start = -1;
        gap = 0;
      }
    }
  }
}

function emitZone(
  a: ConflictPathInput,
  wa: ScanWindow,
  b: ConflictPathInput,
  wb: ScanWindow,
  runStart: number,
  runEnd: number,
  bMin: Int32Array,
  bMax: Int32Array,
  out: { a: ZoneInterval; b: ZoneInterval; points: readonly Vec2[] }[],
): void {
  let loB = -1;
  let hiB = -1;
  const points: Vec2[] = [];
  for (let ia = runStart; ia <= runEnd; ia += 1) {
    const sample = itemAt(wa.samples, ia);
    points.push({ x: sample.x, y: sample.y });
    const lo = bMin[ia] ?? -1;
    const hi = bMax[ia] ?? -1;
    if (lo >= 0 && (loB < 0 || lo < loB)) loB = lo;
    if (hi > hiB) hiB = hi;
  }
  if (loB < 0) return;
  for (let ib = loB; ib <= hiB; ib += 1) {
    const sample = itemAt(wb.samples, ib);
    points.push({ x: sample.x, y: sample.y });
  }
  const aFirst = itemAt(wa.samples, runStart).s;
  const aLast = itemAt(wa.samples, runEnd).s;
  const bFirst = itemAt(wb.samples, loB).s;
  const bLast = itemAt(wb.samples, hiB).s;
  out.push({
    a: interval(a.id, aFirst, aLast, a.lengthMeters),
    b: interval(b.id, bFirst, bLast, b.lengthMeters),
    points,
  });
}

function interval(movementId: MovementId, sFirst: number, sLast: number, pathLength: number): ZoneInterval {
  return {
    movementId,
    sEnter: Math.max(0, sFirst - CONFLICT_STEP / 2),
    sExit: Math.min(pathLength, sLast + CONFLICT_STEP / 2),
  };
}

// --- convex hull + conservative polygon -------------------------------------

function cross(o: Vec2, a: Vec2, b: Vec2): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** Andrew's monotone chain; returns hull vertices in CCW order (may be < 3 for degenerate input). */
function convexHull(points: readonly Vec2[]): Vec2[] {
  const sorted = [...points].sort((p, q) => (p.x !== q.x ? p.x - q.x : p.y - q.y));
  if (sorted.length < 3) return sorted;
  const lower: Vec2[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(itemAt(lower, lower.length - 2), itemAt(lower, lower.length - 1), p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: Vec2[] = [];
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const p = itemAt(sorted, i);
    while (upper.length >= 2 && cross(itemAt(upper, upper.length - 2), itemAt(upper, upper.length - 1), p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  const hull = lower.concat(upper);
  return hull.length >= 3 ? hull : sorted.slice(0, 2);
}

/** Padded conservative polygon: hull expanded outward, square fallback when degenerate. */
function zonePolygon(points: readonly Vec2[]): Vec2[] {
  const hull = convexHull(points);
  let cx = 0;
  let cy = 0;
  for (const p of hull) {
    cx += p.x / hull.length;
    cy += p.y / hull.length;
  }
  if (hull.length < 3) {
    const pad = ZONE_POLYGON_PAD_METERS;
    return [
      { x: cx - pad, y: cy - pad },
      { x: cx + pad, y: cy - pad },
      { x: cx + pad, y: cy + pad },
      { x: cx - pad, y: cy + pad },
    ];
  }
  const centroid = { x: cx, y: cy };
  return hull.map((vertex) => {
    const dir = vsub(vertex, centroid);
    const dist = vlen(dir);
    if (dist < 1e-9) return vadd(centroid, { x: ZONE_POLYGON_PAD_METERS, y: 0 });
    return vadd(centroid, vscale(dir, 1 + ZONE_POLYGON_PAD_METERS / dist));
  });
}

// Re-exported for consumers that compose capsules directly (F5 tests).
export function capsuleSegment(sample: PathSample, halfLength: number): readonly [Vec2, Vec2] {
  return [
    { x: sample.x - sample.hx * halfLength, y: sample.y - sample.hy * halfLength },
    { x: sample.x + sample.hx * halfLength, y: sample.y + sample.hy * halfLength },
  ];
}

export const CONFLICT_THRESHOLD_METERS = CAR_WIDTH_METERS + CONFLICT_STEP;
export const CONFLICT_SCAN_STEP_METERS = CONFLICT_STEP;
