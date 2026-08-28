/**
 * Claim-based conflict-point arbitration (task F5) — research R1 §4.2:
 * Dresner–Stone's claim lifecycle on the exact per-pair conflict zones F3
 * computed (Levin & Rey conflict-point formulation), with the signal ring
 * and the all-way stop FIFO tickets acting as *grant gates* over the same
 * substrate (Dresner–Stone's own stop-sign policy / FCWS-Light
 * composability, with exact zones instead of tiles).
 *
 * Lifecycle per car (R1 §4.2):
 *   APPROACH ──(distance to stop line ≤ stopping distance + margin)──▶ PENDING
 *   PENDING ──(grant, tick T)──▶ CLAIMED          # may cross the stop line
 *   CLAIMED ──(front bumper passes stop line)──▶ IN_BOX
 *   IN_BOX ──(rear bumper clears last conflict zone + margin)──▶ CLEARED
 *   PENDING ──(deny)──▶ PENDING (retry; stop line = virtual stopped leader)
 *
 * Grant rule — requests evaluated in FIFO ticket order (signal: stop-line
 * arrival = min(stop tick, request tick); stop: the stamped stop-at-line
 * ticket, right tiebreak for simultaneous stops), ties by arm (N,E,S,W)
 * then lane. A request by car c on movement m is granted iff ALL:
 * 1. Authority — control grants m at tick T (signal: green, or yellow iff
 *    dilemma-eligible, and the car can still reach the line before yellow
 *    ends; stop: the car is stopped at the line and holds the ticket);
 * 2. Exclusivity — no conflict zone of C(m) is held by a car of another
 *    movement (same-movement platoons follow each other instead —
 *    car-following owns longitudinal safety inside a shared path);
 * 3. Left-yield — only for lefts under yield authority: no oncoming car on
 *    a conflicting movement is granted/in-box, and no oncoming car with
 *    entry authority has a worst-case arrival (accelerate to v_c
 *    immediately) within τ_clear = 4.0 s at the shared zone. Opposing
 *    permissive lefts would otherwise deadlock each other; the FIFO ticket
 *    order breaks that symmetry (a later-ticket oncoming LEFT is not a
 *    threat to an earlier-ticket left; oncoming through/right always is).
 * 4. Exit headroom — the target exit lane's rearmost occupant leaves
 *    ≥ s_min + v_c·T of space past this movement's join point (prevents
 *    box blockage; queues spill back onto the arm instead).
 * 5. Car-following safety — always true by the request-distance rule.
 *
 * Claims feed F4's Guarded IDM through the CarConstraints seam:
 * - a stop-line barrier (`stopLineS + s0`, parking front bumpers ON the
 *   line — the virtual stopped leader for any DENIED pre-line car, erected
 *   from the request line onward (T-F5b): a car in APPROACH is by the
 *   request-distance rule still farther out than its comfortable stopping
 *   distance + one tick + margin, so it needs no hold yet and IDM's
 *   long-range interaction term must not shed speed on cars with current
 *   authority; a PENDING car additionally doubles as R1 §3.1 leader rule
 *   (b), the virtual leader at a denied zone boundary: zones sit at/after
 *   the stop line, so the line barrier is always at least as strict);
 * - per-tick exit-lane speed caps: the Krauss safe speed toward the
 *   rearmost cross-movement occupant of the shared exit lane, mapped into
 *   this path's s-frame via the common exit point (all paths ending on one
 *   exit lane share its final straight, so the map s' = s + (L_m − L_other)
 *   is exact there). Same-movement cars need no cap — F4 follows them.
 *
 * Determinism (R2 Part C): IEEE-exact ops + sqrt only; decisions iterate
 * dense store indices and fixed precomputed arrays; Map/Set are only ever
 * probed (membership/count), never iterated for order-sensitive state.
 */
import { ARM_IDS } from '../../config';
import type { ArmId, IntersectionConfig, TurnDirection } from '../../config';
import type { IntersectionGeometry } from '../../geom';
import type { CarWorld } from '../world';
import { f64At, i32At } from '../store';
import {
  CLAIM_RELEASE_MARGIN_METERS,
  ENTER_SLACK_METERS,
  MIN_GRANT_APPROACH_SPEED_MPS,
  REQUEST_MARGIN_METERS,
  STOP_LINE_WINDOW_METERS,
  STOPPED_SPEED_MPS,
  TAU_CLEAR_SECONDS,
} from './constants';
import type { AllWayStopController } from './stop';
import { oppositeArmOf } from './stop';
import type { SignalController } from './signal';

