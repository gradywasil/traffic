/**
 * Headless run harness (task O1) — one (config, rep) simulation to the
 * horizon, producing the per-run objective (`MetricsEngine.runSummary()`,
 * F7's cumulative ranking input) plus the two R2 Part B/C identifiers:
 * - `spawnDigestHex` — the spawner's rolling pairing digest over the fired
 *   arrival sequence. Same (masterSeed, repIndex, demand, horizon) ⇒ same
 *   digest regardless of the signal plan — this is what the sweep's pairing
 *   assertion compares across candidates.
 * - `runHash` — a rolling digest (dual 32-bit lanes, `DualLaneDigest`) over
 *   the run's identity and trajectory in a pinned order, scoped to what O1
 *   consumes: config serialization, seed words, the spawn digest, per-trip
 *   completion records in completion order, 64-tick checkpoints (alive count,
 *   clamp/safe-cap counters), and the final `RunSummary` quantized Q10.
 *   (R2 Part C's full record — config digest as canonical integers,
 *   per-vehicle (spawnTick, departTick, stops, delayQ) tuples — is Q1's
 *   commitment; O1's variant is deterministic, plan-sensitive and
 *   executor-independent, which is what the sweep's identical-result contract
 *   needs. Documented deviation, see production-log.)
 *
 * Determinism (R2 Part C rule 1): the harness is a pure function of
 * (config, masterSeed, repIndex, horizon, tickBudget) — no clocks, no
 * randomness, no DOM. `performance.now`/`setTimeout` live one layer up, in
 * the executors (explicitly allowed there — budgeting is harness work).
 *
 * The pipeline is the SAME construction and step order as `SimRuntime`
 * (control → world → spawner → metrics), importing the same modules the live
 * app uses — no duplicated sim logic; the worker (worker.ts) calls
 * `executeHeadlessRun` in its own thread.
 */
import type { IntersectionConfig } from '../config';
import { validateConfig } from '../config';
import { buildIntersectionGeometry } from '../geom';
import { stableStringify } from '../geom';
import { createControlSystem } from '../sim/control';
import { DualLaneDigest } from '../sim/hash';
import type { RunSummary } from '../sim/metrics';
import { MetricsEngine } from '../sim/metrics';
import { Spawner } from '../sim/spawn';
import { createCarWorld } from '../sim/world';

/** Car capacity of sweep worlds (matches `SimRuntime`'s default). */
const SWEEP_WORLD_CAPACITY = 512;

/** Checkpoint cadence for the run hash (R2 Part C: 64-tick checkpoints). */
const HASH_CHECKPOINT_TICKS = 64;

export interface HeadlessRunRequest {
  /** Fully validated config; only the signal greens differ between candidates. */
  readonly config: IntersectionConfig;
  /** Master run seed S (uint32). */
  readonly masterSeed: number;
  /** Sweep repetition r (repSeed = H32(S, REP_TAG, r)). */
  readonly repIndex: number;
  /** Horizon in SIM-SECONDS — the tick count derives from `config.dt`. */
  readonly horizonSeconds: number;
  /**
   * Optional deterministic cap on ticks run (R2 Part A's tick budget as a
   * pure function — wall-clock-adaptive shortening is deliberately NOT
   * implemented here because it would break the executors'
   * result-identity acceptance; see production-log).
   */
  readonly tickBudget?: number;
}

export interface HeadlessRunResult {
  readonly runSummary: RunSummary;
  /** Pairing digest over the fired arrival sequence (hex `h0:h1`). */
  readonly spawnDigestHex: string;
  /** Rolling run-hash (hex `h0:h1`) — plan-sensitive, executor-independent. */
  readonly runHash: string;
  /** Ticks actually run (= horizon ticks, or the tick budget if lower). */
  readonly ticksRun: number;
}

/** Horizon → tick count on the config's dt grid (throws off-grid). */
export function horizonTicks(horizonSeconds: number, dt: number): number {
  if (!(horizonSeconds > 0) || !Number.isFinite(horizonSeconds)) {
    throw new Error(`horizonSeconds must be finite > 0, got ${String(horizonSeconds)}`);
  }
  if (!(dt > 0) || !Number.isFinite(dt)) {
    throw new Error(`dt must be finite > 0, got ${String(dt)}`);
  }
  const ticks = Math.round(horizonSeconds / dt);
  if (Math.abs(ticks * dt - horizonSeconds) > 1e-9 || ticks < 1) {
    throw new Error(
      `horizon ${String(horizonSeconds)} s is not on the ${String(dt)} s tick grid`,
    );
  }
  return ticks;
}

