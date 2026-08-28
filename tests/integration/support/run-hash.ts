/**
 * Q1 integration-level run-hash — the FULL R2 Part C record, built on F4's
 * `DualLaneDigest` (src/sim/hash.ts: dual 32-bit `Math.imul` lanes, mixers
 * 0x85ebca6b / 0xc2b2ae35, Q10 quantization with −0 normalization and
 * non-finite rejection).
 *
 * O1's `executeHeadlessRun` ships a plan-scoped run-hash (config
 * serialization via char codes, completions as (entityId, pathIndex, delay,
 * stopped)); the Track B spec assigned the FULL per-vehicle record to Q1:
 *
 *  1. Config digest — canonical INTEGER serialization in a pinned field
 *     order (no floats: durations in ticks, rates/mixes/speeds as Q16.16
 *     fixed point; spec offers "rational numerator/denominator pairs OR
 *     Q16.16" — Q16.16 chosen, one word per scalar).
 *  2. Seed words — (masterSeed, repIndex).
 *  3. Spawn-stream digest — the spawner's rolling `spawnDigest` lanes,
 *     absorbed at finish (the pairing assertion input).
 *  4. Per-vehicle completion records in SPAWN ORDER —
 *     (spawnTick, departTick, stoppedSeconds→Q10, delayQ = floor(delay×1024)).
 *     `stops` is carried as stopped-time quantized Q10: F7's engine
 *     accumulates stopped-TIME (ticks below the 0.5 m/s threshold), not
 *     stop-episode counts — the honest mapping of the record's intent
 *     (documented deviation; the spec's tuple shape is kept).
 *  5. Checkpoint every 64 ticks — (aliveCount, per-arm max queue over the
 *     window since the previous checkpoint); catches divergence that
 *     completes with equal totals. The digest's hex at each checkpoint is
 *     captured into a SEQUENCE — "bit-identical run hash sequences".
 *  6. Final metrics — `runSummary()` quantized Q10 in a pinned field order,
 *     nullables behind presence-flag words.
 *
 * Mid-run config changes are absorbed too: a scope code + the full canonical
 * config digest of the new config at the tick they take effect (config
 * changes are part of the run's identity).
 *
 * The recorder is a PASSIVE sink fed by the pipeline runner (support/pipeline.ts)
 * — it holds no references to sim objects, so world replacement on
 * 'reset'-scope config changes cannot alias.
 */
import { ARM_IDS, TURN_DIRECTIONS } from '../../../src/config';
import type { IntersectionConfig, SignalPhaseKind } from '../../../src/config';
import { DualLaneDigest } from '../../../src/sim/hash';
import type { CompletedTripMetrics } from '../../../src/sim/metrics';
import type { TripRecord } from '../../../src/sim/spawn';

/** Magic first word of a config digest (version-pins the field order). */
const CONFIG_DIGEST_MAGIC = 0x51496366 | 0; // "Q1cf"

/** Checkpoint cadence in ticks (R2 Part C: "checkpoint every 64 ticks"). */
export const HASH_CHECKPOINT_TICKS = 64;

/** Pinned phase-kind order for canonical plan serialization. */
const PHASE_KINDS: readonly SignalPhaseKind[] = [
  'ns-protected-left',
  'ns-through-right',
  'ew-protected-left',
  'ew-through-right',
];

/** Q16.16 fixed point — floor(x · 65536); asserts finiteness (no NaN/Inf words). */
function q16(x: number): number {
  if (!Number.isFinite(x)) throw new Error(`cannot serialize non-finite config value: ${String(x)}`);
  return Math.floor(x * 65536);
}

/**
 * Canonical integer serialization of an IntersectionConfig (R2 Part C item 1):
 * pinned field order, every word an integer — durations as tick counts,
 * continuous scalars as Q16.16. Two configs serialize identically iff they are
 * identical up to Q16.16/Q-tick resolution; trajectory + spawn-digest
 * sensitivity to the raw floats comes from the run itself.
 */
