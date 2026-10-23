# Combat: locks, turret hits, damage, kills, explosions

> Fetch before touching `packages/scene/src/lib/combat/`, anything that locks, rolls a shot, applies damage or kills a
> ship, the document's `combat`, or the `engage` / `cease_fire` tools. Turrets, targets and the shot hook this builds
> on: `sd-weapons`; dogma, activation (`ModuleCycle`) and the page's damage model: `sd-fittings`; the parks:
> `sd-destiny`.

**Status (2026-10-23)**: the combat-rules plan
(`~/.claude/plans/combat-rules-locks-turret-hits-through-getaccuracy-damage-into-the-fit-s-damage.md`) lands in three
slices. **K1 is in**: the runtime-free rules in `packages/scene` (below), the document's `combat` and `set_combat`, and
`ship_stats`' turret numbers. **K2 is in**: the page runs them: `ShipLocks`, the lock gate on
turrets, `CombatRules` rolling each shot through Destiny's `GetAccuracy`, damage into `DamageModel`, passive shield
recharge, `engage` / `cease_fire`, get_state's locks and combat reports. **K3 is in**: deaths explode (the client's
explosion, drawn on a renderer and scheduled headless), the ball leaves both parks after the linger, the fleets fall
back through the live view, a load revives everyone (verify-page 6–8 green), and the real-GPU fight calibrated and
pinned `referenceRadius` (below, Real-GPU evidence). The plan is **delivered**.

## Files (K1)

| File | Holds |
|---|---|
| `combat/accuracy.ts` | `turretHitChance` (Destiny's guards), `NO_FALLOFF_METRES` (1), `rollShot`, `HIT_RESULTS` / `hitResultOf`, `ShotResult`, `WRECKING_ROLL` (0.01), `WRECKING_QUALITY` (3), `QUALITY_OFFSET` (0.49), `vortonApplication` |
| `combat/damage.ts` | `DamageVector`, `NO_DAMAGE`, `shotDamage`, `damageTotal`, `applyLayeredDamage` (pure), `passiveRecharge` (the closed form) |
| `combat/locks.ts` | `lockTime`, `LOCK_TIME_CONSTANT` (40000), `pilotLockLimit`, `shipLockLimit`, the two Target Management skills |
| `combat/random.ts` | `combatRoll(seed, key)`, `combatHash` (cyrb53), `combatPick`, `combatShuffle`, `CombatRollKey` |
| `combat/weapon-numbers.ts` | `TurretCombatNumbers`, `turretCombatNumbersOf(ship, bundle, key)`, `ShipWeapons`, `shipWeaponsOf`, `TURRET_COMBAT_ATTRIBUTES`, `NO_CHARGE_DAMAGE_NOTE` |
| `combat/explosions.ts` | `SHIP_EXPLOSIONS`, `SHIP_EXPLOSION_TIMINGS` (captured), `explosionDurationBound`, `shipExplosionOf`, `MAX_LOCAL_BLASTS` (8), `EXPLOSION_REFERENCE_RADII`, `TITAN_EXPLOSION_REFERENCE_RADIUS` |
| `combat/document.ts` | `SceneCombat`, `COMBAT_DEATH_MODES`, `DEFAULT_COMBAT_SEED` (1), `DEFAULT_COMBAT_DEATH` (`explode`), `normalizeSceneCombat`, `sceneCombatOf`, `COMBAT_OPERATIONS` / `applyCombatOperation` (`set_combat`) |
| `combat/commands.ts` | `normalizeEngageCommand` (`{ selection, target, modules = ["turret"] }`, a celestial refused), `normalizeCeaseFireCommand` (`{ selection, unlock }`) |
| `combat/kill.ts` | `ShotOutcome`, `ShipKill`, `ShipKillReport`: the plain data the page will report and the timeline, time control and automatic camera read |
| `hub/ship-stats-tool.ts` | turret rows' `damage` / `volley` / `dps` / `tracking` / `signatureResolution` / `explosion` / `spool`, and `weapons` on the stats |

## EVE's rules (checked 2026-10-23)

Sources: EVE's developer docs "useful formulae", EVE University "Lock time", "Turret mechanics", "Missile mechanics",
the Entropic Disintegrator and Vorton Projector pages; Destiny's `GetAccuracy`
(`../carbonenginejs/server/destiny/CjsBallparkController.js`).

### Locks

- **Lock time** = `40000 / (scanResolution(mm) × asinh(signatureRadius(m))²)` s: the shooter's live scan resolution
  (564, Signature Analysis V) and the target's live signature (552 with an MWD's bloom, painters). Max skills: Rifter →
  Punisher 2.617 s, Punisher → Rifter 2.770, Ferox → Rifter 9.09, Megathron → Rifter 14.30, Rifter → Megathron 1.10.
- **Range**: `maxTargetRange` (76, Long Range Targeting V), surface to surface: Rifter 28,125 m, Punisher 31,250,
  Ferox 93,750, Megathron 108,750.
