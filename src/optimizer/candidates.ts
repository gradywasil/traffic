/**
 * Candidate space for the green-split sweep (task O1) — the committed
 * candidate space of research R1 §5.2 / plan O1:
 *
 * - **Integer-second green splits** at a **fixed cycle** (the config's
 *   `cycleLengthSeconds`); every green >= g_min = `MIN_GREEN_SECONDS` (5 s).
 * - **Cycle handling:** the usable green budget `G = C − Σlost`, where lost
 *   time is the geometry-derived change intervals (`phaseChangeIntervals`:
 *   yellow + all-red per ring phase — never swept, F2/F5 contract). Integer
 *   greens cannot hit a real-valued `C − Σlost` exactly, so `G` is the UNIQUE
 *   integer within the F2 validation slack (`MAX_CYCLE_DEVIATION_SECONDS` =
 *   0.5 s): `G = round(C − Σlost)`, guarded. Every candidate keeps
 *   `Σ greens = G` exactly, so every candidate round-trips `validateConfig`.
 * - **Which phases:** all phases of the canonical NEMA-lite ring implied by
 *   the config's `leftMode` (`signalPhaseKinds`) — 2 phases (permissive
 *   lefts) up to 4 (protected lefts on both axes). Only greens vary; phase
 *   kinds, order, leftMode and cycle are frozen (the pairing scope note in
 *   R2 Part B: a sweep varies ONLY the signal plan's green splits).
 *
 * ## The grid (documented per the O1 contract)
 *
 * - The first P−1 phases are placed on a lattice `g_i = g_min + step·k_i`
 *   (`k_i >= 0`); the LAST phase absorbs the residual
 *   `g_P = G − Σ g_i (>= g_min)`. Residual absorption is what makes a coarse
 *   step coexist with the exact-cycle constraint.
 * - **Default step:** 1 s for 2-phase rings (the full integer grid — at two
 *   phases it is small and EXHAUSTIVE, so refinement provably adds nothing);
 *   5 s for rings with 3+ phases (the R1 §5.2 coarse grid).
 * - **Boundedness:** while the candidate count exceeds `maxCandidates`
 *   (default 96), the step DOUBLES (deterministic) until it fits. The default
 *   sweep therefore never exceeds the O1 compute budget:
 *     default config (C=60, G=52, 2-phase): step 1 → 43 candidates;
 *     light (C=50, G=42, 2-phase): step 1 → 33;
 *     balanced (C=60, G=43, 4-phase): step 5 → 35;
 *     gridlock (C=80, G=63, 4-phase): step 5 → 165 > 96 → widens to step 10 → 35.
 *   Counts scale with the usable green budget; see candidates.test.ts for the
 *   hand-derived arithmetic (stars and bars over the lattice).
 * - **Enumeration order** is deterministic: lexicographic in the k-vector —
 *   first-phase green ascending, then second, … — and candidate ids are the
 *   greens vector itself (`"g:26+26"`), so ids are stable and rank ties break
 *   reproducibly.
 *
 * ## Stage 2 — refinement (the R1 §5.2 "1 s within ±3 s of the top-3" grid)
 *
 * `refineCandidates` implements the committed second stage as green
 * TRANSFERS at 1 s resolution: for each base (top-K stage-1 candidate), for
 * each ordered phase pair (i, j) and each `d ∈ {−window..+window} \ {0}`,
 * move `d` seconds from phase j to phase i (`g_i += d, g_j -= d`). Transfers
 * preserve `Σ greens = G` exactly (unlike single-phase perturbation, which
 * would break cycle coherence) and cover the ±window neighborhood along
 * every coordinate direction. Results are deduplicated against the coarse
 * space and each other, and capped so coarse + refined together stay within
 * `maxCandidates`.
 */
import {
  MAX_CYCLE_DEVIATION_SECONDS,
  MIN_GREEN_SECONDS,
  phaseChangeIntervals,
  signalPhaseKinds,
  signalPlanDurationSeconds,
  validateConfig,
} from '../config';
import type {
  IntersectionConfig,
  SignalPhaseConfig,
  SignalPhaseKind,
  SignalPlanConfig,
} from '../config';

/** One candidate signal timing: the greens vector + the plan it produces. */
export interface SweepCandidate {
  /** Stable identity: `"g:" + greens joined by '+'` (ring order). */
  readonly id: string;
  /** Green seconds per ring phase, ring order (integers >= g_min). */
  readonly greens: readonly number[];
  /** The plan this candidate installs (canonical ring, fixed cycle). */
  readonly plan: SignalPlanConfig;
}

export interface CandidateSpaceOptions {
  /**
   * Starting lattice step in seconds for the first P−1 phases. The space
   * auto-widens (doubles) from here while the count exceeds `maxCandidates`.
   * Default: 1 for 2-phase rings, 5 otherwise.
   */
  readonly stepSeconds?: number;
  /** Hard bound on the candidate count (default 96; the O1 compute budget). */
  readonly maxCandidates?: number;
}

