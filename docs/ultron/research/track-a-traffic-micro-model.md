# Track A — Traffic Micro-Model (R1): Car-Following, Conflict Arbitration, Signal Structure, Free-Flow Baseline

- **Decision ID:** R1 / Track A "traffic micro-model"
- **Priority:** P0 (blocks simulation core)
- **Status:** decided / committed — 2026-08-27
- **Affected tasks:** F4 (car-following), F5 (control & arbitration), F2 (config additions), F3 (geometry/baseline outputs), F7 (delay metric), O1 (sweep candidate space), Q1 (soak/determinism assertions)
- **Delegation record:** deep-research track agent (ultron pipeline, deep-research-supreme), 2026-08-27. Primary sources consulted directly; links, versions, dates and exact supporting claims in §Evidence.

---

## 1. Question

Commit ONE deterministic car-following + intersection conflict/arbitration model with:

1. a concrete **no-overlap guarantee at fixed dt** (100–120 ms),
2. a concrete **fixed-time signal phase structure** (how lefts are served across lane configs 1–3; what the green-split candidate space for the optimizer is),
3. the exact **per-turn free-flow baseline formula** the control-delay metric uses.

Constraints (from approved scope): deterministic seeded sim, fixed timestep, TS, Canvas 2D, one fixed 4-way intersection, 1–3 lanes/arm with per-lane turn designations, intersection-level control = fixed-time signal OR all-way stop (full stop, FIFO departure, right tiebreak, left yields oncoming through), 150+ concurrent cars at <4 ms/tick sim budget, believable queueing/spillback, control-delay headline = actual − free-flow travel time, paired-seed optimizer sweeps green splits.

Evaluation criteria: (a) believability of queueing/spillback/stop-and-go; (b) hard no-overlap at fixed dt, provable not aspirational; (c) determinism (pure functions of state + isolated RNG); (d) compute budget; (e) composability of one conflict substrate with BOTH control modes (signal incl. permissive phases, and stop-sign FIFO + left-yield + right tiebreak); (f) honesty of the delay metric vs HCM control-delay semantics; (g) implementability in ~2 medium tasks (F4, F5).

---

## 2. The Commitment (summary)

| # | Decision | Commitment |
|---|---|---|
| D1 | Car-following | **"Guarded IDM"**: IDM desired acceleration (ballistic update, dt = 100 ms) + bounded-deceleration safe-speed caps (Krauss/SUMO lineage) + terminal gap clamp (the unconditional invariant). 3 layers; layers 1–2 give believable smooth dynamics, layer 3 carries the proof. |
| D2 | Intersection arbitration | **Claim-based conflict-point arbitration** (Dresner–Stone AIM lifecycle adapted from tiles to exact path conflict points, cf. Levin & Rey conflict-point formulation). One substrate; signal and stop-sign are *gates* that decide when a claim may be granted. Permissive left / left-yield uses a deterministic gap test (worst-case oncoming arrival), not stochastic gap acceptance. |
| D3 | Signal structure | **"NEMA-lite" sequential ring, 2–4 phases**: [NS protected-left?] → NS thru/right → [EW protected-left?] → EW thru/right. Protected-left phase per axis exists iff that axis has a dedicated left lane (config override). Lefts permissive otherwise. Fixed-time (no phase skipping). Yellow/all-red computed from geometry (FHWA formulas), fixed, never swept. Optimizer sweeps integer-second green splits at fixed cycle. |
| D4 | Free-flow baseline | **Fixed influence zone around the intersection** (entry gate = comfortable stopping distance upstream of stop line; exit gate = re-acceleration distance downstream of box exit). Baseline FF(p) = closed-form time of the canonical unimpeded trajectory (cruise / decel b / turn at v_t(p) / accel a). Control delay = (t_exit − t_entry) − FF(path). |

---

## 3. Q1 — Car-following model and the no-overlap guarantee

### Options considered

**Option 1 — Pure IDM, ballistic update (Treiber).**
- Fit: best-documented believability (25 years of validation; realistic queue discharge, stop-and-go, speed-dependent equilibrium headway). The reference for "queueing you can see" — Treiber's own applet demonstrates intersection queueing with IDM.
- Guarantee: **none at fixed dt.** The collision-freeness claim in the literature is continuous-time only. Treiber's official page documents the discrete-time pathologies: ballistic update "will lead to negative speeds" near stops, and at standstill "it may happen that the actual gap of a stopped vehicle s is slightly below the minimum gap s0" — i.e., discrete IDM can under-run its own minimum gap, and nothing bounds the excursion. Adopting pure IDM means accepting possible overlap — fails acceptance ("no visual car overlap at any time") or bolting on the same safety layer anyway.

