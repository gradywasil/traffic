/**
 * Per-movement path generation (task F3).
 *
 * A movement m = (approach arm, lane, turn) maps to exactly one fixed path
 * (R1 §4.1): approach straight to the stop line → connector through the box
 * → exit straight to the receiving arm's outer end.
 *
 * Connectors:
 * - through, aligned lane counts: straight (R_p = null, v_t = v_c);
 * - through, misaligned exit lane: gentle lateral jog (cubic blend) sized so
 *   R_p ≥ v_c²/a_lat whenever it fits ⇒ through traffic never slows;
 * - left/right: quarter-circle arcs tangent to both lane centerlines,
 *   starting exactly at the stop line, radius fixed by the geometry:
 *   R_left = by + setback + exit-lane offset, R_right = by + setback − offset
 *   (7.75 m and v_t ≈ 3.6 m/s at default 3.5 m lanes — a believable urban
 *   right turn; lefts come out wider and faster).
 */
import { EXIT_MARGIN_METERS, JOG_MIN_SPAN_METERS, MOVEMENT_TURN_ORDER, ARM_LENGTH_METERS } from './constants';
import { PathBuilder, sampleAtS } from './curve';
import type { PathSample } from './curve';
import { freeFlowProfile } from './freeflow';
import type { FreeFlowProfile } from './freeflow';
import { buildLayout } from './layout';
import type { IntersectionLayout } from './layout';
import { itemAt, leftOf, rightOf, vadd, vdot, vscale, vsub } from './vec';
import type { Vec2 } from './vec';
import { ARM_IDS } from '../config';
import type { ArmId, IntersectionConfig, TurnDirection } from '../config';

/** Stable id: `${arm}:${laneIndex}:${turn}`. */
export type MovementId = string;

export function movementId(arm: ArmId, laneIndex: number, turn: TurnDirection): MovementId {
  return `${arm}:${laneIndex}:${turn}`;
}

/**
 * Exit-lane mapping (production-owned; right-hand traffic):
 * through/left keep their lane index (clamped to the receiving arm's count),
 * right turns mirror from the right — the rightmost approach lane feeds the
 * rightmost exit lane; excess right lanes share and produce merge zones.
 */
export function exitLaneIndex(
  turn: TurnDirection,
  approachLaneIndex: number,
  approachLaneCount: number,
  exitLaneCount: number,
): number {
  if (turn === 'right') {
    const fromRight = approachLaneCount - 1 - approachLaneIndex;
    return exitLaneCount - 1 - Math.min(fromRight, exitLaneCount - 1);
  }
  return Math.min(approachLaneIndex, exitLaneCount - 1);
}

export interface MovementGeometry {
  readonly id: MovementId;
  readonly arm: ArmId;
  readonly laneIndex: number;
  readonly turn: TurnDirection;
  readonly exitArm: ArmId;
  readonly exitLaneIndex: number;
  readonly samples: readonly PathSample[];
  readonly lengthMeters: number;
  /** Spawn waypoint: approach lane center at the arm's outer end. */
  readonly entryPoint: Vec2;
  /** Despawn waypoint: exit lane center at the exit arm's outer end. */
  readonly exitPoint: Vec2;
  /** s where the path crosses the approach stop line. */
  readonly stopLineS: number;
  readonly stopLinePoint: Vec2;
  /**
   * Slow-section s-range: starts at the stop line, ends at the far end of
   * the turn curve (arc end / jog end / box exit for through). Curve start
   * is the stop line by construction (canonical trajectory, R1 §6.1).
   */
  readonly curveStartS: number;
  readonly curveEndS: number;
  /** R_p (turn radius); null = straight, v_t = v_c. */
  readonly turnRadiusMeters: number | null;
  /** v_t(p) = min(v_c, sqrt(a_lat·R_p)). */
  readonly turnSpeedMps: number;
  readonly entryGateS: number;
  readonly entryGatePoint: Vec2;
  readonly exitGateS: number;
  readonly exitGatePoint: Vec2;
  /** Influence-zone length (exit gate − entry gate). */
  readonly influenceZoneMeters: number;
  /** FF(p): closed-form free-flow travel time through the influence zone. */
  readonly freeFlowSeconds: number;
  /** Conflict zones on this movement, sorted by sEnter (filled by the facade). */
  readonly conflictZones: readonly MovementConflictZone[];
}

export interface MovementConflictZone {
  readonly zoneId: string;
  readonly otherMovementId: MovementId;
  readonly sEnter: number;
  readonly sExit: number;
}

function jogSpanMeters(absDelta: number, cruiseSpeedMps: number, lateralAccelMps2: number, maxSpan: number): number {
  if (absDelta <= 1e-9) return 0;
  const needed = Math.sqrt((6 * absDelta * cruiseSpeedMps * cruiseSpeedMps) / lateralAccelMps2);
  const ceiling = Math.max(JOG_MIN_SPAN_METERS, maxSpan);
  return Math.min(Math.max(needed, JOG_MIN_SPAN_METERS), ceiling);
}

const EXIT_ARM_TABLE: Readonly<Record<ArmId, Readonly<Record<TurnDirection, ArmId>>>> = {
  north: { left: 'east', through: 'south', right: 'west' },
  east: { left: 'south', through: 'west', right: 'north' },
  south: { left: 'west', through: 'north', right: 'east' },
  west: { left: 'north', through: 'east', right: 'south' },
};

