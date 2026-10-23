# Locations: real EVE places, map data, name resolution

> A scene can sit at a real EVE place (a solar system and a point near one of its celestials, from CCP's static data).
> Fetch before touching `packages/scene/src/lib/location/`, the hub's `locations.ts` / `map-data.ts`, or the viewer's
> `location.ts`. Sub-doc **`dressing`** (`{ ref: "sd-locations", doc: "dressing" }`): how the page draws a location
> (nebula, sun, flare, planets, stations, gates, the planet pass).

## Files

| File | Role |
|---|---|
| `packages/scene/src/lib/location/location.ts` | the document's `location` (`normalizeSceneLocation`), `CELESTIAL_KINDS`, `MAX_LOCATION_COORDINATE` 1e15 |
| `location/placement.ts` | origin off a celestial (`toLocationPlacement`): range off the surface along a direction, or an offset. Pure float64. Staging reuses it |
| `location/map.ts` | the `/map/system` answer type and the `get_state` report; `MAP_SEARCH_KINDS`, `LOCATION_NEARBY_LIMIT` 10 |
| `location/dressing.ts` | what a location draws (sub-doc `dressing`) |
| `location/targets.ts` | the location's stations and gates as order targets: `celestial:<id>` ids, `toCelestialTargets`, the `get_state.location.targets` rows |
| `location/names.ts` | `matchCelestialName` / `normalizeMapName`: the name rules below, pure (the hub re-exports them as `MatchCelestialName` / `NormalizeMapName`) |
| `location/named-targets.ts` | `resolveNamedOrderTarget`: order targets by name (below) |
| `apps/scene-director/src/lib/hub/map-data.ts` | `MapData`: tools-core's map routes (search, one system, its celestials, one celestial by id) |
| `hub/locations.ts` | `search_map`, `get_system`, `set_location`, `/map/system` |
| `hub/map-data.testing.ts` | tools-core stand-in: Jita, Perimeter, Niyabainen (SDE 3632936, captured 2026-10-22) |
| `apps/viewer/src/lib/location.ts` | `LocationLookup`: fetches `/map/system`, builds `get_state.location` (node-tested) |

## The document field

```json
"location": {
  "system": 30000142, "name": "Jita", "region": "The Forge",
  "origin": [-107303331552.681, -18744969943.288, 436488926028.301],
  "anchor": { "celestial": 60003760, "name": "Jita IV - Moon 4 - Caldari Navy Assembly Plant", "kind": "station",
              "offset": [31007.319, 5416.712, -126131.699] }
}
```

- `origin` is in **system metres: float64, the system's star at `[0, 0, 0]`, Y up, +Z forward, right-handed**
  (tools-core's map frame). Scene axes are the system's axes, so a location only translates. `origin` is authoritative;
  `anchor` is provenance (editing `origin` by hand does not update it). Ids are EVE ids; names are for people.
- **Every coordinate is bounded at 1e15 m** to refuse a galactic position (a system's galactic `position` is 1e16–1e17
  m; a system is at most ~1e14 m across).
- Ops: `{ "op": "set_location", "location": {...} }` replaces it whole (a new origin never keeps a stale anchor);
  `{ "op": "clear_location" }` removes it. A location change moves the scene in its system, not the ships in the scene.
  **The op is pure and looks nothing up.**

## Coordinates: the float64 / float32 boundary

**Never hand system or galactic coordinates to the renderer.** The page only ever sees origin-relative values from
`/map/system`: the hub does the float64 subtraction, so float32 holds. Ships stay in scene metres around the origin.

## Hub tools

```sh
node bin/scene-director.js call search_map '{"query":"Perimeter","kinds":["stargate"]}'
node bin/scene-director.js call get_system '{"system":"Jita","kinds":["stargate"]}'
node bin/scene-director.js call set_location '{"celestial":"Jita IV - Moon 4 - Caldari Navy Assembly Plant","range":30000}'
node bin/scene-director.js call set_location '{"celestial":"Perimeter gate","system":"Jita"}'
```

- `search_map` (regions, constellations, systems, stars, planets, NPC stations, stargates), `get_system` (one system,
  its star, the region's nebula, its celestials), `set_location` (resolve a celestial, compute the origin, forward one
  `patch_scene`; with `scene` edits that document with no tab, `loaded: false`). With `origin` + `system` it places the
  scene with no celestial.
- `range` = metres off the celestial's **surface** on its EVE radius; `direction` = from the celestial toward the origin
  (`"sun"`, `"away"`, `[x, y, z]`); `offset` (from its centre) replaces both. Defaults frame a scene; they are not EVE's
  warp-in points:

| Kind | Default range | Default direction |
|---|---|---|
| star, planet, moon | one radius (the body spans 60°) | `"sun"` (the star itself: +Z) |
| station | 5,000 m | `"sun"` |
| stargate | 2,500 m | `"sun"` |
| asteroid belt | 0 m from its centre (not solid) | `"sun"` |

- `set_location` only sets the location; its result names the region nebula (a passed `nebula` arg is ignored with a
  warning). **It no longer writes `environment.universe`.**
- `GET /map/system?id=<system>&origin=<x>,<y>,<z>`: system, star (light + model), region nebula, every celestial with
  graphics and stargate rotations, origin-relative, nearest first.

## tools-core map quirks (each cost debugging)

- **Map rows carry `radius: null` for stations and stargates**, so `MapData` reads the type's SDE radius. The generic
  star/planet/moon types carry a **10 km placeholder** radius, so the map row's radius wins when it has one.
- **The map search does not index moons or asteroid belts.** `set_location` finds them through their system's celestial
  list, taking the system as the **longest leading words of the name that are a system name**. System names contain
  spaces (`New Caldari`): **never split on the first word**.
- **Stargates are named after their destination**: `Stargate (Perimeter)` sits in Jita and four other systems, so
  without `system` it is ambiguous.
- A **degraded map index** names stations on moons after their planet (fix in `sd-dev-env`).
- `MapData` reads the hub's single pinned SDE build; galactic `position`s are never read.

## Name resolution order

The exact name; a name inside `system` (`"IV - Moon 4"`, `"Star"`, a unique part like `"Business Tribunal"`);
`"star"` / `"the sun"`; a gate shorthand (`"Perimeter gate"`, `"the gate to Perimeter"`); `"<celestial> in <system>"`.
Without `system`: exact name across the map, then that phrase, then the longest-leading-system-words rule
(`"Jita IV - Moon 4"`, `"New Caldari V - Moon 1"`). Ambiguous names list candidates. No player slang (`"Jita 4-4"`).

## Order targets by name

`order_ship` and `order_fleet` take a name where they take a target id. `Director.NamedTarget` rewrites an order whose
`target` is no ship, object or celestial target id (and has no `point`) **in the page, synchronously, before it is
normalized**, with `resolveNamedOrderTarget` over the document's objects and the `/map/system` answer (origin-relative,
so no hub call). `from` is the ordered ship, or the fleet's FC. First match wins:

1. an object by its exact `name` (`normalizeMapName`), then by its `type` (a name or a type id) when exactly one has
   it; several list their ids;
2. a celestial by `matchCelestialName` (the rules above, with the location's system name); several list their names,
   nearest first;
3. a station or stargate → its `celestial:<id>`, refused when it is not a live target (beyond the extent: "…; set_location
   there first"; or no radius);
4. a planet, moon, star or asteroid belt → **warp only** (any other order is refused): a warp to the point
   `centre + unit(from − centre) × (radius + range)` (a belt's radius counts 0), range 0, refused when that landing is
   beyond `MAX_SCENE_DISTANCE`. From the spec fixtures, warping from the CNAP 30 km origin: Jita IV - Moon 4 lands about
   2,600 km out; Jita IV lands about 51,000 km out and is refused.

Nothing matching leaves the order to the normalizer's "not a ship, object or celestial target" refusal. The tool
results add `resolved { name, kind, target? | point?, range }` and `order` holds what it became. Specs:
`names.spec.ts`, `named-targets.spec.ts`.

## `get_state.location`

System, origin, fetch status, the anchor's actual distance and surface distance, the star's distance and direction, the
ten celestials nearest the origin, `dressing` (sub-doc) and `targets`. The overlay shows a `location` row.

## Celestial targets (`celestial:<id>`)

The location's **stations and stargates** within the scene extent (10,000 km of the origin, `sd-scene-document`) with
a radius are order targets: `order_ship` approach, keep-at-range, orbit and warp take `celestial:60003760`. Each is a
static Destiny ball (`DestinyWorld.AddObject`, `sd-destiny`) on the SDE radius, kept in step by
`Director.SyncCelestialTargets` after every location fetch (`PlanCelestialTargetSync` in `objects.ts`): a new location
replaces them all, a cleared or failed one removes them and halts what flew at them. They are **not camera targets**
and never enter the document. `get_state.location.targets` lists `{ target, id, name, kind, radius, distance,
surfaceDistance }`, nearest first. Measured: a TFI approaching the Jita CNAP (SDE 100 km) with its MWD on overshot to
4.7 km inside the SDE sphere, which on screen sits just off the station's hull.

The data is CCP's static data (tools-core's map routes over the public SDE; no ESI, no API key).
