/**
 * Guarded IDM car-following model (task F4) — research R1 §3.1 verbatim.
 *
 * Three layers (record D1):
 *  1. IDM desired acceleration (Treiber/Hennecke/Helbing 2000), ballistic
 *     integration at the fixed dt = 0.1 s;
 *  2. bounded-deceleration safe-speed caps (Krauss/SUMO lineage):
 *     `v_safe` (high-speed regime) + `v_headway` (low-speed/crawl regime),
 *     applied every tick against EVERY interaction candidate;
 *  3. terminal gap clamp to `s_min` — the unconditional no-overlap invariant
 *     (front-to-back induction, R1 §3.2 theorem 1); firing is counted and
 *     asserted 0 in normal operation.
 *
 * Interaction candidates: at most one real leader (nearest car ahead on the
 * follower's path chain — same movement, or same lane on the shared approach
 * segment up to the stop line) plus one point barrier (virtual stopped leader,
 * length 0 — R1 §3.1 leader rule (a)). The most restrictive candidate wins
 * each layer; the terminal clamp is applied against all of them.
 *
 * Determinism (R2 Part C): only IEEE-exact ops + `sqrt`. The IDM free term
 * `(v/v_c)^delta` uses exponentiation-by-squaring over the integer exponent
 * (committed delta = 4) — `Math.pow` is banned in sim core.
 *
 * Swappability (plan F4 risk note): the model sits behind `CarFollowModel`;
 * the world (world.ts) is the only consumer.
 */
import type { ModelParams } from '../config';

/** A leader's final state for this tick (already updated — chain order). */
export interface LeaderState {
  /** Front-bumper arc length of the leader on the shared path frame. */
  readonly s: number;
  /** Leader's speed this tick (m/s). */
  readonly speed: number;
  /** Leader's car length (m). */
  readonly length: number;
}

export interface CarFollowInput {
  /** Follower front-bumper arc length on its assigned path. */
  readonly s: number;
  /** Follower speed (m/s), >= 0. */
  readonly speed: number;
  /** Fixed timestep (s) — committed 0.1. */
  readonly dt: number;
  /** v_c of the follower's arm (IDM free term). */
  readonly cruiseSpeedMps: number;
  /** v_path_max = min(v_c, turn-ahead profile, external speed cap) — R1 §3.1 step 2. */
  readonly pathSpeedCapMps: number;
  /** Real leader, or null on an empty chain. */
  readonly leader: LeaderState | null;
  /**
   * Point barrier: virtual stopped leader of length 0 at this arc position
   * (red light / stop-sign hold / denied claim — the F5 seam). `Infinity`
   * (or any position at/behind the follower) = inactive.
   */
  readonly barrierS: number;
  readonly params: ModelParams;
}

export interface CarFollowOutput {
  /** New front-bumper position. */
  readonly s1: number;
  /** New speed (m/s), >= 0, consistent with the actual displacement. */
  readonly speed1: number;
  /** Layer 3 fired (counted; must stay 0 in normal presets). */
  readonly clamped: boolean;
  /** Layer-2 `v_safe` was the binding constraint this tick. */
  readonly safeCapBound: boolean;
  /** Layer-2 `v_headway` was the binding constraint this tick. */
  readonly headwayCapBound: boolean;
}

/** The swappable car-following interface (plan F4: "model swappable behind one interface"). */
export interface CarFollowModel {
  readonly name: string;
  step(input: CarFollowInput): CarFollowOutput;
}

/**
 * Integer exponentiation by squaring (deterministic replacement for the banned
 * `Math.pow`): `base**trunc(exponent)` for exponent >= 1, else 1. The
 * committed IDM exponent is the integer 4 (R1 §3.1); non-integer configs are
 * truncated, which is documented behavior, not silent pow.
 */
export function powBySquare(base: number, exponent: number): number {
  const e = Math.trunc(exponent);
  if (!(e > 0)) return 1;
  let result = 1;
  let factor = base;
  let remaining = e;
  while (remaining > 0) {
    if ((remaining & 1) === 1) result *= factor;
    remaining >>>= 1;
    if (remaining > 0) factor *= factor;
  }
  return result;
}

/**
 * IDM desired acceleration (R1 §3.1 step 1):
 *   a_idm = a·[ 1 − (v/v_c)^delta − (sStar/g)² ],
 *   sStar = s0 + max(0, v·T + v·dv/(2·sqrt(a·b))),  dv = v − v_leader.
 * `gap === null` = free traffic (interaction term dropped).
 */
