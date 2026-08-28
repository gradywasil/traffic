# Plan — Traffic Intersection Flow Simulator

Source of truth for task status and dependencies. Scope: docs/ultron/town-hall.md (approved 2026-08-27).
Pipeline: town-hall ✅ → plan-it-out (this artifact) → deep-research-supreme → production-supreme.
Budget: 15 tasks planned; 20-dispatch run cap leaves 5 slots for retries.

## Fixed by scope (do not re-litigate)

TypeScript + Vite; no UI framework; Canvas 2D; real DOM inputs; zero runtime deps in core (charting lib only if R3 commits one); fixed 4-way intersection; per-arm lanes 1–3 with turn designations; intersection-level control (signal fixed-time plan OR all-way stop); control-delay headline metric; FIFO + left-yield stop semantics; edit-while-running; 0.5–4× speed; deterministic seeded sim; paired-seed optimizer; desktop evergreen latest-2; session-only; no backend/persistence/telemetry.

## Committed research decisions

All three delegated research questions are RESOLVED and committed 2026-08-27; auto-approved (ultron-supreme) per pipeline. Research-blocked tasks (F4, F5, O1) unblock at production entry.

- **R1 — traffic micro-model (blocks F4, F5):** RESOLVED. Guarded IDM car-following (discrete no-overlap via safe-speed caps + terminal gap clamp), claim-based conflict-point arbitration (Dresner–Stone lifecycle; signal and stop-sign as grant gates), NEMA-lite 2–4 phase fixed-time ring, influence-zone free-flow baseline. Evidence: research/track-a-traffic-micro-model.md
- **R2 — execution & determinism (blocks O1):** RESOLVED. Dedicated worker pool behind a `SweepExecutor` interface (time-sliced fallback), sfc32 PRNG with H32-hashed per-rep/per-arm sub-streams and state-independent Bernoulli arrivals, IEEE-exact-op determinism rulebook + dual-lane `Math.imul` run-hash over Q10-quantized logs. Evidence: research/track-b-execution-determinism.md
- **R3 — charting (informs U3):** RESOLVED. Hand-rolled Canvas 2D chart, no charting dependency. Evidence: research/track-c-charting.md

## Tasks by role

### Frontend — simulation core

**F1 — Scaffold & fixed-timestep loop** · small · `completed`
- Outcome: Vite+TS app boots; canvas world ticking; fixed-timestep update + interpolated render; FPS meter; Vitest wired.
- Journey/state: enables all; running state from minute one.
- Deps: none. Parallel: none (first).
- Files: `index.html`, `src/main.ts`, `src/loop.ts`, `src/state/`, `vitest.config.ts`.
- Acceptance: `npm run dev` shows 60fps meter; a unit test proves accumulator behavior (e.g., 2 updates at 32ms gap).
- Risks: none material.

**F2 — Config model, presets & validation** · small · `completed`
- Outcome: typed `IntersectionConfig` (arms, lanes 1–3, per-lane designations, spawn rates, turn mix, control type, signal plan), 3 presets (light/balanced/gridlock-risk), validation + sane defaults.
- Deps: F1. Parallel with: U1 prep.
- Files: `src/config/`, `src/presets/`.
- Acceptance: unit tests — invalid configs rejected; each preset round-trips; presets have distinct spawn pressure.
- Risks: preset values are placeholders pending tuning (P1).
- Research commitments (R1 §9, §3.1): add `leftMode` per axis (default: protected iff axis has a dedicated left lane), `cycleLength` (presets 50/60/80 s), global `dt = 0.1`, per-arm cruise speed, and a model-params block defaulting to track A constants (v_c=13.9 m/s, T=1.1 s, a=1.3, b=2.0, s0=2.0 m, delta=4, len=5.0 m, b_e=6.0, s_min=0.5 m, a_lat=1.7 m/s²).

