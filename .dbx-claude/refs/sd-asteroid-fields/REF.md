# Asteroid fields: seeded ore belts of SOF rocks

> The document's `asteroidFields`, the seeded expansion into rocks, the three ops, ore names resolved to SOF rock sets,
> and `add_asteroid_field`. Fetch before touching `packages/scene/src/lib/asteroids/`, `hub/asteroid-data.ts`,
> `hub/asteroid-fields.ts`, or before adding a field with the tools. The document and the diff: `sd-scene-document`;
> `near` / `facing` and `ScenePlaces`: `sd-staging`; belts and other celestials of the location: `sd-locations`;
> authored objects (the pattern this copies): `sd-objects`. Plan:
> `~/.claude/plans/asteroid-fields-seeded-ore-belts-in-cjs-scene-1-drawn-as-sof-rocks.md`.

**Status (2026-10-23, A1)**: fields are validated, stored, expanded and reported by the hub. **The page does not draw
them yet**: `normalizeScene` warns `ASTEROID_FIELDS_NOT_DRAWN_WARNING` while a document has fields. A2 (the instanced
drawing, `get_state`, `frame_camera`, verify-page) and A3 (the real-GPU check and tuning) are continuations; the plan's
§5 and §6 hold their design.

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

## A2 / A3 (planned, see the plan)

- One root SOF object per field on fixed curves; one `EveChildMesh` per rock DNA holding a `Tr2InstancedMesh` and a
  `Tr2RuntimeInstanceData` of that model's rocks (SOF's `SOF_INSTANCE_LAYOUT` rows, `packInstanceMatrix` packing), the
  rock's own `quadenvironmentv5` material plus `SPACE_OBJECT_INSTANCED_ATTACHMENT=SOIA_ENABLED`; SOF builds each DNA
  once per page session. A spike on the real GPU comes first (fallbacks: `quadinstancedv5`, then one object per rock
  capped at 200).
- Pin-bump checklist (once A2 lands): `SOF_INSTANCE_LAYOUT`, `packInstanceMatrix`, the `Tr2InstancedMesh` and
  `Tr2RuntimeInstanceData` fields, `SOIA_ENABLED` still in `quadenvironmentv5`, `SOIA_SHARED` still absent.
