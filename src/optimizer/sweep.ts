/**
 * Sweep orchestration (task O1): run every candidate × every rep on one
 * `SweepExecutor`, assert the paired-seed contract, aggregate, rank.
 *
 * **Pairing protocol (R2 Part B):** every rep r uses the seed stream
 * derived from (masterSeed, r) — shared across ALL candidates (only the
 * signal greens differ, so the demand realization is provably identical;
 * F6's spawner makes the fired-arrival sequence state-independent). The
 * assertion is runtime-enforced: after all runs land, every candidate's
 * `spawnDigestHex` for a given rep must be IDENTICAL, else
 * `PairingViolationError`. (Reps differing from each other is a test-time
 * property, not asserted here — a digest collision would be a hash bug, not
 * a pairing bug.)
 *
 * **Ranking (plan O1):** mean control delay per candidate — the unweighted
 * mean over reps of `RunSummary.meanControlDelaySeconds` (paired design:
 * equal horizon, equal treatment). Sample variance across reps is reported
 * alongside (spread of the treatment effect over demand realizations). A
 * candidate with ANY trip-less rep (null mean) cannot be ranked numerically
 * and sorts LAST (documented; deterministic). Ties break by candidate id
 * (the greens vector) lexicographically — stable and reproducible.
 *
 * **Two-stage default (R1 §5.2):** `runDefaultSweep` runs the coarse grid
 * first; for rings with 3+ phases it then refines around the top-K
 * (`refineCandidates`, 1 s transfers within ±window) and merges both stages
 * into one re-ranked report. Two-phase rings skip stage 2 — their coarse
 * grid at the default 1 s step is already exhaustive.
 */
import type { IntersectionConfig } from '../config';
import { validateConfig } from '../config';
import type { RunSummary } from '../sim/metrics';
import { candidateConfig } from './candidates';
import { greenSplitSpace } from './candidates';
import { refineCandidates } from './candidates';
import type { SweepCandidate } from './candidates';
import type { SweepExecutor, SweepRunRequest } from './executor';

export interface SweepProgress {
  readonly completed: number;
  readonly total: number;
}

export interface SweepOptions {
  /** Master run seed S (default 1). */
  readonly masterSeed?: number;
  /** Paired repetitions per candidate (default 3 — plan O1). */
  readonly reps?: number;
  /** Horizon per run in SIM-SECONDS (default 45 — R2 Part A). */
  readonly horizonSeconds?: number;
  /** Deterministic tick cap per run (optional; see HeadlessRunRequest). */
  readonly tickBudget?: number;
  /** The executor both stages run on (caller owns construction/cancellation). */
  readonly executor: SweepExecutor;
  /** Progress seam for O2's UI: fired after every completed run. */
  readonly onProgress?: (progress: SweepProgress) => void;
}

/** Per-rep outcome of one candidate. */
export interface CandidateRepOutcome {
  readonly repIndex: number;
  readonly runSummary: RunSummary;
  readonly spawnDigestHex: string;
  readonly runHash: string;
  readonly ticksRun: number;
}

export interface CandidateSweepResult {
  readonly candidate: SweepCandidate;
  /** The full config this candidate installs (O2's apply input). */
  readonly config: IntersectionConfig;
  readonly reps: readonly CandidateRepOutcome[];
  /** Ranking key: unweighted mean over reps of the rep mean control delay. */
  readonly meanControlDelaySeconds: number | null;
  /** Sample variance (n−1) of the rep means; null when uncomputable. */
  readonly varianceAcrossReps: number | null;
  readonly sampleStdDevSeconds: number | null;
  readonly meanThroughputVehPerHour: number | null;
  readonly meanMaxQueueCars: number;
  readonly totalTrips: number;
  /** 1-based rank after sorting (assigned by the orchestrator). */
  readonly rank: number;
}

export interface SweepReport {
  /** Ascending by mean control delay (nulls last, ties by candidate id). */
  readonly ranked: readonly CandidateSweepResult[];
  /** The pairing proof: one digest per rep, shared by every candidate. */
  readonly pairing: readonly { readonly repIndex: number; readonly spawnDigestHex: string }[];
  readonly candidateCount: number;
  readonly totalRuns: number;
  readonly executorName: string;
  readonly masterSeed: number;
  readonly reps: number;
  readonly horizonSeconds: number;
  /** Stage metadata when this report merges two stages (default sweep). */
  readonly stages: readonly { readonly label: string; readonly candidateCount: number }[];
}

