# Fleet personalities: templates, the library, pilots, and (later) the FC brain

> A fleet personality is an FC's playstyle (`cjs-fleet-personality/1`) a fleet picks by name, so a cheap model only
> picks one per fleet and deterministic page code runs the fight. Fetch before touching
> `packages/scene/src/lib/personalities/`, the hub's `fleet-personalities.ts` / `personality-files.ts`, the
> `*_fleet_personality*` tools, `personality` on the staging tools, or (S7) `fleet-commanders`. Plan:
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
- **Not yet**: S7 the brain running on the page (`fleet-commanders` builds the picture with `toFleetPicture`, draws
  command traits, runs succession and `stepFleetBrain`; get_state `fc` and `pilot`, manual levers;
  `set_fleet_personality` then re-arms them), S8 real-GPU evidence. **Today a fleet's personality only times its
  pilots' reactions; no FC brain runs** (tools.ts `set_fleet_personality`, the scene format's `personality` line and the
  MCP instructions say so; S7 rewrites those phrases). The free-fire verify-page check has not run on tools-core.

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
  (`order_fleet targets set | clear`), `free-fire` (`order_fleet { type: 'free-fire', on: true }` once engaged, never
  off), `move` (`order_fleet` with the FC's ship order), `prop-mods` (`switch_prop_mods { fleet, active }`); every
  `order_fleet` carries `by: <acting FC>`. A want that differs from the picture opens a pending decision due after
  the FC delay (jitter keyed `seed | fleet | lever | tick − readyAt`); at due the want is recomputed and returned as
  an action; a want that goes away drops it. `manual` levers are skipped, `held` (cease_fire) skips call and free
  fire, no FC (leaderless) decides nothing and drops the pending ones. Calls only once engaged. The decisions log keeps
  the latest 20 `{ tick, lever, tool, args, why }`.
