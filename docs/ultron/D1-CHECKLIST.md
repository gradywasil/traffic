# D1-CHECKLIST — human visual & accessibility pass (for X1)

> **X1 status note (2026-08-27):** an automated real-browser pass (Chrome 151
> headless via CDP, built app at `npm run preview`) already confirmed the
> machine-checkable halves: console clean, overlay/optimizer/chart DOM
> content, edit-while-running, preset chart-signature distinctness, no visual
> car overlap at 150+ cars, all 155 controls native + named, canvases not tab
> stops (evidence: production-log T-X1 entry + `x1-*.png` screenshots). This
> checklist REMAINS the user's final aesthetic/accessibility judgment —
> especially the eyeball items: §1 layout at real sizes, §2–3 marking/signal
> legibility at a normal viewing distance, §7 keyboard walkthrough feel,
> §8 screen-reader smoke, §9 zoom/HiDPI on your display.

D1 shipped source-level polish + programmatic checks (contrast audit in
`src/ui/styles/palette.test.ts`; all ratios printed on every `npm test` run).
No browser was available in the D1 environment, so these items need a human
eyeball in a real evergreen browser. Run against the built app
(`npm run build && npm run preview`, or `npm run dev`) — desktop, mouse +
keyboard, default window 1280×720 or larger.

Record results in the X1 production-log entry. Anything that fails: fix-forward
small (colors/sizes are palette tokens in `src/ui/styles/palette.ts` + the
constants at the top of `src/render/renderer.ts` / `src/ui/chart/draw.ts`).

## Setup

- [ ] Load the app at ≥1280×720 (default `balanced` preset, sim running).
- [ ] Also open with browser devtools' rendering tab available (this pass uses
      no tooling beyond your eyes, but it helps to reproduce findings).

## 1. Layout @ 1280×720 (and one larger size)

- [ ] Canvas world, metrics card (headline stats + chart + overlay), and the
      340 px control panel sit side by side; nothing overlaps or overflows.
- [ ] Canvas keeps 16:9 and is never clipped by the panel at 1280×720.
- [ ] At a maximized window (e.g. 1920×1080), the canvas scales up cleanly
      (crisper, not stretched) and the panel keeps its 340 px width.
- [ ] Narrower than 1280 (not a target viewport): panel wraps below the canvas
      without breaking — no horizontal page scrollbar at ~1000 px.
- [ ] Panel scrolls independently (`max-height: 100vh; overflow-y: auto`) when
      the overlay is expanded and all four arm sections are open.

## 2. Road & markings legibility

- [ ] Lane arrows readable on every arm: shaft + head visible for left /
      through / right; shared-lane glyphs (e.g. left+through) don't crowd.
- [ ] Dashed lane dividers visible but clearly secondary to solid edge lines.
- [ ] Double yellow center line reads as "opposing traffic" separation.
- [ ] Stop bars visible at the box edge of every approach lane.
- [ ] Road silhouette distinguishable from the off-road backdrop at a glance
      (carried by the edge lines — asphalt itself is deliberately low-contrast;
      see SUB_BAR_FLOORS in palette.test.ts).

## 3. Signal heads (switch to a signal preset if needed)

- [ ] Every approach lane has a head on the right shoulder; housings visible
      against the dark backdrop (D1: stroke lightened to 3.4:1).
- [ ] Green / yellow / red lamps clearly distinguishable at a normal viewing
      distance, including for red-green color-blind vision (lamps also differ
      in luminance and shape — arrow vs ball; deuteranopia simulation in
      devtools is a quick check).
- [ ] Arrow lamp (protected left) visibly distinct from ball lamps; the arrow
      points left relative to the approaching direction on the correct arms.
- [ ] Heads never collide with the road edge, cars, or each other on 1/2/3-lane
      arms (stagger check — lane 1's head furthest upstream, rightmost nearest
      the stop line).
- [ ] All-way stop mode: four STOP octagons, one per arm, readable (border +
      fill; the "STOP" text is a stylized bar at this size — intentional).

## 4. Cars

