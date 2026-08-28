---
name: Traffic Intersection Flow Simulator
description: A deterministic 60fps intersection simulator where signal-timing math becomes visible — tune the greens, watch delay respond, let the sweep prove it.
colors:
  # Neutral surfaces (tonal ladder, dark → light)
  night: "#090b10"
  backdrop: "#0b0e14"
  panel: "#10141c"
  panel-border: "#232a36"
  instrument-fill: "#1a212d"
  selected-row: "#16202e"
  best-row: "#16233a"
  # Text
  text-primary: "#d7dde8"
  text-dim: "#8b95a6"
  # Primary accent (interaction / selection / data)
  accent: "#6fb7ff"
  error: "#ff7a7a"
  # World — road & markings (canvas only)
  asphalt: "#282d38"
  marking-white: "#e9eef6"
  center-line: "#e0b23f"
  chart-grid: "#384359"
  selection-arm: "#6385b0"
  # World — control devices (canvas only)
  signal-housing: "#171b22"
  housing-stroke: "#5d687e"
  lamp-green: "#3fd158"
  lamp-yellow: "#ffcf3f"
  lamp-red: "#ff5d5d"
  stop-fill: "#d93026"
  stop-stroke: "#f5f7fa"
  # World — car behavior states (canvas only)
  car-cruise: "#7fb3ff"
  car-braking-queue: "#f2cc60"
  car-yielding: "#c77dff"
  car-in-intersection: "#7ee787"
typography:
  heading:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "13px"
    fontWeight: 600
  label:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "12px"
    fontWeight: 400
  value-mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "14px"
    fontWeight: 400
  micro:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "10px"
    fontWeight: 400
rounded:
  sm: "3px"
  md: "4px"
  lg: "5px"
  xl: "6px"
spacing:
  sm: "4px"
  md: "6px"
  lg: "8px"
  xl: "12px"
  panel: "14px"
components:
  button-neutral:
    backgroundColor: "{colors.instrument-fill}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.lg}"
    padding: "6px 10px"
  button-pressed:
    backgroundColor: "{colors.instrument-fill}"
    textColor: "{colors.accent}"
    rounded: "{rounded.lg}"
    padding: "6px 10px"
  stat-value:
    textColor: "{colors.accent}"
    typography: "{typography.value-mono}"
  badge:
    textColor: "{colors.text-dim}"
    rounded: "{rounded.sm}"
    padding: "2px 4px"
  arm-bar-track:
    backgroundColor: "{colors.instrument-fill}"
    rounded: "{rounded.sm}"
    height: "10px"
  arm-bar-fill:
    backgroundColor: "{colors.accent}"
    rounded: "{rounded.sm}"
---

# Design System: Traffic Intersection Flow Simulator

## Overview

