/**
 * Guarded IDM model-level tests (task F4) — hand-computed expectations from
 * research R1 §3.1 formulas at the committed constants
 * (v_c=13.9, T=1.1, a=1.3, b=2.0, s0=2.0, delta=4, b_e=6.0, s_min=0.5).
 */
import { describe, expect, it } from 'vitest';
import type { ModelParams } from '../config';
import { DEFAULT_MODEL_PARAMS } from '../config/defaults';
import { guardedIdmModel, powBySquare } from './following';
import type { CarFollowInput, LeaderState } from './following';

const P: ModelParams = DEFAULT_MODEL_PARAMS;
const DT = 0.1;

function input(overrides: Partial<CarFollowInput> = {}): CarFollowInput {
  return {
    s: 0,
    speed: 0,
    dt: DT,
    cruiseSpeedMps: P.cruiseSpeedMps,
    pathSpeedCapMps: P.cruiseSpeedMps,
    leader: null,
    barrierS: Infinity,
    params: P,
    ...overrides,
  };
}

function stoppedLeader(gap: number): LeaderState {
  return { s: gap + P.carLengthMeters, speed: 0, length: P.carLengthMeters };
}

describe('powBySquare (banned-pow replacement)', () => {
  it('computes exact integer powers', () => {
    expect(powBySquare(0.5, 4)).toBe(0.0625);
    expect(powBySquare(2, 10)).toBe(1024);
    expect(powBySquare(1.5, 1)).toBe(1.5);
    expect(powBySquare(13.9, 0)).toBe(1);
    expect(powBySquare(13.9, 4)).toBeCloseTo(13.9 ** 4, 9);
  });
});

describe('IDM desired acceleration (R1 §3.1 step 1)', () => {
  it('free acceleration from rest is exactly a·dt on the first tick', () => {
    const out = guardedIdmModel.step(input({ speed: 0 }));
    expect(out.speed1).toBeCloseTo(P.maxAccelerationMps2 * DT, 15);
    expect(out.clamped).toBe(false);
  });

  it('is zero at platoon equilibrium (hand-solved gap)', () => {
    const v = 12;
    const freeTerm = 1 - (v / P.cruiseSpeedMps) ** 4;
    const sStar = P.minGapMeters + v * P.timeHeadwaySeconds; // dv = 0
    const gap = sStar / Math.sqrt(freeTerm);
    const out = guardedIdmModel.step(input({ speed: v, leader: { s: gap + 5, speed: v, length: 5 } }));
    expect(out.speed1).toBeCloseTo(v, 9);
    expect(out.safeCapBound).toBe(false);
    expect(out.headwayCapBound).toBe(false);
  });

  it('matches the hand-computed value behind a slow leader at crawl', () => {
    // v=1, stopped leader at gap 3: a_idm = a·(free − (sStar/g)²) ≈ −0.3797.
    const out = guardedIdmModel.step(input({ speed: 1, leader: stoppedLeader(3) }));
    const rootAB = Math.sqrt(P.maxAccelerationMps2 * P.comfortableDecelMps2);
    const sStar = P.minGapMeters + 1 * P.timeHeadwaySeconds + (1 * 1) / (2 * rootAB);
    const expected = 1 + P.maxAccelerationMps2 * (1 - (1 / P.cruiseSpeedMps) ** 4 - (sStar / 3) ** 2) * DT;
    expect(out.speed1).toBeCloseTo(expected, 9);
    // v_headway = (3 − 0.5)/0.1 − 0.3 = 24.7 — dominated by v_safe (4.877) at
    // committed constants (the record's own §3.2 note: both caps documented,
    // v_safe binds first here).
    expect(out.headwayCapBound).toBe(false);
  });
});

