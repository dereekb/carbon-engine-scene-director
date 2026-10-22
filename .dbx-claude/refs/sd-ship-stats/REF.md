# Ship stats, the pilot, and prop mods (MWD / AB)

> The numbers a ship flies by, where they come from (tools-core's SDE through the hub), the pilot's skills, and prop
> mods as live module state with EVE's cycle timing and engine sound. Fetch before touching
> `packages/scene/src/lib/stats/`, `packages/scene/src/lib/prop-mods/`, the viewer's `flight.ts` / `prop-mods.ts` /
> `prop-mod-audio.ts` / `audio.ts`, `DestinyWorld`'s prop mod methods, or the hub's `ship-data.ts` /
> `ship-stats-tool.ts`. How the numbers move a ball: `sd-destiny`.

## Files

| File | Role |
|---|---|
| `packages/scene/src/lib/stats/ship-stats.ts` | `computeShipStats({ hull, overrides, pilot, propMod })`, `propModCycleTime` |
| `stats/skills.ts` | the hard-coded skill table (checked against the SDE via ESI, 2026-10-21; **re-check when CCP rebalances**) |
| `stats/pilot.ts` | `PilotContext`, `MAX_SKILLS_PILOT`, `createPilotContext` |
| `stats/prop-mods.ts` | group 46 modules: `HULL_SIZED_PROP_MODS`, `BAKED_PROP_MODS` (13 modules, SDE 3632936) |
| `prop-mods/prop-mod.ts` | the document's `ships[].propMod` (`normalizeShipPropMod`) |
| `prop-mods/operation.ts` | the `set_prop_mods` patch op |
| `prop-mods/switch.ts` | `normalizePropModSwitch`: the live switch (and what a timeline beat will embed) |
| `apps/scene-director/src/lib/hub/ship-data.ts` | `ShipData`: hull + module values from tools-core's SDE, cached per hub; `PropModByName` |
| `hub/ship-stats-tool.ts` | the `ship_stats` tool and `GET /ship-stats` |
| `apps/viewer/src/lib/flight.ts` | the page's flight numbers (same pipeline as `ship_stats`) |
| `apps/viewer/src/lib/prop-mods.ts` | which module a ship fits and its numbers, `/prop-mod` lookups |
| `apps/viewer/src/lib/prop-mod-audio.ts` | the engine stems a switch posts (node-tested) |
| `apps/viewer/src/lib/audio.ts` | `PageAudio` over `CjsAudioMan` (`sd-runtime`) |

## The math (`computeShipStats`)

Order: the hull's published values → per-ship `stats` overrides → the pilot's skills → an active prop mod. Outputs
`mass`, `maxVelocity`, `agility`, `signatureRadius`, `radius`, `alignTime` (`-ln(0.25) × mass × agility / 1e6` s).
`mass`, `maxVelocity`, `agility`, `radius` are exactly what a Destiny ball takes (`AddBall`, `SetBallMass`,
`SetMaxSpeed`, `SetBallAgility`); throttle is an order's concern.

- **Skills** (all at V via `MAX_SKILLS_PILOT`; no character system yet): Navigation +5 %/lvl max velocity; Evasive
  Maneuvering −5 % and Spaceship Command −2 %/lvl agility; Advanced Spaceship Command and Capital Ships −5 %/lvl agility
  on capitals (via `advancedAgility` / `advancedCapitalAgility` hooks); Acceleration Control +5 %/lvl prop mod speed
  factor; Afterburner −5 %/lvl AB cycle time (every AB requires it, no MWD does). High Speed Maneuvering, Fuel
  Conservation, Warp Drive Operation and Afterburner's cap bonus touch only capacitor.
- `createPilotContext({ skills, defaultLevel })` takes `{ typeID, level }[]` or a Record by skill name/id, so a later
  character system plugs in without changing callers.
- **Prop mod formula** (effects 6730 / 6731 carry no dogma modifiers; the game applies them in code, so it lives here,
  as Pyfa does): **add the mass first**, then `maxVelocity × (1 + speedFactor × thrust / mass / 100)`, plus an MWD's
  signature bloom.
- `stats` (`{ mass, maxVelocity, agility, signatureRadius }`, each optional) replaces published values **before** skills
  and prop mod: `{ maxVelocity: 200 }` flies 250 m/s with max skills. All four together pin the numbers with no SDE.
- **Not modelled**: hull traits, rigs, implants, boosters, command bursts, heat, other modules, capacitor, fitting
  restrictions (a freighter still gets a 500MN MWD), stacking, server tick rounding.

## Where the base values come from

- A ship resolves to an EVE type: explicit `type` wins (number = type id; string = exact English name via
  `dna/resolve?name=`, which sends `typeID` back **as a string**); else the DNA's base `hull:faction:race` in
  tools-core's DNA index (`dna/search`: bare-hull exact matches, lowest type id wins, others reported as `candidates`).
- tools-core's typed dogma sections lack the prop mod attributes, `rigSize` and the capital agility hooks, so those are
  read by attribute id from `sde/typeDogma`.
- **`ship_stats` and `/ship-stats` need a prepared SDE** for the exact `builds.sde` tools-core reports (`sd-dev-env`);
  an unprepared build answers 404 "not prepared" → an `unavailable` error naming the prepare command.
- `GET /ship-stats?dna=&type=&propMod=` (404 unknown hull, 409 ambiguous name, 503 no SDE);
  `GET /prop-mod?module=<name or id>` (404 unknown, 400 for `mwd` / `ab` / `none`, which the caller sizes, 503 no SDE).
- **tools-core's `dna/resolve` answers 500 for module names** (modules have no graphic). The hub resolves prop mod names
  from the group 46 listing (`sde/types?field=groupID&value=46&limit=1000`, once per hub, `ShipData.PropModByName`).
- The page caches lookups per page session; failures are cached with the hub's message until `ForgetFailures` (every
  `load_scene` / `open_scene`).

