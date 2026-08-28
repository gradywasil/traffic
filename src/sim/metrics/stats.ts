/**
 * Pure aggregation helpers for the metrics engine (task F7).
 *
 * Determinism (R2 Part C): IEEE-exact ops only (+ − × /, comparisons,
 * floor/ceil/min/max); sorting is a numeric ascending comparator over a
 * fresh copy (input order never leaks, equal values are interchangeable).
 */
import { itemAt } from '../../geom';

/** Arithmetic mean, or `null` for an empty sample (U3 renders "no data"). */
export function meanOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

/** Ascending-sorted copy; never mutates the input. */
export function sortedAscending(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

/**
 * Percentile of an ASCENDING-sorted sample by linear interpolation:
 * `k = fraction·(n−1)` clamped to [0, n−1]; result interpolates between the
 * floor and ceil neighbors. fraction is clamped to [0, 1]. `null` when
 * empty. (Deterministic; no dependence on original sample order.)
 */
export function percentileOfSorted(sorted: readonly number[], fraction: number): number | null {
  const n = sorted.length;
  if (n === 0) return null;
  if (n === 1) return itemAt(sorted, 0);
  const clamped = Math.max(0, Math.min(1, fraction));
  const k = clamped * (n - 1);
  const lo = Math.floor(k);
  const hi = Math.ceil(k);
  const a = itemAt(sorted, lo);
  const b = itemAt(sorted, hi);
  return a + (b - a) * (k - lo);
}
