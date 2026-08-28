/**
 * Candidate-space tests (task O1): the committed R1 §5.2 space — integer
 * greens >= g_min summing to the usable green budget at a fixed cycle, every
 * candidate validation-exact, counts hand-derived (stars and bars over the
 * lattice — see the arithmetic in each assertion).
 */
import { describe, expect, it } from 'vitest';
import type { IntersectionConfig } from '../config';
import { createDefaultConfig, validateConfig } from '../config';
import { getPreset } from '../presets';
import type { SweepCandidate } from './candidates';
import { candidateConfig } from './candidates';
import { candidateCycleSeconds } from './candidates';
import { greenSplitSpace } from './candidates';
import { refineCandidates } from './candidates';
import { ringPhaseKinds } from './candidates';
import { usableGreenSeconds } from './candidates';

function expectEveryCandidateValid(config: IntersectionConfig, candidates: readonly SweepCandidate[]): void {
  for (const candidate of candidates) {
    const issues = validateConfig(candidateConfig(config, candidate));
    expect(issues, `${candidate.id}: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`).toEqual([]);
  }
}

describe('usableGreenSeconds', () => {
  it('computes the hand-derived budgets: G = round(C − Σlost)', () => {
    // default: C=60, 2 × (3.3 yellow + 0.6 all-red) = 7.8 lost → 52.2 → 52
    expect(usableGreenSeconds(createDefaultConfig())).toBe(52);
    // light: C=50, same intervals → 42.2 → 42
    expect(usableGreenSeconds(getPreset('light').config)).toBe(42);
    // balanced: C=60, 4 × (3.3 + 0.9) = 16.8 lost → 43.2 → 43 (presets doc: greens sum 43)
    expect(usableGreenSeconds(getPreset('balanced').config)).toBe(43);
    // gridlock: C=80, same lost → 63.2 → 63 (presets doc: greens sum 63)
    expect(usableGreenSeconds(getPreset('gridlock-risk').config)).toBe(63);
  });

  it('throws for non-signal control', () => {
    const stop: IntersectionConfig = { ...createDefaultConfig(), control: { type: 'all-way-stop' } };
    expect(() => usableGreenSeconds(stop)).toThrow(/signal/);
    // A cycle that cannot host g_min greens: 2-phase at C = 16 leaves 8.2 → 8 < 10.
    const base = createDefaultConfig();
    if (base.control.type !== 'signal') throw new Error('test requires a signal config');
    const tiny: IntersectionConfig = {
      ...base,
      control: { type: 'signal', plan: { ...base.control.plan, cycleLengthSeconds: 16 } },
    };
    expect(() => usableGreenSeconds(tiny)).toThrow(/cycle 16 s leaves only/);
  });
});

describe('greenSplitSpace', () => {
  it('default config: exhaustive 1 s grid over the 2-phase split → 43 candidates', () => {
    const config = createDefaultConfig();
    const space = greenSplitSpace(config);
    expect(space.stepSeconds).toBe(1);
    expect(space.widened).toBe(false);
    expect(space.usableGreenSeconds).toBe(52);
    // M = (52 − 2·5)/1 = 42 lattice points +1 → 43
    expect(space.candidates.length).toBe(43);
    expect(space.candidates[0]?.id).toBe('g:5+47');
    expect(space.candidates[21]?.id).toBe('g:26+26'); // enumeration: first-phase green ascending
    expect(space.candidates[42]?.id).toBe('g:47+5');
    expectEveryCandidateValid(config, space.candidates);
  });

  it('every candidate: integer greens >= g_min summing exactly to G at the fixed cycle', () => {
    for (const preset of ['light', 'balanced', 'gridlock-risk'] as const) {
      const config = getPreset(preset).config;
      const control = config.control;
      if (control.type !== 'signal') throw new Error('presets must be signal configs');
      const space = greenSplitSpace(config);
      const G = usableGreenSeconds(config);
      for (const candidate of space.candidates) {
        expect(candidate.greens.every((green) => Number.isInteger(green) && green >= 5), `${preset} ${candidate.id}`).toBe(true);
        expect(candidate.greens.reduce((a, b) => a + b, 0), `${preset} ${candidate.id}`).toBe(G);
        expect(candidate.plan.cycleLengthSeconds).toBe(control.plan.cycleLengthSeconds); // cycle fixed
        // Cycle coherence within the F2 slack.
        expect(Math.abs(candidateCycleSeconds(config, candidate) - candidate.plan.cycleLengthSeconds)).toBeLessThanOrEqual(0.5);
      }
      expectEveryCandidateValid(config, space.candidates);
    }
  });

  it('4-phase rings default to the 5 s coarse grid: balanced → 35, gridlock widens 5 → 10 s → 35 (bounded ≤ 96)', () => {
    const balanced = greenSplitSpace(getPreset('balanced').config);
    // balanced G=43: M = floor((43 − 20)/5) = 4 → C(4+3,3) = 35
    expect(balanced.requestedStepSeconds).toBe(5);
    expect(balanced.stepSeconds).toBe(5);
    expect(balanced.widened).toBe(false);
    expect(balanced.candidates.length).toBe(35);

    const gridlock = greenSplitSpace(getPreset('gridlock-risk').config);
    // gridlock G=63 at step 5: M = floor(43/5) = 8 → C(11,3) = 165 > 96 → widen to 10: M = 4 → 35
    expect(gridlock.requestedStepSeconds).toBe(5);
    expect(gridlock.stepSeconds).toBe(10);
    expect(gridlock.widened).toBe(true);
    expect(gridlock.candidates.length).toBe(35);
    expect(gridlock.candidates.length).toBeLessThanOrEqual(96);
  });

  it('respects an explicit maxCandidates by widening deterministically', () => {
    const config = getPreset('gridlock-risk').config;
    const space = greenSplitSpace(config, { maxCandidates: 20 });
    expect(space.candidates.length).toBeLessThanOrEqual(20);
    // step 20: M = floor(43/20) = 2 → C(2+3,3) = 10
    expect(space.stepSeconds).toBe(20);
    expect(space.candidates.length).toBe(10);
  });

  it('ids are unique, enumeration is deterministic, and generation is pure', () => {
    const config = getPreset('balanced').config;
    const a = greenSplitSpace(config);
    const b = greenSplitSpace(config);
    expect(new Set(a.candidates.map((candidate) => candidate.id)).size).toBe(a.candidates.length);
    expect(b.candidates.map((candidate) => candidate.id)).toEqual(a.candidates.map((candidate) => candidate.id));
    expect(b.candidates.map((candidate) => candidate.greens)).toEqual(a.candidates.map((candidate) => candidate.greens));
  });

  it('rejects non-signal configs and bad steps', () => {
    const stop: IntersectionConfig = { ...createDefaultConfig(), control: { type: 'all-way-stop' } };
    expect(() => greenSplitSpace(stop)).toThrow(/signal/);
    expect(() => greenSplitSpace(createDefaultConfig(), { stepSeconds: 0 })).toThrow(/positive integer/);
  });
});