- **Count**: `min(maxLockedTargets (192), the pilot's 2 + Target Management + Advanced Target Management levels)`: 12
  for the max-skills pilot; Rifter 4, Ferox 8, Megathron 7.
- Entering warp breaks every lock both ways.

### Hit chance and the damage roll

- Chance = `0.5 ^ ((ω × sigRes / (tracking × S))² + (max(0, d − optimal) / falloff)²)`: ω the angular velocity
  (transversal ÷ centre distance, rad/s), sigRes the turret's `optimalSigRadius` (620: 40,000 on every turret), S the
  target's signature, d the surface distance. Destiny's `GetAccuracy(src, dst, optimal, falloff, tracking, signature,
  optimalSigRadius)` computes exactly this from `mNewPos` / `mNewVel` (numeric arguments return `[accuracy,
  surfaceDistance, angularVelocity]`), and answers 0 for falloff 0, tracking 0, signature 0, optimal < 0, or the same
  ball. The page (K2) uses it on the master park; `turretHitChance` is the spec'd twin.
- Worked (Rifter's 200mm AutoCannon II: tracking 393.75, optimal 750, falloff 9,675, on a Punisher, sig 37): 0.875 at
  rest 5 km off; 0.0625 at optimal + 2 × falloff; 1 within optimal at rest; ≈ 0.48 orbiting at ~1 km at 400 m/s.
- **The roll**: one uniform r in [0, 1) per shot; a hit when r < chance; r < 0.01 wrecks at 3 × base; otherwise quality
  r + 0.49 (0.50 to 1.49). Tiers (the client's combat log): grazes 0.5–0.625, glances off –0.75, hits –1.0, penetrates
  –1.25, smashes –1.49, wrecks 3.0. `ShotResult` adds `misses` and `overkill` (the target was already dead).
- **Entropic disintegrators** (`targetDisintegratorAttack`, no falloff attribute on the effect): no falloff, so Destiny
  gets `NO_FALLOFF_METRES` (attribute 158's 1 m default; never 0) and their chance is ~0 past optimal (their reach).
  They spool by `damageMultiplierBonusPerCycle` (2733: 0.07) per consecutive cycle, up to `damageMultiplierBonusMax`
  (2734: 2.125); the spool resets on a stop or a new target.
- **Vorton projectors** (`ChainLightning`: no tracking, no falloff) apply like missiles: base × `min(1, S / E, (S / E ×
  Ve / Vt) ^ drf)`, E `aoeCloudSize` (654), Ve `aoeVelocity` (653), drf 1353, Vt the target's speed; no roll, no
  wrecking, reach = optimal. Arcs: the existing L2 follow-up.

### Damage per shot

- Per type (EM 114, thermal 118, kinetic 117, explosive 116 on the charge): `damageMultiplier (64, the module,
  evaluated) × the charge's damage × quality × (1 + spool)`. No charge, no damage (`NO_CHARGE_DAMAGE_NOTE`); default
  fits always load one, and a fit's empty guns take one from cargo (`loadCargoCharges`, the hub's `ship_stats` too).
- `turretCombatNumbersOf` reads the module's default effect's attribute ids (duration, range, `falloffAttributeID`,
  `trackingSpeedAttributeID`), never attribute 158 blindly. Kind: `vorton` when the effect has no tracking attribute
  and the module carries 654; `disintegrator` when the module carries 2733; else `tracking`.
- Fixture check (`weapon-numbers.spec.ts`, max skills, `dogma-3632936.json`):

  | Default fit | Per gun per shot | Cycle | Paper DPS | Tracking | Optimal + falloff | Sig | Scan res | HP (sh / ar / st) |
  |---|---|---|---|---|---|---|---|---|
  | Rifter, 3 × 200mm AutoCannon II, EMP S | 65.75 (EM 49.31, kin 5.48, exp 10.96) | 1.6875 s | 116.9 | 393.75 | 750 + 9,675 | 35 | 825 | 562.5 / 562.5 / 437.5 |
  | Punisher, 4 × Small Focused Pulse Laser II, Multifrequency S | 68.31 | 2.52 s | 108.4 | 307.81 | 3,938 + 3,125 | 37 | 800 | 437.5 / 625 / 562.5 |
  | Ferox, 6 × 250mm Railgun II, Antimatter Charge M | 197.81 | 4.194 s | 283.0 | 7.38 | 30,375 + 16,875 | 325 | 243.75 | 6,562.5 / 4,375 / 5,000 |
  | Megathron, 7 × Neutron Blaster Cannon II, Antimatter Charge L | 334.72 | 4.2525 s | 551.0 | 8.93 | 4,500 + 12,500 | 380 | 155 | 8,662.5 / 8,937.5 / 10,312.5 |
  | Vedmak, 1 × Heavy Entropic Disintegrator II, Baryon Exotic Plasma M | 588.23 (spool 0) | 3.96 s | 148.5 | 52.5 | 32,897 + none | 110 | 375 | 1,000 / 4,125 / 2,500 |
  | Stormbringer, 1 × Medium Vorton Projector II, ElectroPunch Ultra M | 1,481.95 | 8.1 s | 183.0 | none | 33,000 + none (explosion 107.25 m, 118.1 m/s, drf 0.5) | 130 | 341.25 | 5,000 / 750 / 1,500 |

### Applying damage and passive shield recharge

- **Layers** (`applyLayeredDamage`, pure): shield, then armor, then structure. A layer takes `Σ raw_t × resonance_t`;
  when that exceeds its HP it absorbs the share `hp / effective` of the raw damage and goes to 0, and the rest of the
  raw damage (`× (1 − share)`) moves to the next layer at its resonances. Structure at 0 is death.
- **Shields recharge** on the capacitor's curve, `dS/dt = 10 × Smax / τ × (√s − s)` (τ `shieldRechargeRate`, 479; peak
  at 25 %, 2.5 × Smax / τ): `passiveRecharge` is the closed form `(1 + (√s₀ − 1) e^(−5t/τ))²` (a Rifter's τ 468.75 s:
  3 HP/s at its peak). Armor and structure do not regenerate. The viewer's `CapacitorFractionAfter` is the same formula;
  K2 makes it call `passiveRecharge` so there is one.

## Files (K2, the page; node-tested but the director)

| File | Holds |
|---|---|
| `viewer/locks.ts` | `ShipLocks` over `ShipLocksPort` (`SurfaceDistance`, `InWarp`, `IsTargetable`, `Targeting`, `SignatureOf`, `tickSeconds`): `Request`, `Keep` / `Release`, `Boundary(tick, wanted)`, `IsLocked`, `Hold`, `Of` / `On`, `Remove`, `OnWarpEnter`, `Clear`, `Report` |
| `viewer/combat.ts` | `CombatRules` over `CombatPort` (`Accuracy`, `Speed`, `Weapon`, `SignatureOf`, `KindOf`): `SetCombat`, `Recharge`, `Resolve`, `IsDestroyed`, `KillOf`, `Kills`, `Totals`, `Report`, `Attackers`, `Remove`, `Clear`; `DPS_WINDOW_SECONDS` (20), `COMBAT_ROWS` (3) |
| `viewer/module-cycle.ts` | the gate `Boundary(boundary, { hold })` and `activations` (every event carries `activation`) |
| `viewer/modules.ts` | port `LockHold?`, the lost-lock stop, the lock-gated retarget, `Remove(id, boundary, why)`, `Spec`, `TurretAims`, `TurretKeys`; specs carry `combat` (`ShipModuleSpecsOf`) |
| `viewer/damage.ts` | `ApplyHit`, `Recharge`, `Destroyed` (`capacitor.ts`' `CapacitorFractionAfter` is `passiveRecharge` too: one formula) |
| `viewer/destiny.ts` | `Accuracy(source, target, numbers)`: the master park's `GetAccuracy` (`destiny-accuracy.spec.ts`) |
| `viewer/director.ts` | the wiring below, `Engage` / `CeaseFire`, `OnKill`, get_state |

## Files (K3)

| File | Holds |
|---|---|
| `fleets/live.ts` (scene) | `toLiveFleetScene(scene, gone)` → `{ scene, changes, warnings }`: `LiveFleetView`, `LiveFleetChange` (`actingFor`, `destroyed`, `dropped`); spec'd |
| `viewer/destiny.ts` | `Destroy(id)` / `IsDestroyed(id)`, the `destroyed` refusals, prop mod cause `destroyed` (`destiny-destroy.spec.ts`) |
| `viewer/explosion-plan.ts` | `ExplosionFileFacts`, `ExplosionFiles`, `ExplosionSchedule` / `ExplosionTimes`, `ExplosionRemoveTick`, `EXPLOSION_LINGER_MARGIN_SECONDS` (2); node-tested |
| `viewer/explosions.ts` | `ShipExplosions` (runtime, renderer only): `Start`, `Frame`, `Report`, `Remove`, `Clear`, `Roots`, `Errors` |
| `viewer/director.ts` | `Destroy`, `Hide`, `RemoveDead` (the linger), `Revive`, `LiveFleets`, `DriveExplosions`, `ExplosionStarts`, `PostExplosionSound`, `IsDead` skips |

## Death (`combat.death`)

- **`flag`**: the kill is recorded (`Killed`: targets on it clear, `OnKill` runs) and the ship flies on at 0 structure,
  taking no more damage until a load.
- **`explode`** (the default): `Killed` calls `Director.Destroy(kill)` before the `OnKill` listeners, at the boundary:
  - `ModuleOutputs(modules.Remove(id, tick, 'its target was destroyed'))`: its modules stop, and every module on it;
    `locks.Remove(id)` (both ways), its engagement and its own target end;
  - `world.Destroy(id)`: its ball stops for good, its prop mod goes off, its followers and the ships ordered or queued
    at it stop (`stopped: target "x" was destroyed`); orders, follows and prop mods on it are refused from then on;
  - the live fleet view drops it and `following.Reconcile()` re-points the fleet;
  - its explosion is chosen (`shipExplosionOf`: group and race from the fit bundle's hull record, size from
    `RigSizeOf`, the seed) and its file loaded; `removeTick = ExplosionRemoveTick(kill.tick, lingerSeconds, tick)`.
  - The killing shot draws as usual: `DriveTurrets` starts the explosion clock at its burst's start (draw + the set's
    firing delay), or at the draw when the shot is dropped; a killing shot that never draws starts it two ticks after
    the kill.
  - **Hide** (`Hide(id)`): at the explosion's wreck switch the hull's drawing retires (turrets off,
    `engine.RemoveShip`, `RetireShips` with every retained set), the live entry stays with `status: 'destroyed'`, no
    hull; `shots.Forget(id)` runs then. Shots at it drawn before still draw.
  - **Linger** (`RemoveDead`, first in the `OnBoundary` listener): at the first boundary at or after `removeTick` the
    ball leaves both parks (`world.RemoveShip`), its emitter is released, its damage model and capacitor dropped, and
    a cinema shot on it released (`its subject was destroyed`). The same with or without a renderer.
  - **Skipped while dead** (`IsDead`): `Apply`'s builds, ball, retune and prop mod loops (a patch keeps the dead dead;
    `remove_ship` removes it and its explosion), `Retune`, `SetFlight`, `SyncModules` (no specs, so no re-fly re-adds
    modules), `WantedLocks`, framing (`ApplyCamera`), `Build` (a hull finishing after the hide is not drawn),
    `switch_modules` / `switch_prop_mods` / `set_target` / `engage` selections (`it was destroyed`), `order_ship`
    (`ship "x" was destroyed`). Fleet selections and `order_fleet` read the live view, so the dead are not members.
  - **Revive** (`Revive`, a load): explosions removed, balls taken off (Apply adds them back fresh), live entries
    retired so they rebuild as retried ships, deaths cleared.