**F3 — Geometry & path generation** · medium · `completed`
- Outcome: from config, generate lane polygons, entry/exit waypoints, per-turn smooth paths through the box, per-path free-flow length (baseline input for F7), stop-line positions.
- Journey: design; everything renders/simulates on these paths.
- Deps: F2. Parallel with: F4 research wait.
- Files: `src/geom/`.
- Acceptance: unit tests — every (arm, lane, turn) designation maps to a valid path; free-flow length > 0 for all; geometry fits 1280×720 canvas.
- Risks: geometry constants (arm length, lane width) become visual-design inputs (P1).
- Research commitments (R1 §9, §6.1): per path also output turn radius R_p, v_t(p), footprint-padded conflict-zone list per movement pair (crossing + merge), entry/exit gate positions (U = v_c²/(2b) + v_c·dt + 2 m; D = (v_c² − v_t²)/(2a) + 2 m), and closed-form FF(p); geometry constraints: approach arm ≥ U + queue storage (~50 m + storage), exit arm ≥ D; acceptance "free-flow length > 0" now means FF(p) computable and > 0.

**F4 — ECS store, car entity, car-following** · medium · `completed`
- Outcome: ECS-style store (entities/components: transform, path-progress, kinematics, route); cars follow assigned paths using the R1-chosen car-following model with leader detection per lane/path.
- Deps: F3, R1 resolved. Parallel with: U2.
- Files: `src/sim/` (store, systems).
- Acceptance: unit test — single car on empty path traverses at cruise speed, never exceeds kinematic limits; deterministic given seed; 150 cars update < 4ms/tick on mid-range laptop.
- Risks: R1 model complexity; keep model swappable behind one interface.
- Research commitments (R1 §3): Guarded IDM — IDM desired acceleration + ballistic integration at dt = 0.1 s + Krauss-style safe-velocity/headway caps (v_safe, v_headway) + terminal gap clamp; safety by front-to-back induction; leader rule incl. virtual leaders at stop line/denied conflict zones; yellow dilemma-zone rule (enter only if v²/(2b) > distance to stop line); clamp-fire counter exposed and asserted 0 in normal presets; §3.1 constants: v_c=13.9 m/s, T=1.1 s, a=1.3, b=2.0, s0=2.0, delta=4, len=5.0, b_e=6.0, s_min=0.5, a_lat=1.7.

**F5 — Intersection control & arbitration** · medium (split if overrun) · `completed`
- Outcome: signal controller (fixed-time phase plan, per-phase green/yellow/all-red, editable durations) + all-way stop logic (full stop, FIFO departure order, right tiebreak, left yields oncoming) + in-box conflict arbitration per R1 scheme with a hard no-overlap invariant.
- Journeys: design, tune, compare control types.
- Deps: F4. Parallel with: U2.
- Files: `src/sim/control/`.
- Acceptance: unit tests — phase timing exact; FIFO order respected; no two cars' footprints ever intersect in randomized soak test (≥10k ticks, seeded).
- Risks: hardest correctness problem — this is where the split option lives (signal controller | stop+arbitration).
- Research commitments (R1 §4–§5): claim-based conflict-point reservation with Dresner–Stone-style lifecycle (APPROACH→PENDING→CLAIMED→IN_BOX→CLEARED; release only after rear bumper clears last conflict zone + margin); grant gates = control authority + zone exclusivity + deterministic worst-case left-yield gap test (τ_clear = 4.0 s default) + exit headroom; FIFO tickets in stop-line-arrival order, ties by arm order (N, E, S, W) then lane index; stop-sign grants only to stopped cars with right tiebreak for simultaneous stops; signal = NEMA-lite 2–4 phase sequential ring ([NS protected left?] → NS thru/right → [EW protected left?] → EW thru/right), protected-left phase per axis iff dedicated left lane, fixed-time (no phase skipping), yellow/all-red computed from geometry (y = 1.0 + v_c/(2·3.0) s; all-red = (W + len)/v_c) and never swept; integer-second green splits feed O1.