describe('refineCandidates (stage 2: 1 s transfers within ±window)', () => {
  it('produces only validation-exact transfers around the bases', () => {
    const config = createDefaultConfig(); // G = 52
    const space = greenSplitSpace(config);
    const base = space.candidates[21] as SweepCandidate; // g:26+26
    const refined = refineCandidates(config, [base], { windowSeconds: 3 });

    expect(refined.length).toBeGreaterThan(0);
    for (const candidate of refined) {
      expect(candidate.greens.reduce((a, b) => a + b, 0)).toBe(52); // Σ preserved exactly
      expect(candidate.greens.every((green) => Number.isInteger(green) && green >= 5)).toBe(true);
      expect(Math.abs((candidate.greens[0] as number) - (base.greens[0] as number))).toBeLessThanOrEqual(3);
    }
    expect(new Set(refined.map((candidate) => candidate.id)).size).toBe(refined.length);
    // Hand-check membership: +3 to phase 0 from phase 1 → g:29+23; −2 → g:24+28.
    const ids = new Set(refined.map((candidate) => candidate.id));
    expect(ids.has('g:29+23')).toBe(true);
    expect(ids.has('g:24+28')).toBe(true);
    // A transfer beyond the window never appears.
    expect(ids.has('g:30+22')).toBe(false);
    expect(ids.has('g:26+26')).toBe(false); // the base itself is not a transfer
    expectEveryCandidateValid(config, refined);
  });

  it('2-phase coarse grid is exhaustive → refinement against it adds nothing', () => {
    const config = createDefaultConfig();
    const space = greenSplitSpace(config);
    expect(refineCandidates(config, space.candidates.slice(0, 3), { exclude: space.candidates })).toEqual([]);
  });

  it('skips transfers that would drop a phase below g_min', () => {
    const config = getPreset('balanced').config; // 4-phase, G = 43
    const space = greenSplitSpace(config);
    const base = space.candidates[0] as SweepCandidate; // g:5+5+5+28 — phase 0 at g_min
    expect(base.greens[0]).toBe(5);
    const refined = refineCandidates(config, [base], { windowSeconds: 2 });
    expect(refined.length).toBeGreaterThan(0);
    for (const candidate of refined) {
      expect(candidate.greens.every((green) => green >= 5)).toBe(true);
      expect(candidate.greens.reduce((a, b) => a + b, 0)).toBe(43);
      // Phase 0 may only RECEIVE green, never donate (it sits at g_min).
      expect((candidate.greens[0] as number) - (base.greens[0] as number)).toBeGreaterThanOrEqual(0);
    }
  });

  it('caps the union (coarse + refined) at maxCandidates, deterministically', () => {
    const config = getPreset('gridlock-risk').config;
    const space = greenSplitSpace(config, { maxCandidates: 40 });
    const bases = space.candidates.slice(0, 3);
    const a = refineCandidates(config, bases, { maxCandidates: 40, exclude: space.candidates });
    const b = refineCandidates(config, bases, { maxCandidates: 40, exclude: space.candidates });
    expect(space.candidates.length + a.length).toBeLessThanOrEqual(40);
    expect(a.map((candidate) => candidate.id)).toEqual(b.map((candidate) => candidate.id));
  });
});

describe('ringPhaseKinds', () => {
  it('exposes the canonical ring per leftMode', () => {
    expect(ringPhaseKinds(createDefaultConfig())).toEqual(['ns-through-right', 'ew-through-right']);
    expect(ringPhaseKinds(getPreset('balanced').config)).toEqual([
      'ns-protected-left',
      'ns-through-right',
      'ew-protected-left',
      'ew-through-right',
    ]);
  });
});