function buildOneMovement(
  config: IntersectionConfig,
  layout: IntersectionLayout,
  armId: ArmId,
  laneIndex: number,
  turn: TurnDirection,
): MovementGeometry {
  const arm = layout.arms[armId];
  const u = arm.inboundHeading;
  const stopPoint = itemAt(arm.approachLaneCentersAtStopLine, laneIndex);
  const entryPoint = itemAt(arm.approachLaneEntryPoints, laneIndex);
  const exitArmId = EXIT_ARM_TABLE[armId][turn];
  const exitArm = layout.arms[exitArmId];
  const j = exitLaneIndex(turn, laneIndex, arm.laneCount, exitArm.laneCount);
  const q = itemAt(exitArm.exitLaneCentersAtBoundary, j);
  const exitPoint = itemAt(exitArm.exitLaneExitPoints, j);

  const builder = new PathBuilder();
  builder.start(entryPoint, u);
  builder.pushStraight(arm.approachLengthMeters); // entry → stop line (exact endpoint)
  const stopLineS = builder.lengthMeters;

  let turnRadius: number | null;
  if (turn === 'through') {
    // Lateral offset between the approach lane and its through exit lane.
    const delta = vdot(vadd(vscale(q, -1), stopPoint), vscale(arm.rightOfInbound, -1));
    if (Math.abs(delta) < 1e-9) {
      builder.pushStraight(vdot(vsub(q, stopPoint), u)); // stop line → box exit
      turnRadius = null;
    } else {
      const maxSpan = ARM_LENGTH_METERS - EXIT_MARGIN_METERS - arm.stopLineDistance;
      const span = jogSpanMeters(Math.abs(delta), config.arms[armId].cruiseSpeedMps, config.modelParams.lateralAccelMps2, maxSpan);
      builder.pushJog(arm.rightOfInbound, span, delta);
      turnRadius = (span * span) / (6 * Math.abs(delta));
    }
  } else {
    // Quarter arc from the stop line toward the turn side, radius fixed by
    // the exit-lane centerline distance along the inbound axis.
    const v = turn === 'left' ? leftOf(u) : rightOf(u);
    const radius = vdot(vadd(vscale(stopPoint, -1), q), u);
    if (!(radius > 0)) {
      throw new Error(`degenerate turn radius ${String(radius)} for movement ${movementId(armId, laneIndex, turn)}`);
    }
    builder.pushQuarterArc(v, radius);
    turnRadius = radius;
  }
  const curveEndS = builder.lengthMeters;

  // Exit straight to the receiving arm's outer end, along the current heading.
  const tail = vsub(exitPoint, builder.lastPoint);
  const tailAlong = vdot(tail, builder.lastHeading);
  if (tailAlong < -1e-6) {
    throw new Error(`exit straight length negative (${String(tailAlong)}) for ${movementId(armId, laneIndex, turn)}`);
  }
  builder.pushStraight(Math.max(0, tailAlong));

  const samples = builder.finish();
  const profile: FreeFlowProfile = freeFlowProfile(stopLineS, curveEndS, turnRadius, {
    dt: config.dt,
    cruiseSpeedMps: config.arms[armId].cruiseSpeedMps,
    maxAccelerationMps2: config.modelParams.maxAccelerationMps2,
    comfortableDecelMps2: config.modelParams.comfortableDecelMps2,
    lateralAccelMps2: config.modelParams.lateralAccelMps2,
  });

  return {
    id: movementId(armId, laneIndex, turn),
    arm: armId,
    laneIndex,
    turn,
    exitArm: exitArmId,
    exitLaneIndex: j,
    samples,
    lengthMeters: builder.lengthMeters,
    entryPoint,
    exitPoint,
    stopLineS,
    stopLinePoint: stopPoint,
    curveStartS: stopLineS,
    curveEndS,
    turnRadiusMeters: turnRadius,
    turnSpeedMps: profile.turnSpeedMps,
    entryGateS: profile.entryGateS,
    entryGatePoint: sampleAtS(samples, profile.entryGateS),
    exitGateS: profile.exitGateS,
    exitGatePoint: sampleAtS(samples, profile.exitGateS),
    influenceZoneMeters: profile.influenceZoneMeters,
    freeFlowSeconds: profile.freeFlowSeconds,
    conflictZones: [],
  };
}

/** All movements of a config in canonical order: arm (N,E,S,W) → lane → left,through,right. */
export function buildMovementPathsFromLayout(
  config: IntersectionConfig,
  layout: IntersectionLayout,
): readonly MovementGeometry[] {
  const movements: MovementGeometry[] = [];
  for (const armId of ARM_IDS) {
    const lanes = config.arms[armId].lanes;
    for (let laneIndex = 0; laneIndex < lanes.length; laneIndex += 1) {
      const designations = itemAt(lanes, laneIndex).designations;
      for (const turn of MOVEMENT_TURN_ORDER) {
        if (designations.includes(turn)) {
          movements.push(buildOneMovement(config, layout, armId, laneIndex, turn));
        }
      }
    }
  }
  return movements;
}

/** Convenience wrapper building the layout first (tests, U1 debug tooling). */
export function buildMovementPaths(config: IntersectionConfig): readonly MovementGeometry[] {
  return buildMovementPathsFromLayout(config, buildLayout(config));
}

/** Find a movement by designation; undefined when the lane does not serve the turn. */
export function findMovement(
  movements: readonly MovementGeometry[],
  arm: ArmId,
  laneIndex: number,
  turn: TurnDirection,
): MovementGeometry | undefined {
  const id = movementId(arm, laneIndex, turn);
  return movements.find((movement) => movement.id === id);
}
