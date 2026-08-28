# Town Hall — Scoping Brief

Product: Traffic Intersection Flow Simulator (web app)
Status: all clusters signed off individually; final record presented to user 2026-08-27.
Pipeline: town-hall → plan-it-out → deep-research-supreme → production-supreme

## Problem statement and target users

Signal timing math is invisible — nobody can *feel* what +5 seconds of green does to a bottleneck. This tool lets a user design a 4-way intersection, watch queued traffic emerge at 60fps, and see average delay respond in real time to their tuning — then let a timing sweep confirm or embarrass them.

- **Primary users:** curious learners first (approachable surface); engineering students via the thin engineering overlay.
- **Context:** single-user, in-browser, nothing to install, nothing leaves the browser.

## Proposed MVP

Fixed 4-way intersection simulator + real-time delay chart + manual signal tuning + timing-sweep auto-optimizer.

1. **Geometry:** fixed 4-arm intersection; per-arm lane count 1–3; per-lane turn designations (left/through/right combos); per-arm spawn rate and turn mix; configured via direct manipulation on the canvas.
2. **Control:** intersection-level choice between a signalized plan (fixed-time phases, per-phase green durations user-editable) and all-way stop. All-way stop semantics: full stop, first-come-first-served departure, tiebreak yields right, left-turn yields to oncoming through traffic.
3. **Simulation:** deterministic seeded runs; cars follow plausible car-following behavior, queue, and resolve intersection conflicts without overlapping; 60fps Canvas 2D rendering.
4. **Metrics:** headline "average wait" = control delay (actual minus free-flow travel time); rolling-window line chart (~1Hz, last few sim-minutes); per-arm bars in the engineering overlay.
5. **Engineering overlay (thin, read-mostly):** control delay, stopped-time, throughput (veh/h), max queue length, model parameter read-out. No new inputs beyond learner-facing ones.
6. **Auto-optimizer:** sweeps green-split timings across candidates using paired-seed deterministic comparisons; reports ranked plans with avg delay; one-click apply. Default sweep ≤30s without frame drops.
7. **Interaction:** edit while running (live apply); pause/play; speed 0.5–4×; stats window resets on config change.
8. **Presets:** light / balanced / gridlock-risk, each with a distinct chart signature.
9. **Accessibility stance:** all controls are real DOM inputs; live stats exposed as text. Canvas itself is not made screen-reader-navigable.

## Explicit non-goals (MVP)

- Actuated / demand-responsive signals (fixed-time plans only).
- Pedestrians and cyclists — **committed phase-2 roadmap**, architecture stays extensible (ECS agent components).
- Multi-intersection networks / green waves — **committed phase-2 roadmap** (controller abstraction, routing-friendly path model).
- Crash physics (cars never overlap; collision logic prevents it, never depicts it).
- Persistence, saves, shareable URLs, backend, telemetry.
- Mobile/touch support; tablet viewing.
- Free-form road geometry; per-arm mixed control (signal on one arm, stop sign on another).
- Real-map import; calibration to a specific real intersection.

## Primary journeys and important states

- **First run:** preset loads → simulation running → chart moving; queue formation visible without reading any docs.
- **Design:** adjust lanes/designations/spawn rates live; immediate visual + chart response.
- **Tune:** change green durations → chart responds → stats window reset keeps comparisons clean.
- **Optimize:** run sweep → ranked plans vs current → apply best → observe improvement.
- **Compare control types:** switch signal ↔ all-way stop; observe delay signature change.
- **States:** running / paused / optimizing (sweep runs in background, UI stays interactive) / editing (always available, applies live).

## Success measures and acceptance criteria

- 60fps rendering with 150+ concurrent cars on a mid-range laptop.
- Chart updates ~1Hz over a rolling window; per-arm breakdown in overlay.
- Determinism: same seed + config ⇒ identical run (paired seeds used by optimizer).
- Default optimizer sweep completes ≤30s with no observable frame drops; proposes a measurably better plan on the gridlock-risk preset.
- Three presets produce visibly distinct chart signatures.
- No visual car overlap at any time.
- All controls are DOM inputs; headline stats exposed as text.

## Constraints, assumptions, dependencies, risks

**Constraints:** TypeScript + Vite; Canvas 2D; real DOM inputs; no UI framework; zero runtime dependencies in the core (charting library permitted only if research R3 commits to one); evergreen desktop browsers (latest-2), mouse + keyboard, ≥1280×720.

**Assumptions:** control model is intersection-level (one signal plan OR all-way stop) — mixed per-arm control excluded; spawn rates specified per sim-time; fixed arm geometry that fits the min viewport; "wait" per car measured against a per-turn free-flow baseline.

**Risks:**
- Stochastic noise makes the chart misleading → mitigated by rolling window, seeded determinism, paired-seed optimizer comparisons.
- Optimizer compute janks the live sim → research R2 (workers vs time-slicing).
- Shared-intersection conflict resolution is the hardest correctness problem → research R1.
- Roadmap pressure (pedestrians/networks) creeps into MVP → pinned here as out; extensibility is architectural only.
- Control-delay honesty depends on correct per-path free-flow baselines — sloppy baselines silently corrupt the headline number.
- Run budget: 20 dispatched tasks; plan must fit scope within it.

