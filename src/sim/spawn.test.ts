/**
 * Spawner acceptance tests (task F6; R2 Part B pairing contract + plan
 * acceptance line):
 *
 * 1. same seed ⇒ identical spawn sequence (times/positions/routes) over
 *    ≥ 10k ticks of the FULL sim (control + world + spawner);
 * 2. paired-seed state independence: identical seed, different signal plans
 *    ⇒ IDENTICAL spawn schedules (fired events + spawnDigest), while the
 *    worlds themselves diverge;
 * 3. observed rate ≈ configured rate over 10 sim-minutes (tolerance: ±3σ of
 *    the exact binomial per-tick Bernoulli count — the record's accepted
 *    binomial-vs-Poisson delta);
 * 4. turn-mix distribution matches configured probabilities within ±3σ;
 * 5. the spawn-room rule keeps the terminal clamp dormant: no car is ever
 *    created within len + s_min of a same-lane car (in fact never within
 *    s_min + v_c·T ≈ 15.8 m), and min same-chain gap ≥ s_min every tick.
 *
 * Plus: virtual entry queues consume no extra randomness (blocked vs free
 * world, same seed ⇒ same fired stream/digest), FIFO admission, the F7 trip
 * seam, and round-robin lane assignment's state independence.
 */
import { describe, expect, it } from 'vitest';
import type { IntersectionConfig } from '../config';
import { ARM_IDS, TURN_DIRECTIONS, validateConfig } from '../config';
import { createDefaultConfig, DEFAULT_MODEL_PARAMS } from '../config/defaults';
import { getPreset } from '../presets';
import { buildIntersectionGeometry, itemAt } from '../geom';
import type { IntersectionGeometry } from '../geom';
import { hashCarStore } from './hash';
import { f64At, i32At } from './store';
import { createCarWorld } from './world';
import type { CarWorld } from './world';
import { createControlSystem } from './control';
import type { ControlSystem } from './control';
import { Spawner, carLengthMetersFromAttrWord } from './spawn';
import type { SpawnEvent } from './spawn';

const P = DEFAULT_MODEL_PARAMS;
const LEN = P.carLengthMeters;
const DT = createDefaultConfig().dt;

interface FullSim {
  readonly config: IntersectionConfig;
  readonly geometry: IntersectionGeometry;
  readonly world: CarWorld;
  readonly control: ControlSystem;
  readonly spawner: Spawner;
}

function fullSim(config: IntersectionConfig, masterSeed: number, repIndex = 0): FullSim {
  const geometry = buildIntersectionGeometry(config);
  return {
    config,
    geometry,
    world: createCarWorld(geometry, config, { capacity: 600 }),
    control: createControlSystem(geometry, config, { capacity: 600 }),
    spawner: new Spawner(geometry, config, { masterSeed, repIndex }),
  };
}

/** One tick of the production pipeline: control → world → spawner. */
function stepSim(sim: FullSim): void {
  sim.world.step(sim.control.step(sim.world));
  sim.spawner.step(sim.world);
}

/** Compact comparable form of a fired arrival: (tick, arm, lane, turn, attr, route). */
function eventKey(e: SpawnEvent): number[] {
  return [e.tick, e.armIndex, e.laneIndex, TURN_DIRECTIONS.indexOf(e.turn), e.attrWord, e.pathIndex];
}

function chainKeyOf(pathIndex: number, geometry: IntersectionGeometry): number {
  const movement = geometry.movements[pathIndex];
  if (movement === undefined) throw new Error(`bad pathIndex ${String(pathIndex)}`);
  return ARM_IDS.indexOf(movement.arm) * 3 + movement.laneIndex;
}

/**
 * Minimum qualifying same-chain bumper gap (mirrors the implementation's
 * leader rule — same movement, or ahead car's rear bumper still on the shared
 * approach), for the clamp-dormancy assertion.
 */