## The live fleets (`toLiveFleetScene`)

The document with the destroyed taken out of their fleets by the same fleet ops a removal runs: a dead FC first hands
the fleet (`update_fleet`) to the first live wing commander in wing order, else the first live squad commander, else
the first live member; then `removeShipFromFleets` per dead ship, so squads anchored on it fall back down the chain
with remove_ship's warnings; a fleet with nobody alive is dropped. Never written. `Director.LiveFleets()` memoizes it by
(document, destroyed set) and feeds `FleetFollowing`, `FleetOrders`, get_state's memberships and fleets (`actingFor`,
`destroyed`; a dropped fleet is not listed). An untouched scene is the same object.

## The explosion, drawn (`explosions.ts`)

- `ShipExplosions.Start(id, { ship, curves, choice, radius, at, seed })` queues it; `Frame(now)` (from
  `DriveExplosions`, after `DriveTurrets` in `main.ts`) plays it at `at` once the file loaded: the values are copied
  with every `AudEventCurve` and `observers` list taken out (`WithoutAudio`), hydrated inside `PageAudio.Detached`, the
  root put on the ball's curves at `scaling` 1, the child's own `scaling` multiplied by `max(1, boundingSphereRadius /
  referenceRadius)` (the files author their size there; `sd-runtime` → Explosions),
  `SetLocalExplosionTransforms` with a keyed subset (`combatShuffle(seed, "explosion|<ship>")`) of up to 8 `damage`
  locators (8 Fibonacci points on the bounding sphere without them), `SetGlobalExplosionOffset(boundingSphereCenter)`,
  `engine.AddObject(root)`, `Play()`.