/** Thrown when the paired-seed contract is violated within a rep. */
export class PairingViolationError extends Error {
  readonly repIndex: number;
  readonly digests: readonly string[];
  constructor(repIndex: number, digests: readonly string[]) {
    super(
      `paired-seed violation in rep ${String(repIndex)}: candidates produced ` +
        `${String(digests.length)} distinct spawn digests (${digests.slice(0, 4).join(', ')}${digests.length > 4 ? ', …' : ''})`,
    );
    this.name = 'PairingViolationError';
    this.repIndex = repIndex;
    this.digests = digests;
  }
}

export const DEFAULT_SWEEP_HORIZON_SECONDS = 45;
export const DEFAULT_SWEEP_REPS = 3;

/** Build the (candidate, rep) request list: candidate-major, rep asc. */
function buildRequests(config: IntersectionConfig, candidates: readonly SweepCandidate[], options: SweepOptions): {
  requests: readonly SweepRunRequest[];
  validated: readonly IntersectionConfig[];
} {
  if (config.control.type !== 'signal') {
    throw new Error(`a sweep requires control.type 'signal', got '${String(config.control.type)}'`);
  }
  if (candidates.length === 0) throw new Error('a sweep requires at least one candidate');
  const reps = options.reps ?? DEFAULT_SWEEP_REPS;
  if (!Number.isInteger(reps) || reps < 1) throw new Error(`reps must be an integer >= 1, got ${String(options.reps)}`);

  const validated = candidates.map((candidate) => {
    const candidateFull = candidateConfig(config, candidate);
    const issues = validateConfig(candidateFull);
    if (issues.length > 0) {
      throw new Error(
        `candidate ${candidate.id} fails validation: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`,
      );
    }
    return candidateFull;
  });

  const requests: SweepRunRequest[] = [];
  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    for (let repIndex = 0; repIndex < reps; repIndex += 1) {
      requests.push({
        runId: requests.length,
        request: {
          config: validated[candidateIndex] as IntersectionConfig,
          masterSeed: options.masterSeed ?? 1,
          repIndex,
          horizonSeconds: options.horizonSeconds ?? DEFAULT_SWEEP_HORIZON_SECONDS,
          ...(options.tickBudget !== undefined ? { tickBudget: options.tickBudget } : {}),
        },
      });
    }
  }
  return { requests, validated };
}

/** Rank comparator: mean asc, nulls last, ties by candidate id. */
function candidateBefore(a: UnrankedCandidateResult, b: UnrankedCandidateResult): number {
  const aDelay = a.meanControlDelaySeconds;
  const bDelay = b.meanControlDelaySeconds;
  if (aDelay === null && bDelay === null) return a.candidate.id < b.candidate.id ? -1 : a.candidate.id > b.candidate.id ? 1 : 0;
  if (aDelay === null) return 1;
  if (bDelay === null) return -1;
  if (aDelay !== bDelay) return aDelay - bDelay;
  return a.candidate.id < b.candidate.id ? -1 : a.candidate.id > b.candidate.id ? 1 : 0;
}

interface UnrankedCandidateResult {
  readonly candidate: SweepCandidate;
  readonly config: IntersectionConfig;
  readonly reps: readonly CandidateRepOutcome[];
  readonly meanControlDelaySeconds: number | null;
  readonly varianceAcrossReps: number | null;
  readonly sampleStdDevSeconds: number | null;
  readonly meanThroughputVehPerHour: number | null;
  readonly meanMaxQueueCars: number;
  readonly totalTrips: number;
}

