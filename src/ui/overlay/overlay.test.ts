/**
 * Engineering overlay tests (task U3 acceptance):
 * 1. overlay values equal metrics fixture values EXACTLY — the model copies
 *    snapshot fields verbatim (toBe-level identity through the builder), and
 *    display strings come from the pinned formatters;
 * 2. an F7-fixture-style scripted scenario (the metrics.test.ts hand-computable
 *    cruise/stop/cruise trip) feeds a REAL engine snapshot through the overlay
 *    — the overlay's numbers are the engine's numbers, which match the hand
 *    math computed here from the same geometry;
 * 3. the ModelParams read-out reproduces the config block verbatim;
 * 4. bar fractions scale per-arm delay against the busiest arm, with the
 *    null / all-negative edge cases pinned.
 */
import { describe, expect, it } from 'vitest';
import type { ArmId, IntersectionConfig } from '../../config';
import { createDefaultConfig } from '../../config/defaults';
import { buildIntersectionGeometry, getMovement } from '../../geom';
import { MetricsEngine } from '../../sim/metrics/engine';
import type { ArmMetrics, MetricsSnapshot } from '../../sim/metrics/types';
import { createCarWorld } from '../../sim/world';
import { formatDelaySeconds, formatQueuePerLane, formatThroughput, buildOverlayModel, modelParamRows } from './overlay';

// ---------------------------------------------------------------------------
// Literal fixtures
// ---------------------------------------------------------------------------

function arm(armId: ArmId, overrides: Partial<ArmMetrics> = {}): ArmMetrics {
  return {
    arm: armId,
    tripCount: 0,
    meanControlDelaySeconds: null,
    meanStoppedSeconds: null,
    throughputVehPerHour: null,
    maxQueueCars: 0,
    maxQueuePerLane: [],
    ...overrides,
  };
}

