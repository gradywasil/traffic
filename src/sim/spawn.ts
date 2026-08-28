/**
 * Demand spawner (task F6; research R2 Part B — the pairing contract).
 *
 * **Arrival process:** per-arm per-tick Bernoulli trials, not exponential
 * inversion. Each tick, each arm draws `u = armStream.nextFloat()` ONCE and
 * fires an arrival iff `u < λ_arm·dt`. Turn choice is drawn from the same arm
 * stream at fire time; per-vehicle attributes (the `attrWord`, from which the
 * car length derives) come from the shared attribute stream, also at fire
 * time. One comparison of a uniform against a double — no `ln`, no
 * `Math.random`, everything in exact-IEEE space (R2 Part C rule 3).
 * Discrete-time binomial ≈ Poisson at dt = 0.1 s and veh/h-scale rates —
 * accepted modeling simplification, and the rate acceptance tolerance covers
 * exactly that binomial variance.
 *
 * **State independence (the pairing semantics):** RNG consumption must not
 * depend on control/queue state. Arrival draws happen every tick for every
 * arm regardless of whether previous arrivals were admitted; spillback-blocked
 * arrivals wait in per-lane VIRTUAL ENTRY QUEUES outside the simulated world
 * (they consume no further randomness — their draws already happened at fire
 * time) and are admitted FIFO once room opens. The paired demand realization
 * is the (timestamp, lane, turn, attribute) sequence; the admitted set MAY
 * differ across candidates — that difference is the treatment effect O1
 * measures. `spawnDigestHex()` rolls a hash over the fired sequence in fire
 * order — `(tick, arm, lane, turnIndex, attrWord)` — so pairing is assertable
 * at runtime.
 *
 * **Spawn-room rule (R1 §3.2, from the F4/F5 production-log finding):** a car
 * is only created when the entry lane's rearmost car leaves
 * `s_min + v_c·T` (≈ 15.8 m at defaults) of bumper gap — i.e. rearmost
 * `s − len ≥ s_min + v_c·T`, so `rearmost s ≥ len + s_min + v_c·T` ≈ 22.3 m.
 * Spawning closer places the new car inside the emergency envelope of the
 * queue ahead (the only thing that ever made F4's terminal clamp fire — with
 * the rule, the clamp stays dormant).
 *
 * **Pipeline position:** run `spawner.step(world)` immediately AFTER
 * `world.step(...)` each tick. Arrivals are tagged with `world.tick` (the
 * boundary they appear on); the created car's first movement is the following
 * step. Lane assignment among lanes serving the drawn turn is a per-(arm,
 * turn) round-robin counter — a deterministic function of the demand
 * realization itself, never of queue state (a least-loaded choice would leak
 * world state into the digest and break pairing).
 *
 * **Trip seam:** `world.step` already despawns at the path end and publishes
 * `DepartureRecord`s; the spawner joins each departure with its spawn record
 * into a `TripRecord` (trip-start data for F7 — stops/delay are F7's to
 * compute, R2 Part C's completion tuple `(spawnTick, departTick, ...)` is
 * ready here).
 */
import type { ArmId, IntersectionConfig, TurnDirection } from '../config';
import { ARM_IDS, TURN_DIRECTIONS } from '../config';
import type { IntersectionGeometry } from '../geom';
import { itemAt } from '../geom';
import { DualLaneDigest } from './hash';
import { spawnStreamsForRep } from './rng';
import type { SpawnStreams } from './rng';
import { f64At, i32At } from './store';
import type { CarWorld } from './world';

/** One fired arrival — the demand realization unit (state-independent). */
export interface SpawnEvent {
  /** Tick boundary the arrival fired on (`world.tick` after the step). */
  readonly tick: number;
  readonly timeSeconds: number;
  readonly armIndex: number;
  readonly arm: ArmId;
  readonly laneIndex: number;
  readonly turn: TurnDirection;
  /** Index into `geometry.movements` — the full route/position of the spawn. */
  readonly pathIndex: number;
  /** Raw attribute draw (uint32) — part of the paired realization + digest. */
  readonly attrWord: number;
  /** Car length derived from `attrWord` (see `carLengthMetersFromAttrWord`). */
  readonly carLengthMeters: number;
}