function minChainGap(world: CarWorld, geometry: IntersectionGeometry): number {
  const store = world.store;
  const chains = new Map<number, number[]>();
  for (let i = 0; i < store.count; i += 1) {
    const key = chainKeyOf(i32At(store.pathIndex, i), geometry);
    const bucket = chains.get(key);
    if (bucket === undefined) chains.set(key, [i]);
    else bucket.push(i);
  }
  let min = Number.POSITIVE_INFINITY;
  for (const bucket of chains.values()) {
    bucket.sort((a, b) => f64At(store.s, b) - f64At(store.s, a));
    const stopLineS = geometry.movements[i32At(store.pathIndex, bucket[0] as number)]?.stopLineS ?? 0;
    for (let k = 1; k < bucket.length; k += 1) {
      const ahead = bucket[k - 1] as number;
      const behind = bucket[k] as number;
      const samePath = i32At(store.pathIndex, ahead) === i32At(store.pathIndex, behind);
      const rearOnApproach = f64At(store.s, ahead) - f64At(store.carLengthMeters, ahead) <= stopLineS;
      if (samePath || rearOnApproach) {
        const gap = f64At(store.s, ahead) - f64At(store.carLengthMeters, ahead) - f64At(store.s, behind);
        if (gap < min) min = gap;
      }
    }
  }
  return min;
}

/**
 * The R1 §3.2 spawn-room requirement for one arm: bumper gap the rearmost
 * same-lane car must leave for a new car entering at s = 0.
 */
function roomNeedMeters(config: IntersectionConfig, armIndex: number): number {
  const arm = config.arms[itemAt(ARM_IDS, armIndex)];
  return P.hardMinGapMeters + arm.cruiseSpeedMps * P.timeHeadwaySeconds;
}

// ---------------------------------------------------------------------------
// Acceptance 1: same seed ⇒ identical spawn sequence over ≥ 10k ticks
// ---------------------------------------------------------------------------

describe('determinism: identical spawn sequence (times/positions/routes)', () => {
  const TICKS = 10_000;

  it(
    'two full-sim runs with the same seed produce identical spawn schedules and world states',
    { timeout: 240_000 },
    () => {
    const config = createDefaultConfig();
    expect(validateConfig(config)).toHaveLength(0);
    const a = fullSim(config, 90210);
    const b = fullSim(config, 90210);

    const eventsA: number[][] = [];
    const eventsB: number[][] = [];
    const hashesA: string[] = [];
    const hashesB: string[] = [];

    for (let t = 0; t < TICKS; t += 1) {
      stepSim(a);
      stepSim(b);
      for (const e of a.spawner.fired) eventsA.push(eventKey(e));
      for (const e of b.spawner.fired) eventsB.push(eventKey(e));
      if ((t + 1) % 1000 === 0) {
        hashesA.push(hashCarStore(a.world.store, a.world.tick));
        hashesB.push(hashCarStore(b.world.store, b.world.tick));
      }
    }

    // Identical demand realization: times (tick), routes (arm/lane/turn/path),
    // attributes — spawn position is the movement's entryPoint at s = 0,
    // fully determined by pathIndex.
    expect(eventsA.length).toBeGreaterThan(250); // real demand (~333 at 300/h × 4 arms)
    expect(eventsA).toEqual(eventsB);
    // Identical admitted world trajectories too.
    expect(hashesA).toEqual(hashesB);
    expect(a.spawner.spawnDigestHex()).toBe(b.spawner.spawnDigestHex());
    expect(a.spawner.stats).toEqual(b.spawner.stats);
    // Every event is well-formed: valid route, spawned at the path start.
    for (const key of eventsA) {
      const pathIndex = key[5] as number;
      const movement = a.geometry.movements[pathIndex];
      expect(movement).toBeDefined();
      expect((key[0] as number)).toBeGreaterThanOrEqual(1); // tagged on a completed-tick boundary
    }
    },
  );

  it('a different seed diverges (the comparison has teeth)', () => {
    const config = createDefaultConfig();
    const a = fullSim(config, 1);
    const c = fullSim(config, 2);
    for (let t = 0; t < 2000; t += 1) {
      stepSim(a);
      stepSim(c);
    }
    expect(a.spawner.spawnDigestHex()).not.toBe(c.spawner.spawnDigestHex());
  });
});

// ---------------------------------------------------------------------------
// Acceptance 2: paired-seed state independence (the R2 Part B contract)
// ---------------------------------------------------------------------------