function snapshotFixture(): MetricsSnapshot {
  return {
    timeSeconds: 195.3,
    windowSeconds: 180,
    elapsedSinceResetSeconds: 195.3,
    tripCount: 84,
    meanControlDelaySeconds: 12.25,
    controlDelayP50Seconds: 8.5,
    controlDelayP85Seconds: 24.75,
    controlDelayP95Seconds: 31.25,
    meanStoppedSeconds: 6.125,
    throughputVehPerHour: 612.4,
    maxQueueCars: 11,
    currentQueuePerChain: [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    arms: {
      north: arm('north', {
        tripCount: 30,
        meanControlDelaySeconds: 10,
        meanStoppedSeconds: 5,
        throughputVehPerHour: 200,
        maxQueueCars: 4,
        maxQueuePerLane: [4, 2],
      }),
      east: arm('east', {
        tripCount: 24,
        meanControlDelaySeconds: 5,
        meanStoppedSeconds: 2.5,
        throughputVehPerHour: 160,
        maxQueueCars: 3,
        maxQueuePerLane: [3],
      }),
      south: arm('south'), // no trips: all null
      west: arm('west', {
        tripCount: 30,
        meanControlDelaySeconds: 2,
        meanStoppedSeconds: 1,
        throughputVehPerHour: 252.4,
        maxQueueCars: 4,
        maxQueuePerLane: [4, 4, 1],
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Verbatim snapshot equality + formatters
// ---------------------------------------------------------------------------

describe('overlay model equals metrics fixtures exactly', () => {
  const config = createDefaultConfig();
  const snapshot = snapshotFixture();
  const model = buildOverlayModel(snapshot, config);

  it('numeric fields are copied verbatim, never recomputed', () => {
    for (const armId of ['north', 'east', 'south', 'west'] as const) {
      const row = model.arms.find((candidate) => candidate.arm === armId);
      const source = snapshot.arms[armId];
      if (row === undefined) throw new Error(`missing ${armId} row`);
      expect(row.meanControlDelaySeconds).toBe(source.meanControlDelaySeconds);
      expect(row.meanStoppedSeconds).toBe(source.meanStoppedSeconds);
      expect(row.throughputVehPerHour).toBe(source.throughputVehPerHour);
      expect(row.maxQueueCars).toBe(source.maxQueueCars);
      expect(row.maxQueuePerLane).toBe(source.maxQueuePerLane);
    }
    expect(model.barMaxSeconds).toBe(10);
  });

  it('display strings come from the pinned formatters', () => {
    const north = model.arms[0];
    if (north === undefined) throw new Error('missing north row');
    expect(north.delayText).toBe('10.00 s');
    expect(north.stoppedText).toBe('5.00 s');
    expect(north.throughputText).toBe('200 veh/h');
    expect(north.queueText).toBe('4');
    expect(north.queuePerLaneText).toBe('4 / 2');
    const south = model.arms[2];
    if (south === undefined) throw new Error('missing south row');
    expect(south.delayText).toBe('—');
    expect(south.stoppedText).toBe('—');
    expect(south.throughputText).toBe('—');
    expect(south.queueText).toBe('0');
  });

  it('summary rows render the snapshot headline values', () => {
    const byLabel = new Map(model.summary.map((row) => [row.label, row.value]));
    expect(byLabel.get('Mean control delay')).toBe('12.25 s');
    expect(byLabel.get('p50')).toBe('8.50 s');
    expect(byLabel.get('p85')).toBe('24.75 s');
    expect(byLabel.get('p95')).toBe('31.25 s');
    expect(byLabel.get('Mean stopped time')).toBe('6.13 s');
    expect(byLabel.get('Throughput (all arms)')).toBe('612 veh/h');
    expect(byLabel.get('Max queue (all arms)')).toBe('11');
    expect(byLabel.get('Trips in window')).toBe('84');
    expect(byLabel.get('Window')).toBe('3:00');
    expect(byLabel.get('Since reset')).toBe('3:15');
  });

  it('formatters pin the edge behavior', () => {
    expect(formatDelaySeconds(null)).toBe('—');
    expect(formatDelaySeconds(0)).toBe('0.00 s');
    expect(formatDelaySeconds(12.25)).toBe('12.25 s');
    expect(formatThroughput(null)).toBe('—');
    expect(formatThroughput(612.4)).toBe('612 veh/h');
    expect(formatQueuePerLane([])).toBe('');
    expect(formatQueuePerLane([7, 5, 0])).toBe('7 / 5 / 0');
  });
});

// ---------------------------------------------------------------------------
// 2. Bar fractions
// ---------------------------------------------------------------------------

/** Test-side override of a (deep-readonly) snapshot arm field. */
function setArmDelay(snapshot: MetricsSnapshot, armId: ArmId, value: number | null): void {
  (snapshot.arms[armId] as { meanControlDelaySeconds: number | null }).meanControlDelaySeconds = value;
}

describe('per-arm bar fractions', () => {
  const config = createDefaultConfig();

  it('scales against the busiest arm', () => {
    const model = buildOverlayModel(snapshotFixture(), config);
    const fractions = model.arms.map((row) => row.barFraction);
    expect(fractions).toEqual([1, 0.5, 0, 0.2]);
  });

  it('all-null arms size no bars', () => {
    const snapshot = snapshotFixture();
    for (const armId of ['north', 'east', 'south', 'west'] as const) setArmDelay(snapshot, armId, null);
    const model = buildOverlayModel(snapshot, config);
    expect(model.barMaxSeconds).toBe(0);
    expect(model.arms.every((row) => row.barFraction === 0)).toBe(true);
  });

  it('negative window means (quantization dips) clamp to zero-width bars', () => {
    const snapshot = snapshotFixture();
    for (const armId of ['north', 'east', 'south', 'west'] as const) setArmDelay(snapshot, armId, -0.04);
    const model = buildOverlayModel(snapshot, config);
    expect(model.barMaxSeconds).toBe(0);
    expect(model.arms.every((row) => row.barFraction === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Model-parameter read-out
// ---------------------------------------------------------------------------

describe('model parameter read-out', () => {
  it('reproduces the R1 §3.1 defaults from the config block', () => {
    const rows = modelParamRows(createDefaultConfig().modelParams);
    const byLabel = new Map(rows.map((row) => [row.label, row.value]));
    expect(byLabel.get('Cruise speed v_c')).toBe('13.9 m/s');
    expect(byLabel.get('Time headway T')).toBe('1.1 s');
    expect(byLabel.get('Max accel a')).toBe('1.3 m/s²');
    expect(byLabel.get('Comfortable decel b')).toBe('2 m/s²');
    expect(byLabel.get('Emergency decel b_e')).toBe('6 m/s²');
    expect(byLabel.get('Min gap s0')).toBe('2 m');
    expect(byLabel.get('Hard min gap s_min')).toBe('0.5 m');
    expect(byLabel.get('Accel exponent δ')).toBe('4');
    expect(byLabel.get('Car length')).toBe('5 m');
    expect(byLabel.get('Lateral accel a_lat')).toBe('1.7 m/s²');
    expect(byLabel.get('Yellow reaction t_r')).toBe('1 s');
    expect(byLabel.get('Yellow decel a_y')).toBe('3 m/s²');
  });

  it('the overlay adds dt + lane width from the config', () => {
    const model = buildOverlayModel(snapshotFixture(), createDefaultConfig());
    const byLabel = new Map(model.params.map((row) => [row.label, row.value]));
    expect(byLabel.get('Simulation dt')).toBe('0.1 s');
    expect(byLabel.get('Lane width')).toBe('3.5 m');
  });
});

// ---------------------------------------------------------------------------
// 4. F7-fixture integration: a real engine snapshot through the overlay
// ---------------------------------------------------------------------------

describe('overlay values track a real F7 metrics fixture', () => {
  interface SynthMove {
    readonly index: number;
    readonly s: number;
    readonly speed: number;
  }

  /**
   * The F7 hand-computable scripted scenario (metrics.test.ts): one north
   * through car, cruise A ticks / stop K ticks / cruise B ticks, all at
   * absolute positions — the same feed the engine's acceptance tests use.
   */
  function scriptedTripSnapshot(stopTicks: number): MetricsSnapshot {
    const config: IntersectionConfig = createDefaultConfig();
    const geometry = buildIntersectionGeometry(config);
    const world = createCarWorld(geometry, config, { capacity: 64 });
    const metrics = new MetricsEngine(geometry, config);
    const movement = getMovement(geometry, 'north', 0, 'through');
    if (movement === undefined) throw new Error('missing north:0:through movement');
    const dt = config.dt;
    const step = config.modelParams.cruiseSpeedMps * dt;
    const stopS = movement.entryGateS + 25;
    const A = Math.ceil((stopS - movement.entryGateS) / step);
    const B = Math.ceil((movement.exitGateS - stopS) / step);
    const entityId = world.store.addCar(
      {
        pathIndex: geometry.movements.indexOf(movement),
        s: movement.entryGateS - step,
        speed: config.modelParams.cruiseSpeedMps,
        carLengthMeters: config.modelParams.carLengthMeters,
      },
      world.tick,
      geometry.movements,
    );
    const index = world.store.indexOfEntity(entityId);
    const synthTick = (moves: readonly SynthMove[]): void => {
      for (const move of moves) world.store.prevS[move.index] = world.store.s[move.index] ?? 0;
      for (const move of moves) {
        world.store.s[move.index] = move.s;
        world.store.speed[move.index] = move.speed;
      }
      world.tick += 1;
      world.time = world.tick * world.dt;
    };

    for (let tick = 1; tick <= 1 + A + stopTicks + B; tick += 1) {
      const s =
        tick <= 1 + A
          ? movement.entryGateS + (tick - 1) * step
          : tick <= 1 + A + stopTicks
            ? stopS
            : stopS + (tick - 1 - A - stopTicks) * step;
      const speed = tick > 1 + A && tick <= 1 + A + stopTicks ? 0 : config.modelParams.cruiseSpeedMps;
      synthTick([{ index, s, speed }]);
      metrics.observe(world);
    }
    return metrics.snapshot();
  }

  it('the overlay carries the engine fixture numbers, which match the hand math', () => {
    const config = createDefaultConfig();
    const K = 20;
    const snapshot = scriptedTripSnapshot(K);
    const model = buildOverlayModel(snapshot, config);

    // Hand math from the same geometry inputs (F7 acceptance §3):
    const geometry = buildIntersectionGeometry(config);
    const movement = getMovement(geometry, 'north', 0, 'through');
    if (movement === undefined) throw new Error('missing movement');
    const dt = config.dt;
    const step = config.modelParams.cruiseSpeedMps * dt;
    const stopS = movement.entryGateS + 25;
    const A = Math.ceil((stopS - movement.entryGateS) / step);
    const B = Math.ceil((movement.exitGateS - stopS) / step);
    const expectedDelay = (A + K + B) * dt - movement.freeFlowSeconds;

    expect(snapshot.tripCount).toBe(1);
    expect(snapshot.meanControlDelaySeconds).toBeCloseTo(expectedDelay, 9);
    const north = model.arms[0];
    if (north === undefined) throw new Error('missing north row');
    expect(north.meanControlDelaySeconds).toBe(snapshot.meanControlDelaySeconds);
    expect(north.meanStoppedSeconds).toBe(snapshot.arms.north.meanStoppedSeconds);
    expect(north.throughputVehPerHour).toBe(snapshot.arms.north.throughputVehPerHour);
    // The bar row displays the same number the engine reported.
    expect(north.delayText).toBe(formatDelaySeconds(snapshot.meanControlDelaySeconds));
    // Single busiest arm ⇒ full-width bar.
    expect(north.barFraction).toBe(1);
  });
});