/** A fired arrival that entered the world this tick (passed the room rule). */
export interface AdmittedCar {
  readonly event: SpawnEvent;
  /** Store entity id of the created car. */
  readonly entityId: number;
}

/**
 * Completed trip with trip-start data: the F7 seam (R2 Part C completion
 * tuple `(spawnTick, departTick, ...)` — stops and delay are F7's).
 */
export interface TripRecord {
  readonly entityId: number;
  readonly pathIndex: number;
  readonly armIndex: number;
  readonly arm: ArmId;
  readonly laneIndex: number;
  readonly turn: TurnDirection;
  readonly attrWord: number;
  readonly carLengthMeters: number;
  readonly spawnTick: number;
  readonly spawnTimeSeconds: number;
  readonly departTick: number;
  readonly departTimeSeconds: number;
  readonly exitSpeedMps: number;
}

export interface SpawnerOptions {
  /** Master run seed S (uint32; UI / preset default). Default 1. */
  readonly masterSeed?: number;
  /** Sweep repetition index r (repSeed = H32(S, REP_TAG, r)). Default 0. */
  readonly repIndex?: number;
}

export interface SpawnerStats {
  readonly arrivalsFired: number;
  readonly carsAdmitted: number;
  /** Max per-lane virtual-queue depth observed (spillback evidence). */
  readonly maxVirtualQueueDepth: number;
  /** Total cars currently waiting in virtual entry queues. */
  readonly currentVirtualQueueDepth: number;
}

export interface SpawnTickResult {
  /** Arrivals fired this tick (admitted or virtually queued — same stream). */
  readonly fired: readonly SpawnEvent[];
  /** Fired arrivals that entered the world store this tick. */
  readonly admitted: readonly AdmittedCar[];
  /** Trips completed this tick (departure ⋈ spawn record), in depart order. */
  readonly trips: readonly TripRecord[];
}

/**
 * Car length from an attrWord: uniform in [nominal − 0.5, nominal + 0.5) —
 * heterogeneous but centered on the model param all safety math assumes
 * (F4/F5 invariants are length-aware; queues at 5.0 ± 0.5 m keep spacing
 * far above the s_min floor). Pure, exact-IEEE (one division).
 */
export function carLengthMetersFromAttrWord(attrWord: number, nominalMeters: number): number {
  return nominalMeters + (attrWord / 4294967296 - 0.5);
}

/** Cumulative turn-mix bucket (zero-probability turns are skipped). */
interface TurnBucket {
  readonly turn: TurnDirection;
  readonly turnIndex: number;
  readonly cum: number;
}

export class Spawner {
  readonly geometry: IntersectionGeometry;
  /**
   * The config this spawner currently draws demand from. Replaced (not
   * mutated) by `reconfigure` on live demand-only changes (task U2) —
   * lanes/designations/cruise/params are guaranteed unchanged there by the
   * caller (`SimRuntime.applyConfig` classification).
   */
  config: IntersectionConfig;
  readonly masterSeed: number;
  readonly repIndex: number;

  /** This tick's fired arrivals / admissions / completed trips. */
  fired: readonly SpawnEvent[] = [];
  admitted: readonly AdmittedCar[] = [];
  trips: readonly TripRecord[] = [];

  private readonly streams: SpawnStreams;
  private readonly digest: DualLaneDigest;

  /** Per-tick arrival probability λ_arm·dt, canonical arm order. */
  private readonly arrivalProb: number[];
  /** Cumulative turn mix per arm (positive-probability turns only). */
  private readonly turnTables: TurnBucket[][];
  /** Lane indices serving each (arm, turn), ascending. */
  private readonly servingLanes: number[][][];
  /** Round-robin cursor per (arm, turn) — advances on FIRE, never on admission. */
  private readonly laneCursor: Int32Array;
  /** Movement index per (arm, lane, turn); -1 = not served. */
  private readonly movementAt: Int32Array;
  /** chain id (armIndex*3 + laneIndex) per movement index (world's scheme). */
  private readonly chainOfMovement: Int32Array;
  /** Virtual entry queues per chain id (armIndex*3 + laneIndex). */
  private readonly queues: SpawnEvent[][];
  /** Spawn-room requirement per arm: s_min + v_c·T of bumper gap. */
  private readonly roomNeed: number[];
  private readonly laneCounts: number[];

