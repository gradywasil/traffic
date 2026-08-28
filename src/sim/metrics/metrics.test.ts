/**
 * Metrics engine acceptance tests (task F7; plan acceptance line + R1 §6.1):
 *
 * 1. free-flow car ⇒ ~0 delay: unimpeded through car within (−dt, +dt)
 *    (the R1 §6.1 by-construction tick-quantization bound); turning cars
 *    within a small documented slow-roll (IDM's asymptotic accel vs the
 *    canonical constant-a FF profile);
 * 2. fully stopped car of known duration K ⇒ stopped-time ≈ K, control
 *    delay = K + slow-roll (decel/accel ramps — the documented difference
 *    between the two metrics), and delay is exactly linear in K;
 * 3. scripted single car with a known K-sim-second stop ⇒ delay matches
 *    hand math computed independently from the movement geometry (1e-9);
 * 4. rolling window drops expired samples (sim-time based);
 * 5. config-change reset clears every aggregate;
 * 6. determinism: identical seeded runs ⇒ identical aggregate outputs
 *    (value equality over the full snapshot + run summary);
 * 7. queue/throughput bookkeeping: threshold boundaries, per-arm/lane max,
 *    veh/h hand math.
 *
 * Measured calibration values referenced below (defaults, v_c = 13.9 m/s):
 * unimpeded through delay 0.002 s; unimpeded turn delay ≤ 0.336 s; full-
 * pipeline green transit through delay 0.002 s and turns ≤ 0.336 s (the
 * control layer gates its stop-line barrier to the request line — T-F5b —
 * so a car with authority is not braked from afar; see the green-transit
 * test comment); stopped-car slow-roll 7.702 s.
 */
import { describe, expect, it } from 'vitest';
import type { IntersectionConfig } from '../../config';
import { createDefaultConfig } from '../../config/defaults';
import { buildIntersectionGeometry, getMovement } from '../../geom';
import type { IntersectionGeometry, MovementGeometry } from '../../geom';
import { createControlSystem } from '../control';
import type { ControlSystem } from '../control';
import { Spawner } from '../spawn';
import { unconstrainedConstraints } from '../store';
import { createCarWorld } from '../world';
import type { CarWorld } from '../world';
import { METRICS_STOPPED_SPEED_MPS } from './constants';
import { MetricsEngine } from './engine';
import type { CompletedTripMetrics } from './types';
import { meanOf, percentileOfSorted, sortedAscending } from './stats';

const DT = createDefaultConfig().dt;
const P = createDefaultConfig().modelParams;
const VC = P.cruiseSpeedMps;

interface FullSim {
  readonly config: IntersectionConfig;
  readonly geometry: IntersectionGeometry;
  readonly world: CarWorld;
  readonly control: ControlSystem;
  readonly spawner: Spawner;
  readonly metrics: MetricsEngine;
}

function fullSim(config: IntersectionConfig, masterSeed: number): FullSim {
  const geometry = buildIntersectionGeometry(config);
  return {
    config,
    geometry,
    world: createCarWorld(geometry, config, { capacity: 600 }),
    control: createControlSystem(geometry, config, { capacity: 600 }),
    spawner: new Spawner(geometry, config, { masterSeed, repIndex: 0 }),
    metrics: new MetricsEngine(geometry, config),
  };
}

/** One tick of the production pipeline: control → world → spawner → metrics. */
function stepSim(sim: FullSim): readonly CompletedTripMetrics[] {
  sim.world.step(sim.control.step(sim.world));
  sim.spawner.step(sim.world);
  return sim.metrics.observe(sim.world, sim.spawner.trips);
}

/** World + metrics only (no control layer, no spawner). */
function bareSim(): { config: IntersectionConfig; geometry: IntersectionGeometry; world: CarWorld; metrics: MetricsEngine } {
  const config = createDefaultConfig();
  const geometry = buildIntersectionGeometry(config);
  return {
    config,
    geometry,
    world: createCarWorld(geometry, config, { capacity: 64 }),
    metrics: new MetricsEngine(geometry, config),
  };
}

function movementOf(sim: { geometry: IntersectionGeometry }, turn: 'left' | 'through' | 'right'): MovementGeometry {
  const movement = getMovement(sim.geometry, 'north', 0, turn);
  if (movement === undefined) throw new Error(`missing north:0:${turn} movement`);
  return movement;
}