/** The coarse grid plus the parameters it actually ran with. */
export interface GreenSplitSpace {
  readonly candidates: readonly SweepCandidate[];
  /** The lattice step after any widening. */
  readonly stepSeconds: number;
  /** The starting step (explicit option or default). */
  readonly requestedStepSeconds: number;
  /** True when the step had to widen to respect `maxCandidates`. */
  readonly widened: boolean;
  /** Usable green budget G = round(C − Σlost). */
  readonly usableGreenSeconds: number;
  /** Ring phase kinds the greens vector is indexed by. */
  readonly phaseKinds: readonly SignalPhaseKind[];
}

export const DEFAULT_MAX_CANDIDATES = 96;

/** The signal plan of a config, narrowed (throws for other control types). */
function signalPlanOf(config: IntersectionConfig): SignalPlanConfig {
  if (config.control.type !== 'signal') {
    throw new Error(`green-split candidates require control.type 'signal', got '${String(config.control.type)}'`);
  }
  return config.control.plan;
}

/** The canonical ring phase kinds of a signal config (2–4 phases). */
export function ringPhaseKinds(config: IntersectionConfig): readonly SignalPhaseKind[] {
  return signalPhaseKinds(signalPlanOf(config).leftMode);
}

/**
 * Usable green budget G = round(C − Σlost) — the unique integer-green total
 * inside the F2 cycle-coherence slack. Throws when no integer total fits
 * (cycle too short for the ring) or when the cycle cannot host g_min greens.
 */
export function usableGreenSeconds(config: IntersectionConfig): number {
  const kinds = ringPhaseKinds(config);
  const plan = signalPlanOf(config);
  let lostSeconds = 0;
  for (const kind of kinds) {
    const intervals = phaseChangeIntervals(config, kind);
    lostSeconds += intervals.yellowSeconds + intervals.allRedSeconds;
  }
  const usable = plan.cycleLengthSeconds - lostSeconds;
  const greens = Math.round(usable);
  if (Math.abs(greens + lostSeconds - plan.cycleLengthSeconds) > MAX_CYCLE_DEVIATION_SECONDS) {
    throw new Error(
      `cycle ${String(plan.cycleLengthSeconds)} s cannot be filled with integer greens: ` +
        `usable ${usable.toFixed(2)} s is farther than ${String(MAX_CYCLE_DEVIATION_SECONDS)} s from an integer`,
    );
  }
  if (greens < kinds.length * MIN_GREEN_SECONDS) {
    throw new Error(
      `cycle ${String(plan.cycleLengthSeconds)} s leaves only ${String(greens)} s of green for ` +
        `${String(kinds.length)} phases (need >= ${String(kinds.length * MIN_GREEN_SECONDS)} s at g_min)`,
    );
  }
  return greens;
}

/** Build the candidate for a greens vector (validates the ring shape). */
function makeCandidate(
  config: IntersectionConfig,
  kinds: readonly SignalPhaseKind[],
  greens: readonly number[],
): SweepCandidate {
  if (greens.length !== kinds.length) {
    throw new Error(`greens vector length ${String(greens.length)} != ring phases ${String(kinds.length)}`);
  }
  const phases: SignalPhaseConfig[] = [];
  for (let i = 0; i < kinds.length; i += 1) {
    const green = greens[i];
    if (green === undefined || !Number.isInteger(green) || green < MIN_GREEN_SECONDS) {
      throw new Error(`green ${String(green)} at phase ${String(i)} is not an integer >= ${String(MIN_GREEN_SECONDS)}`);
    }
    phases.push({ kind: kinds[i] as SignalPhaseKind, greenSeconds: green });
  }
  const basePlan = signalPlanOf(config);
  return {
    id: `g:${greens.join('+')}`,
    greens: Object.freeze([...greens]),
    plan: {
      cycleLengthSeconds: basePlan.cycleLengthSeconds,
      leftMode: basePlan.leftMode,
      phases: Object.freeze(phases),
    },
  };
}

/** Number of lattice points for P phases, budget G, g_min, step (stars and bars). */
function latticeCount(phaseCount: number, usableGreen: number, step: number): number {
  const maxK = Math.floor((usableGreen - phaseCount * MIN_GREEN_SECONDS) / step);
  if (maxK < 0) return 0;
  // Number of (P−1)-tuples k >= 0 with Σk <= maxK = C(maxK + P − 1, P − 1).
  let count = 1;
  for (let i = 1; i <= phaseCount - 1; i += 1) {
    count = (count * (maxK + i)) / i;
  }
  return Math.round(count);
}

/**
 * The coarse green-split grid. Deterministic; every candidate satisfies F2
 * validation (integer greens >= g_min, exact Σgreens = G, canonical ring).
 */
