/**
 * SimRuntime tests (task U2 acceptance): the live-apply path —
 * - change classification (geometry-affecting vs demand/plan-only),
 * - live changes keep cars in flight and the tick running (rates/mixes
 *   reconfigure the spawner in place; green changes retarget the ring),
 * - geometry-affecting changes reset the world (cars dropped, tick 0,
 *   same master seed replays the new config deterministically),
 * - the F7 stats-reset signal fires on BOTH paths,
 * - the determinism contract: a scripted (config-change schedule, seed) run
 *   replays bit-identically; swaps land on exact tick boundaries.
 */
import { describe, expect, it } from 'vitest';
import { validateConfig } from '../config';
import type { IntersectionConfig } from '../config';
import { getPreset } from '../presets';
import { hashCarStore } from '../sim/hash';
import { classifyConfigChange, SimRuntime } from './sim-runtime';

/** Deep-writable view of the (deep-readonly) config, for test-side edits. */
type Writable<T> = { -readonly [K in keyof T]: Writable<T[K]> };

/**
 * De-aliased mutable clone — presets stamp ONE shared arm object onto all
 * four arms and `structuredClone` preserves that sharing; per-arm clones
 * break it so test-side per-arm edits cannot leak across arms.
 */
function clone(config: IntersectionConfig): Writable<IntersectionConfig> {
  return {
    ...structuredClone(config),
    arms: {
      north: structuredClone(config.arms.north),
      east: structuredClone(config.arms.east),
      south: structuredClone(config.arms.south),
      west: structuredClone(config.arms.west),
    },
  } as Writable<IntersectionConfig>;
}

function balanced(): Writable<IntersectionConfig> {
  return clone(getPreset('balanced').config);
}

describe('classifyConfigChange — what a config change means for the running sim', () => {
  it('identical configs are none', () => {
    expect(classifyConfigChange(balanced(), balanced())).toBe('none');
  });

  it('demand-only changes (spawn rate, turn mix) are live', () => {
    const rate = balanced();
    rate.arms.north.spawnRateVehPerHour = 800;
    expect(classifyConfigChange(balanced(), rate)).toBe('live');

    const mix = balanced();
    mix.arms.east.turnMix = { left: 0.3, through: 0.5, right: 0.2 };
    expect(classifyConfigChange(balanced(), mix)).toBe('live');
  });

  it('signal-plan-only changes (greens, cycle, leftMode) are live', () => {
    const greens = balanced();
    if (greens.control.type !== 'signal') throw new Error('unreachable');
    greens.control.plan.phases[0]!.greenSeconds = 9;
    greens.control.plan.cycleLengthSeconds = 61;
    expect(classifyConfigChange(balanced(), greens)).toBe('live');
  });

  it('lane structure / cruise / geometry / modelParams / dt / control-type changes are reset', () => {
    const lanes = balanced();
    lanes.arms.north.lanes = [{ designations: ['left', 'through', 'right'] }];
    expect(classifyConfigChange(balanced(), lanes)).toBe('reset');

    const cruise = balanced();
    cruise.arms.south.cruiseSpeedMps = 12;
    expect(classifyConfigChange(balanced(), cruise)).toBe('reset');

    const width = balanced();
    width.geometry.laneWidthMeters = 3.2;
    expect(classifyConfigChange(balanced(), width)).toBe('reset');

    const params = balanced();
    params.modelParams.timeHeadwaySeconds = 1.2;
    expect(classifyConfigChange(balanced(), params)).toBe('reset');

    const dt = balanced();
    dt.dt = 0.05;
    expect(classifyConfigChange(balanced(), dt)).toBe('reset');

    const controlType = balanced();
    controlType.control = { type: 'all-way-stop' };
    expect(classifyConfigChange(balanced(), controlType)).toBe('reset');
  });
});

