/**
 * Q1 integration pipeline runner — one full run through the production
 * pipeline (spawner + control + world + metrics, the `SimRuntime` order),
 * with scripted mid-run config changes and optional per-tick footprint
 * overlap checking (the F5 soak assertions, integration-level with the REAL
 * spawner in the loop).
 *
 * The runner builds on `SimRuntime` itself (the live app's pipeline owner):
 * construction, `step` order and `applyConfig` semantics are the production
 * ones — no duplicated sim logic. One test-harness subclass captures what
 * `SimRuntime.step` discards: the tick's metrics completions (the run-hash's
 * per-vehicle records). Its `step` is the same four calls in the same order
 * as `SimRuntime.step` (auditable side by side).
 */
import { ARM_IDS } from '../../../src/config';
import type { IntersectionConfig } from '../../../src/config';
import { sampleAtS, segmentDistance, CAR_WIDTH_METERS } from '../../../src/geom';
import type { IntersectionGeometry } from '../../../src/geom';
import { METRICS_STOPPED_SPEED_MPS } from '../../../src/sim/metrics/constants';
import type { CompletedTripMetrics, MetricsSnapshot, RunSummary } from '../../../src/sim/metrics';
import { f64At, i32At } from '../../../src/sim/store';
import type { CarWorld } from '../../../src/sim/world';
import { SimRuntime } from '../../../src/ui/sim-runtime';
import type { ConfigChangeScope } from '../../../src/ui/sim-runtime';
import { IntegrationRunHash } from './run-hash';
import type { RunHashOutcome } from './run-hash';

/** Footprint overlap epsilon (F5 soak value — float-noise guard). */
const OVERLAP_EPS = 1e-7;
/** Center-prune bound: max half-length sum + width, + slack (lengths vary 5 ± 0.5 m). */
const CENTER_PRUNE_METERS = 8;

/** `SimRuntime.step` with the metrics completions captured (same 4 calls, same order). */
class HarnessRuntime extends SimRuntime {
  lastCompletions: readonly CompletedTripMetrics[] = [];

  override step(): void {
    const constraints = this.control.step(this.world);
    this.world.step(constraints);
    this.spawner.step(this.world);
    this.lastCompletions = this.metrics.observe(this.world, this.spawner.trips);
  }
}

/** A scripted mid-run config change: `config` takes effect before tick `atTick` + 1. */
export interface ScriptedChange {
  /** Apply when exactly this many ticks have completed (tick boundary). */
  readonly atTick: number;
  readonly config: IntersectionConfig;
}

export interface PipelineOptions {
  readonly config: IntersectionConfig;
  readonly masterSeed: number;
  /** Total ticks to advance this run (config's dt grid). */
  readonly ticks: number;
  /** Mid-run config changes, applied at their tick boundaries (any order; sorted internally). */
  readonly changes?: readonly ScriptedChange[];
  /** World capacity (soak headroom; default 600). */
  readonly capacity?: number;
  /** Per-tick footprint overlap checking (F5 soak assertions). Default false. */
  readonly checkOverlaps?: boolean;
  /** Skip run-hash recording (pure perf/soak variants). Default: record. */
  readonly hash?: boolean;
}

export interface PipelineResult {
  readonly runHash: RunHashOutcome;
  /** Final rolling-window snapshot (deep-equality input for determinism). */
  readonly snapshot: MetricsSnapshot;
  /** Final cumulative summary (deep-equality input for determinism). */
  readonly runSummary: RunSummary;
  /** Final pairing digest of the (final) spawner segment. */
  readonly spawnDigestHex: string;
  /** Scopes of the applied scripted changes, in application order. */
  readonly scopes: readonly ConfigChangeScope[];
  readonly peakAlive: number;
  /** Completed trips observed across the whole run (all spawner segments). */
  readonly tripsCompleted: number;
  /** Cumulative terminal-clamp firings across world segments (assert 0). */
  readonly clampCount: number;
  /** Stop-line crossings without a grant across control segments (assert 0). */
  readonly ungrantedLineCrossings: number;
  readonly grants: number;
  /** Max virtual entry-queue depth (spillback evidence; final spawner segment). */
  readonly maxVirtualQueueDepth: number;
  /** Minimum footprint centerline distance observed (only with checkOverlaps). */
  readonly minFootprintDistance: number;
  /** Footprint overlap count — the soak invariant (assert 0). */
  readonly overlapCount: number;
}

