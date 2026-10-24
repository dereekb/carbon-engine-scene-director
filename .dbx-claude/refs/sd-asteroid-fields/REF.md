# Asteroid fields: seeded ore belts of SOF rocks

> The document's `asteroidFields`, the seeded expansion into rocks, the three ops, ore names resolved to SOF rock sets,
> and `add_asteroid_field`. Fetch before touching `packages/scene/src/lib/asteroids/`, `hub/asteroid-data.ts`,
> `hub/asteroid-fields.ts`, `packages/viewer-engine/src/lib/asteroid-fields.ts` / `scene-fields.ts`, or before adding a field with
> the tools. The document and the diff: `sd-scene-document`;
> `near` / `facing` and `ScenePlaces`: `sd-staging`; belts and other celestials of the location: `sd-locations`;
> authored objects (the pattern this copies): `sd-objects`. Plan:
> `~/.claude/plans/asteroid-fields-seeded-ore-belts-in-cjs-scene-1-drawn-as-sof-rocks.md`.

**Status (2026-10-23, A3)**: fields are validated, stored and expanded by the hub, and **drawn by the page** as one
instanced SOF root per field, listed in `get_state.asteroidFields`, framed by `frame_camera` and checked by
verify-page `--only field`. Measured and tuned on the real GPU: rocks cast no shadows and each model draws its LOD
mesh for its nearest rock (Real-GPU evidence below).

**No-EVE-data mode** (`sd-dev-env`): fields read `off` with the mode's note (the rocks are placed, no model is built)
and draw nothing; `add_asteroid_field` takes only `{ rocks: [dna, …] }` ores, never ore names.

## Files