  private readonly spawnOfEntity = new Map<number, SpawnEvent>();
  private statsState: SpawnerStats = {
    arrivalsFired: 0,
    carsAdmitted: 0,
    maxVirtualQueueDepth: 0,
    currentVirtualQueueDepth: 0,
  };

  constructor(geometry: IntersectionGeometry, config: IntersectionConfig, options: SpawnerOptions = {}) {
    this.geometry = geometry;
    this.config = config;
    this.masterSeed = (options.masterSeed ?? 1) | 0;
    this.repIndex = (options.repIndex ?? 0) | 0;
    this.streams = spawnStreamsForRep(this.masterSeed, this.repIndex);
    this.digest = new DualLaneDigest(this.streams.repSeed);

    const params = config.modelParams;
    this.arrivalProb = [];
    this.turnTables = [];
    this.servingLanes = [];
    this.laneCursor = new Int32Array(12); // armIndex*3 + turnIndex
    this.movementAt = new Int32Array(36).fill(-1); // (armIndex*3 + laneIndex)*3 + turnIndex
    this.chainOfMovement = new Int32Array(geometry.movements.length);
    this.queues = [];
    this.roomNeed = [];
    this.laneCounts = [];

    this.buildDemandTables(config);

    for (let armIndex = 0; armIndex < 4; armIndex += 1) {
      const arm = config.arms[itemAt(ARM_IDS, armIndex)];
      this.roomNeed.push(
        params.hardMinGapMeters + arm.cruiseSpeedMps * params.timeHeadwaySeconds,
      );
      this.laneCounts.push(arm.lanes.length);

      // Lanes serving each turn, ascending lane index.
      const serving: number[][] = [[], [], []];
      for (let laneIndex = 0; laneIndex < arm.lanes.length; laneIndex += 1) {
        for (const turn of itemAt(arm.lanes, laneIndex).designations) {
          itemAt(serving, TURN_DIRECTIONS.indexOf(turn)).push(laneIndex);
        }
      }
      this.servingLanes.push(serving);
    }

    for (let m = 0; m < geometry.movements.length; m += 1) {
      const movement = itemAt(geometry.movements, m);
      const armIndex = ARM_IDS.indexOf(movement.arm);
      const turnIndex = TURN_DIRECTIONS.indexOf(movement.turn);
      this.chainOfMovement[m] = armIndex * 3 + movement.laneIndex;
      this.movementAt[(armIndex * 3 + movement.laneIndex) * 3 + turnIndex] = m;
    }
    for (let chain = 0; chain < 12; chain += 1) this.queues.push([]);
  }

  /**
   * (Re)build the demand tables — per-arm arrival probabilities and
   * cumulative turn-mix buckets — from a config. Pure bookkeeping; shared by
   * the constructor and `reconfigure`.
   */
  private buildDemandTables(config: IntersectionConfig): void {
    this.arrivalProb.length = 0;
    this.turnTables.length = 0;
    const dt = config.dt;
    for (let armIndex = 0; armIndex < 4; armIndex += 1) {
      const armId = itemAt(ARM_IDS, armIndex);
      const arm = config.arms[armId];
      this.arrivalProb.push((arm.spawnRateVehPerHour / 3600) * dt);

      // Cumulative turn mix over positive-probability turns (canonical order).
      const table: TurnBucket[] = [];
      let cum = 0;
      for (let turnIndex = 0; turnIndex < TURN_DIRECTIONS.length; turnIndex += 1) {
        const turn = itemAt(TURN_DIRECTIONS, turnIndex);
        const p = arm.turnMix[turn];
        if (p > 0) {
          cum += p;
          table.push({ turn, turnIndex, cum });
        }
      }
      if (table.length === 0) throw new Error(`arm '${armId}' turn mix is all zeros (validate the config)`);
      this.turnTables.push(table);
    }
  }