- Then: `onHide` at `wreckSwitchTime` (or when it stops); one `onSound` per spawned local blast and one for the global
  container (diffing `generatedLocalExplosions` / `generatedGlobalExplosions`); the root comes off and is retired when
  it stops or `totalDuration` passed. A failed load or play hides the hull at once and is reported.
- **Without a renderer** `ExplosionSchedule` runs it: the first local event at the start, the first global one at start
  + `localExplosionDelay` + `globalExplosionDelay`, the hide at the global start + `wreckSwitchOffsetFromGlobalStart`.
- **Sounds** post through `PageAudio.Post` on the dying ship's emitter (released with the ball). The files' curves:
  `local` / `global` (generic: `ecx_generic_explosive_short_individual_01a_play`, `..._global_01a_play`); the
  Triglavian dreadnought's is `local_explosion_sfx` (`triglavian_structure_individual_explosion_play`) with no global
  sound. `ExplosionFileFacts` matches curve names by prefix.
- get_state `destroyed.explosion`: `{ state: waiting | playing | done | failed, file, scale?, localBlasts?,
  wreckSwitchTime?, totalDuration?, removesAt, gone }`.

## Locks and the gate (`locks.ts`)

- **Lifecycle** `waiting` → `locking` → `locked` on boundaries. A lock starts at the first boundary after its request,
  only while the target is within `maxTargetRange` (surface to surface); its lock time is fixed then (shooter's live
  scan resolution, target's live signature: `RunningFlight`'s, so an MWD bloom and painters count; an object's ball
  radius). It completes at the first boundary at or after start + lock time. Out of range it waits (note `out of
  targeting range: 40.2 km, it locks at 28.1 km`); a locking or locked lock whose target leaves range is `lost` back
  to waiting and locks again once back. A removed or destroyed target, either ship entering warp, or a load clears it.
