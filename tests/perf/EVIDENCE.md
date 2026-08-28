# Q2 acceptance evidence — Traffic Intersection Flow Simulator

Scaffold + headless evidence for the X1 final acceptance run-through. Every
criterion from `docs/ultron/town-hall.md` §"Success measures" is listed with:
where it is measured, the evidence already on record, and — for the
browser-only numbers — an empty slot marked **[X1]** to be filled from the Q2
benchmark page's results JSON.

## How to produce the browser numbers (X1 run)

```bash
npm run build && npm run preview     # then open http://localhost:4173/benchmark.html
# (dev works too: npm run dev → http://localhost:5173/benchmark.html)
```

The page auto-runs (~60 s; keep the tab foreground): stress world at ≥150
concurrent cars → 10 s rAF measurement at 1× → 10 s at 4× → default sweep
concurrent with the frame loop (real worker pool) → results JSON on the page,
in the console, and downloadable. Paste the JSON into the slots below and into
the X1 production-log entry. Record the hardware line from `meta`.

Headless numbers refresh (this machine only; timings are machine-dependent):

```bash
Q2_SWEEP=1 npx vitest run tests/perf/headless-measurements.test.ts   # all timing bars asserted
Q2_SWEEP=1 npx vitest run src/optimizer/sweep.perf.test.ts           # O1 sweep walls
npm test                                                             # suite (timing bars gated, deterministic asserts on)
```

## Machine of record (2026-08-27 headless numbers below)

- MacBook Air, Apple M2, 8 cores (4 performance + 4 efficiency), 16 GB
- darwin 25.6.0, node/vitest per package-lock
- **[X1 browser run — FILLED 2026-08-27]** hardware: same MacBook Air (M2, 8
  cores, 16 GB); Chrome 151.0.7922.174 headless (new) driven via CDP at
  http://localhost:4173/ (`npm run preview`), viewport 1600×1000 logical,
  devicePixelRatio 1, canvas 1124×632 CSS px, hardwareConcurrency 8, sweep
  worker pool 6. rAF idles at 60 Hz (verified before measurement). Results
  JSONs: `docs/ultron/x1-benchmark-results.json` (run 1) — two runs taken per
  invocation; the pre-fix first invocation is preserved in the X1 log entry.

---

## Criterion 1 — 60 fps rendering with 150+ concurrent cars on a mid-range laptop

- **Load floor (guaranteed):** `tests/perf/stress-config.ts` — validated
  3-lane/arm oversaturated signal config, `minGapMeters` 1.2 (disclosed
  deviation, module doc); post-warmup steady state measured 157–179 alive
  cars, floor ≥150 held every tick (asserted in `stress-config.test.ts`, and
  per-frame `aliveCars.min` in every benchmark segment).
- **Headless (node, 2026-08-27):** full-pipeline sim tick (`SimRuntime.step`)
  over 3000 ticks at alive 157–180: median **0.199 ms** / p95 0.329 /
  p99 0.544 / max 1.012 — F4 bar < 4 ms/tick met with ~20× margin at p99.
  Draw-list build (`renderer.frame`) at 159 cars / 443 commands per frame:
  median **0.164 ms** / p99 0.476 / max 1.605 (U1 bar < 4 ms; rasterization
  excluded in node — measured on canvas by the benchmark page). Metrics
  snapshot per frame: median 0.021 ms.
- **Worst-case frame arithmetic (worker-pool sweep, chunk 0):** sim max
  0.873 + build p99 0.702 = **1.575 ms** ⇒ 15.09 ms headroom (91% of a
  16.67 ms frame; ≥ 12 ms warn bar met).
- **[X1 browser — measured 2026-08-27, post-warmup-fix]** steady 1× segment:
  meanFps **59.4 / 59.5** (two runs), p99 frame **18.6 ms** (median 16.7),
  aliveCars min **157** (157–161; bar ≥ 55 fps at ≥ 150 cars — PASS; 60 fps
  target effectively met, vsync-pacing tail only: app-attributable work
  updateMedian 0.2 ms + renderP99 1.1–1.4 ms per frame, 1 frame > 20 ms in
  601). Pre-fix first invocation measured 58.9 fps at alive min 145 — see the
  X1 log entry: the harness exited warmup at the first ≥ 150 crossing
  (mid-ramp); fixed to run the full 1500-tick warmup per
  `stress-config.test.ts`'s guarantee protocol.
- **[X1 browser]** 4× speed segment: meanFps **60.0 / 60.0**, p99 frame
  **18.6 / 18.5 ms** (0 frames > 20 ms), aliveCars **161–170**
- **[X1 browser]** steady 1× worst-case frame from `frameBudgetArithmetic`:
  **1.6 / 1.5 ms**, headroom **15.07 / 15.17 ms** (≥ 12 ms bar met)