export function absorbCanonicalConfig(digest: DualLaneDigest, config: IntersectionConfig): void {
  digest.word(CONFIG_DIGEST_MAGIC);
  digest.word(q16(config.dt));
  digest.word(q16(config.geometry.laneWidthMeters));

  // modelParams in pinned declaration order.
  const mp = config.modelParams;
  const paramWords: readonly number[] = [
    q16(mp.cruiseSpeedMps),
    q16(mp.timeHeadwaySeconds),
    q16(mp.maxAccelerationMps2),
    q16(mp.comfortableDecelMps2),
    q16(mp.minGapMeters),
    q16(mp.accelerationExponent),
    q16(mp.carLengthMeters),
    q16(mp.emergencyDecelMps2),
    q16(mp.hardMinGapMeters),
    q16(mp.lateralAccelMps2),
    q16(mp.yellowReactionSeconds),
    q16(mp.yellowDecelMps2),
  ];
  for (const w of paramWords) digest.word(w);

  // Arms in canonical N, E, S, W order.
  for (const armId of ARM_IDS) {
    const arm = config.arms[armId];
    digest.word(arm.lanes.length);
    for (const lane of arm.lanes) {
      digest.word(lane.designations.length);
      for (const turn of lane.designations) {
        const index = TURN_DIRECTIONS.indexOf(turn);
        if (index < 0) throw new Error(`unknown turn designation '${turn}'`);
        digest.word(index);
      }
    }
    digest.word(q16(arm.spawnRateVehPerHour));
    digest.word(q16(arm.turnMix.left));
    digest.word(q16(arm.turnMix.through));
    digest.word(q16(arm.turnMix.right));
    digest.word(q16(arm.cruiseSpeedMps));
  }

  // Control.
  if (config.control.type === 'all-way-stop') {
    digest.word(1);
    return;
  }
  digest.word(0);
  const plan = config.control.plan;
  digest.word(Math.round(plan.cycleLengthSeconds / config.dt)); // ticks
  digest.word(plan.leftMode.ns === 'protected' ? 1 : 0);
  digest.word(plan.leftMode.ew === 'protected' ? 1 : 0);
  digest.word(plan.phases.length);
  for (const phase of plan.phases) {
    const kindIndex = PHASE_KINDS.indexOf(phase.kind);
    if (kindIndex < 0) throw new Error(`unknown phase kind '${phase.kind}'`);
    digest.word(kindIndex);
    digest.word(Math.round(phase.greenSeconds / config.dt)); // ticks
  }
}

/** One per-tick observation fed to the recorder by the pipeline runner. */
export interface RecorderTick {
  /** 1-based tick count of THIS run (monotonic across 'reset' scope changes). */
  readonly tick: number;
  readonly aliveCount: number;
  /** Stopped-queue car count per arm (N, E, S, W order) this tick. */
  readonly armQueues: readonly number[];
  /** Metrics completions (exit-gate) observed this tick. */
  readonly completions: readonly CompletedTripMetrics[];
  /** Spawner trip records (path-end departures) observed this tick. */
  readonly trips: readonly TripRecord[];
}

/** Final run-hash outcome — the sequence plus telemetry for vacuity guards. */
export interface RunHashOutcome {
  /** Digest hex at every 64-tick checkpoint (bit-identity is asserted on this). */
  readonly checkpoints: readonly string[];
  /** Final digest hex (after spawn-digest + final-metrics absorption). */
  readonly finalHash: string;
  /** Total 32-bit words absorbed (vacuity guard: a real run absorbs many). */
  readonly wordCount: number;
  /** Floats absorbed — every one through `DualLaneDigest.quantized10` (Q10). */
  readonly quantizedCount: number;
  /** Completion records emitted so far (per-vehicle tuples). */
  readonly completionCount: number;
}

/** Joined completion record awaiting checkpoint flush. */
interface JoinedRecord {
  readonly spawnTick: number;
  readonly entityId: number;
  readonly departTick: number;
  readonly stoppedSeconds: number;
  readonly delaySeconds: number;
}

export class IntegrationRunHash {
  private readonly digest: DualLaneDigest;
  private readonly completionsById = new Map<number, CompletedTripMetrics>();
  private readonly tripsById = new Map<number, TripRecord>();
  private readonly armWindowMax = [0, 0, 0, 0];
  private readonly checkpoints: string[] = [];
  private words = 0;
  private quantized = 0;
  private completionRecords = 0;
  private finished = false;

  constructor(masterSeed: number, repIndex: number, config: IntersectionConfig) {
    this.digest = new DualLaneDigest(masterSeed | 0);
    this.word(0x51496e52 | 0); // "Q1nR" run-record magic
    this.word(masterSeed | 0); // seed words (R2 Part C item 2)
    this.word(repIndex | 0);
    absorbCanonicalConfig(this.digest, config); // item 1
  }

  /** A config change took effect at a tick boundary (scope + new identity). */
  configChangeApplied(scope: 'live' | 'reset', next: IntersectionConfig): void {
    this.word(scope === 'live' ? 1 : 2);
    absorbCanonicalConfig(this.digest, next);
  }

