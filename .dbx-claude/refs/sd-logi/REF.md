# Logi auto-repair: the `autoRepair` field, repair-target selection, `auto_repair`

> A fleet's logi repair the members being shot, on their own: who repairs, who is repaired, how a logi picks and keeps
> its target, and the settings a fleet, wing or squad carries. Fetch before touching `packages/scene/src/lib/logi/`,
> the viewer's `auto-repair.ts`, `auto_repair`, or remote repairers' locks and retargets. Plan:
> `~/.claude/plans/logi-auto-repair-logi-squads-repair-fleet-members-under-fire.md` (slices L1–L4).

## Status

- **L1 in** (2026-10-23): the document field and its resolution, the selection math, the tool's pure half
  (`packages/scene`, node-tested).
- **L2 in** (2026-10-23): remote repairers wait for a lock on their target like weapons, retarget at a cycle start
  with the `retarget` switch option (the beam restarts on the new target), and every repair landing is tallied in
  `CombatRules` (get_state `combat.repairs`, scene `combat.repaired`). The accessors the controller needs are built
  (Seams). The lock gate, `LockAims` and the retarget: `sd-fittings` (Targeted modules); the tallies: `sd-combat`.
- **L3 in** (2026-10-23): the page's `AutoRepair` controller (`apps/viewer/src/lib/auto-repair.ts`, node-tested) runs
  every boundary, the `auto_repair` tool, get_state `autoRepair` per member and per fleet, `switch_modules` taking a
  logi over, and the four verify-page `logi:` checks (evidence below).
- **Not yet**: L4 (the real-GPU look: TFIs against 10 Ferox, beams, fps, GPU errors).

## Files

| File | Role |
|---|---|
| `packages/scene/src/lib/logi/auto-repair.ts` | `SceneAutoRepair`, `AUTO_REPAIR_POLICIES`, `REMOTE_REPAIRER_CATEGORIES`, `readSceneAutoRepair` (normalize), `resolveAutoRepair`, `autoRepairOf`, the command (`normalizeAutoRepairCommand`, `toAutoRepairOperations`) |
| `packages/scene/src/lib/logi/selection.ts` | `chooseRepairTargets`, `repairModuleHps`, `repairChoiceWhy`, the `REPAIR_*` constants |
| `packages/scene/src/lib/fleets/fleet.ts`, `normalize.ts` | the field on `SceneFleet` / `SceneWing` / `SceneSquad`, read by `readSceneAutoRepair` |
| `apps/viewer/src/lib/auto-repair.ts` | `AutoRepair` (the page controller, `AutoRepairPort`), `AutoRepairReport` / `AutoRepairFleetReport`, `AUTO_REPAIR_STATES`; node-tested (`auto-repair.spec.ts`, a fake port) |
| `apps/viewer/src/lib/director.ts` | the port, `SyncAutoRepair`, `AutoRepairCondition`, `SetAutoRepair` (the tool), the `SwitchModules` takeover, get_state |

`fleets/normalize.ts` imports the reader; nothing in `logi/` imports `normalize.ts` (the same cycle-safe shape as
`fleets/targets.ts`).

## Who repairs, who is repaired

- **A logi** is a fleet member (live view) whose resolved `autoRepair.on` is true and whose fit carries an online
  remote repairer (`REMOTE_REPAIRER_CATEGORIES`: remote armor repairers, shield transporters, remote hull repairers;
  groups 325, 2018, 41, 585), not taken over by a manual `switch_modules`, with a ball, alive, not in warp or arriving.
- **A candidate** is another member of the same fleet: alive (either death mode), with a ball, not in warp or arriving,
  tracked by the damage model. Never other fleets, free ships or objects. Logi never move to reach anyone (they keep
  their anchor, 30 km on the FC by default); members out of reach are reported.

## The document: `autoRepair`

`autoRepair?: { on?: boolean; policy?: "urgent" | "damaged" | "shot-at" }` on a fleet, a wing and a squad.

- `{}` and `null` are omitted. A non-object, a non-boolean `on` or an unknown policy is a problem; unknown keys warn and
  are dropped.
