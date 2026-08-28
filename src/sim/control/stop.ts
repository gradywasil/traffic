/**
 * All-way stop controller (task F5) — scope semantics: full stop,
 * first-come-first-served departure, right tiebreak for simultaneous
 * stops, left yields oncoming through.
 *
 * The controller owns exactly one thing: the FIFO ticket bookkeeping
 * (R1 §4.2 stop-sign gate — "reservations granted only to stopped
 * vehicles, FIFO order emerges"). A ticket is stamped the first tick a car
 * is both stopped (v < STOPPED_SPEED_MPS) and at the stop line; the grant
 * pass then evaluates tickets in order, subject to the claim gates
 * (exclusivity, left-yield τ_clear, exit headroom) in claims.ts.
 *
 * Departure order comparator (total order — sort-safe):
 *   1. ticket tick ascending (FIFO);
 *   2. right-yield count ascending — among cars stopped at the SAME tick,
 *      a car with another simultaneous car on its right arm yields, so the
 *      car with the fewest right-arm neighbors departs first ("the car to
 *      the right departs first"; for a full 4-way simultaneous stop the
 *      right-relation cycles, and we degrade deterministically to arm
 *      order);
 *   3. arm order N, E, S, W (R1 §4.2 tiebreak), then lane index, then
 *      entity id.
 */
import { ARM_IDS } from '../../config';
import type { ArmId } from '../../config';
import { INBOUND_HEADING, rightOf } from '../../geom';

export interface StopTicket {
  readonly tick: number;
  readonly armIndex: number;
  readonly laneIndex: number;
  readonly entityId: number;
}

interface ArmTables {
  readonly right: Readonly<Record<ArmId, ArmId>>;
  readonly opposite: Readonly<Record<ArmId, ArmId>>;
}

function buildArmTables(): ArmTables {
  const right = {} as Record<ArmId, ArmId>;
  const opposite = {} as Record<ArmId, ArmId>;
  for (const a of ARM_IDS) {
    const ha = INBOUND_HEADING[a];
    const rightSide = rightOf(ha);
    for (const b of ARM_IDS) {
      if (b === a) continue;
      const hb = INBOUND_HEADING[b];
      if (hb.x * ha.x + hb.y * ha.y < -0.5) opposite[a] = b; // hb ≈ −ha
      // b's approach side (−hb) aligned with a's right side ⇒ b sits on a's right.
      if (-hb.x * rightSide.x + -hb.y * rightSide.y > 0.5) right[a] = b;
    }
  }
  return { right, opposite };
}

const TABLES = buildArmTables();

/** The arm whose approach lies to `arm`'s drivers' right (north → west, ...). */
export function rightArmOf(arm: ArmId): ArmId {
  return TABLES.right[arm];
}

/** The oncoming arm (left-yield gate + conflict scoping). */
export function oppositeArmOf(arm: ArmId): ArmId {
  return TABLES.opposite[arm];
}

export class AllWayStopController {
  private readonly tickets = new Map<number, StopTicket>();

  /**
   * Stamp a stop ticket the first time a car is observed stopped at the
   * line. Called once per tick per car by the claim layer, in dense index
   * order (R2 Part C rule 5).
   */
  observe(
    tick: number,
    entityId: number,
    armIndex: number,
    laneIndex: number,
    stopped: boolean,
    atLine: boolean,
  ): void {
    if (!stopped || !atLine) return;
    if (!this.tickets.has(entityId)) {
      this.tickets.set(entityId, { tick, armIndex, laneIndex, entityId });
    }
  }

  hasTicket(entityId: number): boolean {
    return this.tickets.has(entityId);
  }

  ticketOf(entityId: number): StopTicket | undefined {
    return this.tickets.get(entityId);
  }

  /**
   * How many cars stopped at the same tick sit on this car's right arm —
   * the "yields right" tiebreak layer. Count only (order-independent), so
   * Map iteration here cannot affect outcomes.
   */
  rightYieldCount(entityId: number): number {
    const own = this.tickets.get(entityId);
    if (own === undefined) return 0;
    const arm = ARM_IDS[own.armIndex];
    const rightArmIndex = arm === undefined ? own.armIndex : ARM_IDS.indexOf(rightArmOf(arm));
    let count = 0;
    for (const ticket of this.tickets.values()) {
      if (ticket.tick === own.tick && ticket.armIndex === rightArmIndex) count += 1;
    }
    return count;
  }

  /** Total departure-order comparator over two ticketed cars. */
  compare(entityA: number, entityB: number): number {
    if (entityA === entityB) return 0;
    const ta = this.tickets.get(entityA);
    const tb = this.tickets.get(entityB);
    const tickA = ta === undefined ? Number.POSITIVE_INFINITY : ta.tick;
    const tickB = tb === undefined ? Number.POSITIVE_INFINITY : tb.tick;
    if (tickA !== tickB) return tickA - tickB;
    const yieldA = ta === undefined ? 0 : this.rightYieldCount(entityA);
    const yieldB = tb === undefined ? 0 : this.rightYieldCount(entityB);
    if (yieldA !== yieldB) return yieldA - yieldB;
    const armA = ta === undefined ? 0 : ta.armIndex;
    const armB = tb === undefined ? 0 : tb.armIndex;
    if (armA !== armB) return armA - armB;
    const laneA = ta === undefined ? 0 : ta.laneIndex;
    const laneB = tb === undefined ? 0 : tb.laneIndex;
    if (laneA !== laneB) return laneA - laneB;
    return entityA - entityB;
  }

  /** Drop tickets of cars no longer in the store (departures). */
  prune(liveEntityIds: ReadonlySet<number>): void {
    for (const entityId of this.tickets.keys()) {
      if (!liveEntityIds.has(entityId)) this.tickets.delete(entityId);
    }
  }

  /** Number of outstanding tickets (diagnostics/tests). */
  get size(): number {
    return this.tickets.size;
  }
}