describe('paired-seed property: spawn schedule is independent of the signal plan', () => {
  const TICKS = 10_000;

  it(
    'identical seed, different green splits ⇒ IDENTICAL fired streams + spawnDigest, different worlds',
    { timeout: 240_000 },
    () => {
    const base = createDefaultConfig(); // 2-phase permissive, greens 26/26, C = 60
    expect(validateConfig(base)).toHaveLength(0);
    if (base.control.type !== 'signal') throw new Error('default config must be signal-controlled');
    const planB = {
      ...base.control.plan,
      phases: [
        { kind: 'ns-through-right' as const, greenSeconds: 20 },
        { kind: 'ew-through-right' as const, greenSeconds: 32 },
      ],
    };
    const configB: IntersectionConfig = { ...base, control: { type: 'signal', plan: planB } };
    expect(validateConfig(configB)).toHaveLength(0); // 20 + 32 = 26 + 26: cycle still coherent

    const a = fullSim(base, 424242);
    const b = fullSim(configB, 424242);

    const eventsA: number[][] = [];
    const eventsB: number[][] = [];
    const digestsA: string[] = [];
    const digestsB: string[] = [];

    for (let t = 0; t < TICKS; t += 1) {
      stepSim(a);
      stepSim(b);
      for (const e of a.spawner.fired) eventsA.push(eventKey(e));
      for (const e of b.spawner.fired) eventsB.push(eventKey(e));
      if ((t + 1) % 2500 === 0) {
        digestsA.push(a.spawner.spawnDigestHex());
        digestsB.push(b.spawner.spawnDigestHex());
      }
    }
    const hashFinalA = hashCarStore(a.world.store, a.world.tick);
    const hashFinalB = hashCarStore(b.world.store, b.world.tick);

    // THE pairing assertion (O1 consumes this): identical demand realization.
    expect(eventsA).toEqual(eventsB);
    expect(digestsA).toEqual(digestsB);
    expect(a.spawner.spawnDigestHex()).toBe(b.spawner.spawnDigestHex());
    expect(a.spawner.stats.arrivalsFired).toBe(b.spawner.stats.arrivalsFired);
    // But the treatment genuinely changed the world (plans differ ⇒ dynamics differ).
    expect(hashFinalA).not.toBe(hashFinalB);
    // ...and the admitted sets differ — that difference IS the treatment effect.
    expect(a.spawner.stats.carsAdmitted).not.toBe(b.spawner.stats.carsAdmitted);
    },
  );

  it('virtual entry queues consume no different randomness: blocked vs free world, same seed', () => {
    const config = createDefaultConfig();
    const blocked = fullSim(config, 777);
    const free = fullSim(config, 777);

    // Pin a stopped blocker 3 m into the north through lane of the "blocked"
    // world; the north chain can never offer room, so every north arrival
    // queues virtually. The "free" world runs untouched.
    const northThrough = blocked.geometry.movements.findIndex((m) => m.id === 'north:0:through');
    expect(northThrough).toBeGreaterThanOrEqual(0);
    const blockerId = blocked.world.store.addCar(
      { pathIndex: northThrough, s: 3, speed: 0, carLengthMeters: LEN },
      0,
      blocked.geometry.movements,
    );

    let firedBlocked = 0;
    let firedFree = 0;
    const TICKS = 600;
    for (let t = 0; t < TICKS; t += 1) {
      stepSim(blocked);
      stepSim(free);
      // Re-pin the blocker after each world step (test-side manipulation).
      const i = blocked.world.store.indexOfEntity(blockerId);
      if (i >= 0) {
        blocked.world.store.s[i] = 3;
        blocked.world.store.speed[i] = 0;
      }
      firedBlocked += blocked.spawner.fired.length;
      firedFree += free.spawner.fired.length;
    }

    // Same fired stream and digest despite radically different queue state.
    expect(firedBlocked).toBe(firedFree);
    expect(firedBlocked).toBeGreaterThan(15);
    expect(blocked.spawner.spawnDigestHex()).toBe(free.spawner.spawnDigestHex());
    // Spillback genuinely engaged: the north lane's virtual queue grew.
    expect(blocked.spawner.stats.maxVirtualQueueDepth).toBeGreaterThan(0);
    // And admission differed (north arrivals held back in the blocked world).
    expect(blocked.spawner.stats.carsAdmitted).toBeLessThan(free.spawner.stats.carsAdmitted);
  });

  it('virtual queue admits FIFO once room opens', () => {
    const config = createDefaultConfig();
    const sim = fullSim(config, 31337);
    const northThrough = sim.geometry.movements.findIndex((m) => m.id === 'north:0:through');
    const blockerId = sim.world.store.addCar(
      { pathIndex: northThrough, s: 2, speed: 0, carLengthMeters: LEN },
      0,
      sim.geometry.movements,
    );
    const firedNorthTicks: number[] = [];
    const pin = (): void => {
      const i = sim.world.store.indexOfEntity(blockerId);
      if (i >= 0) {
        sim.world.store.s[i] = 2;
        sim.world.store.speed[i] = 0;
      }
    };
    for (let t = 0; t < 400; t += 1) {
      stepSim(sim);
      pin();
      for (const e of sim.spawner.fired) if (e.armIndex === 0) firedNorthTicks.push(e.tick);
    }
    const backlog = firedNorthTicks.length;
    expect(backlog).toBeGreaterThan(3);
    expect(sim.spawner.virtualQueueDepth(0, 0)).toBe(backlog); // all still waiting

    // Release the blocker: queued north arrivals admit strictly in fire order
    // (new arrivals during release join the back of the FIFO).
    const admittedOrder: number[] = [];
    for (let t = 0; t < 200; t += 1) {
      stepSim(sim);
      for (const e of sim.spawner.fired) if (e.armIndex === 0) firedNorthTicks.push(e.tick);
      for (const car of sim.spawner.admitted) if (car.event.armIndex === 0) admittedOrder.push(car.event.tick);
    }
    expect(admittedOrder.length).toBeGreaterThan(0);
    const expectedPrefix = firedNorthTicks.slice(0, admittedOrder.length);
    expect(admittedOrder).toEqual(expectedPrefix); // FIFO by fire (= wait) order
  });
});

