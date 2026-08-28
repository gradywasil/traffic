/**
 * Car world: the F4 systems that advance cars along their F3 paths with
 * Guarded IDM and leader detection (task F4 outcome).
 *
 * Tick pipeline (deterministic, pure function of state + inputs — R2 Part C
 * rule 1; no clocks, no randomness; the RNG arrives in F6 behind the same
 * step):
 *  1. snapshot prevS/prevSpeed (render interpolation, F1 contract);
 *  2. order entities by (lane chain, s descending, entityId) — the
 *     front-to-back order the R1 §3.2 induction proof requires (a follower
 *     always computes against its leader's final new position);
 *  3. per car: resolve leader + constraints, compute the turn-ahead speed
 *     profile, run the car-following model, write back, detect departures;
 *  4. swap-remove departed cars (front bumper reached the path end),
 *     publishing `departures` for F6/F7.
 *
 * Leader rule (R1 §3.1): nearest car ahead whose path segment overlaps the
 * follower's — same movement anywhere on the path; different-turn cars of
 * the SAME (arm, lane) while the leader's rear bumper is still on the shared
 * approach segment (s − len ≤ stopLineS; all turns of a lane share one
 * approach polyline, so the s-frames coincide there — following holds through
 * the divergence window until the footprints actually separate).
 * Cross-movement encounters inside the box / on shared exit lanes are F5's
 * claim arbitration, fed back through the constraint seam (barriers), not
 * through direct following.
 */
import type { IntersectionConfig } from '../config';
import { ARM_IDS } from '../config';
import type { IntersectionGeometry, MovementGeometry } from '../geom';
import { itemAt, sampleAtS } from '../geom';
import { guardedIdmModel } from './following';
import type { CarFollowModel, LeaderState } from './following';
import { f64At, i32At } from './store';
import type { CarConstraints, DepartureRecord } from './store';
import { CarStore } from './store';

/** Interpolated render pose of one car (world meters; headings unit). */
export interface CarPose {
  readonly x: number;
  readonly y: number;
  readonly hx: number;
  readonly hy: number;
  /** Interpolated speed (m/s) — U1 colors cars by behavior state. */
  readonly speedMps: number;
}

export interface CarWorldOptions {
  /** Max live cars; adding beyond it throws (default 512). */
  readonly capacity?: number;
  /** Car-following model (default: the committed Guarded IDM). */
  readonly model?: CarFollowModel;
}

export class CarWorld {
  readonly geometry: IntersectionGeometry;
  readonly config: IntersectionConfig;
  readonly dt: number;
  readonly store: CarStore;
  readonly model: CarFollowModel;

  /** Completed ticks (after the first step: 1). */
  tick = 0;
  /** Simulated time in seconds = tick * dt. */
  time = 0;

  /** Layer-3 terminal-clamp firings, cumulative — asserted 0 in soaks (R1 §9). */
  clampCount = 0;
  /** Layer-2 v_safe / v_headway bindings, cumulative (diagnostics). */
  safeCapBindCount = 0;
  headwayCapBindCount = 0;

  /** Departures of the most recent step (replaced each tick). */
  departures: readonly DepartureRecord[] = [];

  /** chain id (armIndex*3 + laneIndex) per movement index — one per (arm, lane). */
  private readonly chainIdOfMovement: Int32Array;
  /** Scratch: chain id per dense entity index, rebuilt each tick for the sort. */
  private readonly chainOfEntity: Int32Array;
  private readonly order: number[] = [];
  private readonly lastSameOfMovement: Int32Array;

  constructor(geometry: IntersectionGeometry, config: IntersectionConfig, options: CarWorldOptions = {}) {
    this.geometry = geometry;
    this.config = config;
    this.dt = config.dt;
    this.store = new CarStore(options.capacity ?? 512);
    this.model = options.model ?? guardedIdmModel;
    this.chainIdOfMovement = new Int32Array(geometry.movements.length);
    this.chainOfEntity = new Int32Array(this.store.capacity);
    this.lastSameOfMovement = new Int32Array(geometry.movements.length);
    for (let m = 0; m < geometry.movements.length; m += 1) {
      const movement = itemAt(geometry.movements, m);
      const armIndex = ARM_IDS.indexOf(movement.arm);
      this.chainIdOfMovement[m] = armIndex * 3 + movement.laneIndex;
    }
  }

