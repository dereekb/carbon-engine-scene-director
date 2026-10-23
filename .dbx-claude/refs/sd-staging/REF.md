# Scene building: `add_ships` and `stage_engagement`

> Two hub tools that add N ships, or two opposing sides, in one call. Fetch before touching
> `packages/scene/src/lib/staging/` or `apps/scene-director/src/lib/hub/staging.ts`. Fleet rules they rely on:
> `sd-fleets`.

## Split: hub resolves, op is pure

- `hub/staging.ts` resolves every name first: hull names → SOF DNA + EVE radius (tools-core SDE, as
  `add_fleet_composition` does), compositions by name, celestials of the scene's location → scene points, and the EVE
  radii of a fleet the ships join (`radii`). Then it sends **one pure patch op of the same name** to the tab, or applies
  it to a passed `scene` with no tab.
- The raw ops (`staging/operation.ts`: `{ "op": "add_ships", "dna", ..., "radii"?: { "<ship id>": m } }`,
  `{ "op": "stage_engagement", "sides": [...], ... }`) take the same fields with every line's `dna` filled. They
  accept `near.ship` / `near.object` and a ship or object id for `facing` **against the draft** (`staging/draft.ts`),
  so one patch can stage off a ship or object it just added. They refuse celestials and hull names without dna.
- **`hub/scene-places.ts` `ScenePlaces`** holds the plumbing `Staging`, `FleetCompositions` (`add_fleet_composition`'s
  `near`) and the objects tools (`sd-objects`) share, moved out of `staging.ts`: `Before` (the tab's document, or a
  passed `scene`; `{ read: false }` skips get_scene), `Apply` (one `patch_scene` or a local apply; operation warnings
  split from the rest of the result), `ResolveRadii`, `ResolvePlace` (`near` off a ship, object or celestial → the
  lead's point, the implied heading, the reference point), `ResolveFacing` (`{ celestial }` → a point) and
  `ResolveWarpIn` (`warpIn.from: { celestial }` → a point). `staging.spec.ts` guards the extraction.

| File | Role |
|---|---|
| `staging/add-ships.ts` | `add_ships` |
| `staging/engagement.ts` | `stage_engagement` |
| `staging/formations.ts` | shape formations (heading frame, lead at origin) |
| `staging/placement.ts` | heading frame (yaw only), headings toward a point, a point at a range off a ship. The hub reuses it for celestials |
| `staging/ships.ts` | ship lines, ids, the inline composition a ship list becomes |
| `staging/draft.ts` | a ship's document placement read off the draft |

```sh
node bin/scene-director.js call add_ships '{"hull":"Rifter","count":10,"formation":"wedge","near":{"ship":"tfis-fc","range":20000},"facing":"tfis-fc","team":"red"}'
node bin/scene-director.js call stage_engagement '{"sides":[{"composition":"tfis"},{"ships":[{"hull":"Ferox","count":20},{"hull":"Scimitar","count":4}]}],"range":20000,"near":{"celestial":"Jita IV - Moon 4 - Caldari Navy Assembly Plant","range":40000}}'
```

## Templates

`add_ships`'s result `template` is the `cjs-fleet/1` composition of what it added (first ship the FC, the rest one
squad). `save_fleet_composition` stores it; `add_fleet_composition` and engagement sides spawn it by name.

## Formations (ships outside fleets only)

Laid out in the heading frame (x right, y up, z forward), the **lead** (ship 01) at the place. `s` = spacing,
`centreOut` = 0, +1, −1, +2, −2, …

| Formation | Ship k | The place is |
|---|---|---|
| `sphere` (default; `blob`) | shells at `i·s` around the lead, `ceil(40·i²)` Fibonacci candidates each, trailing pole first; kept when ≥ `s` from every kept ship (256 fit in 4 shells) | the centre |
| `line` (abreast) | `(s·centreOut(k), 0, 0)` | line centre |
| `column` (astern) | `(0, 0, −k·s)` | the head |
| `wedge` (V) | arm `a = ceil(k/2)`, right for odd k: `(±a·s·sin45°, 0, −a·s·cos45°)` | the tip |
| `grid` | `w = ceil(√N)` abreast per rank: `(s·centreOut(k mod w), 0, −floor(k/w)·s)` | front rank centre |
| `wall` | `w = ceil(√N)` per row, rows up/down: `(s·centreOut(k mod w), s·centreOut(floor(k/w)), 0)` | the centre |

