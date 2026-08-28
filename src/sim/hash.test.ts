/**
 * Hash semantics tests (task F4; construction per R2 Part C: dual 32-bit
 * imul lanes, Q10 quantization, −0 normalization, non-finite rejection).
 */
import { describe, expect, it } from 'vitest';
import { DualLaneDigest, hashCarStore } from './hash';
import { CarStore } from './store';

describe('DualLaneDigest', () => {
  it('is deterministic across instances for the same word sequence', () => {
    const a = new DualLaneDigest(42);
    const b = new DualLaneDigest(42);
    for (const w of [0, 1, -1, 0x7fffffff, -0x80000000, 123456789]) {
      a.word(w);
      b.word(w);
    }
    expect(a.hex()).toBe(b.hex());
    expect(a.hex()).toMatch(/^[0-9a-f]{8}:[0-9a-f]{8}$/);
  });

  it('depends on the seed and on the words', () => {
    const h1 = new DualLaneDigest(1);
    const h2 = new DualLaneDigest(2);
    h1.word(7);
    h2.word(7);
    expect(h1.hex()).not.toBe(h2.hex());
    const h3 = new DualLaneDigest(1);
    h3.word(8);
    expect(h3.hex()).not.toBe(h1.hex());
  });

  it('normalizes −0 and rejects non-finite values', () => {
    const negZero = new DualLaneDigest();
    negZero.quantized10(-0);
    const posZero = new DualLaneDigest();
    posZero.quantized10(0);
    expect(negZero.hex()).toBe(posZero.hex());

    expect(() => new DualLaneDigest().quantized10(Number.NaN)).toThrow();
    expect(() => new DualLaneDigest().quantized10(Number.POSITIVE_INFINITY)).toThrow();
  });

  it('quantizes at Q10 (1/1024 shifts the hash)', () => {
    const a = new DualLaneDigest();
    a.quantized10(1.0);
    const b = new DualLaneDigest();
    b.quantized10(1.0 + 1 / 1024);
    expect(a.hex()).not.toBe(b.hex());
    // Below one Q10 step: same word.
    const c = new DualLaneDigest();
    c.quantized10(1.0 + 0.5 / 1024);
    expect(c.hex()).toBe(a.hex());
  });
});

describe('hashCarStore', () => {
  // addCar validates pathIndex against the movements array; two entries suffice.
  const movements = [{ id: 'a' }, { id: 'b' }] as never as never[];

  it('identical stores hash identically; any component change flips the hash', () => {
    const x = new CarStore(4);
    x.addCar({ pathIndex: 1, s: 12.5, speed: 3.25, carLengthMeters: 5 }, 0, movements);
    const y = new CarStore(4);
    y.addCar({ pathIndex: 1, s: 12.5, speed: 3.25, carLengthMeters: 5 }, 0, movements);
    expect(hashCarStore(x, 7, [0, 0, 0])).toBe(hashCarStore(y, 7, [0, 0, 0]));

    y.speed[0] = 3.25 + 2 / 1024;
    expect(hashCarStore(x, 7, [0, 0, 0])).not.toBe(hashCarStore(y, 7, [0, 0, 0]));

    const z = new CarStore(4);
    z.addCar({ pathIndex: 1, s: 12.5, speed: 3.25, carLengthMeters: 5 }, 0, movements);
    z.addCar({ pathIndex: 0, s: 0, speed: 0, carLengthMeters: 5 }, 1, movements);
    expect(hashCarStore(z, 7)).not.toBe(hashCarStore(x, 7));
  });
});