  /**
   * Advance the world by exactly one fixed step of `dt`.
   *
   * `constraints` (optional) are this tick's externally-computed per-car
   * constraints in dense-index space (see `CarConstraints`); they must be
   * sized >= `store.count` and are consumed before any removal happens.
   * Returns this tick's departures.
   */
  step(constraints?: CarConstraints): readonly DepartureRecord[] {
    const store = this.store;
    const movements = this.geometry.movements;
    const count = store.count;
    const params = this.config.modelParams;

    if (constraints !== undefined) {
      if (constraints.barrierS.length < count || constraints.speedCapMps.length < count) {
        throw new Error(
          `constraints sized ${String(constraints.barrierS.length)}/${String(constraints.speedCapMps.length)} < store count ${String(count)}`,
        );
      }
    }

    // 1. Snapshot for interpolated rendering (F1 prev/curr contract).
    for (let i = 0; i < count; i += 1) {
      store.prevS[i] = f64At(store.s, i);
      store.prevSpeed[i] = f64At(store.speed, i);
    }
    this.tick += 1;

    // 2. Front-to-back order: chain ascending, s descending, id ascending.
    const chainOfEntity = this.chainOfEntity;
    const order = this.order;
    order.length = count;
    for (let i = 0; i < count; i += 1) {
      chainOfEntity[i] = i32At(this.chainIdOfMovement, i32At(store.pathIndex, i));
      order[i] = i;
    }
    order.sort((a, b) => {
      const chainDelta = i32At(chainOfEntity, a) - i32At(chainOfEntity, b);
      if (chainDelta !== 0) return chainDelta;
      const sDelta = f64At(store.s, b) - f64At(store.s, a);
      if (sDelta !== 0) return sDelta;
      return i32At(store.entityId, a) - i32At(store.entityId, b);
    });

    // 3. Movement pass, chain by chain, leader first.
    const lastSame = this.lastSameOfMovement;
    const departures: DepartureRecord[] = [];
    const departingIndices: number[] = [];
    let currentChain = -1;
    let stopLineS = 0;
    let prevInChain = -1;

    for (let k = 0; k < count; k += 1) {
      const i = itemAt(order, k);
      const mIdx = i32At(store.pathIndex, i);
      const chain = i32At(chainOfEntity, i);
      if (chain !== currentChain) {
        currentChain = chain;
        lastSame.fill(-1);
        prevInChain = -1;
        stopLineS = itemAt(movements, mIdx).stopLineS; // shared by the lane's movements
      }

      // Leader: nearest qualifying car ahead (see module doc).
      let leader: LeaderState | null = null;
      const sameIdx = i32At(lastSame, mIdx);
      if (sameIdx >= 0) {
        leader = {
          s: f64At(store.s, sameIdx),
          speed: f64At(store.speed, sameIdx),
          length: f64At(store.carLengthMeters, sameIdx),
        };
      }
      if (prevInChain >= 0) {
        const prevS = f64At(store.s, prevInChain);
        const prevLen = f64At(store.carLengthMeters, prevInChain);
        if (prevS - prevLen <= stopLineS) {
          // Rear bumper still on the shared approach segment.
          if (leader === null || prevS < leader.s) {
            leader = { s: prevS, speed: f64At(store.speed, prevInChain), length: prevLen };
          }
        }
      }
      lastSame[mIdx] = i;
      prevInChain = i;

      const movement = itemAt(movements, mIdx);
      const cruise = this.config.arms[movement.arm].cruiseSpeedMps;
      const barrierS = constraints !== undefined ? f64At(constraints.barrierS, i) : Infinity;
      const speedCap = constraints !== undefined ? f64At(constraints.speedCapMps, i) : Infinity;

      const v = f64At(store.speed, i);
      const x = f64At(store.s, i);
      // Turn-ahead profile (R1 §3.1 step 2: v_path_max = min(v_c, v_turn_ahead)
      // from F3 path data), evaluated at this tick's travel midpoint
      // (x + (v + v1)/2·dt; a naive end-of-tick evaluation overshoots the
      // per-tick drop). The profile is a comfort device, so it is additionally
      // floored at v − b·dt: tracking it may never demand more than one tick
      // of comfortable deceleration (the b_e envelope in the model carries the
      // collision-safety side; this carries the comfort side).
      const b = params.comfortableDecelMps2;
      let travelSpeed = v; // iter 0 evaluates the full projection x + v·dt
      let turnCap = Infinity;
      for (let iter = 0; iter < 2; iter += 1) {
        turnCap = turnAheadCapMps(movement, x + ((v + travelSpeed) / 2) * this.dt, b);
        travelSpeed = Math.min(v, turnCap);
      }

      const out = this.model.step({
        s: x,
        speed: v,
        dt: this.dt,
        cruiseSpeedMps: cruise,
        // The one-tick comfort floor applies to the TURN profile only (a
        // comfort device, F4). External F5 safety caps — the Krauss safe
        // speed toward a cross-movement car on a shared exit lane — must
        // bind at full authority: flooring them would let a fast follower
        // track v_safe only at comfortable-b and under-run the guarantee
        // when the gap closes quickly (through car behind a slow merger).
        pathSpeedCapMps: Math.min(Math.max(turnCap, v - b * this.dt), speedCap),
        leader,
        barrierS,
        params,
      });
      if (out.clamped) this.clampCount += 1;
      if (out.safeCapBound) this.safeCapBindCount += 1;
      if (out.headwayCapBound) this.headwayCapBindCount += 1;

      let s1 = out.s1;
      if (s1 >= movement.lengthMeters) {
        // Trip complete: clamp to the path end and collect for removal.
        s1 = movement.lengthMeters;
        departingIndices.push(i);
        departures.push({
          entityId: i32At(store.entityId, i),
          pathIndex: mIdx,
          tick: this.tick,
          timeSeconds: this.time + this.dt,
          exitSpeedMps: out.speed1,
        });
      }
      store.s[i] = s1;
      store.speed[i] = out.speed1;
    }

    // 4. Remove departed cars (descending index keeps swap-removes stable).
    if (departingIndices.length > 0) {
      departingIndices.sort((a, b) => b - a);
      for (const index of departingIndices) store.removeAt(index);
    }

    this.time += this.dt;
    this.departures = departures;
    return departures;
  }