- **Resolution, key by key** (`resolveAutoRepair` → `{ on, policy, source, policySource }`): the nearest group in the
  ship's chain that sets the key: its squad, its wing (its squad's, or the one it commands), its fleet; else the
  default: `on` = its squad's role is `logi` (false outside squads), `policy` = `urgent`. The FC follows the same chain
  (auto-repair is not a fleet command). A squad `{ policy }` still inherits `on`; a fleet `{ on: false }` turns off
  every squad but one that says `{ on: true }`.
- Edited by `update_fleet` / `update_wing` / `update_squad` `set { autoRepair }` (replaced whole; `null` clears) and
  carried by `add_*` objects. `diffScenes` flags `fleets`, never `regrouped` (memberships ignore it). Kills and removals
  never touch it. Not in `cjs-fleet/1` compositions or `add_ships` squads.

## The command (`auto_repair`, page tool in L3)

`{ fleet, wing? | squad?, on?: boolean | null, policy?: policy | null }`. `normalizeAutoRepairCommand` refuses `ships`
("auto-repair is set per fleet, wing or squad; a ship repairs its fleet as its squad does"), nothing to set, bad values,
wing with squad and unknown keys. `toAutoRepairOperations` merges into the group's field (a value sets its key, `null`
deletes it, an emptied field becomes `autoRepair: null`) and returns one `update_*` op, or none when nothing changes; an
unknown group is a `SceneError`. A timeline cues the command or the op.

## The page half (`AutoRepair`, L3)

- **Where it runs.** `Director`'s boundary listener: `SyncFleetTargets(boundary)` → `SyncAutoRepair(boundary)` →
  `LockEvents(locks.Boundary(boundary, WantedLocks()))`. A rep it switches on joins `LockAims` at the same boundary,
  so its lock starts there and the gate starts the rep the boundary its lock completes. `Apply` calls it after
  `SyncFleetTargets()` (new settings decide at once; switches apply at the next boundary); a restart `Clear`s it,
  removals and `Destroy` `Forget` the ship.
- **The port.** `Scene` (the live fleet view), `Condition` (`ready`, `destroyed` (either death mode), `in-warp` (warp or
  arriving), `waiting` (no ball, or the fit has no dogma yet)), `Health` (`DamageModel.Health`), `Taken`
  (`TakenSince(…, REPAIR_PRESSURE_SECONDS)`), `HostileLocks` (`Lockers` outside the fleet and not on the member's
  team), `SurfaceDistance`, `Targeting` (`LockTargeting`), `Locks`, `RemoteRepairers`, `IncomingReps`
  (`modules.Incoming`: amount × effectiveness / cycle, keyed `from` + module key), `Switch` (`modules.Switch` at
  `world.tick`).
- **A pass** (`Sync`): settings resolve; a ship whose resolved settings changed loses its manual mark; ships that left
  every fleet are let go (owned reps switched online). Per fleet in order: the logi, the candidates (`otherReps` =
  incoming reps it does not own), `chooseRepairTargets`, then each choice: reaching modules
  `Switch(active, target, { retarget: true })` unless already engaged on it (a refusal goes to `note`), its idle
  modules and a layer with no target switch `online` (owned ones only). It returns whether it switched anything
  (`onChange`).
- **Owned modules only.** The controller touches only modules it switched on (`owned`, with the target it asked).
  Turning off stops them at their cycle end (the last cycle lands); reps it never owned are left alone.
- **Manual takeover.** `SwitchModules` on a ship whose selected modules include a remote repairer and `IsAuto(id)`
  (resolved on, fits one, not already manual) calls `Manual(id)` (let go, no switch) and adds a result `notes` line.
  `SetAutoRepair` always `Rearm`s the group's ships (their engaged reps are adopted as owned, their targets as the
  incumbents); a resolved-settings change does the same; a load clears it.
- **Pre-locks.** `PreLocks()` (≤ `REPAIR_PRE_LOCKS` per logi) join `WantedLocks` after `LockAims`, the ship's target and
  the lever's pre-locks, only while the ship's set is under `maxLocks` (a logi with no target gets a set of its own).

## get_state and the tool

