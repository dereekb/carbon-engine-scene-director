# Fleet personalities: templates, the library, pilots, and the FC brain

> A fleet personality is an FC's playstyle (`cjs-fleet-personality/1`) a fleet picks by name, so a cheap model only
> picks one per fleet and deterministic page code runs the fight. Fetch before touching
> `packages/scene/src/lib/personalities/`, the hub's `fleet-personalities.ts` / `personality-files.ts`, the
> `*_fleet_personality*` tools, `personality` on the staging tools, or `fleet-commanders` (the brain on the page). Plan:
> `~/.claude/plans/i-want-to-be-reactive-twilight.md` (slices S1–S8).

## Status

- **In**: S1 live calls and S2 the fleet flies on when its FC dies (`sd-fleets` targets doc, `sd-combat`); S3 the
  templates, the 9 built-ins, the document's `personalities`, `fleets[].personality` and `ships[].pilot`
  (`sd-scene-document`); S4 (2026-10-23) the hub library: saved templates on disk, the five tools, and
  `personality` on `add_fleet_composition`, `stage_engagement` sides and `add_ships`' new fleet; **S5 (2026-10-23) the
  pure policy** in `packages/scene` (below): picture, traits, succession, targeting, movement, `stepFleetBrain`; **S6
  (2026-10-23) reactions and free fire**: orders given without `delay` reach each pilot after its reaction (its
  `pilot.reaction`, else its personality fleet's draw: `Director.ReactionOf` over `toFleetPilotTraits`; `sd-fleets`
  doc `orders`), and `order_fleet { type: "free-fire", on }` (`FleetCommanders` free fire, `FleetTargets` free picks
  with `pickFreeFireTarget`; `sd-fleets` doc `targets`). `Director.ShipReach` / `FreeFireView` are ready for S7's
  picture port.
- **S7 (2026-10-23) the brain runs on the page** (below, The brain on the page): `FleetCommanders` steps every
  personality fleet each boundary, its calls run as `order_fleet` / `switch_prop_mods` with the acting FC as `by`; the
  succession hands the formation to the designate; a model's lever is manual until `set_fleet_personality`; get_state
  `fleets[].fc` and `ships[].pilot`. Node specs: `fleet-commanders.spec.ts` (fake port). Its verify-page check
  passes on tools-core (Verify-page below).
- **S8 (2026-10-23, dbxpc): the plan is delivered.** verify-page on tools-core, the end-to-end run over the tools and
  the real-GPU fight, brawler TFIs vs sniper Ferox (the three sections below). Two S7 limits were real defects and are
  fixed: the gate waits out a warp-in, and leaderless is not sticky (Known limits).

## Files

| File | Role |
|---|---|
| `packages/scene/src/lib/personalities/personality.ts` | schema, enums, limits, `FleetPersonality` (as written) / `ResolvedFleetPersonality` |
| `.../personalities/normalize.ts` | `normalizeFleetPersonality`, `resolveFleetPersonality` (the `extends` merge), built-ins map |
| `.../personalities/examples.ts` + `examples/*.json` | the built-ins: `line` (complete root), brawler, kiter, sniper, headhunter, alpha, green, veteran, defensive |
| `.../personalities/document.ts` | the document's `personalities`, `set_personalities`, `isFleetPersonalityKey` |
| `.../personalities/pilots.ts` | `ships[].pilot` `{ command?, reaction? }` |
| `apps/scene-director/src/lib/store/personality-files.ts` | `FleetPersonalityFileStore` over `document-files.ts` |
| `apps/scene-director/src/lib/hub/fleet-personalities.ts` | `FleetPersonalities`: the tools, `Embed`, `MergeFleetPersonalityOver` |
| `.../personalities/picture.ts` | `FleetPicture` (the brain's view), `toFleetPicture`, `toFleetTeam`, reach medians, `FLEET_AWARENESS_RANGE` |
| `.../personalities/traits.ts` | seeded draws (`fleetTraitUnit`, `drawFleetTrait`), `toFleetBackups`, `toFleetPilotTraits` |
| `.../personalities/succession.ts` | `toFleetSuccessor`, `toHandoverTicks`, `toFcDelayTicks` |
| `.../personalities/targeting.ts` | `rankFleetTargets`, `toFleetCall`, `toFleetEngaged`, `pickFreeFireTarget` |
| `.../personalities/movement.ts` | `toFleetMove` (stances), `isFleetMoveChange`, `toFleetPropMods` |
| `.../personalities/brain.ts` | `stepFleetBrain`, the levers, memory (pending decisions, the decisions log) |
| `packages/viewer-engine/src/lib/fleet-commanders.ts` | the page's command state: call book, free fire, acting commanders (overlay), and the brain: `Step`, `CommanderDown`, `TakeLevers`, `AfterOperations`, `Report`, `PilotOf`; node-tested over `FleetBrainPort` |
| `packages/scene/src/lib/fleets/live.ts` | `LiveFleetOverlay.commanders`: the acting commander replaces the default successor, or takes the command from a flagged FC |

## The template

Every field optional but `id`; unset fields take the base's (`extends`: a built-in or a `personalities` key; omitted
means `line`). `ability` / `reaction` are a number or `[lo, hi]` (seeded draws later), 0..1, higher is better;
`handover` 2..300 s; reach / range `lock | optimal | falloff` or metres ≤ 250 km. The full shape is
`FLEET_PERSONALITY_FORMAT` in `tools.ts` (save / set tool descriptions) and the plan's template block. Built-ins'
descriptions say when to pick each; `list_fleet_personalities` shows them.

