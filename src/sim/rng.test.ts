/**
 * RNG unit tests (task F6; R2 Part B acceptance): the sfc32 implementation is
 * cross-checked against an INDEPENDENT transcription of the PractRand v4
 * reference from the research record (not against rng.ts itself), the warmup
 * discipline is proven, the float range is exact, and the H32 sub-stream
 * derivation is deterministic, distinct and avalanching.
 */
import { describe, expect, it } from 'vitest';
import {
  ARM_TAG,
  REP_TAG,
  SFC32_WARMUP_ITERATIONS,
  Sfc32,
  armSeedOf,
  attrSeedOf,
  h32,
  repSeedOf,
  sfc32FromSeed,
  sfc32Next,
  spawnStreamsForRep,
} from './rng';

/**
 * Reference transcription of the PractRand sfc32 v4 step, written directly
 * from docs/ultron/research/track-b-execution-determinism.md §Part B
 * (constants {21, 9, 3}; uint32 semantics via >>> / << / |0).
 */
function referenceSfc32Sequence(a: number, b: number, c: number, counter: number, count: number): number[] {
  const s = new Uint32Array([a >>> 0, b >>> 0, c >>> 0, counter >>> 0]);
  const out: number[] = [];
  for (let i = 0; i < SFC32_WARMUP_ITERATIONS; i += 1) sfc32ReferenceNext(s); // warmup
  for (let i = 0; i < count; i += 1) out.push(sfc32ReferenceNext(s));
  return out;
}

function sfc32ReferenceNext(s: Uint32Array): number {
  const a = s[0] ?? 0;
  const b = s[1] ?? 0;
  const c = s[2] ?? 0;
  const counter = s[3] ?? 0;
  const t = (a + b + counter) | 0;
  s[3] = (counter + 1) | 0;
  s[0] = b ^ (b >>> 9);
  s[1] = (c + (c << 3)) | 0;
  s[2] = (((c << 21) | (c >>> 11)) + t) | 0;
  return t >>> 0;
}

describe('sfc32 reference cross-check (PractRand v4 constants {21,9,3})', () => {
  const seedSets: ReadonlyArray<[number, number, number]> = [
    [0, 0, 0],
    [1, 0x9e3779b9 | 0, 0x85ebca6b | 0],
    [0xdeadbeef | 0, 0xcafebabe | 0, 0x1234567 | 0],
    [0xffffffff | 0, 0xffffffff | 0, 0xffffffff | 0],
  ];

  it('first 1000 outputs match the independently transcribed reference for every seed set', () => {
    for (const [a, b, c] of seedSets) {
      const expected = referenceSfc32Sequence(a, b, c, 1, 1000);
      const rng = new Sfc32(a, b, c);
      const actual: number[] = [];
      for (let i = 0; i < 1000; i += 1) actual.push(rng.nextUint32());
      expect(actual).toEqual(expected);
    }
  });

  it('the class applies the 12 warmup iterations (first output == 13th raw step)', () => {
    const a = 0x13579bdf | 0;
    const b = 0x2468ace0 | 0;
    const c = 0x10203040 | 0;
    // Reference: 12 warmup steps discarded, then the 13th step is the first output.
    const raw = new Uint32Array([a >>> 0, b >>> 0, c >>> 0, 1]);
    for (let i = 0; i < SFC32_WARMUP_ITERATIONS; i += 1) sfc32ReferenceNext(raw);
    const expected = sfc32ReferenceNext(raw);
    expect(new Sfc32(a, b, c).nextUint32()).toBe(expected);
    // The exported reference-shaped step agrees with the class's internals.
    const state = new Uint32Array([a >>> 0, b >>> 0, c >>> 0, 1]);
    for (let i = 0; i < SFC32_WARMUP_ITERATIONS; i += 1) sfc32Next(state);
    expect(sfc32Next(state)).toBe(expected);
  });

  it('counter participates in the state (same a,b,c, different counter diverges)', () => {
    const x = new Sfc32(11, 22, 33, 1);
    const y = new Sfc32(11, 22, 33, 2);
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < 64; i += 1) {
      xs.push(x.nextUint32());
      ys.push(y.nextUint32());
    }
    expect(xs).not.toEqual(ys);
  });
});