export type ClaimPhase = 'approach' | 'pending' | 'claimed' | 'in-box' | 'cleared';

/** Live claim state of one car (keyed by stable entity id). */
export interface ClaimRecord {
  readonly entityId: number;
  readonly pathIndex: number;
  phase: ClaimPhase;
  /** Tick the car entered PENDING (reached the request line). */
  requestTick: number;
  /** First tick the car was observed stopped (signal FIFO timestamp input). */
  stoppedTick: number;
}

/** One grant decision, in grant order (tests, telemetry, U1). */
export interface GrantEvent {
  readonly tick: number;
  readonly entityId: number;
  readonly pathIndex: number;
}

export interface ClaimStats {
  grants: number;
  releases: number;
  deniedAuthority: number;
  deniedReach: number;
  deniedExclusivity: number;
  deniedYield: number;
  deniedExitHeadroom: number;
  /** PENDING car crossed the stop line without a grant — must stay 0. */
  ungrantedLineCrossings: number;
}

interface OncomingConflict {
  readonly otherIndex: number;
  /** sEnter of the first shared zone on the OTHER movement's path. */
  readonly otherFirstZoneEnterS: number;
  /** sExit of the last shared zone on the OTHER movement's path (+ margin). */
  readonly otherClearS: number;
}

interface ExitPeer {
  readonly otherIndex: number;
  /** s' in this movement's frame = s_other + offset (valid on the shared exit straight). */
  readonly offset: number;
}

/** Precomputed per-movement arbitration facts (pure function of geometry+config). */
interface MovementFacts {
  readonly arm: ArmId;
  readonly armIndex: number;
  readonly laneIndex: number;
  readonly turn: TurnDirection;
  readonly cruiseMps: number;
  readonly stopLineS: number;
  readonly curveEndS: number;
  readonly lengthMeters: number;
  /** Rear bumper must pass this s before claims release. */
  readonly releaseS: number;
  readonly zoneIds: readonly string[];
  readonly exitChainKey: number;
  /** Movements sharing the exit lane, self excluded (longitudinal caps). */
  readonly exitPeers: readonly ExitPeer[];
  /** Movements on the exit lane including self (exit-headroom scan). */
  readonly exitScan: readonly number[];
  /** Oncoming movements sharing a conflict zone (left-yield gate). */
  readonly oncomingConflicts: readonly OncomingConflict[];
}

export interface ClaimManagerOptions {
  /** Buffer size for the constraint arrays (>= the CarWorld capacity). */
  readonly capacity?: number;
  /** Left-yield worst-case gap window (R1 default 4.0 s). */
  readonly tauClearSeconds?: number;
}

export class ClaimManager {
  readonly stats: ClaimStats = {
    grants: 0,
    releases: 0,
    deniedAuthority: 0,
    deniedReach: 0,
    deniedExclusivity: 0,
    deniedYield: 0,
    deniedExitHeadroom: 0,
    ungrantedLineCrossings: 0,
  };
  readonly grantLog: GrantEvent[] = [];

  private readonly config: IntersectionConfig;
  private readonly facts: readonly MovementFacts[];
  private readonly records = new Map<number, ClaimRecord>();
  private readonly zoneHolders = new Map<string, Map<number, number>>();
  private readonly liveIds = new Set<number>();
  private readonly denseByMovement: number[][];
  private readonly tauClearSeconds: number;
  private readonly barrierBuf: Float64Array;
  private readonly capBuf: Float64Array;
  private readonly scratchCandidates: number[] = [];
  /** The world of the grant pass in flight (helpers read its store). */
  private activeWorld: CarWorld | null = null;

