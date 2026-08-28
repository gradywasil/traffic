# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Two audiences, both confirmed:

1. **Portfolio visitors** (primary, per owner decision 2026-08-28): recruiters, hiring managers, and engineering peers arriving at the live URL. Their situation is a cold, unattended first visit; their job is to judge, within seconds to a couple of minutes, whether the maker has engineering and design craft. The site must carry that judgment alone — no one is standing next to it to explain.
2. **Operators** (the in-product user, from the approved brief): curious learners first, engineering students via the overlay. Single user, one sitting, no prior traffic-engineering knowledge required to start.

## Product Purpose

A deterministic, 60fps top-down simulation of one configurable 4-way intersection where the mathematics of signal timing becomes visible and felt: queues form live, average delay charts in real time, and tuning a green phase by seconds shows its effect on the bottleneck immediately. A paired-seed optimizer sweeps timing plans and either confirms or embarrasses the operator's hand-tuning.

It exists as a **portfolio / demo piece** (owner decision): the deliverable is the live site, and future work optimizes for a striking, shareable first impression that demonstrates from-scratch engineering craft.

Success means: a cold visitor grasps the premise from the first viewport without instructions, interacts, and witnesses delay respond to a tweak — and an operator leaves having *felt* what +5 seconds of green does.

## Positioning

Traffic-engineer-honest metrics on a from-scratch simulation: control delay measured the way the profession measures it (HCM-style actual-minus-free-flow), paired-seed deterministic optimization, an ECS simulation core, renderer, and chart built with **zero runtime dependencies**. An arcade traffic toy could copy the look but could not truthfully claim "the numbers are real."

## Operating Context

- Hosted at `https://traffic.graydonwasil.com` — GitHub Pages deployed by Actions on push to `main`; DNS on Cloudflare. Repo: `Arrangedgodly/traffic`.
- Desktop evergreen browsers (latest-2), mouse + keyboard, ≥1280×720 viewport. Touch and mobile are explicitly out of scope.
- Single-user, session-only: nothing persists, nothing leaves the browser, no backend, no telemetry.
- Dev: `npm run dev`; build + typecheck: `npm run build`; full suite: `npm test`.

## Capabilities and Constraints

Confirmed functionality:

- Fixed 4-way intersection; per-arm lane count 1–3 with per-lane turn designations (left/through/right); per-arm spawn rates and turn mixes.
- Control per intersection: NEMA-lite fixed-time signal plan (integer-second greens, derived yellow/all-red) **or** all-way stop (full stop, FIFO departure, right-tiebreak, left yields to oncoming).
- Edit while running: plan/demand changes apply live; geometry changes reset the world; stats window resets on any config change.
- Pause/play; speed 0.5–4×; three presets (light / balanced / gridlock-risk) with distinct chart signatures.
- Headline metric: rolling-window average **control delay** (~1Hz chart); engineering overlay adds stopped-time, throughput, max queue, percentiles, parameter read-out.
- Optimizer: paired-seed timing sweep on a worker pool (~2s typical), ranked plans vs current, one-click apply.
- Deterministic seeded runs — same seed + config ⇒ identical run (proven, bit-identical).

Constraints: 60fps with 150+ concurrent cars; zero runtime dependencies; no backend/persistence.

**Parked ideas — not commitments** (owner decision 2026-08-28): pedestrians/bikes, multi-intersection networks, actuated signals, save/share URLs, mobile support. The single-intersection simulator is the product.

## Brand Commitments

- The product name is the descriptive title: **Traffic Intersection Flow Simulator**. Settled — no naming, logo, or brand-mark work in future design passes.
- In-app voice is precise and technical (e.g., "control delay", "paired seeds") — plain-language labels backed by an engineering overlay.

## Evidence on Hand

- `docs/ultron/town-hall.md` — approved scoping brief (decisions + rationale).
- `docs/ultron/plan.md`, `docs/ultron/research/` (3 committed research records), `docs/ultron/production-log.md` (17 verified task entries with measurements).
- `docs/ultron/x1-*` — 17 acceptance artifacts: browser screenshots + benchmark JSONs. `tests/perf/EVIDENCE.md` — acceptance evidence table.
- In-app benchmark page (`/benchmark.html`) reproduces the performance claims on demand.

Absences future work must not fabricate: no real-world usage data, no testimonials, no external reviews, no third-party benchmarks.

## Product Principles

1. **The math is the show.** Every element earns its place by making delay more visible and more legible.
2. **Honest numbers or nothing.** Engineering-grade metrics only; never a stat an operator could game or a chart a traffic engineer would dispute.
3. **Provable claims.** What the product asserts, it can reproduce — determinism and evidence trails are features.
4. **Built, not assembled.** The simulation core, renderer, and chart are hand-rolled; the zero-dependency constraint is part of the demonstration.
5. **The first viewport teaches.** A cold visitor with no instructions understands the premise and sees it working immediately.

## Accessibility & Inclusion

All controls are real DOM inputs, labeled, keyboard-operable; the palette is WCAG contrast-audited (record: `docs/ultron/production-log.md`, T-D1); live stats are exposed as text. Desktop-only scope is an explicit constraint of this product, not an oversight.