describe('SimRuntime.applyConfig — live scope (keep running)', () => {
  it('a rate change keeps cars in flight, the tick and the world object; metrics reset', () => {
    const runtime = new SimRuntime(balanced(), { masterSeed: 7 });
    for (let tick = 0; tick < 600; tick += 1) runtime.step(); // 60 s — cars on the road
    expect(runtime.world.store.count).toBeGreaterThan(0);
    const worldBefore = runtime.world;
    const tickBefore = runtime.world.tick;
    const carsBefore = runtime.world.store.count;

    const next = clone(runtime.config);
    next.arms.north.spawnRateVehPerHour = 900;
    // Capture the window anchor BEFORE the apply (reset() nulls it).
    const elapsedBefore = runtime.metrics.snapshot().elapsedSinceResetSeconds;
    const result = runtime.applyConfig(next);

    expect(result.scope).toBe('live');
    expect(result.geometryRebuilt).toBe(false);
    expect(result.appliedAtTick).toBe(tickBefore);
    expect(runtime.world).toBe(worldBefore); // same world — cars kept
    expect(runtime.world.tick).toBe(tickBefore);
    expect(runtime.world.store.count).toBe(carsBefore);
    expect(elapsedBefore).toBeGreaterThan(30);
    // Stats-reset signal fired: the window re-anchors at the next observe
    // (elapsed collapses from ~60 s to 0 — well under one dt).
    runtime.step();
    const elapsedAfter = runtime.metrics.snapshot().elapsedSinceResetSeconds;
    expect(elapsedAfter).toBeLessThan(runtime.config.dt);
  });

  it('a rate cut to 0 stops new arrivals from the NEXT tick (tick-boundary apply)', () => {
    const runtime = new SimRuntime(balanced(), { masterSeed: 3 });
    for (let tick = 0; tick < 400; tick += 1) runtime.step();
    const firedBefore = runtime.spawner.stats.arrivalsFired;
    expect(firedBefore).toBeGreaterThan(0);

    const next = clone(runtime.config);
    for (const arm of ['north', 'east', 'south', 'west'] as const) {
      next.arms[arm].spawnRateVehPerHour = 0;
    }
    const result = runtime.applyConfig(next);
    expect(result.scope).toBe('live');

    for (let tick = 0; tick < 600; tick += 1) runtime.step();
    // No arrival fired after the change took effect (cars drain, demand stops).
    expect(runtime.spawner.stats.arrivalsFired).toBe(firedBefore);
    // In-flight cars drain: the world empties.
    expect(runtime.world.store.count).toBe(0);
  });

  it('a green change retargets the ring live without dropping claims or cars', () => {
    const runtime = new SimRuntime(balanced(), { masterSeed: 11 });
    for (let tick = 0; tick < 600; tick += 1) runtime.step();
    const cycleTicksBefore = runtime.control.signal?.cycleTicks;
    const grantsBefore = runtime.control.claims.stats.grants;

    const next = clone(runtime.config);
    if (next.control.type !== 'signal') throw new Error('unreachable');
    next.control.plan.phases[1]!.greenSeconds = 22;
    next.control.plan.cycleLengthSeconds = 67;
    const result = runtime.applyConfig(next);

    expect(result.scope).toBe('live');
    expect(result.controlChanged).toBe(true);
    expect(runtime.control.signal?.cycleTicks).not.toBe(cycleTicksBefore);
    expect(runtime.control.claims.stats.grants).toBe(grantsBefore); // claim history intact
    expect(runtime.world.tick).toBe(600);
    // Keeps running coherently (soak the retargeted ring).
    for (let tick = 0; tick < 600; tick += 1) runtime.step();
    expect(runtime.control.claims.stats.ungrantedLineCrossings).toBe(0);
    expect(runtime.world.clampCount).toBe(0);
  });

  it('a turn-mix change reconfigures the spawner without restarting the demand stream', () => {
    const runtime = new SimRuntime(balanced(), { masterSeed: 5 });
    for (let tick = 0; tick < 300; tick += 1) runtime.step();
    const next = clone(runtime.config);
    next.arms.north.turnMix = { left: 0.5, through: 0.3, right: 0.2 };
    expect(validateConfig(next)).toEqual([]);
    const result = runtime.applyConfig(next);
    expect(result.scope).toBe('live');
    // The spawner object survives (queues, cursors, digest position).
    const spawnerBefore = runtime.spawner;
    runtime.step();
    expect(runtime.spawner).toBe(spawnerBefore);
  });

  it('an identical config is a no-op (no metrics reset)', () => {
    const runtime = new SimRuntime(balanced(), { masterSeed: 2 });
    for (let tick = 0; tick < 100; tick += 1) runtime.step();
    const result = runtime.applyConfig(clone(runtime.config));
    expect(result.scope).toBe('none');
    runtime.step();
    // Anchored at the first observe (t = 0.1): 101 steps => ~10.0 s elapsed.
    expect(runtime.metrics.snapshot().elapsedSinceResetSeconds).toBeCloseTo(10, 6);
  });
});

