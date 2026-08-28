/**
 * Q1 leak checks per the R2 Part C run-hash spec — enforced statically and at
 * the quantization boundary:
 *
 * 1. No wall-clock / host-timing / nondeterminism / banned-op leakage in the
 *    sim path (`src/sim`, `src/geom`, `src/config`, and the optimizer's pure
 *    run modules `run.ts`/`candidates.ts`/`worker.ts`). R2 rule 1: sim is a
 *    pure function of (state, tick, seed) — no Date, performance.now,
 *    timers, rAF, microtask scheduling, Math.random, eval. R2 rule 2:
 *    IEEE-exact ops only — the implementation-approximated Math functions
 *    (pow, exp, log*, trig*, atan2, cbrt, hypot, sinh/cosh/tanh) and the
 *    `**` operator are banned outside `src/render/`. The worker-pool
 *    EXECUTOR (`src/optimizer/executor.ts`) is deliberately out of scope:
 *    R2 exempts the harness ("performance.now allowed for budgeting, never
 *    in sim").
 *
 *    The scan strips comments and string literals first (doc comments say
 *    things like "`Math.pow` is banned" — prose, not code), then pattern-
 *    matches the remaining code. It is a coarse static assert, not a proof;
 *    review remains the lint of record.
 *
 * 2. Q10 quantization respected: the run-hash's float path quantizes with
 *    floor semantics (`delayQ = floor(delay × 1024)` — distinguishable from
 *    trunc/round at negative values), normalizes −0, rejects non-finite, and
 *    a full recorder outcome is invariant to sub-quantum (≤ 2^-10 s) shifts
 *    while a one-quantum shift flips it.
 */
import { describe, expect, it } from 'vitest';
import { createDefaultConfig } from '../../src/config/defaults';
import { DualLaneDigest } from '../../src/sim/hash';
import { IntegrationRunHash } from './support/run-hash';

/**
 * The scan reads sources through Vite's module graph (`import.meta.glob` with
 * `?raw`, typed by vite/client — no node-specific types needed): project-rooted
 * path → raw source text, non-test .ts files only.
 */
const SCANNED_SOURCES: Readonly<Record<string, string>> = {
  ...import.meta.glob('/src/{sim,geom,config}/**/*.ts', { eager: true, query: '?raw', import: 'default' }),
  ...import.meta.glob('/src/optimizer/{run,candidates,worker}.ts', { eager: true, query: '?raw', import: 'default' }),
};

const scannedEntries = Object.entries(SCANNED_SOURCES).filter(([path]) => !path.endsWith('.test.ts'));