| File | Role |
|---|---|
| `packages/scene/src/lib/asteroids/field.ts` | `SceneAsteroidField`, `normalizeAsteroidFields` (ids unique across ships, objects and fields), `diffAsteroidFields`, the limits and defaults, `asteroidFieldModels`, `asteroidFieldEnvelopeLimit`, the get_state row type (A2) |
| `asteroids/expand.ts` | `expandAsteroidField`: the seeded, deterministic rocks; `asteroidFieldGeometry`, `asteroidSizeThresholds`, `asteroidFieldDigest` |
| `asteroids/ores.ts` | the curated ore → SOF faction table, `asteroidRockFaction`, `asteroidRockSize`, `asteroidRockSet`, `ASTEROID_ORE_NAMES` |
| `asteroids/operations.ts` | the three pure ops (`ASTEROID_FIELD_OPERATIONS`), their warnings |
| `staging/draft.ts` | `StagingDraft.fields`: field ids are taken ids for every generated ship, object, composition and field id |
| `apps/scene-director/src/lib/hub/asteroid-data.ts` | `AsteroidData`: an ore name → asteroid type and group → SOF faction; a faction → its rock DNAs from the SDE `graphics` table |
| `hub/asteroid-fields.ts` | `AsteroidFieldTools`: `add_asteroid_field` |
| `packages/viewer-engine/src/lib/asteroid-fields.ts` | pure, node-tested: `FieldDrawPlan` (groups per model and cell), `PackInstance`, `FIELD_INSTANCE_LAYOUT`, `RockTemplateOf`, `FieldRootValues` (the instanced root's values), `FieldSphere`, `FieldReach`, `AsteroidFieldStateRow`, `AsteroidFieldsText`; spec fixture `asteroid-fields.spec-helper.ts` |
| `packages/viewer-engine/src/lib/scene-fields.ts` | `SceneFields`: Apply / Build / Retire, the per-DNA template cache, hydrate-then-swap, `?fields=` |
| `packages/viewer-engine/src/lib/director.ts` | `this.fields`, `SceneryRoots()`, the Apply wiring, `FieldRows()`, field camera targets |
| `apps/scene-director/src/verify-page.ts` | `--only field`: six checks |
| `hub/scene-places.ts` | `ResolvePlace({ beltCentred })` and `ResolvedPlace.celestial` (shared with staging and objects) |
| specs | `asteroids/*.spec.ts` (the pinned digest is in `expand.spec.ts`), `hub/asteroid-data.spec.ts` (fixture `asteroid-data.testing.ts`, ids captured live), `hub/asteroid-fields.spec.ts`, `hub.spec.ts` |

## The field

```json
{ "id": "veldspar-01", "name": "Veldspar and Scordite field", "position": [0, 0, 60000], "rotation": [30, 0, 10],
  "shape": "disc", "radius": 30000, "thickness": 6000, "arc": 180, "count": 300, "size": [300, 3000], "seed": 2873310457,
  "ores": [{ "ore": "Veldspar", "type": 1230, "faction": "ore_veldspar", "weight": 2,
             "rocks": { "small": ["rock_01_s_v1a_whiteyellow:ore_veldspar:asteroid", "..."], "medium": [...], "large": [...] } }] }
```

| Key | Rule (default) |
|---|---|
| `id` | the ship-id pattern; unique across ships, objects and fields (a clash is reported on the field) |
| `position` | the centre, scene metres. The **whole field** must fit: `|position| + radius + size[1] ≤ MAX_SCENE_DISTANCE` (10,000 km); past 2,000 km the ops warn |
| `rotation` | `[yaw, pitch, roll]` (0, 0, 0). Local Y is a disc's axis; local +Z the middle of its arc |
| `shape` | `sphere` (default), `disc`, `ring` |
| `radius` | (0, 1,000 km] (20,000) |
| `innerRadius?` | [0, radius): a shell or a hole. Absent: ring 0.6 × radius, else 0 |
| `thickness?`, `arc?` | disc and ring only (warned and dropped on a sphere). Absent: disc R/4, ring R/6; arc 360° |
| `count` | integer 1–2,000 (150) |
| `size` | `[min, max]` rock radii, 1 ≤ min ≤ max ≤ 50 km, max < radius. Default `[300, 3000]`, both capped at radius / 4 |
| `seed` | integer 0 to 2³² − 1; default `floor(unitHash("asteroid-field|<id>") × 2³²)`, **written in at normalize** |
| `ores` | 1–8; together at most 48 distinct DNAs. `rocks` is `{ small, medium, large }`, each a non-empty DNA list; a flat list is shorthand for all three. `weight` > 0 (1, not written). `ore`, `type`, `faction` are provenance |

Defaults are written in (shape, radius, count, size, seed); keys come out in canonical order; unknown keys warn and
drop. The document stores **resolved DNA lists**, so a saved scene is self-contained and the page never looks an ore up.

## The expansion (`expandAsteroidField`; reimplement exactly)

1. Geometry: `Ri = innerRadius ?? (ring ? 0.6R : 0)`, `T = thickness ?? (disc ? R/4 : R/6)`, `arc = arc ?? 360`.
2. Size thresholds: log-thirds `t1 = min·(max/min)^(1/3)`, `t2 = min·(max/min)^(2/3)`; under t1 small, under t2
   medium, else large; max/min < 1.0001 makes every rock medium. (CCP's per-ore swap sizes are server data.)
3. Rock k = 0 … count − 1 draws from **its own stream**, `mulberry32(floor(unitHash("<seed>|<k>") × 2³²))`, in this
   order: the ore (`rng × Σweight` against cumulative weights); the radius `min·(max/min)^rng` (mm); the spin, a
   Shoemake quaternion `[√(1−u1)·sin 2πu2, √(1−u1)·cos 2πu2, √u1·sin 2πu3, √u1·cos 2πu3]` (1e-6); the model
   `rocks[size][floor(rng × n)]`; then up to 16 places: sphere (u, v, w) `y = 1 − 2u`, `φ = 2πv`,
   `ρ = ∛(w(R³ − Ri³) + Ri³)`, point `ρ·[√(1−y²)·sin φ, y, √(1−y²)·cos φ]`; disc / ring (a, b, c1, c2)
   `θ = (b − 0.5)·arc`, `ρ = √(a(R² − Ri²) + Ri²)`, point `[ρ sin θ, (T/2)(c1 + c2 − 1), ρ cos θ]` (mm). A place is
   accepted when no earlier rock is within `(r + r') × 1.1` (a grid hash, cell `2·max·1.1`, 27 neighbours); after 16
   failures the rock is **dropped**.
4. So: **raising count keeps the first rocks exactly**; editing shape, radius or density moves rocks but keeps each
   rock's ore, size, model and spin.
5. Envelope: `max(|p| + r)` over placed rocks (mm). Digest: cyrb53 (`combatHash`) of `dna|x|y|z|r|qx|qy|qz|qw` per rock
   joined by `;`, 14 hex digits. The hub's result reports it; A2's get_state reports the page's, and verify-page
   compares them.
6. 2,000 rocks expand in about 17 ms in Node. It runs in the add / update ops (shortfall warning), in the hub tool
   (the result) and, from A2, in the page; **never in `normalizeScene`**.

## Ops (pure)

- `add_asteroid_field` (flat): `ores` (each needs `rocks`: refused with the tool hint otherwise), `id?`, `prefix?`,
  `name?`, the field keys, `position? | near?: { ship | object, range?, direction? }`, `rotation? | heading? | facing?`,
  `radii?`. Place and turn come from `readObjectPlace` with the field radius as the lead radius, so `near.range` runs
  from the reference's surface to the field's edge (5,000 m, `ahead`); rotation defaults to the reference's yaw. A
  celestial `near` is refused with the tool hint. Ids: `<prefix | slug of name | slug of first ore | asteroid-field>-NN`
  over every ship, object and field id. Name default `"<A>, <B> and <C> field"` from the `ore` names, else
  `"Asteroid field"`.
- `update_asteroid_field { id, set }`: `ores` replaced whole; `null` clears `name`, `innerRadius`, `thickness`, `arc`;
  the id cannot change. A `position` / `rotation` change is a move (no move op).
- `remove_asteroid_field { id }`: also clears `camera.target`.
- Warnings (add, and update of geometry or position): the centre past 2,000 km; ships or objects inside the envelope
  ("its rocks draw through them"); "placed N of M rocks without overlap"; `size[1] > radius / 4`.
- Diff: `SceneDiff.asteroidFields { added, removed, rebuilt, moved }`; `rebuilt` is any of shape, radius, innerRadius,
  thickness, arc, count, size, seed, ores; `moved` only position / rotation; a name change does nothing.

## Draw-only (decided)

Rocks have **no Destiny balls** and a field id is **not an order target** (`order_ship` refuses it as "not a ship,
object or celestial target"). Nothing collides in scene-director (ships and object balls are non-massive, `sd-destiny`),
hundreds of static balls would cost tick time and snapshot memory for nothing, and a field stays pure document data
for time control. Only the field's extent is bounded. Rocks as targets and warping to a field are follow-ups.

## Ores and tools-core (`AsteroidData`; each cost a look)

- **Ore types have no graphic** (Veldspar 1230: group 462, category 25, no `graphicID`, no radius). The SDE has no
  group → graphics table (the client keeps `groupgraphics.fsdbinary`), so `ores.ts` maps **group name → SOF faction**
  (16 classic ores `ore_*` / `crystal_*`, `crystal_fluorite`, `tyranite`, moon rarities `r04` … `r64`) and the **Ice**
  group (465, shared by every ice) by the type's base name (`ice_blue`, `ice_clearicicle`, …). Grades (`II`/`III`/`IV`/
  `0-Grade`) and `Compressed` / `Batch Compressed` share the group, so they map too. Unmapped (refused, with
  `{ faction }` / `{ rocks }` as escape hatches): Mordunium and the other 2023 null ores, Pochven ores, Azure Ice,
  Crystalline Icicle, Mutanite.
- **Name resolution**: `ObjectData.Search({ query, group: 'asteroid', placeable: false })` (the category is "Asteroid"),
  an exact normalized name among category-25 groups; else an exact **group** name from
  `sde/groups?field=categoryID&value=25&limit=200` ("Common Moon Asteroids"; `typeID` null); else a plain search names
  the type's group ("Tritanium is a Mineral, not an asteroid ore"), or close names from `ASTEROID_ORE_NAMES`.
- **Rock models**: `sde/graphics?field=sofFactionName&value=<faction>&limit=200`, rows `{ table, id, payload: { _key,
  sofFactionName, sofHullName, sofRaceName } }`, kept where `sofRaceName` is `asteroid`. **`rowCount` is the whole
  graphics table (6,072)**, not the filtered rows. It is an **SDE** route (the hub's pinned SDE build), not the
  resource build.
- Hulls `(rock|crystal|ice)_NN_(s|m|l)_vNa_<colour>` are the field rocks: classic ores and ice have **4 per size**
  (`ore_veldspar` answers 14 rows: the 12 plus `rock_01_field_v1a_whiteyellow`, a pre-built 200 km field mesh, and
  `as1_l_03_whitebrown`, an abyssal rock, both skipped); moon factions have **8 per size** (two families, so a moon ore
  is 24 models); Tyranite has 4 unsized `crystal_04v1..4`, which fill every size. An empty size borrows medium, then
  the other, with a note.
- Rock hulls are unit-sized (bounding radius 0.75–1.0): the instance scale is the rock radius, as the client scales
  by ball radius. Each 2026 ore has "four small, four medium and four large models", swapped by ore amount (CCP,
  "EVE Evolved: Sharper Skies").

## `add_asteroid_field` (hub)

```sh
node bin/scene-director.js call add_asteroid_field '{"scene":{"name":"x"},"ores":["Veldspar","Dark Ochre","Blue Ice"],"count":200}'
node bin/scene-director.js call add_asteroid_field '{"ores":["Veldspar",{"ore":"Scordite","weight":2}],"shape":"disc","arc":180,"count":300,"near":{"celestial":"Perimeter II - Asteroid Belt 1"}}'
```

- `ores` entries: a name; `{ ore, weight? }`; `{ faction, weight?, name? }`; `{ rocks, weight?, name? }`. Each distinct
  name resolves once (cached per hub, failures retried); any bad entry fails the call naming every bad one.
- Places: `near.ship` / `near.object` go to the op (the hub fills the ship's EVE radius into `radii`);
  `near.celestial` resolves through `ScenePlaces.ResolvePlace({ beltCentred: true })`: **an asteroid belt centres the
  field** (range from its centre, default 0; the belt's SDE radius, rounded, when `radius` is not given: Perimeter II -
  Asteroid Belt 1 is 44,425 m); any other celestial puts the field's edge its set_location range off the surface (the
  radius, default 20 km, added as the lead radius). `facing: { celestial }` resolves through `ResolveFacing`.
- `replace: true` with an existing id sends `remove_asteroid_field` then `add_asteroid_field` in one patch.
- Not cueable (no `at`). Returns `added { id, name, position, rotation, shape, radius, count, placed, envelope,
  digest }` (from the stored field and a local expansion), `ores [{ ore, type, group, faction, models, from, skipped? }]`,
  warnings (rock-set notes first) and the patch result.
- Live smoke (2026-10-23, SDE 3646012): Veldspar, Dark Ochre and Blue Ice, 200 rocks in the default 20 km sphere → 12
  models each, 199 placed (the default field is near its packing limit at 200; A3 retunes the defaults); the Perimeter
  belt disc (arc 180, 300 rocks, radius 44,425) → 287 placed.

## The page (A2)

- **One meshless root per field** (the first template's root type, `EveStation2`; no mesh, controllers, observers,
  locators or impact overlay; bounding sphere = the envelope) on fixed curves (`CreateStaticCurves` / `PlaceStatic` at
  the field position and `DocumentRotation(rotation)`), hydrated by `HydrateSofObject` inside `PageAudio.Detached`,
  then `Engine.AddObject`. Its one `EveChildContainer` (`alwaysOn`, `origin: 1`, `isPlacementRoot`) holds an
  `EveChildMesh` per **(DNA, cell)** draw group: `{ name: dna, mesh, castShadow, reflectionMode, minScreenSize: 2.5 }`.
- **The mesh** is the rock template's SOF `Tr2Mesh` values cloned and retyped `Tr2InstancedMesh`: `boundsMethod: 2`
  (DYNAMIC_SCALED: the runtime widens the instance box by `maxInstanceSize` × the geometry radius), `instanceMeshIndex:
  0`, `minBounds` / `maxBounds` zero, `maxInstanceSize` = the group's largest rock radius, and an
  `instanceGeometryResource` `Tr2RuntimeInstanceData { layout: FIELD_INSTANCE_LAYOUT, rows, explicitBoundingBox: true,
  aabbMin, aabbMax }` (the rocks' centres' box, as SOF's `translationBounds`). Every area effect keeps its options and
  gains `SPACE_OBJECT_INSTANCED_ATTACHMENT=SOIA_ENABLED` (the rock's own `quadenvironmentv5` material). A row is
  `PackInstance(position, quaternion, radius)`: `M = T·R·S`, `transformN = [mN, mN+4, mN+8, mN+12]`, last copies, bone 0.
- **Templates**: `RockTemplateOf(BuildShipValues(dna).values)` (`{ mesh, castShadow, reflectionMode, rootType,
  inheritProperties }`), cached per DNA for the page session over the shared SOF queue and shared by every field; a
  failure is forgotten and retried on the next build. Only the DNAs of placed rocks build (`models.total`).
- **Edits**: a move re-places the curves; a rebuild keeps the old root drawn on the same curves until the new one is in
  the scene, then removes and retires it (`RetireShips` with every other root retained); a removal retires at once. A
  failed field is retried on the next apply. Fields build after the objects; `SetDrawReach(FieldReach, 'fields')`
  (the farthest `|centre| + 2 × envelope`).
- **LOD (`SceneFields.DriveLod`, every frame before `engine.Frame`)**: a rock `.gr2` keeps its LODs as **separate
  meshes** (`rock_01_m_v1.gr2`: `v3Shape`, then `v3Shape LOD 640`, `320`, `160`, `80`, `40`, `20`; the base is ~35k
  triangles), each with one LOD of threshold `0xffffffff`, and the SOF mesh always names mesh 0, so the runtime never
  LODs a rock. The page sets each instanced child's `Tr2InstancedMesh.meshIndex` to the smallest `LOD N` mesh with
  N ≥ `min(currentInstanceScreenSize, currentScreenSize)` (`FieldLodMeshes` / `FieldLodIndex`; the base above 640 px),
  read from the last scene update (a frame late). All rocks of a model share the LOD of its **nearest** rock, so near
  a field most models draw their base mesh; per-instance LOD is a follow-up.
- **Shadows are off by default**: the shadow passes cost 4× the rest (below). `?fields=shadow` composes the
  templates' `castShadow: true`.
- **Cells**: `FIELD_CELL_SIZE` stays `Infinity` (one child per model): cells multiply the children and their CPU cost
  faster than their LOD saves (below).
- **Switches**: `?fields=off` builds the templates but draws nothing (status `off`; the fps baseline);
  `?fields=shadow` turns rock shadows on. Without a renderer (headless) the root is composed but not hydrated:
  `validated`.
- **get_state**: `scene.asteroidFields` (count) and `asteroidFields[]` rows (`SceneAsteroidFieldStateReport`): `id`,
  `name`, `status` (queued, building, ready, validated, off, failed + `error`), the field keys, `rocks { requested,
  placed, bySize, byOre: [{ ore, rocks }] }`, `models { total, built, failed, failedDnas? }`, `cells`, `envelope`,
  `distance`, `digest` (the page's own expansion: verify-page compares it with the tool's) and `nearestShips`. No
  per-rock lists. A patch result carries the rows and `changes.asteroidFields { added, rebuilt, moved, removed }`.
- **Camera**: `frame_camera { target: <field> }` and the document's `camera.target` frame the envelope sphere; a field
  is never followed (no ball). With no ships and no objects the camera fits the fields. Removed field ids release a
  cinema subject or a follow like objects (`ReframesAfterEdit`, `CinemaReleases`). Fields are not alt-click picked.
- **Overlay**: a `fields` row, `"1 · 293 rocks · 1 ready"`.
- **verify-page `--only field`** (headless, temp stores, `SkipWithoutSde`): Veldspar + Dark Ochre (24 models, 150
  placed, page digest = tool digest); Tritanium and a field past the extent refused with nothing changed; a move keeps
  the digest (`moved: 1`), a seed change rebuilds (`rebuilt: 1`, new digest); a belt centres the field (radius 44,425);
  save / open round-trip and `frame_camera` (an unknown id is refused); `remove_asteroid_field` clears `camera.target`.

### The spike (real GPU, 2026-10-23)

Windows Chrome, NVIDIA (lovelace), 1600×900, private hub on 5537: one DNA (`rock_01_m_v1a_whiteyellow:ore_veldspar:
asteroid`), 20 instances over 10 km. **Pass**: lit, textured rocks at their instance transforms, scaled and turned;
`gpuErrors` 0 and no shader or permutation error in `page_log`, on the default tier and `?tier=hi`. `?tier=lo` draws
an all-white frame **with fields off too** (the lo tier's post process; `?tier=lo&post=off` draws the rocks), so that
is not the fields'. No fallback was needed: `quadinstancedv5` and one object per rock are unused. Then the Perimeter
belt disc (Veldspar, Scordite, Dark Ochre; 293 of 300 placed, 36 models) built and drew at 56–60 fps with digest equal
to the hub's; moving the camera onto the field for the first time stalled the frame (1 fps for a few seconds) while the
models' geometry and textures loaded.

## Real-GPU evidence (2026-10-23)

Windows Chrome, NVIDIA (lovelace), vsync 60 Hz, ~1600×900, private hub on 5537, Perimeter II - Asteroid Belt 1.
`fps` is from rAF intervals over 3–5 s, `CPU` the mean `engine.Frame` time, `draws` the AL's drawn batches per
frame; "off" takes the roots out of the scene in the same tab (as `?fields=off`). These are measurements, not specs:
re-measure after a change.

- **Shadows were the cost.** A 150-rock disc (Veldspar, Scordite, Dark Ochre; 36 models): +907 draws and +8.5 ms CPU
  with SOF's `castShadow`, +128 draws (2 areas × 2 passes per model) and +2 ms without. Near the field (a Rifter
  inside it, camera 3 km), base meshes, no LOD:

  | rocks | shadows | no shadows | off |
  |---|---|---|---|
  | 500 | 33 fps, 1,173 draws | 58.6 fps, 269 draws | 60 fps, 124 draws |
  | 1,000 | 17 fps | 55.9 fps | 60 fps |
  | 2,000 | 8.7 fps | 35 fps | 60 fps |

  The same 2,000 from 186 km cost the same (36 fps): the base mesh never LODs.
- **With the LOD meshes and no shadows** (the shipped defaults; a 60 km disc of 36 models): 150, 500 and 1,000
  rocks hold **60 fps near and far** (+120–145 draws, +1.5–2.5 ms CPU over off); 2,000 rocks hold 60 fps far (LOD
  20/40 meshes) and **43.6 fps near** (every model's nearest rock is big, so all 36 draw their base mesh).
- **Cells at radius / 2** (30 km) on the 2,000-rock field: 924 children, 30 fps, 2,071 draws, 33 ms CPU, against
  44 fps and 5.5 ms with one child per model. Cells stay off; per-instance LOD is the follow-up.
- **The look**: the belt disc (arc 180, 293 of 300 placed, digest = the hub's), a 150-rock Blue Ice sphere and a
  100-rock Arkonor sphere (99 placed): lit by Perimeter's star, textured per ore, ice and crystals telling apart, small,
  medium and large models mixed; near (2 km off a 2,960 m Scordite rock) 45–47 fps, mid (20 km) 44 fps, far (100 km)
  52 fps, against a 52 fps baseline for that nebula view (the 542 rocks, 60 models: +240 draws, +6 ms CPU).
- **Behind fleets**: `stage_engagement` with 100 ships a side (Rifters and Thrashers against Merlins and
  Cormorants, 201 ships) in front of a 1,000-rock field: **5.1–5.3 fps with the field, 5.1–5.2 without**: the ships'
  `engine.Frame` takes ~190 ms; the field adds ~140 draws and no measurable CPU.
- **Cold load stalls**: the first time a field's models and LODs come into view the main thread stalls for seconds
  (8 s frames; ~40–60 s until steady after a reload with 60 rock models), while geometry and its LOD buffers load.
  Steady state is reached once each geometry and LOD has drawn once.
- **Tuned**: shadows off by default (`?fields=shadow`), LOD meshes per child each frame, `FIELD_CELL_SIZE`
  `Infinity`. Kept: `MAX_FIELD_ROCKS` 2,000 (44 fps near, 60 far) and the A1 defaults (150 rocks fill the default 20 km
  sphere; ~200 is its packing limit at `[300, 3000]`, and the shortfall warning says so).
- `?tier=lo` draws an all-white frame with the default post process, fields or not (`?tier=lo&post=off` draws).

### Pin-bump checklist (runtime)

On a runtime pin bump re-check, against the new `EveSOF.js` and classes:
1. `SOF_INSTANCE_LAYOUT` still equals `FIELD_INSTANCE_LAYOUT` (the spec pins ours).
2. `packInstanceMatrix` still packs `transformN = [mN, mN+4, mN+8, mN+12]` with `lastTransform*` copies.
3. `CreateLayoutInstancedMesh` still writes the same `Tr2InstancedMesh` fields (`boundsMethod: 2`,
   `instanceGeometryResource`, `instanceMeshIndex`, `minBounds`, `maxBounds`, `maxInstanceSize`) and the same
   `Tr2RuntimeInstanceData` fields (`layout`, `rows`, `explicitBoundingBox`, `aabbMin`, `aabbMax`).
4. `quadenvironmentv5`'s dx11 containers still carry `SPACE_OBJECT_INSTANCED_ATTACHMENT` with `SOIA_ENABLED`, and
   whether `SOIA_SHARED` has appeared (it would open `EveChildInstancedMeshes` with per-instance culling and LOD).
5. Re-run the spike: one field on the real GPU, `gpuErrors` 0.
