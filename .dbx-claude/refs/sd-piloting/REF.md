# Piloting: stances, the ideal range, maneuvers and pilots that fly themselves

> How a ship decides its own range and maneuvering from both sides' numbers, and the stances that tell it to. The
> plan is `~/.claude/plans/i-want-to-work-woolly-flame.md` (slices P1-P6). **Status: P1 (the pure math in
> `packages/scene/src/lib/piloting/`), P2 (stances in the document and as live orders), P3 (`get_overview`, the
> ship-relative overview) and P4 (the page's pilots fly their stances, `apps/viewer/src/lib/pilots.ts`) have landed.**
> The outside-program driver (P5) and the dbxpc evidence (P6) are still to come. Related refs: `sd-destiny` (the
> parks, orders, the legacy orbit), `sd-combat` (hit chance, missile application), `sd-fleets` (Follow the FC, the
> `piloting` state), `sd-personalities` (the FC brain's `toFleetMove`; a stance on the acting FC takes its `move` and
> `prop-mods` levers).

## The stance (decided with the user)

A stance can sit on a fleet, wing, squad or ship (`ShipStance`, `stance.ts`), resolved down the chain like called
targets: the ship's own > squad > wing > fleet; `type`, `on` and `range` together from the nearest level that sets
`type`, `propMods` / `formation` / `disengage` key by key. **No stance anywhere: today's behavior (members hold their
formation slots on the FC).** A group's stance is flown **in line by its leader** (the FC for a fleet) with members
in formation; `formation: "loose"` makes every member fly it alone (loose with no type: dps / ewar / boost `auto`,
tackle `tackle`, logi `support`). A ship's own stance flies that ship alone.

| key | values |
|---|---|
| `type` | `in-line` (default) · `hold` · levers `orbit` / `keep-at-range` / `approach` · ideal types `kite` / `brawl` / `snipe` / `tackle` / `support` · `auto` |
| `on` | `focus` (own target > the group's primary > nearest hostile) · a ship id · `{ squad }` / `{ wing }` (its leader) |
| `range` | metres · `[min, max]` · `ideal` · `optimal` · `falloff` · `lock` · `point` · `scram` · `web` · `reps` |
| `propMods` | `never` · `closing` · `always` · `auto` |
| `disengage` | HP fraction to burn out at (`DEFAULT_DISENGAGE` 0.35; re-engage at + `REENGAGE_MARGIN` 0.15) |

`PilotStance` is what one pilot flies: the type resolved (never `in-line`), `on` resolved to a ship id.

## File map (`packages/scene/src/lib/piloting/`, camelCase, no runtime imports)

| file | holds |
|---|---|
| `vectors.ts` | scene-vector helpers (add, scale, unit, angle, `perpendicularTo`, `rotateToward`) |
| `relative.ts` | `relativeMotionOf`: EVE's overview columns (surface / centre distance, radial and closing velocity, transversal, angular, bearing off the nose, aspect) |
| `kinematics.ts` | τ = mass × agility / 1e6, align, `speedAfter` / `distanceAfter`, `timeToSpeed`, reversal (τ ln 2), straight-chase closing |
| `orbit.ts` | `legacyOrbitOf` (the stepped legacy orbit, memoized) and `orbitOrderFor` (what to order to fly a range) |
| `application.ts` | `PilotWeapon` (from turret / missile combat numbers), E(p), `weaponApplicationOf`, `appliedDpsOf`, reach |
| `profile.ts` | `ShipCombatProfile` (flight off / on, EHP, weapons, tackle, lock range, remote reps) and its helpers |
| `stance.ts` | the stance types above |
| `stances.ts` | the document and live side: `readSceneStance`, `checkStanceReferences`, `resolveShipStances`, `StanceOrder` / `readStanceOrder`, `removeStanceReferences`, the book helpers (`groupStanceOf`, `stanceEdited`, `pruneStanceOn`) |
| `envelope.ts` | `PilotContact`, `candidateRangesOf`, `envelopePointOf` (out / in DPS, kill and death rates, who tackles the spot) |
| `ideal.ts` | `idealRangeOf`: scoring, constraints, ties, the window, `auto`, dictation |
| `maneuvers.ts` | kite away, close in / spiral, threat centroid and burn out, out of reach, support point, lever bands and orders, re-aim |
| `pilot.ts` | `stepShipPilot`: picture + stance + memory → `order_ship` / `switch_prop_mods` calls with `why` |
| `overview.ts` | `toShipOverview` (get_overview), `toPilotContact` (page facts → a picture contact), `overviewRelationOf` |
| `piloting.spec-helper.ts` | fixture profiles (Rifter, Punisher, Caracal, Megathron: max skills, default weapons, baked MWD) |

Viewer: `apps/viewer/src/lib/destiny-orbit-model.spec.ts` calibrates `legacyOrbitOf` against the parks;
`apps/viewer/src/lib/pilot-facts.ts` builds the page's side of the facts (`CombatProfileOf`, `TackleOn`,
`RemainingEhpOf`, `IncomingRepsOf`, `HeadingVectorOf`).

