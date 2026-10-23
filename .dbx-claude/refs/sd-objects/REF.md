# Authored objects: stations, gates, structures, LCOs and wrecks

> Static EVE objects placed in the scene by type name: the document's `objects`, the five ops, `add_objects` and
> `search_objects`, their Destiny balls and their drawing. Fetch before touching `packages/scene/src/lib/objects/`,
> `extent.ts`, `hub/object-data.ts`, `hub/objects.ts`, the viewer's `objects.ts` / `scene-objects.ts`, or before
> placing objects with the tools. The document field and the diff: `sd-scene-document`; the balls and the bubble
> refusal: `sd-destiny`; `near` / `facing` and `ScenePlaces`: `sd-staging`; the location's own stations and gates as
> targets: `sd-locations`.

## Files

| File | Role |
|---|---|
| `packages/scene/src/lib/objects/object.ts` | `SceneObject`, `normalizeSceneObjects` (ids unique across ships and objects), `diffSceneObjects`, the `get_state` row type, `MAX_OBJECTS_PER_OPERATION` 100, `DEFAULT_OBJECT_RADIUS` 1,000 m |
| `objects/operations.ts` | the five pure ops (`OBJECT_OPERATIONS`), `readObjectPlace` (`near` a ship or object off the draft), overlap warnings |
| `packages/scene/src/lib/extent.ts` | the scene extent: `MAX_SCENE_DISTANCE` 10,000 km refused, `LARGE_SCENE_DISTANCE` 2,000 km warns, `formatSceneDistance` |
| `apps/scene-director/src/lib/hub/object-data.ts` | `ObjectData`: a type name or id → type id, name, group, category, SOF DNA and ball radius (the SDE's; the SOF hull's bounding radius where the SDE has none or gives a wreck its 14 m placeholder); `IsWreckType`; the name search |
| `hub/objects.ts` | `ObjectTools`: `add_objects`, `search_objects` |
| `hub/scene-places.ts` | `ScenePlaces`, shared with `Staging` (`sd-staging`) |
| `apps/viewer/src/lib/objects.ts` | the pure half (node-tested): `ObjectBallRadius`, `ObjectReach`, `NearestShips`, `TargetedBy`, `ObjectStateRow`, `ObjectsText`, `PlanCelestialTargetSync` |
| `apps/viewer/src/lib/scene-objects.ts` | `SceneObjects` (runtime): one SOF build per object through `BuildStaticObject` (`ships.ts`, shared with the location dressing) on fixed curves; a move re-places the curves, a DNA change rebuilds; no renderer → `validated` |
| specs | `objects/*.spec.ts`, `extent.spec.ts`, `hub/object-data.spec.ts`, `hub/objects.spec.ts`, viewer `objects.spec.ts`, `destiny.spec.ts` (object balls); verify-page `--only object` (ten checks) |

## The tools

```sh
node bin/scene-director.js call search_objects '{"query":"Astrahus"}'
node bin/scene-director.js call add_objects '{"objects":[{"type":"Astrahus","id":"astra","near":{"celestial":"Jita IV - Moon 4 - Caldari Navy Assembly Plant","range":20000}},{"type":"Minmatar Frigate Wreck","count":8,"spacing":800,"near":{"object":"astra","range":3000,"direction":"behind"}}]}'
```

