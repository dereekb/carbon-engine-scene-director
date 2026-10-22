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
| `apps/scene-director/src/lib/hub/object-data.ts` | `ObjectData`: a type name or id → type id, name, group, category, SDE radius, SOF DNA; the name search |
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
  Returns `{ query, total, items: [{ typeID, name, group, category, radius?, dna?, published }], note? }`.
- **`add_objects`**: `objects: [line, ...]`, or one line's fields at the top level. A line is `{ type | dna, radius?,
  id?, name?, prefix?, count?, formation?, spacing?, position? | near?, heading? | facing? | rotation? }`. The hub
  resolves every type (`ObjectData`), celestial `near` and `{ celestial }` facing first, then sends **one** pure
  `add_objects` op per line in **one** `patch_scene`. **Atomic**: any problem (no graphic, unknown or ambiguous name,
  a place outside the extent) fails the call naming each line, and nothing is added. With `scene` it edits that
  document with no tab. Returns `added`, `types` (with `dnaFrom` / `radiusFrom`) and the patch result.
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
| ball radius | document `radius` (SDE), else the SOF bounding radius once built, else 1,000 m |

Placements past 2,000 km warn, and so do overlaps with ships or objects (inside the object's radius).

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

## Wrecks

- **There is no "Rifter Wreck".** Sub-capital wrecks are per race and size ("Minmatar Frigate Wreck"), and every one of
  a size shares a generic DNA, whatever the race: `wreck_s` / `wreck_m` / `wreck_l` `:genericbase:generic` (even "Jove
  Frigate Wreck" is `wreck_m`). Generic debris has no meaningful orientation.
- **Battleships also have hull wrecks** (34191–34197: `ab2_t1_wreck:amarrbase:amarr`, `cb1_`, `cb2_`, `gb1_`, `gb2_`,
  `mb1_`, `mb2_t1_wreck`, SDE radius 200 m), plus CONCORD, Triglavian, Drifter, Nestor and Colony ones.
- **Capital wrecks are always hull-specific**: titans `at1` / `ct1` / `gt1` / `mt1_t1_wreck`, dreadnoughts `adn1` /
  `cdn1` / `gdn1` / `mdn1`, carriers and supercarriers `aca1` / `aca2` / `cca1` / … , with faction variants
  (`adn1_t1_wreck:bloodraider:amarr`). Each has a "Wreck" type and a "Wreckage" type (2096–2124, a real radius).
- **A wreck's SDE radius is a 14 m placeholder** on the generic and capital "Wreck" types, so spacing, `near` ranges,
  overlap warnings and order ranges on wrecks are wrong, worst on capitals. Measured SDE against SOF: Minmatar Titan
  Wreck 14 m against 10,891 m (its Wreckage type 2,000 m); Minmatar Battleship Wreck (34196) 200 m against 672 m;
  Caldari Battleship Wreck (generic) 14 m against 282 m; Amarr Cruiser Wreck 14 m against 228 m; Minmatar Frigate Wreck
  14 m against 70 m. A level-4 follow-up (2026-10-22) covers the fix; until then pass `radius` on a capital wreck line.

## Ranges: SDE radius against the model

Object balls use the **SDE radius**, which is what EVE's overview measures, and it often disagrees with the model:

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