  /**
   * Live-apply a DEMAND-ONLY config change (task U2): rebuild the arrival
   * probabilities and turn tables while PRESERVING the RNG stream position
   * (the demand process changes its parameters, not its history — arrivals
   * continue from the same sub-streams), the pairing digest, the round-robin
   * lane cursors and any virtual entry queues (spillback demand is not
   * silently dropped). The caller must guarantee lanes/designations/cruise/
   * params are unchanged — `SimRuntime.applyConfig` enforces that via its
   * change classification before calling.
   */
  reconfigure(config: IntersectionConfig): void {
    this.buildDemandTables(config);
    this.config = config;
  }

  /**
   * Fire this tick's arrivals and admit what fits. Call immediately after
   * `world.step(...)`. Pure function of (spawner state, tick, world store) —
   * the RNG consumption order is fixed (arm N→E→S→W, one arrival draw per arm
   * per tick, turn + attr draws only at fire) and never inspects control or
   * queue state before drawing.
   */
  step(world: CarWorld): SpawnTickResult {
    const tick = world.tick;
    const timeSeconds = world.time;
    const fired: SpawnEvent[] = [];

    // 1. Arrival draws — the state-independent demand realization.
    for (let armIndex = 0; armIndex < 4; armIndex += 1) {
      const armStream = itemAt(this.streams.arms, armIndex);
      const u = armStream.nextFloat();
      if (!(u < itemAt(this.arrivalProb, armIndex))) continue;
      const turnU = armStream.nextFloat(); // drawn from the same arm stream
      const bucket = this.pickTurnBucket(armIndex, turnU);
      const attrWord = this.streams.attrs.nextUint32(); // shared attr stream
      const event = this.fireArrival(armIndex, bucket, attrWord, tick, timeSeconds);
      fired.push(event);
    }

    // 2. Digest in fire order: (tick, arm, lane, turnIndex, attrWord).
    for (const event of fired) {
      this.digest.word(event.tick);
      this.digest.word(event.armIndex);
      this.digest.word(event.laneIndex);
      this.digest.word(TURN_DIRECTIONS.indexOf(event.turn));
      this.digest.word(event.attrWord);
    }

    // 3. Virtual-queue admission (canonical arm/lane order; no randomness).
    const admitted: AdmittedCar[] = [];
    for (let armIndex = 0; armIndex < 4; armIndex += 1) {
      const laneCount = itemAt(this.laneCounts, armIndex);
      for (let laneIndex = 0; laneIndex < laneCount; laneIndex += 1) {
        const chain = armIndex * 3 + laneIndex;
        const queue = itemAt(this.queues, chain);
        while (queue.length > 0 && this.hasRoom(world, chain, itemAt(this.roomNeed, armIndex))) {
          const event = queue.shift();
          if (event === undefined) break; // unreachable: length checked
          const entityId = world.store.addCar(
            {
              pathIndex: event.pathIndex,
              s: 0,
              speed: this.config.arms[event.arm].cruiseSpeedMps,
              carLengthMeters: event.carLengthMeters,
            },
            tick,
            this.geometry.movements,
          );
          this.spawnOfEntity.set(entityId, event);
          admitted.push({ event, entityId });
        }
      }
    }

    // 4. Departure join — trip-start data handed to F7 through the seam.
    const trips: TripRecord[] = [];
    for (const departure of world.departures) {
      const event = this.spawnOfEntity.get(departure.entityId);
      if (event === undefined) continue; // not this spawner's car (tests/debug)
      this.spawnOfEntity.delete(departure.entityId);
      trips.push({
        entityId: departure.entityId,
        pathIndex: departure.pathIndex,
        armIndex: event.armIndex,
        arm: event.arm,
        laneIndex: event.laneIndex,
        turn: event.turn,
        attrWord: event.attrWord,
        carLengthMeters: event.carLengthMeters,
        spawnTick: event.tick,
        spawnTimeSeconds: event.timeSeconds,
        departTick: departure.tick,
        departTimeSeconds: departure.timeSeconds,
        exitSpeedMps: departure.exitSpeedMps,
      });
    }

    // 5. Stats.
    let waiting = 0;
    let maxDepth = this.statsState.maxVirtualQueueDepth;
    for (let chain = 0; chain < 12; chain += 1) {
      const depth = itemAt(this.queues, chain).length;
      waiting += depth;
      if (depth > maxDepth) maxDepth = depth;
    }
    this.statsState = {
      arrivalsFired: this.statsState.arrivalsFired + fired.length,
      carsAdmitted: this.statsState.carsAdmitted + admitted.length,
      maxVirtualQueueDepth: maxDepth,
      currentVirtualQueueDepth: waiting,
    };

    this.fired = fired;
    this.admitted = admitted;
    this.trips = trips;
    return { fired, admitted, trips };
  }