  constructor(geometry: IntersectionGeometry, config: IntersectionConfig, options: ClaimManagerOptions = {}) {
    this.config = config;
    this.tauClearSeconds = options.tauClearSeconds ?? TAU_CLEAR_SECONDS;
    const capacity = options.capacity ?? 512;
    this.barrierBuf = new Float64Array(capacity).fill(Number.POSITIVE_INFINITY);
    this.capBuf = new Float64Array(capacity).fill(Number.POSITIVE_INFINITY);

    const movements = geometry.movements;
    const indexById = new Map<string, number>();
    for (let m = 0; m < movements.length; m += 1) {
      const movement = movements[m];
      if (movement === undefined) throw new Error(`missing movement ${String(m)}`);
      indexById.set(movement.id, m);
    }

    // First pass: everything derivable from the movement itself.
    const partial = movements.map((movement) => {
      let lastZoneExitS = Number.NEGATIVE_INFINITY;
      for (const zone of movement.conflictZones) lastZoneExitS = Math.max(lastZoneExitS, zone.sExit);
      const releaseS =
        movement.conflictZones.length > 0
          ? lastZoneExitS + CLAIM_RELEASE_MARGIN_METERS
          : movement.curveEndS + CLAIM_RELEASE_MARGIN_METERS;
      return {
        movement,
        armIndex: ARM_IDS.indexOf(movement.arm),
        exitChainKey: ARM_IDS.indexOf(movement.exitArm) * 3 + movement.exitLaneIndex,
        releaseS,
      };
    });

    // Second pass: relations between movements (peers, oncoming conflicts).
    this.facts = partial.map((p, m) => {
      const movement = p.movement;
      const exitPeers: ExitPeer[] = [];
      const exitScan: number[] = [m];
      for (let other = 0; other < movements.length; other += 1) {
        if (other === m) continue;
        const otherMovement = movements[other];
        if (otherMovement === undefined) continue;
        if (
          ARM_IDS.indexOf(otherMovement.exitArm) * 3 + otherMovement.exitLaneIndex !== p.exitChainKey
        ) {
          continue;
        }
        exitPeers.push({ otherIndex: other, offset: movement.lengthMeters - otherMovement.lengthMeters });
        exitScan.push(other);
      }

      const opposite = oppositeArmOf(movement.arm);
      const conflictByOther = new Map<number, { firstEnter: number; lastExit: number }>();
      for (const zone of movement.conflictZones) {
        const otherIndex = indexById.get(zone.otherMovementId);
        if (otherIndex === undefined) throw new Error(`unknown movement ${zone.otherMovementId}`);
        const otherMovement = movements[otherIndex];
        if (otherMovement === undefined || otherMovement.arm !== opposite) continue;
        const otherZone = otherMovement.conflictZones.find((z) => z.zoneId === zone.zoneId);
        if (otherZone === undefined) {
          throw new Error(`zone ${zone.zoneId} not attached to ${otherMovement.id}`);
        }
        const bounds = conflictByOther.get(otherIndex);
        if (bounds === undefined) {
          conflictByOther.set(otherIndex, { firstEnter: otherZone.sEnter, lastExit: otherZone.sExit });
        } else {
          bounds.firstEnter = Math.min(bounds.firstEnter, otherZone.sEnter);
          bounds.lastExit = Math.max(bounds.lastExit, otherZone.sExit);
        }
      }
      const oncomingConflicts: OncomingConflict[] = [];
      for (const [otherIndex, bounds] of conflictByOther) {
        oncomingConflicts.push({
          otherIndex,
          otherFirstZoneEnterS: bounds.firstEnter,
          otherClearS: bounds.lastExit + CLAIM_RELEASE_MARGIN_METERS,
        });
      }
      oncomingConflicts.sort((a, b) => a.otherIndex - b.otherIndex);

      return {
        arm: movement.arm,
        armIndex: p.armIndex,
        laneIndex: movement.laneIndex,
        turn: movement.turn,
        cruiseMps: this.config.arms[movement.arm].cruiseSpeedMps,
        stopLineS: movement.stopLineS,
        curveEndS: movement.curveEndS,
        lengthMeters: movement.lengthMeters,
        releaseS: p.releaseS,
        zoneIds: movement.conflictZones.map((zone) => zone.zoneId),
        exitChainKey: p.exitChainKey,
        exitPeers,
        exitScan,
        oncomingConflicts,
      };
    });

    this.denseByMovement = this.facts.map(() => []);
  }

  /** Claim record of a car (undefined once departed). */
  recordOf(entityId: number): ClaimRecord | undefined {
    return this.records.get(entityId);
  }

  /** Movement indices currently holding a zone (diagnostics/tests). */
  holdersOfZone(zoneId: string): readonly number[] {
    const holders = this.zoneHolders.get(zoneId);
    return holders === undefined ? [] : [...holders.keys()];
  }

