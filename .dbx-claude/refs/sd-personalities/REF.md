# Fleet personalities: templates, the library, pilots, and (later) the FC brain

> A fleet personality is an FC's playstyle (`cjs-fleet-personality/1`) a fleet picks by name, so a cheap model only
> picks one per fleet and deterministic page code runs the fight. Fetch before touching
> `packages/scene/src/lib/personalities/`, the hub's `fleet-personalities.ts` / `personality-files.ts`, the
> `*_fleet_personality*` tools, `personality` on the staging tools, or (S7) `fleet-commanders`. Plan:
> `~/.claude/plans/i-want-to-be-reactive-twilight.md` (slices S1–S8).

## Status

- **In**: S1 live calls and S2 the fleet flies on when its FC dies (`sd-fleets` targets doc, `sd-combat`); S3 the
  templates, the 9 built-ins, the document's `personalities`, `fleets[].personality` and `ships[].pilot`
  (`sd-scene-document`); **S4 (2026-10-23) the hub library**: saved templates on disk, the five tools, and
  `personality` on `add_fleet_composition`, `stage_engagement` sides and `add_ships`' new fleet.
- **Not yet**: S5 the pure policy (picture, traits, succession, targeting, movement, `stepFleetBrain`), S6 pilot
  reactions in `toPilotDelays` and `order_fleet` `free-fire`, S7 the brain running on the page (get_state `fc`,
  manual levers; `set_fleet_personality` then re-arms them), S8 real-GPU evidence. **Today a fleet stores its
  personality and pilots their traits; nothing acts on them** (tools.ts and the MCP instructions say so; S6/S7
  rewrite those phrases).

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
