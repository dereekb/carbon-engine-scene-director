# Piloting: stances, the ideal range, maneuvers and pilots that fly themselves

> How a ship decides its own range and maneuvering from both sides' numbers, and the stances that tell it to. The
> plan is `~/.claude/plans/i-want-to-work-woolly-flame.md` (slices P1-P6). **Status: P1, the pure math in
> `packages/scene/src/lib/piloting/`, has landed.** Stances in the document and as live orders (P2), `get_overview`
> (P3), the page's pilots (P4), the outside-program driver (P5) and the dbxpc evidence (P6) are still to come; until
> P4 nothing in the page calls this code. Related refs: `sd-destiny` (the parks, orders, the legacy orbit),
> `sd-combat` (hit chance, missile application), `sd-fleets` (Follow the FC), `sd-personalities` (the FC brain's
> `toFleetMove`, which keeps moving personality fleets until a stance takes its `move` lever in P4).

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
| `envelope.ts` | `PilotContact`, `candidateRangesOf`, `envelopePointOf` (out / in DPS, kill and death rates, who tackles the spot) |
| `ideal.ts` | `idealRangeOf`: scoring, constraints, ties, the window, `auto`, dictation |
| `maneuvers.ts` | kite away, close in / spiral, threat centroid and burn out, out of reach, support point, lever bands and orders, re-aim |
| `pilot.ts` | `stepShipPilot`: picture + stance + memory → `order_ship` / `switch_prop_mods` calls with `why` |
| `piloting.spec-helper.ts` | fixture profiles (Rifter, Punisher, Caracal, Megathron: max skills, default weapons, baked MWD) |

Viewer: `apps/viewer/src/lib/destiny-orbit-model.spec.ts` calibrates `legacyOrbitOf` against the parks.

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
