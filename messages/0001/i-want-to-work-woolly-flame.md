# Stances and piloting: ideal range, the ship's overview, and pilots that fly themselves

## Context

Fleets today fly one way: members hold formation slots on the FC (Follow the FC), and only a personality fleet's FC
brain moves the FC (`toFleetMove`: brawl / kite / snipe / hold on its focus at a personality range). Nothing decides a
ship's *own* range from what it and the enemy fly, so a squishy nano gang has no way to use its speed and reach to stay
alive, a tackler cannot hold point from outside the target's web, and logi sit at a static 30 km anchor whether or not
that keeps them in rep range and out of the enemy's reach.

The user's direction (this session):

- Algorithms that decide a ship's ideal range and maneuvering from both sides' numbers (EVE University's manual and
  advanced piloting pages: kiting, spiralling, orbiting under the guns, range dictation, transversal / angular).
- **Stances at every level**: a fleet, a wing, a squad and a single pilot can each carry a stance, resolved down the
  chain the same way called targets are, and commanders set them for their groups the same way they call targets.
  **Pilots still fall in line on the FC**: with no stance set, behavior stays what it is today.
- The same mechanism manages a fleet's **logi stance**, including the deterministic lever "position this wing / squad
  by orbiting another squad" (logi 20-30 km off the dps to stay clear of AoE).
- Later, a decision LLM drives some ships. Everything a pilot brain reads must be measurable relative to one ship from
  outside the page (a ship-relative overview), and everything it does must be a tool call a model can make (the rule
  the personality brain already follows).

## Decisions (asked and answered)

| Question | Answer |
|---|---|
| Who flies a group's stance | **In line on the leader** (the FC for a fleet; a wing's or squad's leader, the group flying apart on it as `order_fleet` wing/squad moves do today). `formation: "loose"` makes every member fly it on its own. A pilot's own stance flies that pilot alone. |
| Scope | Pure math, stances (document + live orders), the page's pilot brains, the ship-relative overview tool; sliced, one commit per slice |
| For the future decision program | `get_overview` + the hub's existing WebSocket controller protocol documented + a tiny scripted example driver. Time control (pause / step) stays a later feature |
| A losing squishy pilot | Burns out of hostile reach with its prop mod on, stays on grid, re-engages once safe or repaired |

## The stance

```jsonc
// on fleets[], wings[], squads[] and ships[]: the opening stance (like `targets`); order_fleet / order_ship set it live
"stance": {
  "type": "kite",          // in-line | hold | orbit | keep-at-range | approach | kite | brawl | snipe | tackle | support | auto
  "on": "focus",           // focus (own target > the group's called primary > nearest hostile) | a ship id | { "squad": "dps" } (its leader)
  "range": "ideal",        // metres | [min, max] | ideal | optimal | falloff | lock | point | scram | web | reps
  "propMods": "auto",      // never | closing | always | auto
  "formation": "in-line",  // in-line (default): the group's leader flies it, members hold formation | loose: each member flies it
  "disengage": 0.35        // HP fraction to burn out at
}
```

Examples the user approved: `fleets[0].stance = { "type": "kite", "range": "ideal" }` (the FC kites, everyone stays in
line); `fleets[0].stance = { "formation": "loose" }` (small gang: every pilot flies its role: dps / ewar / boost `auto`,
tackle `tackle`, logi `support`); `squads[logi].stance = { "type": "orbit", "on": { "squad": "dps" }, "range": [20000,
30000], "formation": "loose" }`; `ships[4].stance = { "type": "brawl", "range": "ideal" }` (that pilot leaves formation).

## Destiny facts the math is built on (verified this session)

- Velocity relaxes in a straight line: v(t) = v_target + (v0 − v_target)·e^(−t/τ), τ = mass·agility/1e6 (BPC
  `Integrate` 3377-3393); 1 s ticks; orders apply at the next boundary; re-issuing an order every tick does not jolt.