// ---------------------------------------------------------------------------
// Acceptance 3 + 4: rate and turn mix over 10 sim-minutes
// ---------------------------------------------------------------------------

/** 10 sim-minutes at dt = 0.1 s. */
const RATE_TICKS = 6000;

describe('observed rate ≈ configured rate over 10 sim-minutes', () => {
  const SEEDS = [1, 42, 1337];

  it(
    'per-arm fired counts fall within ±3σ of the binomial mean (tolerance stated)',
    { timeout: 120_000 },
    () => {
    const config = getPreset('balanced').config; // 550 veh/h per arm
    for (const seed of SEEDS) {
      const sim = fullSim(config, seed);
      const firedPerArm = [0, 0, 0, 0];
      for (let t = 0; t < RATE_TICKS; t += 1) {
        stepSim(sim);
        for (const e of sim.spawner.fired) firedPerArm[e.armIndex] = (firedPerArm[e.armIndex] ?? 0) + 1;
      }
      const rate = config.arms.north.spawnRateVehPerHour;
      const p = (rate / 3600) * DT;
      const mu = RATE_TICKS * p;
      const sigma = Math.sqrt(RATE_TICKS * p * (1 - p));
      const deviations: string[] = [];
      for (let arm = 0; arm < 4; arm += 1) {
        const n = itemAt(firedPerArm, arm);
        const devSigma = (n - mu) / sigma;
        deviations.push(`${ARM_IDS[arm]}=${n} (dev ${devSigma >= 0 ? '+' : ''}${devSigma.toFixed(2)}σ, ${(100 * (n - mu) / mu).toFixed(1)}%)`);
        // Tolerance: ±3σ of the exact per-tick Bernoulli count — the committed
        // binomial-vs-Poisson delta (R2 Part B risk note).
        expect(Math.abs(n - mu), `seed ${String(seed)} arm ${ARM_IDS[arm]}`).toBeLessThanOrEqual(3 * sigma + 1e-9);
      }
      const total = firedPerArm.reduce((a, b) => a + b, 0);
      expect(Math.abs(total - 4 * mu)).toBeLessThanOrEqual(3 * Math.sqrt(4 * RATE_TICKS * p * (1 - p)));
      if (seed === SEEDS[0]) {
        console.info(
          `[rate] configured ${String(rate)} veh/h/arm over 10 min: mean ${mu.toFixed(1)}, σ ${sigma.toFixed(2)}; measured [${deviations.join(', ')}]`,
        );
      }
    }
    },
  );

  it('an arm with rate 0 never fires', () => {
    const base = createDefaultConfig();
    const config: IntersectionConfig = {
      ...base,
      arms: { ...base.arms, east: { ...base.arms.east, spawnRateVehPerHour: 0 } },
    };
    const sim = fullSim(config, 9);
    let firedElsewhere = 0;
    for (let t = 0; t < 2000; t += 1) {
      stepSim(sim);
      for (const e of sim.spawner.fired) {
        expect(e.armIndex).not.toBe(1);
        firedElsewhere += 1;
      }
    }
    expect(firedElsewhere).toBeGreaterThan(30); // the other arms kept firing
  });
});