function aggregate(candidate: SweepCandidate, config: IntersectionConfig, outcomes: readonly CandidateRepOutcome[]): UnrankedCandidateResult {
  const delays: number[] = [];
  const throughputs: number[] = [];
  let allNonNullOrNull: number | null = null; // mean of delays or null
  let meanThroughput: number | null = null;
  let delaySum = 0;
  let throughputSum = 0;
  let maxQueueSum = 0;
  let totalTrips = 0;
  for (const outcome of outcomes) {
    const summary = outcome.runSummary;
    if (summary.meanControlDelaySeconds !== null) {
      delaySum += summary.meanControlDelaySeconds;
      delays.push(summary.meanControlDelaySeconds);
    }
    if (summary.throughputVehPerHour !== null) {
      throughputSum += summary.throughputVehPerHour;
      throughputs.push(summary.throughputVehPerHour);
    }
    maxQueueSum += summary.maxQueueCars;
    totalTrips += summary.tripCount;
  }
  if (delays.length === outcomes.length && outcomes.length > 0) {
    allNonNullOrNull = delaySum / outcomes.length;
    meanThroughput = throughputs.length === outcomes.length ? throughputSum / outcomes.length : null;
  }
  let variance: number | null = null;
  if (allNonNullOrNull !== null && delays.length >= 2) {
    let squared = 0;
    for (const delay of delays) squared += (delay - allNonNullOrNull) * (delay - allNonNullOrNull);
    variance = squared / (delays.length - 1);
  }
  return {
    candidate,
    config,
    reps: outcomes,
    meanControlDelaySeconds: allNonNullOrNull,
    varianceAcrossReps: variance,
    sampleStdDevSeconds: variance === null ? null : Math.sqrt(variance),
    meanThroughputVehPerHour: meanThroughput,
    meanMaxQueueCars: outcomes.length > 0 ? maxQueueSum / outcomes.length : 0,
    totalTrips,
  };
}

/** Run one stage: all candidates × reps, pairing-asserted, unranked results. */
async function runStage(
  config: IntersectionConfig,
  candidates: readonly SweepCandidate[],
  options: SweepOptions,
): Promise<{ results: readonly UnrankedCandidateResult[]; executorName: string; totalRuns: number }> {
  const { requests, validated } = buildRequests(config, candidates, options);
  const reps = options.reps ?? DEFAULT_SWEEP_REPS;
  let completed = 0;
  const results = await options.executor.run(requests, {
    ...(options.onProgress !== undefined
      ? {
          onResult: () => {
            completed += 1;
            options.onProgress?.({ completed, total: requests.length });
          },
        }
      : {}),
  });
  if (results.length !== requests.length) {
    throw new Error(`executor returned ${String(results.length)} results for ${String(requests.length)} requests`);
  }
  const byRunId = new Map<number, (typeof results)[number]>();
  for (const result of results) byRunId.set(result.runId, result);

  // Pairing assertion (R2 Part B): per rep, identical spawn digest across
  // every candidate — the runtime proof that demand was shared.
  const outcomesPerCandidate: CandidateRepOutcome[][] = candidates.map(() => []);
  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    for (let repIndex = 0; repIndex < reps; repIndex += 1) {
      const runId = candidateIndex * reps + repIndex;
      const result = byRunId.get(runId);
      if (result === undefined) throw new Error(`executor omitted runId ${String(runId)}`);
      outcomesPerCandidate[candidateIndex]?.push({
        repIndex,
        runSummary: result.result.runSummary,
        spawnDigestHex: result.result.spawnDigestHex,
        runHash: result.result.runHash,
        ticksRun: result.result.ticksRun,
      });
    }
  }
  for (let repIndex = 0; repIndex < reps; repIndex += 1) {
    const digests = new Set<string>();
    for (const outcomes of outcomesPerCandidate) {
      digests.add((outcomes[repIndex] as CandidateRepOutcome).spawnDigestHex);
    }
    if (digests.size > 1) {
      throw new PairingViolationError(repIndex, [...digests]);
    }
  }

  const resultsOut = candidates.map((candidate, index) =>
    aggregate(candidate, validated[index] as IntersectionConfig, outcomesPerCandidate[index] as readonly CandidateRepOutcome[]),
  );
  return { results: resultsOut, executorName: options.executor.name, totalRuns: requests.length };
}

