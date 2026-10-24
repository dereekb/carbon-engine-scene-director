# Ship selectors: the scopes and filters every fleet lever takes

> Fetch before touching `packages/scene/src/lib/selectors/`, a tool or op that takes `ships` / `fleet` / `all`, or
> `Director.SelectShips`. The fleet structure the scopes walk: `sd-fleets`; immunity, the first adopter: `sd-combat`.

**Status (2026-10-24)**: the immunity-and-selectors plan
(`~/.claude/plans/damage-immunity-and-a-generic-apply-to-fleet-apply-to-scene-targeting-layer.md`) lands in four
slices. **S1 is in**: the pure selector (`readShipSelector`, `selectShips`, the report) and its first adopter, the
`set_immunity` patch op (`sd-combat` → Damage immunity). **S2** adds the page's facts (`Director.SelectShips`) and the
`set_immunity` tool; **S3** moves `switch_prop_mods`, `switch_modules`, `set_target`, `engage`, `cease_fire` (and
`set_hp`) and the `set_prop_mods` op onto it; **S4** is the real-GPU look.

## The grammar (the one place it is written)

```text
<selector> := <scope> <filters>
<scope>    := "ships": [<ship id>, ...]                         these ships
            | "fleet": <id> [, "wing": <id> | "squad": <id>]    the fleet, one wing, or one squad
            | "all": true                                       every ship in the scene
<filters>  := "role"?:   <role>   | [<role>, ...]               squad roles: dps, logi, tackle, ewar, boost, support
              "team"?:   <team>   | [<team>, ...]               ships[].team, case-insensitive
              "hull"?:   <hull>   | [<hull>, ...]               EVE type name or type id, or ship group name
              "state"?:  <state>  | [<state>, ...]              alive, destroyed, damaged, undamaged, in-warp, on-grid
              "sample"?: <count> | "<p>%" | { "count"?: n, "percent"?: p, "seed"?: s }
```

- **Exactly one scope**, so a filter alone never means "everything" (`set_hp { armor: 0 }` must not hit the scene):
  `<where> needs exactly one of ships (ship ids), fleet (a fleet id, optionally with wing or squad) and all (every ship
  in the scene)`. `all` must be `true`. `wing` / `squad` need `fleet` and exclude each other (unchanged; `all` with
  `squad` gets "give fleet too"). `readFleetSelection` keeps its own two-scope message for `order_fleet` and the rest.