## Role perspectives

- **Product/value** — supports the tweak→watch loop as the hook; dissented that "optimization tool" risks becoming a solver that replaces learning; resolved: optimizer confirmed as *addition* to manual tuning, not replacement. Follow-up: watch that ranked plans don't bury the manual loop.
- **UX/UI** — supports direct manipulation; strongest concern was free-form editor scope-death and evaporating "aha" moments; resolved by lane-configuration model + rolling chart. Open: visual polish details → production.
- **Frontend** — supports Canvas + fixed timestep + ECS-ish store; flagged topology as the scope lever (resolved: fixed 4-way); flagged optimizer execution architecture → research R2.
- **Backend/data** — none; client-side only. Non-applicable beyond persistence decision (session-only).
- **Quality/reliability** — demanded precise wait definition (resolved: control delay headline) and determinism (accepted as acceptance criterion).
- **Security/privacy** — non-applicable; no backend, no telemetry, nothing leaves the browser.
- **Accessibility** — DOM controls + text stats in MVP; full canvas accessibility non-goal.
- **Domain accuracy (traffic engineering)** — supports qualitative correctness (queueing, spillback, starvation); pushed control delay over stopped-time (accepted); pushed FIFO+left-yield stop semantics (accepted); open: car-following model choice → research R1.

## Open-question dispositions

| Question | Owner | Blocking |
|---|---|---|
| Car-following + intersection conflict model (IDM vs simplified; conflict points, gap acceptance) | research (R1) | blocks simulation-core tasks |
| Optimizer execution architecture (workers vs time-sliced main thread; determinism needs) | research (R2) | blocks optimizer task |
| Charting approach (hand-rolled canvas vs uPlot-style lib) | research (R3) | non-blocking |
| Visual design details, preset spawn-rate values, chart axis ranges | production (P1) | non-blocking |
| Intersection-level control model (assumption above) | production (P2) — if contested, returns to town hall | non-blocking |

## Decisions with rationale and rejected alternatives

1. **Fixed 4-way topology** — focus polish on the optimization loop. Rejected: template shapes (moderate cost), free-form roads (scope-death).
2. **Layered fidelity, thin engineering overlay** — honesty without double-UI cost. Rejected: fully editable parameters (double UI), deferring entirely (chart loses credibility).
3. **Lanes + turn designations config model** — real design play, tractable geometry. Rejected: single lane per arm, free lane painting.
4. **FIFO + left-yield stop semantics** — realistic and legible. Rejected: simple rotation (teaches a fake rule), full rulebook (unverifiable by eye).
5. **Auto-optimizer in MVP; pedestrians/networks to roadmap** — user pull-in reconciled after Challenger/Advocate; all-three-in MVP contradicted fixed-4-way + manual-tuning picks, ~3× scope, exceeded run budget. Architecture stays extensible for phase-2.
6. **Control-delay headline metric** — stopped-time is gameable by slow-rolling; optimizer must target the honest metric. Layered breakdown in overlay. Rejected: stopped-time headline, user toggle.
7. **Rolling-window chart** — time-shape visible, cheap. Optimizer comparison replaces A/B snapshots. Rejected: scrub history, number+sparkline.
8. **Edit while running** — immediacy is the product. Rejected: edit/observe mode split.
9. **Acceptance bar as recommended** — 60fps@150+ cars, ≤30s sweep, deterministic, 3 presets. Rejected: relaxed (30fps/100), harder (300+/10s forces worker-first architecture).
10. **TS + Vite + no framework** — the app is a simulation with a control panel, not a document. Rejected: Preact shell, routing stack to research.
11. **Desktop evergreen only** — Rejected: tablet viewing.
12. **Dispositions table as proposed** — R1/R2 blocking; charting non-blocking; details to production.
13. **Problem & users statement confirmed as written.**

## Cluster sign-off status

- Problem & users — signed off (round 3, plain confirmation).
- MVP boundary & non-goals — signed off (rounds 1–2, incl. Challenger/Advocate on fidelity depth and scope pull-in reconciliation).
- Journeys, states, success measures & acceptance criteria — signed off (round 2, incl. Challenger/Advocate on wait metric).
- Constraints/assumptions/risks — signed off (round 3).
- Open-question dispositions — signed off (round 3).

## Handoff note for plan-it-out

Scope is frozen as above. Plan must: (a) sequence simulation-core and optimizer tasks behind research R1/R2 outcomes (deep-research runs before production in this pipeline); (b) keep architecture extensible for phase-2 items without doing any of their work (ECS components, controller abstraction, headless sim capability); (c) fit within the 20-dispatch task budget — bite-sized, verifiable tasks; (d) encode acceptance criteria as task-level verification so 60fps/determinism/sweep-budget are provable, not aspirational.