/** Rank + assemble a report from unranked per-candidate results. */
function assembleReport(
  unranked: readonly UnrankedCandidateResult[],
  executorName: string,
  totalRuns: number,
  options: SweepOptions,
  stages: readonly { readonly label: string; readonly candidateCount: number }[],
): SweepReport {
  const sorted = [...unranked].sort(candidateBefore);
  const ranked: CandidateSweepResult[] = sorted.map((entry, index) => ({ ...entry, rank: index + 1 }));
  const reps = options.reps ?? DEFAULT_SWEEP_REPS;
  const pairing: { repIndex: number; spawnDigestHex: string }[] = [];
  if (ranked.length > 0) {
    for (let repIndex = 0; repIndex < reps; repIndex += 1) {
      pairing.push({
        repIndex,
        spawnDigestHex: ((ranked[0] as CandidateSweepResult).reps[repIndex] as CandidateRepOutcome).spawnDigestHex,
      });
    }
  }
  return {
    ranked,
    pairing,
    candidateCount: ranked.length,
    totalRuns,
    executorName,
    masterSeed: options.masterSeed ?? 1,
    reps,
    horizonSeconds: options.horizonSeconds ?? DEFAULT_SWEEP_HORIZON_SECONDS,
    stages,
  };
}

/** Single-stage sweep over an explicit candidate list. */
export async function runSweep(
  config: IntersectionConfig,
  candidates: readonly SweepCandidate[],
  options: SweepOptions,
): Promise<SweepReport> {
  const stage = await runStage(config, candidates, options);
  return assembleReport(stage.results, stage.executorName, stage.totalRuns, options, [
    { label: 'single', candidateCount: candidates.length },
  ]);
}

// ---------------------------------------------------------------------------
// Default sweep: coarse grid + (3+ phase rings) refinement around the top-K
// ---------------------------------------------------------------------------

export interface DefaultSweepOptions extends SweepOptions {
  /** Stage-2 refinement breadth (default 3 — R1 §5.2 "top-3"). */
  readonly refineTopK?: number;
  /** Stage-2 transfer window in seconds (default 3). */
  readonly refineWindowSeconds?: number;
  /** Total candidate bound across both stages (default 96). */
  readonly maxCandidates?: number;
  /** Coarse lattice step override (default: auto per ring size). */
  readonly stepSeconds?: number;
}

export async function runDefaultSweep(config: IntersectionConfig, options: DefaultSweepOptions): Promise<SweepReport> {
  const space = greenSplitSpace(config, {
    ...(options.stepSeconds !== undefined ? { stepSeconds: options.stepSeconds } : {}),
    ...(options.maxCandidates !== undefined ? { maxCandidates: options.maxCandidates } : {}),
  });
  const stage1 = await runStage(config, space.candidates, options);

  const phaseCount = space.phaseKinds.length;
  if (phaseCount < 3 || stage1.results.length === 0) {
    return assembleReport(stage1.results, stage1.executorName, stage1.totalRuns, options, [
      { label: `coarse (step ${String(space.stepSeconds)} s, exhaustive at this ring size)`, candidateCount: space.candidates.length },
    ]);
  }

  // Stage 2: refine around the top-K of stage 1 (1 s transfers, deduped
  // against the coarse space, union capped at maxCandidates).
  const topK = options.refineTopK ?? 3;
  const rankedStage1 = [...stage1.results].sort(candidateBefore);
  const bases = rankedStage1.slice(0, topK).map((entry) => entry.candidate);
  const refined = refineCandidates(config, bases, {
    windowSeconds: options.refineWindowSeconds ?? 3,
    ...(options.maxCandidates !== undefined ? { maxCandidates: options.maxCandidates } : {}),
    exclude: space.candidates,
  });

  if (refined.length === 0) {
    return assembleReport(stage1.results, stage1.executorName, stage1.totalRuns, options, [
      { label: `coarse (step ${String(space.stepSeconds)} s)`, candidateCount: space.candidates.length },
    ]);
  }

  const stage2 = await runStage(config, refined, options);
  const merged = [...stage1.results, ...stage2.results];
  return assembleReport(
    merged,
    stage1.executorName,
    stage1.totalRuns + stage2.totalRuns,
    options,
    [
      { label: `coarse (step ${String(space.stepSeconds)} s)`, candidateCount: space.candidates.length },
      { label: `refined (top-${String(topK)}, ±${String(options.refineWindowSeconds ?? 3)} s transfers)`, candidateCount: refined.length },
    ],
  );
}