describe('layer-2 safe caps (R1 §3.1 step 3)', () => {
  it('v_safe binds against a stopped leader: sqrt(v_l² + 2·b_e·(g − s_min)) − b_e·dt', () => {
    const gap = 10;
    const out = guardedIdmModel.step(input({ speed: 13.9, leader: stoppedLeader(gap) }));
    const expected = Math.sqrt(2 * P.emergencyDecelMps2 * (gap - P.hardMinGapMeters)) - P.emergencyDecelMps2 * DT;
    expect(out.speed1).toBeCloseTo(expected, 12);
    expect(out.safeCapBound).toBe(true);
    expect(out.clamped).toBe(false);
  });

  it('caps never push speed negative (standstill stays standstill)', () => {
    const out = guardedIdmModel.step(input({ speed: 0, leader: stoppedLeader(P.hardMinGapMeters) }));
    expect(out.speed1).toBe(0);
    expect(out.s1).toBe(0);
    expect(out.clamped).toBe(false);
  });
});

describe('stop-within-tick fixup (R1 §3.1 step 4)', () => {
  it('stops exactly v²/(2·b_e) into the tick, speed 0, never backward', () => {
    // v=0.5 behind a stopped leader at gap 1.0 commands a_idm < −b_e, so
    // aApplied = −b_e and v + a·dt < 0 → the fixup branch.
    const out = guardedIdmModel.step(input({ speed: 0.5, leader: stoppedLeader(1.0) }));
    expect(out.speed1).toBe(0);
    expect(out.s1).toBeCloseTo((0.5 * 0.5) / (2 * P.emergencyDecelMps2), 12);
    expect(out.clamped).toBe(false);
  });
});

describe('terminal clamp (R1 §3.1 step 6 — the invariant)', () => {
  it('clamps an over-speed car to gap = s_min and derives speed from displacement', () => {
    const gap = 0.6;
    const out = guardedIdmModel.step(input({ speed: 20, pathSpeedCapMps: 20, cruiseSpeedMps: 20, leader: stoppedLeader(gap) }));
    expect(out.clamped).toBe(true);
    expect(out.s1).toBeCloseTo(gap - P.hardMinGapMeters, 12);
    expect(out.speed1).toBeCloseTo(out.s1 / DT, 12);
    const newGap = gap + P.carLengthMeters - P.carLengthMeters - out.s1;
    expect(newGap).toBeCloseTo(P.hardMinGapMeters, 12);
  });

  it('never moves backward and ignores a barrier behind the front bumper', () => {
    const out = guardedIdmModel.step(input({ s: 10, speed: 5, barrierS: 9.9 }));
    expect(out.s1).toBeGreaterThan(10);
    expect(out.speed1).toBeGreaterThan(5);
    expect(out.clamped).toBe(false);
  });
});

describe('barrier = virtual stopped leader (R1 §3.1 leader rule a)', () => {
  it('a car at cruise parks ~s0 before the barrier and never crosses barrier − s_min', () => {
    const barrier = 100;
    let x = 0;
    let v = 13.9;
    let clamped = false;
    for (let t = 0; t < 1200; t += 1) {
      const out = guardedIdmModel.step(input({ s: x, speed: v, barrierS: barrier }));
      x = out.s1;
      v = out.speed1;
      clamped ||= out.clamped;
      expect(x).toBeLessThanOrEqual(barrier - P.hardMinGapMeters + 1e-9);
    }
    expect(v).toBeLessThan(0.1);
    expect(barrier - x).toBeGreaterThanOrEqual(P.hardMinGapMeters);
    expect(barrier - x).toBeLessThanOrEqual(P.minGapMeters + 0.75); // parks ≈ s0
    expect(clamped).toBe(false); // layers 1–2 suffice (R1 §3.2)
  });

  it('emergency envelope: a late-erected barrier is brake-steered, not crossed', () => {
    // Barrier 5 m ahead at full speed: comfortable stop impossible (needs
    // 24.1 m) but the b_e envelope (16.1 m) ... 5 < 16.1, so even b_e cannot
    // stop before it — the car must cross. The model may not go backward.
    let x = 0;
    let v = 13.9;
    for (let t = 0; t < 60; t += 1) {
      const out = guardedIdmModel.step(input({ s: x, speed: v, barrierS: 5 }));
      expect(out.s1).toBeGreaterThanOrEqual(x - 1e-12);
      x = out.s1;
      v = out.speed1;
    }
  });
});