- **The legacy orbit** (`EvolveOldStyleOrbit`, BPC:3247-3308; `g_useNewOrbit` is off) aims at the tangent point of
  the ordered circle with a Gaussian blend exp(−(r−dist)²/40000) and always full thrust, so it settles wider and slower
  than ordered. **A 2D 1 s-step simulation of that exact rule reproduces Destiny's measured orbits to the metre**
  (checked in Python this session): Rifter on Rifter, ordered → flown / speed / angular: 0 → 312 m / 56 % / 39.2°/s,
  500 → 867 / 76.4 % / 21.5, 1 km → 1,355 / 85 % / 15.7, 2.5 km → 2,796 / 94.6 % / 8.6, 5 km → 5,242 / 98.2 % / 4.8.
  An MWD Rifter (3,240 m/s, τ 3.38 s) ordered to 10 km flies 13.1 km at 83 % (player lore: "orbit 7.5 km with MWD
  holds 11-12 km"); a Caracal on MWD ordered to 5 km flies 7.7 km. The continuous closed form under-predicts tight
  orbits by 15-20 %, so the model is the stepped simulation (memoized), inverted by bisection for "what to order".
- Keep-at-range (`EvolveFollow`, 2943-2955) aims at the point on the range sphere along the current line of sight: it
  flies straight away from a closing target (≈0 transversal: "never burn directly away from turret boats") and trails
  a moving target by D·(u/v)^(1/4) (1 km behind 130 m/s → 1,333 m).

Worked envelope (computed this session with the fixture numbers, EVE's expected turret factor E(p) = 0.5(p² + 0.98p +
0.0501), the stepped orbit model, kill rate − 3 × death rate): a max-skills Rifter (MWD on, sig 201) against a
Punisher (MWD on) scores best at **10-11 km** (out 50 / in 7 dps), stays good from ~9 to ~14 km, and loses the trade
inside ~7 km (at 4 km: out 106 / in 110). To fly 10 km in orbit it must order ~6.8 km. A Caracal against a Megathron:
the blasters still apply ~30 dps at 30 km and ~6 at 40 km, the heavy missiles apply in full, and the Caracal's lock is
71.9 km (inside its 86.9 km missile lower range), so its window is roughly 42-70 km and it out-runs the Megathron's
MWD (1,913 vs ~1,135 m/s): it dictates range. A Rifter orbiting a lone Megathron at ~870 m without its MWD (369 m/s,
0.32 rad/s) takes ~0 (the large blasters' tracking term is ≈ 41, so p ≈ 0) while applying all of its 117 dps (E(p) ≈ 1.0): under the guns, MWD off
(drones are not modelled, so nothing else can touch it).

## The outside program (future decision LLM)

Nothing new is needed to reach the page: the hub's WebSocket already takes controllers (`hub.ts:13-24`, what
`RemoteHub`, the CLI `call` and a second `scene-director mcp` use). Any process on the machine:

```text
→ { "type": "hello", "role": "controller" }
→ { "type": "call", "id": 1, "name": "get_overview", "args": { "ship": "blue-03" } }
← { "type": "result", "id": 1, "ok": true, "value": { … } }   (or ok: false, error { message, problems? })
```

No auth (127.0.0.1 only), page tools go to the newest tab, no push channel (poll each tick), 60 s timeout per page call.
**The simulation only advances on animation frames: the tab must stay visible.** An MCP client can instead spawn
`node bin/scene-director.js mcp`, which joins the running hub. What this plan adds for it: `get_overview` (everything
relative to one ship), stances as live orders (intent-level levers a slow model can pull every few seconds while the
page's pilot flies every tick), a controller-protocol sub-doc in the new ref, and a tiny scripted example driver.

## Slices

One commit per slice, in order; each updates `sd-piloting` (and the refs it touches) in the same commit.

### P1 — the piloting math (`packages/scene/src/lib/piloting/`, pure, camelCase)

- `relative.ts`: EVE's overview columns between two ships: surface / centre distance, radial and closing velocity,
  transversal, angular (transversal / centre distance), bearing off the nose, aspect.
- `kinematics.ts` + `orbit.ts`: τ, align, time and distance to a speed, reversal time, straight-chase closing rate;
  `legacyOrbitOf` (the stepped 2D simulation of `EvolveOldStyleOrbit`, memoized) and `orbitOrderFor` (bisection: what
  to order to fly a distance).
- `application.ts`: E(p), applied dps of a weapon set on a target at a geometry (turrets through `turretHitChance`,
  missiles through `missileApplication` and the reach chance from `missileRange`, disintegrators, vortons).
- `profile.ts`: a ship's plain combat profile (speed, signature and τ with the prop mod off and on, HP, weapons, tackle
  ranges and the MWD block, lock range, remote reps).
