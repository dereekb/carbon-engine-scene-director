# Fleet personalities: deterministic FCs a cheap model just picks

## Context

The user wants smaller, cheaper models to drive complex fleet fights. A cheap model should only pick a **fleet
personality** (an FC's playstyle template) per fleet; deterministic page code then runs the fight: target calling,
FC succession when the FC dies (a protocol plus a handover delay), FC ability 0..1 (1 = no delay in calls and fleet
orders), per-pilot reaction delays, movement stances, prop mod use, open-fire rules and free fire. Later, models
must FC themselves, so **every lever the brain pulls is a tool call a model can make** (same JSON), and get_state
shows each call the brain made and why.

Today (refs `sd-fleets` + docs `targets` / `orders`, `sd-combat`, `sd-destiny`, `sd-scene-document`): fleets fly in
formation on their FC; `order_fleet` moves, warps and calls targets (a group's `targets` list: primary + queue;
members lock, pre-lock 2 and shoot; `delay` 0..1 staggers responses through `toPilotDelays`); combat locks, hits and
kills; on an FC's death `toLiveFleetScene` hands the fleet to the first live wing cmdr / squad cmdr / member and the
whole fleet halts. Nothing decides on its own; `ships[].pilot` is a reserved, unused key.

## Decisions (with the user)

1. **Calls are live.** `order_fleet`'s `targets` order stops writing the document (today: `Serialize` → async `Apply`
   → IndexedDB, landing at tick T+1 or later, unusable for a per-tick brain). It edits a live call book synchronously,
   like moves and warps. The document's `targets` become the **opening calls** a load starts with. A reload replays the
   same fight.
2. **Nobody stops when the FC dies.** Members keep shooting and the fleet keeps moving. Command (new calls and orders)
   waits for a handover: short with a good successor, long when the best remaining FC is poor ("the fleet hesitates").
3. In scope: target calling, succession + handover, FC ability, per-pilot reactions, movement stances, prop mod use,
   open-fire rules, free fire.
4. **Per-pilot reactions**, deterministic seeded draws for now; an authored `pilot.reaction` overrides.

## Design

### Levers: the brain makes the tool calls a model makes

The brain's only outputs are `order_fleet` (`targets`, `free-fire`, `keep-at-range` / `direction` / ...) and
`switch_prop_mods { ships, active }`, run through the same synchronous Director methods the tools use
(`OrderFleetNow`, `SwitchPropMods`), with the acting FC as `by`. Each executed call (exact args + why) goes to the
fleet's decisions log. **A model pulling a lever on a personality fleet takes that lever manual**: `targets`,
`free-fire`, `cease_fire` and `engage` the targeting lever; fleet moves, warps and `order_ship` on the FC the movement
lever; `switch_prop_mods` the prop mod lever. The brain stops pulling that lever until `set_fleet_personality` is
called again (get_state `fc.manual`). The brain never calls while its fleet is held by `cease_fire`.

### Live calls (S1)