## The library on the hub (S4)

- **Store**: one JSON file per template in `--personalities <dir>` / `SCENE_DIRECTOR_PERSONALITIES`, default
  `scene-director/personalities` in the per-user data dir (`viewer_status` → `personalitiesDirectory`). File naming as
  saved scenes (`document-files.ts`); a personality summary has no `ships` (the summary field is optional). **Tests and
  verify-page pass a temp `FleetPersonalityFileStore`; server.spec passes `--personalities <tmp>`.**
- **Names**: a template saves under `name` (default its `id`), which becomes its id: the key a scene embeds it under
  and a fleet picks it by, so it must be an id (1-64 letters, digits, `_ - .`). Lookups ignore case (file stems are
  lowercased) and answer with the saved id, so a fleet takes the canonical key. **A built-in's name (any case) cannot
  be saved**, and a hand-placed file holding one lists as unreadable. Built-in lookups also ignore case (`Brawler` →
  `brawler`).
- **Save** validates the template and its chain first: `extends` must reach a built-in through saved templates (no
  loops, ≤ 8 links), so a base is saved before what extends it. **Delete** names the saved templates that extended it.
- **Get** returns the template as written and `resolved` (every field, `chain` naming each saved link).

## Embedding: how a saved or inline template reaches a scene

A scene knows only the built-ins and its own `personalities`, and its patch ops stay pure (`add_fleet_composition`,
`stage_engagement` and `add_ships` take only a name, `readId`), so the hub resolves every `personality` first
(`FleetPersonalities.Embed`):

