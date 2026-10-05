# Traffic Intersection Flow Simulator

A deterministic, browser-based four-way intersection simulator for seeing how signal timing changes traffic delay.

[Open the live demo](https://traffic.graydonwasil.com/) | [Browse the source](https://github.com/Arrangedgodly/traffic)

<img width="1600" height="913" alt="x1-app-1-boot" src="https://github.com/user-attachments/assets/e7b92307-34f9-4de2-9650-6cd323ab7dc9" />

*The intersection view brings signal timing, traffic controls, and the delay chart together.*

## Try it locally

Requires Node.js 22 and npm.

```sh
git clone https://github.com/Arrangedgodly/traffic.git
cd traffic
npm ci
npm run dev
```

Open the local URL printed by Vite. To create the production bundle, run `npm run build`.

## What you can do

- Tune fixed-time signal greens and watch rolling average control delay update as trips complete.
- Compare signal control with an all-way stop.
- Change lane counts, turn mixes, and vehicle arrival rates on each approach.
- Use Light, Balanced, and Gridlock risk presets to explore different demand patterns.
- Run the timing optimizer to compare paired-seed signal plans, rank results by mean control delay, and apply a plan.
- Inspect stopped time, throughput, queues, and delay percentiles in the engineering overlay.
- Pause the simulation or change its speed from 0.5x to 4x.

The simulation is deterministic for a given seed and configuration. The app is built to run in the browser without runtime dependencies.

<img width="1600" height="913" alt="x1-app-8b-optimizer-results" src="https://github.com/user-attachments/assets/fa6d60f6-994c-4592-ab8c-b606f772ccad" />

*Compare timing plans: this captured run ranks 92 candidates and shows the selected plan's measured delay.*

## Scope

This is a single-user simulator for one four-way intersection. Settings and simulation state stay in the current browser session; there is no backend or persistence. Pedestrians, bicycles, networks of intersections, actuated signals, and shareable saved scenarios are not implemented.

## Development

`npm run dev` starts Vite. `npm run build` runs TypeScript type checking and creates the production bundle. `npm test` runs the Vitest suite.

## Links

- [Live demo](https://traffic.graydonwasil.com/)
- [Source repository](https://github.com/Arrangedgodly/traffic)
- [Product notes](PRODUCT.md)
- [Design system](DESIGN.md)