## Criterion 2 — chart updates ~1 Hz over a rolling window; per-arm breakdown in overlay

- **Design evidence (T-U3, verified PASS):** sim-time-keyed ~1 Hz gate
  (`src/ui/chart/gate.ts`) — paused ⇒ 0 redraws; 0.5/1/2/4× ⇒ 0.5/1/2/4 Hz;
  hand-rolled canvas chart + DOM overlay, no charting dependency.
- **Headless:** the chart/overlay/gates run inside every measured benchmark
  frame (part of `renderMs`; metrics snapshot median 0.021 ms).
- **[X1 browser — confirmed 2026-08-27]** the benchmark page's own
  `chart1HzWithoutFrameDrops` bar: **PASS** on all 4 runs (chart/headline/
  overlay run inside every measured frame — part of renderMs, median 0.6–0.7
  ms, p99 1.1–1.4 ms; no correlated spikes: app work ≤ 1.9 ms worst-case
  arithmetic vs 16.67 ms budget). In the main app: headline DOM text observed
  updating between samples 2.6 s apart and identical between back-to-back
  samples (the ~1 Hz sim-time gate), while fps held 60 (HUD, screenshot
  `x1-app-2-balanced-chart.png`).

## Criterion 3 — determinism: same seed + config ⇒ identical run (paired seeds)

- **Evidence (T-Q1, verified PASS 2026-08-27):** 4 configs × 2×2000-tick
  bit-identical run-hash sequences + snapshots; adjacent-seed divergence;
  mid-run config-change replay bit-identical; O1 executor-identity tests
  (pool ≡ time-sliced ≡ direct) green.
- Open (non-blocking, T-Q1 log): cross-thread real-Worker bit-identity in a
  browser — the benchmark page's sweep runs the real worker pool; its report
  is deterministic per seed. **[X1 browser — FILLED 2026-08-27]** benchmark
  page re-run twice (and twice again after the harness warmup fix): identical
  `bestCandidateId` "g:5+26+5+7" and identical `bestMeanControlDelaySeconds`
  **0.632 = 0.632** across both post-fix runs (same executor
  "worker-pool", same 92 candidates / 276 runs; only wall time differed) —
  real-Worker cross-thread determinism confirmed in a real browser, matching
  the Q1 in-process worker evidence.

## Criterion 4 — default optimizer sweep ≤ 30 s, no observable frame drops; proposes a measurably better plan on gridlock-risk

- **Headless walls (fallback/time-sliced executor, 2026-08-27):** default
  config 43 candidates × 3 reps = 129 runs → **16.49 s**; balanced preset
  (the app default) 92 candidates = 276 runs → **26.14 s**. Browser 6-worker
  pool estimates 2.81 / 4.36 s (excl. worker startup).
- **Chunk arithmetic (fallback executor while live):** sweep tick max 0.497 ms
  ⇒ 4 ms chunk worst case **4.497 ms = 27.0% of a 16.67 ms frame** (≤ 30%
  bar); fallback-sweep worst-case frame 6.072 ms ⇒ 10.59 ms headroom (≥55 fps
  satisfied; the 12 ms warn headroom is the NO-sweep frame's bar — see
  production-log deviation note).
- **Better plan on gridlock-risk (T-O1/T-O2, verified):** sweep ranks by mean
  control delay; O2 apply mutates the live plan measurably.
- **[X1 browser — measured 2026-08-27]** sweep segment: wallSeconds
  **2.44 / 2.02** (two runs; bar ≤ 30 s — PASS with ~12× margin),
  meanFps during sweep **60.0 / 60.0** (bar ≥ 55 fps — PASS, 0 frames
  > 20 ms), executor **worker-pool** (6 workers), candidates **92**
  (276 runs, 3 reps, 45 s horizon); app-pass in-page optimizer runs: 2.5 s
  (288 runs, custom C=65 config), 2.1 s (gridlock-risk), 1.9 s (balanced
  fresh load) — all worker-pool.
- **[X1 browser]** on the gridlock-risk preset in the app: run optimizer,
  best plan **5+26+5+7 s greens, mean delay 1.2 s** vs current
  **6.3 s** (288 runs, worker-pool, 2.1 s wall) — **measurably better:
  −5.1 s (−81%)**: PASS. Balanced/custom run: best 0.6 s vs current
  1.9 s (−1.3 s); apply through the panel mutated the live plan
  7/20/7/14 → 5/26/10/7 at C=65 and the ranked rows carry Best/Current
  badges + per-row Apply (screenshot `x1-app-8b-optimizer-results.png`).

## Criterion 5 — three presets produce visibly distinct chart signatures

- **Evidence (T-Q1, verified PASS):** mean control delay per-seed ranges
  light [8.8, 18.8] < balanced [21.6, 29.5] < gridlock [33.3, 40.2] s at the
  pinned 120 s horizon — disjoint at every seed (verifier-reproduced margins
  12.08 / 7.19 s with fresh seeds).
