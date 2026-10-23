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
- **Not yet**: L3 (the page's `AutoRepair`, the `auto_repair` tool, get_state `autoRepair`, verify-page `logi:`
  checks), L4 (the real-GPU look). Until L3, remote repairers run only through `switch_modules`.

## Files

| File | Role |
|---|---|
| `packages/scene/src/lib/logi/auto-repair.ts` | `SceneAutoRepair`, `AUTO_REPAIR_POLICIES`, `REMOTE_REPAIRER_CATEGORIES`, `readSceneAutoRepair` (normalize), `resolveAutoRepair`, `autoRepairOf`, the command (`normalizeAutoRepairCommand`, `toAutoRepairOperations`) |
| `packages/scene/src/lib/logi/selection.ts` | `chooseRepairTargets`, `repairModuleHps`, `repairChoiceWhy`, the `REPAIR_*` constants |
| `packages/scene/src/lib/fleets/fleet.ts`, `normalize.ts` | the field on `SceneFleet` / `SceneWing` / `SceneSquad`, read by `readSceneAutoRepair` |

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
- L3's page controller runs `chooseRepairTargets` per fleet in the boundary listener, before the lock sweep.
- Missiles' damage feeds `takenWindow` through `CombatRules`, so pressure includes it with no change here.