- **Per member** (`autoRepair`, for a member with remote repairers or with auto-repair on): `{ state, on, policy,
  source, policySource, target?, reason?, why, since? (s on the target), layer?, modules? ([{ module, state }]), hps?,
  preLocks?, unreachable?, note?, layers? }`. `state` is the first that applies: `destroyed`, `in-warp`, `waiting`,
  `no-repairers`, `off`, `manual`, `repairing` (a module on the target is active or stopping), `locking` (they wait on
  the lock or the next cycle start), `out-of-range`, `idle`. The flat fields are its main layer (the most nominal
  HP/s); another layer goes in `layers`. `combat.repairs` (L2) beside it.
- **Per fleet** (`fleets[].autoRepair`, omitted without remote repairers): `{ logi, repairing, locking, idle,
  outOfRange, manual, off, targets: [{ target, logi, hps }] }`; `targets` counts repairing and locking logi.
- **`auto_repair`** (`SetAutoRepair`, through `Serialize`; hub `SLOW_TOOLS`): normalize → `selectFleetShips` (problems
  throw) → `toAutoRepairOperations` → `Apply` when there are ops → `Rearm` → `SyncAutoRepair`. Returns `{ fleet, wing?,
  squad?, autoRepair (the group's field after, or null), ships: [{ id, on, policy, source, state, target?, reason? }],
  operations, …the patch result (builds) }`.

## Verify-page evidence (L3, 2026-10-23, SDE 3632936, headless)

`--only "logi:"`, each check its own scene, death flag; a Guardian (`LOGI_AUTO_FIT`: two Large Remote Armor Repairer
II) 30 km behind its FC Punisher, default-fit red Rifters 3 km off the Punishers:

- **Lock and landing**: engaged at tick 6; the pre-lock at 9, first damage at 10, both reps active at 14 (the 4.486 s
  lock), first landing at 19 (nominal 512, one row restoring 179.3 HP); `idle → locking → repairing`, reason
  `under-fire`, effectiveness 1 at 30 km, two `defense.incoming` rows.
- **Hold vs. no reps**: the unrepped Punisher (its fleet's squad `{ on: false }`) dies 27 s in (1633 HP taken); the
  repped one holds at armor 388/625 (1493 taken, 809 repaired); the off logi reports `off` with its reps online.
- **Split**: two Guardians on two shot Punishers take one each (`fleets[0].autoRepair.targets` two rows of one logi,
  170.7 HP/s each).
- **The tool**: `on: false` writes `{ on: false }` (one `update_squad`), the reps stop by their cycle end and
  `incoming` empties; `{ on: null, policy: "damaged" }` repairs again (`policySource: squad`); a manual
  `switch_modules … online` holds `manual` for 10 s under fire; `on: true` hands it back; `ships`, a bad policy,
  nothing to set and an unknown fleet are refused.

The 502s from tools-core's resource proxy (hull materials) during these runs only stop hulls drawing; balls, fits and
combat run.

## The selection (`chooseRepairTargets`, one pass per fleet)

Input: the fleet's candidates (`layers` HP / max, `taken` over the window, `hostileLocks`, `otherReps` HP/s the pass
does not assign) and its logi in fleet order (`policy`, remote repairers `{ key, layer, amount, cycleTime (s), range,
falloff }`, `lockRange` (Infinity without targeting numbers), surface `distances`, `current` target per layer, held
`locks`). Output per logi: one `RepairChoice` per layer it carries (in `DEFENSE_LAYERS` order) and `preLocks`.

| Constant | Value | |
|---|---|---|
| `REPAIR_PRESSURE_SECONDS` | 10 | "under fire" = HP lost to shots over it; pressure = that / 10 (HP/s) |
| `REPAIR_COVER_MARGIN` | 1.25 | reps worth 125 % of pressure cover a member |
| `REPAIR_SWITCH_RATIO` | 2 | same tier: leave the incumbent only for one strictly more and ≥ 2× as urgent |
| `REPAIR_TOP_OFF_FRACTION` | 0.95 | a calm member below 95 % on the logi's layer is topped off; the incumbent to full |
| `REPAIR_FULL_HP` | 1 | within 1 HP of max is full |
| `REPAIR_SELECTION_FALLOFFS` | 1 | a new target within optimal + 1 falloff (50 %) of one rep; the incumbent up to + 2 falloffs |
| `REPAIR_PRE_LOCKS` | 2 | pre-locks per logi |
| `REPAIR_UNREACHABLE_ROWS` | 3 | `unreachable` rows |