## Stances in the document and as live orders (P2)

- **Document**: `stance?` on `SceneFleet` / `SceneWing` / `SceneSquad` (read in `fleets/normalize.ts`) and on
  `SceneShip` (`scene.ts`), read by `readSceneStance` (bad values are problems; unknown keys warn and drop;
  `formation` on a ship warns and drops: a ship's own stance flies it alone). Edited by `update_fleet` / `_wing` /
  `_squad` / `update_ship` `set: { stance }` (whole; `null` clears). An `on` ship must exist and not be the ship
  itself; a group's `{ squad }` / `{ wing }` must be in its fleet (a problem); a ship's own that its fleet does not
  hold only warns (it flies on its focus).
- **Resolution** (`resolveShipStances(scene, { ships })`, every ship in ships[] order): chain ship > squad > wing >
  fleet, the FC skipping squad and wing (as it takes only its fleet's call). `type` + `on` + `range` from the nearest
  level that sets `type` (a level's `range` without a `type` is ignored); `propMods`, `formation`, `disengage` key by
  key; `sources` names each. No type: loose → the role default (`STANCE_ROLE_DEFAULTS`: logi `support`, tackle
  `tackle`, the rest and a ship in no squad `auto`, source `role`), else `in-line` (`flownBy: null`). `flownBy`: the
  ship for its own or a role type or a loose formation; else `fleetGroupLeaderOf` (`fleets/orders.ts`,
  resolveFleetOrderRequest's leader rule with the nearest commander as issuer: the FC for a fleet, a squad's
  commander, else the issuer in it, else its lead, else its first member). A ship that flies its stance gets `pilot`
  (the P1 `PilotStance`: `on` as a ship id, a `{ squad }` / `{ wing }` resolved to that group's leader, `null` =
  focus). An explicit `type: "in-line"` wins over a loose role default.
- **Live**: `order_fleet { order: { type: "stance", set: {…} | clear: true } }` (exactly one; `set` replaces the
  group's stance whole, unknown keys are problems) with the targets order's authority (`resolveFleetOrderRequest`;
  an `on` squad or wing not in the fleet is refused there). The page (`Director.StanceOrder`) stores it in
  `FleetCommanders`' stance book with the order's tick and each pilot's `toPilotDelays` (reported as `respondsIn`;
  applying them is P4's), records `command.last`, and returns `stance` and `ships [{ id, type, flownBy,
  respondsIn? }]`. `order_ship { order: { type: "stance", set | clear } }` sets the pilot's own (`SetShipStance`,
  returns the resolved `stance`); `rejoin` clears a ship's own (live `null` over the document's). Neither takes an FC
  brain's lever (`TakeLevers` skips stance orders). The book splices over the document: group stances through
  `LiveFleetOverlay.stances` (`toLiveFleetScene`, null = cleared), ship stances through `resolveShipStances`'
  `ships`; `Director.ResolvedStances()` is the live resolution. Never written; `Clear` (a load) empties it; it is in
  the time-control snapshot (plain maps).
- **Removal pruning**: `removeStanceReferences` (beside `removeTimelineReferences` at remove_ship, remove_fleet,
  remove_wing, remove_squad) deletes an `on` naming a removed ship, or a squad / wing no longer held, with a warning
  (`fleet "f": squad "logi"'s stance now flies on its focus (its on squad "dps" was removed)`). The book's
  `AfterStanceEdit` does the same live (`pruneStanceOn`), and drops a live entry whose group or ship is gone or whose
  document stance the patch edited (`stanceEdited` ignores a pruned `on`).
- **Timeline**: stance orders are `live` cues; `orderReferences` names `order.set.on` (a ship; order_fleet's squad /
  wing in its fleet), so removing it prunes the cue. A ship `orders` step may be a stance order (completion `given`).
- Tools: the scene format's `stance` paragraph (`STANCE_TEXT` in `tools.ts`), the patch_scene `set` lists, order_ship
  and order_fleet's stance lines and `set` / `clear` schemas (order_fleet's `set` is array | object).

## get_overview (P3)

- **One facts port for both brains**: `Director.BrainFacts` (the FC brains' `FleetShipFacts`) also carries, per live
  ship, `name`, `velocity`, `heading` (`HeadingVectorOf(motion.heading)`), `profile` (`CombatProfileOf`: the flight
  off and `RunningFlight` on, τ from mass × agility, the turret / launcher combat numbers of its online modules,
  point / scram / web ranges by `activation.category` with the web's factor from its maxVelocity postPercent, remote
  repairers as HP/s with optimal and falloff, lock range from `flight.targeting` else `TABLE_PATH_LOCK_RANGE` 50 km;
  EHP from `flight.defense`, else max HP), `propModOn`, `scrammed` / `webFactor` (`TackleOn` over
  `ShipModules.Targeting`: a scram's `blocksMicrowarpdrive`, webs multiplied at their applied effectiveness),
  `remainingEhp` (each layer's HP × its EHP / HP), `layers`, `locks` (locking / locked), `shooting`
  (`ShipModules.FiringAt`: running weapons' targets) and `incomingReps` (`ShipModules.Incoming`). `toFleetPicture`
  ignores them. The profile is rebuilt each call (no cache yet).
- **`toShipOverview`** (pure, `overview.ts`): rows are every other non-`away` ship within `within` (default 250 km,
  surface to surface), nearest first then id, cut at `limit` (25); `counts` gives hostile / friendly / neutral in
  range, `beyond` and `cut`. Relation by team only (both set and equal friendly, different hostile, else neutral).
  Columns from `relativeMotionOf` (`radial` positive while opening, `angular` rad/s, `bearing` off this ship's nose,
  `aspect` off its nose). A non-friendly row gets `incomingDps` (its weapons on this ship at this geometry, this ship's
  live signature and speed; 0 beyond its lock range), `outgoingDps` and `hitChance` (this ship's turrets, paper-DPS
  weighted); a friendly row gets `repairs` when this ship fits remote reps. `targeting` / `shooting` are the row's
  lock and fire on this ship. The envelope's focus: `target` (an unknown one warns and falls back), else its own
  target, else the nearest hostile with a profile; weighed by `idealRangeOf` for the pilot stance's ideal type, else
  `auto`, with `propMods` from the stance; `inWindow` compares the range now; `envelope: true` adds `points` (out / in
  at every candidate range in the ideal's posture and prop mod state); `envelope: false` drops it. Null envelope while
  its profile is pending (a warning). Numbers are rounded (m to 1, m/s to 0.1, rad/s to 4 decimals).
- **The tool**: `get_overview { ship, within?, limit?, target?, envelope? }`, `where: 'page'`, `Director.Overview`
  (checks the args, then `toShipOverview` over `BrainFacts` with `ResolvedStances().get(ship)`); read-only, not
  journaled. verify-page: "get_overview measures the fight from one ship".

## The page's pilots (P4, `apps/viewer/src/lib/pilots.ts`)

- **`ShipPilots`** over `ShipPilotsPort` (node-tested, imports nothing from ./runtime), stepped by
  `Director.StepPilots(boundary)` in the `OnBoundary` listener right after `SyncFleetTargets` (it sees this boundary's
  calls; its orders apply this tick). Each boundary: **take up** the live stances (`Director.ResolvedStances()`), sync
  the **formation**, then step every ship whose stance it flies itself (`stance.pilot` and `flownBy` = itself: an
  in-line group's leader, the FC for a fleet's, every loose member, a ship's own, a free ship's).
- **Response**: a stance that changes while the latest live order_fleet stance order naming the ship is still due
  (`FleetCommanders.StanceDueOf`: that order's tick + its `toPilotDelays` delay) waits as `pending`; the ship keeps
  flying its previous stance (or stays in line) until then. order_ship's own stance applies at once.
- **Formation** (`Formation` → `Director.PilotFormation`): ships flying alone (`fliesAlone`: own, role default,
  loose, or a free ship) go to `FleetFollowing.SetPiloted` (left alone like detached, report `piloting`, keep their
  slot until their pilot's first order, rejoin when the stance ends); an in-line wing or squad stance flies apart on its
  leader (`BreakAway`, only when `following.Apart` differs) and `Regroup`s when it ends. A fleet stance flies the FC:
  members follow it as always. **No stance anywhere: no record, no Formation change, no calls.**
- **Gate**: no facts or no profile (pending numbers), `!Settled`, or `away` (warp, arriving, destroyed) → `waiting`.
- **Picture** from `BrainFacts` (one call per boundary, only when a pilot steps): `toPilotContact` for every non-away
  ship; hostiles / friends by `overviewRelationOf` within `FLEET_AWARENESS_RANGE`; focus = own target if hostile > the
  called target (`FleetTargets.CallOf`) > nearest hostile; anchor = `stance.pilot.on`; `attackedBy` from
  `CombatRules.AttackedAt` (tick × tickSeconds, the DPS window); `now` = boundary × tickSeconds.
- **Calls**: `order_ship` → `world.Order` (a refusal is logged on the decision); `switch_prop_mods` →
  `Director.PilotPropMod` (the pilot's own reaction delay, `toPilotDelays` keyed `pilot|<id>` on the seeded tick); the
  same switch again within `PILOT_PROP_MOD_REPEAT_TICKS` (10) of the last is dropped (the switch is queued, or the
  MWD runs out its cycle). **Tackle**: the ship's point / scram / web (`TackleModulesOf`) run on the focus while it is
  in their range and the pilot fights (not support, disengaging, waiting or idle), switched with `retarget`; it only
  ever stops modules it switched on (`owned`), and stops them when its stance ends.
- **Stagger**: the first ideal's `idealAt` is set back by `unitHash('pilot|<id>') × refresh`, so pilots that start
  together refresh on different boundaries.
- **Manual**: `Director.Manual` (a model's order_ship that is not a stance order or rejoin, switch_prop_mods' switched
  ships, a ship script's steps) and switch_modules touching `prop` / `point` / `scram` / `web` call `ShipPilots.Manual`:
  the pilot holds (`manual`) until a stance order names it (order_ship stance, order_fleet stance: `Release`), a
  rejoin, or its stance changes.
- **FC brain**: `FleetBrainPort.Piloted` (`ShipPilots.Flies`) on the acting FC adds `FLEET_PILOTED_LEVERS` (`move`,
  `prop-mods`) to that step's manual levers; `fc.piloted` reports them.
- **get_state**: `ships[].stance` for every ship with a stance or a pilot record: the resolved stance and sources,
  `flownBy`, `state` (`in-line` for a member its leader flies, `manual`, else the step's), `focus`, `window`, `ideal`,
  `why`, `pending { type, flownBy, at, in }` and the last `PILOT_DECISIONS_KEPT` (6) decisions (`order_ship`,
  `switch_prop_mods`, `switch_modules`, with `why` and any `refused`); `fleets[].stances` counts members by state.
  `get_overview`'s `stance` block is the same report. Cleared on a load, forgotten when a ship goes, in the
  time-control snapshot (`SimOwners` `pilots`).
- **Specs** (`pilots.spec.ts`): the controller over a fake port (own stance, no stance, in-line squad apart and
  regroup, the response delay, manual and release, owned tackle, a snapshot round trip, 50 loose pilots against 10
  hostiles: ~25-30 ms per boundary on this Mac for the steps alone); on the parks with the real `stepShipPilot`: an
  MWD Rifter kiting a Punisher-like brawler (lasers 6 + 2.5 km, an 8 km web) holds 9-14 km from 40 s to 160 s (it
  settles at ~11.5 km: web + 1.5 km), the same run twice gives identical ball states and orders, MWD Guardian logi
  orbit a TFI flying straight inside 20-30 km, and a Rifter burns out at 30 % HP, waits out of reach, and re-engages
  at 60 %. verify-page: "pilots fly their stances: a kiter holds its window and a model takes it over".
- **Cost not yet measured on the page**: `BrainFacts` rebuilds every ship's profile (`CombatProfileOf`) on each call,
  and both the FC brains and the pilots call it once per boundary. Measure on the GPU in P6 before caching per ship.

## Destiny facts the math stands on

- Velocity relaxes in a straight line: `v(t) = v_target + (v0 − v_target) e^(−t/τ)` (BPC `Integrate`), on 1 s ticks.
- **The legacy orbit** (`EvolveOldStyleOrbit`; `g_useNewOrbit` is off): every tick, full cruise thrust toward the
  tangent point of the circle `r = followRange + both radii`, blended into the tangent by `exp(−(r − d)² / 40000)`.
  It settles **wider and slower** than ordered. The closed form under-predicts tight orbits by 15-20 %, so
  `legacyOrbitOf` steps the same rule in 2D (target still, plane fixed; Destiny precesses it 0.001 rad/tick) with the
  exact integrator until it settles, cached on 0.5 m/s, 0.01 s τ, 10 m and 1 m steps (20,000 entries, then cleared).
  It matches the parks within 1 % (the viewer spec: Rifter 0-5 km, Guardian, TFI, MWD off and on). Rifter on Rifter,
  ordered → flown / speed: 0 → 312 m / 56 %, 500 → 867 / 76 %, 1 km → 1,355 / 85 %, 5 km → 5,242 / 98 %; an MWD
  Rifter ordered to 10 km flies 13.1 km at 83 %. `orbitOrderFor` bisects it (16 steps, to 10 m).
- Keep-at-range (`EvolveFollow`) aims at the point on the range sphere along the current line of sight: it flies
  straight away from a closing target (≈ 0 transversal) and trails a moving one.

## The ideal range (`idealRangeOf`)

1. **Candidates** (`candidateRangesOf`): 250 m steps to 5 km, 1 km to 30 km, 2.5 km beyond, capped at the lock range,
   plus breakpoints: every weapon's optimal and optimal + falloff on both sides, hostile tackle ± 1.5 km
   (`TACKLE_MARGIN_METRES`), own tackle × 0.9.
2. **Postures**: `orbit` (speed and angular from the orbit model) and `keep-at-range` (own speed matches the focus,
   angular from the focus's live transversal); prop mod off / on unless `propMods` rules one out or a scram blocks the
   MWD. `approach` is a maneuver and a lever, not a scored posture. An orbit tighter than the ship can fly (even an
   order of 0 settles wider than 1.05 × range + 50 m) is skipped.
3. **Out / in**: out = applied DPS on the focus (its live signature and speed); in = Σ applied DPS of every hostile that
   can lock the spot (this ship's bearing from the focus at that range). The focus shoots with the posture's angular;
   other hostiles with own speed × 2/π. Turrets: paper DPS × E(p), E(p) = 3p under 1 %, else 0.5(p² + 0.98p + 0.0501)
   (1.015 at p = 1). Missiles: reach chance × `missileApplication`. Vortons: application inside optimal only.
4. **Score** = out / focus EHP left − risk × max(0, in − incoming reps) / own EHP left. Risk (`STANCE_RISK`): kite and
   snipe 3, auto 2, tackle 2, brawl 0.75; support scores −death rate only.
5. **Hard constraints**: kite, snipe and support never inside a hostile's scram or web + 1.5 km; kite and snipe also
   never inside the focus's longest **turret optimal** (added in P1: without it a kite against a tackle-less hull
   picks a 500 m orbit, which is brawling); tackle inside 0.9 × its point (or scram). No allowed range: the least bad,
   `constrained: true`.
6. **Ties** (`IDEAL_TIE_SHARE` 1 %): kite and snipe take the farthest tied range, the rest the nearest, and a run of
   tied ranges is held at its middle (a Caracal on a Megathron takes ~0 both under the guns and beyond 42 km: kite
   holds 60 km, brawl 1.25 km).
7. **Window**: the contiguous ranges around the ideal scoring within 10 % of the best (`IDEAL_WINDOW_SHARE`); a pilot
   acts only when it leaves it.
8. **`auto`** weighs snipe, kite and brawl at each one's ideal by out / EHP − 2 × death rate and takes the best, the
   first in that order on a 1 % tie.
9. **Dictation**: max speeds compared (prop mod on, webs applied: `webFactor`). `dictates: 'focus'` when the focus is
   faster; if its own best range (`auto`, no dictation, against this ship alone) lies outside the window, the ideal
   moves there (`dictated`), the posture that suffers least is taken, and `disengage` is set when the score there is
   negative.

**Anchors** (`ideal.spec.ts`, fixture profiles): an MWD Rifter kiting an MWD Punisher holds 10-11 km (out ~46 / in
~6 dps), still winning from 9 to 14 km and losing inside 7 km (at 4 km both apply ~100 dps); a Caracal kiting a
Megathron holds ~60 km in a 47.5-70 km window and dictates; a Rifter brawling a still Megathron orbits ~1 km with its
MWD off (in ≈ 0, out ~118: the large blasters cannot track it); a Megathron brawling a Caracal is dictated to 60 km
and disengages. Drones are not modelled, so a lone battleship cannot touch a frigate under its guns here.

## The pilot step (`stepShipPilot`)

Input: the picture (self with health and its order, focus, the `on` anchor, hostiles, friends, incoming reps, who shot
it and when, `now` in scene seconds), the `PilotStance` and the memory from the last step. Output: `calls` (each a
real tool call: `order_ship { id, order }` or `switch_prop_mods { ships, active }`, with `why`), the new memory,
`state` (`closing`, `holding`, `orbiting`, `kiting`, `disengaging`, `waiting`, `idle`; `in-line` and `manual` are the
page's) and `why`.

- **Refresh**: the ideal is cached in memory and recomputed every `PILOT_REFRESH_TICKS` (5), or at once on a new
  focus, more hostiles, or an HP drop of 15 %. Staggering by ship is the page's job (P4).
- **Fight** (ideal types): in the window, orbit at the ideal's ordered range when it orbits and this ship dictates,
  else keep at range; an order already on the focus is left alone while the range stays in the window. Too close
  (kite, snipe): kite away 40° off the line toward the side it already moves (`KITE_AWAY_DEGREES`). Too far (beyond
  1.1 × the window, or beyond it with no order on the focus): close in, spiralling 45° off the line while the focus's
  weapons reach it, straight otherwise. Directions are re-given only past 10° (`REAIM_DEGREES`). A dictated ideal
  flagged `disengage` burns out.
- **Levers** (`orbit` / `keep-at-range` / `approach` on `on`, else the focus): a band from `range` (± 10 %, at least
  500 m, or `[min, max]`), ordered at its middle (an orbit through `orbitOrderFor`), re-given only when the order or
  its target changes. Logi orbiting the dps squad's leader at `[20000, 30000]` orders the orbit that flies 25 km.
- **Support**: fly to a point 0.8 × repair reach behind its friend (the anchor, else the nearest friend) from the
  hostiles' centre, then keep at range on the friend there. Repair reach: armor / hull optimal, shield optimal + ½
  falloff.
- **Disengage**: at or below `disengage` HP the pilot burns out away from the DPS-weighted threat centre, 20° off the
  line, prop mod on (an AB still runs when scrammed); once outside every hostile's reach (weapons capped at lock
  range, tackle) + 5 km it keeps at range 2.5 km on its nearest friend (else stops). It re-engages at disengage + 0.15
  HP, or once every hostile that shot it in the 20 s before it disengaged is gone. Merely out of reach is not safe.
- **Prop mods**: `never` off, `always` on, `closing` on while closing / kiting away / burning out, `auto` the same plus
  the ideal's choice in the window. Called only when the wanted state differs and the module can run.
- `hold` stops once.

## Gotchas

- `envelopePointOf` measures every non-focus hostile from the spot it would fly to, but breakpoints from non-focus
  hostiles are applied as ranges to the focus (an approximation; fine when the focus is the main threat).
- The orbit model treats the focus as still; a moving focus changes the real transversal.
- Pilots read enemy fits exactly (the sim knows them). A fog option is a follow-up.
- Not modelled: drones, heat, capacitor use, collisions and bumping, AoE, ECM / damps.