  /**
   * Reconcile per-car records with the store: create APPROACH records for
   * new entities, release claims and drop records of departed cars, prune
   * stop tickets. Call once per tick, before the world step.
   */
  sync(world: CarWorld, stop: AllWayStopController | null): void {
    const store = world.store;
    this.liveIds.clear();
    for (let i = 0; i < store.count; i += 1) {
      const id = i32At(store.entityId, i);
      this.liveIds.add(id);
      if (!this.records.has(id)) {
        this.records.set(id, {
          entityId: id,
          pathIndex: i32At(store.pathIndex, i),
          phase: 'approach',
          requestTick: Number.POSITIVE_INFINITY,
          stoppedTick: Number.POSITIVE_INFINITY,
        });
      }
    }
    for (const [id, record] of this.records) {
      if (this.liveIds.has(id)) continue;
      if (record.phase === 'claimed' || record.phase === 'in-box') this.releaseHolds(record);
      this.records.delete(id);
    }
    if (stop !== null) stop.prune(this.liveIds);
  }

  /**
   * Advance claim lifecycles and stamp stop observations from the current
   * (pre-step) store state. Call after `sync`, before `evaluateGrants`.
   */
  advanceLifecycles(world: CarWorld, tick: number, stop: AllWayStopController | null): void {
    const store = world.store;
    const b = this.config.modelParams.comfortableDecelMps2;
    const dt = this.config.dt;
    for (let i = 0; i < store.count; i += 1) {
      const id = i32At(store.entityId, i);
      const record = this.records.get(id);
      if (record === undefined) continue;
      const facts = this.factOf(i32At(store.pathIndex, i));
      const s = f64At(store.s, i);
      const v = f64At(store.speed, i);
      const stopped = v < STOPPED_SPEED_MPS;
      if (stopped && record.stoppedTick === Number.POSITIVE_INFINITY) record.stoppedTick = tick;
      if (
        stop !== null &&
        record.phase === 'pending' &&
        stopped &&
        s >= facts.stopLineS - STOP_LINE_WINDOW_METERS &&
        s <= facts.stopLineS + STOP_LINE_WINDOW_METERS
      ) {
        stop.observe(tick, id, facts.armIndex, facts.laneIndex, true, true);
      }

      switch (record.phase) {
        case 'approach': {
          // Request distance = comfortable stopping distance + one tick of
          // travel + margin ⇒ a denial can always be honored comfortably.
          const requestDistance = (v * v) / (2 * b) + v * dt + REQUEST_MARGIN_METERS;
          if (facts.stopLineS - s <= requestDistance) {
            record.phase = 'pending';
            record.requestTick = tick;
          }
          break;
        }
        case 'pending':
          // The stop-line barrier + b_e envelope makes this unreachable;
          // counted so a regression fails loudly instead of silently.
          if (s > facts.stopLineS + ENTER_SLACK_METERS) this.stats.ungrantedLineCrossings += 1;
          break;
        case 'claimed':
          if (s > facts.stopLineS) record.phase = 'in-box';
          break;
        case 'in-box': {
          if (s - f64At(store.carLengthMeters, i) >= facts.releaseS) {
            this.releaseHolds(record);
            record.phase = 'cleared';
            this.stats.releases += 1;
          }
          break;
        }
        case 'cleared':
          break;
        default:
          break;
      }
    }
  }