**F6 — Spawner & seeded RNG** · small · `completed`
- Outcome: per-arm Poisson-style spawning from rates + turn mix; single seeded PRNG stream design supporting paired-seed runs (foundation for O1); despawn at exit with trip data handoff to F7.
- Deps: F4. Parallel with: F7 prep.
- Files: `src/sim/spawn.ts`, `src/sim/rng.ts`.
- Acceptance: same seed ⇒ identical spawn sequence (test); observed rate ≈ configured rate within tolerance over 10 sim-minutes.
- Risks: RNG stream architecture must satisfy R2 conclusions; keep isolated.
- Research commitments (R2 Part B): sfc32 PRNG (PractRand v4 constants, ≥12 warmup calls) in `src/sim/rng.ts` with H32 (pure Math.imul/xor/shift) sub-streams — repSeed = H32(S, REP_TAG, r), armSeed[a] = H32(repSeed, ARM_TAG, a), separate attrSeed; state-independent spawn schedule: one uniform draw per arm per tick, arrival iff u < λ_arm·dt, turn/route/attributes drawn at fire time (no ln, no Math.random); spillback-blocked arrivals held in per-lane virtual entry queues outside the simulated world; all draws logged in spawnDigest order; rate tolerance covers the binomial-vs-Poisson delta.

**F7 — Metrics engine** · medium · `completed`
- Outcome: per-car control delay (actual − free-flow, using F3 baselines), stopped-time, throughput (veh/h), max queue per arm/lane; rolling-window aggregation feeding display + optimizer; stats reset on config change.
- Journeys: tune, optimize; success measures live here.
- Deps: F6. Parallel with: U3 prep.
- Files: `src/sim/metrics/`.
- Acceptance: unit tests — free-flow car has ~0 delay; fully stopped car accumulates ≈ stopped-time; rolling window drops old samples; known-script scenario produces hand-computable numbers.
- Risks: free-flow baseline correctness is the honesty risk pinned in the brief.
- Research commitments (R1 §6.1): influence-zone free-flow baseline — entry gate U = v_c²/(2b) + v_c·dt + 2 m upstream of stop line, exit gate D = (v_c² − v_t²)/(2a) + 2 m past turn arc; v_turn(p) = min(v_c, sqrt(a_lat·R_p)) with a_lat = 1.7 m/s²; delay = (t_exit − t_entry) − FF(p) using front-bumper gate-crossing times (free-flow car ∈ [−dt, +dt] by construction); aggregates: rolling-window mean headline plus per-arm means, stopped-time (v < 0.5 m/s in zone), throughput (veh/h at exit gate), max queue per arm/lane; spillback saturation caveat surfaced in overlay docs.

**F5b — Approach barrier gating fix** · small · `completed` · inserted adjustment 2026-08-27 (task-level, ultron-supreme)
- Outcome: honest control delay. The stop-line barrier is erected only from the request line onward (claim phase PENDING), so a car with current movement authority (green/proceed) and no conflicting claims is not braked from afar by IDM's long-range interaction term; cars that must stop (red, ungranted stop-sign, conflicting claims) still get the barrier with the R1 §4.2 request-distance lead (comfortable stopping distance + one tick + margin — the same stopping-sight logic gate 5's safety argument rests on).
- Journey: tune/optimize (delay-headline honesty).
- Deps: F5, F7 (both completed + verified). Parallel with: none — fix-forward on the T-F7-confirmed approach-barrier delay inflation.
- Files: `src/sim/control/claims.ts` (+ regression tests in `src/sim/control/control.test.ts`, `src/sim/metrics/metrics.test.ts`).
- Acceptance: lone green through car ≤ 0.05 s control delay (measured 0.002 s; was 2.102 s / 1.502 s spawned at the entry gate); unimpeded turn cars at free-run levels (0.336/0.286 s; was ~0.7–1.0 s inflation); F5 soaks (all three control modes, 10k ticks) + F6 spawn soaks green with zero footprint overlaps and identical-hash determinism; no-overlap invariant preserved (clamp 0, ungranted line crossings 0).
- Risks: none material — the gate rides the existing APPROACH→PENDING request-distance rule (not a new constant); red-stop peak decel rises 1.83 → 2.79 m/s², inside the comfortable-to-emergency bracket (b = 2.0, b_e = 6.0), clamp never fires.