`FleetCommanders` (page) owns a call book: group key → list (`[]` shadows the document's list). `toLiveFleetScene`
takes an overlay `{ commanders?, calls? }` and splices it, so FleetTargets, FleetFollowing, FleetOrders and get_state
read live calls with no change. A load clears the book. A patch drops a group's live call when the group is gone or
its document list changed beyond pruning, and prunes removed ship and object ids from live lists (with warnings).
order_fleet targets: resolve on the live view → `CallWarnings` → `toFleetTargetList` (the pure list transform pulled
out of `toFleetTargetOperations`, same refusals) → `SetCall` → `Respond` → `SyncFleetTargets()` (skipped for a brain
call at a boundary, so the listener's own `SyncFleetTargets(boundary)` starts the locks at the boundary) → `Fly` →
`CallResult` from the live view. The result loses `operations` and the patch fields.

### The FC dies, the fleet flies on (S2)

`world.Destroy` halts every ship whose anchor or frame is the dead FC (`destiny.ts` ~1068-1079), heir included, and
`following.Reconcile` leaves the heir without a follow. `Director.Destroy` captures, before `world.Destroy`, the
fleets the ship commands and `world.Motion(id)` (applied and pending order, `respondsIn`, velocity, speed). After
`Reconcile`, a pure node-tested helper decides what the heir **inherits**:
- `pending ?? applied` order, its `respondsIn` carried as the delay; `stop` inherits nothing;
- an order aimed at the heir, or one `OrderRefusal` refuses: `direction` along the dead FC's velocity at speed ÷ max
  velocity (only above `SETTLE_SPEED`);
- an aligning warp: `direction` toward its landing (the tackle-cancel precedent);
- only an heir that was in formation inherits; a detached heir or a group-apart leader keeps its own order.
Kills resolve inside the boundary listener and pending orders apply after it in the same `Tick`, so the heir never
shows a stopped tick. The successor comes from `toDefaultFleetSuccessor` (live.ts's rule extracted) for fleets with no
personality; in S7 the protocol's designate for personality fleets.

### Pilot traits (`ships[].pilot`)

`{ command?: 0..1, reaction?: 0..1 }`, higher is better for both. `command` is FC ability; a pilot with it is
FC-capable. `reaction` is how fast the pilot answers: an order without an explicit `delay` reaches it after
`round((1 − r) × 10 s × (0.5 + 0.5u))`. In a personality fleet, unset traits are seeded draws (`combatHash` with a
string key on the scene's `combat.seed`): the FC and `command.backups` backups (wing cmdrs, squad cmdrs, `boost`
squads' members, then seeded members) from `command.ability`, every member from `pilots.reaction`. Ships with neither
a personality fleet nor authored traits behave as today; an explicit `delay` keeps today's formula. **Reactions never
stagger fleet warps or regroups** (EVE's fleet warp is simultaneous), and moving on after a kill stays instant
(pre-locks). A string `pilot` and other keys stay reserved; `command` / `reaction` edits do not retune flight.

### The template: `cjs-fleet-personality/1`

```jsonc
{ "schema": "cjs-fleet-personality/1", "id": "brawler", "extends": "line", "name": "Brawler",
  "description": "Closes to its guns' optimal and focuses the nearest; MWDs while closing.",
  "command":   { "ability": [0.5, 0.8], "backups": 2, "succession": ["most-able", "chain", "anyone"], "handover": 20 },
  "pilots":    { "reaction": [0.6, 0.9] },
  "engage":    "in-range",                        // on-sight | in-range | when-attacked
  "targeting": { "priority": ["fc", "logi", "tackle", "ewar", "dps", "boost", "support"],
                 "prefer": "nearest",             // nearest|weakest|damaged|toughest|dangerous|commander|fastest|biggest|smallest
                 "reach": "falloff",              // lock | optimal | falloff | <metres>
                 "queue": 2, "switch": "on-kill", "freeFire": true },   // switch: on-kill | on-better
  "movement":  { "stance": "brawl", "range": "optimal", "propMods": "closing" } }  // brawl|kite|snipe|hold; never|closing|always
```

`ability` / `reaction` take a number or `[lo, hi]`; `handover` ≥ 2. `extends` merges over a built-in or embedded base
(loop-checked; the hub flattens saved chains when embedding); unset fields take `line`'s. Built-ins in
`packages/scene` as JSON (the `compositions/examples` pattern), each description saying when to pick it: `line`
(balanced default), `brawler`, `kiter`, `sniper`, `headhunter` (`fc` then commanders, switch on-better), `alpha`
(queue 0, fast reactions), `green` (ability 0.1-0.4, no backups, slow reactions, long handover), `veteran`
(0.85-1, 3 backups, fast), `defensive` (hold, fire when attacked).

### Command: FC delay, succession, handover

- **FC decision delay** per lever: `round((1 − a) × 10 s × (0.5 + 0.5u))` whole ticks. a = 1 decides at the same
  boundary.
- **Succession** (personality fleets): an FC is down once `combat.IsDestroyed`. The protocol picks the designate over
  live members: `most-able` (FC-capable, highest ability, ties fleet order) → `chain` (wing cmdrs, then squad cmdrs) →
  `anyone` (fleet order); non-capable successors have ability 0. Explode mode: the designate becomes the formation root
  at once and inherits the order (S2's path). Flag mode: the flagged FC flies on as root until the handover, then the
  overlay moves the root to the successor, who inherits its order. The designate **takes command** after
  `ceil(2 + (1 − a) × (handover − 2) × (0.5 + 0.5u))` s; a designate dying meanwhile re-runs the protocol. No candidate:
  `leaderless` (the default rule keeps a root; the brain idles; free fire, if on, goes on).
- **Hostiles**: live ships (not destroyed, warping or arriving) whose `team` is set and differs from the fleet's (its
  FC's, else its members' most common), within 250 km of the FC. No team: no hostiles, state `no-team`.

### The brain, each boundary (try/catch, between `SyncRecharged` and `SyncFleetTargets(boundary)`, director.ts ~926-938)

Per personality fleet, in document order:
1. **Gate**: `following.Ready(fleet)`, and every live member and candidate hostile has a hull-stats answer and a
   settled fit, none arriving or in warp; ships that never settle count after 20 ticks (noted); later reinforcements
   join the picture once settled without blocking it. `readyAt` recorded; every jitter hash is keyed `seed | fleet |
   lever | tick − readyAt`, so a reload replays the same decisions.
2. Handover due → the designate takes command.
3. **Picture** (plain, serializable, the future model view): members and hostiles with distance, HP fractions,
   remaining HP, paper DPS, role (`fc` for an enemy FC; no fleet → `dps`), signature, speed, their target; the live
   call; the FC's order; fleet reach medians lock / optimal / falloff (turrets optimal + falloff, missiles mean range).
   Document order; hostiles sorted by (metric, id); no module or live-map iteration.
4. **Engaged** flips on per `engage` (a hostile within lock reach / a candidate within targeting reach / a member shot
   by a hostile in the 20 s window) and stays on while a hostile is in awareness.
5. Desired, per lever not manual:
   - **call** (engaged): candidates within reach ranked by priority tier → `prefer` → nearest → id; keep the live
     primary unless dead, gone or out of reach, or (`on-better`) a higher tier is in reach; refill the queue.
   - **free fire**: `order_fleet free-fire on` once engaged when `freeFire`.
   - **move** (focus = primary, else the nearest hostile): brawl `keep-at-range` at range; kite `keep-at-range` beyond
     1.1 × range and `direction` away inside 0.9 × range (no orbit: rigid slots swing); snipe `keep-at-range`; hold
     none. Changed on a new type or target, or range moving > 10 %.
   - **prop mods**: closing = on beyond 1.25 × range, off inside 1.1 ×; always = on while engaged or closing; never.
6. A difference opens a **pending decision** due after the FC delay; at due it is recomputed and executed as tool
   calls. Decisions log capped at 20.

**Free fire** (any fleet, lever `order_fleet { order: { type: "free-fire", on } }` on a fleet, wing or squad): a member
whose chain has free fire on and no live primary (no own target, not stood down, not logi) picks the nearest hostile
within its own reach after its reaction delay, re-picks the same way, and takes the FC's call once there is one.
Precedence: own > called > free; `hold` keeps a free target unarmed, `stand-down` clears it.

## Surface

- **Document**: top-level `personalities?: { key: template }` (embedded customs, like `fits`; op `set_personalities {
  personalities: { key: template | null } }`, null refused while a fleet uses it); `fleets[].personality?: string` (a
  built-in name or a `personalities` key; `update_fleet set`); `ships[].pilot`. Compositions (`cjs-fleet/1`):
  `personality` (a name) and `pilot` on the commander and lines. Staging ship lines take `pilot`.
- **Hub tools**: `list_fleet_personalities`, `get_fleet_personality` (as written + resolved),
  `save_fleet_personality`, `delete_fleet_personality`, `set_fleet_personality { fleet, personality: name | inline |
  null, scene? }` (embeds saved/inline templates flattened, then `update_fleet`; re-arms manual levers). `personality` on
  `add_fleet_composition`, `stage_engagement` sides and `add_ships` `fleet: { new: true }`. Store `--personalities` /
  `SCENE_DIRECTOR_PERSONALITIES`, default `scene-director/personalities`; `viewer_status.personalitiesDirectory`.
- **Page tool change**: `order_fleet` gains `free-fire`; targets are live.
- **get_state**: per personality fleet `fc { personality, ship, ability, state: waiting | commanding | handover |
  leaderless | no-team, successor?, takesOverIn?, engaged, hostiles, reach, stance, manual[], pending: [{ lever, dueIn,
  why }], decisions: [{ tick, tool, args, why }] }`; per ship `pilot { command?, reaction, source }`; `target.source`
  gains `free`; `call.state` gains `free-fire`.
- **MCP**: an instructions line (pick a personality; the brain pulls your levers; taking one makes it manual;
  `fc.decisions`). A cheap model's whole fight: `stage_engagement { sides: [{ composition: "tfis", personality:
  "brawler" }, { ships: [{ hull: "Ferox", count: 10 }], personality: "sniper" }] }`.

## Slices (one commit each through `dbx-claude-commit`; each updates its refs)

**S1: live calls (scene + viewer).**
- `packages/scene/src/lib/fleets/targets.ts`: `toFleetTargetList(current, group, order, { own?, statusOf? })` out of
  `toFleetTargetOperations` (~498-521), which wraps it.
- `fleets/live.ts`: `toLiveFleetScene(scene, gone, overlay?)`; its early-out checks the overlay.
- `apps/viewer/src/lib/fleet-commanders.ts` (new, node-tested): call book (`SetCall`, `AfterEdit`, `Overlay`,
  `version`, `Clear`).
- `director.ts`: targets routed before the Serialize branch (~1030) to `CallTargets(request, { boundary? })`;
  `OrderFleetNow` (sync) for live orders; `CallResult` (~1096) on the live view; `LiveFleets` (~2992) memo keys on
  the version; `Apply` → `Clear` on restart, else `AfterEdit`. `following.ts` (~496): the layout memo key drops
  `targets` / `personality`.
- Specs: `targets.spec.ts`, `live.spec.ts`, `fleet-commanders.spec.ts`; `fleet-orders.spec.ts` Rig (~63-68, ~315)
  routes targets live and asserts the document untouched. verify-page "called" checks (~1920-1927) read get_state's
  live `targets`; a pruning check. Wording: `tools.ts` (~62, 518, 651-655), `scene.ts` (~341), `targets.ts` header,
  `fleet.ts` docs, `director.ts` (~482-486, 1013-1016); `server.spec.ts` phrases kept.

**S2: the FC dies, the fleet flies on (scene + viewer).** `toDefaultFleetSuccessor` (live.ts), the inheritance helper
(`fleet-commanders.ts` or its own node-tested file), `Director.Destroy` (~3044-3075) capture + inherit. Specs: a
DestinyWorld + FleetFollowing rig where the heir's speed never drops across the death tick, the fallback and warp
cases. verify-page: a moving-FC variant of "a dead squad lead and a dead FC fall back" (~1840).

**S3: personalities and pilots in the document (scene).** `packages/scene/src/lib/personalities/` (new):
`personality.ts` (types, enums, `FLEET_PERSONALITY_SCHEMA`), `normalize.ts` (`normalizeFleetPersonality`,
`resolveFleetPersonality` with `extends`), `examples.ts` + `examples/*.json`, `document.ts` (`personalities`,
`set_personalities`), `pilots.ts` (`normalizeShipPilot`); barrel + `src/index.ts`. `scene.ts`: `personalities`,
`SCENE_KEYS`, normalize before fleets (~299), `pilot` (~211-214, ~600-606), diff (~506) ignoring command / reaction.
`fleets/normalize.ts` `FLEET_KEYS` + name check (skipped without a name set: `add_ships` normalizes one fleet alone),
`fleets/fleet.ts`. Compositions (`composition.ts`, `normalize.ts`, `expand.ts`) and staging (`ships.ts`,
`engagement.ts`, `add-ships.ts`) carry `personality` / `pilot`. Specs: normalize / extends / every built-in valid and
described, ops and diff, `scene.spec.ts` (~154-191) pilot cases rewritten, composition and staging round trips.

**S4: templates on the hub.** `store/document-files.ts` (summary `ships` optional), `store/personality-files.ts`,
`hub/fleet-personalities.ts` (`FleetPersonalities.Call`, embedding through `ScenePlaces`), `hub.ts` / `main.ts`
wiring + `viewer_status`, `hub/fleet-compositions.ts` + `hub/staging.ts` resolve `personality`, `tools.ts` entries
and args, `mcp/server.ts` instructions. Specs: store, service, `hub.spec.ts`, `staging.spec.ts`, `server.spec.ts`.

**S5: the pure policy (scene).** `personalities/picture.ts`, `traits.ts` (seeded draws, backups), `succession.ts`
(`toFleetSuccessor`, `toHandoverTicks`, `toFcDelayTicks`), `targeting.ts` (`rankFleetTargets`, call decision,
free-fire picks), `movement.ts` (stances, prop mods), `brain.ts` (`stepFleetBrain({ picture, personality, memory,
tick, seed }) → { memory, actions }`). Specs on synthetic pictures: tiers, prefer, reach, switch rules, queue refill,
stances and hysteresis, engage rules, ability 1 vs 0 latency, handover by ability, determinism.

**S6: reactions and free fire (scene + viewer).** `toPilotDelays` takes `reactionOf?` (explicit `delay` wins; callers
`director.ts` ~1040, 1114, 1163 and `fleet-orders.ts` ~159 pass `request.delay` without `?? 0`; warps and regroups
never take reactions). `order_fleet` `free-fire` (`orders.ts`, live state in `FleetCommanders`); `fleet-targets.ts`
free picks (`SetFreePicks`, `Sync`, `Armed`, `Source`, `Report`, `Forget`, `Clear`); `SetTarget` null skips
free-firers. Specs + a verify-page check.

**S7: the brain runs.** `fleet-commanders.ts`: picture port, gate, traits, succession / handover (Destroy hands the
designate to the overlay; flag mode at the handover), `stepFleetBrain` execution through `OrderFleetNow` /
`SwitchPropMods`, manual levers. `director.ts`: the boundary step (try/catch), get_state `fc` / `pilot`. Specs:
`fleet-commanders.spec.ts` with a fake port (ability latency, handover timing, leaderless, designate dies, manual
takeover, cease_fire, determinism). verify-page `personality:` checks. New ref.

**S8: evidence.** Real-GPU fight on dbxpc (windows-chrome skill): brawler TFIs vs sniper Ferox; focus fire, an FC
kill and handover, fps; dated evidence in `sd-personalities`.

## Docs (same commits as the behavior)

New ref `.dbx-claude/refs/sd-personalities/REF.md` (format, library, pilots, command, brain loop, levers, manual
takeover, picture) with triggers in `.dbx-claude/dbx-claude.json` (words: personality, FC ability, succession,
handover, free fire; paths `lib/personalities/`, `fleet-commanders`; tools `*fleet_personalit*`); README "What works"
line, tools rows, Documentation row; CLAUDE.md ref index line. Updates: `sd-fleets` (targets doc: live calls,
free-fire; orders doc: reactions; REF: the fleet flies on; compositions doc), `sd-scene-document`, `sd-staging`,
`sd-combat` (live fleets; the call book and FleetCommanders on the snapshot list).

## Reuse

`toPilotDelays` / `unitHash` (`fleets/orders.ts`), `combatHash` (`combat/random.ts`), `toCalledTargets` /
`toFleetGroupCalls` / `toShipCallPlans` / `calledTargetsOf` / `fleetGroupShips` (`fleets/targets.ts`),
`toLiveFleetScene` / `applyFleetOperation` (`fleets/live.ts`), `toFleetMemberships`, `selectFleetShips`,
`FleetTargets.Respond` / `Armed` / `PreLocks`, `FleetOrders.Fly` / `Resolve`, `Director.SwitchPropMods`,
`Director.CallWarnings` / `CalledTargetStatus` / `LockTargeting`, the paper-DPS sum in `CombatState` (extracted),
`combat.Attackers`, `damage.Fractions` / `Report`, `modules.Spec(...).combat / .missile`, `world.SurfaceDistance` /
`Motion` / `OrderRefusal`, `DocumentFileStore`, `ScenePlaces.Before` / `Apply`, the `FLEET_COMPOSITION_EXAMPLES`
pattern, `sceneCombatOf(scene).seed`.

## Verification

- This Mac (no tools-core): `dbx-claude-test` for `scene`, `viewer`, `scene-director`; `dbx-claude-build`
  `scene-director`; `dbx-claude-lint-run`. All node specs run offline.
- dbxpc (tools-core + SDE): `npx nx run scene-director:verify-page -- --only "personality|called|fleet|FC"`; the
  combat, fleet and warp-in checks re-run unchanged.
- End to end over MCP: `stage_engagement` with two personalities at 20 km → `get_state` shows `fc.decisions` with
  `order_fleet` calls, members on calls, kills advancing; kill an FC → its fleet keeps moving, `fc.state: handover`
  with `takesOverIn` scaled by the successor's ability, then calls resume; a model's `order_fleet targets` makes the
  lever manual; the same seed twice gives identical decision ticks.
- Real GPU (S8): screenshots and fps.

## Follow-ups (not in this plan; filed with `dbx-claude-followup`)

A `fleet_picture` page tool for models; a manual handover lever (`order_fleet { type: "command", ship }`); an
advisor mode (brain proposes, model approves); logi auto-repair; tackle / ewar modules by role; disengage / warp-out
rules; per-squad split calls; designated backup lists.