- **[X1 browser — visually confirmed 2026-08-27]** three ~50 s app sessions
  (screenshots `x1-app-9-preset-light.png`, `x1-app-2-balanced-chart.png`,
  `x1-app-10-preset-gridlock.png`): **light** — line flat/low ~0–2 s, headline
  avg wait 8.9 s at 9 trips, max queue 4, ~6 cars; **balanced** — flat ~1–2 s
  then rising to ~6 s, 6.2 s headline, throughput 1047 veh/h, max queue 8,
  ~22 cars; **gridlock-risk** — climbs early to ~4–5 s then rises toward ~7 s
  with visible arm imbalance (overlay per-arm bars South 14.5 s vs North
  0.7 s), headline 6.4 s (window still building), max queue 22, ~45 cars,
  queues stretching back along approaches. **Three visibly distinct chart
  signatures: PASS.**

## Criterion 6 — no visual car overlap at any time

- **Evidence (T-Q1/T-F5b, verified PASS):** 10k-tick soaks × 4 control modes
  with the real spawner — 0 footprint intersections (F3 capsule model,
  min distances 1.96–2.72 m vs 1.8 m threshold); terminal clamp 0; ungranted
  crossings 0. The stress config inherits the same machinery; its soak is
  covered by `stress-config.test.ts` (spillback engaged, same no-overlap
  sim core).
- **[X1 browser — visually confirmed 2026-08-27]** screenshots inspected at
  150+ cars (benchmark runs, alive 157–170) and on all three app presets incl.
  gridlock-risk at max queue 22 (bumper-to-bumper queues visible): **no
  visual car overlap observed anywhere** — matches the Q1 soak guarantee
  (0 footprint intersections across 4 control modes × 10k ticks).

## Criterion 7 — all controls are DOM inputs; headline stats exposed as text

- **Evidence (T-U2/T-U3/T-O2, verified PASS):** control/optimizer panels are
  real native DOM inputs with labels + focus visibility; headline stats are
  DOM text (`#headline-stats`); U3 verifier proved textContent assignment.
- **[X1 browser — confirmed 2026-08-27]** DOM audit over 155 live controls
  (panel + overlay + optimizer incl. 96 per-row Apply buttons): **all native
  `<input>/<select>/<button>`, zero unnamed** (explicit `htmlFor` labels or
  button text / aria-label); both canvases `tabIndex -1` (role="img", not
  tab stops); headline stats are real DOM text (`#headline-stats` read as
  "Avg wait (control delay) 10.4 s · Throughput 877 veh/h · Window 15 trips
  · max queue 33"). Screenshot `x1-app-1-boot.png`; human tab-order pass
  remains in `docs/ultron/D1-CHECKLIST.md`.

---

## Bars summary (Q2's own acceptance)

| Bar | Value | Met by (evidence above) |
| --- | --- | --- |
| 150+ concurrent cars (guaranteed load) | ≥ 150 alive every measured tick | Headless: 157–180 ✓ (asserted) |
| Sim tick at load (F4) | < 4 ms/tick | Headless: median 0.199 / p99 0.544 ✓ |
| Render build at load (U1) | < 4 ms | Headless: median 0.164 / p99 0.476 ✓ (raster → browser) |
| Worst-case frame, no sweep | ≤ 16.6 ms, headroom ≥ 12 ms | Headless: 1.575 ms used, 15.09 ms headroom ✓ |
| Worst-case time-slice chunk | ≤ 30% of frame | Headless: 4.497 ms = 27.0% ✓ |
| Default sweep wall | ≤ 30 s | Headless fallback: 16.49 s (default cfg) / 26.14 s (balanced) ✓; **[X1] browser pool: 2.44 / 2.02 s** ✓ |
| fps during sweep | ≥ 55 fps | Headless bound: worst frame 6.07 ms ⇒ ≥ 160 fps theoretical ✓; **[X1] measured 60.0 / 60.0 fps** ✓ |

## X1 browser verdict (2026-08-27, the benchmark's own pass/fail)

Post-warmup-fix, two consecutive runs, all three bars PASS on both:
`render60fpsAt150PlusCars` (59.4/59.5 fps at alive ≥ 157) ·
`chart1HzWithoutFrameDrops` · `defaultSweepUnder30sNoDrops` (2.44/2.02 s,
60 fps during). Full JSON: `docs/ultron/x1-benchmark-results.json`. The first
(pre-fix) invocation honestly FAILED the 150-car floor half of bar 1
(58.9 fps — above 55 — at alive min 145): the harness exited warmup at the
first ≥ 150 crossing; fixed to the full-tick warmup protocol of
`stress-config.test.ts` (see X1 production-log entry).