## Prop mods in the document

`propMod`: `"50MN Microwarpdrive II"` or `{ "module": "10MN Afterburner II", "active": true }`. A module is a type name
(case-insensitive, `MWD` / `AB` read as Microwarpdrive / Afterburner), a type id, `"mwd"` / `"ab"` (the Tech II module of
that kind for the hull's size) or `"none"`. Omitted → the hull-sized T2 MWD, off (`DEFAULT_PROP_MOD_MODULE`).

- Hull size: the SDE's `rigSize` when the hub named the hull, else the SOF class's (`CLASS_RIG_SIZES`): frig/destroyer
  5MN / 1MN, cruiser/BC 50MN / 10MN, BS 500MN / 100MN, capitals 50000MN / 10000MN.
- Numbers: hub `/prop-mod` (SDE) → `BAKED_PROP_MODS` → the hull-sized T2 module of the name's kind standing in
  (`source: "default"`, with a `note`).
- `{ "op": "set_prop_mods", <selection>, "active"?, "module"? }` edits a selection (`module: null` removes the module →
  hull default; `active: false` removes `active`). The page applies a document change **at once**, no cycle wait.

## Prop mods live (`switch_prop_mods`)

**Prop mods are live module state in `DestinyWorld` (`ShipEntry.prop`), not motion.**

- `SwitchPropMod` (the tool) follows EVE's cycle: **on** at the next tick boundary; **off** at the end of the running
  cycle, rounded up to a tick (10 s MWD, 7.5 s AB with Afterburner V, 20 / 15 s capitals; `stopsIn` counts down). On
  while stopping keeps it running; off while activating cancels it.
- `SetPropModActive` (the document's `propMod.active`) applies at once, like a placement.
- **Every change sets mass and max velocity on both parks (`ApplyPropModNumbers`, `SetBallMass` / `SetMaxSpeed` as
  EVE's server does) at the due boundary, before the orders and `Steer`.** Destiny then accelerates/slows at agility
  (a TFI: 159 → 994 m/s in 20 ticks on a 500MN MWD II). Switching on while aligning slows the align.
- **Entering warp switches a running module off** (`note: off: entered warp`); it stays off after landing.
- `PlaceShip` keeps the state. **A live switch is never written to the document.**
- Selection (`fleets/selection.ts`): `ships`, or `fleet` (FC, wing commanders, squad members) narrowed by `wing` (its
  commander + its squads' members) or `squad`. `"none"` ships are skipped; so are ships in warp when switching on.
- Fleet members keep formation at their own boosted speeds; a switch never detaches.

## `get_state`

`physics` = what it flies now (while running: the module's mass, max velocity, signature (MWD bloom) and align time).
`propMod` = `module` as written, `name`, `typeID`, `kind`, `size` (S/M/L/XL), `source` (`sde` / `baked` / `default`),
`note`, `state` (`off` / `activating` / `active` / `stopping`), `cycleTime`, `since`, `at`, `stopsIn`, running numbers;
`null` for `"none"`. Each fleet: `propMods` counts. **Boosters keep the prop-mod-off `maxVel`** (`sd-destiny` →
`boosters`).

## Audio

Switching on posts `ship_engine_<S|M|L|XL>_<microwarpdrive|afterburner>_3rd_activate` on the ship's own emitter;
switching off (switch, document or warp) posts `..._powerdown`, sized by the hull (`PROP_MOD_AUDIO_STAGES`). Both are
one-shots: `_activate` is a muted swell (an L MWD's is a 37 s clip peaking ~8 s in), `_powerdown` the slowing-down
wind-down (L: a 2 s sound plus a 27.6 s tail; S: ~13 s). Switching off also stops a swell still playing
(`PROP_MOD_AUDIO_STOPS`). A module already running when audio turns on posts nothing.

- **Why `_activate`, not `_on`** (the user, against the game, Windows Chrome, 2026-10-22): the client plays the MWD
  sound once as the module activates, muted. `_on` is authored as a hold: an activation burst over 7 looping beds and a
  random layer chaining 3–5 s variations, so it repeated every ~4 s until stopped, ~20 dB louder; its opening burst
  sounds like undocking. `_on` alone carries the motion RTPCs (`booster_intensity`, `ship_Acceleration`,
  `ship_Thruster_Power`, `ship_Roll`), so the page sets none. `_3rd` is the other-ships set (the camera flies no
  ship); `_1st`, the own-ship set, has the same events. The metadata's `microwarpdrive_<class>_play` /
  `afterburner_<class>_play` module events have no program or media in this library.
- **Once per switch-on.** The user remembers the sound replaying as the module cycles; the page does not repeat it
  (follow-up).
- **The page stops what the backend leaves playing.** The library says `_powerdown` stops `_activate` and `_on`, but
  the runtime's Web Audio backend leaves that to `_powerdown`'s authored program, which did not stop `_on` (still
  -36 dBFS 12 s later). `PageAudio.Post` stops the post's `stops` after posting: `MarkPlayingIDStoppedByRequest`, then
  `ExecuteActionOnPlayingID(id, 'stop', PROP_MOD_AUDIO_STOP_FADE_MS)` (1 s, the runtime's own stop fade).
- **No delay before the sound.** A prop mod change shows on the drawn ship from the frame its event is delivered (the
  ClientBall trails by a tick and interpolates toward it; a destiny spec pins it), so the event posts at once: the
  browser measured the drawn acceleration in the post's frame and the sound 0–83 ms later.
- **Hear it within the event's radius** (`maxRadiusAttenuation`, culled beyond): S 4.5 km, M 7, L 12, XL `_activate`
  10 and `_powerdown` 25 km (L AB `_powerdown` 20). The curves are 0 dB to ~800 m, then fall to silence at the radius
  (L, measured: -3.8 dB at 2 km, -14.2 at 5, -38.7 at 9, silent at 13). An `_on` loop culled and back in range resumed
  ~20 dB down.
- **`distanceScale` stays 1** (comment in `audio.ts`): it scales only the panner and listener positions (HRTF, rolloff
  0), while the curves and culling read raw metres. 1/150 measured within 1.2 dB of 1 at every distance.
- **Panning follows the drawn side**: a ship fully to the right plays 4 dB louder right; the stems are low-frequency,
  so HRTF separates little (1.5 dB at 33°).
- **Mass switches** (41 TFIs ships on `_on`): the master bus peaked at +9.4 dBFS (RMS -12.1) into the runtime's -6 dBFS
  limiter, and the runtime's audio frame threw for 35 s (`sd-runtime`) while fps fell from ~30 to 15–18.

Library ~20 MB fetched when audio turns on, through the hub's `/audio/library` + `/audio/path/<resPath>` (must
**stream and forward `Range`**: the stems' media sit inside the 32 MB `boosters.bnk`). Listener at the camera. On only
after a user gesture (or autoplay allowed); `?audio=off`. Every pointerdown, pointerup (touch activates there) and
keydown resumes a suspended context (`PageAudio.Gesture`): Chromium grants no activation for a modifier key alone or
Escape, so a first Shift or Alt could turn audio on with the context still suspended. `get_state.audio`: state, the
last 20 events with `played`, `frameErrors` / `lastFrameError` (the page logs at most one line per 10 s and goes on),
and `context` (`suspended` while on: click the view; the overlay says so).