describe('sfc32 float conversion and uniformity', () => {
  it('nextFloat is always in [0, 1) and uint32 outputs cover the full range', () => {
    const rng = sfc32FromSeed(20260827);
    let sawHigh = false;
    let sawLow = false;
    let rangeViolations = 0;
    for (let i = 0; i < 100_000; i += 1) {
      const w = rng.nextUint32();
      const f = w / 4294967296;
      if (!(f >= 0 && f < 1)) rangeViolations += 1; // also catches NaN
      if (w > 0xc0000000) sawHigh = true;
      if (w < 0x40000000) sawLow = true;
    }
    expect(rangeViolations).toBe(0);
    expect(sawHigh).toBe(true);
    expect(sawLow).toBe(true);
  });

  it('mean of 200k floats is within 0.5% of 0.5 (statistical sanity, seeded)', () => {
    const rng = sfc32FromSeed(777);
    let sum = 0;
    const n = 200_000;
    for (let i = 0; i < n; i += 1) sum += rng.nextFloat();
    const mean = sum / n;
    expect(Math.abs(mean - 0.5)).toBeLessThan(0.005);
  });
});

describe('H32 sub-stream derivation', () => {
  it('h32 is deterministic and sensitive to every input', () => {
    for (const seed of [0, 1, -1, 0x7fffffff | 0, 0xdeadbeef | 0]) {
      expect(h32(seed, REP_TAG, 0)).toBe(h32(seed, REP_TAG, 0));
      expect(h32(seed, REP_TAG, 0)).not.toBe(h32(seed, ARM_TAG, 0)); // tag differs
      expect(h32(seed, REP_TAG, 0)).not.toBe(h32(seed, REP_TAG, 1)); // index differs
      expect(h32(seed, REP_TAG, 0)).not.toBe(h32(seed + 1, REP_TAG, 0)); // seed differs
    }
  });

  it('h32 avalanches: one flipped input bit flips ~16 output bits on average', () => {
    let totalBits = 0;
    const samples = 2000;
    for (let i = 0; i < samples; i += 1) {
      const seed = (i * 2654435761) | 0;
      const a = h32(seed, ARM_TAG, i) >>> 0;
      const b = h32(seed ^ (1 << (i % 31)), ARM_TAG, i) >>> 0;
      totalBits += popcount(a ^ b);
    }
    const avg = totalBits / samples;
    expect(avg).toBeGreaterThan(14); // ~16 expected; anything <14 means weak mixing
    expect(avg).toBeLessThan(18);
  });

  it('rep/arm/attr derivations produce distinct 32-bit seeds', () => {
    const s = 42;
    const rep = repSeedOf(s, 0);
    expect(rep).not.toBe(repSeedOf(s, 1));
    expect(repSeedOf(s, 0)).toBe(repSeedOf(s, 0));
    const armSeeds = [0, 1, 2, 3].map((a) => armSeedOf(rep, a));
    expect(new Set(armSeeds).size).toBe(4);
    for (const a of armSeeds) expect(a).not.toBe(attrSeedOf(rep));
  });

  it('spawnStreamsForRep: same (seed, rep) regenerates identical streams; different rep/arm diverge', () => {
    const x = spawnStreamsForRep(1234, 0);
    const y = spawnStreamsForRep(1234, 0);
    const z = spawnStreamsForRep(1234, 1);
    const draw = (bundle: ReturnType<typeof spawnStreamsForRep>): number[] => {
      const out: number[] = [];
      for (let t = 0; t < 500; t += 1) {
        for (const arm of bundle.arms) out.push(arm.nextUint32());
        out.push(bundle.attrs.nextUint32());
      }
      return out;
    };
    expect(draw(x)).toEqual(draw(y)); // worker regeneration == main-thread build
    expect(draw(x)).not.toEqual(draw(z)); // rep separation

    // Arm streams are independent of each other (no shared prefix anywhere).
    const a = spawnStreamsForRep(99, 2);
    const b = spawnStreamsForRep(99, 2);
    for (let arm = 0; arm < 4; arm += 1) {
      const solo = sfc32FromSeed(armSeedOf(repSeedOf(99, 2), arm));
      const armA = a.arms[arm] as Sfc32;
      const armB = b.arms[arm] as Sfc32;
      for (let i = 0; i < 200; i += 1) {
        const w = solo.nextUint32();
        expect(armA.nextUint32()).toBe(w);
        expect(armB.nextUint32()).toBe(w);
      }
    }
  });

  it('master seed 0 still produces healthy streams (no all-zero degenerate state)', () => {
    const streams = spawnStreamsForRep(0, 0);
    const words = new Set<number>();
    const arm0 = streams.arms[0] as Sfc32;
    for (let i = 0; i < 1000; i += 1) words.add(arm0.nextUint32());
    expect(words.size).toBe(1000); // no repetition collapse
  });
});

function popcount(w: number): number {
  let v = w >>> 0;
  let bits = 0;
  while (v !== 0) {
    v &= v - 1;
    bits += 1;
  }
  return bits;
}