describe('SimRuntime.applyConfig — reset scope (world rebuild)', () => {
  it('a lane change rebuilds the world: cars dropped, tick 0, fresh spawner, fresh metrics', () => {
    const runtime = new SimRuntime(balanced(), { masterSeed: 7 });
    for (let tick = 0; tick < 600; tick += 1) runtime.step();
    expect(runtime.world.store.count).toBeGreaterThan(0);
    const worldBefore = runtime.world;
    const geometryBefore = runtime.geometry;

    const next = clone(runtime.config);
    next.arms.north.lanes = [
      { designations: ['left'] },
      { designations: ['through'] },
      { designations: ['right'] },
    ];
    next.arms.north.turnMix = { left: 0.2, through: 0.6, right: 0.2 };
    const result = runtime.applyConfig(next);

    expect(result.scope).toBe('reset');
    expect(result.geometryRebuilt).toBe(true);
    expect(result.appliedAtTick).toBe(0);
    expect(runtime.world).not.toBe(worldBefore);
    expect(runtime.geometry).not.toBe(geometryBefore);
    expect(runtime.world.tick).toBe(0);
    expect(runtime.world.store.count).toBe(0);
    runtime.step();
    // Fresh engine: the window anchors at the first post-reset observe.
    expect(runtime.metrics.snapshot().elapsedSinceResetSeconds).toBeLessThan(runtime.config.dt);
  });

  it('a control-type switch resets (claim regimes cannot be re-adjudicated mid-box)', () => {
    const runtime = new SimRuntime(balanced(), { masterSeed: 9 });
    for (let tick = 0; tick < 300; tick += 1) runtime.step();
    const next = clone(runtime.config);
    next.control = { type: 'all-way-stop' };
    const result = runtime.applyConfig(next);
    expect(result.scope).toBe('reset');
    expect(runtime.control.mode).toBe('stop');
    // The rebuilt all-way-stop world keeps running cleanly.
    for (let tick = 0; tick < 600; tick += 1) runtime.step();
    expect(runtime.world.clampCount).toBe(0);
  });

  it('invalid configs are refused loudly (the runtime is the guard behind the panel)', () => {
    const runtime = new SimRuntime(balanced());
    const broken = balanced();
    broken.arms.north.lanes = [];
    expect(() => runtime.applyConfig(broken)).toThrow(/invalid/);
  });
});

describe('SimRuntime — determinism contract (config swap at tick boundary)', () => {
  /**
   * Scripted run: 600 ticks of balanced, a LIVE rate change, 400 more ticks,
   * then a RESET lane change, 200 ticks of the new config. Returns the
   * per-tick store-hash sequence (sampled every 25 ticks + the final).
   */
  function scriptedRun(): string[] {
    const runtime = new SimRuntime(balanced(), { masterSeed: 42 });
    const hashes: string[] = [];
    const sample = (): void => {
      hashes.push(hashCarStore(runtime.world.store, runtime.world.tick, [runtime.world.clampCount]));
    };
    for (let tick = 0; tick < 600; tick += 1) {
      runtime.step();
      if (tick % 25 === 24) sample();
    }
    const rateChange = clone(runtime.config);
    rateChange.arms.east.spawnRateVehPerHour = 1000;
    const liveResult = runtime.applyConfig(rateChange);
    if (liveResult.scope !== 'live') throw new Error(`expected live, got ${liveResult.scope}`);
    for (let tick = 0; tick < 400; tick += 1) {
      runtime.step();
      if (tick % 25 === 24) sample();
    }
    const laneChange = clone(runtime.config);
    laneChange.arms.west.lanes = [{ designations: ['left', 'through', 'right'] }];
    laneChange.arms.west.turnMix = { left: 0.25, through: 0.5, right: 0.25 };
    const resetResult = runtime.applyConfig(laneChange);
    if (resetResult.scope !== 'reset') throw new Error(`expected reset, got ${resetResult.scope}`);
    for (let tick = 0; tick < 200; tick += 1) {
      runtime.step();
      if (tick % 25 === 24) sample();
    }
    sample();
    return hashes;
  }

  it('the same (config-change schedule, seed) replays bit-identically', () => {
    const first = scriptedRun();
    const second = scriptedRun();
    expect(second).toEqual(first);
    expect(first.length).toBeGreaterThan(40);
    // Sanity: the run actually lived (hashes are non-trivial).
    expect(new Set(first).size).toBeGreaterThan(10);
  });

  it('a fresh reset run of a config equals a run started from that config directly', () => {
    // After the reset, SimRuntime is byte-equivalent to constructing the
    // runtime with the new config directly (same master seed).
    const changed = balanced();
    changed.arms.west.lanes = [{ designations: ['left', 'through', 'right'] }];
    changed.arms.west.turnMix = { left: 0.25, through: 0.5, right: 0.25 };

    const direct = new SimRuntime(changed, { masterSeed: 42 });
    for (let tick = 0; tick < 150; tick += 1) direct.step();
    const directHash = hashCarStore(direct.world.store, direct.world.tick, [direct.world.clampCount]);

    const viaReset = new SimRuntime(balanced(), { masterSeed: 42 });
    viaReset.applyConfig(clone(changed));
    for (let tick = 0; tick < 150; tick += 1) viaReset.step();
    const resetHash = hashCarStore(viaReset.world.store, viaReset.world.tick, [viaReset.world.clampCount]);
    expect(resetHash).toBe(directHash);
  });
});
