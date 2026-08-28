# Track C — Charting: hand-rolled canvas vs library

- **Decision ID:** R3 (Track C, "charting")
- **Affected tasks:** U3 (metrics display: chart + text stats + engineering overlay) — advisory, non-blocking; minor knock-on to U1 (shared DPR/resize utility)
- **Priority:** P2 · advisory · default was hand-rolled if undecided
- **Status:** decided 2026-08-27
- **Delegation record:** deep-research track agent (ZCode), 2026-08-27. Method: primary sources only (uPlot GitHub repo/README/demos, npm registry API, unpkg dist artifacts measured locally); no spikes needed — nothing surprising emerged.

## Question

Should the U3 rolling-window average-wait chart (~1Hz update, last few sim-minutes, one line, possibly a second comparison line later) be hand-rolled on Canvas 2D, or built on a charting library — uPlot as the leading candidate, Chart.js/ECharts considered briefly to show why they are the wrong class of tool here?

## Constraints and evaluation criteria (from town-hall.md / plan.md)

- TypeScript + Vite, Canvas 2D app, no UI framework; **zero runtime dependencies in the core** — "charting library permitted only if research R3 commits to one"; the brief elsewhere: "charting library permitted only if it is *clearly better*."
- Chart: rolling-window avg-wait line, updated ~1Hz, last few sim-minutes (≈180–300 points at 1 sample/s), one line now, maybe one comparison line later. **No zoom, no brush, no tooltip, no scrub** — town-hall decision #7 explicitly rejected scrub-history.
- Per-arm bars live in the engineering overlay (trivially simple bar drawing).
- Render budget <4ms; desktop evergreen latest-2.
- Canvas expertise is already mandatory for the 60fps world renderer with 150+ cars (U1) — strictly harder than a 1Hz line chart.