export function runPipeline(options: PipelineOptions): PipelineResult {
  const rt = new HarnessRuntime(options.config, {
    masterSeed: options.masterSeed,
    capacity: options.capacity ?? 600,
  });
  const changes = [...(options.changes ?? [])].sort((a, b) => a.atTick - b.atTick);
  const recordHash = options.hash !== false;
  const recorder = recordHash
    ? new IntegrationRunHash(options.masterSeed, 0, options.config)
    : null;

  const scopes: ConfigChangeScope[] = [];
  let peakAlive = 0;
  let tripsCompleted = 0;
  let clampTotal = 0;
  let prevClamp = 0;
  let currentWorld: CarWorld = rt.world;
  let minFootprint = Number.POSITIVE_INFINITY;
  let overlapCount = 0;

  // Scratch buffers for the footprint capsules (capacity-bound).
  const capacity = options.capacity ?? 600;
  const cx = new Float64Array(capacity);
  const cy = new Float64Array(capacity);
  const ax1 = new Float64Array(capacity);
  const ay1 = new Float64Array(capacity);
  const ax2 = new Float64Array(capacity);
  const ay2 = new Float64Array(capacity);

  for (let tick = 1; tick <= options.ticks; tick += 1) {
    // Config changes apply BETWEEN ticks (the SimRuntime contract).
    while (changes.length > 0 && (changes[0] as ScriptedChange).atTick === tick - 1) {
      const change = changes.shift() as ScriptedChange;
      const result = rt.applyConfig(change.config);
      if (result.scope === 'none') {
        throw new Error(`scripted change at tick ${String(change.atTick)} classified as 'none' (not a change)`);
      }
      scopes.push(result.scope);
      recorder?.configChangeApplied(result.scope, change.config);
      currentWorld = rt.world;
      prevClamp = 0;
    }

    rt.step();

    // World-segment accounting (world is replaced on 'reset'-scope changes).
    if (rt.world !== currentWorld) {
      currentWorld = rt.world;
      prevClamp = 0;
    }
    clampTotal += currentWorld.clampCount - prevClamp;
    prevClamp = currentWorld.clampCount;

    const world = rt.world;
    const store = world.store;
    const geometry: IntersectionGeometry = rt.geometry;
    const alive = store.count;
    if (alive > peakAlive) peakAlive = alive;
    const trips = rt.spawner.trips;
    tripsCompleted += trips.length;

    // Per-arm stopped queue (checkpoint input; also the spillback view).
    const armQueues = [0, 0, 0, 0];
    if (recorder !== null) {
      for (let i = 0; i < alive; i += 1) {
        const movement = geometry.movements[i32At(store.pathIndex, i)];
        if (movement === undefined) continue;
        if (f64At(store.s, i) <= movement.stopLineS && f64At(store.speed, i) < METRICS_STOPPED_SPEED_MPS) {
          const arm = ARM_IDS.indexOf(movement.arm);
          armQueues[arm] = (armQueues[arm] ?? 0) + 1;
        }
      }
      recorder.observe({
        tick,
        aliveCount: alive,
        armQueues,
        completions: rt.lastCompletions,
        trips,
      });
    }

    // Footprint non-intersection (F3 capsule model) — every tick, all pairs,
    // AABB-pruned on centers (the F5 soak assertion set).
    if (options.checkOverlaps === true) {
      for (let i = 0; i < alive; i += 1) {
        const movement = geometry.movements[i32At(store.pathIndex, i)];
        if (movement === undefined) continue;
        const sample = sampleAtS(movement.samples, f64At(store.s, i));
        const halfLen = (f64At(store.carLengthMeters, i) - CAR_WIDTH_METERS) / 2;
        cx[i] = sample.x;
        cy[i] = sample.y;
        ax1[i] = sample.x - sample.hx * halfLen;
        ay1[i] = sample.y - sample.hy * halfLen;
        ax2[i] = sample.x + sample.hx * halfLen;
        ay2[i] = sample.y + sample.hy * halfLen;
      }
      for (let i = 0; i < alive; i += 1) {
        for (let j = i + 1; j < alive; j += 1) {
          const dx = (cx[i] as number) - (cx[j] as number);
          if (dx > CENTER_PRUNE_METERS || dx < -CENTER_PRUNE_METERS) continue;
          const dy = (cy[i] as number) - (cy[j] as number);
          if (dy > CENTER_PRUNE_METERS || dy < -CENTER_PRUNE_METERS) continue;
          const distance = segmentDistance(
            { x: ax1[i] as number, y: ay1[i] as number },
            { x: ax2[i] as number, y: ay2[i] as number },
            { x: ax1[j] as number, y: ay1[j] as number },
            { x: ax2[j] as number, y: ay2[j] as number },
          );
          if (distance < minFootprint) minFootprint = distance;
          if (distance < CAR_WIDTH_METERS - OVERLAP_EPS) overlapCount += 1;
        }
      }
    }
  }

  if (changes.length > 0) {
    throw new Error(`scripted change at tick ${String((changes[0] as ScriptedChange).atTick)} is beyond the horizon`);
  }

  const stats = rt.control.claims.stats;
  const outcome = recorder !== null
    ? recorder.finish(rt.spawner.spawnDigestHex(), rt.metrics.runSummary())
    : {
        checkpoints: [],
        finalHash: '',
        wordCount: 0,
        quantizedCount: 0,
        completionCount: 0,
      };
  return {
    runHash: outcome,
    snapshot: rt.metrics.snapshot(),
    runSummary: rt.metrics.runSummary(),
    spawnDigestHex: rt.spawner.spawnDigestHex(),
    scopes,
    peakAlive,
    tripsCompleted,
    clampCount: clampTotal,
    ungrantedLineCrossings: stats.ungrantedLineCrossings,
    grants: stats.grants,
    maxVirtualQueueDepth: rt.spawner.stats.maxVirtualQueueDepth,
    minFootprintDistance: minFootprint,
    overlapCount,
  };
}