  /**
   * Interpolated render pose of the car at dense `index`:
   * alpha = 0 → previous tick, alpha = 1 → current tick (F1 contract).
   */
  carPose(index: number, alpha: number): CarPose {
    const store = this.store;
    const movement = itemAt(this.geometry.movements, i32At(store.pathIndex, index));
    const prev = sampleAtS(movement.samples, f64At(store.prevS, index));
    const curr = sampleAtS(movement.samples, f64At(store.s, index));
    const hx = prev.hx + (curr.hx - prev.hx) * alpha;
    const hy = prev.hy + (curr.hy - prev.hy) * alpha;
    const norm = Math.sqrt(hx * hx + hy * hy);
    return {
      x: prev.x + (curr.x - prev.x) * alpha,
      y: prev.y + (curr.y - prev.y) * alpha,
      hx: hx / norm,
      hy: hy / norm,
      speedMps:
        f64At(store.prevSpeed, index) + (f64At(store.speed, index) - f64At(store.prevSpeed, index)) * alpha,
    };
  }
}

export function createCarWorld(
  geometry: IntersectionGeometry,
  config: IntersectionConfig,
  options: CarWorldOptions = {},
): CarWorld {
  return new CarWorld(geometry, config, options);
}

/**
 * v_turn_ahead (R1 §3.1 step 2) from F3 path data: the comfortable-b
 * slow-down profile toward v_t before the turn curve, v_t through it, and
 * unrestricted (caller mins with v_c) after:
 *   s' < curveStart: sqrt(v_t² + 2b·(curveStart − s'))
 *   curveStart ≤ s' ≤ curveEnd: v_t
 *   s' > curveEnd: Infinity (accelerate back out; IDM free term does that)
 * Straight/aligned through paths have v_t = v_c, so the profile never binds.
 */
function turnAheadCapMps(movement: MovementGeometry, projectedS: number, b: number): number {
  const vT = movement.turnSpeedMps;
  if (projectedS < movement.curveStartS) {
    const distance = movement.curveStartS - projectedS;
    return Math.sqrt(vT * vT + 2 * b * distance);
  }
  if (projectedS <= movement.curveEndS) return vT;
  return Infinity;
}