export function greenSplitSpace(config: IntersectionConfig, options: CandidateSpaceOptions = {}): GreenSplitSpace {
  const kinds = ringPhaseKinds(config);
  const usableGreen = usableGreenSeconds(config);
  const maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const requestedStep = options.stepSeconds ?? (kinds.length <= 2 ? 1 : 5);
  if (!Number.isInteger(requestedStep) || requestedStep < 1) {
    throw new Error(`stepSeconds must be a positive integer, got ${String(options.stepSeconds)}`);
  }

  let step = requestedStep;
  while (latticeCount(kinds.length, usableGreen, step) > maxCandidates) step *= 2;

  // Lexicographic enumeration over the k-vectors; last phase absorbs.
  const phaseCount = kinds.length;
  const maxK = Math.floor((usableGreen - phaseCount * MIN_GREEN_SECONDS) / step);
  const greensList: number[][] = [];
  const current: number[] = [];
  const enumerate = (index: number, kRemaining: number): void => {
    if (index === phaseCount - 1) {
      let prefix = 0;
      for (const green of current) prefix += green;
      const last = usableGreen - prefix;
      if (last >= MIN_GREEN_SECONDS) greensList.push([...current, last]);
      return;
    }
    for (let k = 0; k <= kRemaining; k += 1) {
      current.push(MIN_GREEN_SECONDS + step * k);
      enumerate(index + 1, kRemaining - k);
      current.pop();
    }
  };
  enumerate(0, maxK);

  const candidates = greensList.map((greens) => makeCandidate(config, kinds, greens));
  for (const candidate of candidates) {
    const issues = validateConfig(candidateConfig(config, candidate));
    if (issues.length > 0) {
      throw new Error(
        `generated candidate ${candidate.id} fails validation: ${issues
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join('; ')}`,
      );
    }
  }
  return {
    candidates,
    stepSeconds: step,
    requestedStepSeconds: requestedStep,
    widened: step !== requestedStep,
    usableGreenSeconds: usableGreen,
    phaseKinds: kinds,
  };
}

export interface RefineOptions {
  /** Transfer window per phase pair in seconds (default 3 — R1 §5.2). */
  readonly windowSeconds?: number;
  /** Cap on the TOTAL candidate count (coarse + refined; default 96). */
  readonly maxCandidates?: number;
  /** Candidates already evaluated (the coarse space) — refined output excludes them. */
  readonly exclude?: readonly SweepCandidate[];
}

/**
 * Stage-2 refinement around the top stage-1 candidates: 1 s green transfers
 * within ±window across every ordered phase pair (see module doc). Deduped
 * against `exclude` and itself; deterministically capped so the union with
 * the coarse space stays within `maxCandidates`. Returns `[]` for 2-phase
 * rings when the coarse grid was exhaustive — or generally when every
 * transfer is already covered.
 */
export function refineCandidates(
  config: IntersectionConfig,
  bases: readonly SweepCandidate[],
  options: RefineOptions = {},
): readonly SweepCandidate[] {
  const kinds = ringPhaseKinds(config);
  const windowSeconds = options.windowSeconds ?? 3;
  if (!Number.isInteger(windowSeconds) || windowSeconds < 1) {
    throw new Error(`windowSeconds must be a positive integer, got ${String(options.windowSeconds)}`);
  }
  const maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const excludedCount = options.exclude?.length ?? 0;
  const seen = new Set<string>((options.exclude ?? []).map((candidate) => candidate.id));
  const refined: SweepCandidate[] = [];

  for (const base of bases) {
    if (base.greens.length !== kinds.length) {
      throw new Error(`base candidate ${base.id} has ${String(base.greens.length)} greens, ring has ${String(kinds.length)}`);
    }
    for (let from = 0; from < kinds.length; from += 1) {
      for (let to = 0; to < kinds.length; to += 1) {
        if (from === to) continue;
        for (let delta = -windowSeconds; delta <= windowSeconds; delta += 1) {
          if (delta === 0) continue;
          const greens = [...base.greens];
          greens[from] = (greens[from] ?? 0) + delta;
          greens[to] = (greens[to] ?? 0) - delta;
          if ((greens[from] ?? 0) < MIN_GREEN_SECONDS || (greens[to] ?? 0) < MIN_GREEN_SECONDS) continue;
          const candidate = makeCandidate(config, kinds, greens);
          if (seen.has(candidate.id)) continue;
          seen.add(candidate.id);
          if (excludedCount + refined.length >= maxCandidates) return refined;
          refined.push(candidate);
        }
      }
    }
  }
  return refined;
}

/** The full config a candidate installs (everything frozen but the greens). */
export function candidateConfig(config: IntersectionConfig, candidate: SweepCandidate): IntersectionConfig {
  return { ...config, control: { type: 'signal', plan: candidate.plan } };
}

/**
 * Convenience: the ring duration a candidate implies (greens + computed
 * change intervals) — sanity double of the cycle-coherence guard.
 */
export function candidateCycleSeconds(config: IntersectionConfig, candidate: SweepCandidate): number {
  return signalPlanDurationSeconds(config, candidate.plan);
}