export function idmAcceleration(
  v: number,
  cruiseSpeedMps: number,
  params: ModelParams,
  gap: number | null,
  leaderSpeed: number,
): number {
  const freeTerm = 1 - powBySquare(v / cruiseSpeedMps, params.accelerationExponent);
  if (gap === null) return params.maxAccelerationMps2 * freeTerm;
  const dv = v - leaderSpeed;
  const rootAB = Math.sqrt(params.maxAccelerationMps2 * params.comfortableDecelMps2);
  const sStar =
    params.minGapMeters +
    Math.max(0, v * params.timeHeadwaySeconds + (v * dv) / (2 * rootAB));
  const g = Math.max(gap, 1e-6); // degenerate-overlap guard (state is caller's job)
  const ratio = sStar / g;
  return params.maxAccelerationMps2 * (freeTerm - ratio * ratio);
}

/** The committed Guarded IDM (R1 §3.1 steps 1–6, exactly). */
export const guardedIdmModel: CarFollowModel = {
  name: 'guarded-idm',
  step(input: CarFollowInput): CarFollowOutput {
    const { s: x, speed: v, dt } = input;
    const p = input.params;
    const bE = p.emergencyDecelMps2;
    const sMin = p.hardMinGapMeters;
    const cap = Math.min(input.cruiseSpeedMps, input.pathSpeedCapMps);

    const leader = input.leader;
    const leaderGap = leader === null ? null : leader.s - leader.length - x;
    // A barrier only interacts while strictly ahead of the front bumper (R1:
    // a passed stop line / zone is not re-erected behind the car).
    const barrierGap =
      input.barrierS > x && Number.isFinite(input.barrierS) ? input.barrierS - x : null;

    // --- 1. IDM desired acceleration: most restrictive candidate -----------
    let aDesired = idmAcceleration(v, input.cruiseSpeedMps, p, null, 0);
    if (leaderGap !== null && leader !== null) {
      aDesired = Math.min(aDesired, idmAcceleration(v, input.cruiseSpeedMps, p, leaderGap, leader.speed));
    }
    if (barrierGap !== null) {
      aDesired = Math.min(aDesired, idmAcceleration(v, input.cruiseSpeedMps, p, barrierGap, 0));
    }
    // b_e is the hard bound on commanded deceleration, every tick (R1 §3.1).
    const aApplied = Math.max(aDesired, -bE);

    // --- 2. ballistic candidate --------------------------------------------
    let v1 = Math.min(Math.max(v + aApplied * dt, 0), cap);

    // --- 3. layer-2 safe caps, per candidate -------------------------------
    let safeCapBound = false;
    let headwayCapBound = false;
    const applyCaps = (gap: number, vLeader: number, vLeaderNext: number): void => {
      const vSafe = Math.max(0, Math.sqrt(vLeader * vLeader + 2 * bE * Math.max(0, gap - sMin)) - bE * dt);
      if (vSafe < v1) {
        v1 = vSafe;
        safeCapBound = true;
      }
      const vHeadway = Math.max(0, vLeaderNext + (gap - sMin) / dt - (bE * dt) / 2);
      if (vHeadway < v1) {
        v1 = vHeadway;
        headwayCapBound = true;
      }
    };
    if (leaderGap !== null && leader !== null) {
      applyCaps(leaderGap, leader.speed, leader.speed); // leader.speed is already final (chain order)
    }
    if (barrierGap !== null) applyCaps(barrierGap, 0, 0);

    // --- 4/5. position (ballistic, with stop-within-tick fixup) -------------
    let x1: number;
    if (v + aApplied * dt < 0) {
      // Stop within the interval at constant decel (Treiber's fixup); the
      // displacement v²/(2|aApplied|) is forward and < v·dt by branch condition.
      v1 = 0;
      x1 = x - (v * v) / (2 * aApplied);
    } else {
      x1 = x + ((v + v1) / 2) * dt;
    }

    // The terminal limits for this tick (computed before the clamp so the
    // stop-within-tick fixup can complete its stop exactly AT the limit —
    // the safe envelope's intended endpoint in the deep-crawl regime, not a
    // clamp anomaly).
    let xLimit = Infinity;
    if (leader !== null) xLimit = Math.min(xLimit, leader.s - leader.length - sMin);
    if (barrierGap !== null) xLimit = Math.min(xLimit, input.barrierS - sMin);
    if (x1 > xLimit && xLimit >= x && v1 === 0) {
      // Stopping this tick anyway: shorten the stop to land exactly on the
      // limit (speed stays 0 — consistent with the displacement).
      x1 = xLimit;
    }

    // --- 6. terminal clamp (layer 3 — the invariant) ------------------------
    let clamped = false;
    if (x1 > xLimit && xLimit >= x) {
      x1 = xLimit; // xLimit >= x checked: never move backward (R1 §3.2 proof)
      v1 = Math.max(0, (x1 - x) / dt);
      clamped = true;
    }

    return { s1: x1, speed1: v1, clamped, safeCapBound, headwayCapBound };
  },
};
