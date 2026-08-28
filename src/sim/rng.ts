/**
 * Seeded RNG for demand generation (task F6; research R2 Part B — the binding
 * PRNG + sub-stream record).
 *
 * Design (committed in docs/ultron/research/track-b-execution-determinism.md):
 * - **sfc32** (PractRand v4 constants: BARREL_SHIFT 21, RSHIFT 9, LSHIFT 3;
 *   4×uint32 state; ≥ 12 warmup iterations after seeding) — chosen for JS-native
 *   32-bit ergonomics: state words map 1:1 to JS numbers via `|0`/`Math.imul`,
 *   no BigInt, ENDIAN_SAFE, ~2^127 average period (astronomically beyond the
 *   ≤ ~10^6 draws per rep this product needs).
 * - **H32** sub-stream derivation: MurmurHash3-style 32-bit integer finalizer
 *   composition (splitmix construction at 32-bit width: odd-increment mixing +
 *   alternating xor-shift / `Math.imul` multiply) — exact integer ops only.
 * - Named sub-streams from a master run seed `S` (uint32 from UI/preset):
 *   `repSeed = H32(S, REP_TAG, r)`, `armSeed[a] = H32(repSeed, ARM_TAG, a)`
 *   for a ∈ {N,E,S,W}, `attrSeed = H32(repSeed, ATTR_TAG)` — each expands into
 *   its own sfc32 instance. Streams never cross: an arm's arrival stream is
 *   never consumed by behavior code.
 * - Regeneration, not transfer: workers rebuild the demand stream from
 *   `(S, r)` — pairing across sweep candidates is proven by construction and
 *   asserted at runtime via the spawn digest (see spawn.ts).
 *
 * R2 Part C rulebook: no `Math.random`, no clocks; integer ops (`imul`, `>>>`,
 * `|`, `+`) plus one division for the float conversion — everything stays in
 * exact-IEEE space.
 */

/**
 * Sub-stream tags for the H32 derivations. Distinct 32-bit constants (ASCII
 * mnemonics: "rep1", "arm1", "att1", "exp1"); the values themselves are
 * arbitrary — they only need to differ so streams never collide.
 */
export const REP_TAG = 0x72657031 | 0;
export const ARM_TAG = 0x61726d31 | 0;
export const ATTR_TAG = 0x61747431 | 0;
/** Expands one 32-bit seed into the three state words of an sfc32 instance. */
export const EXPAND_TAG = 0x65787031 | 0;

/**
 * H32: MurmurHash3-style 32-bit integer finalizer composition (pure
 * `Math.imul` / xor / shift — exact integer ops, R2 Part B). Splitmix-style
 * construction at 32-bit width: fold `tag`/`index` into the seed with odd
 * golden-ratio multipliers, then run the alternating xor-shift / multiply
 * avalanche. Returns a signed int32 (use `>>> 0` for the unsigned view).
 */
export function h32(seed: number, tag: number, index: number): number {
  let z = ((seed | 0) ^ Math.imul(tag | 0, 0x9e3779b9) ^ Math.imul(index | 0, 0x85ebca6b)) | 0;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) | 0;
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) | 0;
  return (z ^ (z >>> 16)) | 0;
}

/**
 * sfc32 step on a 4-word `[a, b, c, counter]` state (PractRand v4 reference,
 * transcribed; JS `>>>` / `<<` / `|0` give the uint32 semantics):
 *
 * ```text
 * tmp = a + b + counter++;      // output word
 * a   = b ^ (b >> 9);           // RSHIFT = 9
 * b   = c + (c << 3);           // LSHIFT = 3
 * c   = rotl(c, 21) + tmp;      // BARREL_SHIFT = 21
 * ```
 *
 * Exported in reference shape (mutable Uint32Array state) so tests can
 * cross-check the class against an independent transcription of the record.
 */
