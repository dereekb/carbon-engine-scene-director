# The scene document (`cjs-scene/1`): schema, patch ops, diff, camera, saved scenes

> The document is the only state a saved scene keeps; the page turns it into runtime objects. Fetch before changing
> `packages/scene/src/lib/scene.ts`, adding a patch op or a document field, touching `director.ts`'s apply path,
> `camera.ts`, or the saved-scene stores. Subsystem fields have their own refs: `fleets` (`sd-fleets`), `location`
> (`sd-locations`), `propMod` / `stats` / `type` (`sd-ship-stats`), staging ops (`sd-staging`), `objects` (`sd-objects`).

## Shape

```json
{
  "schema": "cjs-scene/1",
  "name": "duel",
  "environment": { "universe": "res:/dx9/scene/universe/a01_cube.black" },
  "camera": { "target": null, "distance": null, "yaw": 45, "pitch": -15, "fov": 90, "mode": "orbit" },
  "ships": [
    { "id": "punisher-1", "dna": "af1_t1:amarrbase:amarr", "team": "red", "position": [0, 0, 0] },
    { "id": "rifter-1", "dna": "mf1_t1:minmatarbase:minmatar", "team": "blue", "position": [3000, 0, 0], "rotation": [180, 0, 0] }
  ],
  "fleets": [], "objects": [], "location": { }
}
```

- **Units are EVE's**: metres, degrees, **Y up**. `rotation` is `[yaw, pitch, roll]`. Yaw 0 faces +Z, 90 faces +X.
- Ship fields: `id` (ship-id pattern), `dna` (SOF `hull:faction:race[:commands]`), `name?`, `team?` (the side, for
  hostility; independent of fleets), `position`, `rotation`, `type?`, `stats?`, `propMod?`, `fit?` (EFT text or a key
  of `fits`: `sd-fittings`), `pilot?` (`{ command?, reaction? }` in [0, 1], higher better: FC ability and how fast
  it answers fleet orders, `personalities/pilots.ts`; a pilot name and other keys are reserved, stored with a warning;
  stored for fleet personalities, not acted on yet), `orders?` (the ship's own script: order_ship steps with `after` /
  `duration`, `timeline/steps.ts`, `sd-timeline`), `immune?` (`true` or a list of `shield` / `armor` / `structure`: the
  ship ignores incoming damage there; `sd-combat` → Damage immunity).