  /**
   * The deterministic grant pass (see module doc). Call after
   * `advanceLifecycles`; grants register zone holds immediately.
   */
  evaluateGrants(
    world: CarWorld,
    tick: number,
    signal: SignalController | null,
    stop: AllWayStopController | null,
  ): void {
    this.activeWorld = world;
    try {
      const store = world.store;
      this.rebuildBuckets(world);
      const candidates = this.scratchCandidates;
      candidates.length = 0;

      for (let i = 0; i < store.count; i += 1) {
        const id = i32At(store.entityId, i);
        const record = this.records.get(id);
        if (record === undefined || record.phase !== 'pending') continue;
        const facts = this.factOf(record.pathIndex);
        const s = f64At(store.s, i);
        if (s > facts.stopLineS + ENTER_SLACK_METERS) continue;

        if (signal !== null) {
          const mode = signal.movementGrantMode(record.pathIndex, tick);
          if (mode === 'none') {
            this.stats.deniedAuthority += 1;
            continue;
          }
          if (mode === 'yellow-protected' || mode === 'yellow-yield') {
            // §3.1 dilemma-zone rule: on yellow only cars that cannot stop
            // comfortably before the line may still claim.
            if (!signal.dilemmaEligible(f64At(store.speed, i), facts.stopLineS - s)) {
              this.stats.deniedAuthority += 1;
              continue;
            }
          }
          // Imminent-entry rule: the claim would otherwise be held for the
          // whole approach; require reaching the line before yellow ends.
          const reach =
            (facts.stopLineS - s) / Math.max(f64At(store.speed, i), MIN_GRANT_APPROACH_SPEED_MPS);
          if (reach > signal.secondsUntilYellowEnd(tick) + world.dt) {
            this.stats.deniedReach += 1;
            continue;
          }
        } else if (stop !== null) {
          // All-way stop: full stop at the line before any grant (scope).
          if (!stop.hasTicket(id)) continue;
        }
        candidates.push(i);
      }

      candidates.sort((a, b) => this.compareTickets(a, b, stop));

      for (const denseIndex of candidates) {
        const id = i32At(store.entityId, denseIndex);
        const record = this.records.get(id);
        if (record === undefined) continue;
        const pathIndex = record.pathIndex;

        if (!this.zonesFreeFor(pathIndex)) {
          this.stats.deniedExclusivity += 1;
          continue;
        }
        if (this.isYieldLeft(pathIndex, tick, signal) && this.leftYieldBlocked(denseIndex, tick, signal, stop)) {
          this.stats.deniedYield += 1;
          continue;
        }
        if (!this.exitHeadroomOk(denseIndex, pathIndex)) {
          this.stats.deniedExitHeadroom += 1;
          continue;
        }

        record.phase = 'claimed';
        this.registerHolds(record);
        this.stats.grants += 1;
        this.grantLog.push({ tick, entityId: id, pathIndex });
      }
    } finally {
      this.activeWorld = null;
    }
  }

  /**
   * Per-car constraints for this tick (the F5 seam): stop-line barriers for
   * non-granted cars + exit-lane safe-speed caps. Returned buffers are
   * reused — consume before the next call (world.step does).
   */
  computeConstraints(world: CarWorld): { barrierS: Float64Array; speedCapMps: Float64Array } {
    const store = world.store;
    const count = store.count;
    const params = this.config.modelParams;
    const dt = this.config.dt;
    const bE = params.emergencyDecelMps2;
    const sMin = params.hardMinGapMeters;
    if (this.barrierBuf.length < count) {
      throw new Error('claim constraint buffers smaller than store count');
    }
    this.barrierBuf.fill(Number.POSITIVE_INFINITY, 0, count);
    this.capBuf.fill(Number.POSITIVE_INFINITY, 0, count);

    // Dense-index buckets per movement (fresh: the store has not been
    // stepped since evaluateGrants built them, but rebuild defensively —
    // this is O(count) and keeps computeConstraints self-sufficient).
    this.rebuildBuckets(world);

    for (let i = 0; i < count; i += 1) {
      const record = this.records.get(i32At(store.entityId, i));
      if (record === undefined) continue;
      const facts = this.factOf(record.pathIndex);
      const s = f64At(store.s, i);

      // Stop-line hold: virtual stopped leader at stopLineS + s0 (parks
      // front bumpers ON the line at IDM queue equilibrium s0). Gated by
      // the request line (phase PENDING — T-F5b): `advanceLifecycles`
      // flipped the car to PENDING this very tick iff it is now within its
      // comfortable stopping distance + one tick + margin (the R1 §4.2
      // request-distance rule, the same lead the grant gate 5 safety
      // argument rests on), so cars that must stop (red, ungranted
      // stop-sign, conflicting claims, denied yield/headroom) still get
      // the barrier with the record's stopping-sight lead while a car
      // with authority and no conflicts is not braked from afar by IDM's
      // long-range interaction term. Gating on the sticky phase (not on
      // `s <= stopLineS`) keeps the hold through the settling overshoot:
      // the model ignores barriers behind the bumper, and the terminal
      // clamp bounds the overshoot at s0 − s_min past the line.
      if (record.phase === 'pending') {
        this.barrierBuf[i] = facts.stopLineS + params.minGapMeters;
      }

      // Exit-lane caps: Krauss safe speed toward the rearmost cross-movement
      // occupant ahead on the shared exit lane, mapped into this frame.
      let cap = Number.POSITIVE_INFINITY;
      for (const peer of facts.exitPeers) {
        const peerFacts = this.factOf(peer.otherIndex);
        const bucket = this.denseByMovement[peer.otherIndex];
        if (bucket === undefined) continue;
        for (const j of bucket) {
          const sj = f64At(store.s, j);
          if (sj < peerFacts.curveEndS) continue; // not on the shared exit straight
          const mappedRear = sj - f64At(store.carLengthMeters, j) + peer.offset;
          const gap = mappedRear - s;
          if (gap <= 0) continue; // beside/behind: exclusivity or its own pass covers it
          const vj = f64At(store.speed, j);
          let vSafe = Math.sqrt(vj * vj + 2 * bE * Math.max(0, gap - sMin)) - bE * dt;
          if (vSafe < 0) vSafe = 0;
          if (vSafe < cap) cap = vSafe;
        }
      }
      if (cap < Number.POSITIVE_INFINITY) this.capBuf[i] = cap;
    }

    return { barrierS: this.barrierBuf, speedCapMps: this.capBuf };
  }