- **The sweep** (`Boundary`'s `wanted`, built by `Director.WantedLocks`): a ship keeps its target's lock, its turrets'
  targets (running, stopping, held, and a pending retarget) and its `Keep`s, locks any wanted target it has room for,
  and releases the rest. So a `set_target` to a new ship keeps the old lock while the guns still fire at it.
- **Limit**: `maxLocks = shipLockLimit(targeting, MAX_SKILLS_PILOT)` (Rifter 4, the pilot 12). `Request` at the limit
  frees a lock outside the ship's wanted set, else refuses (`it holds 4 locks, its most`).
- **No targeting numbers** (the table path, no EVE dogma for the hull): `Request` refuses (`it cannot lock: no EVE dogma
  for its hull`) and `Hold` is null, so its turrets fire unlocked as before (and do no damage: no combat numbers).
- **The gate** (`ModuleCycle.Boundary(boundary, { hold })`, through `ShipModulesPort.LockHold` = `ShipLocks.Hold`):
  an activating turret with a hold stays `activating` with the hold as its note (`waiting for its lock on "x" (1.6
  s)`): EVE's pre-activation. A running turret whose lock is lost stops at its cycle end (`it lost its lock on "x"`).
  A pending retarget switches at the first cycle start once the new target is locked. Only turrets wait: remote reps,
  webs, scrams and EWAR run without a lock.

## Combat rules in the page (`combat.ts`)

- `Resolve(shots, boundary)` sorts by (`at`, ship id, module key), then per shot: a target already destroyed
  (earlier in the boundary too) is `overkill` (no roll, no damage, drawn as a hit); an object (or a shooter without
  combat numbers) gets a range-only roll on `effectiveness` (0 past optimal without falloff) and no damage; a ship gets
  `port.Accuracy` (tracking / disintegrator kinds; falloff null → 1 m) or, for a vorton, `vortonApplication` within
  optimal (no roll), then `rollShot` on `combatRoll(seed, { ship, module, activation, cycle, target })`, a
  disintegrator's spool (`(n − 1) × perCycle` capped, n the consecutive cycles on this target in this activation),
  and `DamageModel.ApplyHit(target, shotDamage(damage, quality × (1 + spool)))`. A ship the model does not track
  takes nothing (`takes no damage: no EVE dogma for its hull`).
- Every shot gets `missed`, `outcome` (`ShotOutcome`); the killing one `fatal`. Structure at 0 → a `ShipKill` (`by`,
  `module`, `weapon`, `tick`, `at`, `mode`, contributors most first) and `onKill`; the ship is then destroyed for the
  rules: no more damage until a load, its kill not repeated. Repairs still land on it.
- Tallies: dealt / taken, a 20 s trailing DPS window, shots / hits / misses, the 3 latest rows fired (`lastHits`) and
  taken (`lastTaken`), contributors, `Attackers` (who shot it in the window). Scene totals: shots, hits.
- **Director wiring**: one `OnBoundary` listener, in order: `RemoveDead(boundary)`, `combat.Recharge(tick s)` (impact
  overlays re-armed when the shield moved > 0.1 %), `SyncFleetTargets(boundary)` (the fleet targeting lever: members
  take their groups' next live called targets, locks asked at `boundary − 1`; `sd-fleets` doc `targets`),
  `locks.Boundary(boundary, WantedLocks())` (wanted: targets, turret aims, then called members' pre-locks under
  `maxLocks`), `Engagements(boundary)` (an engaged ship's matching turrets back `online` switch active again, then
  `fleetTargets.Armed()` members with `["turret"]`), `ModuleEvents(modules.Boundary(boundary))`. `Shots` resolves the
  boundary's shots before the `OnShot` listeners (the hook's contract is unchanged) and `SyncImpactState` follows the
  damage. A destroyed ship is no target: `ShipTargets` and `ShipModules` `HasShip` and the locks' `IsTargetable` are
  `world.Curves(id) != null && !combat.IsDestroyed(id)`. On a kill (`Killed`) every target on it clears
  (`ShipTargets.Forget`; their turrets stop at their cycle end), then `OnKill` listeners run. The flagged ship keeps
  its own target and guns. `SetCombat(sceneCombatOf(scene))` on every apply; a load clears locks, kills, tallies and
  engagements; a removal forgets the ship's.

## The keyed RNG and determinism

- `combatRoll(seed, { ship, module, activation, cycle, target })` = cyrb53 of `` `${seed}|${ship}|${module}|${activation}|${cycle}|${target}` ``
  over 2⁵³. `activation` counts the module's activations since the load (a second engagement does not replay the
  first's rolls), `cycle` the cycle within it.
- **Keyed, not a stream**: module events reach the page in `ShipModules` map order, which depends on when each ship's
  fit resolved; a keyed roll is the same whatever the order and however many unrelated ships exist. The time-control
  entry snapshots only the seed.
- The page (K2) applies a boundary's shots sorted by (`at`, ship id, module key), so which shot kills is deterministic;
  shield recharge runs once per boundary before the shots.
- Explosion variants and local-blast subsets are keyed `(seed, "explosion|<ship>")` (`combatPick`, `combatShuffle`).
- `random.spec.ts`: same key same roll, every field changes it, 100,000 keys mean 0.5 ± 0.005 and deciles 10 % ± 0.5 %.

## The document's `combat`

`{ "seed"?: <integer 0 … 2³² − 1>, "death"?: "explode" | "flag" }`, top level, omitted when empty; defaults seed 1,
death `explode` (`sceneCombatOf`). Unknown keys warn and are dropped; `null` is absent. `{ op: "set_combat", seed?,
death? }` merges, `null` resets a field. `diffScenes` flags `combat`. **Kills are live state** like HP, locks and
targets: the document stays the setup, `load_scene` / `open_scene` revive everyone, `remove_ship` keeps an aftermath.

## The client's death explosion (`shipExplosionOf`)

Files `res:/fisfx/explosion/ecx_*.black` (68 under the folder in the 3632936 res index, captured in
`explosions.spec.ts`): an `EveEffectRoot2` whose effect child is an `EveChildExplosion` (local blast variants, a
shared part, a `globalExplosion` container, timing values). The client picks one through its explosion buckets
(`explosionBucketID`), which the public SDE drops (follow-up); the table instead:

| Hull | File (`ecx_<name>.black`) |
|---|---|
| titan (group 30) | `titan_<amarr / caldari / gallente / minmatar / angel>_explosive_01a` by DNA race, else `generic_explosive_long_01a` |
| Triglavian (raceID 135 or DNA race) | `triglavian_explosive_tgdn01_t1` for dreadnoughts (group 485), else `triglavian_explosive_01a` |
| jove / drifter DNA race | `drifter_cruiser_explosive_01a` for M, else `drifter_explosive_01a` |
| sleeper DNA race | `sleeper_explosive_01a` |
| S (rigSize 1) | `generic_explosive_short_01a`, `_01b` |
| M (2) | `generic_explosive_01a`, `_01b`, `_01c` |
| L, XL (3, 4) | `generic_explosive_long_01a`, `_01b`, `_01c` |

- Size from the hull's rigSize (1547), else the SOF class's, else S; the variant `combatPick(seed, "explosion|<ship>")`.
- **`lingerSeconds`** (how long the ball stays, K3) = ceil of the duration bound with `MAX_LOCAL_BLASTS` blasts, from
  the runtime's `CalculateExplosionTimes`: `max(localDelay + localDuration + S, globalDelay + S + globalDuration)`,
  `S = interval × (1 − factor^N) / (1 − factor)` (`triFloatRandom01` ≤ 1): short 01a 16 s, generic 01a 21, long 01a
  52, titan amarr 44. The timing values are captured in `SHIP_EXPLOSION_TIMINGS` (tools-core `?format=json`, build
  3632936). The Triglavian dreadnought file has the older single `localExplosion` / `globalExplosions` members; the
  runtime plays and draws it (K3 GPU check).
- **`referenceRadius`** (the drawn bounding radius the file's authored size suits; the page multiplies the file's own
  scaling by `max(1, radius / reference)`), pinned from the GPU check: `EXPLOSION_REFERENCE_RADII` S 70 m, M 250, L
  550, XL 1,500 (the Triglavian dreadnought's file); the titan files `TITAN_EXPLOSION_REFERENCE_RADIUS` 7,000; the
  titan fallback (a long file) L's 550. A hull under its class's reference plays the authored size.

## Tools

- **`ship_stats`** (K1): turret rows in `fit.modules` carry `damage` (per shot by type, before quality), `volley`,
  `dps`, `tracking`, `signatureResolution`, and `explosion` / `spool`; `stats`, `withPropMod` and `withActive.stats`
  carry `weapons: { turrets, volley, dps, damage }` (DPS by type; a siege module in `active` raises it). Spec:
  `ship-stats-tool.spec.ts` (a default-fit Rifter text gives the table's numbers; a TFI's empty guns load Barrage L).
- **`patch_scene`**: `set_combat`.
- **`set_target`** starts the lock (its answer's `lock`: `{ state, lockTime?, readyIn?, note? }` or `{ refused }`); a
  null target ends the ship's engagement. **`switch_modules`** turrets wait for the lock on the ship's target.
- **`engage`** `{ selection, target, modules? }`: the target becomes each ship's target and its lock starts, the
  matching turrets switch active (they wait for the lock), and the engagement keeps them firing (`Engagements`). It
  ends on `cease_fire`, `set_target` null, removal or a load, and survives the target's death. Skipped: itself, in
  warp, target in warp, destroyed, fit unresolved, no targeting numbers, no matching turret. A `warning` when shooter
  and target share a team (no hostility check).
- **`cease_fire`** `{ selection, unlock? }`: ends the engagement, its turrets switch online (cycle end); `unlock` also
  clears the target (the sweep drops the lock).
- **get_state** per ship: `targeting` `{ scanResolution, maxTargetRange, maxLocks }`, `locks`, `engaged`, `combat`
  `{ dealt, taken, dps: { dealt, taken }, shots, hits, misses, lastHits, lastTaken, paperDps }` (once it fired or was
  shot), `destroyed` `{ tick, by, module, weapon, mode }`; weapon rows `combat` `{ damage, volley, dps }` and the lock
  note while held; scene `combat` `{ seed, death, shots, hits, kills }`.
- **`Director.OnKill(listener)`**: for the fleet targeting lever and the automatic camera.

## State to snapshot (time control)

Plain data in its owners: `ShipLocks` (locks, keeps), `DamageModel` (HP), `CombatRules` (tallies, kills, destroyed,
spools), the `ModuleCycle` activation counters, `Director.engagements`, `FleetTargets` (own marks, called targets,
holds, responses, the last calls and primaries: `sd-fleets` doc `targets`), and `Director.deaths` (kill, explosion
choice, start, hidden, `removeTick`, gone). The RNG is the document's seed, so a re-simulation rolls the same; explosions
re-trigger from their kills' times.

## Seams

- Fleet targeting lever (built, `sd-fleets` doc `targets`): `SetShipTarget(…, { requestedAt })` for called primaries;
  `Engagements` arms `FleetTargets.Armed()` like an engagement; pre-locks join `WantedLocks` under `maxLocks` (not
  `ShipLocks.Keep`: sticky, and at the limit it can block the primary's own lock); the move-on is the boundary sync
  before the lock sweep (not `OnKill`, which runs inside `Shots` and would re-enter ShipModules for no earlier first
  shot); `Director.OnPrimary(listener)` reports each group's primary change for the automatic camera.
- Logi auto-repair: `DamageModel.Fractions` / `Report`, `CombatRules.Report(id).dps.taken`, `Attackers(id)`.
- Missiles: a `missile` kind through `Resolve` with the shared `applyLayeredDamage`.

## Verify-page (K2)

`set_target locks with EVE's lock time and the guns wait for the lock`, `hits at rest within optimal always hit and
land EVE damage through resists`, `shots in falloff mostly miss, and misses post no impact sound`, `engage arms the
guns; cease_fire stops them; a lost lock re-fires after the re-lock`, `the same seed replays the same fight; another
seed differs`. The turret checks count from the lock; `turrets are not refused by range: they wait for the lock`.

Evidence (2026-10-23, SDE 3632936, headless): lock time 2.617 s Rifter → Punisher (825 mm, sig 37), first shot on the
lock's boundary; at 40 km `out of targeting range: 39.9 km, it locks at 28.1 km`. Two Punishers on a Rifter at 2 km:
16 / 16 hits, shield rows equal the volley through resists, dealt 803.1 = taken 803.1 (HP lost 794.3: the shield
recharged the rest). Rifter at 20,085 m (chance 0.063): 11 of 12 missed, 1 impact sound for 1 hit. Seed 1 twice: 40
shots, the kill 15 ticks after `engage`, by p2 high-0, dealt [824.6, 748]; seed 2: 32 shots, 12 ticks, p2 high-2.

## Verify-page (K3)

`a ship at 0 hull explodes and leaves cleanly`, `a dead squad lead and a dead FC fall back like a removal`,
`load_scene revives the dead`. Evidence (2026-10-23, SDE 3632936, headless): Rifter killed by p2 15 ticks after
`engage`; the orbiter `stopped: target "rifter" was destroyed`; `order_ship` refused; posted
`ecx_generic_explosive_short_individual_01b_play` and `..._global_01b_play`; the ball gone at tick 85 (removesAt 84),
`audio.gameObjects − emitters` 1 before and after. Fleet: the lead dead at tick 21, the squad anchors on the wing
commander; the FC dead at tick 39, the wing commander acts for it and the member follows it. A load: 6 ships alive at
full HP, no kills, the FC back.

The kill check also asserts no `audio.foreign`. Headless draws no hull, so the hull's damage effects (the VDS fires)
never load there and its result says `(no renderer: the hull's damage effects never load)`; the real-GPU run covers
them (Real-GPU evidence → Audio).

## Real-GPU evidence (K3)

2026-10-23, dbxpc (Windows Chrome, nvidia lovelace, 1600 × 900), SDE 3632936, a private hub on 5521; drivers and
artifacts in `.scratch/combat-gpu/` on that machine (`fight.mjs` the controller driver, `probe.js` the per-frame
explosion timeline, `calib.js` a private `ShipExplosions` that plays any file on a live hull at a given reference).

- **The 3v3** (3 Rifters vs 3 Punishers at 6 km, `engage` each fleet on the other's FC): `run5-3v3/` at 450 m off
  blue's FC: `006-fight-0-44-100.png` autocannon tracers past the hull and an armor impact, `009-fight-0-0-38.png` a
  hull impact with the hull's damage fire; the kill `010`–`018-blue-fc-k{0.5,1.5,3,6,12}s.png`: blasts on the hull
  (1.5 s), short 01b's global flash and plume enveloping where the hull was (3 s, hull gone at the wreck switch), debris
  and smoke (6 s), the tail. Each kill: 8 local blasts and the global one, each sound posted on the dying ship's emitter
  with `played: true`; the hide at the wreck switch (short 01a 1.87 s, 01b 2.55 s); roots off at `totalDuration`
  (15.4 / 22.5 s), `scene.objects` back to the live ships. Red's fleet acts on `red-dps-01` (`actingFor: red-fc`),
  in formation. 45–57 fps, `gpuErrors` 0, `ShipExplosions.Errors()` empty, `page_log` info only.
- **M and L** (2 Ferox vs a Megathron at 5 km, `run2-ml/`): the Ferox dies (generic 01a, factor 1.011, wreck switch
  2.77 s, done 17.8 s), then the Megathron (long 01c, factor 1, wreck switch 9.67 s, done 33.7 s):
  `023-blue-fc-k3s.png` blasts along the hull, `025-blue-fc-k12s.png` the blue-white flash (~920 m) over the ~460 m
  hull. 54 fps mean, p99 28 ms.
- **Calibration** (`calib/`, hull left drawn, factor 1 = authored size): Rifter (bounding 68 m) short 01a fireball
  ~640 m (`rifter-*`); Ferox (253 m) generic 01a ring ~1.3 km, fireball ~2.3 km (`ferox-1-3s.png`); Megathron (541 m)
  long 01a flash ~880 m (`mega-2-5_2s.png`, blasts on the hull `mega-2-4s.png`); Zirnitra (1,446 m) tgdn01 red blasts
  then a red flash about the hull (`zirn-1-1_5s.png`, `zirn-1-5s.png`: the older members draw); Avatar (6,954 m) titan
  amarr fireball ~12 km (`avatar-1-6s.png`). Each class's authored size envelops its typical hull, so the reference is
  that hull's radius: S 70, M 250, L 550, XL 1,500, titans 7,000.
- **Fixed on the way** (`explosions.ts`): the child's `scaling` was overwritten (short 01a drew at 3.4× its authored
  size, a 1.1 km fireball on a Rifter) and long 01a's root scale 5 threw its blasts up to 1.8 km off the hull
  (`sd-runtime` → Explosions).
- **Scale** (the TFIs, 44, vs 10 Ferox at 20 km, `run4-scale/`, re-engaging the next Ferox on each kill): 9 kills in
  ~75 s, up to 4 explosions at once, 11–14 fps through explosions, 17–23 between, 26–30 at rest, `gpuErrors` 0, no
  explosion errors; after cease-fire `scene.objects` 45 = the live ships, 0 explosion roots.
- **Audio**: the explosion roots register no emitter (no `GlobalExplosionEmitter` anywhere). Before the fix,
  `audio.gameObjects − emitters` grew by 7 per frigate and 10 per Ferox when its armor ran out, before the kill (3v3
  1 → 15, M and L 1 → 24, scale 38 → 115), surviving the ball's removal and a load. The cause was not the impact
  overlay but the hull's VDS controller: `SetImpactDamageState` moves it to `addFires`, whose child effect
  `vds_trail_fire_01a` loads through `LoadObject` (async) and copies its emitter template (`smoke_fire_sfx`,
  `smoke_fire_hangar_sfx`, `LocalExplosionEmitter1`) per damage locator inside the scene update, both with the seams
  attached. **Fixed** by running every runtime object build and `engine.Frame` detached (`sd-runtime` → Audio).
  After (2026-10-23, same setup on a private hub on 5522, `.scratch/audio-leak/`): the in-page probe
  (`SetImpactDamageState(1, 0, 0.5)` on a lone Punisher) loaded `vds_trail_fire_01a`, 1 → 1 game objects and 0
  registrations, the fire still drawn (`probe-burning-hull-110m.png`); the 3v3 (`run1-3v3/`), M and L (`run2-ml/`)
  and the scale run (`run3-scale/`, all 10 Ferox killed) kept `gameObjects − emitters` at 1 with no `foreign` on every
  row, through each `load_scene`; the probe recorded 0 foreign registrations across all three; explosion sounds
  `played: true`; `frameErrors`, `backendErrors` and `gpuErrors` 0; fps as before (3v3 median 60, 33 at a kill
  frame; M and L mean 55.8; scale 10–29 through kills, 31 at rest, one 4 fps sample at the first `generic_01c` load).
  A detached window costs 0.28 µs.
- `frame_camera` on a destroyed ship frames every ship (the dead are skipped), so a driver must frame the victim before
  the kill.

## Test data

The dogma fixture (`sd-fittings`) carries every default weapon and charge. Explosion timing: `curl
"http://127.0.0.1:5510/eve/3632936/res/fisfx/explosion/ecx_<name>.black?format=json"`, the `EveChildExplosion`'s
scalar members; the folder list from the res index (`resfileindex`). Re-capture both when CCP ships new explosions.