/** Spawn one car at `s` at cruise speed on a movement; returns its entity id. */
function spawnCar(sim: { world: CarWorld; geometry: IntersectionGeometry; config: IntersectionConfig }, movement: MovementGeometry, s: number, speed = VC): number {
  return sim.world.store.addCar(
    {
      pathIndex: sim.geometry.movements.indexOf(movement),
      s,
      speed,
      carLengthMeters: sim.config.modelParams.carLengthMeters,
    },
    sim.world.tick,
    sim.geometry.movements,
  );
}

/**
 * Drive one car through the (unimpeded, control-free) world until its trip
 * completes; returns the completed metrics record.
 */
function runUnimpededCar(turn: 'left' | 'through' | 'right'): CompletedTripMetrics {
  const sim = bareSim();
  const movement = movementOf(sim, turn);
  spawnCar(sim, movement, 0);
  for (let t = 0; t < 2000; t += 1) {
    const done = sim.metrics.observe(sim.world, sim.world.departures);
    if (done.length > 0) return done[0] as CompletedTripMetrics;
    sim.world.step();
  }
  throw new Error(`unimpeded ${turn} car never completed`);
}

/**
 * Scripted stop via the CarConstraints seam: hold a stop-line barrier (the
 * F5 placement, stopLineS + s0) until the car has been stopped for exactly
 * `holdSeconds`, then release. Returns the completed trip.
 */
function runScriptedStopCar(holdSeconds: number): CompletedTripMetrics {
  const sim = bareSim();
  const movement = movementOf(sim, 'through');
  const barrierS = movement.stopLineS + sim.config.modelParams.minGapMeters;
  spawnCar(sim, movement, 0);
  let stoppedAtTick: number | null = null;
  const holdTicks = Math.round(holdSeconds / sim.config.dt);
  for (let t = 0; t < 4000; t += 1) {
    const count = sim.world.store.count;
    const constraints = unconstrainedConstraints(count);
    const holding = stoppedAtTick === null || t - stoppedAtTick < holdTicks;
    if (holding && count > 0) constraints.barrierS[0] = barrierS;
    sim.world.step(constraints);
    const done = sim.metrics.observe(sim.world, sim.world.departures);
    if (done.length > 0) return done[0] as CompletedTripMetrics;
    if (stoppedAtTick === null && count > 0 && (sim.world.store.speed[0] ?? 0) < METRICS_STOPPED_SPEED_MPS) {
      stoppedAtTick = t;
    }
  }
  throw new Error('scripted-stop car never completed');
}

/**
 * Synthetic per-tick driver: moves chosen cars to scripted absolute
 * positions/speeds (no physics), then advances tick/time exactly like
 * CarWorld does. The engine only ever sees store state — this is the
 * hand-computable feed.
 */
interface SynthMove {
  readonly index: number;
  readonly s: number;
  readonly speed: number;
}

function synthTick(sim: { world: CarWorld }, moves: readonly SynthMove[]): void {
  const store = sim.world.store;
  for (const move of moves) {
    store.prevS[move.index] = store.s[move.index] ?? 0;
  }
  for (const move of moves) {
    store.s[move.index] = move.s;
    store.speed[move.index] = move.speed;
  }
  sim.world.tick += 1;
  sim.world.time = sim.world.tick * sim.world.dt;
}

// ---------------------------------------------------------------------------
// 1. Free-flow cars
// ---------------------------------------------------------------------------