- `envelope.ts` / `ideal.ts`: out and in dps over candidate ranges and postures, kill rate − risk × death rate, hard
  constraints (kite / snipe never inside hostile scram or web; tackle inside its point; support inside rep reach), the
  window, prop mod choice, who dictates range, `auto`'s choice, reasons.
- `maneuvers.ts` / `pilot.ts`: spiral, kite-at-angle, burn-out, logi support point, band orders on a friendly ship;
  `stepShipPilot` (picture + resolved stance + memory → tool calls with `why`, hysteresis bands).
- Viewer calibration spec: Destiny's real orbits (Harness: Rifter, Guardian, TFI; MWD off and on) against
  `legacyOrbitOf`.

**The ideal range** (vs the focus F, with the hostiles H and friends around; constants named, values tuned in specs):

1. Candidate flown ranges: a grid (250 m to 5 km, 1 km to 30 km, 2.5 km beyond, capped at the lock range) plus
   breakpoints: own optimal, optimal + falloff, missile lower range; each hostile's optimal, optimal + falloff, point /
   scram / web range ± a margin.
2. Postures: orbit (transversal from the orbit model at that range), keep-at-range (≈ F's own transversal), approach;
   prop mod off / on when fitted and not blocked (a scram blocks the MWD).
3. Out = applied dps on F (F's live signature and speed); in = Σ applied dps of every hostile that can lock this ship,
   from its position to the hypothetical spot (this ship's bearing from F at that range); non-focus transversal ≈
   speed × 2/π. Kill rate = out / F's EHP, death rate = (in − reps it receives) / own EHP.
4. Score = kill rate − risk × death rate (risk by type: kite / snipe 3, auto 2, tackle 2, brawl 0.75, support only
   safety). Hard constraints: kite / snipe / support never inside a hostile scram or web + 1.5 km; tackle inside its
   point (or scram) × 0.9.
5. Dictation: compare max speeds (prop mods on, webs applied). If F is faster and its own best range (the same
   function from its side) differs, F dictates: take the posture that suffers least at F's range and flag disengage
   when the score is negative.
6. Window: the contiguous ranges around the best scoring ≥ 90 % of it; act only when the flown range leaves it
   (hysteresis, like `movement.ts`' bands). `auto` picks kite, brawl or snipe by the best score and says why.
7. Refresh every few ticks per pilot (staggered by ship hash) or at once on a new focus, a new hostile in reach or a
   big HP drop; maneuvers re-aim every tick from the cached ideal.

**Maneuvers**: in the window, orbit F at `orbitOrderFor(ideal)` when faster than F (kite, brawl, tackle), else
keep-at-range (snipe, a slower kiter); too close, kite away 30-45° off the line (keeps transversal); too far, spiral
in (aim between F and a perpendicular, re-aimed past 10°); `orbit` / `keep-at-range` / `approach` with `on` are the
deterministic levers (band midpoint, re-ordered only when the band is left or the target changes); `support` holds a
point behind the friends from the hostiles, inside rep reach of them (armor: optimal; shield: optimal + ½ falloff);
**disengage** below `disengage` HP: burn away from the dps-weighted threat centroid, 20° off the line, prop mod on (AB
if scrammed), until outside every hostile's reach + margin; hold there (keep at range on the nearest safe friend);
re-engage at `disengage` + 0.15 HP (shield recharge or logi), or once every hostile that shot it in the last 20 s is
gone (destroyed, warped off or out of awareness). Being merely out of reach is not "safe": it would flap back in.
- Create the `sd-piloting` ref (triggers in `.dbx-claude/dbx-claude.json`, CLAUDE.md index line, README Documentation
  row).

### P2 — stances in the document and as live orders (`packages/scene`)

- `SceneStance` + `readSceneStance` (problems vs warnings as `readSceneAutoRepair` does), `stance?` on `SceneFleet` /
  `SceneWing` / `SceneSquad` (`fleets/fleet.ts`, read in `fleets/normalize.ts`) and on ships (`scene.ts`); edited by
  `update_fleet` / `_wing` / `_squad` / `update_ship set { stance }` (`null` clears).
- **Resolution** (`resolveShipStances`, precedent `resolveAutoRepair` in `logi/auto-repair.ts:124`): ship's own >
  squad > wing > fleet. `type`, `on` and `range` resolve together from the nearest level that sets `type`;
  `propMods`, `formation`, `disengage` key by key; each with its `source`. `flownBy`: the ship itself (own stance or
  loose), else the leader of the group whose level set the type (`resolveFleetOrderRequest`'s leader rule,
  `fleets/orders.ts:389`); no type and not loose → `in-line` (today). Loose with no type → role default (dps / ewar /
  boost `auto`, tackle `tackle`, logi `support`).
- **Live**: `order_fleet { order: { type: "stance", set: {…} | clear: true } }` with the targets order's authority and
  pilot delays; `order_ship { order: { type: "stance", set | clear } }` for a pilot's own (`rejoin` also clears it).
  The live book splices over the document like live calls (`LiveFleetOverlay` in `fleets/live.ts`, plus per-ship live
  stances); never written; a load resets to the document.
- Removal pruning: an `on` naming a removed ship or group falls back to `focus` with a warning (as anchors fall back).
  Timeline: stance orders are `live` cues (`timeline/actions.ts` references, `prune.ts`); a ship `orders` step may set
  a stance (completes `given`). `tools.ts`: `order_fleet` / `order_ship` / `patch_scene` descriptions and schemas.
- Specs: normalize, every precedence path, loose role defaults, the in-line leader rule, authority, splice, pruning,
  cues.

### P3 — `get_overview` (page tool, read-only)

- Extend the facts port once for both brains (DG-1: `Director.BrainFacts` (`director.ts:3971`) grows velocity and
  heading from `world.Motion` and the P1 combat profile; `toFleetPicture` ignores what it does not read). The profile's
  sources: `RunningFlight(flight, false | true)` (`flight.ts:346`) for speed, mass and signature with the prop mod off
  and on; `ShipModules.WeaponKeys` / `Spec` (`modules.ts:453`, `:423`) for turret and missile numbers and the
  point / scram / web activations (`category`, `range`, `falloff`, `targetEffect`); `RemoteRepairers` (`:463`);
  `damage.Health` and the flight's `defense` for HP and resonances; `LockTargeting` for lock range. Keep the new code
  out of `director.ts` (5,135 lines) beyond thin wiring.
- Pure builder `toShipOverview` (P1's `ShipPicture` + the envelope vs its focus + its stance state), plain JSON.
- `get_overview { ship, within?: m (250 km), limit?: rows (25), target?: envelope focus, envelope?: boolean }`,
  `where: 'page'`, a `Director.Handlers()` entry. Rows nearest first: id, name, team / relation, distance, velocity,
  radial, transversal, angular, bearing, aspect, its reach and tackle ranges, its applied dps on this ship now, this
  ship's hit chance and applied dps on it now, locking / locked / shooting this ship, health, target.
- Specs on synthetic facts; verify-page check written ("get_overview measures the fight from one ship").

### P4 — pilots fly their stances (the page)

- `apps/viewer/src/lib/pilots.ts`: `ShipPilots` over `ShipPilotsPort` (node-tested like `AutoRepair` /
  `FleetCommanders`). It steps, each boundary: the leader of every in-line group stance (the FC for a fleet stance),
  every loose member, every ship with its own stance, free ships with a stance. Gate: settled, not warping, arriving or
  destroyed. Builds the picture, runs `stepShipPilot`, runs the actions: `world.Order` (+ `following.Detach` for a
  member), `SwitchPropMods` with reaction delays (`toPilotDelays` keyed on scene ticks), tackle modules on the focus as
  owned modules (AutoRepair's rule: only what it switched on).
- Director: `StepPilots(boundary)` in the `OnBoundary` listener right after `SyncFleetTargets` (sees this boundary's
  calls; orders given there apply this tick); the live stance book in `FleetCommanders` (its overlay); load clears.
- Following (`following.ts`): ships flown by their own or a loose stance are skipped by `Reconcile` like `detached`,
  report `piloting`; an in-line wing / squad stance flies apart on its leader (`BreakAway`) while it lasts and
  regroups when cleared. **No stance anywhere: no change.**
- The FC brain: a stance resolving on a personality fleet's acting FC takes the brain's `move` and `prop-mods` levers
  (it still calls targets and free fire); without one the brain moves as today (no personality spec changes).
- Manual takeover through `Director.Manual`: a model's `order_ship`, `switch_prop_mods` or `switch_modules` on a
  piloted ship (and a ship script's steps) holds its pilot until a stance order or `rejoin`.
- get_state `ships[].stance`: the resolved stance and sources, `flownBy`, `state` (in-line, closing, holding,
  orbiting, kiting, disengaging, waiting, manual, idle), focus, window, ideal, `why`, pending, the last decisions;
  per fleet counts.
- Specs: the controller over a fake port; Destiny-level flights with the Harness (a Rifter holds 9-14 km on a
  Punisher-like target; logi orbit a moving squad leader inside 20-30 km; burn-out at the threshold and re-engage);
  following and fleet-commanders additions. verify-page checks written for dbxpc.

### P5 — the outside program

- `.dbx-claude/refs/sd-piloting/references/controller.md`: the protocol, one `get_overview` per piloted ship per tick,
  intent levers (stance orders) vs raw orders (manual), errors and timeouts, the visible-tab caveat, the MCP route.
- `apps/scene-director/src/pilot-loop.ts`, an additional esbuild entry beside `verify-page.ts`
  (`node dist/apps/scene-director/pilot-loop.js --ship <id> [--port 5520]`): Node's global `WebSocket`, the raw
  protocol, a 1 Hz loop that reads `get_overview` and switches the ship's stance by a simple rule, printing each
  decision. Linted and typechecked with the app.
- README: "What works today" line and the `get_overview` tools row.

### P6 — evidence on dbxpc (handoff)

verify-page `--only "overview|stance"` against tools-core, then the real-GPU look (`windows-chrome` skill): a loose
nano gang (Caracals, a Rifter tackle, a Guardian) against brawlers, the logi orbiting the dps squad at 20-30 km, an
in-line kiting fleet on its FC, fps with 50 loose pilots. Findings go into `sd-piloting`. This Mac has no tools-core
and no GPU, so P6 is a queue item pinned to dbxpc (the S8 precedent).

## Risks and follow-ups

- **Cost**: the envelope is candidates × postures × prop mod states × hostiles per pilot; cache the orbit model, refresh
  ideals every few ticks per pilot (staggered), cap hostiles to those that can reach. Measure with 50 loose pilots in
  P4's specs and on the GPU in P6.
- **Omniscience**: pilots read enemy fits exactly (the sim knows them; EVE pilots infer them by Look At). A fog option
  is a follow-up.
- **Not modelled**: drones, heat, capacitor use, collisions and bumping, AoE weapons (the logi band only spaces them),
  ECM / damps. A lone battleship cannot touch a frigate under its guns here.
- **Nested group stances** (a squad stance inside a wing stance): the nearest level that sets `type` wins per ship;
  `BreakAway` already merges a group apart that lies inside a new one (`following.ts` BreakAway).
- Follow-ups to file: the personality's `movement` as the fleet's default stance (one movement executor for the FC
  brain and the pilots), time control for slow decision programs, EWAR stances (painters, neuts, damps).

## Verification

- Every slice: `dbx-claude-test` (`project: scene`, then `viewer`, then `scene-director` for the tool list and the MCP
  spec), `dbx-claude-build` (`project: scene-director`), `dbx-claude-lint-run`; commit through `dbx-claude-commit`
  (header ≤ 72 chars; declare `refImpact` with `dbx-claude-log`). One commit per instruction: ask the user before each
  further slice's commit (`additionalCommitApproved`).
- P1's anchors: the orbit calibration spec (Destiny's own orbits within 1 % of `legacyOrbitOf`, MWD off and on) and
  the worked envelopes above as spec expectations (Rifter vs Punisher 10-11 km, Caracal vs Megathron ≈ 42-70 km and
  dictating, Rifter under a Megathron's guns with its MWD off).
- P4's anchors: Destiny-level flight specs with the real `stepShipPilot` in the loop (ranges held over 120 s,
  lockstep parks via `BallStates`, the same run twice gives identical ball states).
- On a machine with tools-core and a tab (dbxpc): `stage_engagement` a small gang against brawlers, `order_fleet {
  order: { type: "stance", set: { formation: "loose" } } }`, then `get_overview` on a few ships and `get_state`'s
  `stance` reports; run `pilot-loop.js` against one ship; verify-page `--only "overview|stance"`; the real-GPU look.
