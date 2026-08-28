/**
 * Chart scale + tick math (task U3, research R3): the pure, canvas-free
 * number utilities behind the hand-rolled rolling avg-wait chart —
 * nice-number y autoscale with a min-range clamp (the zero-range/all-zero
 * edge R3 pinned), fixed-x-window mm:ss tick selection, and label
 * formatters.
 *
 * Determinism: floor/ceil/min/max and division only (the R2 rulebook's
 * whitelisted ops), no logarithms — the decimal exponent for nice steps is
 * computed by repeated ×10/÷10, so the same input always produces the exact
 * same ticks and labels.
 */

/** A finished linear scale: bounded range plus the tick values inside it. */
export interface TickScale {
  readonly min: number;
  readonly max: number;
  readonly ticks: readonly number[];
}

/** Y bounds for an empty / all-null series (readable placeholder; P1-tunable). */
export const EMPTY_Y_SCALE: TickScale = { min: 0, max: 10, ticks: [0, 2, 4, 6, 8, 10] };

/** Smallest y span autoscale honors (flat / all-zero series guard, R3). */
export const MIN_Y_RANGE_SECONDS = 2;

/** Nice-number mantissas for tick steps (classic 1/2/5 × 10ⁿ). */
const NICE_MULTIPLIERS = [1, 2, 5] as const;

/** Relative slack for float fuzz at tick boundaries (steps stay ≤ ~10³ here). */
const EPSILON = 1e-9;

/** Largest exact power of ten ≤ |x|, via repeated scaling (no Math.log*). */
function pow10AtOrBelow(x: number): number {
  const magnitude = Math.abs(x);
  if (!(magnitude > 0) || !Number.isFinite(magnitude)) return 1;
  let pow = 1;
  while (pow * 10 <= magnitude && pow < 1e15) pow *= 10;
  while (pow > magnitude && pow > 1e-15) pow /= 10;
  return pow;
}

/**
 * Smallest nice step (1/2/5 × 10ⁿ) ≥ max(|rawStep|, minStep): rounding UP
 * keeps the tick count at or under the target instead of over it.
 */
export function niceStep(rawStep: number, minStep = 1e-9): number {
  const target = Math.max(Math.abs(rawStep), minStep);
  const pow = pow10AtOrBelow(target);
  for (const multiplier of NICE_MULTIPLIERS) {
    const candidate = multiplier * pow;
    if (candidate >= target) return candidate;
  }
  return 10 * pow; // mantissa in (5, 10) rounds up into the next decade
}

/** Tick values covering [min, max] at exact integer multiples of `step` (-0 normalized to +0). */
export function ticksInRange(min: number, max: number, step: number): number[] {
  if (!(step > 0)) return [];
  const ticks: number[] = [];
  const firstK = Math.ceil(min / step - EPSILON);
  const lastK = Math.floor(max / step + EPSILON);
  for (let k = firstK; k <= lastK; k += 1) {
    const tick = k * step;
    ticks.push(tick === 0 ? 0 : tick);
  }
  return ticks;
}

/**
 * Autoscale y over the window's finite values (null = no-trip gap, skipped):
 * pad ±8%, extend outward to nice-tick boundaries, min-range clamp for flat
 * series, [0, 10] default when empty. The floor follows the data down —
 * per-car control delay is tick-quantized and may dip slightly negative
 * (F7), and clamping that away would hide the honest zero.
 */
export function autoscaleY(values: readonly (number | null)[], targetTicks = 5): TickScale {
  const data = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (data.length === 0) return EMPTY_Y_SCALE;
  let lo = Math.min(...data);
  let hi = Math.max(...data);
  if (hi - lo < MIN_Y_RANGE_SECONDS) {
    if (lo >= 0) {
      hi = Math.max(hi, MIN_Y_RANGE_SECONDS); // all-zero → [0, 2]
      lo = Math.max(0, hi - MIN_Y_RANGE_SECONDS); // flat at K → [K−2, K]
    } else {
      const center = (lo + hi) / 2;
      lo = center - MIN_Y_RANGE_SECONDS / 2;
      hi = center + MIN_Y_RANGE_SECONDS / 2;
    }
  } else {
    const pad = (hi - lo) * 0.08;
    lo -= pad;
    hi += pad;
  }
  const step = niceStep((hi - lo) / Math.max(1, targetTicks), 0.1);
  const min = Math.floor(lo / step + EPSILON) * step;
  const max = Math.ceil(hi / step - EPSILON) * step;
  return { min, max, ticks: ticksInRange(min, max, step) };
}

/** Nice mm:ss tick step candidates for the x axis (sim-time seconds). */
export const TIME_TICK_STEPS_SECONDS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600] as const;

/**
 * X tick times covering [xMin, xMax]: the smallest nice step keeping the
 * count ≤ `targetCount`, aligned to multiples of the step from sim time 0 so
 * labels stay round ("1:30", never "1:27") as the window scrolls.
 */
export function timeTicks(xMin: number, xMax: number, targetCount = 4): readonly number[] {
  const span = Math.max(xMax - xMin, 0);
  let step: number = TIME_TICK_STEPS_SECONDS[TIME_TICK_STEPS_SECONDS.length - 1] as number;
  for (const candidate of TIME_TICK_STEPS_SECONDS) {
    if (span / candidate <= targetCount) {
      step = candidate;
      break;
    }
  }
  const firstK = Math.ceil(xMin / step - EPSILON);
  const lastK = Math.floor(xMax / step + EPSILON);
  const ticks: number[] = [];
  for (let k = firstK; k <= lastK; k += 1) {
    const tick = k * step;
    ticks.push(tick === 0 ? 0 : tick);
  }
  return ticks;
}

/** Trim trailing zeros from a fixed-decimal string ("2.50" → "2.5", "3.00" → "3"). */
export function trimDecimalZeros(text: string): string {
  if (!text.includes('.')) return text;
  let end = text.length;
  while (end > 0 && text.charAt(end - 1) === '0') end -= 1;
  if (end > 0 && text.charAt(end - 1) === '.') end -= 1;
  return text.slice(0, end);
}

/** Fixed-decimal number with trailing zeros trimmed; null/undefined → '—'. */
export function formatNumber(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return trimDecimalZeros(value.toFixed(digits));
}

/** A seconds quantity for display ("12.3 s"); null → '—'. */
export function formatSecondsDisplay(value: number | null, digits = 1): string {
  const text = formatNumber(value, digits);
  return text === '—' ? text : `${text} s`;
}

/** Sim-time clock label "m:ss" (negative times clamp to 0). */
export function formatMMSS(totalSeconds: number): string {
  const t = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(t / 60);
  const seconds = t - minutes * 60;
  return `${String(minutes)}:${seconds < 10 ? '0' : ''}${String(seconds)}`;
}