describe('F7 acceptance: free-flow car has ~0 delay', () => {
  it('unimpeded through car measures delay within one tick (R1 §6.1 bound)', () => {
    const trip = runUnimpededCar('through');
    // By construction (R1 §6.1): gate times are tick-quantized, each with an
    // error in [0, dt), so a canonical free-flower lands in (−dt, +dt).
    // Measured: 0.002 s.
    expect(trip.controlDelaySeconds).toBeGreaterThanOrEqual(-DT);
    expect(trip.controlDelaySeconds).toBeLessThanOrEqual(DT);
    expect(trip.stoppedSeconds).toBe(0);
  });

  it('unimpeded turning cars stay within the documented IDM slow-roll', () => {
    // Turning paths re-accelerate via the IDM free term (asymptotic toward
    // v_c) while the canonical FF(p) profile assumes constant-a: the exit
    // ramp therefore costs ~0.3 s extra (measured 0.336/0.286 s for
    // left/right at defaults). Ceiling 0.75 s with the analytic estimate
    // ~ (vc/a)·[∫dx/(1−x⁴)] − (vc−vt)/a ≈ 0.4 s padded.
    for (const turn of ['left', 'right'] as const) {
      const trip = runUnimpededCar(turn);
      expect(trip.controlDelaySeconds).toBeGreaterThanOrEqual(-DT);
      expect(trip.controlDelaySeconds).toBeLessThanOrEqual(0.75);
      expect(trip.stoppedSeconds).toBe(0);
    }
  });

  it('green transit through the full control pipeline stays small-positive', () => {
    // Full pipeline (F5 claims + signal). Spawned 2 m before the entry gate
    // on green, the through car keeps its free-run number: since T-F5b the
    // stop-line barrier is erected only from the request line onward
    // (phase PENDING), so a car with authority is granted as it reaches
    // the request distance and IDM's long-range interaction term never
    // sheds approach speed. Previously ~1.5 s (barrier-from-spawn
    // artifact; through cars floored at +2.1 s from s=0). Measured: 0.002 s.
    const sim = fullSim(createDefaultConfig(), 1);
    const movement = getMovement(sim.geometry, 'north', 0, 'through');
    if (movement === undefined) throw new Error('missing through movement');
    spawnCar(sim, movement, movement.entryGateS - 2);
    let trip: CompletedTripMetrics | null = null;
    for (let t = 0; t < 2000 && trip === null; t += 1) {
      const done = stepSim(sim);
      trip = done[0] ?? null;
    }
    expect(trip).not.toBeNull();
    const value = (trip as CompletedTripMetrics).controlDelaySeconds;
    expect(value).toBeGreaterThanOrEqual(-DT);
    expect(value).toBeLessThanOrEqual(0.05);
    expect((trip as CompletedTripMetrics).stoppedSeconds).toBe(0);
    expect(sim.metrics.droppedDepartureCount).toBe(0);
  });

  it('unimpeded turns through the full control pipeline stay at free-run levels', () => {
    // The T-F5b companion case: turn cars previously carried ~+0.4 s of
    // approach-barrier inflation on top of the documented IDM slow-roll
    // (never-stopped turn inflation measured +0.7/+1.0 s in traffic).
    // Unimpeded on green they must land in the same band as the control-free
    // world above. Measured: left 0.336 s, right 0.286 s.
    for (const turn of ['left', 'right'] as const) {
      const sim = fullSim(createDefaultConfig(), 1);
      const movement = getMovement(sim.geometry, 'north', 0, turn);
      if (movement === undefined) throw new Error(`missing ${turn} movement`);
      spawnCar(sim, movement, movement.entryGateS - 2);
      let trip: CompletedTripMetrics | null = null;
      for (let t = 0; t < 2000 && trip === null; t += 1) {
        const done = stepSim(sim);
        trip = done[0] ?? null;
      }
      expect(trip).not.toBeNull();
      const value = (trip as CompletedTripMetrics).controlDelaySeconds;
      expect(value).toBeGreaterThanOrEqual(-DT);
      expect(value).toBeLessThanOrEqual(0.75);
      expect((trip as CompletedTripMetrics).stoppedSeconds).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Fully stopped car of known duration
// ---------------------------------------------------------------------------

describe('F7 acceptance: fully stopped car ⇒ delay ≈ stopped duration + slow-roll', () => {
  it('stopped-time tracks the hold; control delay = hold + ramps; exactly linear in K', () => {
    const short = runScriptedStopCar(5);
    const long = runScriptedStopCar(10);

    // Stopped-time ≈ K ± the settle/release ticks around the barrier
    // (measured K + 0.3 s: crawling below 0.5 m/s before the full stop plus
    // the release tick).
    for (const [trip, k] of [
      [short, 5],
      [long, 10],
    ] as const) {
      expect(Math.abs(trip.stoppedSeconds - k)).toBeLessThanOrEqual(0.5);
    }

    // Control delay = stopped duration + slow-roll (the DOCUMENTED
    // difference: deceleration into the stop and acceleration out of it —
    // none of which stopped-time charges; HCM control delay includes both,
    // E6). Ramp bound: v_c/(2b) + v_c/(2a) + settle ≈ 3.5 + 5.4 ≈ 8.8 < 9.
    // Measured slow-roll: 7.702 s.
    for (const [trip, k] of [
      [short, 5],
      [long, 10],
    ] as const) {
      expect(trip.controlDelaySeconds).toBeGreaterThan(trip.stoppedSeconds);
      expect(trip.controlDelaySeconds - trip.stoppedSeconds).toBeLessThanOrEqual(9);
      expect(trip.controlDelaySeconds).toBeGreaterThan(k);
    }

    // Linearity — the hand relationship: holding 5 s longer adds exactly
    // 5.000 s of control delay (measured 18.002 − 13.002).
    expect(long.controlDelaySeconds - short.controlDelaySeconds).toBeCloseTo(5, 6);
    expect(long.stoppedSeconds).toBeGreaterThan(short.stoppedSeconds);
  });
});

// ---------------------------------------------------------------------------
// 3. Hand-computable scripted scenario (exact math)
// ---------------------------------------------------------------------------

describe('F7 acceptance: known-script scenario matches hand math', () => {
  it('scripted single car with a K-sim-second stop matches independent hand computation', () => {
    const sim = bareSim();
    const movement = movementOf(sim, 'through');
    const metrics = sim.metrics;
    const step = VC * DT; // 1.39 m per cruise tick

    // Hand trajectory: cross the entry gate exactly at tick 1, cruise A
    // ticks, freeze for K ticks (v = 0), cruise B ticks to/through the exit
    // gate — all positions absolute (no cumulative drift).
    const K = 20;
    const stopS = movement.entryGateS + 25; // comfortably inside the zone
    const A = Math.ceil((stopS - movement.entryGateS) / step);
    const B = Math.ceil((movement.exitGateS - stopS) / step);
    const entityId = spawnCar(sim, movement, movement.entryGateS - step);

    let done: readonly CompletedTripMetrics[] = [];
    for (let tick = 1; tick <= 1 + A + K + B; tick += 1) {
      const s =
        tick <= 1 + A
          ? movement.entryGateS + (tick - 1) * step
          : tick <= 1 + A + K
            ? stopS
            : stopS + (tick - 1 - A - K) * step;
      const speed = tick > 1 + A && tick <= 1 + A + K ? 0 : VC;
      synthTick(sim, [{ index: sim.world.store.indexOfEntity(entityId), s, speed }]);
      done = metrics.observe(sim.world);
    }

    // Hand math, computed here from the same geometry numbers the engine
    // consumed (entry at end of tick 1, exit at end of tick 1+A+K+B):
    const expectedDelay = (A + K + B) * DT - movement.freeFlowSeconds;
    const expectedStopped = K * DT;
    expect(done.length).toBe(1);
    const trip = done[0] as CompletedTripMetrics;
    expect(trip.entityId).toBe(entityId);
    expect(trip.entryTimeSeconds).toBeCloseTo(DT, 9);
    expect(trip.exitTimeSeconds).toBeCloseTo((1 + A + K + B) * DT, 9);
    expect(trip.freeFlowSeconds).toBe(movement.freeFlowSeconds);
    expect(trip.controlDelaySeconds).toBeCloseTo(expectedDelay, 9);
    expect(trip.stoppedSeconds).toBeCloseTo(expectedStopped, 9);

    // The single sample drives the headline mean exactly.
    const snapshot = metrics.snapshot();
    expect(snapshot.tripCount).toBe(1);
    expect(snapshot.meanControlDelaySeconds).toBeCloseTo(expectedDelay, 9);
    expect(snapshot.controlDelayP50Seconds).toBeCloseTo(expectedDelay, 9);
    expect(snapshot.meanStoppedSeconds).toBeCloseTo(expectedStopped, 9);
  });
});

// ---------------------------------------------------------------------------
// 4. Rolling window expiry (sim-time based)
// ---------------------------------------------------------------------------

describe('F7 acceptance: rolling window drops expired samples', () => {
  it('pushing sim time forward expires old samples from every aggregate', () => {
    const sim = bareSim();
    const movement = movementOf(sim, 'through');
    const metrics = new MetricsEngine(sim.geometry, sim.config, { windowSeconds: 30 });

    // Trip A: completes ~t=20 s with a large delay (150-tick = 15 s stop).
    // Its stop sits upstream of the stop line ⇒ a 1-car queue episode.
    const tripA = driveScriptedTrip(sim, metrics, movement, 150);
    expect(tripA.controlDelaySeconds).toBeGreaterThan(14);
    expect(metrics.snapshot().tripCount).toBe(1);
    expect(metrics.snapshot().maxQueueCars).toBe(1);

    // Advance empty time past the window (30 s) after A's exit: A's sample
    // AND its queue episode expire together (sim-time window).
    for (let t = 0; t < Math.ceil(45 / DT); t += 1) synthTick(sim, []);
    metrics.observe(sim.world);
    expect(metrics.snapshot().tripCount).toBe(0);
    expect(metrics.snapshot().meanControlDelaySeconds).toBeNull();
    expect(metrics.snapshot().throughputVehPerHour).toBeNull();
    expect(metrics.snapshot().maxQueueCars).toBe(0);

    // Trip B: completes later with a small delay; A stays expired.
    const tB0 = sim.world.tick;
    const tripB = driveScriptedTrip(sim, metrics, movement, 20);
    expect(tripB.exitTimeSeconds).toBeGreaterThan(tB0 * DT);
    const snapshot = metrics.snapshot();
    expect(snapshot.tripCount).toBe(1);
    expect(snapshot.meanControlDelaySeconds).toBeCloseTo(tripB.controlDelaySeconds, 9);
    // A's 15 s hold would dominate any pooled mean — prove it is gone.
    expect(snapshot.meanControlDelaySeconds as number).toBeLessThan(5);
    // B's own 2 s stop re-populates the windowed queue max (A's expired).
    expect(snapshot.maxQueueCars).toBe(1);
    // Run-summary stays cumulative (reset is the only clearer).
    expect(metrics.runSummary().tripCount).toBe(2);
  });

  it('setWindowSeconds narrows immediately and never resurrects', () => {
    const sim = bareSim();
    const movement = movementOf(sim, 'through');
    const metrics = new MetricsEngine(sim.geometry, sim.config, { windowSeconds: 180 });
    driveScriptedTrip(sim, metrics, movement, 2);
    for (let t = 0; t < Math.ceil(10 / DT); t += 1) synthTick(sim, []);
    metrics.observe(sim.world);
    expect(metrics.snapshot().tripCount).toBe(1);
    metrics.setWindowSeconds(5); // sample is now older than 5 s
    expect(metrics.snapshot().tripCount).toBe(0);
    metrics.setWindowSeconds(180); // widening cannot resurrect
    expect(metrics.snapshot().tripCount).toBe(0);
    expect(() => metrics.setWindowSeconds(0)).toThrow();
  });
});

/** Helper: drive one scripted cruise/stop/cruise car to completion. */
function driveScriptedTrip(
  sim: ReturnType<typeof bareSim>,
  metrics: MetricsEngine,
  movement: MovementGeometry,
  stopTicks: number,
): CompletedTripMetrics {
  const step = VC * DT;
  const stopS = movement.entryGateS + 25;
  const A = Math.ceil((stopS - movement.entryGateS) / step);
  const B = Math.ceil((movement.exitGateS - stopS) / step);
  const entityId = spawnCar(sim, movement, movement.entryGateS - step);
  const index = sim.world.store.indexOfEntity(entityId);
  for (let tick = 1; tick <= 1 + A + stopTicks + B; tick += 1) {
    const s =
      tick <= 1 + A
        ? movement.entryGateS + (tick - 1) * step
        : tick <= 1 + A + stopTicks
          ? stopS
          : stopS + (tick - 1 - A - stopTicks) * step;
    const speed = tick > 1 + A && tick <= 1 + A + stopTicks ? 0 : VC;
    synthTick(sim, [{ index, s, speed }]);
    const done = metrics.observe(sim.world);
    if (done.length > 0) {
      // Despawn like the world does (removeAt), then hand the departure
      // record over — the production seam, so the next trip starts clean.
      sim.world.store.removeAt(sim.world.store.indexOfEntity(entityId));
      metrics.observe(sim.world, [{ entityId, timeSeconds: sim.world.time }]);
      return done[0] as CompletedTripMetrics;
    }
  }
  throw new Error('scripted trip never completed');
}

// ---------------------------------------------------------------------------
// 5. Config-change reset
// ---------------------------------------------------------------------------

describe('F7 acceptance: config-change reset clears aggregates', () => {
  it('reset() clears window samples, maxima, cumulative summary; new samples accumulate', () => {
    const sim = fullSim(createDefaultConfig(), 7);
    let trips = 0;
    for (let t = 0; t < 3000; t += 1) trips += stepSim(sim).length;
    expect(trips).toBeGreaterThan(0);
    const before = sim.metrics.snapshot();
    expect(before.tripCount).toBeGreaterThan(0);
    expect(sim.metrics.runSummary().maxQueueCars).toBeGreaterThan(0);

    sim.metrics.reset(); // the stats-reset signal a config change fires

    const cleared = sim.metrics.snapshot();
    expect(cleared.tripCount).toBe(0);
    expect(cleared.meanControlDelaySeconds).toBeNull();
    expect(cleared.controlDelayP50Seconds).toBeNull();
    expect(cleared.controlDelayP85Seconds).toBeNull();
    expect(cleared.controlDelayP95Seconds).toBeNull();
    expect(cleared.meanStoppedSeconds).toBeNull();
    expect(cleared.throughputVehPerHour).toBeNull();
    expect(cleared.maxQueueCars).toBe(0);
    expect(cleared.currentQueuePerChain.every((q) => q === 0)).toBe(true);
    const summary = sim.metrics.runSummary();
    expect(summary.tripCount).toBe(0);
    expect(summary.meanControlDelaySeconds).toBeNull();
    expect(summary.maxQueueCars).toBe(0);
    expect(summary.maxQueuePerChain.every((q) => q === 0)).toBe(true);

    // Post-reset sim traffic re-accumulates from a re-anchored window. Cars
    // in flight across the reset complete re-baselined (excluded from the
    // aggregates); everything after crosses both gates honestly.
    let honest = 0;
    let rebaselined = 0;
    for (let t = 0; t < 3000; t += 1) {
      for (const trip of stepSim(sim)) {
        if (trip.rebaselined) rebaselined += 1;
        else honest += 1;
      }
    }
    expect(honest).toBeGreaterThan(0);
    expect(sim.metrics.snapshot().tripCount).toBeGreaterThan(0);
    expect(sim.metrics.runSummary().tripCount).toBe(honest);
    expect(rebaselined).toBeGreaterThan(0); // the reset really cut mid-flight trips
    expect(sim.metrics.droppedDepartureCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Determinism
// ---------------------------------------------------------------------------

describe('F7 acceptance: identical runs produce identical aggregates', () => {
  it(
    'same seed + config ⇒ identical snapshot and run summary (value equality)',
    // 2 × 6000-tick full-pipeline runs — explicit timeout per the suite
    // hardening pass (T-F5b follow-up: multi-thousand-tick soaks flake at the
    // 5 s default under heavy parallel load; same remedy as world.test.ts).
    { timeout: 60_000 },
    () => {
    const run = (): { snap: string; summary: string; trips: string } => {
      const sim = fullSim(createDefaultConfig(), 42);
      const trips: CompletedTripMetrics[] = [];
      for (let t = 0; t < 6000; t += 1) trips.push(...stepSim(sim));
      return {
        snap: JSON.stringify(sim.metrics.snapshot()),
        summary: JSON.stringify(sim.metrics.runSummary()),
        trips: JSON.stringify(trips),
      };
    };
    expect(run()).toEqual(run());
  });
});

// ---------------------------------------------------------------------------
// 7. Queue + throughput bookkeeping
// ---------------------------------------------------------------------------

describe('F7: queue and throughput measurement', () => {
  it('queue counts stopped cars upstream of the stop line, per arm and lane', () => {
    const sim = bareSim();
    const movement = movementOf(sim, 'through');
    const metrics = sim.metrics;
    const ids = [
      spawnCar(sim, movement, 100, 13.9), // moving: not queued
      spawnCar(sim, movement, 60, 0), // stopped on approach: queued
      spawnCar(sim, movement, 54, 0), // stopped: queued
      spawnCar(sim, movement, 48, METRICS_STOPPED_SPEED_MPS), // at threshold: NOT queued (strict <)
    ];
    synthTick(sim, ids.map((_, k) => ({ index: k, s: [100, 60, 54, 48][k] as number, speed: [13.9, 0, 0, METRICS_STOPPED_SPEED_MPS][k] as number })));
    metrics.observe(sim.world);

    const snapshot = metrics.snapshot();
    expect(snapshot.currentQueuePerChain[0]).toBe(2); // north lane 0
    expect(snapshot.arms.north.maxQueuePerLane[0]).toBe(2);
    expect(snapshot.arms.north.maxQueueCars).toBe(2);
    expect(snapshot.arms.north.tripCount).toBe(0);
    expect(snapshot.maxQueueCars).toBe(2);
    expect(snapshot.arms.south.maxQueueCars).toBe(0);
    expect(metrics.runSummary().maxQueueCars).toBe(2);

    // Stopped cars past the stop line (inside the box) are not approach queue.
    const store = sim.world.store;
    for (const id of [ids[1], ids[2]]) {
      const boxIndex = store.indexOfEntity(id as number);
      synthTick(sim, [{ index: boxIndex, s: movement.stopLineS + 5, speed: 0 }]);
    }
    metrics.observe(sim.world);
    expect(metrics.snapshot().currentQueuePerChain[0]).toBe(0); // mover + at-threshold only
  });

  it('throughput veh/h matches hand math; per-arm split is exact', () => {
    const sim = bareSim();
    const movement = movementOf(sim, 'through');
    const metrics = new MetricsEngine(sim.geometry, sim.config, { windowSeconds: 180 });
    // 10 sequential trips, each ~4.9 s of scripted driving: 60 s total.
    for (let k = 0; k < 10; k += 1) driveScriptedTrip(sim, metrics, movement, 0);
    const elapsed = sim.world.time;
    expect(elapsed).toBeGreaterThan(0);
    const snapshot = metrics.snapshot();
    expect(snapshot.tripCount).toBe(10);
    // Throughput denominator = min(window, time since the FIRST observe) —
    // the engine anchors at the first observation tick (t = DT), not at 0.
    const span = elapsed - DT;
    expect(snapshot.throughputVehPerHour).toBeCloseTo((10 * 3600) / span, 6);
    expect(snapshot.arms.north.throughputVehPerHour).toBeCloseTo((10 * 3600) / span, 6);
    expect(snapshot.arms.north.tripCount).toBe(10);
    expect(snapshot.arms.east.throughputVehPerHour).toBeNull();
    expect(metrics.runSummary().throughputVehPerHour).toBeCloseTo((10 * 3600) / span, 6);
  });
});

// ---------------------------------------------------------------------------
// stats helpers
// ---------------------------------------------------------------------------

describe('stats helpers', () => {
  it('meanOf', () => {
    expect(meanOf([])).toBeNull();
    expect(meanOf([1, 2, 3])).toBe(2);
    expect(meanOf([2])).toBe(2);
  });

  it('sortedAscending never mutates input', () => {
    const input = [3, 1, 2];
    const sorted = sortedAscending(input);
    expect(sorted).toEqual([1, 2, 3]);
    expect(input).toEqual([3, 1, 2]);
  });

  it('percentileOfSorted interpolates and clamps', () => {
    expect(percentileOfSorted([], 0.5)).toBeNull();
    expect(percentileOfSorted([5], 0.5)).toBe(5);
    const sorted = [1, 2, 3, 4, 5];
    expect(percentileOfSorted(sorted, 0)).toBe(1);
    expect(percentileOfSorted(sorted, 1)).toBe(5);
    expect(percentileOfSorted(sorted, 0.5)).toBe(3);
    expect(percentileOfSorted(sorted, 0.85)).toBeCloseTo(4.4, 9);
    expect(percentileOfSorted(sorted, -0.5)).toBe(1); // clamped
    expect(percentileOfSorted(sorted, 1.5)).toBe(5); // clamped
    expect(percentileOfSorted([1, 2], 0.5)).toBeCloseTo(1.5, 9);
  });
});