  // --- grant-gate helpers -----------------------------------------------------

  /** Dense store indices per movement index, ascending (rebuilt each tick). */
  private rebuildBuckets(world: CarWorld): void {
    for (const bucket of this.denseByMovement) bucket.length = 0;
    const store = world.store;
    for (let i = 0; i < store.count; i += 1) {
      const bucket = this.denseByMovement[i32At(store.pathIndex, i)];
      if (bucket !== undefined) bucket.push(i);
    }
  }

  private factOf(pathIndex: number): MovementFacts {
    const facts = this.facts[pathIndex];
    if (facts === undefined) throw new Error(`no arbitration facts for path ${String(pathIndex)}`);
    return facts;
  }

  private isYieldLeft(pathIndex: number, tick: number, signal: SignalController | null): boolean {
    const facts = this.factOf(pathIndex);
    if (facts.turn !== 'left') return false;
    if (signal === null) return true; // every stop-sign left is a yield left
    const mode = signal.movementGrantMode(pathIndex, tick);
    return mode === 'green-yield' || mode === 'yellow-yield';
  }

  private zonesFreeFor(pathIndex: number): boolean {
    const zoneIds = this.factOf(pathIndex).zoneIds;
    for (const zoneId of zoneIds) {
      const holders = this.zoneHolders.get(zoneId);
      if (holders === undefined) continue;
      for (const holderIndex of holders.keys()) {
        if (holderIndex !== pathIndex) return false;
      }
    }
    return true;
  }

  /**
   * R1 §4.2 gate 3 (τ_clear worst-case gap test) with the FIFO exemption
   * for symmetric opposing yield-lefts (see module doc).
   */
  private leftYieldBlocked(
    denseIndex: number,
    tick: number,
    signal: SignalController | null,
    stop: AllWayStopController | null,
  ): boolean {
    const world = this.activeWorld;
    if (world === null) return false;
    const store = world.store;
    const facts = this.factOf(i32At(store.pathIndex, denseIndex));

    for (const conflict of facts.oncomingConflicts) {
      const otherFacts = this.factOf(conflict.otherIndex);
      const bucket = this.denseByMovement[conflict.otherIndex];
      if (bucket === undefined) continue;
      for (const j of bucket) {
        const otherId = i32At(store.entityId, j);
        const otherRecord = this.records.get(otherId);
        const granted =
          otherRecord !== undefined && (otherRecord.phase === 'claimed' || otherRecord.phase === 'in-box');
        if (granted) return true; // holds shared zones / is in the box

        const sj = f64At(store.s, j);
        if (sj >= conflict.otherClearS) continue; // fully past the shared region

        // Only cars that can actually contend for entry are threats:
        // granted (in/affecting the box), PENDING (actively requesting —
        // granted as soon as zones free), or rolling. A car stopped in
        // APPROACH (queued behind its own front car, never requested) can
        // neither launch nor be granted — counting it as a worst-case
        // arrival would let two shared-lane queues deadlock through each
        // other's yield gates, breaking the R1 §4.2 acyclicity argument.
        const rolling = f64At(store.speed, j) >= STOPPED_SPEED_MPS;
        const pending = otherRecord !== undefined && otherRecord.phase === 'pending';
        if (!rolling && !pending) continue;

        // Authority: could this oncoming car legally enter (now or the
        // moment it stops)? Under a signal: its movement has green/yellow.
        // At a stop sign: it is stopped with a ticket, or still rolling in.
        if (signal !== null) {
          if (signal.movementGrantMode(conflict.otherIndex, tick) === 'none') continue;
        } else if (stop !== null && !stop.hasTicket(otherId) && !rolling) {
          continue;
        }

        // Worst-case arrival: accelerate to v_c immediately (R1 §4.2).
        const arrival = Math.max(0, conflict.otherFirstZoneEnterS - sj) / otherFacts.cruiseMps;
        if (arrival > this.tauClearSeconds) continue;

        // FIFO exemption for symmetric opposing yield-lefts: a later-ticket
        // oncoming left that holds nothing does not block an earlier-ticket
        // left (otherwise two opposing permissive lefts deadlock).
        if (
          otherFacts.turn === 'left' &&
          otherRecord !== undefined &&
          this.isYieldLeft(conflict.otherIndex, tick, signal) &&
          this.compareTickets(denseIndex, j, stop) < 0
        ) {
          continue;
        }
        return true;
      }
    }
    return false;
  }