export function sfc32Next(state: Uint32Array): number {
  const a = state[0] ?? 0;
  const b = state[1] ?? 0;
  const c = state[2] ?? 0;
  const counter = state[3] ?? 0;
  const t = (a + b + counter) | 0;
  state[3] = (counter + 1) | 0;
  state[0] = b ^ (b >>> 9);
  state[1] = (c + (c << 3)) | 0;
  state[2] = (((c << 21) | (c >>> 11)) + t) | 0;
  return t >>> 0;
}

/** Warmup iterations applied on seeding (PractRand `seed()` uses 12). */
export const SFC32_WARMUP_ITERATIONS = 12;

/**
 * sfc32 generator instance. Seeded with three state words + counter = 1
 * (PractRand's 4-word JS-style seeding), then warmed up: the constructor
 * advances the state `SFC32_WARMUP_ITERATIONS` (12) times, discarding output,
 * so low-quality seed bits cannot leak into the first draws.
 */
export class Sfc32 {
  private readonly state = new Uint32Array(4);

  constructor(a: number, b: number, c: number, counter = 1) {
    this.state[0] = a >>> 0;
    this.state[1] = b >>> 0;
    this.state[2] = c >>> 0;
    this.state[3] = counter >>> 0;
    for (let i = 0; i < SFC32_WARMUP_ITERATIONS; i += 1) sfc32Next(this.state);
  }

  /** Next raw output as an unsigned 32-bit integer. */
  nextUint32(): number {
    return sfc32Next(this.state);
  }

  /** Next uniform in [0, 1) — one division, exact-IEEE (R2 Part C rule 3). */
  nextFloat(): number {
    return this.nextUint32() / 4294967296;
  }
}

/**
 * Expand one 32-bit seed into a warmed-up sfc32 instance: the three state
 * words are H32 derivations of the seed (chained through EXPAND_TAG), counter
 * starts at 1 per the record's seeding note.
 */
export function sfc32FromSeed(seed: number): Sfc32 {
  return new Sfc32(h32(seed, EXPAND_TAG, 0), h32(seed, EXPAND_TAG, 1), h32(seed, EXPAND_TAG, 2));
}

// ---------------------------------------------------------------------------
// Paired-seed sub-stream derivation (R2 Part B, the O1 pairing contract)
// ---------------------------------------------------------------------------

/** repSeed = H32(S, REP_TAG, r) — one per sweep repetition / live run. */
export function repSeedOf(masterSeed: number, repIndex: number): number {
  return h32(masterSeed, REP_TAG, repIndex);
}

/** armSeed[a] = H32(repSeed, ARM_TAG, a) — the arrival stream of arm `a`. */
export function armSeedOf(repSeed: number, armIndex: number): number {
  return h32(repSeed, ARM_TAG, armIndex);
}

/** attrSeed = H32(repSeed, ATTR_TAG) — the per-vehicle attribute stream. */
export function attrSeedOf(repSeed: number): number {
  return h32(repSeed, ATTR_TAG, 0);
}

/**
 * The named sub-stream bundle one rep consumes: four arm arrival streams (in
 * canonical `ARM_IDS` order N, E, S, W) + the shared attribute stream. Demand
 * is a pure function of `(masterSeed, repIndex, demandConfig, tick)` — never
 * of control or queue state.
 */
export interface SpawnStreams {
  readonly masterSeed: number;
  readonly repIndex: number;
  readonly repSeed: number;
  readonly arms: readonly Sfc32[];
  readonly attrs: Sfc32;
}

export function spawnStreamsForRep(masterSeed: number, repIndex: number): SpawnStreams {
  const repSeed = repSeedOf(masterSeed, repIndex);
  const arms: Sfc32[] = [];
  for (let armIndex = 0; armIndex < 4; armIndex += 1) {
    arms.push(sfc32FromSeed(armSeedOf(repSeed, armIndex)));
  }
  return {
    masterSeed: masterSeed | 0,
    repIndex: repIndex | 0,
    repSeed,
    arms,
    attrs: sfc32FromSeed(attrSeedOf(repSeed)),
  };
}