Evaluation criteria: bundle cost and supply-chain surface; API/skill fit; maintenance risk; render-budget headroom; styling coherence with a hand-drawn world (P1 polish wants the chart to match the app's palette); LOC/effort and risk of the hand-rolled path; upgrade path if requirements grow.

## Options considered

1. **Hand-rolled Canvas 2D chart** (the plan default).
2. **uPlot** (leeoniya/uPlot) — the only serious library candidate: small, fast, Canvas 2D, time-series-native, MIT.
3. **Chart.js** — popular general chart lib, Canvas-based; wrong weight/class.
4. **ECharts** — full visualization grammar; massively wrong class.

## Evidence (primary sources; all sizes measured 2026-08-27 from unpkg artifacts unless noted)

### uPlot — current state

| Fact | Value | Source |
|---|---|---|
| Latest version | 1.6.32 | npm registry |
| Last publish | 2025-03-14 (≈17.5 months before today) | npm registry `time` field |
| Minified size | 51,081 bytes (`dist/uPlot.iife.min.js`) — README itself claims "~50 KB min" | measured; README |
| Gzipped size | 22,004 bytes (gzip -9 of same file) | measured |
| License | MIT | npm `license`; GitHub API `license.spdx_id: MIT` |
| Renderer | Canvas 2D — README: "Canvas 2D-based chart", explicitly avoids WebGL shaders and WASM | README |
| Repo health | 10,453 stars · 459 forks · 149 open issues · not archived · created 2019-09-27 · last push 2026-04-22 (commit "avoid -0 translation") | GitHub API |
| Release cadence | 63 npm versions total; recent ≈1–2 releases/year (1.6.31 → 2024-09-28, 1.6.32 → 2025-03-14); README benchmark table dated 2023-03-11 | npm registry; releases page |
| TS types | Shipped in-package: `"typings": "./dist/uPlot.d.ts"` — 1,199 lines / 38,497 bytes, heavily commented (README: full API documented via comments in the .d.ts) | npm registry; measured |
| Perf claims (exact, README) | "interactive chart containing 166,650 data points in 25ms" cold start; "scaling linearly at ~100,000 pts/ms afterwards"; "When updating 3,600 points at 60fps, uPlot uses 10% CPU and 12.3MB RAM"; README bench table: uPlot v1.6.24 = 47.9 KB / 34 ms vs Chart.js v4.2.1 = 254 KB / 38 ms | README |
| Rolling-window API fit | Squarely in its wheelhouse — official demos: "Dynamic data update / streaming", "Sine wave stream (3,600 points lookback @ 60Hz)", plus cursor sync / zoom / tooltip plugin demos | demos index |

Interpretation: uPlot is healthy-but-in-maintenance-mode (mature, stable, alive — but 17 months since last release and a slow cadence). It is the right *class* of tool: small, canvas, time-series-first, MIT, typed. Its headline value — performance at 10³–10⁶ points and 60Hz streaming, cursor/zoom/sync interactions — solves problems this project does not have (one line, 1Hz, ≤300 points, no interactions).

### Chart.js / ECharts — wrong class (measured 2026-08-27)

- **Chart.js 4.5.1** (published 2025-10-13): `dist/chart.umd.js` = 208,518 bytes raw / **70,518 gzip** (before any plugins). Animation system + dashboard-oriented options model aimed at many heterogeneous charts; would be the app's only dep and the largest single asset. Even uPlot's own README bench tags Chart.js at 254 KB.
- **ECharts 6.1.0** (published 2026-05-19): `dist/echarts.min.js` = 1,121,883 bytes raw / **368,217 gzip**. A full visualization grammar (multiple renderers, coordinate systems, dataset pipeline). Larger gzipped than the entire traffic app will be on disk. Dismissed.

### Hand-rolled cost (honest estimate)

What a ~1Hz single-line rolling chart actually requires, and an LOC estimate per piece:

| Piece | Notes | LOC est. |
|---|---|---|
| Canvas sizing + DPR | ResizeObserver + `setTransform(dpr,0,0,dpr,0,0)`; **same utility needed by U1's world renderer** — shared, not chart-specific | 25–40 |
| Ring buffer + window trim | push (simTime, avgWait), drop samples older than window | 15–25 |
| Y autoscale with "nice" ticks | classic nice-number algorithm (1/2/5×10ⁿ); edge case: flat/all-zero data at window start needs a minimum-range clamp | 30–40 |
| X axis | fixed sim-time window → mm:ss tick labels | 15–20 |
| Grid + axis labels drawing | strokeStyle/font/textBaseline; avoid label collision on narrow widths | 40–60 |
| Line path + plot-area clip | one `moveTo/lineTo` pass; second comparison series ≈ +5 | 15–20 |
| Per-arm bars (overlay) | even simpler than the line chart: 4–8 labeled rects scaled to a max | 40–60 |
| **Total** | | **≈150–250 (line chart) + 50–80 (bars)** |

Effort: roughly half a day to a day including unit tests. Render cost: redrawing ≤300 points at 1Hz is microseconds — the <4ms budget is a non-issue; the chart can render on its own 1Hz cadence entirely outside the 60fps sim loop, which is *cleaner* than integrating a lib into the frame loop.

Real risks of hand-rolling (all one-time, all unit-testable): nice-tick edge cases (zero-range data), DPR text crispness, x-label collision at narrow widths. Nothing ongoing; no DOM flakiness beyond resize, which U1 must handle anyway.

## Recommendation and rationale

**Hand-rolled Canvas 2D chart. Do not add a charting dependency.**

Rationale:

1. **The brief's bar is "clearly better" — and uPlot is not clearly better for this chart.** One line, 1Hz, ≤300 points, no interactions. uPlot's entire differentiator (10⁵-point streaming perf, cursor sync, zoom plugins) is unexercised; what remains is 22KB gzip of capability we'd mostly idle.
2. **Zero-dep core is a signed constraint.** A dependency for one chart is exactly the kind of exception the constraint exists to prevent; 22,004 bytes gzip is plausibly comparable to our entire chart *and* overlay code (≈200–330 LOC), and would likely be the largest single module in the bundle.
3. **Canvas expertise is already sunk cost on this project.** U1 must render a 60fps world with 150+ oriented cars, signals, lane geometry — strictly harder than a 1Hz line chart. The shared DPR/resize utility comes free.
4. **Styling coherence.** P1 visual polish wants the chart to match a hand-drawn app palette; with our own canvas that's just constants, with a library it's fighting defaults.
5. **Maintenance posture.** uPlot is stable but in maintenance mode (last release 2025-03-14; ≈17 months). Buying a slow-cadence dep for an idle capability is weak even at 22KB.
6. **Per-arm bars were never a library question** — 4–8 labeled rects is trivially hand-drawn in either world.

## Tradeoffs, risks, confidence

- **What we give up:** uPlot's cursor/zoom/brush/tooltip machinery, multi-chart cursor sync, and proven high-frequency streaming — none needed for MVP.
- **Revisit trigger (the condition under which the library becomes preferable):** any future requirement for *interactive history* — zoom/brush over past windows, hover crosshair with value readout, scrubbing, or cross-chart sync — or growth in series count (e.g., per-arm lines on the main chart instead of bars). At that point uPlot is the right call (small, canvas, MIT, time-series-native) and migration is cheap because our data layer (ring buffer + window) stays library-agnostic. Note: town-hall decision #7 explicitly rejected scrub-history, so the nearest trigger is out of scope by decision.
- **Risks of the hand-rolled path:** nice-tick edge cases and initial all-zero window (mitigate: min-range clamp + unit tests on ticks/ring buffer — fits U3's existing test posture); DPR/resize handled once in shared code with U1.
- **Confidence: high** on the decision (asymmetric: adequate path is well-understood and small; library fails the "clearly better" bar). **Medium** on the LOC estimate — it is an estimate from component knowledge, not a measured spike; no surprise emerged that warranted one.

## Implementation consequences and plan updates

- U3 builds `src/ui/chart/` hand-rolled: ring buffer keyed by sim-time, nice-tick y autoscale with min-range clamp, fixed x window with mm:ss labels, 1Hz render cadence outside the sim frame loop; per-arm bars in `src/ui/overlay/` as plain rects.
- Share/extract the DPR + resize utility with U1's renderer (put it in `src/render/` or a tiny shared module) — small addition to U1's outcome, no scope change.
- Unit-test targets for U3: ring-buffer window trimming, nice ticks (incl. zero-range), label formatting; acceptance criterion "chart updates ~1Hz without frame drops" unchanged and easily met.
- `package.json` stays zero runtime dependencies; no changes to deps or build config.
- plan.md U3 risk line "R3 lib choice; default hand-rolled" → resolved: **hand-rolled confirmed**; no other task changes.

## Decision record

- **Decision:** hand-rolled canvas chart; no charting library. Unanimous evidence direction; no dissenting consideration survived the "clearly better" test.
- **Priority:** P2 (advisory to U3, non-blocking).
- **Status:** decided 2026-08-27; supersedes the "default hand-rolled" fallback — now a committed choice.