  /** R1 §4.2 gate 4: exit-lane room at this movement's join point. */
  private exitHeadroomOk(denseIndex: number, pathIndex: number): boolean {
    const world = this.activeWorld;
    if (world === null) return false;
    const store = world.store;
    const facts = this.factOf(pathIndex);
    const threshold =
      this.config.modelParams.hardMinGapMeters +
      facts.cruiseMps * this.config.modelParams.timeHeadwaySeconds;
    let worst = Number.POSITIVE_INFINITY;
    for (const p of facts.exitScan) {
      const peerFacts = this.factOf(p);
      const bucket = this.denseByMovement[p];
      if (bucket === undefined) continue;
      for (const j of bucket) {
        if (j === denseIndex) continue;
        const sj = f64At(store.s, j);
        if (sj < peerFacts.curveEndS) continue; // not on the shared exit straight
        const mappedRear =
          sj - f64At(store.carLengthMeters, j) + (facts.lengthMeters - peerFacts.lengthMeters);
        const room = mappedRear - facts.curveEndS;
        if (room < worst) worst = room;
      }
    }
    return worst >= threshold;
  }

  private registerHolds(record: ClaimRecord): void {
    for (const zoneId of this.factOf(record.pathIndex).zoneIds) {
      let holders = this.zoneHolders.get(zoneId);
      if (holders === undefined) {
        holders = new Map<number, number>();
        this.zoneHolders.set(zoneId, holders);
      }
      holders.set(record.pathIndex, (holders.get(record.pathIndex) ?? 0) + 1);
    }
  }

  private releaseHolds(record: ClaimRecord): void {
    for (const zoneId of this.factOf(record.pathIndex).zoneIds) {
      const holders = this.zoneHolders.get(zoneId);
      if (holders === undefined) continue;
      const count = (holders.get(record.pathIndex) ?? 0) - 1;
      if (count > 0) holders.set(record.pathIndex, count);
      else holders.delete(record.pathIndex);
      if (holders.size === 0) this.zoneHolders.delete(zoneId);
    }
  }

  // --- ticket ordering --------------------------------------------------------

  private compareTickets(a: number, b: number, stop: AllWayStopController | null): number {
    const store = this.activeWorld?.store;
    if (store === undefined) return a - b;
    const idA = i32At(store.entityId, a);
    const idB = i32At(store.entityId, b);
    if (stop !== null) return stop.compare(idA, idB);
    // Signal mode: FIFO by stop-line arrival = min(stop tick, request tick),
    // ties by arm (N,E,S,W) then lane then entity id (R1 §4.2).
    const ra = this.records.get(idA);
    const rb = this.records.get(idB);
    if (ra === undefined || rb === undefined) return idA - idB;
    const fa = this.factOf(i32At(store.pathIndex, a));
    const fb = this.factOf(i32At(store.pathIndex, b));
    const ticketA = Math.min(ra.requestTick, ra.stoppedTick);
    const ticketB = Math.min(rb.requestTick, rb.stoppedTick);
    if (ticketA !== ticketB) return ticketA - ticketB;
    if (fa.armIndex !== fb.armIndex) return fa.armIndex - fb.armIndex;
    if (fa.laneIndex !== fb.laneIndex) return fa.laneIndex - fb.laneIndex;
    return ra.entityId - rb.entityId;
  }
}