  /** Rolling pairing digest over the fired arrival sequence (R2 Part B). */
  spawnDigestHex(): string {
    return this.digest.hex();
  }

  get stats(): SpawnerStats {
    return this.statsState;
  }

  /** Cars currently waiting in one lane's virtual entry queue. */
  virtualQueueDepth(armIndex: number, laneIndex: number): number {
    return itemAt(this.queues, armIndex * 3 + laneIndex).length;
  }

  /** Cumulative turn-mix walk; the tail beyond the last bucket clamps down. */
  private pickTurnBucket(armIndex: number, turnU: number): TurnBucket {
    const table = itemAt(this.turnTables, armIndex);
    let chosen = itemAt(table, table.length - 1);
    for (const bucket of table) {
      if (turnU < bucket.cum) {
        chosen = bucket;
        break;
      }
    }
    return chosen;
  }

  /**
   * Build a fired arrival: lane via round-robin over the lanes serving the
   * drawn turn (state-independent by construction). Throws on an incoherent
   * config (positive-probability turn with no serving lane — F2 validation
   * rejects those; the throw keeps unvalidated input loud).
   */
  private fireArrival(
    armIndex: number,
    bucket: TurnBucket,
    attrWord: number,
    tick: number,
    timeSeconds: number,
  ): SpawnEvent {
    const armId = itemAt(ARM_IDS, armIndex);
    const serving = itemAt(itemAt(this.servingLanes, armIndex), bucket.turnIndex);
    if (serving.length === 0) {
      throw new Error(`turn '${bucket.turn}' on arm '${armId}' has positive mix but no serving lane`);
    }
    const cursor = this.laneCursor[armIndex * 3 + bucket.turnIndex] ?? 0;
    this.laneCursor[armIndex * 3 + bucket.turnIndex] = cursor + 1;
    const laneIndex = itemAt(serving, cursor % serving.length);
    const pathIndex = i32At(this.movementAt, (armIndex * 3 + laneIndex) * 3 + bucket.turnIndex);
    if (pathIndex < 0) {
      throw new Error(`no movement for ${armId}:${String(laneIndex)}:${bucket.turn} (geometry/config mismatch)`);
    }
    const event: SpawnEvent = {
      tick,
      timeSeconds,
      armIndex,
      arm: armId,
      laneIndex,
      turn: bucket.turn,
      pathIndex,
      attrWord,
      carLengthMeters: carLengthMetersFromAttrWord(attrWord, this.config.modelParams.carLengthMeters),
    };
    itemAt(this.queues, armIndex * 3 + laneIndex).push(event);
    return event;
  }

  /**
   * Spawn-room rule (R1 §3.2): the rearmost same-chain car must leave
   * `need = s_min + v_c·T` of bumper gap for the new car entering at s = 0,
   * i.e. `rearmostS − rearmostLength ≥ need` (equivalently
   * `rearmostS ≥ len + s_min + v_c·T` ≈ 22.3 m at defaults). Uses the
   * rearmost car's ACTUAL length (lengths vary with the attrWord).
   */
  private hasRoom(world: CarWorld, chain: number, need: number): boolean {
    const store = world.store;
    let rearmostS = Number.POSITIVE_INFINITY;
    let rearmostLength = 0;
    for (let i = 0; i < store.count; i += 1) {
      if (i32At(this.chainOfMovement, i32At(store.pathIndex, i)) === chain) {
        const s = f64At(store.s, i);
        if (s < rearmostS) {
          rearmostS = s;
          rearmostLength = f64At(store.carLengthMeters, i);
        }
      }
    }
    if (rearmostS === Number.POSITIVE_INFINITY) return true; // lane empty
    return rearmostS - rearmostLength >= need;
  }
}