- **Repairers**: a logi's reps of one layer choose together; layers run in `DEFENSE_LAYERS` order, logi in fleet order,
  and each sees the reps the logi before it assigned (one `reps` map, shared across layers: HP/s is HP/s).
- **Reach**: always within lock range. A new pick within `max(range + 1 × falloff)`; the incumbent within
  `max(moduleReach)`. `modules` = the keys whose own `moduleReach` covers the distance, `idle` the rest; `hps` = Σ
  `amount × falloffEffectiveness / cycleTime`.
- **Tiers**: 1 `under-fire` (taken > 0 and pressure × 1.25 − reps > 0), 2 `covering` (under fire, covered), 3
  `topping-off` (calm, layer < 95 %; the incumbent: not full). Else it needs nothing.
- **Score**: tier 3 `1 − layerFraction`; tiers 1–2 `urgent` need (tier 1) or pressure (tier 2) over `max(1, hpLeft)`
  (the inverse time to live), `damaged` `1 − fraction`, `shot-at` pressure. Ties: pressure, lower fraction, id.
- **Choice**: the best (lowest tier, highest score); the eligible incumbent is kept unless the best has a lower tier, or
  the same tier and a score > and ≥ 2× its own. A target adds its `hps` to `reps`. None: `out-of-range` with the top 3
  members needing reps beyond reach, else `idle`.
- **Pre-locks**: members not its targets, within lock range, under fire or yellow-boxed (`hostileLocks > 0`): held locks
  first, under fire before yellow only, pressure, hostile locks, id; at most 2.
- **Determinism**: candidates are sorted by id first; the same inputs give the same plans.
- `repairChoiceWhy(choice, policy)`: `"b1" is under fire: 103.3 HP/s against 0.0 HP/s of reps, about 16 s to live`
  (`damaged` adds `, 100 % of its HP left`; `shot-at` stops after the reps; net ≤ 0 says `short of 125 % cover`),
  `"b1" is under fire and covered (341.3 of 103.3 HP/s); no member needs it more`, `"b1" is calm with armor at 50 %`,
  `no fleet member in reach needs reps`, `"b1" is under fire 80.0 km off; its reps reach 74.4 km`; a kept target adds
  ` (kept: it still needs reps)`.

Worked numbers (SDE 3632936, max skills; `selection.spec.ts`): a Guardian's Large Remote Armor Repairer II is 512 HP per
6 s, 57.6 km + 16.8 km (two: 170.67 HP/s in optimal, half at 74.4 km); the Guardian locks to 81.25 km. A default-fit
Rifter puts ~103 HP/s into a bare Punisher (438 / 625 / 563 HP). Two Guardians on two such Punishers split one each
(170.7 ≥ 1.25 × 103.3); one Punisher under 400 HP/s gets both.

## Seams

- L2 (built): the lock gate for remote repairers (`IsLockGated`), the `retarget` switch option (the module takes the
  new target at its next cycle start once locked, so the old cycle lands on the old target; a stopping one resumes;
  without it the manual refusal stands) and the beam restart (`retargeted` cycle → `start`), plus
  `CombatRules.RecordRepair` / `TakenSince`, `DamageModel.Health`, `ShipLocks.Lockers` (locking or locked),
  `ShipModules.RemoteRepairers` (`{ key, spec, state, target, retarget? }`). `SwitchModules` asks for the lock on a
  switched remote repairer's target; L3's controller passes `retarget: true` and lets the boundary's lock sweep
  (`LockAims`) start its locks. verify-page "remote reps take a target…" pins the lock (1.937 s Guardian → TFI) and the
  first landing (6 ticks after activation, nominal 512, amount 0 on full armor).
- L3 (built): the page controller runs `chooseRepairTargets` per fleet in the boundary listener, before the lock sweep
  (The page half).
- The automatic camera can read `FleetReport().targets` (whom the logi hold up); the timeline cues `auto_repair`'s
  command or its `update_*` op.
- Missiles' damage feeds `takenWindow` through `CombatRules`, so pressure includes it with no change here.