**Option 2 — Krauss safe-velocity model (SUMO default).**
- Fit: simple; industrially proven collision-free-by-construction at dt = 1 s (SUMO has run Krauss as default for 20+ years); `v_safe` explicitly "selects a speed that ensures minGap can always be maintained whereas other models may not do this" (SUMO docs).
- Drawbacks: constant-acceleration takeoffs, `min()`-cap deceleration onset (less organic than IDM's smooth interaction term), queue spacing = fixed minGap rather than speed-adaptive, dawdling noise term must be zeroed/seeded for determinism. Believable, but visibly more "robotic" queue dynamics.

**Option 3 — Guarded IDM (RECOMMENDED).**
- IDM supplies the desired acceleration (believability); a bounded-deceleration safe map caps speed (smooth emergency envelope, Krauss/Gipps lineage); a terminal position clamp guarantees the invariant unconditionally (proof below). The caps are computed to essentially never bind in normal following (numerical check in §3.3), so on-screen dynamics are pure IDM; the clamp is an invisible safety net whose activation is counted and asserted 0 in tests.

### 3.1 The model, concretely

Global constants (P1-tunable, defaults committed here):

```
dt        = 0.1 s   fixed timestep (10 ticks/s; render interpolated — F1)
v_c       = 13.9 m/s (50 km/h) approach cruise speed (per arm)
T         = 1.1 s   IDM desired time headway
a         = 1.3 m/s^2 IDM max acceleration
b         = 2.0 m/s^2 IDM comfortable deceleration
s0        = 2.0 m   IDM minimum gap (queue spacing at rest)
delta     = 4       IDM acceleration exponent
len       = 5.0 m   car length (footprint; width for render/claim padding only)
b_e       = 6.0 m/s^2 EMERGENCY deceleration — hard bound on |decel| for every car, every tick
s_min     = 0.5 m   hard floor on net bumper gap (clamp/assert threshold)
a_lat     = 1.7 m/s^2 comfortable lateral acceleration for turn speed
```

Per tick, per car (on a 1-D path-arclength coordinate; see leader rule below), update **front-to-back along each path chain** (leader already updated when follower computes — deterministic sequential update, Gipps precedent):

1. **IDM desired acceleration** (Treiber, Hennecke, Helbing 2000):
   `a_idm = a * [ 1 − (v/v_c)^delta − (s_star / g)^2 ]`
   with `s_star = s0 + max(0, v*T + v*dv/(2*sqrt(a*b)))`, `g` = net bumper gap to leader (or to virtual leader), `dv = v − v_leader`.
2. **Ballistic candidate:** `v1 = clamp(v + a_idm*dt, 0, v_path_max)` where `v_path_max = min(v_c, v_turn_ahead)` (turn-speed limit ahead, from F3 path data).
3. **Safe map (layer 2) — two caps, both applied every tick:**
   - `v_safe = max(0, sqrt(v_l^2 + 2*b_e*(g − s_min)) − b_e*dt)` — the Krauss/SUMO-form safe speed ("stop before the leader's stop position, both braking at ≤ b_e, minus one-tick reaction buffer"). Covers the high-speed regime.
   - `v_headway = max(0, v_l_next + (g − s_min)/dt − b_e*dt/2)` — discrete headway check: this tick's displacement can never eat the remaining gap even at crawl/standstill, even if the leader brakes at b_e for the whole tick. Covers the low-speed regime where `v_safe`'s continuous argument is weak (at v→0 the equal-braking argument degenerates — this is exactly why Treiber's page sees s < s0 at standstill).
   - `v1 = min(v1, v_safe, v_headway)`.
4. **Stop-within-tick handling** (Treiber's fixup): if `v + a_idm*dt < 0`, stop within the interval at constant decel: `v1 = 0`, `x1 = x − v^2/(2*a_idm)` (never negative displacement).
5. **Position:** `x1 = x + (v + v1)/2 * dt` (ballistic; exact for constant acceleration, Treiber & Kanagaraj's recommended scheme).
6. **Terminal clamp (layer 3 — the invariant):** `x1 = min(x1, x_leader_final − len_leader − s_min)`; then **derive velocity from actual displacement**: `v1 = max(0, (x1 − x)/dt)`. If the clamp fires (it must not, given layers 1–2; counted and asserted), the car momentarily brakes harder than b_e for one frame — an invisible, logged safety net, never expected on screen.

**Leader rule.** A car's leader is the nearest car ahead whose current path segment overlaps the follower's current path segment: same approach lane up to the stop line; same (lane, turn) path inside the box and on the exit. **Virtual leaders:** (a) red signal / stop-sign hold / denied claim ⇒ virtual stopped leader (v = 0) at the stop line; (b) a conflict zone entry held by a non-following car (cross/merge traffic) ⇒ virtual stopped leader at the zone boundary; (c) exit-lane full ⇒ virtual stopped leader at the box exit... (c) is instead enforced by the claim precondition (exit headroom, §4.2) so cars never enter without exit space; the virtual leader remains as belt-and-braces.

**Dilemma-zone rule (yellow):** a car may legally enter the box on yellow only if it cannot stop comfortably before the line: `v^2 / (2*b) > distance_to_stop_line`. Otherwise the stop line becomes a virtual stopped leader. Deterministic, mirrors real yellow semantics, avoids unbelievable 6 m/s² stops at speed.

### 3.2 No-overlap argument (explicit discrete-time proof)

Documentation does not hand us a fixed-dt proof (Treiber's own page only offers fixups; the 25-years review claims crash-freeness in continuous time "as long as the physical braking limits are not exceeded"). The guarantee here is argued directly.

**Contract.** All cars: (i) move only along their fixed path (no lane changes — MVP non-goal); (ii) never move backward (v ≥ 0); (iii) updates are sequential front-to-back along each path chain, so a follower always clamps against its leader's *final* new position for this tick.

**Theorem (same-path no overlap).** If initial net gaps ≥ s_min, then after every tick all same-path net gaps are ≥ s_min ≥ 0 — regardless of what the acceleration model computes, and for any dt.

*Proof.* Induction on ticks. Within a tick, consider a follower f with leader l (already updated). Its new position is `x_f' = min(x_f_ballistic, x_l' − len_l − s_min)` ≥ `x_f` (the clamp can only remove forward motion: `x_l' − len_l − s_min ≥ x_l − len_l − s_min = g_old_gap_position ≥ x_f` because `x_l' ≥ x_l` — leaders never move backward — and the old gap was ≥ s_min by the induction hypothesis). Hence `g' = x_l' − x_f' − len_l ≥ s_min`. Every follower in the chain is processed against an already-final leader, so the bound holds for all pairs simultaneously. ∎

**Theorem (cross-path no overlap).** No two cars on different paths ever have intersecting footprints inside the box, given: (a) F3 computes, for every ordered pair of movements, the set of *conflict zones* = footprint-padded regions where the two paths cross or merge (conservative superset of geometric intersection; see §4); (b) a car may not cross its first conflict zone until it holds exclusive claims on all conflict zones of its movement (granted before stop-line entry — request distance ≥ stopping distance at current speed, so denial ⇒ car stops at the line via the virtual leader); (c) a claim is released only after the holder's *rear bumper* clears the zone (+ safety margin). At most one holder per zone ⇒ at most one car's footprint inside any zone at any time. Cars outside the box are on disjoint lane segments (per-lane paths don't touch), so no other cross-path encounters exist. ∎

**Why layers 1–2 exist if layer 3 suffices:** layer 3 alone would permit visually broken behavior (a bug or an aggressive IDM parameter would surface as a teleport-stop when the clamp fires). Layers 1–2 make the clamp provably unreachable in normal operation: `v_safe` and `v_headway` are exactly the two worst-case analyses (high-speed braking-to-stop with both cars at b_e; low-speed per-tick displacement) under the stated contract. Numerical sanity check at equilibrium following (v = v_l = 13.9, IDM gap s* ≈ s0 + v·T = 17.3 m): `v_safe ≈ sqrt(13.9² + 2·6·16.8) − 0.6 ≈ 20 m/s` (never binds), `v_headway ≈ 13.9 + 168` (never binds); at crawl (v = 1 m/s, g = 3 m): `v_safe ≈ sqrt(2·6·2.5) − 0.6 ≈ 4.8`, `v_headway = 25` — IDM itself is the binding constraint in all normal states. The caps engage only when IDM under-brakes vs the contract (e.g., a queue stops abruptly just beyond a turn's sightline) — precisely when an emergency stop is the believable action.

**Spillback/spawn.** The spawner holds a spawn when the entry segment lacks `s_min + v_c·T` of room (demand truncation, deterministic); queues back up the arm — believable spillback without ever pushing cars into the box without exit space.

**Budget.** Per car per tick: ~30 flops + 2 sqrt. 150 cars ⇒ « 4 ms/tick (sub-microsecond/car arithmetic; GC-free typed arrays per F4 store). dt = 0.1 s is safe per Treiber ("any update time steps below 0.5 seconds will essentially lead to the same result") and matches Dresner–Stone's simulator.

### 3.3 Parameter notes (string stability)

Per the 25-years review, low-speed string stability roughly requires `a ≥ s0/T²`; with s0 = 2.0, T = 1.1 that is 1.65 m/s², so the committed a = 1.3 sits mildly string-unstable — deliberate: mild instability is what produces believable stop-and-go waves and jam growth (the gridlock-risk preset needs it), and the safe map bounds the resulting decel excursions. If P1 tuning wants steadier discharge, raise a toward 1.5+ (review: "a > 1.5 m/s² yield a stable IDM under nearly all other plausible parameter combinations").

---

## 4. Q2 — Intersection conflict resolution

### Options considered

**Option 1 — Gap acceptance (HCM unsignalized / permissive-left model).** Probabilistic, calibrated to *human* gap perception (critical gaps, follow-up times, adjustment factors). A deterministic variant degenerates into "is the conflicting stream empty enough" — i.e., an occupancy check. Problems: it reasons about gaps in a *stream*, not exclusive space-time rights, so it provides no no-overlap argument inside the box; it needs critical-gap constants that are meaningless for deterministic cars; composing it with signal permissive phases means a second, different mechanism. Rejected as the substrate (a deterministic *gap test* survives as one gate inside Option 3, below).

**Option 2 — Full tile-based reservation (Dresner & Stone AIM as published).** n×n spatial tiles × 0.1 s timesteps; manager simulates each requester's trajectory and reserves tile-time cells. Proven, and — decisively — the authors *already built stop-sign and traffic-light policies as thin gates over the same substrate*, demonstrating the composability we need (see Evidence §E5). Drawback for us: tiles are a spatial-temporal discretization of a thing we possess *exactly* — the paths. Tiles forced Dresner–Stone to add static + time buffers, and edge buffers, purely to patch discretization artifacts ("Even in simulation, artifacts resulting from the discretization of time are enough to weaken the reservation tiles' guarantees of exclusivity"). With ≤ 12 movements and precomputed geometry we can use exact per-pair conflict zones instead.

**Option 3 — Claim-based conflict-point arbitration (RECOMMENDED).** Dresner–Stone's claim lifecycle on Levin & Rey-style conflict points.

### 4.1 Definitions

- **Movement** m = (approach lane, turn) ⇒ one fixed path (F3). Movements per intersection ≤ 12.
- **Conflict zones** C(m): for each movement pair (m, m′), the footprint-padded crossing or merging regions along m's path (precomputed by F3 from path geometry + car length/width; conservative superset of true overlap). Same-arm/diagonal non-conflicting pairs yield empty sets. Through paths on the same axis conflict only with cross-axis and opposing-left paths; merge zones cover shared exit lanes.
- **Exit headroom** for m: the target exit lane's rearmost occupant leaves ≥ `s_min + v_c·T` of space at the exit boundary.

### 4.2 Claim lifecycle (concrete rules)

```
APPROACH ──(request when distance_to_stop_line ≤ stopping distance + margin)──▶ PENDING
PENDING ──(grant, tick T)──▶ CLAIMED          # may cross the stop line
CLAIMED ──(front bumper passes stop line)──▶ IN_BOX
IN_BOX ──(rear bumper clears last conflict zone + margin)──▶ CLEARED (claims released)
PENDING ──(deny)──▶ PENDING (retry next tick; stop line = virtual stopped leader)
```

**Grant rule (per tick, deterministic order).** Requests are evaluated in FIFO order of stop-line arrival (timestamp = tick the car came to a stop / reached the request line, whichever first); ties broken by arm order (N, E, S, W) then lane index. A request by car c (movement m) is granted iff ALL:
1. **Authority:** control grants m at tick T (see gates below);
2. **Exclusivity:** no conflict zone in C(m) is held or reserved by another car (claims of green-through cars included — this is Dresner–Stone's "off-limits tiles" logic in reverse);
3. **Left-yield gate** (only for lefts under yield authority): no oncoming movement with a conflicting zone satisfies `predicted_arrival ≤ τ_clear` (worst-case prediction: oncoming car accelerates to v_c immediately; τ_clear default 4.0 s, P1-tunable — order of magnitude consistent with HCM permissive-left critical gaps of ~4–5 s, deliberately not cited to higher precision) AND no oncoming car is IN_BOX on a conflicting path;
4. **Exit headroom:** target exit lane has room (prevents box blockage / gridlock-by-deadlock; forces queue spillback onto the arm instead);
5. **Car-following safety:** the car can still physically reach the stop line at ≤ b_e (always true by the request-distance rule).

**Gates by control mode (the composability payoff):**
- **Signal mode:** Authority = movement has green. Protected movements (green arrow): granted unconditionally subject to 2/4. Permissive lefts (green ball): granted subject to 2/3/4. Through/right on green: 2/4. On yellow: only dilemma-zone-eligible cars (§3.1) may still claim. On red: no grants (cars in box hold claims until CLEARED — cross traffic's first green grant happens after all-red, and even then is blocked by rule 2 until the box is clear — exactly Dresner–Stone's FCWS-Light off-limits-tiles mechanism).
- **All-way stop:** a car may request only when stopped at the line (v < ε; scope: full stop). Authority = the car holds the FIFO ticket among stopped cars across all arms (right tiebreak for simultaneous stops: the car to the right departs first; left-turners additionally pass gate 3). This is Dresner–Stone's stop-sign policy: reservations granted only to stopped vehicles, FIFO order emerges.

**Deadlock freedom (argument).** Grants are acyclic: FIFO total order + fixed tiebreak ⇒ no cyclic wait among PENDING cars; granted cars always complete because exit headroom (rule 4) guarantees forward space, exit lanes drain (their heads eventually despawn), and approach queues are held outside the box. The only waits are on leaders (same-path, always progressing) and on earlier FIFO tickets (always completing).

**Right-on-red:** deliberately not modeled (MVP scope minimalism; config-off permanently this phase).

---

## 5. Q3 — Fixed-time signal phase structure

### Options considered

**Option 1 — Simple 2-phase (NS / EW), permissive lefts only.** Simplest; correct for 1-lane arms (a shared lane *cannot* be given a protected phase without wasting the whole lane's green). With heavy left demand on shared lanes, permissive lefts starve and block the shared lane — realistic behavior, but leaves the optimizer no left-service lever and undersells the "design your intersection" play at 2–3 lanes.

**Option 2 — Full NEMA dual-ring, 8 phases, lead/lag/overlap options.** Over-engineered: dual-ring concurrency across barriers doubles optimizer dimensionality; lead-lag and yellow-trap handling add UI/logic complexity aimed at *coordinated/actuated* systems (FHWA: lead-lag "generally used … in a coordinated signal system"), which are explicit non-goals.

**Option 3 — "NEMA-lite" sequential ring (RECOMMENDED).** Standard-aligned, config-derived, optimizer-friendly.

### 5.1 Phase plan (committed)

Ring (fixed order, single sequence, repeats): 

```
[ P1: NS protected lefts (optional) ] → P2: NS through+right →
[ P3: EW protected lefts (optional) ] → P4: EW through+right
```

- Each green phase is followed by **yellow** then **all-red** (fixed, computed, below). Lead-only left sequencing ("the most commonly used left-turn phase sequence" per FHWA).
- **Left service across lane configs:**
  - 1 lane/arm: leftMode = permissive (no protected phase exists for a shared lane); 2-phase plan. Lefts claim on through-green via the yield gate.
  - 2–3 lanes/arm: if any arm on an axis has a dedicated left-only lane ⇒ protected-left phase available on that axis (default ON; user override to permissive). 4-phase plan. Lefts in the protected phase claim unconditionally (2/4); through/right phase serves the rest; permissive lefts during their own through phase remain possible only when leftMode = permissive.
  - Protected+permissive (green arrow then ball): deferred (P1+) — it is a display/claim-gate refinement, not a structural change.
- **Fixed-time semantics:** no phase skipping, no actuation (non-goal). Empty protected phases run their duration — honest fixed-time behavior and deterministic optimizer comparisons.
- **Change intervals (computed at config time from F3 geometry, never swept, never user-scaled):** yellow `y = t_r + v_c/(2·a_y)` with t_r = 1.0 s, a_y = 3.0 m/s² (≈10 ft/s², ITE/FHWA values; Kell & Fullerton form; MUTCD range 3–6 s ⇒ y ≈ 3.6 s ✓); all-red `r = (W + len)/v_c` with W = cross-street width to clear (≈ 1.1 s at 3 lanes; ≤ 6 s ✓). These encode the box-clearance safety the claim layer then enforces exactly.

### 5.2 Optimizer candidate space (O1)

- **Variables:** green durations `g_i ∈ ℤ seconds` of the active phases ONLY.
- **Constraints:** `Σ g_i = C − Σ lost_i` (cycle C fixed per plan — presets 50/60/80 s, user-settable, NOT swept in the default sweep); `g_i ≥ g_min = 5 s`; lost_i = y + all-red (fixed above).
- **Granularity/candidate count:** 2-phase (C = 60, lost ≈ 8.8 ⇒ usable 51 s): all splits at 1 s ⇒ 42 candidates. 4-phase: two-stage grid — coarse pass at 5 s granularity, then 1 s refinement within ±3 s of the top-3 coarse plans (keeps total ≤ ~100 candidates × 3 paired-seed reps, fitting the ≤ 30 s sweep budget per R2/O1).
- Ranking metric: mean control delay (§6) over paired-seed reps; deterministic candidate enumeration order.

---

## 6. Q4 — Free-flow baseline and control delay

### Options considered

**Option 1 — stop-line-to-stop-line.** Excludes deceleration before the line and acceleration after it — both are components of HCM control delay ("delay brought about by the presence of a traffic control device, including … vehicles slowing in advance of an intersection, queue time, stopped time, and acceleration delay"). Understates the headline; rejected.

**Option 2 — spawn-to-despawn with per-path baseline.** (Dresner–Stone's choice for their delay metric.) Simple, but couples the metric to spawn discipline and full-arm car-following; queue spillback past the spawn point silently truncates delay; rejected for headline (per-arm *throughput* still measured at despawn in the overlay).

**Option 3 — fixed influence zone (RECOMMENDED).** HCM-aligned: measure inside the intersection's influence area only.

### 6.1 Baseline formula (committed; F3 computes constants, F7 evaluates)

For each path p (approach lane + turn), define fixed gates from geometry:
- **Entry gate:** on the approach at distance `U = v_c²/(2·b) + v_c·dt + 2 m` before the stop line (comfortable stopping distance + tick + margin) — any legal controlled trajectory begins decelerating inside the zone. (Constrains F3: approach arm length ≥ U + queue storage; with b = 2.0, U ≈ 50 m.)
- **Exit gate:** past the far end of the turn arc at distance `D = (v_c² − v_t(p)²)/(2·a) + 2 m` (re-acceleration distance + margin). (Constrains F3: exit arm ≥ D.)

**Per-turn speed:** `v_t(p) = min(v_c, sqrt(a_lat · R_p))`, R_p = turn radius from F3 path geometry, a_lat = 1.7 m/s² (≈0.17 g — within the Green Book's low-speed urban side-friction range 0.16–0.31; physics v² = g·R·f). Right turns (tighter R) come out slower than lefts — believable.

**Free-flow time FF(p)** — closed form of the canonical unimpeded trajectory through [entry gate, exit gate]:

```
FF(p) = (L_cruise_in)/v_c                                  # entry gate → decel start
      + (v_c − v_t)/b                                      # decel at comfortable b
      + L_arc(p)/v_t(p)                                    # turn arc at v_t (L_arc = 0 motion if through: v_t = v_c, degenerates)
      + (v_c − v_t)/a                                      # accel at a
      + (L_cruise_out)/v_c                                 # accel end → exit gate
```

with `L_cruise_in = (U − (v_c² − v_t²)/(2b))`, `L_cruise_out = D − (v_c² − v_t²)/(2a)`; segment times for constant-accel phases use distance/(mean speed) equivalently. All inputs are F3 geometry + the model constants above ⇒ FF(p) is an exact constant per path.

**Control delay per car:** `delay = (t_exit − t_entry) − FF(p)`, where t_entry/t_exit are front-bumper gate-crossing times (sim time, tick-quantized ⇒ a perfectly free-flow car measures delay ∈ [−dt, +dt] ≈ 0 — exactly the F7 acceptance test, by construction).

**Aggregates:** headline = rolling-window mean over completed trips; overlay adds per-arm means, stopped-time (v < 0.5 m/s inside zone), throughput (veh/h at exit gate), max queue per arm/lane. Optional overlay garnish: HCM LOS bands (A ≤ 10 … F > 80 s/veh). **Honesty caveat (documented, not hidden):** during full-arm spillback, per-car zone delay saturates while the queue keeps growing — the overlay's max-queue metric is the unbounded signal in that regime (gridlock-risk preset relies on this).

---

## 7. Evidence (primary sources; all accessed 2026-08-27)

**E1 — IDM original + official implementation notes.**
- Treiber, M., Hennecke, A., Helbing, D. (2000). "Congested traffic states in empirical observations and microscopic simulations." *Physical Review E* 62(2), 1805–1824. (The IDM paper.) https://journals.aps.org/pre/abstract/10.1103/PhysRevE.62.1805
- Treiber's official model page (version: living doc of traffic-simulation.de, the author's site): https://traffic-simulation.de/info/info_IDM.html — exact claims: simulation "means to numerically 'integrate'" with the **ballistic method** (constant acceleration per step; v(t+Δt)=v(t)+(dv/dt)Δt; x(t+Δt)=x(t)+v(t)Δt+½(dv/dt)Δt²); "**any update time steps below 0.5 seconds will essentially lead to the same result**"; ballistic updating "will lead to negative speeds whenever the end of a time integration interval is not exactly equal to the true stopping time" (with the stop-within-interval fixup given); at standstill "it may happen that the actual gap of a stopped vehicle s is slightly below the minimum gap s0"; parameters: T realistic 0.8–2 s, s0 = 2 m ("kept at complete standstill, also in queues that are caused by red traffic lights"), b realistic ≈ 2 m/s². **Supports:** ballistic update at dt = 0.1 s is the author-endorsed scheme; pure IDM has NO discrete-time no-overlap guarantee (gap under-run documented) ⇒ safety layer mandatory.

**E2 — IDM 25-years review (numerics + safety claim limits).**
- "Twenty-Five Years of the Intelligent Driver Model" (Treiber, Kesting et al., 2025), arXiv:2506.05909v1. https://arxiv.org/html/2506.05909v1 — exact claims: Treiber & Kanagaraj (2015) compared "Euler method, ballistic update, Heun method … and standard fourth-order Runge-Kutta" and "the ballistic scheme is the best for all practical purposes"; "Most researchers and simulators, including SUMO, use this scheme"; IDM collision-free "**as long as the physical braking limits are not exceeded**" (continuous-time claim; the model "can't crash by design" so it is unsuitable for safety studies); string stability: "Higher sensitivity increases instability, while larger values of a and b improve stability", low-speed condition "a ≥ s0/T²", and "a > 1.5 m/s² yield a stable IDM under nearly all other plausible parameter combinations". **Supports:** ballistic choice, a/b tuning rationale, and the explicit framing that IDM safety is a continuous-time property — our discrete guarantee must come from elsewhere (§3.2).

**E3 — Krauss/SUMO safe velocity (the industrial precedent for layer 2).**
- SUMO docs, Car-Following-Models: https://sumo.dlr.de/docs/Car-Following-Models/index.html — exact claims: "The 'safe' velocity for every simulation step is computed by the configured carFollowModel"; drivers keep a minimum time gap tau (default 1 s) between "the rear bumper of their leader and their own (front-bumper + minGap)"; "the Krauss model selects a speed that ensures minGap can always be maintained **whereas other models may not do this**"; warning that tau below reaction time "manifests as high deceleration or even collisions" (safety is the safe-speed map's job, not IDM's).
- SUMO source formula (sumo-devel list, DLR developers): `vsafe = -1*myTauDecel + sqrt(predSpeed^2 + 2*myDecel*gap)` — the exact lineage of our `v_safe`. https://sourceforge.net/p/sumo/mailman/sumo-devel/thread/AANLkTinAV4qJ3TvObPYxxsJ4jFru83G_3YPpSapj0KwC%2540mail.gmail.com/
- Krauss, S., Wagner, P., Gawron, C. (1997). "Metastable states in a microscopic model of traffic flow." *Phys. Rev. E* 55, 5597 (safe-velocity model origin; reference citation, not fetched).
- Gipps, P. (1981). "A behavioural car-following model for computer simulation." *Transportation Research B* 15(2), 105–111 — the classical derivation of a discrete-time, bounded-deceleration, collision-free update with one-step reaction (precedent for the sequential front-to-back update; reference citation, not fetched). **Supports:** layers 2–3 architecture; "safe speed every step + hard floor" is the state of the practice.

**E4 — Claim/reservation composability (the decisive evidence for D2).**
- Dresner, K., Stone, P. (2008). "A Multiagent Approach to Autonomous Intersection Management." *Journal of Artificial Intelligence Research* 31, 591–656. https://jair.org/index.php/jair/article/view/10542/25241 (also https://www.cs.utexas.edu/~aim/) — exact claims: intersection "divided into an n×n grid of reservation tiles"; protocol: REQUEST (arrival time, velocity, direction, turn, size) → manager "runs a simulation of the vehicle's trajectory through the intersection" at each timestep marking tiles occupied → CONFIRM (token) or REJECT; vehicles "should never collide in the intersection" while following the protocol; discretization artifacts forced static + time buffers ("hybrid buffer") and **edge buffers** for exit safety; simulator timestep 0.1 s. **Decisive composability:** their **stop-sign policy** = FCFS "from vehicles that are stopped at the intersection" (FIFO emerges); their **FCWS-Light** composes a traffic light with reservations — during red, FCFS requests are checked against "off-limits tiles: all tiles that could be used by vehicles with a green or yellow light are considered reserved." Our gates (§4.2) are direct analogues with exact conflict zones replacing tiles. **Supports:** one claim substrate serving stop-sign FIFO, signal greens, and permissive conflicts.
- Levin, M. W., Rey, D. (2017). "Conflict-point formulation of intersection control for autonomous vehicles." *Transportation Research Part C* 85 — reservation-based control simplified to vehicle ordering at path conflict points (existence + formulation verified via abstract; not deep-fetched). https://www.researchgate.net/publication/320576253_Conflict-point_formulation_of_intersection_control_for_autonomous_vehicles — **Supports:** conflict points as the exact, non-discretized substitute for tiles.

**E5 — Signal phasing and change intervals.**
- FHWA Traffic Signal Timing Manual (Koonce et al., 2008; FHWA-HOP-08-024), Ch. 4: https://ops.fhwa.dot.gov/publications/fhwahop08024/chapter4.htm — exact claims: left-turn phasing options "permissive only, protected only, protected-permissive, split phasing, and prohibited"; permissive-only "primarily used when traffic is light to moderate"; protected-only "recognized to provide the safest left-turn operation" but "increases the lost time within the cycle"; lead-lead is "the most commonly used left-turn phase sequence"; NEMA ring/barrier rules (1/2/3/4 ring 1, 5/6/7/8 ring 2, odd = lefts, even = throughs; barrier crossing simultaneous). **Supports:** NEMA-lite structure, per-axis protected-left optionality, lead-only choice, fixed-time lost-time accounting.
- Same manual, Ch. 5: https://ops.fhwa.dot.gov/publications/fhwahop08024/chapter5.htm — exact claims: yellow change term = "the time required for a vehicle to travel one safe stopping distance, including driver perception-reaction time" (t + v/(2a), grade-adjusted); red clearance = "the time needed for a vehicle to traverse the intersection ([W + Lv]/v)"; "the values of t = 1.0 s, a = 10 ft/s², and Lv = 20 ft are often cited"; MUTCD: yellow "approximately 3 to 6 seconds," red clearance "not to exceed 6 seconds." **Supports:** §5.1 change-interval formulas and constants.

**E6 — Control delay definition.**
- HCM definition via FHWA Field Measurement of MOEs (FHWA-HOP-08-054, 2008) §3: https://ops.fhwa.dot.gov/publications/fhwahop08054/sect3.htm — exact claims: HCM defines delay as "The additional travel time experienced by a driver, passenger, or pedestrian"; delay is "the difference between an 'ideal' travel time and the actual travel time" (ideal = unimpeded/free-flow). 
- TxDOT Traffic Signal Program manual, Ch. 4 MOEs: https://www.txdot.gov/manuals/des/tsp/chapter-4-traffic-analysis-methodology--tools--and/4-5-moes.html — exact claim: per HCM, control delay is "delay brought about by the presence of a traffic control device, including delay associated with vehicles slowing in advance of an intersection, queue time (time in queue), stopped time, and acceleration delay after the signal turns green." **Supports:** §6 zone choice (must include decel-before-line and accel-after-line; hence influence zone, not stop-line-to-stop-line).

**E7 — Turn speed from geometry.**
- FHWA Speed Concepts: Informational Guide, Ch. 4: https://highways.dot.gov/safety/speed-management/speed-concepts-informational-guide/chapter-4-engineering-and-technical — maximum side-friction factors from the AASHTO Green Book decrease with design speed, established for driver comfort.
- ASCE J. Transportation Engineering 131(2) (2005), low-speed horizontal curve friction: 2001 Green Book "low-speed urban side friction factors ranging from 0.16 to 0.31 for design speeds of 30–70 km/h," superelevation ≈ 0 at intersections. https://ascelibrary.org/doi/pdf/10.1061/%2528ASCE%25290733-947X%25282005%2529131%253A2%2528112%2529 — **Supports:** v_t = sqrt(a_lat·R) with a_lat ≈ 1.7 m/s² (0.17 g) as a mid-range comfort constant.

---

## 8. Tradeoffs, risks, confidence

**Tradeoffs accepted.**
- Guarded IDM > pure IDM on safety, > pure Krauss on believability, at the cost of ~40 extra lines (two caps + clamp) and one more concept to document. Caps bind ~never, so tuning effort stays on IDM parameters.
- Conflict-point claims > tile reservations on exactness and cost; we lose the tile machinery's generality (irrelevant for a fixed 4-way) and must compute pairwise conflict zones carefully in F3 (padded, conservative).
- NEMA-lite > full NEMA on legibility/optimizer size; loses dual-ring concurrent phasing (irrelevant single intersection, fixed-time) and protected+permissive display modes (deferred P1+, additive).
- Influence-zone baseline > spawn-to-despawn on HCM honesty; requires F3 to guarantee arm lengths ≥ U/D (geometry constraint, satisfied at our canvas scale with ~120 m arms).
- Permissive lefts under deterministic worst-case gap test will be somewhat conservative (opposing car assumed to accelerate to v_c) — left capacity is P1-tunable via τ_clear; determinism is preserved either way.

**Risks.**
1. Claim/zones geometry bugs (F3) could under-cover conflicts — mitigated by Q1 soak with footprint-intersection assertion across ≥ 3 configs incl. randomized lane maps; conflict sets are conservative by construction (padding).
2. Clamp firing would be a correctness smell — clamp counter asserted 0 in soaks; if it ever fires in normal presets, the caps' constants (b_e) get fixed before ship.
3. Fixed-time empty protected phases look inert — visual honesty choice; presets will set left demand accordingly (P1).
4. τ_clear / a_lat / a-b-T constants are defaults, not calibrations — all P1-tunable behind the model-parameter readout in the engineering overlay (per brief).
5. Mild string instability (a = 1.3 < s0/T²) may amplify waves in the 150-car soak — bounded by the safe map; if soak shows excessive oscillation, raise a to ≥ 1.5 (E2's near-universal stability bound).

**Confidence.** D1 guarded IDM + proof: 0.85 (each layer has direct primary-source precedent; the theorem is elementary and implementation-checkable). D2 claim arbitration: 0.85 (composability directly demonstrated by Dresner–Stone's own stop-sign and FCWS-Light policies; conflict-point substitution has literature precedent). D3 NEMA-lite: 0.8 (standard-aligned simplification; the one deviation — no protected+permissive mode in MVP — is additive later). D4 baseline: 0.85 (HCM-aligned closed form; free-flow-car≈0-delay is exact by construction; constants P1).

---

## 9. Implementation consequences and plan updates

- **F2 (config):** add `leftMode` per axis (default: protected iff axis has a dedicated left lane), `cycleLength` (default per preset 50/60/80 s), global `dt = 0.1`, per-arm cruise speed, and a model-params block defaulting to §3.1 constants.
- **F3 (geometry):** must additionally output per path: turn radius R_p, v_t(p), conflict-zone list per movement pair (crossing + merge, footprint-padded), entry/exit gate positions, and the closed-form FF(p). Geometry constraints: approach arm ≥ U + queue storage (~50 m + storage), exit arm ≥ D. Free-flow length > 0 acceptance now means FF(p) computable and > 0.
- **F4 (car-following):** implement guarded IDM exactly as §3.1; leader rule incl. virtual leaders (stop line, denied conflict zone); expose clamp-fire counter. Acceptance additions: cap-never-binds + clamp-counter = 0 in normal presets; deterministic replay unchanged.
- **F5 (control & arbitration):** claim manager per §4.2 (lifecycle, FIFO tickets with right tiebreak, left-yield gap test, exit headroom), signal ring per §5.1 (computed y/all-red), stop-sign gate, yellow dilemma-zone rule. Q1 soak asserts footprint non-intersection — the theorems in §3.2 are the design argument; the soak is the proof-by-execution.
- **F7 (metrics):** delay per §6.1 (gate-crossing timestamps, FF from F3); stopped-time/throughput/max-queue per §6.1 aggregates; spillback saturation caveat surfaced in overlay docs.
- **O1 (optimizer):** candidate space per §5.2 (integer-second splits, g_min = 5 s, two-stage grid for 4-phase plans); ranking = mean control delay, paired seeds (R2).
- **Plan.md deltas:** none structural — R1 blocking status clears for F4/F5; F3 scope grows slightly (conflict zones + gates + FF) but stays "medium"; suggest noting in F3/F5 outcomes that Q1's soak is the executable form of the §3.2 invariants.

---

## 10. Decision record

- **Priority:** P0 — blocks F4/F5; informs F2/F3/F7/O1/Q1.
- **Status:** committed 2026-08-27 by Track A research agent; safe to start F4/F5 against this spec; constants are defaults owned by P1 tuning.
- **Return-to-town-hall triggers (per plan assumptions):** if per-turn free-flow baselines prove unstable at allowed geometry sizes, or if FIFO+left-yield stop semantics need renegotiation after playtest — otherwise no scope impact.
- **Delegation:** researched and written by the deep-research track agent (ultron pipeline), 2026-08-27; primary sources as cited in §7.