- Top level: `schema`, `name`, `environment`, `camera`, `ships`, `fleets?` (`fleets[].personality?` names a built-in
  or a `personalities` key), `objects?`, `fits?` (EFT text by key; omitted when empty), `personalities?` (custom
  `cjs-fleet-personality/1` templates by key, never a built-in name; each resolves through `extends` to `line`;
  `personalities/`; normalized before fleets so the fleets' names check), `combat?` (`{ seed?, death? }`: the seed every shot's roll is keyed by, an integer 0 … 2³² − 1,
  default 1; `death` `"explode"` (default) or `"flag"`; omitted when empty; `combat/document.ts`, `sd-combat`),
  `location?`, `timeline?` (the scene's script: cues at a time, each running one lever; validated against the scene
  projected to the cue's time, `timeline/`, `sd-timeline`). Both are validated and stored; the page plays them from T2.
- Object fields (`objects/object.ts`): `id`, `dna`, `type?` (provenance only: a type id or the English name), `name?`,
  `position`, `rotation`, `radius?` (the radius order ranges use: add_objects fills the type's SDE radius, or its SOF
  bounding radius where the SDE has none or gives a wreck its 14 m placeholder; without one the page takes the SOF
  bounding radius once built, else 1,000 m). **Ids are unique across ships and objects**; ship-id and composition-id generators skip
  object ids. Detail: `sd-objects`.
- `asteroidFields?` (`asteroids/field.ts`): seeded fields of SOF rock DNAs (`id`, `name?`, `position`, `rotation`,
  `shape`, `radius`, `innerRadius?`, `thickness?`, `arc?`, `count`, `size`, `seed`, `ores`); shape, radius, count, size
  and the seed are written in. **Ids are unique across ships, objects and fields**, and every id generator skips field
  ids. The whole field (centre + radius + largest rock) must fit the extent. `camera.target` may name a field (framed by
  its envelope, never followed). The page draws each field instanced (`scene-fields.ts`). Detail: `sd-asteroid-fields`.
- **The scene extent** (`extent.ts`, the user's rule of 2026-10-22, "just like the game"): every ship and object
  document position is **refused past `MAX_SCENE_DISTANCE` (10,000 km)** from the origin (`readScenePosition`), and
  placements past `LARGE_SCENE_DISTANCE` (2,000 km) warn (`largeSceneWarning`). Live orders are not bounded: a goto
  or warp may still leave it. `formatSceneDistance` writes the distances in messages.
- **Unknown fields are reported as warnings and dropped.** `null` on an optional field means absent.
- `normalizeScene(input)` validates and reports **every** problem together; `SceneError` carries the problem list
  (and `ToolError` keeps it through the hub).

## Patch ops (`applySceneOperations`)

`applySceneOperations(scene, operations)` clones the document into an unvalidated **draft**, runs each op in order,
then normalizes once. Ops run on a draft that an earlier op in the same patch may have broken, so op code tolerates
malformed values and never throws; `normalizeScene` reports what is wrong with the result.

| Op family | Ops | Where |
|---|---|---|
| ships | `add_ship` / `update_ship { id, set }` (id can't change; `null` clears `type`, `stats`, `propMod`, `fit`, `pilot`, `orders`, `immune`; `stats` and `orders` replaced whole) / `remove_ship` (clears `camera.target`, leaves fleets with fallback, prunes it from every called `targets` list and from the timeline's cues and ship steps, with a warning; `remove_object`, `remove_fleet`, `remove_wing` and `remove_squad` prune the same) | `scene.ts` |
| scene | `set_camera`, `set_environment` (merged), `rename`, `set_location` (whole), `clear_location` | `scene.ts` |
| fleets | `add_/update_/remove_fleet`, `..._wing`, `..._squad`, `move_to_squad`, `remove_from_fleet`, `set_anchor`; `update_fleet` / `_wing` / `_squad` `set { targets }` edits a group's called targets and `set { autoRepair }` its logi auto-repair (`null` clears) | `fleets/operations.ts`, `fleets/targets.ts` (`sd-fleets`, doc `targets`), `logi/auto-repair.ts` (`sd-logi`) |
| compositions | `add_fleet_composition` | `compositions/operation.ts` (`sd-fleets` → `compositions`) |
| prop mods | `set_prop_mods` | `prop-mods/operation.ts` (`sd-ship-stats`) |
| staging | `add_ships`, `stage_engagement` | `staging/operation.ts` (`sd-staging`) |
| fits | `set_fits { fits: { key: text \| null } }` (merged; `null` deletes a key no ship uses) | `fitting/operation.ts` (`sd-fittings`) |
| personalities | `set_personalities { personalities: { key: template \| null } }` (merged; `null` deletes a key no fleet uses; a fleet picks one with `update_fleet set { personality }`) | `personalities/document.ts` |
| combat | `set_combat { seed?: n \| null, death?: "explode" \| "flag" \| null }` (merged; `null` resets a field; an emptied `combat` goes) | `combat/document.ts` (`sd-combat`) |
| immunity | `set_immunity { <selector: ships \| fleet [+ wing \| squad] \| all, role?, team?, sample?>, immune: true \| false \| [layers] }` (replaces each selected ship's `immune`; `false` deletes; `hull` / `state` need the `set_immunity` tool) | `combat/immunity.ts` (`sd-combat`, `sd-selectors`) |
| timeline | `add_cue { cue }` / `update_cue { id, set }` (an action replaces the cue's and clears `adds`) / `remove_cue { id }` / `set_timeline { timeline \| null }` / `clear_timeline` | `timeline/operations.ts` (`sd-timeline`) |
| objects | `add_object { object }` / `add_objects` (count of one DNA in a formation at a place) / `update_object { id, set }` (id can't change; `null` clears `type`, `name`, `radius`) / `move_object` (position or `near`, turn; the rest kept) / `remove_object` (clears `camera.target`) | `objects/operations.ts` (`sd-objects`) |
| asteroid fields | `add_asteroid_field` (flat; every ore needs `rocks`; place as `add_objects`, `near` range to the field's edge) / `update_asteroid_field { id, set }` (`ores` replaced whole; `null` clears `name`, `innerRadius`, `thickness`, `arc`; position / rotation is a move) / `remove_asteroid_field` (clears `camera.target`) | `asteroids/operations.ts` (`sd-asteroid-fields`) |

The result is `{ scene, warnings, arrivals? }`: `arrivals` lists the groups a `warpIn` added (`sd-staging` "Warp-in");
the director's `Apply` hands them to `Arrivals` (parked right after `AddShip`, before builds). The document never
records them.

**`applySceneOperations` stays synchronous and pure: it runs in the page.** Anything that needs tools-core (hull names,
SDE radii, celestials, saved compositions) is resolved by the **hub tool of the same name**, which fills the op's data
(`dna`, `radius`, `radii`, points) and forwards it. The raw op refuses what it cannot resolve and says to use the tool.

A new op family: export an `*_OPERATIONS` set + `apply*Operation(operation, context)` and add it to the `default:`
branch of `applyOperation` in `scene.ts`.

## The authored document and the live scene (`sd-timeline`)

The page keeps two documents. **`Director.authored`** is the document as authored, timeline included: what
`get_scene`, `save_scene` (both stores) and the IndexedDB working copy hold, so a tab reload restores the script and
restarts it. **`Director.scene`** is the **live scene** every subsystem reads: the authored document **without its
`timeline`**, plus the **live edits** (`liveEdits`: what document cues changed, and user edits only the live scene took).
Without a timeline in it, normalizing it never projects, and cue-added ids never collide with their own cues. The
"live state is never written" rule extends to document cues: a warp-in add by a cue is never saved.

- `get_scene` returns the authored document; `{ live: true }` the live scene; `{ at }` the authored document projected
  to that timeline time (`sceneAtTimelineTime`). Hub tools read `{ live: true }` (`ScenePlaces.Before`) and take the
  patch result's `live ?? scene` (`ScenePlaces.Apply`).
- **User edits** (`Director.Edit`: patch_scene, order_fleet's document half, auto_repair, a persisted camera, the
  pointer's camera, every hub tool's forwarded op) run through the edit queue. With no live edits: the authored document
  takes the ops and the live scene follows it (today's path). With live edits: both take the ops (the timeline ops the
  authored document only); **live-only** when only the live scene takes them and they name a timeline-added id
  (warning "applies live only …: it lasts until the timeline restarts"); **authored-only** when only the authored
  document does (warning "the live scene refused it (…): it applies from the next restart"); any other refusal is
  thrown. The patch result's `scene` is the authored document, plus `live` while live edits exist.
- **The Apply split**: `Apply(authored, { restart, paused, live })` → `ApplyNow(live)` (the synchronous part: diff,
  revivals, removals, `this.scene =`, cinema releases, location, combat, a load's clears, balls, arrivals, object balls,
  retunes, prop mods, formations, and the builds' `queued` live entries) → the timeline player takes the authored
  document (`Load` on a restart, else `Edit`) → `store.Put(CURRENT_KEY, authored)` → `FinishApply` (builds, object
  builds, draw reach, the arrivals' plan, reframe, report). `CueEdit` (a document cue, from the pre-boundary hook) runs
  `ApplyNow` on the live scene and starts `FinishApply` outside the queue, with no store write.

## Diff (`diffScenes`) and what the page does with it

`Director.ApplyNow` diffs the new normalized live scene against the current one and does only the work the diff names:

| `SceneDiff` field | Page action |
|---|---|
| `added` / `removed` | build / retire ships (removing stops the ship's followers: `sd-destiny`) |
| `rebuilt` | DNA changed: rebuild that ship; it keeps flying |
| `moved` | placement changed: put that ship at rest there (ends its order) |
| `relabelled` | name/team only |
| `retuned` | `type`, `stats`, `pilot` (but its `command` / `reaction`, `pilotFlightPart`), `propMod.module` or the resolved fit text (`fitTextOf`) changed: new flight numbers, no rebuild; a fitted ship re-resolves its fit and flies the table path until it lands (`sd-fittings`) |
| `switched` | `propMod.active` changed: switch at once (no cycle wait). A ship can be in `retuned` too |
| `fleets` / `regrouped` | fleet changed / ships whose membership or resolved anchor changed: re-plan following, no rebuild (a `targets` or `autoRepair` edit flags `fleets` only: no re-follow) |
| `location` | re-fetch `/map/system`, re-dress, re-sync the celestial targets (`sd-locations`) |
| `objects` (`SceneObjectsDiff`: `added` / `removed` / `rebuilt` / `moved` / `resized`) | `SceneObjects.Apply` builds, retires or re-places the models; `DestinyWorld` adds, re-adds (moved, resized, rebuilt) or `RemoveObject`s the static ball, which halts ships flying at it (`sd-destiny`) |
| `asteroidFields` (`SceneAsteroidFieldsDiff`: `added` / `removed` / `rebuilt` (any rock key) / `moved` (position, rotation only); a name change is none) | `SceneFields.Apply` / `Build`: build an added field's instanced root (after the objects), re-place a moved one's curves, rebuild a changed one (the new root hydrates before the old leaves) or retire a removed one; removed field ids join `ReframesAfterEdit` / `CinemaReleases`; the result's `changes.asteroidFields` counts them |
| `environment` | **reloads the tab** (the environment is initialized with the device) |
| `camera` | re-frame |
| `combat` | the seed or death mode changed; the page's combat rules (`sd-combat`, K2) take it for later shots and deaths |
| `immunity` | kept ships whose `immune` changed: the damage model's immune layers follow (no rebuild, no retune; S2 indexes them on every apply) |
| `orders` | kept ships whose `orders` changed: their scripts restart (T2, `sd-timeline`); timeline edits need no diff field. A script edit on a started timeline (M3) bypasses the diff: changed steps swap in place or re-simulate |

`load_scene` / `open_scene` restart every ship at rest at its document placement; a patch touches only what it changes.
**Edits cut the time-control window** (`sd-time`): `Director.Apply` cuts on a load and on any diff that changes the
simulation (`SimulationChange`: ships added, removed, rebuilt, moved, retuned, switched, regrouped, re-teamed or
re-scripted, objects, fleets, location, environment, combat); a camera-only or name-only edit keeps the window. Patch cues
(`ApplyNow` directly) do not cut. **Script edits re-simulate instead** (Movie mode M3, `sd-timeline` doc `movie`): an
edit of only the timeline and ships' `orders`, while a started timeline records, never reaches `Apply`
(`Director.ScriptEdit` in `EditNow`): the live scene's ships take the new orders directly (`withScriptOrders`) and the
scene re-simulates from the latest snapshot before the edit's first difference, or takes it at once when it changes
only the future; the patch result carries `resimulated`.
Live state (orders, prop mod switches, camera follow from `frame_camera`, and from Combat rules locks, HP, `set_hp`'s HP sets and kills) is **never written to the document**, so a
save or reload starts from the document's placements. Damage immunity is document state (a rule of the scene, like
`combat.death`); the HP it protects stays live.

## Camera

- `target: null` frames every ship (every object when the scene has no ships); `distance: null` fits the target:
  `OrbitCamera.Fit` (`camera.ts` `OrbitFitDistance`) puts its bounding sphere across 1 / `FIT_MARGIN` (87 %) of the
  view's narrower extent (the height, or the width in a portrait window), at the fov just set.
- `fov` is the vertical field of view, 5–120°, default `DEFAULT_CAMERA_FOV` 90 (EveCamera's own). Above an aspect of
  1.6 Carbon narrows the view by aspect / 1.6 (it keeps the 16:10 width); Fit, Pan and picking all include that. **Until
  2026-10-23 every scene drew at 90° whatever `fov` said** (the zoom curve, `sd-runtime`), so fitted views filled only
  35–41 % of the height; they now draw ~2.1x larger. Explicit distances look as before.
- Real GPU (2026-10-23, Windows Chrome, NVIDIA, private hub, 1600 × 900): the projection drew 30 / 45 / 90 / 120° as
  set; a fitted Tempest (R 536 m) sat inside a sphere spanning 0.8696 of the height at 45° (1.622 R at 90°, 3.242 R at
  45°) and of the width at 700 × 1000; `Pan` moved a focus-plane point exactly 200 / 120 px at 45° and 90°; alt-click
  took all five frigates, 38–60 px from the edges, at both; chase at 45° held the ship centred; a version-less record
  at fov 45 opened at 90. 0 GPU errors.
  **A target may be an object id** (`frame_camera`, the document, alt-click, the overlay); celestial targets cannot. A ship target is followed every frame (focus
  shifts by the drawn ship's travel, keeping any orbit/pan/zoom). `mode`: `orbit` (keeps your angles) or `chase`
  (behind the ship, 12° above its heading, turns with it; a drag looks around and eases back).
- In the page: alt-click a ship to follow it (glides over), **C** toggles orbit/chase; both write into the document.
- **Edits keep a follow.** Every edit used to re-frame the document's camera, dropping a `frame_camera` follow (rarely
  persisted) or gliding a persisted one across a teleport. `camera.ts` `ReframesAfterEdit` decides: re-frame only on a
  load, a camera change, removing the followed ship or object, or when nothing is followed. `Director.Apply` calls it before its
  `appliedCamera` check.
- Picking reads EveCamera's drawn projection (`PickShip`), Carbon's narrowing above aspect 1.6 included; shift-drag
  pan moves `PanMetresPerPixel` per pixel, so the grab point tracks the pointer.
- A cinematic shot draws over the orbit camera, which keeps updating underneath (`sd-cinema`). `frame_camera`, a
  camera change and alt-click release the shot, a load cuts it, other edits leave it playing; get_state's
  `camera.view` says which camera draws and `camera.drawn` what it drew.

## Saved scenes

| Store | Where | Notes |
|---|---|---|
| `disk` (default for saving) | `SceneFileStore` (`apps/scene-director/src/lib/store/scene-files.ts` over `document-files.ts`) in the hub's scenes dir: `--scenes <dir>` / `SCENE_DIRECTOR_SCENES`, default `scene-director/scenes` in the per-user data dir | validated on write and read; works with no tab |
| `browser` | the tab's IndexedDB (`packages/viewer-engine/src/lib/store.ts`); the working copy lives under a reserved key listings hide | needs a connected tab; records carry `version` (`SCENE_RECORD_VERSION` 2) |

- **Browser records from before the honoured fov** (no `version`) all carry the old default fov 45, which normalizing
  wrote in: `store.ts` `FromSceneRecord` reads 45 as 90, the look they were drawn with, and keeps any other fov.
  Nothing is rewritten in place; the next `Put` writes version 2. Disk scenes are not migrated (none existed on dbxpc).
  A per-record version, not an IndexedDB version bump: a tab on the old bundle has no `onversionchange`, so the new
  tab's `open(…, 2)` would block the page's start.
- The tools are `where: 'hub'` (`hub/saved-scenes.ts`) and forward to the page's handlers for `store: "browser"`.
  Stores are independent (no write-through). With `store` omitted: `save_scene` → disk; `list_scenes` → both (each entry
  marked); `open_scene` → disk first, then browser (no tab: returns the disk scene with `loaded: false`);
  `delete_scene` → disk if there, else browser.
- **File names** come from the scene name, lowercased, every run of chars other than letters, digits, `_`, `-` turned
  into `-` (`Duel at Jita` → `duel-at-jita.json`), so no name escapes the dir. Case-only differences are the same
  scene; saving a different name that collapses onto another scene's file is **refused**, not overwritten. A
  hand-placed file is listed and opened by its file name.
- The scenes dir belongs to the hub's owner process: a joined MCP server uses that hub's dir. `viewer_status` reports
  it. A `scenes/` folder in the checkout is gitignored.
- **Tests and verify-page pass a temp `SceneFileStore`; never write to the default per-user dir.**
- Import/export through the CLI: `call save_scene '{"name":"duel"}' --in duel.json`, `call open_scene ... --out f.json`,
  `call get_scene --out current.json`.