describe('turn mix matches configured probabilities', () => {
  const SEEDS = [7, 88, 2024];

  it(
    'per-arm per-turn counts within ±3σ (multinomial on the fired count)',
    { timeout: 120_000 },
    () => {
    const config = getPreset('balanced').config; // mix left .2 / through .55 / right .25
    for (const seed of SEEDS) {
      const sim = fullSim(config, seed);
      const counts = [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ];
      const bump = (arm: number, turn: number): void => {
        const row = itemAt(counts, arm);
        row[turn] = (row[turn] ?? 0) + 1;
      };
      for (let t = 0; t < RATE_TICKS; t += 1) {
        stepSim(sim);
        for (const e of sim.spawner.fired) bump(e.armIndex, TURN_DIRECTIONS.indexOf(e.turn));
      }
      for (let arm = 0; arm < 4; arm += 1) {
        const armCounts = itemAt(counts, arm);
        const n = armCounts.reduce((a, b) => a + b, 0);
        expect(n).toBeGreaterThan(30);
        for (let turn = 0; turn < 3; turn += 1) {
          const p = config.arms.north.turnMix[itemAt(TURN_DIRECTIONS, turn)];
          const mu = n * p;
          const sigma = Math.sqrt(n * p * (1 - p));
          const c = itemAt(armCounts, turn);
          if (seed === SEEDS[0] && arm === 0) {
            console.info(
              `[mix] ${ARM_IDS[0]} ${TURN_DIRECTIONS[turn]}: configured ${(100 * p).toFixed(0)}%, observed ${(100 * c / n).toFixed(1)}% (n=${String(n)})`,
            );
          }
          expect(Math.abs(c - mu), `seed ${String(seed)} arm ${String(arm)} turn ${String(turn)}`).toBeLessThanOrEqual(
            3 * sigma + 1e-9,
          );
        }
      }
    }
    },
  );

  it(
    'round-robin lane assignment is state-independent and alternates deterministically',
    { timeout: 120_000 },
    () => {
    const base = createDefaultConfig();
    const config: IntersectionConfig = {
      ...base,
      arms: {
        ...base.arms,
        north: {
          ...base.arms.north,
          spawnRateVehPerHour: 900, // denser sampling for the alternation check
          lanes: [
            { designations: ['left', 'through'] },
            { designations: ['through', 'right'] },
          ],
        },
      },
    };
    expect(validateConfig(config)).toHaveLength(0);
    const sim = fullSim(config, 555);
    const throughLanes: number[] = [];
    for (let t = 0; t < 4000; t += 1) {
      stepSim(sim);
      for (const e of sim.spawner.fired) {
        if (e.armIndex === 0 && e.turn === 'through') throughLanes.push(e.laneIndex);
      }
    }
    expect(throughLanes.length).toBeGreaterThan(15);
    // Round-robin: strict alternation between the two lanes serving through,
    // regardless of which lane's queue is emptier (state independence).
    for (let i = 1; i < throughLanes.length; i += 1) {
      expect(throughLanes[i]).not.toBe(throughLanes[i - 1]);
    }
    // A re-run reproduces the identical assignment sequence.
    const sim2 = fullSim(config, 555);
    const throughLanes2: number[] = [];
    for (let t = 0; t < 4000; t += 1) {
      stepSim(sim2);
      for (const e of sim2.spawner.fired) {
        if (e.armIndex === 0 && e.turn === 'through') throughLanes2.push(e.laneIndex);
      }
    }
    expect(throughLanes2).toEqual(throughLanes);
    },
  );
});

// ---------------------------------------------------------------------------
// Acceptance 5: spawn-room rule keeps the clamp dormant
// ---------------------------------------------------------------------------

