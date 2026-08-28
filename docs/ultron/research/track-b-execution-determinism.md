# Track B — Execution & Determinism (R2)

- **Delegation record:** deep-research track agent (Track B "execution & determinism"), dispatched by ultron-supreme, 2026-08-27.
- **Decision priority:** P0 (blocks O1; sets contracts consumed by F6 and Q1).
- **Status:** COMMITTED (auto-approved per pipeline; dispositions land before production entry).
- **Question and affected task IDs:** How to run headless paired-seed sweeps (≈60–100 candidates × 3 reps, ≤30s total) without janking the 60fps main loop; how to structure PRNG streams so candidates run on identical demand realizations; and which determinism rules + run-hash definition make "same seed+config ⇒ bit-identical run hash" provable. Affects **O1** (sweep harness), **F6** (spawner & RNG), **Q1** (determinism tests).

## Constraints and evaluation criteria (from brief + plan)

- 60fps fixed-timestep main sim (dt = 1/60s); UI must stay ≥55fps during the sweep; default sweep ≤30s total.
- Deterministic seeded runs; paired-seed evaluation (same demand realizations across candidates); acceptance includes bit-identical replay: same seed + config ⇒ identical run hash (Q1).
- TS + Vite, no UI framework, Canvas 2D, zero runtime deps in core — PRNG and hash must be hand-rolled from public-domain algorithms.
- Desktop evergreen latest-2; single-user, in-browser; session-only, no backend.
- Sweep horizon and per-tick cost are coupled; sizing must survive Q2's measured perf harness.

---

## Part A — Sweep execution architecture

### Options considered

1. **Dedicated Web Worker pool (module workers), message passing.** `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`; pool of `clamp(hardwareConcurrency − 1, 2, 6)` workers; one candidate-run per message; results returned per run.
2. **Time-sliced main thread** — budgeted chunks (~4–6ms) per frame inside the rAF loop (or `setTimeout(0)` when paused), same worker-free code path.
3. **SharedArrayBuffer shared-state parallelism** — rejected on deployment grounds (see evidence).
4. **OffscreenCanvas render offload** — irrelevant; sweep is headless, no rendering in the loop.

### Recommendation (a): Dedicated worker pool, workers = `clamp(navigator.hardwareConcurrency − 1, 2, 6)`, time-slicing kept as a compile-time-swappable fallback executor behind the same interface.

Architecture:

- `src/sim/` stays environment-agnostic (no DOM, no timers) so the identical module runs in the live sim (main thread) and in the sweep worker. This is already a plan requirement (headless sim capability).
- One worker executes whole candidate-runs: message in = `{runId, config, repSeed, horizonTicks}`; message out = `{runId, spawnDigest, runHash, metrics}`. Config is a plain JSON-able object (structured clone); all hashed/returned numeric fields are integers or fixed-point-quantized (Part C), so clone payload is exact.
- Work queue on main thread; idle worker pulls next run; progress posted per completed run (≤ ~300 messages total — negligible).
- Fallback executor: same `SweepExecutor` interface with a `timeSliced` implementation that runs `while (performance.now() − frameStart < budget) tick()` chunks in rAF (budget ≈ 4ms/frame when live sim is running, more when paused). Exists as an escape hatch (e.g., exotic embedding contexts where workers are blocked); not the default path.

**Rationale.** The sweep is embarrassingly parallel (300 independent runs, zero inter-run state). Workers give near-linear core scaling and zero interference with the render loop; time-slicing can only offer a fraction of one core and competes with the live sim for frame budget (arithmetic below). SAB buys nothing for one-shot batch jobs whose payloads are ~KB, while imposing header requirements on every deployment surface.

