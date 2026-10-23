# Fleet compositions (`cjs-fleet/1`) (sd-fleets sub-doc)

A doctrine fleet written once and dropped into a scene as often as wanted: an FC, wings, and squads of hull lines with
counts, roles and anchors. Code: `packages/scene/src/lib/compositions/` (`composition.ts` types, `normalize.ts`,
`expand.ts` (`expandFleetComposition`), `eft.ts` (fit header), `operation.ts` (`add_fleet_composition` op),
`examples.ts` + `examples/tfis.json`); hub tools in `apps/scene-director/src/lib/hub/fleet-compositions.ts`; disk store
`store/composition-files.ts` (`FleetCompositionFileStore`).

## Document

```json
{
  "schema": "cjs-fleet/1",
  "id": "tfis",
  "name": "TFIs",
  "source": "https://my.minmatar.org/ships/doctrines/13-tfis/",
  "commander": { "hull": "Tempest Fleet Issue", "dna": "mb2_t1:minmatarnavy:minmatar", "radius": 250, "name": "FC", "fit": "tfi" },
  "wings": [
    { "id": "mainline", "name": "Mainline", "squads": [
      { "id": "dps-a", "name": "DPS A", "role": "dps", "ships": [{ "hull": "Tempest Fleet Issue", "count": 10, "propMod": "500MN Cold-Gas Enduring Microwarpdrive", "fit": "tfi" }] },
      { "id": "ewar", "name": "Bhaalgorns", "role": "ewar", "anchor": { "range": 2500 }, "ships": [{ "hull": "Bhaalgorn", "count": 3 }, { "hull": "Vindicator", "count": 2 }] }
    ] },
    { "id": "logistics", "squads": [{ "id": "logi", "role": "logi", "ships": [{ "hull": "Guardian", "count": 5 }, { "hull": "Zarmazd", "count": 3 }] }] },
    { "id": "capitals", "squads": [{ "id": "fax", "role": "logi", "anchor": { "on": "logi", "range": 5000 }, "ships": [{ "hull": "Apostle" }] }] }
  ],
  "fits": { "tfi": "[Tempest Fleet Issue, [FL33T] Tempest Fleet Issue]\n..." }
}
```