/** Wall-clock, host scheduling, nondeterminism, dynamic code (R2 rule 1). */
const WALL_CLOCK_PATTERNS: readonly { readonly pattern: RegExp; readonly label: string }[] = [
  { pattern: /\bnew\s+Date\b|\bDate\.now\s*\(/, label: 'Date (wall clock)' },
  { pattern: /\bperformance\s*\.\s*now\s*\(/, label: 'performance.now' },
  { pattern: /\bsetTimeout\s*\(|\bsetInterval\s*\(/, label: 'setTimeout/setInterval' },
  { pattern: /\brequestAnimationFrame\s*\(|\brequestIdleCallback\s*\(/, label: 'rAF/rIC' },
  { pattern: /\bqueueMicrotask\s*\(/, label: 'queueMicrotask' },
  { pattern: /\bMath\.random\s*\(/, label: 'Math.random' },
  { pattern: /\beval\s*\(|\bnew\s+Function\s*\(/, label: 'eval / new Function' },
];

/** Implementation-approximated Math functions + the ** operator (R2 rule 2). */
const BANNED_OP_PATTERNS: readonly { readonly pattern: RegExp; readonly label: string }[] = [
  { pattern: /\bMath\.pow\s*\(/, label: 'Math.pow' },
  { pattern: /\bMath\.expm1\s*\(/, label: 'Math.expm1' },
  { pattern: /\bMath\.exp\s*\(/, label: 'Math.exp' },
  { pattern: /\bMath\.log1p\s*\(|\bMath\.log10\s*\(|\bMath\.log2\s*\(|\bMath\.log\s*\(/, label: 'Math.log*' },
  {
    pattern: /\bMath\.sinh\s*\(|\bMath\.cosh\s*\(|\bMath\.tanh\s*\(/,
    label: 'Math.sinh/cosh/tanh',
  },
  { pattern: /\bMath\.asin\s*\(|\bMath\.acos\s*\(|\bMath\.atan2\s*\(|\bMath\.atan\s*\(/, label: 'Math.asin/acos/atan/atan2' },
  { pattern: /\bMath\.sin\s*\(|\bMath\.cos\s*\(|\bMath\.tan\s*\(/, label: 'Math.sin/cos/tan' },
  { pattern: /\bMath\.cbrt\s*\(/, label: 'Math.cbrt' },
  { pattern: /\bMath\.hypot\s*\(/, label: 'Math.hypot' },
  { pattern: /\*\*/, label: '** exponentiation operator' },
];

/** Strip comments and string-literal contents (template ${exprs} kept — code). */
function stripCommentsAndStrings(source: string): string {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    const next = i + 1 < n ? source[i + 1] : '';
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      i = end === -1 ? n : end;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < n) {
        const c = source[i];
        if (c === '\\') {
          i += 2;
          continue;
        }
        if (quote === '`' && c === '$' && source[i + 1] === '{') {
          let depth = 1;
          i += 2;
          while (i < n && depth > 0) {
            const t = source[i];
            if (t === '{') depth += 1;
            else if (t === '}') depth -= 1;
            i += 1;
          }
          continue;
        }
        if (c === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      out += ' ';
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

describe('Q1 leak checks: no wall-clock / nondeterminism / banned ops in the sim path', () => {
  it(`scans a non-empty sim-path file set (${String(scannedEntries.length)} files)`, () => {
    // Vacuity guard: the scan actually covers the sim core.
    expect(scannedEntries.length).toBeGreaterThanOrEqual(20);
    const paths = scannedEntries.map(([path]) => path);
    for (const mustInclude of [
      '/src/sim/world.ts',
      '/src/sim/following.ts',
      '/src/sim/spawn.ts',
      '/src/sim/rng.ts',
      '/src/sim/control/claims.ts',
      '/src/sim/metrics/engine.ts',
      '/src/geom/paths.ts',
      '/src/optimizer/run.ts',
    ]) {
      expect(paths, `scan covers ${mustInclude}`).toContain(mustInclude);
    }
  });

  it('no wall-clock reads, host scheduling, Math.random, or eval anywhere in the sim path', () => {
    for (const [path, source] of scannedEntries) {
      const code = stripCommentsAndStrings(source);
      for (const { pattern, label } of WALL_CLOCK_PATTERNS) {
        expect(code.match(pattern), `${path}: ${label}`).toBeNull();
      }
    }
  });

  it('no implementation-approximated Math calls or ** operator in the sim path', () => {
    for (const [path, source] of scannedEntries) {
      const code = stripCommentsAndStrings(source);
      for (const { pattern, label } of BANNED_OP_PATTERNS) {
        expect(code.match(pattern), `${path}: ${label}`).toBeNull();
      }
    }
  });
});

describe('Q1 leak checks: Q10 quantization respected by the run-hash construction', () => {
  it('quantizes with FLOOR semantics (distinguishable from trunc/round at negative values)', () => {
    // −0.3 s × 1024 = −307.2 → floor −308 (trunc/round would give −307).
    const floored = new DualLaneDigest(7);
    floored.quantized10(-0.3);
    const expected = new DualLaneDigest(7);
    expected.word(Math.floor(-0.3 * 1024));
    const notTrunc = new DualLaneDigest(7);
    notTrunc.word(Math.trunc(-0.3 * 1024));
    const notRound = new DualLaneDigest(7);
    notRound.word(Math.round(-0.3 * 1024));
    expect(floored.hex()).toBe(expected.hex());
    expect(floored.hex()).not.toBe(notTrunc.hex());
    expect(floored.hex()).not.toBe(notRound.hex());
  });

  it('normalizes −0 and rejects non-finite values', () => {
    const negZero = new DualLaneDigest(7);
    negZero.quantized10(-0);
    const posZero = new DualLaneDigest(7);
    posZero.quantized10(0);
    expect(negZero.hex()).toBe(posZero.hex());
    expect(() => new DualLaneDigest(7).quantized10(Number.NaN)).toThrow();
    expect(() => new DualLaneDigest(7).quantized10(Number.POSITIVE_INFINITY)).toThrow();
  });

  it('a recorder outcome is invariant to sub-quantum shifts, flipped by one quantum (delayQ = floor(delay·1024))', () => {
    const summaryFor = (delay: number) => ({
      tripCount: 3,
      meanControlDelaySeconds: delay,
      meanStoppedSeconds: 1.5,
      throughputVehPerHour: 900,
      maxQueueCars: 4,
      maxQueuePerChain: [1, 2, 1, 0, 2, 1, 0, 1, 1, 0, 1, 0],
    });
    const run = (delay: number): ReturnType<IntegrationRunHash['finish']> => {
      const recorder = new IntegrationRunHash(42, 0, createDefaultConfig());
      return recorder.finish('0123abcd:fedcba98', summaryFor(delay));
    };
    // Same recorder seed words/config shape; only the final-metrics float differs.
    const base = run(10.0);
    const subQuantum = run(10.0 + 0.5 / 1024); // 0.5 quantum — same Q10 word
    const oneQuantum = run(10.0 + 1.5 / 1024); // crosses one Q10 step
    expect(subQuantum.finalHash).toBe(base.finalHash);
    expect(oneQuantum.finalHash).not.toBe(base.finalHash);
    // Every float word went through quantization (single choke point).
    expect(base.quantizedCount).toBeGreaterThan(0);
    expect(subQuantum.quantizedCount).toBe(base.quantizedCount);
    expect(subQuantum.wordCount).toBe(base.wordCount);
  });
});