- [ ] Car behavior colors distinguishable at speed: cruise (light blue) /
      queue (amber) / yielding (violet) / in-intersection (green).
- [ ] Queued cars stay visually distinct bumper-to-bumper (dark outline; D1
      strengthened outline alpha 0.55 → 0.65).
- [ ] No visual overlap between cars, ever (also an acceptance criterion).
- [ ] Click an approach lane on the canvas: bright outline on that lane, dimmer
      outline on the arm's other lanes (D1: dim outline lifted from invisible
      #3d5a80 to 3.6:1 #6385b0); panel scrolls to + focuses the arm editor.

## 5. Chart & metrics card

- [ ] Rolling avg-wait chart: data line clearly dominant over gridlines; the
      head dot visible at the newest sample.
- [ ] Axis labels (mm:ss, seconds) readable; gridlines visible but subtle.
- [ ] Empty state message ("waiting for completed trips…") visible on a fresh
      load / after a config change resets the window.
- [ ] Headline stats read as text, update ~1 Hz, no layout shift while updating.
- [ ] Engineering overlay: toggle on; per-arm delay bars + tables render; bar
      fill visible against the track; numbers change ~1 Hz while running.
- [ ] Three presets (light / balanced / gridlock-risk) produce visibly distinct
      chart shapes after ~2–3 sim-minutes (acceptance criterion).

## 6. Panel & optimizer polish

- [ ] Slider labels + live value outputs (veh/h, %, s) aligned and readable;
      green-duration sliders show integer seconds; cycle length auto-fits.
- [ ] Selected arm/lane rows highlighted (border/background) without hiding text.
- [ ] Optimizer: run → progress line updates (status region); ranked list rows
      readable; Best/Current badges legible; Apply buttons obviously buttons.
- [ ] Disabled states (Cancel while idle, Apply on unranked rows) visibly
      disabled but not invisible.

## 7. Keyboard-only walkthrough (put the mouse away)

- [ ] Tab reaches every control in a sensible order: panel controls (pause,
      speed, preset, control type, plan sliders, per-arm editors), overlay
      toggle, optimizer buttons, per-row Apply buttons.
- [ ] Every focused control shows the accent focus ring (2 px, offset).
- [ ] Space toggles Pause; arrow keys move a focused slider; checkboxes toggle
      with Space; selects open with arrow keys/Enter.
- [ ] "North arm" (etc.) buttons select the arm with Enter/Space — the DOM
      equivalent of clicking the canvas.
- [ ] Canvas is NOT a tab stop (role="img" — selection/editing fully reachable
      from the panel; canvas click is an enhancement only).

## 8. Screen-reader smoke test (VoiceOver on macOS: Cmd+F5)

- [ ] Page title/heading announced ("Traffic Intersection Flow Simulator").
- [ ] Every control announces its label + role (e.g. "Spawn rate, slider").
- [ ] Optimizer progress announces politely while running (role=status).
- [ ] An invalid edit announces via the alert region ("Invalid edit — not
      applied").
- [ ] Headline stats are readable as text on demand (navigate to the metrics
      region). They are intentionally NOT a live region (1 Hz chatter).
- [ ] The two canvases announce their aria-labels and nothing more (stance:
      canvas is not screen-reader-navigable).

## 9. Zoom / display robustness (quick)

- [ ] Browser zoom 200%: layout still usable (text scales; panel scrolls).
- [ ] If the OS uses a non-1 devicePixelRatio (Retina/HiDPI): canvas + chart
      look sharp (DPR-aware backing stores), not blurry.

## Known deliberate sub-3:1 pairs (do NOT file as bugs)

- Asphalt vs backdrop (1.4:1) — road boundary carried by 7.4:1 edge lines.
- Signal-housing fill vs backdrop (1.1:1) — head carried by 3.4:1 stroke + lamps.
- Chart gridlines vs chart bg (2.0:1) — reference decoration; values carried by
  6.4:1 axis labels; kept subordinate to the 9.1:1 data line.

Rationale + floors are pinned in `src/ui/styles/palette.test.ts`
(`SUB_BAR_FLOORS`); the full measured ratio table prints on every test run.