**Creative North Star: "The Night Control Room"** *(inferred — the qualitative interview went unanswered; the metaphor is taken from the incumbent system's own documented doctrine, not imposed)*

The interface is a dark, instrument-lit control room for a single intersection. The chrome — panel, controls, labels — recedes into near-black slate so the simulation stays the brightest object on stage. One cool blue accent is the only voice the interface itself speaks: focus rings, selected values, the data line, selection highlights. Everything vivid beyond that belongs to the simulated world (signal lamps, car states), not to the UI. The result reads as *instrumented calm*: quiet, precise, data-forward, nothing shouting.

Discipline is the aesthetic. The palette is a single module (`src/ui/styles/palette.ts`) whose contrast ratios are pinned by tests, not taste — every text pair ≥ 4.5:1, every meaningful graphic ≥ 3:1, with three deliberate, documented sub-bar floors (see Colors). Depth is tonal, never shadowed. State is expressed by line and color changes, never by motion or gloss. The system's authority is measurement: a future screen is on-brand when its ratios pass the same audit.

**Key Characteristics:**

- Dark tonal ladder of near-black slate surfaces (no true black except car outlines), separated by 1px hairlines
- Exactly one UI accent (cool instrument blue) shared by interaction, selection, and data
- Green/yellow/red reserved exclusively for signal semantics; amber tones mean "queue/attention"
- Monospace for every number; system sans for every word
- Flat: zero shadows, zero gradients, zero transitions — state changes are instant
- Browser surfaces are themed from the ladder like drawn ones: scrollbars (panel, optimizer results, overlay body) are thin with a Panel Border thumb (Chart Grid on hover) over a transparent track; text selection is a 28%-alpha Instrument Blue wash; the tab favicon is the world's own three-lamp signal head (inline SVG, no asset)
- Contrast ratios are test-pinned (`palette.test.ts`), including three documented sub-bar floors

## Colors

A measured dark-slate instrument palette: neutrals step by lightness, one blue accent carries all UI meaning, and saturated color is licensed only to the simulated world.

### Primary
- **Instrument Blue** (#6fb7ff): the UI's single voice — focus rings (`:focus-visible`), live stat values, chart data line, selection strokes, pressed-button text. 8.7:1 on panel. Cars in cruise echo this family deliberately so chrome and world read as one system.

### Secondary
- **Queue Amber family** — Asphalt Yellow center line (#e0b23f, 7.0:1 on asphalt), car braking-queue (#f2cc60), HUD "ok" (#f2cc60): amber always means attention/queue pressure, never decoration.

### Tertiary (signal semantics — canvas only)
- **Lamp Green** (#3fd158), **Lamp Yellow** (#ffcf3f), **Lamp Red** (#ff5d5d): signal lamps only. Lamps separate by luminance and shape (arrow vs ball, bay position), not hue alone. **Stop Sign** red fill (#d93026) with white stroke (#f5f7fa) for all-way-stop glyphs.
- **Car behavior states** — Cruise #7fb3ff / Braking-queue #f2cc60 / Yielding #c77dff / In-intersection #7ee787 — all ≥ 3:1 on asphalt (#282d38), each outlined in 65%-alpha page-black (#090b10) so queue members stay distinct.
- **Turn-signal lamps** (canvas only) — turning cars carry a dark housing square at the front and rear corner of the signaling side, with a Lamp Yellow (#ffcf3f) fill lit at 1 Hz in sim time (0.5 s lit / 0.5 s dark); the signal window runs from 28 m before the stop line through the end of the turn curve. The blink is a pure function of sim time — deterministic, and a paused world holds its lamps.

### Neutral
- **Night** (#090b10): page background, the darkest step.
- **Backdrop** (#0b0e14): canvas and chart fields — the "screen" the world plays on.
- **Panel** (#10141c): control panel and metrics card surface, bordered by **Panel Border** hairline (#232a36).
- **Instrument Fill** (#1a212d): buttons, slider-adjacent fills, bar tracks — controls at rest.
- **Selected Row** (#16202e) and **Best Row** (#16233a): the two tinted-row states (lane selected; optimizer best).
- **Text Primary** (#d7dde8, 13.5:1 on panel) and **Text Dim** (#8b95a6, 6.1:1): the only text colors besides accent/error.

### Named Rules

**The Reserved Signal Rule.** Green, yellow, and red appear only as signal semantics (lamps, stop signs, FPS health). The UI never uses them decoratively; "success" in chrome is Instrument Blue, not green.

**The One Instrument Rule.** One accent for interaction, selection, and data. If a screen needs a second UI color, the design is wrong — amber and violet exist only inside the simulation.

**The Earned Contrast Rule.** Sub-3:1 is allowed only for documented floors: asphalt-vs-backdrop (1.4:1 — the road boundary is carried by 7.4:1 edge lines), signal-housing fill (silhouette carried by its 3.4:1 stroke), chart gridlines (2.0:1 — deliberately subordinate to the 9.1:1 data line). Every other text/graphic pair meets WCAG. New work must extend `palette.test.ts`, not argue exceptions.

## Typography

**Body Font:** system-ui (with -apple-system, Segoe UI, Roboto, sans-serif)
**Numeric/Mono Font:** ui-monospace (with SFMono-Regular, Menlo, Consolas, monospace)

**Character:** A deliberate non-pairing. The system sans says words quietly at small sizes; the monospace says numbers like an instrument. There is no display face — nothing on this stage is display-sized.

### Hierarchy
- **Heading** (600, 13px): sub-group headings (`h3`/`h4` — arms, phases, overlay groups). The panel has no title of its own — it opens on the "Playback" legend; a heading would restate the obvious (distill).
- **Label** (400, 12px, Text Dim): legends, field labels, table heads, hints — the workhorse size of the panel.
- **Value** (mono, 400, 14px, Instrument Blue): every stat value, output, and readout.
- **Micro** (400, 10px): badges only.

### Named Rules
**The Numbers Are Mono Rule.** Any glyph that is a measurement — stat values, table cells, optimizer greens, HUD, chart axis labels, canvas readouts — renders in the mono stack (all canvas text is mono). Sans is for language; mono is for data. There are no exceptions because the two stacks are the entire type system.

## Layout

**Desktop (≥980px):** a two-region stage (`flex`, wraps below ~640px+340px): the **world column** — canvas only — and a fixed **340px control panel** (right, full-height scroll, left hairline border, `contain: layout` — its internal scroll region never contributes to the page's scroll geometry). The 16:9 canvas is sized `min(100%, (100dvh − 12px) × 16/9)` and vertically centered in the column (the freed band reads as instrument bezel). **The metrics card is a popover riding ON the canvas** (owner-request layout): anchored bottom-left of the canvas above its toggle chip, `min(520px, width−28px)` wide, internally scrolled, dismissible via the "Metrics" chip in the canvas's bottom-left corner (HUD owns the top-left). Default open — the chart is the aha. With the card out of flow, the desktop page never scrolls in ANY state (engineering overlay included — it lives inside the popover's bounded scroll).

**Mobile portrait (<980px): the docked-deck composition** (adapt pass, owner decision 2026-08-28 — full parity on touch). One 100dvh column, no page scroll: the **world on top** (full-width 16:9 canvas), the **metrics card in flow beneath it** (never a popover over a six-inch canvas; same premise line, stats, chart, overlay, internally scrolled, still dismissible from the canvas's corner chip row), and the **control panel docked at the bottom as a deck** — a persistent full-width "Controls" bar (48px, 13px/600, the arm-summary triangle as its state chevron) over a scrollable body (`max-height: max(200px, min(60dvh, 100dvh − 56.25vw − 300px))`, hairline above) so the canvas plus a metrics minimum stay visible while tuning — the premise (tune a green, watch delay answer) survives the small screen. The deck opens/closes instantly (no motion, per doctrine); default closed, so the first viewport is the taught scene and the bar is the invitation. Safe-area insets pad the deck's bottom; `overscroll-behavior: contain` fences both scroll regions.

**Mobile world zoom:** below 980px the canvas **crops to the road** (`ROAD_FILL_WIDTH_ZOOM` = 1280/696 ≈ 1.84×): the E–W road runs edge to edge and the N/S arm tips extend past the top and bottom of the frame — the intersection, not the county, is the subject. Canvas text is HUD chrome, not world: it stays on the unzoomed transform (constant CSS-px size), and canvas taps invert the same view for picking. Desktop keeps the full 240 m overview.

**Hideable stats:** the canvas HUD readout (FPS · sim clock · car count) is toggleable chrome — the "Stats" chip beside "Metrics" in the canvas's bottom-left corner row removes it from the stage entirely (a null `SceneHud` emits no readout commands; default on).

**Mobile landscape (<980px):** too short to dock — the world caps at viewport height, metrics and panel flow beneath, the page scrolls (touch-sized, intentionally).

**Touch layer (coarse pointers):** every interactive control ≥44px (checkboxes drawn at 20px with label hit areas; slider rows and selects sized up), form controls render at 16px text (below that, Mobile Safari zooms the page on focus — a platform constraint, not a type-system widening: labels and values keep the five sizes), `touch-action: manipulation` kills double-tap-zoom delay, tap highlight is transparent, and pressed controls step one tonal rung (`:active` → Panel Border fill) — instant color state, the existing state vocabulary unchanged. Canvas HUD text holds a constant CSS-pixel size as the canvas shrinks (`SceneHud.textScale`, capped 3.2×, test-pinned) instead of scaling into illegibility.

Panel order follows the task, not setup: **Playback → Signal plan → Optimizer → Arms → Control type → Preset → Issues** — identical in the deck (the deck body is the same panel, docked). The premise's named action (the greens) is group 2; the sweep that grades it follows immediately — the whole taught loop sits above the fold. Arms are `<details>` collapsed to their summaries by default (between-arm margin 8px exceeds the within-arm 6px so four arms read as four groups); opening a summary selects the arm, and canvas arm/lane selection expands and scrolls to its editor. (On phones the arms are small on canvas — the panel's arm editors are the primary path there, as they always were for keyboard users.)

Rhythm is close and even: 6px–8px gaps between controls, 8px–12px inner padding (panel 12/14px), 1px hairline separations. Density is instrument-panel tight, not airy — the 12px label is the unit of measure.

## Elevation & Depth

Flat by doctrine: the codebase contains **zero box-shadows and zero gradients**. Depth is tonal — Night → Backdrop → Panel → Instrument Fill → Selected/Best tints — reinforced by 1px hairline borders. A surface "lifts" only by becoming lighter or gaining an accent border, never by shadow. (Inferred as doctrine, not accident: the ladder is uniform across every surface in the code.)

### Named Rules
**The No-Shadow Rule.** No shadows, ever — in DOM or canvas. If a new element feels like it needs one, it needs a lighter fill or an accent border instead.

## Shapes

Small-radius rectangles everywhere: 6px for containers (fieldset groups, metrics card), 5px buttons, 4px rows and the chart field, 3px bar tracks and badges. Borders do the semantic work: solid hairlines separate structure; **dashed accent outlines mark transient states** (the optimizer's "current plan" row, dotted underline on arm links); solid accent borders mark committed selection. The only organic shapes in the product are the simulated world's own — rounded car rectangles, octagonal stop signs, signal housings.

## Components

All controls are native elements (button, select, input[type=range], checkbox), styled minimally — the browser's control rendering tinted by `accent-color`, wrapped in hairline borders.

### Buttons
- **Shape:** softly squared (5px radius)
- **Neutral:** Instrument Fill bg, Text Primary, 1px Panel Border, padding 6×10px (`pause-button`, optimizer run/cancel/apply)
- **Pressed/active toggle** (`aria-pressed="true"`): accent border + accent text
- **Focus:** global `:focus-visible` — 2px Instrument Blue outline, 2px offset, on every interactive element
- **Disabled:** 0.5 opacity, no cursor — never removed from layout

### Inputs / Fields
- **Range sliders & selects:** full-width, `accent-color: var(--accent)`; labels sit above with the live value in mono (`output`) on the label line
- **Fieldsets:** the grouping unit — 1px hairline, 6px radius, 12px legend in Text Dim
- **Invalid edits:** prevented upstream by config validation; when shown, issues render in Error red under the group (`role=alert`)

### Chips
- **Badges** ("BEST", "CURRENT"): 10px micro text, 3px radius, hairline border, Text Dim; the active variant's border+text flip to accent on the row it labels

### Cards / Containers
- **Mobile control deck** (portrait <980px): the panel docked at the viewport's bottom — Panel bg, top hairline, safe-area bottom padding. The persistent bar is a single full-width button ("Controls", 48px min, chevron triangle flipping with `aria-expanded`); the body is the ordinary panel content, scrollable, capped so world + metrics stay visible above. Instant open/close, no motion
- **Metrics popover:** rides ON the canvas (bottom-left, above its toggle chip) — Panel bg, hairline border, 6px radius, 6/12/8px padding, `min(520px, width−28px)` wide, internally scrolled; flat tonal card over the world, never a shadow. Opens with the **premise line** ("Tune a green phase in the panel — the delay line answers.", 12px Text Dim — the one taught interaction, static caption, never a tooltip), then the headline stat row and chart. The "Metrics" chip in the canvas's bottom-left corner toggles it (`aria-pressed`); default open. (Mobile portrait: same card, in flow under the canvas, never a popover)
- **Optimizer results:** bordered scroll box (max 300px, internally scrolled); rows are a fixed-track grid — rank | greens (slash notation, mono) | delay | delta | Apply — so all rows scan as one aligned table (spread and "vs current" context live on each row's accessible name). The **best row** is tinted Best Row; the **current row** carries the dashed accent outline and its badge sits in the delta cell (it IS the reference). A **verdict line** leads the box — the sweep's one-sentence judgment on the operator's tuning ("Verdict — current plan confirmed…" / "Verdict — rank 1 cuts mean control delay by ⟨mono accent⟩ X s vs the current plan."): 12px, 600-weight label, hairline below; recomputed on every apply, so applying rank 1 flips it to confirmed. The verdict is the results' polite live region (announced at completion and on re-baselining); the status line above stays terse ("Done in 2.1 s.") and never repeats the verdict's or summary's numbers. Success stays Instrument Blue — never signal green.

### Stat Readouts
- **Headline stats:** label (12px dim) inline-before value (mono 14px accent), nowrap, wrapped in a row with 22px column gaps

### Signature: Arm Bars & Lane Rows
- **Arm bar** (engineering overlay): 52px name / 10px track (Instrument Fill, hairline, 3px radius) / 72px mono value; fill is 100% Instrument Blue — bar length is the encoding, color never varies
- **Lane row (selected):** Selected Row tint + 1px accent outline; arm sections gain an accent border when their lane is canvas-selected

## Do's and Don'ts

### Do:
- **Do** add every new color to `src/ui/styles/palette.ts` with its measured contrast ratio in the doc comment — the test-pinned audit is the system's source of authority.
- **Do** express state with tonal steps, accent borders, or dashed-vs-solid lines — the vocabulary already covers selection, transient, and committed states.
- **Do** keep every number in the mono stack at 12–14px with its label in 12px Text Dim.
- **Do** reserve saturated color for the simulated world; chrome speaks slate + Instrument Blue.

### Don't:
- **Don't** add shadows, gradients, glow, or transitions — the instant, flat, tonal response is the aesthetic. (The deck opens and closes in one instant state change, exactly like every other state in the system.)
- **Don't** use green/yellow/red in the UI chrome; they mean signal state only.
- **Don't** introduce a second UI accent; selection, focus, data, and action share Instrument Blue.
- **Don't** widen the type system — the two stacks and five sizes are complete. (The 16px form-control text on coarse pointers is a Mobile Safari zoom guard, not a sixth size: labels and values never change.)
- **Don't** design a third composition: there are exactly two — the desktop split stage and the mobile docked deck (plus the landscape scroll fallback). A new surface picks one; it does not invent layout.
