# Location dressing (sd-locations sub-doc)

How the page dresses a scene from its location the way the client dresses a system. `packages/scene/src/lib/location/dressing.ts`
plans it (`toLocationDressingPlan`, `toPlanetPassDistance`); `apps/viewer/src/lib/celestials.ts` is the pure half in the
page (height map patch, `?dress=`, slot reconcile, report; node-tested); `apps/viewer/src/lib/location-dressing.ts`
(runtime) draws it. The base client dressing every scene gets (post process, exposure) is `environment.ts`: `sd-runtime`.

## What gets drawn

- **Nebula**: the region's (The Forge: `res:/dx9/scene/universe/c02_cube.black`), swapped in **live without a reload**.
  `environment.universe` stays the nebula for a scene with no location; clearing the location brings it back. A change
  of `environment.universe` itself still reloads the tab.
  - `Engine.universe` is the document's universe (the reload trick); `Engine.nebula` is what is drawn. `SetNebula`
    resets the fields every universe file sets, hydrates a fresh background `Tr2Effect` and reloads the env maps through
    `OnModified`.
- **The star**: light direction from the origin toward it (a sun ball); its sun disc in the planet pass; its environment
  template as the post process (`env_<sun graphic>`, else the `_01a` variant, else `DEFAULT_SUN_TEMPLATE`
  `env_sun_yellow_01a`); its lens flare (the graphic minus `sun_` and the variant; Triglavian suns have their own;
  default `yellow`), the flare on its own curve at the star's **true** distance.
- **Planets and moons** with radius / distance ≥ `MIN_DRESSED_BODY_SIZE` 5e-4 (~3 px across 1920 px at 45°), biggest
  first, at most `MAX_DRESSED_BODIES` 12, from their shader presets at real directions and angular sizes. An origin
  inside a body skips it.
- **NPC stations and stargates** with SDE radius / distance ≥ `MIN_DRESSED_OBJECT_SIZE` 3e-4, at most
  `MAX_DRESSED_OBJECTS` 8, as **static SOF objects** at true origin-relative positions: gates turned by tools-core's
  quaternion to face their destination; stations unrotated (tools-core serves no station rotation). Not Destiny balls,
  not order targets. The camera's back clip grows to cover the farthest.
- Not drawn: asteroid belts, authored objects, player structures, celestials too small to see.

## Planet pass rules (each cost debugging)

- The planet pass draws `scene.planets` at **1 / 1e6** scale between clip planes 0.01 and 1e5, i.e. **1e4 .. 1e11 m**
  world (`PLANET_PASS_FAR_DISTANCE`). `toPlanetPassDistance` pulls a body beyond `PLANET_PASS_KNEE_DISTANCE` 5e9 m in
  along its direction on a log curve, with the radius scaled to keep its angular size.
- **Model radii**: the sun core mesh has radius 0.5 (`SUN_MODEL_RADIUS`) and `planetsphere.gr2` radius 1
  (`BODY_MODEL_RADIUS`), so **sun `scaling = 2r`, planet `scaling = r`**.
- **The sun disc's translation curve must *be* `scene.sunBall`**: Carbon picks the sun by identity (it also sets the
  light direction each frame). The flare gets its own true-distance curve.
- A body's surface under 10 km from the camera is cut by the planet pass's near plane.
- **Height maps**: a planet template's `HeightMap = res:/texture/global/black.dds` is the client's bake target; the page
  binds the celestial's heightMap1 only there (gas giants author their own, moons have none).

## Stations, gates and teardown

- Built with `BuildShipValues` + `HydrateSofObject` on fixed `Tr2TranslationAdapter` / `Tr2RotationAdapter` curves,
  and retired with every live ship root retained (so shared resources survive).
- **Retire a replaced `EveLensflare` with `Destruct()`.**

## Re-dressing

Everything is placed from `/map/system`'s origin-relative metres. Changing the location reconciles **by slot** (same
celestials move, new ones build, gone ones retire); clearing it undresses. Without a renderer (headless verify-page)
the plan still runs: bodies load as values and stations/gates build to SOF values, reported `validated`.

## Reporting and switches

- `get_state.location.dressing`: state (`loading`, `ready`, `partial`, `failed`, `off`), the nebula, the sun (graphic,
  template, flare, true and drawn distance), counts per kind (drawn, validated, loading, failed, skipped) and every
  dressed planet / moon / station / gate with its state and error. `get_state.environment.nebula` says which nebula is
  drawn and whether it comes from the location or `environment.universe`. The overlay shows a `dressing` row.
- `?dress=off|all|<nebula,sun,planets,objects>` (`LOCATION_DRESSING_PARTS`) switches parts for A/B; `?post=` and
  `?flare=` override the star's template / flare (`sd-dev-env`).
- `?fog=on` keeps the template's distance fog (dropped by default: it fogs planets as background so they read
  translucent, washes the frame, and draws a flat haze a far camera sees as a glowing disc).