### Frontend — UI & rendering

**U1 — Canvas renderer** · medium · `completed`
- Outcome: draw road surface, lane markings, turn arrows, stop lines, signal heads with state colors, stop signs, cars (oriented, colored per behavior state: cruise/queue/yield). Camera fits fixed geometry.
- Journey: first-run impression.
- Deps: F3 (cars drawn from store once F4 lands; build with debug entities meanwhile). Parallel with: F4–F6.
- Files: `src/render/`.
- Acceptance: visual inspection against preset; no layout overflow at 1280×720; render pass < 4ms at 150 cars.
- Risks: polish is P1; keep primitive-but-clear.

**U2 — DOM control panel & canvas interactions** · medium · `completed`
- Outcome: real-DOM controls (sliders/buttons/selects, labeled, keyboard-reachable): spawn rates, turn mix, lane count/designations via canvas click/drag on arms, control-type switch, green-duration sliders, preset picker, pause/play, speed 0.5–4×; edit-while-running with live apply + stats reset signal.
- Journeys: design, tune, compare.
- Deps: F2, F3, U1. Parallel with: F5–F7.
- Files: `src/ui/`.
- Acceptance: every config field editable from UI; changes apply without restart; all controls focusable + labeled (accessibility stance); unit test for panel→config binding.
- Risks: interaction scope creep — no free-form dragging beyond the agreed model.

**U3 — Metrics display: chart + text stats + engineering overlay** · medium · `completed` · informed by R3
- Outcome: rolling-window avg-wait line chart (~1Hz), headline numeric readout as text, engineering overlay mode (per-arm bars, stopped-time, throughput, max queue, parameter read-out).
- Journeys: tune, optimize feedback loop.
- Deps: F7, U1. Parallel with: O1.
- Files: `src/ui/chart/`, `src/ui/overlay/`.
- Acceptance: chart updates ~1Hz without frame drops; overlay numbers match metrics engine unit fixtures; toggle persists in-session.
- Risks: R3 lib choice; default hand-rolled.
- Research commitments (R3): hand-rolled canvas chart (~150–250 LOC line chart + 50–80 LOC per-arm bars), no charting dependency; ring buffer keyed by sim-time with window trim, nice-tick y autoscale with min-range clamp (zero-range edge), fixed x window with mm:ss labels, 1 Hz render cadence outside the sim frame loop; per-arm bars as plain rects in `src/ui/overlay/`; share/extract the DPR + resize utility with U1's renderer; `package.json` stays zero runtime dependencies.

### Frontend — optimizer

**O1 — Paired-seed sweep harness** · medium · `completed` · delivered 2026-08-27, verified PASS 2026-08-27 (research R2 resolved 2026-08-27)
- Outcome: headless simulation runner per R2 architecture; grid sweep over green splits (configurable candidate set); paired-seed evaluation (same demand realizations across candidates); ranked results by avg control delay. DELIVERED 2026-08-27 — see production-log T-O1 entry (executors result-identical by test; default sweep measured; worker chunk proven via smoke build pending O2 wiring it into the main graph).
- Journey: optimize.
- Deps: F7, R2 resolved. Parallel with: U3.
- Files: `src/optimizer/`.
- Acceptance: default sweep (≈60–100 candidates × 3 reps) completes ≤30s; UI thread stays ≥55fps during sweep on mid-range laptop; identical re-run produces identical ranking (test).
- Risks: compute budget; candidate set sizing is P1-tunable.
- Research commitments (R2 Parts A–B, R1 §5.2): worker pool clamp(hardwareConcurrency − 1, 2, 6) via Vite module workers (`new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`, options as static literals) behind a `SweepExecutor` interface with time-sliced fallback (~4 ms/frame budget when live); per-rep shared seeds regenerated in-worker, message out = {runId, spawnDigest, runHash, metrics}; assert identical spawnDigest across candidates per rep; horizon ≈ 45 sim-s per rep, tick-budgeted (shorten gracefully, never drop pairing); candidates = integer-second green splits, g_min = 5 s, Σg_i = C − Σlost at fixed cycle, two-stage grid for 4-phase (5 s coarse, then 1 s within ±3 s of top-3); ranking = mean control delay over paired-seed reps.