- **`search_objects { query, group?, limit?, placeable? }`**: English **name** substring only (no description hits),
  ranked exact, prefix, word prefix, substring, then shorter; `group` matches part of the group or category name;
  `limit` 20 (at most 50); `placeable` (default true) drops types with no SOF DNA and says how many it dropped.
  Returns `{ query, total, items: [{ typeID, name, group, category, radius?, radiusFrom?, dna?, published }], note? }`:
  `radius` is the one add_objects takes (`radiusFrom: "sof"` when it is the model's). The `placeable: false` listing
  reads no DNA, so it shows the raw SDE radius.
- **`add_objects`**: `objects: [line, ...]`, or one line's fields at the top level. A line is `{ type | dna, radius?,
  id?, name?, prefix?, count?, formation?, spacing?, position? | near?, heading? | facing? | rotation? }`. The hub
  resolves every type (`ObjectData`), celestial `near` and `{ celestial }` facing first, then sends **one** pure
  `add_objects` op per line in **one** `patch_scene`. **Atomic**: any problem (no graphic, unknown or ambiguous name,
  a place outside the extent) fails the call naming each line, and nothing is added. With `scene` it edits that
  document with no tab. Returns `added`, `types` (with `dnaFrom`, `radiusFrom` `given` / `sde` / `sof` / `none`,
  and `sdeRadius` when the model's replaced it) and the patch result.
- Moves and removals go through `patch_scene`: `move_object` (a position, or `near` a ship or object), `update_object`,
  `remove_object`. To move one off a celestial, remove it and `add_objects` it again with the same id.

| Default | Value |
|---|---|
| `count` | 1 (at most 100 per line or op) |
| `formation` / `spacing` | `sphere` / `ceil(1.5 × 2r + 100)` m, r = 1,000 m when unknown (warns) |
| `near.range` | 5,000 m off a ship or object; off a celestial as `set_location` (station 5 km, gate 2.5 km, body one radius) |
| `near.direction` | `ahead` off a ship or object (its heading), `sun` off a celestial |
| rotation | the near reference's yaw, else `[0, 0, 0]`; `facing` turns yaw only |
| ids / names | `id` names one object; else `<prefix or type slug>-<nn>` after the highest number any ship or object uses; names `<type> <n>` |
| ball radius | the line's `radius`; else the type's SDE radius; else (none, or a wreck's 14 m placeholder) its SOF hull's bounding radius read at resolve time; the page: document `radius`, else the SOF radius once built, else 1,000 m |

Placements past 2,000 km warn, and so do overlaps with ships or objects (inside the object's radius) and a spacing
under two radii.

## tools-core quirks (`ObjectData`; each cost debugging)

- **`ShipData.Hull` refuses non-ships**, so objects resolve here, on ShipData's pinned SDE build (`MapData` is the
  precedent for a second tools-core client). Every lookup is cached per hub; a failed one is retried.
- **`dna/resolve` answers 500** "Internal tool error" for a type with **no graphic** (Tritanium) or a **non-SOF
  graphic** (a sun), by name and by type id alike. ShipData reads a 500 as "no SDE"; here that would be wrong, so
  `ObjectData` classifies it from `types/<id>?lang=en`: no `graphicID` → "has no graphic, so it cannot be placed"; a
  graphic but no DNA → "not a space object the page can build". It also answers 404 for an unknown name and 409 for an
  ambiguous one ("names 3 EVE types (…); give a type id"). `typeID` and `graphicID` come back as strings.
- **`sde/types?query=` is a substring search over every text field, descriptions included** ("Rifter Wreck" matches
  "Drifter wrecks" in a Sleeper description), in type-id order; `ObjectData` reads 500 rows (about 0.2 s) and filters
  on the English name itself.
- **Wrecks, LCOs and NPC stations are unpublished**: never filter on `published`. Ship types are placeable too (a
  static derelict prop).
- Groups: wrecks are group 186 (Wreck, category Celestial); LCOs are groups 226 (Large Collidable Object) and 319
  (Large Collidable Structure); Upwell structures are category 65 (Structure; group 1657 is Citadel).
- **`sof/hulls/<hull>`** answers the hull's catalog record `{ _type: "EveSOFDataHull", name, category,
  boundingSphere: [x, y, z, r], ... }`, 404 `{ error: "SOF hull not found: <hull>" }` for an unknown hull, 501 only
  when the SOF service is not configured. It is a **resource** route: `ObjectData` reads it on
  `ToolsCore.ResolveBuild()` (its `resourceBuild` option), never the SDE build (tools-core's build-reference rule; the
  fixture pins them apart, 3632940 against 3632936). It is the record the page's `ReadHull` reads, so the hub's radius
  equals get_state's `sofRadius`. Records run 14 KB (`wreck_s`) to 762 KB (`cm1_t1`), so a hull is read only when a
  type needs it, once per hull per hub (a 404 is cached, other failures retried). Wreck hulls are category `wreck` or
  `structure_wreck`.

## Wrecks

- **There is no "Rifter Wreck".** Sub-capital wrecks are per race and size ("Minmatar Frigate Wreck"), and every one of
  a size shares a generic DNA, whatever the race: `wreck_s` / `wreck_m` / `wreck_l` `:genericbase:generic` (even "Jove
  Frigate Wreck" is `wreck_m`). Generic debris has no meaningful orientation.
- **Battleships also have hull wrecks**: 34191–34197 (`ab2_t1_wreck:amarrbase:amarr`, `cb1_`, `cb2_`, `gb1_`, `gb2_`,
  `mb1_`, `mb2_t1_wreck`) are group 226 (Large Collidable Object), SDE radius 200 m; the hulk wrecks 49119–49125 are
  group 186, also 200 m. Plus CONCORD, Triglavian, Drifter, Nestor and Colony ones.
- **Capital wrecks are always hull-specific**: titans `at1` / `ct1` / `gt1` / `mt1_t1_wreck`, dreadnoughts `adn1` /
  `cdn1` / `gdn1` / `mdn1`, carriers and supercarriers `aca1` / `aca2` / `cca1` / … , with faction variants
  (`adn1_t1_wreck:bloodraider:amarr`). Each has a "Wreck" type and a "Wreckage" type (2096–2124, group 226, 500–2,000 m,
  three with no radius).
- **"Minmatar Battleship Wreck" is ambiguous** (26536 is the generic `wreck_l`; 34196 and 34197 are hull wrecks):
  `dna/resolve` answers 409, so give a type id.

### The 14 m placeholder (SDE 3632936)

The SDE gives every generic sub-capital wreck (`wreck_s|m|l`), most capital wrecks, and many faction and structure
wrecks a **14 m radius: a placeholder, not a size** (no published source states EVE's runtime rule for a wreck's
ball). Three wreck types have none at all. So `ObjectData` sizes a type's ball:

1. the line's `radius` (`radiusFrom: "given"`);
2. else the SDE radius (`"sde"`), unless the SDE has **none**, or the type **is a wreck** (`IsWreckType`: group 186, or
   a SOF wreck hull by name, `wreck_s|m|l` or `<hull>_wreck`, which catches the wrecks filed under groups 226 and 319)
   **with an SDE radius ≤ `WRECK_PLACEHOLDER_RADIUS` (14 m)**;
3. then the SOF hull's `boundingSphere` `r`, rounded to whole metres (`"sof"`, with `sdeRadius` in the report);
4. a failed read leaves no radius (`"none"`) and a line warning saying why; the op assumes 1,000 m and the page takes the
   model's once built. The 14 m is never used.

| Wreck | SOF hull | Ball radius | Default spacing |
|---|---|---|---|
| generic small (frigates, shuttles, rookies) | `wreck_s` | 70 m | 310 m |
| generic medium (cruisers, destroyers, haulers, barges) | `wreck_m` | 228 m | 784 m |
| generic large (battlecruisers, battleships) | `wreck_l` | 282 m | 946 m |
| Minmatar Titan Wreck (26556) | `mt1_t1_wreck` | 10,891 m | 32,773 m |
| titan wrecks | `at1` / `ct1` / `gt1` / `angt1` `_t1_wreck` | 8,909–10,112 m | |
| dreadnought / carrier / supercarrier wrecks | `adn1` …, `aca2` …, `aca1` … | 1,861–2,844 / 1,623–1,986 / 5,084–5,877 m | |
| freighter wrecks | `afr1` … `mfr1` | 1,275–1,928 m | |
| Wrecked Avalanche (group 319) | `uwfr01_t1_wreck` | 1,928 m | |
| Minmatar Carrier Wreckage (2110, no SDE radius) | `mca2_t1_wreck` | 1,719 m | |

- **Real SDE wreck radii stand** (EVE's overview rule, as for every object): structure wrecks (Astrahus Wreck 45 km
  against a 25 km model), FAX 3,000 m, navy dreadnoughts 4,000 m. Some sit far below their models: hulk and hull wrecks
  200 m against 520–744 m, Wreckage types 2,000 m against 10,891 m, Mercenary Den Wreck 50 m against 7,431 m,
  station-style wrecks 4,000 m against 17–36 km. Pass `radius` for those; the level-3 model-ranges follow-up covers
  them.
- The ball takes the sphere's `r`, not `r` plus its centre offset (the titan wreck's sphere sits 1.5 km off its
  origin), as the page's own SOF fallback does.
- `get_state` for an add_objects wreck shows `radiusFrom: "document"` with `sofRadius` equal once built; the provenance
  is add_objects' `types[].radiusFrom: "sof"`. A raw `patch_scene` wreck with no radius reports `"default"`, then
  `"sof"`.
- A scene saved before 2026-10-22 keeps `radius: 14` on its wrecks: `update_object` each with its row's `sofRadius`,
  or remove it and `add_objects` it again with the same id.

## Ranges: SDE radius against the model

Object balls use the **SDE radius**, which is what EVE's overview measures (wrecks with the 14 m placeholder and types
with none take the model's: above), and it often disagrees with the model:

| Type | SOF hull | SOF bounding radius | SDE radius |
|---|---|---|---|
| Astrahus | `cm1_t1` | 21.9 km | 45 km |
| Fortizar | `cl1_t1` | 52.6 km | 85 km |
| Keepstar | `cxl1_t1` | 98.8 km | not checked |
| Astrahus Wreck | `cm1_t1_wreck` | 25 km | 45 km |
| Ruined Stargate | `ghg_wreck` | 5.4 km | 6 km |
| Caldari Trading Station | `cs3` | 36.2 km | 33.4 km |
| Jita Trade Hub (the CNAP) | `jita` | 156.6 km | 100 km |

So an orbit at 5 km on an Astrahus flies ~28 km off its hull. `get_state.objects` reports both (`radius` +
`radiusFrom`, `sofRadius`). A level-3 follow-up weighs model ranges for some groups.

## The page

- **Objects never collide**: their balls are static, not free, **not massive**, not interactive, and ships are not
  massive either (`sd-destiny`). Ships fly through hulls; a level-3 follow-up covers collisions.
- Objects build after the ships in a patch, awaited and reported in the result (`objects[].status`), and a failed
  build is retried. Every `RetireShips` keeps ship, dressing and object roots.
- The camera's back clip takes the largest reach of its sources (`Engine.SetDrawReach(metres, 'dressing' |
  'objects')`; `ObjectReach` for objects).
- `get_state.objects[]`: `id, type, name, dna, status, error?, position, rotation, radius, radiusFrom, sofRadius,
  distance, nearestShips` (3, surface to surface) and `targetedBy`; `scene.objects` counts them. The overlay shows an
  objects row (`ObjectsText`). `frame_camera` and alt-click take an object id.

## Real-GPU check (2026-10-22, Windows Chrome, NVIDIA Lovelace)

Note `scene-director-authored-objects-gpu-check`. Rifter and TFI 30 km off the Jita CNAP; an Astrahus, a Fortizar,
a Ruined Stargate and 8 frigate wrecks; later 74 objects.

- 11 objects `ready` in 2.5 s; 20 battleship hull wrecks of a not-yet-built DNA in 2.7 s end to end, so one SOF build
  per DNA is not needed yet. 0 GPU errors; 45–53 fps with up to 31 objects, 32–35 fps with 74.
- The Astrahus and Fortizar draw with Upwell materials, the Ruined Stargate with its rings, wrecks as debris. No
  z-fighting or clipping at 100–160 km; the back clip reached the Fortizar (208 km out) and the moon behind it.
- `page_log` warn showed only the runtime's audio noise (`sd-runtime`), nothing from objects.