| Where | Field | Rule |
|---|---|---|
| top | `schema` | optional; when present `cjs-fleet/1` (a scene document passed by mistake is refused) |
| top | `id` | required: default fleet id and ship id prefix |
| top | `name`, `description`, `source` | optional; `name` names the fleet and the saved composition |
| top | `commander` | required: the FC's ship (a line without `count`), in EVE's FC slot (no squad) |
| top | `wings` | default `[]`; FC-only is valid |
| top | `fits` | optional EFT text by key; each must start with `[Hull, Fit name]` |
| wing | `id`, `name?`, `squads` | ids unique in the composition |
| squad | `id`, `name?`, `role`, `anchor?`, `ships` | ids unique across wings; `fc` and `lead` reserved |
| line | `hull` | exact English type name or type id → each ship's `type`. Omitted: its fit header's hull |
| line | `dna`, `radius` | SOF DNA and EVE radius (m); filled by the hub tool when missing |
| line | `count` | 1..256, default 1 |
| line | `name`, `propMod`, `fit` | name base; prop mod (→ each ship's `propMod`); a `fits` key |

A line needs `hull`, `dna` or `fit`; a string `hull` must match its fit's header. All validated together; unknown keys
warn and drop; values kept as written (a saved composition reads back as written). ≤ 256 ships with the FC.

## Anchors (`{ on?, range? }`, surface to surface)

| `on` | Means | Scene anchor written |
|---|---|---|
| `fc` (default except logi) | every ship keeps `range` (default 1,000) on the FC | `{ range }` or none |
| `lead` (logi default) | the squad's first ship keeps `range` (default 30,000) on the FC; the rest anchor up on it at 1,000 | `{ ship: <first>, range? }` |
| a squad id | every ship keeps `range` (default the role's) on that squad's first ship | `{ ship: <its first>, range? }` |

Exactly the anchors the fleet rules resolve; nothing re-derived.

## Expansion

- Ships placed at rest by `layoutFleetFormation` (`sd-fleets`), at the FC's position/heading, with the line radii.
- **Ids**: fleet = composition `id` (`tfis`), else `tfis-2`, `tfis-3`… when the fleet or any ship id is taken (or pass
  `fleet`). Ships `<fleet>-fc`, `<fleet>-<squad>-<nn>` (`tfis-dps-a-01`). FC named `FC` (or the commander's `name`);
  others the line's `name` or hull, numbered within a line adding more than one (`Tempest Fleet Issue 7`).
- **Prop mods**: a line's `propMod` → each ship's `propMod`. A line with `fit` and no `propMod` takes the first fitted
  MWD/AB in its EFT text (cargo/drone `xN` lines skipped, `/OFFLINE` and charges dropped), or `"none"` when the fit has
  neither; a line with neither flies the hull-sized MWD.
- **Fits ride on the ships**: each line ship gets `fit: "<composition id>/<fit key>"` and the op merges the texts it
  uses into the scene's `fits` once (a second fleet of the composition reuses them; other text under the key gets
  `<fleet id>/<fit key>`). Rules and the parser: `sd-fittings`.

## Hub vs op

- **The `add_fleet_composition` patch op is pure**: it needs `dna` on every line and says to use the tool otherwise.
- The **hub tool of the same name** resolves each distinct hull missing `dna` or `radius` through tools-core
  (`dna/resolve`, SDE `radius`), reports `hulls` (source `composition` / `sde` / `default`), refuses an unresolvable
  hull with no `dna`, warns when a line's `dna` names another SOF hull than the EVE data. It checks each distinct
  module name (group 46 listing; `PropModByName`), reports `propMods` (`module`, `typeID`, `from`: `sde` / `unknown` /
  `unchecked`); unknown warns and those ships fly the hull-sized default.
- Tool args: `name` | `composition` (inline), `position` (the FC's) **or** `near { ship | object | celestial, range?,
  direction? }` (exactly one; resolved by `ScenePlaces.ResolvePlace` on the **commander line's** radius, as
  `add_ships`; off a ship or object it takes that heading unless `heading`, `facing` or `warpIn.from` is given),
  `heading` (yaw°) or `facing` (a point or `{ celestial }`), `fleet?`, `team?`, `warpIn?` (land from warp: `sd-staging`
  "Warp-in"; `from` sets the heading, `{ celestial }` resolved to a point), `scene?` (edit that document with no tab;
  result returned, not shown; a `warpIn` then warns that the document places them at their landing). The tool reads
  the tab's document (get_scene) only when `near` or a `{ celestial }` needs it. Result = `patch_scene` result (the
  page's `arrivals` included) + `added` (`fleet`, `commander`, `ships`), `hulls`, `propMods`. `FleetCompositions` takes
  `mapData` (for celestials).
- Remove again: `{ "op": "remove_fleet", "fleet": "tfis", "withShips": true }`; look at it with
  `frame_camera { "target": "tfis-fc" }`. The raw op is `{ "op": "add_fleet_composition", "composition", "position",
  "heading"? | "facing"?, "fleet"?, "team"?, "warpIn"? }` (its fleet recorded in the result's `arrivals`) and composes with other ops in one patch.

```sh
node bin/scene-director.js call add_fleet_composition '{"name":"tfis","position":[0,0,80000],"heading":180,"team":"blue"}'
node bin/scene-director.js call switch_prop_mods '{"fleet":"tfis","active":true}'
```

## Saved compositions

`save_fleet_composition` writes one JSON file per composition (named like saved scenes; saves under `name`, else `id`)
to `--fleets <dir>` / `SCENE_DIRECTOR_FLEETS`, default `scene-director/fleets` in the per-user data dir (`viewer_status`
→ `fleetsDirectory`). Built-in examples list as `store: "example"`, read-only; a saved one of the same name shadows it.
`call --in` fills `composition`; `--out` writes what `get_fleet_composition` returns. **Tests pass a temp
`FleetCompositionFileStore`.**

## The TFIs example (`examples/tfis.json`, name `tfis`)

The close-range armor doctrine of my.minmatar.org with its 13 `[FL33T]` EFT fits; 44 ships chosen:

| Wing | Squad | Role | Ships | Anchor |
|---|---|---|---|---|
| (FC slot) | | | 1 Tempest Fleet Issue "FC" | |
| Mainline | `dps-a`, `dps-b` | dps | 10 TFI each | FC, 1,000 m |
| | `ewar` | ewar | 3 Bhaalgorn, 2 Vindicator | FC, 2,500 m |
| | `tackle` | tackle | 2 Devoter | FC, 1,000 m |
| | `boost` | boost | 1 Damnation, 1 Eos | FC, 1,000 m |
| Logistics | `logi` | logi | 5 Guardian, 3 Zarmazd | own lead, 30,000 m off the FC |
| Capitals | `dreads` | dps | 2 Revelation | FC, 10,000 m |
| | `fax` | logi | 1 Apostle | the logi lead, 5,000 m |
| | `carriers` | support | Thanatos, Nidhoggur, Archon | FC, 15,000 m |

Every line carries `dna` and `radius` (checked against SDE build 3632936), so it needs no tools-core. Fits beyond prop
mods (turrets) and fleet warp-in are stored/planned, not played: added fleets start at rest in formation, prop mods off.

Real GPU (2026-10-22): all 44 hulls built in 4–5.5 s (38–49 fps during the build); 45 ships at ~46 fps at rest,
25–50 fps in flight; no GPU errors; no mesh intersections in formation (14 TFI pairs at 850–870 m overlap as drawn
bounding spheres only).