**O2 — Optimizer UI & plan application** · small · `completed` · delivered 2026-08-27, verified PASS 2026-08-27 (deps O1, U2, U3 completed)
- Outcome: run-sweep button, progress indication, results panel (ranked plans vs current), one-click apply that mutates the signal plan live (counts as config change → stats reset).
- Journey: optimize.
- Deps: O1, U2, U3.
- Files: `src/ui/optimizer/`.
- Acceptance: apply changes phase durations measurably; applied plan survives config inspection; no dead UI states while sweep runs.
- Risks: minor.
- DELIVERED 2026-08-27 — see production-log T-O2 entry (OptimizerModel state machine idle→running→done/cancelled/failed with throttled progress; SweepService = runDefaultSweep + measured current-plan baseline, worker pool with runtime time-sliced fallback; apply via new `PanelModel.applySignalPlan` — one plan-only config-change, live scope + metrics reset asserted; npm test 453/453, worker chunk emitted in dist via the real import).

### QA

**Q1 — Integration tests: determinism, no-overlap, preset signatures** · medium · `completed` · delivered 2026-08-27, verified PASS 2026-08-27
- Outcome: automated suite — same seed+config ⇒ bit-identical run hash; randomized soak with overlap assertion; presets produce statistically distinct delay signatures over fixed horizon.
- Deps: F7, F5, F6. Parallel with: U-track.
- Files: `tests/`.
- Acceptance: suite green in CI-equivalent (`npm test`); soak covers ≥3 configs.
- Risks: flaky timing if determinism leaks (wall-clock reads) — strict sim-time only.
- DELIVERED 2026-08-27 — see production-log T-Q1 entry (full R2 Part C run-hash record on F4's DualLaneDigest; 4 configs × 2×2000-tick bit-identity + adjacent-seed/config-replay teeth; 10k-tick soaks ×4 control modes with the real spawner — 0 footprint intersections; preset signatures disjoint at the pinned 120 s horizon; leak scan 35 files). Verified PASS 2026-08-27 by independent verifier — preset margins reproduced with fresh seeds (12.08/7.19 s at 120 s, disjoint), mutation probes confirm determinism teeth at record resolution, soak confirmed geometry-footprint-based; one non-blocking limitation logged (leak-scan bracket-notation blind spot). Milestone 3 "Numbers honest" complete.
- Research commitments (R2 Part C): IEEE-exact-op whitelist in sim core (+ − × / %, comparisons, bitwise/imul/clz32, sqrt, abs/min/max/floor/ceil/round/trunc/sign/fround; pow, exp, log*, trig*, atan2, cbrt, hypot banned — render-only under `src/render/`); sim = pure function of (state, tick, seed), no Date/performance.now/Math.random; run-hash = Math.imul dual-32-bit-lane digest (mixers 0x85ebca6b / 0xc2b2ae35) over Q10-quantized event logs in fixed order (config digest, seed words, spawnDigest, per-vehicle completion records with delayQ = floor(delay × 1024), 64-tick checkpoints (aliveCount, per-arm max queue), final metrics), −0 normalized, NaN/±Infinity asserted; tests: same seed+config in worker and main ⇒ identical runHash, spawnDigest pairing assertion across candidates, soak ≥10k ticks across ≥3 configs.

**Q2 — Performance & acceptance harness** · medium · `completed` · delivered 2026-08-27, verified PASS 2026-08-27
- Outcome: scripted perf run — 150+ concurrent cars, tick+render budget measured (target ≤16.6ms, warn < 12ms headroom on mid-range laptop); sweep-time measurement ≤30s; evidence recorded for X1. DELIVERED 2026-08-27 — see production-log T-Q2 entry (browser benchmark page `benchmark.html` + `src/benchmark-main.ts` emitted by `npm run build`, NOT wired into the app UI, runs the full app pipeline at a guaranteed ≥150-car stress load and the concurrent default sweep; headless node proxies measured on the build machine; acceptance-evidence scaffold at `tests/perf/EVIDENCE.md` with X1 slots). Verified PASS 2026-08-27 by independent verifier — gated wall bars unweakened and passing standalone (14.89/14.91 s ≤ 30 s), suite skips-not-deletes (488 | 4 skipped twice), headless numbers reproduced (verifier probe: sim tick median 0.183/p99 0.466 ms, draw-list 0.162/0.586 ms — same magnitudes; one non-blocking note: the ≥150 floor is seed-conditioned, pinned at the harness's seed 1 where it holds every tick).
- Deps: O1, U3, F7. Late.
- Files: `tests/perf/`.
- Acceptance: measured numbers recorded in production-log; targets met or deviation documented.
- Risks: machine variance — measure on build machine, note hardware.

### Design & accessibility

**D1 — Visual polish & accessibility audit** · small · `completed` · delivered 2026-08-27, verified PASS 2026-08-27 (deps U2, U3 completed)
- Outcome: coherent palette/typography on canvas + panel; contrast check; audit that all interactive controls are DOM, labeled, keyboard-operable; headline stats exposed as text (already U3 — verify end-to-end).
- Deps: U2, U3.
- Files: `src/ui/styles/`, canvas colors.
- Acceptance: audit checklist passes; no canvas-only interactive control.
- Risks: P1 visual details settled here.
- DELIVERED 2026-08-27 — see production-log T-D1 entry (centralized palette `src/ui/styles/palette.ts` + programmatic WCAG audit `palette.test.ts` — 59 new tests, every ratio printed; canvas polish: signal heads +20% with 3.4:1 housing stroke, arrow stroke 1.6 px, car outline α 0.65, chart grid #384359 + 1.8 px line, selected-arm stroke 3.6:1; a11y fixes: visually-hidden h1 + metrics h2, overlay headings h4→h3, mono stack unified; a11y audit documented — all controls native+labeled+keyboard, canvas click = enhancement, optimizer aria-live verified; D1-CHECKLIST.md for X1's human pass; npm test 547+4 skipped, tsc 0, eslint 0, build green). Verified PASS 2026-08-27 by independent verifier — all 43 logged ratios reproduced with the verifier's own from-spec WCAG implementation (every delta ≤ 0.005, bar ±0.1); palette-centralization sweep clean (zero color literals in src/render + src/ui outside `src/ui/styles/`; renderer.ts:201 `'red'` is a SignalColor state key, not a color); a11y walk confirmed every control native + explicit htmlFor + canvas-free edits (arm buttons → same `model.select(arm)` path as canvas click); draw-list suites (render.test.ts, untouched by D1 per mtime) green against the constants-only renderer edits; worker hash unchanged. Milestone 5 "Shipped bar" pending X1.

### Integration

**X1 — Final acceptance run-through** · medium · `completed`
- Outcome: walk every brief acceptance criterion end-to-end on the built app; record evidence in production-log.md; document deviations.
- Deps: all.
- Acceptance: every criterion in town-hall.md §"Success measures" has evidence or a documented, user-visible deviation.
- Risks: late surprises → fix-forward small tasks within budget.
- DELIVERED 2026-08-27 — see production-log T-X1 entry (real-browser pass on the built app via `npm run preview`: main-app walk — console clean, edit-while-running, pause/speed, overlay, canvas pick, optimizer run/apply, three preset chart signatures; benchmark page ×4 runs — post-harness-fix all three bars PASS twice: 59.4/59.5 fps at 157–161 cars, sweep 2.44/2.02 s at 60 fps, in-browser worker-pool determinism cross-check identical; one harness fix disclosed: benchmark warmup early-exit; EVIDENCE.md slots filled; 11 screenshots + results JSONs in docs/ultron/; D1-CHECKLIST human pass remains for the user). Verified PASS 2026-08-27 by independent verifier — all four commands reproduced green post-fix (547 passed | 4 skipped, tsc 0, eslint 0, build with identical chunk hashes); independent Chrome/CDP reproduction: main app 0 console/0 exceptions with world pixels advancing and chart/headline updating, one fresh benchmark run all three bars PASS at alive min 157–167 with the sweep determinism triplet identical (g:5+26+5+7, 0.632 s — matching both worker runs), gridlock-risk optimizer ordering re-confirmed (best 1.2 s vs current 6.3 s); warmup fix read as load-unflattering (full 1500-tick warmup mirroring stress-config.test.ts's every-tick guarantee, extend-once guard only fires below floor); screenshots authenticated by palette-signature pixel analysis incl. a cross-check against the verifier's own live capture; one non-blocking note: three cosmetic tail-statistic cells in the worker's benchmark table transcription-slipped vs the shipped JSONs (values corrected in the verifier entry; no bar affected). Milestone 5 "Shipped bar" complete.

## Dependency-ordered task index

| # | ID | Deps | Parallel-friendly with |
|---|----|------|------------------------|
| 1 | F1 | — | — |
| 2 | F2 | F1 | — |
| 3 | F3 | F2 | R-track |
| 4 | F4 | F3 + **R1** | U1, U2 |
| 5 | F5 | F4 | U2 |
| 6 | F6 | F4 | F7 prep, U3 prep |
| 7 | F7 | F6 | O1 prep, U3 |
| 7a | F5b (inserted 2026-08-27) | F5, F7 | — |
| 8 | U1 | F3 | F4–F6 |
| 9 | U2 | F2, F3, U1 | F5–F7 |
| 10 | U3 | F7, U1 + R3 advisory | O1 |
| 11 | O1 | F7 + **R2** | U3 |
| 12 | O2 | O1, U2, U3 | — |
| 13 | Q1 | F5, F6, F7 | U-track |
| 14 | Q2 | O1, U3 | D1 |
| 15 | D1 | U2, U3 | Q2 |
| 16 | X1 | all | — |

Statuses initialized `pending`. R1/R2 resolutions arrive from deep-research before production starts, so research-blocked tasks unblock at production entry.

## Milestones

- **M1 — World visible** (F1–F3 + U1): a configurable intersection renders from preset; early exposure of geometry/layout assumptions.
- **M2 — Cars obey** (F4–F6): cars drive, queue, obey signals/signs, never overlap; determinism testable.
- **M3 — Numbers honest** (F7 + U3 + Q1): live rolling chart + engineering overlay; determinism/no-overlap proven automatically.
- **M4 — Optimizer** (O1–O2): sweep runs, ranks plans, applies best within budgets.
- **M5 — Shipped bar** (Q2 + D1 + X1): acceptance criteria evidenced in production-log.

## Handoff section

- **Build order:** critical path F1→F2→F3→(R1)→F4→F5→F6→F7→U3→O1→O2; U1/U2 ride parallel from F3; Q1 lands after F7; Q2/D1/X1 close.
- **Fixed by scope:** see §"Fixed by scope".
- **Delegated to deep-research:** R1 (blocking F4/F5), R2 (blocking O1), R3 (advisory to U3).
- **Assumptions that return to Town Hall if changed:** intersection-level control model (P2); free-flow baseline per turn is computable and stable; fixed arm geometry at 1280×720; preset tuning values remain P1 (not scope).
- **Approval needed before research begins:** user approval of this plan (the one plan review gate); after that, ultron-supreme auto-approves research dispositions and production tasks, halting only on the halt list.