Whole metres; every ship faces the heading (yaw only). Default spacing = fleets' rule for two of the hull,
`ceil(1.5 × 2r + 100)` (Rifter 193 m, TFI 850 m); unknown radius counts as 500 m with a warning; `spacing < 2r` warns
of overlap; mixed lists use the largest radius.

## Places and headings

- `position` `[x, y, z]` is the lead's place, or `near { ship | object | celestial, range?, direction? }`:
  - off a **ship**: `range` (default 5,000 m) surface to surface on both EVE radii; `direction` `ahead` (default),
    `behind`, `left`, `right` (the ship's own heading), `above`, `below`, `sun`, `away` (need a location), `origin`,
    or `[x, y, z]`. **The ship is used at its document placement, not where it has flown since.**
  - off an **object** (`sd-objects`): as off a ship, on the object's document radius (else 1,000 m) and its yaw, so a
    fleet can stage off a structure.
  - off a **celestial** of the scene location's system (named as `set_location` names them inside a system, or by id):
    `range` off its surface with `set_location`'s per-kind defaults; `direction` `sun` (default), `away`, `origin`,
    `[x, y, z]`. A scene with no location is refused.
- `heading` yaw° (0 → +Z, 90 → +X) or `facing` (a point, a ship or object id, or `{ celestial }`; straight
  above/below refused). Default: the near ship's or object's heading, else 0.
- **The scene extent** (`sd-scene-document`): a ship placed past 2,000 km from the origin warns (`largeSceneWarning`,
  replacing the old 100,000 km far warning), and the document refuses one past 10,000 km.

## Fleets

| `fleet` | Does | Placement |
|---|---|---|
| `{ "new": true, "id"?, "name"?, "squad"? }` | new fleet from an inline composition: first ship FC, rest one squad (id = role) in `wing-1`; `id` refused when taken, else prefix numbered | FC at the place facing the heading; rest at their slots |
| `{ "id": "<fleet>", "squad": "<squad id>" }` | joins a squad (`move_to_squad`) | Follow-the-FC slots around the FC's **document** placement |
| `{ "id": "<fleet>", "squad": { "id"?, "role"?, "anchor"?, "name"? }, "wing"? }` | new squad (id = role, `logi-2` when taken) in the fleet's **last** wing (`wing-1` made for a wingless fleet) | at their slots |

- **Ships joining a fleet are placed at their Follow-the-FC slots** (`layoutFleetFormation` at the FC's document
  placement, with the hub-filled `radii`), **never in a shape formation**, which Follow the FC would scramble. So joins
  refuse `formation`, `spacing`, `position`, `near`, `heading`, `facing`; a new fleet refuses `formation`, `spacing`.
- **Joining a squad re-plans the fleet**: slots go in wing, squad, member order, so later squads on the same shell move
  (TFIs `dps-a` + 2 moves 14 members by up to 3.5 km); the op warns with the count. A new squad in the last wing moves
  nobody. ≤ 256 ships per fleet.
- Role default from the hull's EVE group: Logistics, Logistics Frigate, Force Auxiliary → logi; Interdictor, Heavy
  Interdiction Cruiser, Interceptor → tackle; Electronic Attack Ship, Recons → ewar; Command Ship, Command Destroyer →
  boost; Carrier, Supercarrier → support; else dps (raw ops default dps). Anchors take the composition form
  `{ on?: "fc" | "lead" | "<squad id>", range? }`.

## Ids and names

Free ships and joins: `<prefix>-<nn>` after the highest number already used with the prefix (≥ 2 digits). Prefix =
`prefix`, else the name/hull slug (`tempest-fleet-issue`), or `<fleet>-<squad>` when joining. Names `<name or hull> <n>`.
`type` = canonical SDE name; `team`, `stats`, `propMod`, `pilot` go on every ship (`add_ships { pilot }`, a ship
line's `pilot`; the hub forwards `add_ships`' `pilot`); `fleet: { new: true, personality? }` and a fleet side's
`personality` (else its composition's) set the new fleet's personality (a free side refuses one): a built-in or saved
name, or an inline template, which the hub embeds in the same patch (`sd-personalities`). A line's `fit` (EFT text; the hull defaults to
its header's) goes on every ship too, kept once in the scene's `fits`: `<fleet id>/<fit name slug>` for a new fleet or a
fleet side, `<id prefix>/<fit name slug>` for free ships and joins; the returned `template` carries it in its `fits`
(`sd-fittings`). New fleets take composition ids. **Ship ids
skip object ids** (ids are unique across both), and a ship id an object holds is refused.

## Engagements

- Exactly two sides; A faces `heading`, B faces back. Each side's **front** = how far its ships reach ahead of its
  reference (FC or lead), laid out at the origin. A's reference at `C − f·(range/2 + front_A)`, B's at
  `C + f·(range/2 + front_B)`, so fronts are exactly `range` apart around `C` (TFIs vs 8 Ferox + 2 Scimitar at 20 km:
  FCs 20,465 m apart).
- A side is a `composition` (inline/saved/built-in; always a fleet) or `ships: [{ hull, count?, role?, name?, propMod?,
  fit?, pilot?, dna?, radius? }]`: a fleet (FC = first ship, lines = squads in `wing-1`, ids their roles `dps`, `dps-2`), or with
  `fleet: false` free ships in `formation` (ids `<team>-01`…). Fleet ids: side's `fleet`, else composition id, else team.
- Result `engagement` lists per side: team, fleet, commander, ships, lead.

## Warp-in (`warpIn`)

`add_ships` and `stage_engagement` `sides[i]` (and `add_fleet_composition`, `add_ship { ship, warpIn }`) take
`warpIn: true | { stagger? (s, default 4, max 30), together? (default true), from? }`: the new ships wait parked
off-grid and land from warp at their placements (Destiny's EntityWarpIn: `sd-destiny` doc `warp`, "Warp-in").

- **Document layer** (`packages/scene/src/lib/arrivals/arrival.ts`): `readWarpIn`, `toArrivalLane`, `toWarpInHeading`,
  `toArrivalOffsets` (seeded on group key + tick + ship with `unitHash` from `fleets/orders.ts`, continuous in
  [0, stagger], the leader 0), `keepSceneArrivals`. Each op pushes a `SceneArrival { where, group, fleet?, leader?,
  ships, lane, landing: document | formation, stagger, together }` into `FleetOperationContext.arrivals`;
  `applySceneOperations` returns them as `arrivals` (only ships still in the result; none → no key). **The document
  never records an arrival**: the ships are ordinary ships at their landings, so a document-only edit (`scene`, no tab)
  just places them there.
- **Lanes**: level, forward of the heading: free ships and new fleets along their heading, a side along its own
  (B's is A's + 180°), `add_ship` along its rotation's yaw. `from` (a point, or a ship/object id off the draft; the hub
  turns `{ celestial }` into a point) **sets the heading** (yaw from it to the lead's place) and is refused with
  `heading` / `facing`, for joins, for engagement sides and for `add_ship`.
- **Hub tools** (`ScenePlaces`): `add_ships` and `add_fleet_composition` forward `warpIn` with `from: { celestial }`
  resolved to its scene point (`ResolveWarpIn`; a scene with no location is refused; a join's `warpIn` goes through
  untouched, so the op refuses its `from`); an engagement side's `warpIn` rides on the side as given. Under
  `warpIn.from` the hub adds no implied heading off a `near` ship or object (it would clash). `Apply` on a passed
  `scene` (no tab) adds `WARP_IN_DOCUMENT_WARNING` ("warpIn lands ships from warp only in the viewer; this document
  places them at their landing") when the patch recorded arrivals; with a tab the result passes the page's
  `arrivals` reports through.
- **Joins** (`fleet: { id, squad }`) land at their **live** formation slots: `landing: formation`, group
  `<fleet>/<squad>`, leader = the fleet's FC (not in `ships`); the page reads the FC's live position and heading.
- **The page** (`apps/viewer/src/lib/arrivals.ts`, node-tested; `Director.arrivals`): `Arrivals.Add` parks each ship
  right after its ball exists and before any build (`ARRIVAL_PARK_DISTANCE` 4,000 km back along the lane, `at: null`),
  so a hull never shows at its landing. `Boundary(tick)` (on `world.OnBoundary`, and once after an Apply's builds)
  plans a group when every ship's `/ship-stats` answer and SOF build have settled (`Director.ArrivalReady`; a join
  also `FleetFollowing.Ready`), or after `ARRIVAL_READY_TIMEOUT` (20 ticks, with a note). A ship with max velocity 0
  is placed at its landing (dropped, noted).
- **Planner** (`PlanArrivals`, pure over `DestinyWorld.WarpProfile`): `WarpInMinDistance` = the smallest lane (bisection
  on log D) whose remaining distance a tick past the 5-tick backdate is ≥ `WARP_IN_HIDDEN_DISTANCE` (2,000 km);
  `together`: target = the slowest hull's `WarpDropOutTime(D_min) − backdate` + its offset; by speed: its own + offset.
  Start tick = boundary + ⌊wait⌋, the fractional rest absorbed by a longer lane (`WarpInDistanceFor`, still ≥ D_min).
  The world's first ticks backdate less (`WarpInBackdate`): the plan settles it per start tick. Spec-pinned: exits on
  the planned tick ±1, ≥ 2,000 km out on the first tick of the warp-in, within 1 km of the placement.
- **Formation landings**: `FramePoint(FC origin, frame, GroupOffsets offset)` as `FleetOrders.Warp` predicts slots: the
  FC's landing in its warp frame while it warps or arrives, else its position in its heading's frame; the lane follows
  the FC's live heading (its arrival lane while it arrives).
- **Reports**: the Apply result's and `get_state`'s `arrivals`: per group `{ group, fleet?, leader?, ships: [{ id,
  state, landsIn?, note? }], state, counts, lands: { first, last } (s from now, once planned), together, stagger,
  landing, notes? }`; ship states `waiting | scheduled | warping | landed | forming-up | formed | dropped` (formed = in
  formation / leading, or a landed free ship under 1 m/s; dropped = placed, removed or refused). A group is kept
  `ARRIVAL_FORMED_KEEP` (30 ticks) after it formed. A load or open clears them; a removed ship leaves its group.
- **While arriving**: orders, prop mods, modules (the modules port's `InWarp` is `InWarp || Arriving`) and
  `frame_camera` on it are refused; framing (`ApplyCamera`'s `WorldSphere(doc, { landing: true })`) puts it at its
  landing; Follow the FC reports `following.state` `arriving` and `formation.arriving` counts it.

## Defaults

| Argument | Default |
|---|---|
| `count` | 1 (≤ 256 per call or side) |
| `formation` | `sphere` |
| `spacing` | `ceil(1.5 × 2r + 100)` m (500 m radius when unknown) |
| place | `[0, 0, 0]` |
| `near.range` | 5,000 m off a ship; per kind off a celestial (station 5 km, gate 2.5 km, star/planet/moon one radius, belt 0) |
| `near.direction` | `ahead` (ship), `sun` (celestial) |
| team | none (`add_ships`); `blue` / `red` (`stage_engagement`) |
| engagement `range` / centre / heading | 20,000 m between fronts / `[0,0,0]` / across the line from `near`, else 0 |

**Limits**: placements read document positions, not live ones; 256 per call/side; yaw only; beyond `STAGING_FAR_DISTANCE`
(1e8 m) from the origin ships draw with float32 jitter.