| Given | Result |
|---|---|
| a built-in name | passed through, nothing embedded |
| a saved name | the saved template, **flattened**: each saved base merged in (`MergeFleetPersonalityOver`: the head's fields win field by field per section; it keeps its own id, name and description; `extends` becomes the first built-in or scene key on the chain), embedded under its saved id |
| a key the scene holds (not saved) | passed through |
| an inline template | normalized (a built-in id refused), flattened the same way, embedded under its id |

Lookup order for a name: built-in, then disk, then the scene's keys, so **embedding a saved template refreshes the
scene's copy** under that key (other fleets on it see the new version). The embed rides in the same patch as the op
that names it: `PersonalityOperations` merges every side's templates into one `set_personalities` placed first, so the
document's fleet name check passes. Results report `personality: { name, from: built-in | disk | scene | inline,
chain, embedded? }` (per side in `stage_engagement`'s `engagement.sides`).

- `set_fleet_personality { fleet, personality: name | inline | null, scene? }`: `[set_personalities?, update_fleet {
  set: { personality } }]` in one patch; `null` clears it (the embedded template stays in the scene). Refuses a fleet
  the scene lacks.
- `add_fleet_composition { personality? }` overrides the composition's `personality`; either is embedded.
- `stage_engagement` sides: the side's `personality`, else its composition's; a free side (`fleet: false`) is not
  embedded and the op refuses it.
- `add_ships { fleet: { new: true, personality } }`; `add_ships { pilot }` now reaches the op (the hub's line fields).

## The policy (S5, pure, `packages/scene`)

Everything the brain decides is a pure function of a **picture**, so the page (S7) only builds pictures and runs the
tool calls that come back. Specs on synthetic pictures: `personalities.spec-helper.ts` (`picture`, `hostile`,
`member`, `commandFleet`), `brain` / `targeting` / `movement` / `command` / `picture` specs.

- **Picture** (`toFleetPicture`): members in fleet order (not destroyed, warping or arriving); hostiles are live ships
  of another team within 250 km of the acting FC, by distance then id. The fleet's team is its FC's, else its members'
  most common; no team or no FC means no hostiles. Each ship: surface distance and offset from the FC, `health`
  (HP left over total), `remaining`, paper `dps`, `role` (`fc` for a fleet commander, else its squad's role, `dps`
  outside squads), `commands`, signature, max speed, its target; members add `reach` and `attackedBy` (20 s window).
  Fleet `reach` is the members' median lock / optimal / falloff (falloff = optimal + falloff; zeros left out). Plain
  JSON: a model can read the same view later.
- **Traits**: authored `pilot.command` / `reaction` win; otherwise draws keyed `combat.seed | trait|<fleet>|<ship>|
  <trait>` (`combatHash`). The FC and `command.backups` backups (wing cmdrs, squad cmdrs, boost squads' members, then
  members in a seeded shuffle) draw `ability`; every member draws `pilots.reaction`. `source`: pilot / personality /
  mixed.
- **Succession**: steps in order over live members (the FC left out): `most-able` (FC-capable, highest ability, ties
  fleet order), `chain` (wing cmdrs, then squad cmdrs), `anyone` (fleet order); none: leaderless (null). A
  non-capable designate has ability 0. Handover `ceil(2 + (1 − a)(handover − 2)(0.5 + 0.5u))` s; FC decision delay
  `round((1 − a) × 10 × (0.5 + 0.5u))` s (ability 1 decides in the same step).
- **Targeting**: reach is the personality's, capped at the fleet's lock range. Candidates rank by tier (priority index;
  unlisted roles after all listed), then `prefer`, then nearest, then id. The call keeps its live primary unless it is
  gone or out of reach, or (`on-better`) a higher tier is in reach; the queue keeps its live candidates in order, then
  refills from the ranking up to `queue`. Nothing in reach: the call clears. **Engaged**: `on-sight` a hostile within
  lock range, `in-range` one within targeting reach, `when-attacked` a member shot by a hostile; once on it stays on
  while any hostile is in the picture. Free fire picks the nearest hostile within the ship's own reach (ties: id).
- **Movement**: the focus is the live primary, else the primary the brain wants, else the nearest hostile. brawl /
  snipe: `keep-at-range` focus at range; kite: `keep-at-range` beyond 1.1 × range, `direction` away inside 0.9 ×,
  keep what it flies between; hold: nothing. Re-given only on a new type or target, a range moving > 10 %, or a
  direction turning > ~25°. Prop mods: `never` off; `closing` on beyond 1.25 × range, off inside 1.1 ×, unchanged
  between (a hold never closes); `always` also on while engaged; nothing when no member has one.
- **`stepFleetBrain({ picture, personality, memory, tick, readyAt, seed, manual?, held? })`**: levers `call`
  (`order_fleet targets set | clear`; none with `targeting.calls: false`, which instead clears a call it finds once),
  `free-fire` (`order_fleet { type: 'free-fire', on: true }` once engaged; `on: false` whenever the personality's
  `freeFire` is false and free fire is on, engaged or not, unless the lever is manual or the fleet held), `move` (`order_fleet` with the FC's ship order), `prop-mods` (`switch_prop_mods { fleet, active }`); every
  `order_fleet` carries `by: <acting FC>`. A want that differs from the picture opens a pending decision due after
  the FC delay (jitter keyed `seed | fleet | lever | tick − readyAt`); at due the want is recomputed and returned as
  an action; a want that goes away drops it. `manual` levers are skipped, `held` (cease_fire) skips call and free
  fire, no FC (leaderless) decides nothing and drops the pending ones. Calls only once engaged. The decisions log keeps
  the latest 20 `{ tick, lever, tool, args, why }`.

## The brain on the page (S7, `fleet-commanders.ts`)

`Director` builds `FleetCommanders` with a `FleetBrainPort` (Document, Live, Destroyed, Ready, Settled, Facts,
OrderOf, CallOf, PropMods, Run, HandOver), so the brain is node-tested with a fake port and imports nothing from
`./runtime`.

- **Loop**: `Director.StepFleetBrains(boundary)` runs in the boundary listener between `SyncRecharged` and
  `SyncFleetTargets(boundary)` (try/catch; a fleet whose step throws gets `fc.note`, the others step). Per personality
  fleet in document order: succession checks, the handover, the gate, the picture, `stepFleetBrain`, then each action
  through `port.Run`: `order_fleet` → `Director.FleetOrderNow(args, { boundary })` (targets → `CallTargets`,
  free-fire → `FreeFireOrder`, both skipping their own sync so the boundary's starts the locks; moves → `orders.Fly`;
  a document order is refused without a cue), `switch_prop_mods` → `SwitchPropMods` (pilots answer at their
  reactions). A refused action stays in the log with `refused`.
- **Gate**: `following.Ready(fleet)`, no member arriving or in warp, and every member and ship of another team
  `Settled` (`Director.ShipSettled`: hull stats, prop mod lookup, fit or default weapons' type). **A warp-in is waited
  out in full** (its landings are scheduled): the gate's give-up clock (`since`) restarts at every boundary a member is
  away, and it gives up on unsettled ships `FLEET_GATE_TICKS` (20) boundaries after the last landing (from its first
  boundary without one), noting what it waited for (`fc.note`); `readyAt` keys every jitter. (Before 2026-10-23 it
  gave up 20 boundaries from its first even mid-warp-in: a 23–27 s TFIs warp-in then reported `state: "no-team"` while
  the fleet was still in warp and kept a note naming all 44 arriving ships.) After it, a ship joins the pictures once
  settled or 20 ticks after it was first seen unsettled. The brain idles while the acting FC is in warp, arriving or
  without a ball.
- **Picture port** (`Director.BrainFacts`): every ship with a ball that has not exploded: position and radius from
  `world.Motion` (`physics.radius`, `physics.maxVelocity`), HP from `damage.Health`, paper DPS (`Director.PaperDps`,
  shared with get_state's `combat.paperDps`), `SignatureOf`, its target, `ShipReach`, `combat.Attackers` (the 20 s DPS
  window); flagged, warping and arriving ships are `away`. `CallOf` is the fleet group's live list filtered to
  `CalledTargetStatus` live; `OrderOf` the FC's pending, else applied, order; `PropMods` from the fleet's prop mod
  counts (on when activating + active outnumber stopping + off).
- **Traits**: one `toFleetTraitBook` per document (personalities resolved, `toFleetPilotTraits` per personality
  fleet, authored traits elsewhere with source `pilot`): `PilotOf` feeds get_state `pilot`, `ReactionOf` feeds
  `toPilotDelays` (it replaced S6's `PilotReactions`).
- **Succession**: `CommanderDown(fleet, down, tick, { flagged })` runs `toFleetSuccessor` over the document fleet with
  every destroyed ship gone, and sets the handover (`toHandoverTicks`, unit keyed `fleet|handover|designate|tick −
  readyAt`). Explode: `Director.Destroy` calls it for each personality fleet the dead ship commanded (live view)
  **before** reading the heirs, so the overlay's `commanders` makes the designate the formation root at once and S2's
  `CaptureFleetHeirs` / `InheritFleetOrders` fly it on. Flag: the step sees the live commander destroyed and starts it
  flagged; the flagged FC stays the root until the handover, when `port.HandOver` captures the flagged FC's motion,
  moves the overlay, re-plans (`following.Reconcile`) and has the designate inherit. A designate dying during its
  handover re-runs the protocol (explode through `Destroy`, flag through the step). No designate: `leaderless` (the
  overlay entry goes, the default rule keeps a root, the brain decides nothing). **Leaderless is not sticky**: each
  boundary the step runs the protocol again over the live members (`DesignateOf`), so a ship that can command (a
  reinforcement joining the fleet, a member given `pilot.command`, or anyone under `anyone`) ends it: its handover
  (`HandTo`) runs from the default rule's root, which flies on until then as a flagged FC does and hands its order over
  through `port.HandOver`, or, when the root is the designate, just pins it. A patch that changes a fleet's document
  commander drops its acting commander and succession.
- **Levers taken by a model** (`TakeLevers`, after a tool call or a timeline cue succeeds, `Director.Manual`): order_fleet
  targets / free-fire, engage and cease_fire on members → `call` + `free-fire` (cease_fire also `held`, the others
  let it go); a fleet (not wing or squad) move or warp, `order_ship` on the acting FC (and a ship script's steps on
  it) → `move`; switch_prop_mods on members → `prop-mods`. The brain's own calls never pass through it.
  A stance flown by the acting FC (`FleetBrainPort.Piloted`, `ShipPilots.Flies`, `sd-piloting`) holds `move` and
  `prop-mods` for each step it flies (not in `manual`: `fc.piloted` reports them); the brain still calls targets and
  free fire. No stance on the FC: the brain moves it as before.
  `set_fleet_personality` (any `update_fleet` whose `set` has `personality`, `AfterOperations` from `Edit` and
  `CueEdit`) clears `manual`, `held` and the pending decisions; a held fleet's members get their holds lifted
  (`FleetTargets.Rearm`) so the brain's call is shot again.
- **`order_fleet { type: "engage" }`** (fleet level, a personality fleet only: refused otherwise with "give it a
  personality first") is the console's Engage and needs no document edit: `FleetCommanders.Engage` drops the fleet's
  live stances (its own, its wings' and squads', so the document's apply again; the members' pilots are released),
  clears `manual`, `held`, the lent call and the pending decisions, and sets `engaged` with `engagedBy: "ordered"`; a
  held fleet's members re-arm as above (`Director.EngageOrder`). `TakeLevers` takes nothing for it, so the brain calls,
  moves and runs the prop mods from its next step.
- **A lent call** (`order_fleet targets { ..., until: "gone" }`, the console's Call primary): `TakeLevers` →
  `LendCall` takes only `call` (not free fire), lets a cease_fire hold go, and records the ids the order named
  (`primary`, `set`, `queue`; `next` / `drop`: the call they leave). `StepFleet` releases it at the first step where
  none of them is `live` (`FleetBrainPort.TargetStatus` = `Director.CalledTargetStatus`: destroyed, missing or
  warping), and the brain calls again that same step; `{ clear: true, until: "gone" }` releases it at once;
  set_fleet_personality and engage drop it. get_state `fc.lent` `{ lever: "call", targets }`; the time-control
  snapshot carries it (a brain field).
- **get_state `fleets[].fc`** (personality fleets): `personality`, `ship` (the live commander: the formation root;
  during an explode handover already the designate), `ability`, `state` (`handover` > `leaderless` > `waiting` >
  `no-team` > `commanding`), `successor` / `takesOverIn` (seconds) during a handover, `readyAt`, `engaged` /
  `engagedBy`, `hostiles` and `reach` (the last picture), `stance`, `manual`, `lent`, `held`, `pending` (`lever`, `dueIn`,
  `why`), `decisions` (`tick`, `lever`, `tool`, `args`, `why`, `refused?`; the latest 20), `note`. **`ships[].pilot`**:
  `{ command?, reaction?, source }` for a personality fleet's members and ships with authored traits.
- **Reset**: a load clears every brain, acting commander, gate memory and the trait book (`Clear`); a fleet removed
  drops its brain.

## Known limits (S7's, checked 2026-10-23 on dbxpc)

- **Leaderless was sticky** (held until a load or a commander edit, even after a capable ship joined; even
  `set_fleet_personality` kept it): **fixed**, the step runs the protocol again each boundary (The brain on the page →
  Succession). Spec: `a leaderless fleet runs the protocol again each boundary ...`.
- **The gate gave up after 20 ticks mid-warp-in**: **fixed**, it waits out a warp-in (Gate). Spec: `the gate waits out
  a warp-in ...`. Ships whose lookups never settle still count 20 boundaries after the last landing, noted.
- **`fc.ship` during an explode handover is already the designate**: kept, not a defect. `fc.ship` is the formation
  root in both death modes (flag mode: the flagged FC until the handover), so it always names the ship the fleet flies
  on, the one `order_ship` takes the move lever from, and whose `ability` is shown; `state: "handover"` with
  `successor` / `takesOverIn` says that command waits.
- **An heir crossing to its slot reverses** (not a defect): in the E2E fight red's heir `red-dps-02` was flying to its
  slot on the far side of its FC (+x at 120 m/s while `red-fc` backed off along −x), so inheriting the FC's
  keep-at-range turned it around: 120 → 78 → 44 → 22 → 30 → 49 → 67 m/s over the 6 ticks after the death, then on
  the FC's course at 120+ by the handover's end; the other members re-laid out on it, none below 44 m/s. S2's "no
  stopped tick" is about the order, not the speed: the moving-FC check covers an heir already on its FC's course.
- **A brawler calls only inside `optimal`** (the personality as written): the TFIs' median optimal is 6 km, so against
  Ferox holding at 47 km the brawler's call fired only while a Ferox was inside 6 km (scene ticks 31–45 in the E2E
  fight); every other kill came from free fire (on at scene tick 2, each member on the nearest in its own reach). A
  brawler with `targeting.reach: "falloff"` would call at the TFIs' 44.7 km.

## Verify-page (S8, 2026-10-23, dbxpc, SDE 3646012, headless)

`personality: the FC brain calls the nearest hostile as its FC; a model call takes the lever, a dead FC hands over,
set_fleet_personality hands it back` passes: brain call on k1 by bfc at the first boundary after the gate; the model's
call on k2 the same tick takes `call` + `free-fire`; bfc dies 18 ticks later and p1 takes command 3 ticks after it
(ability 1, 4 s handover); handed back with 1 decision logged. The other personality-area checks and the whole suite:
`sd-combat` Verify-page (K3) and `sd-fleets` doc `targets`. On the build with the gate and leaderless fixes, `--only
"personality|called|fleet|FC|free fire|warp-in"`: 36 ok, 3 FAIL: the cinema warp-in shot check (as in the whole
suite, filed) and two that read an earlier check's scene the filter skips (`get_state reports fleet membership and the
fleet tree`, `timeline: pilot delays and warp-in staggers are keyed on scene ticks across restarts`; both pass in the
whole suite). Filtered runs show such false failures: `--only FC` also fails the `flw-*` checks, whose scene `fleet
members form up on their anchors` loads.

## End to end over the tools (S8, 2026-10-23, dbxpc, SDE 3646012)

A private hub on 5523 (temp scenes, fleets and personalities dirs), driven as a controller with the tool calls an MCP
client makes (same names and JSON); drivers and logs in `.scratch/personalities-gpu/` on dbxpc (`fight.mjs` the
fight, `heir.mjs` the per-tick heir probe, `call.mjs` / `fc.mjs` one call / the `fc` digest). The whole cheap-model
fight is `set_location` CNAP + `stage_engagement { sides: [{ composition: "tfis", personality: "brawler" }, { ships:
[{ hull: "Ferox", count: 10 }], personality: "sniper" }], range: 20000 }`; the staged document (`staged-doc.json`) was
then loaded for every run, scene ticks counted from the load.

- **Decisions**: both gates passed at the load tick (everything settled, cached), commanding the tick after. Red (sniper,
  FC ability 0.67) at scene tick 2: `order_fleet targets set ["tfis-ewar-03", "tfis-ewar-02", "tfis-ewar-01",
  "tfis-ewar-05"]` by `red-fc` ("ewar, damaged, within 47.3 km"), then free fire and `keep-at-range tfis-ewar-03
  47250`. Blue (brawler, 0.7) at 2: free fire, `keep-at-range red-fc 6000`, `switch_prop_mods { active: true }`
  (closing from 20 km); its move followed each nearest target; its call at 31 (`set ["red-dps-01", "red-dps-05",
  "red-dps-03"]`, 35 members following: the 8 logi never take fleet calls) and `clear` at 45 ("nothing within 6 km").
  Every `order_fleet` carried `by` = the acting FC. Red wiped at scene tick 113 (kills at 11, 25, 25, 42, 56, 67, 80,
  93, 103, 113), blue lost none.
- **FC kill and handover**: `red-fc` died at scene tick 11 (by `tfis-dps-b-06`); the next poll showed `state:
  "handover"`, `successor: "red-dps-02"`, ability 0.63, `takesOverIn: 10`, counting down each tick; commanding at 23.
  The fleet kept moving on the inherited order (the heir's reversal: Known limits). `takesOverIn` scales with the
  successor's ability: red as `veteran` handed to `red-dps-06` (ability 1) in 2 s (the floor; commanding at 15), as
  `green` (no backups, so ability 0 on a 90 s handover) to `red-dps-01` in 80 s.
- **A model's lever**: `order_fleet red targets primary tfis-fc` at scene tick 3 made red `manual: ["call",
  "free-fire"]` at once; the brain stopped calling and never turned free fire on (its move followed the model's
  primary: `keep-at-range tfis-fc`); manual held through the handover; `set_fleet_personality red sniper` at 37 cleared
  it, and `red-dps-02` called at 39 (`set ["tfis-fc", ...]`, "keeps tfis-fc") and turned free fire on at 40.
- **The same seed replays**: three loads of the staged document gave the same 18 decisions (scene tick, lever and
  args), the same 10 kill ticks and the same handover (scene ticks 12 → 23), headless and on the GPU tab alike.
- **The gate on a warp-in** (`warpIn: true` on the TFIs side, landing 23–27 s after the stage): before the fix the gate
  gave up at 20 ticks, reported `no-team` until the FC landed and kept a 44-ship note; after it, `waiting` to the last
  landing, ready there with no note, and its first decisions on the next boundaries.

## Real-GPU evidence (S8, 2026-10-23)

dbxpc, Windows Chrome (chrome-devtools MCP, `windows-chrome` skill), NVIDIA Lovelace, 1600 × 900, SDE 3646012, the
private hub on 5523; the staged document above, so the drawn fight has the same ticks as the E2E runs. Three takes
(`gpu1/`–`gpu3/`; `gpu3/` the final one, its kill shots taken before the camera moves to the designate).

- `gpu3/004-red-fc-k1.5s.png`: blasts on `red-fc`'s hull 1.5 s after its death, its formation flying on around it.
- `gpu3/005-red-fc-k3s.png`: the Ferox's global fireball and ring enveloping where `red-fc` was, its fleet
  silhouetted in it.
- `gpu3/006-red-handover-red-dps-02.png`: `red-dps-02` at the centre as the formation root during its handover, the
  fleet re-forming on it in `red-fc`'s afterglow, TFI shells incoming.
- `gpu3/007-red-commanding-red-dps-02.png`: red under `red-dps-02` (commanding), its seven Ferox firing railguns in
  parallel on the called `tfis-ewar-03`.
- `gpu3/009-blue-call-from-fc-red-dps-01.png`: from the blue FC as its call goes out, the TFIs (dreads and carriers
  among them) charging on MWDs toward red's line.
- `gpu3/010-focus-red-dps-01.png`: blue's focus fire: every TFI's shells converging from all sides on the called
  `red-dps-01`, which flares at the centre.
- fps over the 54-ship fight (2 Hz `renderer.fps`): mean 16.8 / 16.9 / 17.2, median 17, min 9–12 (explosions), max
  21–23 (`gpu3` / `gpu2` / `gpu1`), in line with `sd-combat`'s TFIs-vs-Ferox scale run. `gpuErrors` 0,
  `lastFrameError` null, turrets failed 0 / unplaced 0, `page_log` 22 entries, all info.