  /** Ingest one tick's observations; auto-checkpoints every 64 ticks. */
  observe(tick: RecorderTick): void {
    if (this.finished) throw new Error('run hash already finished');
    for (let arm = 0; arm < 4; arm += 1) {
      const q = tick.armQueues[arm] ?? 0;
      const current = this.armWindowMax[arm] ?? 0;
      if (q > current) this.armWindowMax[arm] = q;
    }
    for (const completion of tick.completions) this.completionsById.set(completion.entityId, completion);
    for (const trip of tick.trips) this.tripsById.set(trip.entityId, trip);
    if (tick.tick % HASH_CHECKPOINT_TICKS === 0) this.checkpoint(tick.aliveCount);
  }

  /**
   * Finalize: flush completions, absorb the spawner's pairing digest lanes
   * (item 3) and the final run summary quantized Q10 (item 6). Idempotent.
   */
  finish(spawnDigestHex: string, summary: {
    readonly tripCount: number;
    readonly meanControlDelaySeconds: number | null;
    readonly meanStoppedSeconds: number | null;
    readonly throughputVehPerHour: number | null;
    readonly maxQueueCars: number;
    readonly maxQueuePerChain: readonly number[];
  }): RunHashOutcome {
    if (this.finished) throw new Error('run hash already finished');
    this.finished = true;
    this.flushCompletions();
    const [h0, h1] = spawnDigestHex.split(':');
    this.word(Number.parseInt(h0 ?? '0', 16) | 0);
    this.word(Number.parseInt(h1 ?? '0', 16) | 0);
    this.word(summary.tripCount);
    this.absorbNullableQ10(summary.meanControlDelaySeconds);
    this.absorbNullableQ10(summary.meanStoppedSeconds);
    this.absorbNullableQ10(summary.throughputVehPerHour);
    this.word(summary.maxQueueCars);
    for (const chain of summary.maxQueuePerChain) this.word(chain);
    return this.outcome();
  }

  /** Current outcome without finalizing (checkpoint sequence so far). */
  outcome(): RunHashOutcome {
    return {
      checkpoints: [...this.checkpoints],
      finalHash: this.digest.hex(),
      wordCount: this.words,
      quantizedCount: this.quantized,
      completionCount: this.completionRecords,
    };
  }

  /** Absorb the digest's current hex as a checkpoint snapshot. */
  private checkpoint(aliveCount: number): void {
    this.flushCompletions();
    this.word(aliveCount);
    for (let arm = 0; arm < 4; arm += 1) {
      this.word(this.armWindowMax[arm] ?? 0);
      this.armWindowMax[arm] = 0;
    }
    this.checkpoints.push(this.digest.hex());
  }

  /**
   * Emit joined completion records in SPAWN ORDER (spawnTick, then entityId
   * tiebreak) — R2 Part C item 4. A record is emitted once both halves (the
   * metrics completion and the spawner trip) have been observed; still-in-flight
   * cars at horizon end emit nothing (deterministic given an identical run).
   */
  private flushCompletions(): void {
    const joined: JoinedRecord[] = [];
    for (const [entityId, trip] of this.tripsById) {
      const completion = this.completionsById.get(entityId);
      if (completion === undefined) continue;
      joined.push({
        spawnTick: trip.spawnTick,
        entityId,
        departTick: trip.departTick,
        stoppedSeconds: completion.stoppedSeconds,
        delaySeconds: completion.controlDelaySeconds,
      });
    }
    joined.sort((a, b) => (a.spawnTick - b.spawnTick) || (a.entityId - b.entityId));
    for (const record of joined) {
      this.word(record.spawnTick);
      this.word(record.departTick);
      this.quantize10(record.stoppedSeconds);
      this.quantize10(record.delaySeconds); // delayQ = floor(delay × 1024)
      this.tripsById.delete(record.entityId);
      this.completionsById.delete(record.entityId);
      this.completionRecords += 1;
    }
  }

  /** Nullable float → presence flag + Q10 word (nullables in final metrics). */
  private absorbNullableQ10(value: number | null): void {
    if (value === null) {
      this.word(0);
      return;
    }
    this.word(1);
    this.quantize10(value);
  }

  private word(w: number): void {
    this.digest.word(w);
    this.words += 1;
  }

  private quantize10(value: number): void {
    if (!Number.isFinite(value)) {
      throw new Error(`run hash cannot quantize non-finite value: ${String(value)}`);
    }
    this.digest.quantized10(value); // floor(x × 1024) after −0 + +0 normalization
    this.quantized += 1;
  }
}