- **AND across keys, OR within a list, `sample` last.** `fleet: "blue", role: "logi"` is blue's logi; `all: true, team:
  "red", role: ["dps", "tackle"], state: "alive"` every live red DPS or tackle ship.
- **role**: the ship's squad role in the document's fleets, from a draft-tolerant walk (not `toFleetMemberships`, which
  wants a normalized document). Ships outside squads (an FC or wing commander in no squad, free ships) have none.
- **team**: `ships[].team`, case-insensitive; a ship with no team never matches.
- **hull**: a type name (case-insensitive), a type id (an integer or a string of digits), or a ship group name, matched
  against the ship's `/ship-stats` answer (`typeID`, `name`, `group`). A ship whose answer is pending is **unresolved**:
  left out, listed, warned about. A ship with no EVE type matches nothing.
- **state** (`SHIP_SELECTOR_STATES`):

  | State | Matches when |
  |---|---|
  | `alive` | not destroyed (either death mode) |
  | `destroyed` | destroyed: flagged, exploding or lingering |
  | `damaged` | alive, and some layer under `DAMAGED_FRACTION` (0.999) of its max |
  | `undamaged` | alive, and every layer at 0.999 or more, or untracked by the damage model |
  | `in-warp` | alive, and in warp or still arriving by warp |
  | `on-grid` | alive, neither |

  0.999, not 1: shields regenerate asymptotically (a Rifter's shield from 91 % reads damaged for about 7 minutes).
- **sample**: `5` keeps 5 (all when fewer matched); `"30%"` keeps `round(n × 30 / 100)`, at least 1 of a non-empty set;
  `{ count | percent, seed? }` gives a seed (an integer 0 … 2³² − 1). See Sample seeding.
- **Normalized form** (what `readShipSelector` returns and a timeline cue stores): the four filters as arrays,
  deduplicated (strings case-insensitively) in the order given, roles and states lower case; `sample` an object;
  `all: true`. Reading it again changes nothing.
- **Problems** (nothing applies): the scope rules; a role or state outside its list; a team that is not a non-empty
  string; a hull neither a non-empty string nor a positive integer; a bad sample (not a count, a percent or the object;
  both or neither of count and percent; percent ≤ 0 or above 100; a bad seed; an unknown key); an unknown ship, fleet,
  wing or squad (`selection: no ship "x"`, as `selectFleetShips`).
- **Warnings** (the lever applies to what matched): a role, team or hull entry matching no ship **in the scope**,
  naming what it holds (`selection.team "rde" matches no ship in fleet "blue" (teams there: blue)`, `selection.hull
  "Rfter" matches no ship in the scene (hulls there: Rifter, Punisher; groups: Frigate)`); unresolved hulls
  (`2 ships were left out: their EVE types are still loading ("r4", "r5"); call again once they have loaded`).

## Resolution, facts and the report (`selectors/select.ts`)

- `selectShips(scene, selector, { where?, seed?, facts?, liveHint? })` is pure and tolerant of a draft mid-patch. Order:
  the scope (`ships` / `fleet` through `selectFleetShips`; `all` every document ship), then `role`, `team`, `hull`,
  `state`, `sample`. Each filter step counts what it removed (`excluded`); a ship an earlier filter removed is never
  looked up by a later one, so it is never unresolved (the unmatched-entry warnings still read the whole scope).
- **Facts** (`ShipSelectionFacts`, from the page): `hullOf(id)` → `{ typeID, name, group? }`, `null` (no EVE type) or
  `undefined` (pending); `stateOf(id)` → `{ destroyed, inWarp, fractions? }`. The thresholds (`DAMAGED_FRACTION`, the
  state table) live in the pure code (`stateMatches`).
- **Without facts** (the document ops) `hull` and `state` are problems ending with the caller's `liveHint`:
  `operations[0].hull and .state read the live scene (each ship's EVE type and state): use the set_immunity tool, which
  resolves them in the viewer`. `role`, `team` and `sample` work. So `applySceneOperations` never resolves a live
  filter: the tool compiles to explicit ship ids and stays synchronous and pure.
- **Result**: `{ ships (document order; empty on a problem), problems, warnings, scope, scoped, excluded, unresolved,
  sample? }`; `scope` is a label (`ships`, `fleet "b"`, `fleet "b" squad "logi"`, `all`), `sample` `{ from, kept, seed
  }`.
- **The report** (`shipSelectionReport`): `{ scope, scoped, matched, excluded?, unresolved?, sample?, warnings? }`. A
  lever adds it as `selection` **only when `isFilteredSelector`** (`all` or a filter), so an old call's result is
  unchanged.
- Why the page resolves, not the hub: only the page knows deaths, warp and HP, and it already holds each ship's EVE
  type and group from tools-core (through the hub's `/ship-stats`). A hub pre-pass could only add SDE-wide typo
  detection, and group names would need tools-core's inspection-only `sde/<table>` routes; the unmatched-hull warning
  lists the scene's hulls and groups instead.

## Sample seeding

Each kept ship is ranked by `combatUnit(seed, "select|<id>")` and the lowest k are kept, in document order. Keyed per
ship: the same call picks the same ships whatever order the scene lists them in, a ship added later does not reshuffle
the rest, and a smaller sample with the same seed sits inside a larger one. The `select|` prefix keeps these apart from
the shot rolls, `explosion|` and set_hp's `hp|`. The seed: the sample's `seed`, else the caller's `seed` option, else
the document's combat seed (a draft's `combat.seed`, else 1).

## Who takes it

| Lever | Takes | Since |
|---|---|---|
| `set_immunity` op | the document subset: scope, `role`, `team`, `sample` (`hull` / `state` refused with the tool hint) | S1 |
| `set_immunity` tool | the full selector, resolved by `Director.SelectShips` | S2 |
| `switch_prop_mods`, `switch_modules`, `set_target`, `engage`, `cease_fire`, `set_hp` | the full selector | S3 |
| `set_prop_mods` op | the document subset | S3 |

Unchanged, on `readFleetSelection` / `selectFleetShips`: `order_fleet` (a commander's group order with `by`
authority: a group, not a ship set), called targets, cinema subjects (their own subject grammar), `following.ts`, and
logi's `auto_repair` (a group setting). `order_ship` is one pilot's order.

A parameter, not a separate tool: one call per action, the MCP schema validates the selector on each tool, each tool
keeps its own result. No `apply { lever, args }` dispatcher (its `args` would go unvalidated, and every lever would
have two call forms) and no preview tool (every lever's `selection` report says what it picked; the get_state filter
note covers inspection).

## Adding a lever

1. The normalizer reads `readShipSelector(input, where, problems)`, takes `SHIP_SELECTOR_KEYS` among its known keys,
   names `SHIP_SELECTOR_SHAPE` in its "must be an object" message, and its command type `extends ShipSelector`.
2. The tool schema spreads `SHIP_SELECTOR_PROPERTIES` (`tools.ts`, S2); its prose says "a selection of ships" and never
   repeats the grammar.
3. The director calls `this.SelectShips(command)`, throws its problems as a `SceneError`, and adds
   `selection: shipSelectionReport(result)` when `isFilteredSelector(command)`.
4. A timeline entry needs nothing for the keys: the cue registry reuses the normalizer, and the selection's ids
   (`ships`, `fleet`, `wing`, `squad`) validate and prune as before; filters name no ids.

## Files

| File | Holds |
|---|---|
| `packages/scene/src/lib/selectors/selector.ts` | `ShipSelector`, `SHIP_SELECTOR_STATES`, `DAMAGED_FRACTION`, `SHIP_SELECTOR_KEYS`, `SHIP_SELECTOR_SHAPE`, `readShipSelector`, `isFilteredSelector` |
| `packages/scene/src/lib/selectors/select.ts` | the facts, `selectShips`, `sampleShips`, `stateMatches`, `shipSelectionReport`, the role walk |
| `packages/scene/src/lib/fleets/selection.ts` | `readFleetSelectionParts` (the four keys, shared), `readFleetSelection`, `selectFleetShips` |
| `packages/scene/src/lib/combat/immunity.ts` | the first adopter: `normalizeImmunityCommand`, `applyImmunityOperation` |

Specs: `selector.spec.ts` (every reader, every problem pinned, stability), `select.spec.ts` (every scope and filter,
combinations, sample rounding / seeding / order / nesting, empty sets, unknown ids, warnings, the no-facts refusal,
draft tolerance, the report), `combat/immunity.spec.ts` (the op).

## Verify-page

S2 adds `immunity: …` (set_immunity's fleet, role, team, hull and sample selections), S3 `selector: …` (all, team,
role, state and sample on the existing levers, and an unchanged legacy result).