**Sizing arithmetic (assumptions marked; validate in Q2).** 300 runs over 30s = 100ms wall per run single-threaded, or ~0.4–0.6s per run with 5–6 workers. At an assumed headless per-tick cost of 0.1–0.5ms @ 150 cars (UNVERIFIED estimate derived from F4's "< 4ms/tick incl. render/main-thread overhead" acceptance; measure in Q2), 0.5s buys 1,000–5,000 ticks → default **horizon ≈ 45 sim-seconds per rep (2,700 ticks)**, capped by a tick budget so the 30s wall target degrades gracefully by shortening horizons, not by dropping pairing. Time-slice comparison: 60fps × ~5ms = ~0.3 core-seconds per wall second ⇒ 30s yields ~9 core-seconds — roughly 6–20× less compute than the pool, with jank risk on every frame. Workers win unless unavailable.

**Worker startup cost: UNVERIFIED, sized by reasoning.** No primary-source number found for modern engines. The bundle is small (core sim, few tens of KB); startup is plausibly ~5–40ms per worker (script fetch from cache + isolate creation). With a pool spawned once per sweep and 300 runs amortized across it, startup is <1% of the 30s budget. Message overhead likewise: no authoritative per-message cost found (unverified); ~300 small postMessages across 30s cannot plausibly threaten the budget; per-message payload is < 2KB.

**Pitfalls documented by Vite (must respect in O1):** the `new URL(...)` must sit directly inside the `new Worker()` call, and constructor options must be static literals — so the options object is a module constant, never built conditionally; the dynamic part is only *how many* workers to construct.

### Evidence — Part A

- **Vite docs, v8.2.2** (latest stable per npm/GitHub as of 2026-08-27; Vite 8.0 released 2026-03-12), "Web Workers" in Features guide (https://vite.dev/guide/features, retrieved 2026-08-27):
  - Recommended pattern: `new Worker(new URL('./worker.js', import.meta.url))`; module workers via `{ type: 'module' }`. "Compared to the worker suffixes, this syntax leans closer to the standards and it is the recommended way to create workers."
  - Exact caveats: "The worker detection will only work if the new URL() constructor is used directly inside the new Worker() declaration." / "Otherwise it is handled as a static asset URL instead." / "Additionally, all options parameters must be static values (i.e. string literals)."
  - ESM in workers: "The worker script can also use ESM import statements instead of importScripts(). Note: During development this relies on browser native support" and "for the production build it is compiled away." Default build output: "the worker script will be emitted as a separate chunk in the production build."
  - `?worker` / `?worker&inline` suffix imports exist as an alternative constructor export.
- **Vite docs v8.2.2, Worker Options** (https://vite.dev/config/worker-options, retrieved 2026-08-27): `worker.format` type `'es' | 'iife'`, **default `'iife'`** ("Output format for worker bundle") — i.e., build-time ESM is compiled away by default; the `{type:'module'}` literal we keep for dev fidelity is harmless in build (module workers are universally supported in our evergreen matrix anyway). `worker.plugins` needed if plugins must apply to worker bundles at build.
- **Module worker browser support** (caniuse.mdn-api_worker_worker_ecmascript_modules, StatCounter July 2026): Chrome 80+, Edge 80+, Firefox 114+, Safari 15+. Evergreen latest-2 is comfortably inside this range; dev-mode native module workers are safe.
- **SharedArrayBuffer gating — MDN** (https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer, last modified 2026-02-10): "To use shared memory your document must be in a secure context and cross-origin isolated." — "SharedArrayBuffer objects are in principle always available, but unfortunately the constructor on the global object is hidden, unless the two headers mentioned above are set"; without them "the various postMessage() APIs will throw for SharedArrayBuffer objects." Gated since 2018 due to Spectre.
- **COOP/COEP header values — web.dev** ("COOP and COEP explained", Eiji Kitamura, published 2020-04-13, updated 2022-06-21; https://web.dev/articles/coop-coep): required headers `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`; COEP require-corp "block[s] loading of resources or iframes which haven't opted into being loaded by cross-origin documents" (third-party assets need CORP/CORS opt-in; iframes need the whole chain isolated). **No localhost/dev exemption is documented.** This is a deployment hazard for a Vite static app (custom dev-server headers, and every future host/embedding surface must comply) with zero benefit for embarrassingly-parallel batch work ⇒ SAB rejected.
- **Worker pool sizing — MDN** `navigator.hardwareConcurrency` (last modified 2024-10-16): "returns the number of logical processors available to run threads"; caveat: "The browser may… choose to report a lower number of logical cores… so don't treat this as an absolute measurement." Hence clamp to [2,6] and leave ≥1 logical core for main thread (live sim + render).

---

## Part B — Paired-seed RNG & spawn stream design

### Options considered

1. **Per-rep seed shared across candidates; per-arm independent streams derived by integer hashing; arrivals generated on a fixed schedule independent of world state** (committed).
2. Pre-generated per-rep arrival traces shipped to every candidate (clone or transfer).
3. Single global RNG stream per rep (spawn draws interleaved with behavior draws).

### Recommendation (b): Option 1 — demand generation is a *pure function* of `(repSeed, demandConfig, tick)`, with named sub-streams.

Structure:

- Master run seed `S` (uint32 from UI or preset default). For sweep rep `r ∈ {0,1,2}`: `repSeed = H32(S, REP_TAG, r)`.
- Named streams derived from repSeed: `armSeed[a] = H32(repSeed, ARM_TAG, a)` for a ∈ {N,E,S,W}; `attrSeed = H32(repSeed, ATTR_TAG)`. `H32` = MurmurHash3-style 32-bit integer finalizer composition (pure `Math.imul`/xor/shift — exact integer ops). Each 32-bit seed initializes its own **sfc32** instance (algorithm below). Streams never cross: an arm's arrival stream is never consumed by behavior code.
- **Arrival process (F6): per-tick Bernoulli trials, not exponential inversion.** Each tick, each arm draws `u = armRng.nextFloat()` once and fires an arrival iff `u < λ_arm·dt`. Turn/route choice and per-vehicle attributes (speed factor, length, …) are drawn **at arrival-fire time from the same event**, i.e., they belong to the demand realization. This needs only one comparison of a uniform against a double — no `ln` — so the entire spawn stream lives in exact-IEEE space (Part C). (Discrete-time binomial arrival ≈ Poisson at dt = 1/60s and our rates; statistically indistinguishable for this product; per-tick probability must be ≤ 1 — always true at veh/h-scale rates. Marked as a modeling simplification, accepted.)
- **Independence rule (the pairing contract):** RNG consumption in the demand generator must not depend on control/queue state. Concretely: arrival draws happen every tick for every arm regardless of whether the previous arrival was admitted; blocked arrivals (entry blocked by queue spillback reaching the spawn point) are held in a per-lane *virtual entry queue* outside the simulated world and do not alter any subsequent draw. **Pairing semantics = the arrival timestamp/assignment/attribute sequence is the paired demand realization; the admitted set may differ across candidates (that difference — throughput, spillback — is the treatment effect being measured).**
- Scope note: pairing is valid because O1's sweep varies *only the signal plan* (green splits/phase durations); demand config is frozen for the whole sweep. Pairing claims never span different demand configs or different control types.
- Worker distribution: workers *regenerate* the demand stream from `(S, r)` rather than receiving traces — zero payload, and pairing is proven by construction: every run returns a `spawnDigest` (rolling integer hash over the arrival sequence); the harness asserts all candidates in a rep produce identical `spawnDigest` (a runtime proof of pairing, reused by Q1).

Rejected alternatives: (2) adds payload plumbing and a second code path while being *weaker* than deterministic regeneration (still needs the same pure generator to build the trace); (3) a single interleaved stream is fragile — any change in draw order (e.g., a new behavior draw) silently re-correlates everything, and interleaving makes "arrival stream independent of control state" impossible to state locally.

### PRNG choice: sfc32 (primary source verified), with exact reference implementation

**Why sfc32 over xoshiro128\*\*:** 32-bit state words map 1:1 to JS numbers (`|0`, `Math.imul`) — no BigInt, no 64-bit splitting, ~few-ns-per-draw in practice; PractRand's own docs score it top-tier for its size ("fastest of the recommended RNGs… pros: fast, small; cons: none"); PractRand flags it `ENDIAN_SAFE` (byte-order-independent output) and its 2^128 state / ~2^127 average period is astronomically beyond our needs (≤ ~10^6 draws per rep). xoshiro128\*\* is equally acceptable quality-wise (verified below) but the 64-bit-style seeding guidance (SplitMix64) is clumsy in JS at 32 bits; either passes every test we could run, so the tiebreaker is JS-native 32-bit ergonomics.

Reference implementation (verified against PractRand source; note JS uses `>>>`/`Math.imul` to get uint32 semantics):

```ts
// state a,b,c,counter as uint32 (Uint32Array[4]); constants per PractRand v4
function sfc32Next(s: Uint32Array): number {          // returns uint32
  const t = (s[0] + s[1] + s[3]) | 0;                 // tmp = a + b + counter++
  s[3] = (s[3] + 1) | 0;
  s[0] = s[1] ^ (s[1] >>> 9);                         // a = b ^ (b >> RSHIFT=9)
  s[1] = (s[2] + ((s[2] << 3) | 0)) | 0;              // b = c + (c << LSHIFT=3)
  s[2] = (((s[2] << 21) | (s[2] >>> 11)) + t) | 0;    // c = rotl(c,21) + tmp
  return t >>> 0;
}
// float: (sfc32Next(s) >>> 0) / 4294967296  → [0,1)
```

Seeding: PractRand `seed(Uint64 s)` sets a=0, b/c = seed halves, counter=1, then **12 warmup iterations**; for 4-word JS-style seeding use `(a,b,c,counter=1)` from the H32 derivations, then ≥ 12 warmup calls. `Math.random()` is never used (spec: implementation-defined algorithm).

### Evidence — Part B

- **PractRand source (primary), file `src/RNGs/sfc.cpp`** (Chris Doty-Humphrey; mirror MartyMacGyver/PractRand @ master, retrieved 2026-08-27; original distribution: practrand.sourceforge.net / sourceforge.net/projects/pracrand): `raw32()` uses `enum {BARREL_SHIFT = 21, RSHIFT = 9, LSHIFT = 3}` ("good sets include {21,9,3},{15,8,3}"); `seed(Uint64)` comment: "a = 0; //a gets mixed in the slowest", `counter = 1`, 12 warmup calls.
- **PractRand docs (primary), `doc/RNG_engines.txt`:** "sfc64 / sfc32 / sfc16 — The sfc* RNGs are the fastest of the recommended RNGs and one of the smallest. The 32 and 64 bit variants have no known drawbacks"; recommendation table: `sfc32  quality 3*** speed 5***** … 16 bytes "best speed"`; per-generator notes: "sfc32 (v4) … empirical: 5 - passed all tests; cycle: 4 - avg ~ 2**127 (min >=2**32)…; states: 3 - 2**128"; "I wrote this algorithm." (author = Doty-Humphrey). `include/PractRand/RNGs/sfc32.h`: `FLAGS = FLAG::ENDIAN_SAFE | FLAG::USES_SPECIFIED`, `OUTPUT_BITS = 32`.
- **xoshiro128\*\* (verified alternative), Vigna/Blackman primary page + code** (https://prng.di.unimi.it/ and https://prng.di.unimi.it/xoshiro128starstar.c, public domain, "Written in 2018 by David Blackman and Sebastiano Vigna", retrieved 2026-08-27): scrambler `result = rotl(s[1] * 5, 7) * 9`; state 4×uint32, nonzero; jump constants (2^64-equivalent) `0x8764000b, 0xf542d2d3, 0x6fa035c3, 0x77f2db5b` for "2^64 non-overlapping subsequences"; long-jump (2^96) `0xb523952e, 0x0b6f099f, 0xccf5a0ef, 0x1c580662`. Site: "All 32-bit generators pass all tests we are aware of, with the exception of linearity tests… for xoshiro128+ and xoroshiro64*" (i.e., not the \*\* scrambler). Note the source-file comment that v1.0 mistakenly used s[0] — pin the current file if ever adopted.
- **Seeding guidance (Vigna, splitmix64.c, public domain 2015):** next(): `z = (x += 0x9e3779b97f4a7c15); z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9; z = (z ^ (z >> 27)) * 0x94d049bb133111eb; return z ^ (z >> 31);` — "a very fast generator passing BigCrush"; Vigna's xoshiro page: "We suggest to use SplitMix64 to initialize the state of our generators." Our 32-bit `H32` derivation follows the same construction (odd increment + alternating xor-shift/multiply) at 32-bit width, implemented with `Math.imul`.
- **Structured clone for payloads/results — MDN** (Web Workers API / Structured clone algorithm, last modified 2025-06-29): ArrayBuffer, TypedArray, DataView, plain objects are supported and deep-copied; functions/DOM nodes throw `DataCloneError`; transfer list moves without copy. All cross-thread numbers in our design are integers or fixed-point, so cloning is exact.

---

## Part C — Determinism rules & run-hash (Q1)

### The language-level facts (ECMA-262, verified against the tc39.es draft — "ECMAScript® 2027 Language Specification", 18th edition, retrieved 2026-08-27)

- Number is IEEE 754-2019 binary64: "The Number type has exactly 18,437,736,874,454,810,627 (that is, 2^64 − 2^53 + 3) values, representing the double-precision floating point IEEE 754-2019 binary64 values…" (§6.1.6.1).
- Spec term: "An implementation-approximated facility is one that defers its definition to an external source while recommending an ideal behaviour… Some mathematical operations, such as `Math.exp`, are implementation-approximated." (§4.2)
- **Engine-variant (implementation-approximated) — each ends "Return an implementation-approximated Number value representing…"**: `Math.acos, asin, atan, atan2, cbrt, cos, cosh, exp, expm1, hypot, log, log1p, log10, log2, sin, sinh, tan, tanh` (§21.3.2.x), and — via delegation — **`Math.pow`**: "Return Number::exponentiate(base, exponent)" where §6.1.6.1.3 says it "returns an implementation-approximated value representing the result of raising base to the exponent power."
- **Deterministic (exact/𝔽-rounded, engine-independent)**: `+ − × / %` (IEEE ops), `Math.sqrt` — "Return 𝔽 (the square root of ℝ (n))" i.e. correctly rounded — plus `abs, floor, ceil, round, trunc, sign, min, max, fround`, all bitwise ops / `Math.imul` / `clz32` (via ToInt32, exact). **`Math.hypot` is implementation-approximated but `Math.sqrt(x*x + y*y)` is not** — write the latter.
- `Math.random`: "chosen randomly or pseudo randomly… using an implementation-defined algorithm" — banned in sim core.
- Iteration order: `Map.prototype.forEach` callback runs "for each key/value pair present in the Map, **in key insertion order**"; `Set.prototype.forEach` "in **value insertion order**"; Set "must be implemented using either hash tables or other mechanisms that… provide access times that are sublinear" — observable order is still insertion order, so Map/Set iteration is deterministic *if insertion order itself is deterministic*.
- Wall clock / scheduling: `Date.*`, `performance.now()`, promises/microtask timing are host-driven — sim core must be a pure function of (state, tick) so none of these can influence it.

### Recommendation (c): the determinism rulebook + run-hash definition

**Rulebook for `src/sim/` (enforced by lint-of-record in code review + Q1 soak):**

1. Sim state advances only in the fixed-timestep update; everything is a pure function of (previous state, tick, seed). No reads of `Date`, `performance.now`, `Math.random`, `requestAnimationFrame` timing, or microtask ordering inside sim.
2. Numeric ops in sim core: IEEE-exact set only (`+ − × / %`, comparisons, bitwise, `imul/clz32`, `sqrt, abs, min, max, floor, ceil, round, trunc, sign, fround`). Banned: `pow, exp, log*, trig*, atan2, cbrt, hypot, sinh/cosh/tanh` — these are *render-only*. Trig for car rotation in the renderer is fine because render never feeds state or hash.
3. Spawning uses uniform-vs-threshold draws only (Part B) — no exponential inversion (`ln`).
4. Float accumulation feeding hashed values must not produce `NaN`/`±Infinity` (assert) and must be normalized against `-0` (add `+0` before quantization; `-0 + +0 → +0` under IEEE addition).
5. Entity iteration for anything state-affecting uses dense integer ids in typed arrays (index order); Map/Set permitted only where insertion order is deterministic by construction; never iterate plain-object string keys in hash-relevant code (for-in order not spec-fixed beyond integer-like keys).
6. One code module, two environments: worker and main run the identical compiled core; cross-*engine* bit-equality is not claimed (spec explicitly allows approximation differences) — Q1's bit-identical acceptance is same-browser, and the quantized hash (below) degrades gracefully if an engine-approximated op ever leaks in.

**Run-hash (committed definition):** a rolling 64-bit digest implemented as **two 32-bit lanes** mixed with `Math.imul` (no BigInt per element; BigInt only to render the final hex). Per 32-bit word `w`: `h0 = Math.imul(h0 ^ w, 0x85ebca6b)`, then `h1 = Math.imul(h1 ^ h0 ^ (h0 >>> 15), 0xc2b2ae35)`; initialize lanes from splitmix-style constants derived from the seed. Digest input order is fixed:

1. **Config digest** — canonical integer serialization of `IntersectionConfig` in a pinned field order (durations in ticks; no floats — rates as rational tick-probability numerator/denominator pairs or Q16.16 fixed point).
2. **Seed words** (S, rep index).
3. **Spawn stream digest** (`spawnDigest`) — rolling hash over arrivals in fire order: `(tick, arm, lane, turnIndex, attrWord)` — one hash shared by candidate comparisons (this *is* the pairing assertion).
4. **Per-vehicle completion record** in spawn order: `(spawnTick, departTick, stops, delayQ)` where `delayQ = floor(delaySeconds × 1024)` — Q10 fixed point, floored consistently.
5. **Checkpoint every 64 ticks**: `(aliveCount, per-arm max queue)` — catches divergence that completes with equal totals.
6. **Final metrics** quantized Q10 in a pinned field order.

**Quantization rationale:** with the IEEE-exact rulebook the floats are already bit-deterministic; Q10 quantization is defense-in-depth — one leaked engine-approximated op would have to shift a trajectory by ≥ 2^-10 s ≈ 1 sub-tick to flip the hash, so accidental violations fail loudly in soak rather than flaking per-ulp. No coarser quantization: a 1-tick delay change moves Q10 by ~1024 units — divergence detection stays sharp.

Q1 test recipe: run the same (seed, config) twice in-worker and once on main; assert equal `runHash`; run candidate A vs B same rep; assert equal `spawnDigest` but (typically) different `runHash`.

### Evidence — Part C

- ECMA-262 draft (2027 edition, https://tc39.es/ecma262/, retrieved 2026-08-27) — clause and quote-level citations inline above (§4.2; §5.2.6 Mathematical Operations exists; §6.1.6.1 Number Type; §6.1.6.1.3 Number::exponentiate; §21.3.2.x Math functions incl. sqrt/round/hypot/pow/random; §24.1/24.2 Map/Set forEach insertion-order notes).
- Structured-clone exactness for integer/typed-array payloads: MDN structured clone algorithm page (modified 2025-06-29) — deep copy of ArrayBuffer/TypedArray; supported types verified.
- sfc32/splitmix64/xoshiro primary sources as cited in Part B (all public domain — safe for zero-dep core).
- Run-hash construction (MurmurHash3-style mixing constants 0x85ebca6b / 0xc2b2ae35): adapted from MurmurHash3's public-domain finalizer (Austin Appleby, smhasher); constants chosen for avalanche, not cryptographic strength.

---

## Tradeoffs, risks, confidence

- **Worker pool risk — oversubscription/thermals:** mitigated by `hardwareConcurrency − 1`, capped 6; burst is only ~30s. Confidence: high.
- **Worker spawn cost unknown (unverified):** amortized over 300 runs; even 10× my reasoned estimate (~5–40ms) stays <5% of budget. Confidence: high that it's immaterial.
- **Per-tick cost assumption (0.1–0.5ms @ 150 cars headless) is unverified** — if Q2 measures worse, the harness shortens horizon via tick budget rather than breaking the ≤30s promise; candidate count is P1-tunable. Confidence: medium-high.
- **Bernoulli-per-tick arrivals instead of exact Poisson:** a modeling simplification (per-tick binomial ≈ Poisson at our rates/dt); keeps the spawn stream in exact-IEEE space. Flag for F6's rate-accuracy acceptance test ("observed rate ≈ configured"). Confidence: high.
- **Spillback-blocked arrivals change admitted set across candidates** — this is by design (pairing defined on the *arrival* realization, not admission); must be stated in O1's results copy so "same demand" claims stay honest. Confidence: high.
- **Not cross-engine bit-identical** (spec-sanctioned approximation freedom): acceptance is same-browser; Q10 quantization is the safety net. Confidence: high.
- **Vite static-literal constraint on worker options:** a real foot-gun; encoded as an implementation consequence below. Confidence: high.
- **SAB rejection** could be revisited only if a phase-2 feature needs shared mutable state (e.g., live-steering of an in-flight sweep); not warranted now.

## Implementation consequences and plan updates

- **O1:** build `SweepExecutor` interface with two implementations (`WorkerPoolSweepExecutor` default; `TimeSlicedSweepExecutor` fallback); worker created with the static-literal pattern; queue of `(candidate, rep)` pairs; assert equal `spawnDigest` per rep across candidates; tick-budgeted horizon (default 2,700 ticks ≈ 45 sim-s, P1-tunable); `performance.now()` allowed in the *harness* for budgeting (never in sim).
- **F6:** implement `src/sim/rng.ts` (sfc32 + H32 derivations, verified against the PractRand reference constants; unit test: first outputs for known seeds — snapshot from the reference implementation); spawner = per-arm per-tick Bernoulli with virtual entry queues; all draws logged into `spawnDigest` order; no `Math.random`, no `ln`.
- **Q1:** determinism suite = re-run in worker + main ⇒ identical `runHash`; pairing test via `spawnDigest`; soak (≥10k ticks, ≥3 configs) hashes every run and diffs; lint/review checklist codifying the IEEE-exact op whitelist (render-only boundary: banned Math functions allowed only under `src/render/`).
- **Plan updates:** none structural — O1 acceptance already encodes ≤30s / ≥55fps / identical-ranking; this record fixes the architecture under them. F6's acceptance ("observed rate ≈ configured") should be evaluated against the Bernoulli arrival process (tolerance covers the binomial-vs-Poisson delta, negligible at dt=1/60s).
- Docs: this file is the R2 disposition; production may reference it in production-log when evidencing X1's determinism criterion.