/**
 * A run in progress: step it tick by tick (the time-sliced executor's seam)
 * or all at once (`executeHeadlessRun`). `finish()` finalizes the hashes.
 */
export interface HeadlessRunHandle {
  /** Total ticks this run will advance (after any tick budget). */
  readonly totalTicks: number;
  isDone(): boolean;
  /** Advance exactly one tick. Throws when already done. */
  step(): void;
  /** Finalize (idempotent): run summary + digests. */
  finish(): HeadlessRunResult;
}

export function createHeadlessRun(request: HeadlessRunRequest): HeadlessRunHandle {
  const { config } = request;
  const issues = validateConfig(config);
  if (issues.length > 0) {
    throw new Error(`sweep run config is invalid: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`);
  }
  const horizon = horizonTicks(request.horizonSeconds, config.dt);
  const totalTicks = request.tickBudget !== undefined ? Math.min(horizon, Math.max(1, Math.floor(request.tickBudget))) : horizon;

  const geometry = buildIntersectionGeometry(config);
  const world = createCarWorld(geometry, config, { capacity: SWEEP_WORLD_CAPACITY });
  const control = createControlSystem(geometry, config, { capacity: SWEEP_WORLD_CAPACITY });
  const spawner = new Spawner(geometry, config, {
    masterSeed: request.masterSeed,
    repIndex: request.repIndex,
  });
  const metrics = new MetricsEngine(geometry, config);

  const digest = new DualLaneDigest(request.masterSeed);
  digest.word(request.repIndex);
  // Config digest via stable serialization: char codes of the canonical form
  // (sorted keys, shortest-round-trip numbers — deterministic, F3 contract).
  const configString = stableStringify(config);
  for (let i = 0; i < configString.length; i += 1) digest.word(configString.charCodeAt(i));

  let ticksRun = 0;
  let finished: HeadlessRunResult | null = null;

  return {
    totalTicks,
    isDone: () => ticksRun >= totalTicks,
    step: () => {
      if (finished !== null) throw new Error('headless run already finished');
      if (ticksRun >= totalTicks) throw new Error('headless run already at its horizon');
      const constraints = control.step(world);
      world.step(constraints);
      spawner.step(world);
      const completed = metrics.observe(world, spawner.trips);
      for (const trip of completed) {
        digest.word(trip.entityId);
        digest.word(trip.pathIndex);
        digest.quantized10(trip.controlDelaySeconds);
        digest.quantized10(trip.stoppedSeconds);
      }
      if (world.tick % HASH_CHECKPOINT_TICKS === 0) {
        digest.word(world.store.count);
        digest.word(world.clampCount);
        digest.word(world.safeCapBindCount);
      }
      ticksRun += 1;
    },
    finish: () => {
      if (finished !== null) return finished;
      if (ticksRun < totalTicks) {
        throw new Error(`headless run finished early: ${String(ticksRun)}/${String(totalTicks)} ticks`);
      }
      // Absorb the spawn digest's two lanes (hex `h0:h1`).
      const spawnDigestHex = spawner.spawnDigestHex();
      const [spawnH0, spawnH1] = spawnDigestHex.split(':');
      digest.word(Number.parseInt(spawnH0 ?? '0', 16) | 0);
      digest.word(Number.parseInt(spawnH1 ?? '0', 16) | 0);
      // Final metrics, Q10-quantized with explicit presence flags for nulls.
      const summary = metrics.runSummary();
      digest.word(summary.tripCount);
      absorbNullableQuantized(digest, summary.meanControlDelaySeconds);
      absorbNullableQuantized(digest, summary.meanStoppedSeconds);
      absorbNullableQuantized(digest, summary.throughputVehPerHour);
      digest.word(summary.maxQueueCars);
      for (const queue of summary.maxQueuePerChain) digest.word(queue);
      finished = {
        runSummary: summary,
        spawnDigestHex,
        runHash: digest.hex(),
        ticksRun,
      };
      return finished;
    },
  };
}

function absorbNullableQuantized(digest: DualLaneDigest, value: number | null): void {
  if (value === null) {
    digest.word(0);
    return;
  }
  digest.word(1);
  digest.quantized10(value);
}

/** Run a whole (config, rep) to its horizon in one call. */
export function executeHeadlessRun(request: HeadlessRunRequest): HeadlessRunResult {
  const handle = createHeadlessRun(request);
  while (!handle.isDone()) handle.step();
  return handle.finish();
}