describe('spawn-room rule (R1 §3.2): clamp dormant, no tight creations', () => {
  it(
    'gridlock-risk preset, 10k ticks: no car created within len + s_min of a same-lane car; clamp 0',
    { timeout: 240_000 },
    () => {
      const config = getPreset('gridlock-risk').config; // 1100 veh/h/arm — oversaturated
      const sim = fullSim(config, 60606);
      let minCreationGap = Number.POSITIVE_INFINITY;
      let minTickGap = Number.POSITIVE_INFINITY;

      for (let t = 0; t < 10_000; t += 1) {
        stepSim(sim);
        // Creation invariant: each admitted car entered with ≥ s_min + v_c·T of
        // bumper gap to the nearest same-lane car ahead (≥ 22.3 m of s-room —
        // far beyond the acceptance's len + s_min ≈ 5.5 m).
        for (const car of sim.spawner.admitted) {
          const need = roomNeedMeters(config, car.event.armIndex);
          const chain = chainKeyOf(car.event.pathIndex, sim.geometry);
          let nearest = Number.POSITIVE_INFINITY;
          for (let i = 0; i < sim.world.store.count; i += 1) {
            if (i32At(sim.world.store.entityId, i) === car.entityId) continue;
            if (chainKeyOf(i32At(sim.world.store.pathIndex, i), sim.geometry) !== chain) continue;
            const gap = f64At(sim.world.store.s, i) - f64At(sim.world.store.carLengthMeters, i);
            if (gap < nearest) nearest = gap;
          }
          if (nearest < minCreationGap) minCreationGap = nearest;
          expect(nearest).toBeGreaterThanOrEqual(need - 1e-9);
        }
        const gap = minChainGap(sim.world, sim.geometry);
        if (gap < minTickGap) minTickGap = gap;
        expect(gap).toBeGreaterThanOrEqual(P.hardMinGapMeters - 1e-9);
      }

      expect(sim.world.clampCount).toBe(0); // the terminal clamp stayed dormant
      expect(minCreationGap).toBeGreaterThanOrEqual(P.hardMinGapMeters + 5); // ≫ len + s_min slack
      expect(sim.spawner.stats.arrivalsFired).toBeGreaterThan(1000); // real demand
      expect(sim.spawner.stats.maxVirtualQueueDepth).toBeGreaterThan(0); // spillback engaged
      console.info(
        `[room] min creation gap ${minCreationGap.toFixed(2)} m (rule needs ≥ ${(P.hardMinGapMeters + 5).toFixed(2)}), ` +
          `min live chain gap ${minTickGap.toFixed(3)} m, clamp ${String(sim.world.clampCount)}, ` +
          `max virtual queue ${String(sim.spawner.stats.maxVirtualQueueDepth)}, ` +
          `departures-driven trips present: ${String(sim.spawner.stats.carsAdmitted > 500)}`,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Trip seam (F7 handoff) + attributes
// ---------------------------------------------------------------------------

describe('trip records hand trip-start data to the F7 seam', () => {
  it('every departure becomes a trip with consistent spawn/depart data', () => {
    const config = createDefaultConfig();
    const sim = fullSim(config, 20260827);
    let departures = 0;
    let trips = 0;
    for (let t = 0; t < 3000; t += 1) {
      stepSim(sim);
      departures += sim.world.departures.length;
      for (const trip of sim.spawner.trips) {
        trips += 1;
        expect(trip.departTick).toBeGreaterThan(trip.spawnTick);
        expect(trip.spawnTick).toBeGreaterThanOrEqual(1);
        expect(trip.spawnTimeSeconds).toBeCloseTo(trip.spawnTick * DT, 10);
        expect(trip.departTimeSeconds).toBeCloseTo(trip.departTick * DT, 10);
        expect(trip.exitSpeedMps).toBeGreaterThanOrEqual(0);
        expect(trip.carLengthMeters).toBeGreaterThanOrEqual(LEN - 0.5);
        expect(trip.carLengthMeters).toBeLessThan(LEN + 0.5);
        const movement = sim.geometry.movements[trip.pathIndex];
        expect(movement).toBeDefined();
        expect(movement?.arm).toBe(trip.arm);
        expect(movement?.laneIndex).toBe(trip.laneIndex);
        expect(movement?.turn).toBe(trip.turn);
      }
    }
    expect(departures).toBeGreaterThan(50);
    expect(trips).toBe(departures); // no departure lost at the seam
  });

  it('carLengthMetersFromAttrWord spans [nominal-0.5, nominal+0.5) exactly', () => {
    expect(carLengthMetersFromAttrWord(0, 5)).toBeCloseTo(4.5, 12);
    expect(carLengthMetersFromAttrWord(0x7fffffff, 5)).toBeCloseTo(4.9999999998, 9);
    expect(carLengthMetersFromAttrWord(0xffffffff, 5)).toBeLessThan(5.5);
    expect(carLengthMetersFromAttrWord(0xffffffff, 5)).toBeGreaterThanOrEqual(5.499);
  });
});
