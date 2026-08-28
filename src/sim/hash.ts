/**
 * Deterministic hashing for sim state (task F4; the R2 Part C run-hash
 * construction, scoped down to store state).
 *
 * Rolling 64-bit digest as two 32-bit lanes mixed with `Math.imul` (no BigInt
 * per element): per 32-bit word `w`,
 *   h0 = imul(h0 ^ w, 0x85ebca6b); h1 = imul(h1 ^ h0 ^ (h0 >>> 15), 0xc2b2ae35)
 * (MurmurHash3 finalizer constants — avalanche, not crypto). Words come from
 * Q10 quantization: `floor(value * 1024)` after `-0` normalization
 * (`x + 0`), with NaN/±Infinity asserted — R2 rules 4 and 6.
 */
import { f64At, i32At } from './store';

export class DualLaneDigest {
  private h0: number;
  private h1: number;

  constructor(seed: number = 0) {
    // Splitmix-style lane init from the seed (imul/xor/shift only).
    let z = (seed | 0) ^ 0x9e3779b9;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    this.h0 = z | 0;
    this.h1 = Math.imul(z ^ (z >>> 16), 0x27d4eb2f) | 0;
  }

  /** Absorb one int32 word. */
  word(w: number): void {
    this.h0 = Math.imul(this.h0 ^ (w | 0), 0x85ebca6b) | 0;
    this.h1 = Math.imul(this.h1 ^ this.h0 ^ (this.h0 >>> 15), 0xc2b2ae35) | 0;
  }

  /** Absorb a float quantized to Q10 fixed point (floor(x * 1024)). */
  quantized10(value: number): void {
    if (!Number.isFinite(value)) {
      throw new Error(`cannot hash non-finite value: ${String(value)}`);
    }
    const normalized = value + 0; // -0 + +0 → +0 (R2 Part C rule 4)
    this.word(Math.floor(normalized * 1024));
  }

  /** Hex form `h0:h1` (8 hex digits each). */
  hex(): string {
    return `${(this.h0 >>> 0).toString(16).padStart(8, '0')}:${(this.h1 >>> 0).toString(16).padStart(8, '0')}`;
  }
}

/**
 * Hash of a car store's full state (the F4 determinism acceptance: same
 * inputs ⇒ identical hash). Field order is pinned: tick, count, then per
 * entity in dense index order (id, pathIndex, sQ10, speedQ10, lengthQ10).
 * Counters (clamp/cap binds) are folded in after the entities.
 */
export function hashCarStore(
  store: {
    readonly count: number;
    readonly entityId: Int32Array;
    readonly pathIndex: Int32Array;
    readonly s: Float64Array;
    readonly speed: Float64Array;
    readonly carLengthMeters: Float64Array;
  },
  tick: number,
  counters: readonly number[] = [],
): string {
  const digest = new DualLaneDigest(0x5f3759df);
  digest.word(tick | 0);
  digest.word(store.count);
  for (let i = 0; i < store.count; i += 1) {
    digest.word(i32At(store.entityId, i));
    digest.word(i32At(store.pathIndex, i));
    digest.quantized10(f64At(store.s, i));
    digest.quantized10(f64At(store.speed, i));
    digest.quantized10(f64At(store.carLengthMeters, i));
  }
  for (const counter of counters) digest.word(counter | 0);
  return digest.hex();
}
