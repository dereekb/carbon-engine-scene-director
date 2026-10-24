# Combat: locks, turret hits, damage, kills, explosions

> Fetch before touching `packages/scene/src/lib/combat/`, anything that locks, rolls a shot, applies damage or kills a
> ship, damage immunity (`ships[].immune`, `set_immunity`), the document's `combat`, or the `engage` / `cease_fire`
> tools. Turrets, targets and the shot hook this builds
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

**Missiles** (`~/.claude/plans/missiles-launchers-fire-destiny-pursued-evemissiles-that-hit-through-eve-s-missi.md`):
**M1 is in** (2026-10-23): EVE's missile rules and numbers in `packages/scene` (Missiles, below), the evaluator's
missile effects (`sd-fittings`), default missiles and the `/missile` route (`sd-weapons`), `ship_stats` launcher rows.
**M2a is in** (2026-10-23): Destiny missile balls (`sd-destiny` → Missile balls), the flight book and missile hits /
expiry rows in Combat rules (Missiles in the page, below). **M2b is in** (2026-10-23): launchers run and the director
fires, resolves and reports missiles, headless (`sd-weapons` → Launchers fire). **M3 is in** (2026-10-23): missiles
draw, detonate on the drawn hull and kill there, checked on the real GPU (Missiles in the page → Drawn, below;
`sd-weapons` → Launchers fire, drawn). The plan is delivered.

**Battle damage** (`~/.claude/plans/ship-battle-damage-set-hp-by-percent-amount-random-or-layer.md`): **done**
(2026-10-24). H1 and H2 brought `set_hp`'s command and maths in `packages/scene`, the page half, get_state and
verify-page (Battle damage, below). H3 brought the real-GPU look: the evidence is below, and the recipes are in
sd-cinema → Battle-damaged looks.

## Files (K1)

| File | Holds |
|---|---|
| `combat/accuracy.ts` | `turretHitChance` (Destiny's guards), `NO_FALLOFF_METRES` (1), `rollShot`, `HIT_RESULTS` / `hitResultOf`, `ShotResult`, `WRECKING_ROLL` (0.01), `WRECKING_QUALITY` (3), `QUALITY_OFFSET` (0.49), `missileApplication` (`vortonApplication` is the same function) |
| `combat/missile-numbers.ts` | `MISSILE_COMBAT_ATTRIBUTES`, `MissileCombatNumbers`, `missileCombatNumbersOf(ship, bundle, key)`, `missileFlightTime`, `missileRange` (`MissileRange`), `NO_MISSILE_NOTE`, `MISSILE_TICK_SECONDS` |
| `combat/damage.ts` | `DamageVector`, `NO_DAMAGE`, `shotDamage`, `damageTotal`, `applyLayeredDamage` (pure), `passiveRecharge` (the closed form) |
| `combat/locks.ts` | `lockTime`, `LOCK_TIME_CONSTANT` (40000), `pilotLockLimit`, `shipLockLimit`, the two Target Management skills |
| `combat/random.ts` | `combatRoll(seed, key)`, `combatHash` (cyrb53), `combatUnit(seed, key)` (the picks, shuffles and set_hp's draws roll on it), `combatPick`, `combatShuffle`, `CombatRollKey` |
| `combat/weapon-numbers.ts` | `TurretCombatNumbers`, `turretCombatNumbersOf(ship, bundle, key)`, `ShipWeapons` (`turrets`, `launchers`), `shipWeaponsOf` (turrets and launchers summed), `TURRET_COMBAT_ATTRIBUTES`, `NO_CHARGE_DAMAGE_NOTE` |
| `combat/explosions.ts` | `SHIP_EXPLOSIONS`, `SHIP_EXPLOSION_TIMINGS` (captured), `explosionDurationBound`, `shipExplosionOf`, `MAX_LOCAL_BLASTS` (8), `EXPLOSION_REFERENCE_RADII`, `TITAN_EXPLOSION_REFERENCE_RADIUS` |
| `combat/document.ts` | `SceneCombat`, `COMBAT_DEATH_MODES`, `DEFAULT_COMBAT_SEED` (1), `DEFAULT_COMBAT_DEATH` (`explode`), `normalizeSceneCombat`, `sceneCombatOf`, `COMBAT_OPERATIONS` / `applyCombatOperation` (`set_combat`) |
| `combat/commands.ts` | `normalizeEngageCommand` (`{ selection, target, modules = DEFAULT_ENGAGE_MODULES ["turret", "launcher"] }`, a celestial refused), `normalizeCeaseFireCommand` (`{ selection, unlock }`) |
| `combat/kill.ts` | `ShotOutcome`, `ShipKill`, `ShipKillReport`: the plain data the page will report and the timeline, time control and automatic camera read; `by` / `module` / `weapon` are absent and `cause: "set_hp"` (`ShipKillCause`) set for a set_hp kill |
| `combat/hp-set.ts` | set_hp: `normalizeHpSetCommand`, `HP_SET_INTENTS` (`cinematic` default, `gameplay`), `CINEMATIC_MIN_STRUCTURE_HP` (1), `HP_SET_TARGETS`, `readHpAmount`, `hpSetHasRandom`, `hpSetValuesOf`, `hpSetRoll`, `drainTotalHp`, `resolveHpSet` (Battle damage, below) |
| `combat/distributions.ts` | `HP_DISTRIBUTIONS` (`uniform` default, `normal`, `triangular`), `DEFAULT_NORMAL_SD_SPANS` (4), `uniformQuantile`, `triangularQuantile`, `normalCdf`, `normalQuantile`, `truncatedNormalQuantile`, `distributionQuantile` |
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

### Missiles (missiles M1; checked 2026-10-23)

Sources: EVE University "Missile mechanics" / "Missiles"; Pyfa (`missileMaxRangeData`, effects 660-668, 1851, 763,
2851, `_calcMissileFactor`, issue 2083); Destiny's missile code in the server fork (`PyLaunchMissile`,
`MissileFollow`); SDE 3632936.

- **Launchers**: default effect 101 `useMissiles` (category 1, not a target effect; duration attribute 51); no
  `damageMultiplier`. Rate of fire 51: LML II 12.8 s, HML II 12.0, CML II 16.54, RLML II 6.24, HAML II 6.4.
- **Missiles** (T1): effect 9 `missileLaunching`; radius column 300 m; damage 114-118 stackable, 37 / 70 / 281 / 653 /
  654 not. Light 83 dmg, 3,750 m/s, 5.0 s, 40 m / 170 m/s / drf 0.604; heavy 149, 4,300, 6.5 s, 140 / 85 / 0.682;
  cruise 375, 4,700, 14.0 s, 330 / 69 / 0.882.
- **Damage per missile** = the charge's evaluated damage × the character's `missileDamageMultiplier` (212; BCS and
  Warhead Calefaction rigs raise it, stacking-penalized). Skills (+25 % from the missile skill, +10 % Warhead
  Upgrades), hull bonuses and the specializations' −10 % rate of fire come from the evaluator (`sd-fittings`).
- **Flight time** T = explosionDelay + shipRadius / velocity (missiles start at the shooter's centre). **Range**: a
  missile flies floor(T) or ceil(T) whole 1 s ticks, the longer with chance T − floor(T); each case `v / 2 × a + v ×
  (t − a) − shipRadius`, a = min(t, mass × agility / 1e6) (T1 heavies: ~1e-7 s). `missileRange` gives `{ lower,
  upper, upperChance, mean }`.
- **Application** (`missileApplication`): `min(1, S / E, (S / E × Ve / Vt) ^ drf)` with the target's live signature
  and speed at impact; no roll, no wrecking (a missile that arrives always hits). A signature ≤ 0 takes nothing; no
  explosion radius applies fully; a target at rest or Ve 0 leaves S / E.
- **Paper DPS** = volley / rate of fire, reloads left out (Pyfa's default, as for turrets).
- Fixture check (`missile-numbers.spec.ts`, max skills, Scourge):

  | Fit | Rate of fire | Per missile | Paper DPS (fit) | Velocity | Flight time | Range lower / upper (chance) / mean | Explosion |
  |---|---|---|---|---|---|---|---|
  | Caracal, 5 × HML II (default fit) | 6.1965 s | 204.875 | 165.3 (volley 1,024.4) | 9,675 m/s | 9.771 s | 86.87 / 96.55 (0.771) / 94.33 km | 105 m, 127.5 m/s, 0.682 |
  | Kestrel, 4 × LML II | 8.8128 s | 142.66 | 64.7 | 8,437.5 | 7.505 | 59.02 / 67.45 / 63.28 km | 30 m, 255 m/s, 0.604 |
  | Raven, 6 × CML II | 8.5408 s | 515.63 | 362.2 | 10,575 | 21.024 | 221.83 / 232.40 / 222.08 km | 247.5 m, 103.5 m/s, 0.882 |
  | Drake, 6 × HML II | 8.262 s | 307.31 | 223.2 | 8,062.5 | 9.75 | mean 78.61 km | |

  A BCS II multiplies the damage by 1.1 and the rate of fire by 0.895. Heavy Scourge on a Punisher (sig 37) at rest
  applies 37 / 105 = 0.352.
- `missileCombatNumbersOf` is null for a key the ship lacks, a module that is no launcher (probe launchers have no
  `launcherFitted`) or one without a cycle; a launcher without a missile (or with a charge that is no missile) gets
  zeros and `NO_MISSILE_NOTE`.

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
| `viewer/locks.ts` | `ShipLocks` over `ShipLocksPort` (`SurfaceDistance`, `InWarp`, `IsTargetable`, `Targeting`, `SignatureOf`, `tickSeconds`): `Request`, `Keep` / `Release`, `Boundary(tick, wanted)`, `IsLocked`, `Hold`, `Of` / `On`, `Lockers` (locking or locked only), `Remove`, `OnWarpEnter`, `Clear`, `Report` |
| `viewer/combat.ts` | `CombatRules` over `CombatPort` (`Accuracy`, `Speed`, `Weapon`, `SignatureOf`, `KindOf`): `SetCombat`, `Recharge`, `Resolve`, `IsDestroyed`, `KillOf`, `Kills`, `Totals`, `Report`, `Attackers`, `TakenSince` (and its twins `DealtSince`, `RepairedSince`: the camera director's picture), `RecordRepair`, `Remove`, `Clear`; `DPS_WINDOW_SECONDS` (20), `COMBAT_ROWS` (3) |
| `viewer/module-cycle.ts` | the gate `Boundary(boundary, { hold })` and `activations` (every event carries `activation`) |
| `viewer/modules.ts` | port `LockHold?`, the lost-lock stop, the lock-gated retarget (`IsLockGated`: weapons and remote repairers; the `retarget` switch option), `Remove(id, boundary, why)`, `Spec`, `LockAims`, `WeaponKeys` (turrets and launchers), `RemoteRepairers`; specs carry `combat` / `missile` (`ShipModuleSpecsOf`) |
| `viewer/damage.ts` | `ApplyHit`, `Recharge`, `Destroyed` (`capacitor.ts`' `CapacitorFractionAfter` is `passiveRecharge` too: one formula) |
| `viewer/destiny.ts` | `Accuracy(source, target, numbers)`: the master park's `GetAccuracy` (`destiny-accuracy.spec.ts`) |
| `viewer/director.ts` | the wiring below, `Engage` / `CeaseFire`, `OnKill`, get_state |

## Files (K3)

| File | Holds |
|---|---|
| `fleets/live.ts` (scene) | `toLiveFleetScene(scene, gone, overlay?)` → `{ scene, changes, warnings }` (`overlay.calls`: the live call book spliced in first; `overlay.commanders`: a personality fleet's acting commander): `LiveFleetView`, `LiveFleetChange` (`actingFor`, `destroyed`, `dropped`); `toDefaultFleetSuccessor(fleet, gone)` (the acting commander rule); spec'd |
| `viewer/fleet-succession.ts` | the heir flies on: `CaptureFleetHeirs`, `HeirOrderOf`, `InheritFleetOrders` (`sd-fleets` "Edits and fallback"); node-tested |
| `viewer/destiny.ts` | `Destroy(id)` / `IsDestroyed(id)`, the `destroyed` refusals, prop mod cause `destroyed` (`destiny-destroy.spec.ts`) |
| `viewer/explosion-plan.ts` | `ExplosionFileFacts`, `ExplosionFiles`, `ExplosionSchedule` / `ExplosionTimes`, `ExplosionRemoveTick`, `EXPLOSION_LINGER_MARGIN_SECONDS` (2); node-tested |
| `viewer/explosions.ts` | `ShipExplosions` (runtime, renderer only): `Start`, `Frame`, `Report`, `Remove`, `Clear`, `Roots`, `Errors` |
| `viewer/director.ts` | `Destroy`, `Hide`, `RemoveDead` (the linger), `Revive`, `LiveFleets`, `DriveExplosions`, `ExplosionStarts`, `PostExplosionSound`, `IsDead` skips |

## Death (`combat.death`)

A gameplay `set_hp` that leaves structure at 0 dies the same way at the next boundary (Battle damage → Intent), its kill
`cause: "set_hp"` with no shooter; `explode` then starts its explosion at once (no shot draws it).

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
the fleet (`update_fleet`) to its successor (a personality fleet's designate, the overlay's `commanders`, set by
`FleetCommanders.CommanderDown` in `Director.Destroy` before the heirs are read, `sd-personalities`; else
`toDefaultFleetSuccessor`: the first live wing commander in wing order, else the first live squad commander, else the
first live member); an overlay commander also takes the command from a flagged FC that still flies, at its handover; then `removeShipFromFleets` per dead ship, so squads anchored on it fall back down the chain
with remove_ship's warnings; a fleet with nobody alive is dropped. The page's live calls (`FleetCommanders`, the
`overlay` argument, `sd-fleets` doc `targets`) replace their groups' document lists first. Never written.
`Director.LiveFleets()` memoizes it by (document, destroyed set, call book `version`) and feeds `FleetTargets`, `FleetFollowing`, `FleetOrders`, get_state's memberships and fleets (`actingFor`,
`destroyed`; a dropped fleet is not listed). An untouched scene is the same object.

**The fleet flies on** (`fleet-succession.ts`): `Director.Destroy` reads, before `world.Destroy`, the fleets the dead
ship commands (live view) and, after the death enters the view, each fleet's new commander, and `CaptureFleetHeirs`
records the dead FC's `world.Motion` and whether the heir followed framed on it. After `following.Reconcile` re-plans
the formation on the heir, `InheritFleetOrders` orders the heir on with the FC's order, so neither the heir nor the
members ever fly a stopped tick (rules: `sd-fleets` "Edits and fallback").

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

## Missiles in the page (M2a built and spec'd, M2b wired, M3 drawn)

| File | Holds |
|---|---|
| `weapons/shots.ts` (scene) | `WeaponShot.missile?: WeaponShotMissile` `{ id, launchedAt, damage, explosion }` (damage and explosion fixed at launch; null without dogma) |
| `viewer/destiny.ts` | the missile balls (`sd-destiny` → Missile balls) |
| `viewer/missile-flights.ts` | `MissileFlights` (`Add`, `Refused` / `RefusalOf`, `End`, `ShotOf`, `Due`, `Prune`, `Counts`, `InFlightOf`, `Report`, `Forget`, `Clear`), `MissileFlightId`, `MISSILE_REPORT_ROWS` (40), `MISSILE_FLIGHT_KEEP_TICKS` (linger + 2) |
| `viewer/combat.ts` | missile outcomes in `Resolve`, `Expire`, `MISSILE_EXPIRED_NOTE`, `MISSILE_TARGET_DESTROYED`; rows' `missile: true` |

- **A missile hit is a `WeaponShot`** (`MissileFlights.ShotOf`): the launcher's ship, module, typeID and name, the
  charge, target and kind, the launch's cycle and activation, `tick` the boundary it resolves at, `at` the contact,
  distance 0, effectiveness 1, `missile` from the flight. `Resolve` sorts it with the boundary's turret shots by (at,
  ship, module), so which one kills stays deterministic. A destroyed target (earlier in the boundary too): `overkill`.
  An object, or no dogma (`damage` null): `hits` with `objects take no damage` / `no EVE dogma for its weapon: it does
  no damage`. A ship: `chance = quality = missileApplication(...)` from its live `SignatureOf` and `Speed` against the
  launch's explosion, `result: 'hits'` (no roll, no wrecking, no spool), `shotDamage(damage, quality)` into
  `DamageModel.ApplyHit`; a ship the model does not track takes nothing (the turret note). Kills as turrets:
  `ShipKill.weapon` is the launcher's name. Spec: Scourge Heavy on a Punisher at rest applies 37 / 105 (72.2 HP raw),
  then the shield's kinetic resonance.
- **`Expire(shot, why, boundary)`**: a missile that finished without reaching its target records a row with no
  damage and no `onDamaged`: `misses` with its note (`it ran out of flight time`, `its target entered warp`, `its target
  was removed`, `its ship …`), `overkill` for `its target was destroyed` (or a target destroyed meanwhile). So shots,
  hits and misses count finished launches.
- **The flight book** (`MissileFlights`): `Add(launch, now)` records `{ id: <ship>|<module>|<activation>|<cycle>, ship,
  module, typeID, name, charge, target, targetKind, cycle, activation, tick, at, numbers }` (the spec's missile numbers
  at launch: a refitted launcher or a shooter killed after a hit was found still lands it) with `drawAt` = T(boundary)
  + max(0, at − tick) ticks (M3: at its boundary, Drawn below). `End(event, now, boundary)` applies a DestinyWorld
  event: `finishes` once per flight (a hit → `Resolve`; a loss or expiry → `Expire`; a lost target's later expiry only
  ends its flight), the end's draw time by the same rule, and a `hit` or `vanish` moment for `Due(now)` (with the
  `launch` moments, in draw order; a loss queues its `vanish` at once).
  `Counts(ship)` `{ launched, inFlight }`, `InFlightOf(ship, module)`, `Report(boundary, world.Missile)`: `{ inFlight,
  launched, hits, expired, lost, refused, flights }` (at most 40 rows, flying first, soonest end first: `{ id, ship,
  module, charge, target, state: flying | lost | hit | expired, launchedAt, age, expiresIn, distance, speed, why }`).

### The wiring (M2b, `director.ts`)

- **Launches** (`Launches(events)`, in `ModuleOutputs` right before `Shots`, so a kill in that Resolve loses the new
  missiles too): every launcher `cycle` event with a live target kind → `world.LaunchMissile({ id: MissileFlightId,
  owner, target, physics: { mass, agility, maxVelocity: velocity, radius }, launchedAt: at + 1, expiresAt: launchedAt +
  flightTime / tickSeconds })` (the drawn frame, the turret draw rule: a first cycle at the boundary flies ceil(T)
  whole ticks; `sd-destiny` → Missile balls) → `MissileFlights.Add`, or `Refused` with DestinyWorld's reason (no
  `missile` numbers: "no EVE dogma for its missile"). Turret `cycle` events still become turret shots (`WeaponShotsOf`).
- **Ends** (`MissileArrivals(boundary)`, after `Engagements`, before `ModuleEvents`): `TakeMissileEvents()` → `End` →
  for a finishing hit, `ShotOf(flight, event.at, boundary)` waits in `missileHits` for that boundary's `Shots`, which
  appends it to the turret shots (not to `ShotQueue`: nothing draws yet) for ONE `Resolve` and the `OnShot` listeners;
  a boundary with no turret event resolves them with `Shots([])`. Losses and expiries go to `combat.Expire(ShotOf(…),
  why ?? MISSILE_EXPIRED_NOTE, boundary)` at once. Then `Prune(boundary)`. `LoseMissileTargets`' events from a kill
  inside `Resolve` drain one boundary later.
- **`DriveMissiles(now)`** (`main.ts`, after `DriveTurrets`, before `DriveExplosions`): takes `Due(now)` and draws it
  (Drawn, below).
- **Death**: `world.Destroy` loses the missiles at the victim; the dead shooter's own missiles vanish on the next evolve
  ("its ship was destroyed"). **Removal**: `world.RemoveMissilesOf(id)`, `MissileFlights.Forget(id)`. **Load**:
  `world.ClearMissiles()`, `MissileFlights.Clear()`.
- Evidence (headless, 2026-10-23, SDE 3646012): a Caracal's Scourge Heavy at a Punisher 14,764 m off at rest launched
  at tick 58 and hit at 60; every hit `quality` = `chance` = 0.352 (37 / 105), 43.3 HP per missile into the shield
  (volley 204.88, kinetic resist 40 %), dealt 216.6 = taken 216.6. A Punisher with `maxVelocity` 9000 (11,242 m/s)
  fleeing straight away outran a volley: 5 expired, 5 misses ("it ran out of flight time"), its taken unchanged. At
  ~60 km two Punishers killed a Rifter under the Caracal's fire: 10 flights `lost` ("its target was destroyed",
  overkill rows), no damage after the kill; a Punisher warping off: 5 lost ("its target entered warp"). The Caracal
  warping: 5 vanished ("its ship entered warp"). A Caracal `engage` (no `modules`) armed its 5 launchers and killed a
  Rifter at 8 km 53 ticks later (`destroyed.by` caracal, `module` high-0, `weapon` Heavy Missile Launcher II); the
  explosion played and the ball left; audio game objects − emitters unchanged.

### Drawn (M3)

- **The draw rule changed**: the replica draws missile balls at master time (no lag, unlike ships; `sd-runtime` →
  EveMissile), so a launch draws at its boundary and an end at its drain boundary: `now + max(0, at − tick)` ticks (the
  turret rule's `at + 1 − tick` drew the hit a tick after the drawn ball arrived). A lost target's drawing vanishes at
  the loss (a warhead left on the hull would detonate there); its later expiry queues nothing.
- **`DriveMissiles`**: `launch` → `DrawLaunch` (the burst, the outburst sound and the drawn missile: `sd-weapons` →
  Launchers fire, drawn); `hit` → `ShipMissiles.Hit`: `drawn` (the missile is still flying: its detonation will play the
  impact), `played` (it already detonated: the kill starts now, `MissileKill`) or `undrawn` (no renderer, over the cap,
  its files not loaded: the impact sound and kill at the hit's draw time, `MissileDetonated`); `vanish` →
  `ShipMissiles.Vanish`. Then the drawing's frame: each detonation posts the impact sound on the target's emitter and
  starts a fatal hit's explosion there.
- **Missile kills start at the drawn detonation**: `missileHitShots` keeps each resolved hit until it detonates; a
  `fatal` hit still drawing puts its victim in `drawnMissileKills`, and `DriveExplosions`' fallback (a killing shot that
  never drew) waits `MISSILE_FALLBACK_TICKS + 1` (3) ticks for it instead of 2. Cleared on removal and load.
- **Real-GPU kills** (2026-10-23, run6 in `.scratch/missiles-gpu/`; `sd-weapons` → Real-GPU evidence: missiles): 10
  Caracals vs 10 Rifters at 30 km, 50 launched / 50 hits / 50 detonated, red-fc killed by a Heavy Missile Launcher II
  and its explosion played at the detonation; audio `gameObjects − emitters` 1 → 1, `gpuErrors` 0. TFIs (44) vs 20
  Caracals: fps 13-17 with 95-missile volleys against ~22 with turrets alone (the K3 baseline 17-23 between kills).

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
- **No targeting numbers** (the table path, no EVE dogma for the hull, with EVE data): `Request` refuses (`it cannot
  lock: no EVE dogma for its hull`) and `Hold` is null, so its turrets fire unlocked as before (and do no damage: no
  combat numbers). Stand-ins without EVE data have numbers (Stand-in combat below).
- **The gate** (`ModuleCycle.Boundary(boundary, { hold })`, through `ShipModulesPort.LockHold` = `ShipLocks.Hold`):
  an activating turret with a hold stays `activating` with the hold as its note (`waiting for its lock on "x" (1.6
  s)`): EVE's pre-activation. A running turret whose lock is lost stops at its cycle end (`it lost its lock on "x"`).
  A pending retarget switches at the first cycle start once the new target is locked. Weapons (turrets, launchers)
  and remote repairers wait (`IsLockGated`; logi L2, `sd-logi`): webs, scrams, points, neuts, nos, transmitters and
  EWAR run without a lock.

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
  taken (`lastTaken`), contributors, `Attackers` (who shot it in the window). Scene totals: shots, hits, repaired.
  `TakenSince(id, boundary, seconds)` sums the taken window over the trailing seconds (≤ 20): auto-repair's pressure.
- **Repair tallies** (logi L2): the director's `ModuleOutputs` calls `RecordRepair({ ship, from, module, layer, amount,
  nominal, tick })` for every repair landing, local and remote: `amount` is `DamageModel.Repair`'s return (HP
  restored, capped at max), `nominal` the cycle's HP after falloff. The victim gains `repaired`, a 20 s
  `repairedWindow` and 3 `lastRepaired` rows; a remote giver gains `given` and `givenWindow`. A 0 HP landing on a full
  layer is recorded (pre-reps show as `amount: 0`). `Report` adds `repairs { received, given, hps { received, given },
  lastReceived }` once a ship received or gave one, so a logi that only repairs gets a `combat` block. `Clear` and
  `Remove` forget them.
- **Director wiring**: one `OnBoundary` listener, in order: `RemoveDead(boundary)`, `combat.Recharge(tick s)` (impact
  overlays re-armed when the shield moved > 0.1 %), `combat.SweepDestroyed(boundary, not in warp and not arriving)`
  (set_hp's gameplay kills), `SyncFleetTargets(boundary)` (the fleet targeting lever: members
  take their groups' next live called targets, locks asked at `boundary − 1`; `sd-fleets` doc `targets`),
  `SyncAutoRepair(boundary)` (logi auto-repair: each fleet's logi pick their targets and switch their remote repairers
  with `retarget`; `sd-logi`), `locks.Boundary(boundary, WantedLocks())` (wanted: `LockAims` (weapons and remote
  repairers, so a rep target picked this boundary starts its lock here), targets, then called members' pre-locks and
  the logi's `autoRepair.PreLocks()` under `maxLocks`), `Engagements(boundary)` (an engaged ship's matching weapons back `online` switch active again, then
  `fleetTargets.Armed()` members with `DEFAULT_ENGAGE_MODULES`: `ArmWeapons`), `MissileArrivals(boundary)`,
  `ModuleEvents(modules.Boundary(boundary))`, then `Shots([])` when missile hits are left. `Shots` resolves the
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
death? }` merges, `null` resets a field. `diffScenes` flags `combat`. Damage immunity (`ships[].immune`) is document
state too, a rule like the death mode. **Kills are live state** like HP, locks and targets: the document stays the setup, `load_scene` / `open_scene` revive everyone, `remove_ship` keeps an aftermath.
`set_hp` sets HP live and writes nothing (Battle damage).

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

## Battle damage (`set_hp`)

A page tool (`where: 'page'`) that sets the live shield, armor and structure HP of ships, a fleet, a wing or a squad:
hulls that look battle damaged for a shot, or a low-HP fight without waiting for guns. Every value is the HP a layer is
**left with**.

- **Values**: HP (a number ≥ 0), a percent of the layer's max (`"40%"`, 0–100; trimmed, `"40 %"` → `"40%"`), or a seeded
  random draw `{ min, max, distribution?, mean?, sd?, mode? }`. A range's amounts share one unit (all HP or all percent;
  a percent `sd` is points of the max), so it validates without a ship. One command mixes HP and percent across layers.
- **Targets**: `shield` / `armor` / `structure` (each named layer set; the others keep their **current** HP; no spill
  between them), or `total` (not with the layers): the HP left across the three, resolved against Σ max, and the deficit
  taken **off a full ship** through `applyLayeredDamage` at unit resonances (shield first, then armor, then structure,
  the damage spill; resists do not apply to an HP amount). From full, not from the current HP, so the same call gives the
  same HP. Rifter (Σ 1,562.5): `"40%"` → 0 / 187.5 / 437.5, `1000` → 0 / 562.5 / 437.5.
- **Above the max**: an HP value or a range bound above a ship's layer max is set to the max (each ship's max differs,
  so not refused), with a `clamped` note (`armor 9999 HP is above its max 562.5: set to 562.5`; a range: `drawn up to`).
- **Draws**: one uniform `u = combatUnit(seed, "hp|<ship>|<target>")` per ship and target (cyrb53, keyed like shot rolls:
  the same in any selection order, however many ships), mapped through the distribution's quantile on the range in HP
  for that ship, then clamped into [min, max]. `uniform`; `triangular` (mode default the middle); `normal` (mean the
  middle, sd range ÷ 4) **truncated by its inverse CDF** (`μ + σ Φ⁻¹(Φ(α) + u (Φ(β) − Φ(α)))`; a range wholly above the
  mean is drawn mirrored for precision), so no draw piles on a bound as clamping would (4.6 % at the default sd). Φ is
  `0.5 erfc(−x/√2)` with Numerical Recipes' Chebyshev erfc (fractional error < 1.2e-7, tails included), Φ⁻¹ Acklam's
  (< 1.2e-9). The seed is the command's `seed`, else the document's combat seed; two calls with one seed reuse a ship's
  `u`. Moments pinned in `distributions.spec.ts` (100,000 keyed draws): normal 10–90 mean 50 / sd 17.59; normal 0–100 at
  μ 70 σ 25 mean 64.72 / sd 20.41; triangular 0–100 mode 80 mean 60.
- **Intent**: `cinematic` (default) never kills: structure the set **writes** (`structure`, or a `total` that drains it)
  is held at `CINEMATIC_MIN_STRUCTURE_HP` (1; `min(1, max)`) with `structure held at 1 HP: a cinematic set never kills`.
  `gameplay` plays EVE's rule: a set that leaves structure at exactly 0 is swept into a kill at the **next boundary**
  (`CombatRules.SweepDestroyed`, right after the recharge, before the calls, locks, repairs and shots; ids sorted), as
  `combat.death` says (explode: `Destroy`, the explosion started at once; flag: recorded, it flies on). A ship in warp
  or still arriving dies once it is out and landed (`mayDie`). Any value above 0 keeps it alive (0.04 HP: a shot ends
  it). Refusing 0 was rejected: it would fail a fleet-wide random set for one ship.
- **Live only**: no document field; a load restores full HP, `remove_ship` drops the HP and the set. After a set the
  normal rules run from the new HP: shields recharge on EVE's curve (from 0: 5 % at 0.0506 τ, 25 % at 0.139 τ; a Rifter
  23.7 s / 65 s), repairs land on it, armor and structure hold until repaired, shot, a load, or a refit through the table
  path (back at full HP, as combat damage); a max change keeps the fraction (`SetDefense`). The hull shows it at once
  (`SyncImpactState`; `rechargeSynced` gets the new shield).
- **Pending**: a ship the damage model does not track yet (its fit or default fit resolving) keeps the set in
  `Director.pendingHp` (a newer set replaces it) and takes it in `SetFlight` right after `SetDefense`; a gameplay death
  still comes from the next sweep. `HpWait` skips a ship that never has HP (`it has no HP: no EVE dogma for its hull`:
  no EVE type, or its type failed). A load clears them; a removal or death drops the ship's. `load_scene` returns once
  default fits resolve, so pending is seen with an EFT fit the hub still resolves.
- **Validation** (`normalizeHpSetCommand`, one `SceneError` with every problem): unknown keys (`hull` hints
  `structure`), no value, `total` with a layer, intent, seed (integer 0 … 2³² − 1), the selection (`readFleetSelection`);
  amounts (negative / non-finite HP, non-percent strings, percents outside 0–100); ranges (unknown key, no min / max,
  mixed units, min > max, unknown distribution, `mean` / `sd` without normal, `mode` without triangular, mean or mode
  outside, sd ≤ 0). The page throws unknown ships, fleets, wings and squads (`selectFleetShips` on the document, as
  engage) and skips destroyed or dead ships (`it was destroyed (a load revives it)`).
- **Result**: `{ tick, intent, seed? (a random set), ships: [{ id, shield | armor | structure: { hp, max, was },
  clamped? }], destroys? ([{ id, mode, note? }]), pending? ([{ id, note }]), skipped }`. `tick` is `world.tick`, the
  boundary to come, so a gameplay kill lands at that tick.
- **get_state**: `defense` (each layer's current and max, unchanged); `hpSet` (omitted until a set since the load):
  `{ state: applied | pending, tick, appliedAt?, intent, seed?, values (as given, normalized), hp? (each target's HP to
  0.1), clamped?, note? }` (only the latest set; `DamageModel` keeps it beside the HP); `destroyed` and `combat.kills`
  carry `cause: "set_hp"` and no `by`, `module`, `weapon`.
- **Files**: `combat/hp-set.ts`, `combat/distributions.ts`, `combat/random.ts` `combatUnit` (above); viewer `damage.ts`
  `SetHp` / `HpSet` / `DestroyedShips` / `HpSetRecord`; `combat.ts` `SweepDestroyed` (onKill's shot is `Maybe`);
  `director.ts` `SetHp`, `ApplyHpSet`, `ApplyPendingHp`, `HpWait`, `HpSetState`, `pendingHp`, `SET_HP_NO_DOGMA`,
  `KillerOf`; `set_hp` joins `JOURNALED_TOOLS`.
- **Verify-page** (2026-10-24, SDE 3632936, headless; `--only set_hp`): Rifter maxes 562.5 / 562.5 / 437.5; `{ shield:
  "0%", armor: 200, structure: "50%" }` → 0 / 200 / 218.8, `total: "40%"` → 0 / 187.5 / 437.5, `armor: 9999` → 562.5
  with the note; cinematic `total: 0` → 0 / 0 / 1; gameplay `structure: 0` killed at the result's tick (cause set_hp, no
  by), `ecx_generic_explosive_short_individual_01b` 1 tick and `_global_01b` 3 ticks later; a flagged set kill flies on;
  a 5-Rifter fleet normal 10–90 % armor: seed 1 [193.1, 178.9, 336.1, 227.5, 339.5] twice, seed 7 [343.3, 266.8, 101,
  264.6, 343.5]; a shield set to 0 read 5.8 HP after 10 boundaries (the curve's 5.758), then a Punisher's first hits
  landed on armor (281.3 → 145); six refusals with their texts and nothing changed; three fitted Slashers pending
  (`loading the fit's dogma`) took the set before the next boundary.
  Full verify-page (2026-10-24, after H2/H3, headless in `--only` batches): 182 ok, 1 skip (SOF audio, no renderer), 1
  FAIL, the warp-in shot's flank-port refusal (it predates set_hp and is filed); `screenshot` needs a renderer; no
  flakes. Checks 73–91 share the TFIs and `flw` fleets, so run them in one batch or they fail.
- **Real GPU** (2026-10-24, H3, Windows Chrome NVIDIA, 1600 × 900; the TFIs at the Jita CNAP with a squad per tier;
  `.scratch/hp-gpu/`). The look, its thresholds and recipes are in sd-cinema → Battle-damaged looks; the overlay counts
  were read over CDP.
  - The same seeded sets re-applied gave every ship the same HP.
  - Hole goals matched `trunc(12 (1 − a) + 4 (1 − s))` and the flicker `clamp01((0.9 − s) / 0.8)` at every 10 %
    structure step.
  - The hull fires (`shipVisualDamage`) light below 100 % structure or 12.3 % armor, and go out 5 s after armor is
    back to 50 % and structure to 100 %.
  - Under fire, a pristine TFI took shield hits (`lastTaken` layer shield, a shield flash). A crippled Bhaalgorn took
    structure hits and died in 10 ticks (`flag`).
  - Two gameplay `structure: 0` sets on TFIs were killed at the result's tick with `cause: "set_hp"`. The long
    explosion started within the next tick, its sound posted with `played: true`:
    - 01a: wreck switch 5.7 s, total 47.7 s;
    - 01c: wreck switch 10.5 s, total 34.5 s.
    The hull hid at the wreck switch, and the ball left at `removesAt`.
  - Throughout: `gpuErrors` 0, `renderer.moduleEffects.failed` 0, and `page_log` info only.
  - Audio, with audio on: `gameObjects − emitters` stayed 1 (the listener) before the sets, and 6 s and 16 s after
    them on burning hulls; `foreign` was absent. During the explosion it was 2 − 1: its emitter and the listener. The
    fire copies stay inert, as with the audio-leak fix.
  - fps: holes cost nothing (28.1 vs 28.2 median healed). 12 burning TFIs took the 44-ship scene to 19.0. One 2 fps
    hitch came when the first fires loaded.

## Damage immunity (`ships[].immune`, `set_immunity`)

Plan: `~/.claude/plans/damage-immunity-and-a-generic-apply-to-fleet-apply-to-scene-targeting-layer.md`. **S1 and S2
are in**: the pure rule, the document field, the op and the command in `packages/scene` (S1); the page's damage model,
`CombatRules.Land`, `Director.SetImmunity`, the `set_immunity` tool and timeline cue, get_state (S2). S3 puts the
selector on every lever, S4 is the real-GPU look.

- **The field**: `ships[].immune?: true | ("shield" | "armor" | "structure")[]` (`ShipImmunity`,
  `combat/immunity.ts`). `true` is every layer; a list is normalized in layer order, deduplicated, case-insensitive,
  and all three becomes `true`. `false`, `null` and `[]` drop the key. `"hull"` is refused with a hint (the hull layer
  is structure).
- **Saved, not live**: a rule of the scene like `combat.death` (it survives a load, an open, a tab reload and a saved
  scene); HP, kills, locks and targets stay live. Edits: `{ op: "set_immunity", <selector without hull or state>,
  immune }` replaces each selected ship's value (`false` deletes; unknown keys warn; composes after an op that adds the
  ships), `update_ship set { immune }` (`null` clears), `remove_ship` takes it. The selector: `sd-selectors`.
- **The rule** (`applyLayeredDamage(layers, damage, immune?)`, `combat/damage.ts`): a layer not immune behaves as
  before. An immune layer **with HP** keeps it and stops the whole hit that reaches it: nothing passes on, and
  `absorbed` is that hit's effective damage at **its** resonances, uncapped by its HP (`absorbedBy` the layer). An
  immune layer **at 0 HP** stops nothing. So `["structure"]` lets shield and armor drain but the ship cannot die,
  `["armor", "structure"]` lets only the shield drop, `true` lets nothing land. Without immunity the result is
  identical to before (no `absorbed` key). Three 100 HP layers, resonances 1, a 150 HP hit:

  | Immune | Taken (S / A / St) | Left | absorbed |
  |---|---|---|---|
  | none, or `["structure"]` | 100 / 50 / 0 | 0 / 50 / 100 | 0 |
  | `["armor"]` | 100 / 0 / 0 | 0 / 100 / 100 | 50 (armor) |
  | `true`, or `["shield"]` | 0 / 0 / 0 | 100 / 100 / 100 | 150 (shield) |
  | `["shield"]`, shield at 0 | 0 / 100 / 50 | 0 / 0 / 50 | 0 |
  | `["shield", "structure"]`, shield at 0 | 0 / 100 / 0 | 0 / 0 / 100 | 50 (structure) |

- **Under fire nothing changes before the hit**: locks, lock times, called targets, turrets, engagements, `overkill`
  and the hit roll run as usual, and a miss never consults immunity. A hit (or a vorton application) that took no HP
  because of immunity reads `result: "immune"` (`ShotResult`), `damage: 0` and `absorbed` (`ShotOutcome.absorbed`);
  one that took some HP keeps its tier and adds `absorbed`. `missed` stays `result === "misses"`, so an immune hit draws
  as a hit, impact and impact sound included. The shooter's `shots` / `hits` count the roll (as `overkill` does);
  `dealt` / `taken` stay HP really taken; the victim gains `combat.absorbed`.
- **Every damage source obeys it**: the page enforces it inside `DamageModel.ApplyHit` (turrets, vortons, missiles,
  all through `CombatRules.Land`, S2); no lever bypasses the damage model. Untouched: repairs, passive shield recharge,
  webs, scrams, points, painters, neuts, nos, transmitters and the ship's own guns.
- **The death rule**: `DamageModel.Destroyed` is false while structure is immune, so neither a shot nor set_hp's sweep
  kills the ship; set_hp's `DestroyedShips` is built on `Destroyed`. Immunity revives nothing: a recorded kill stands,
  and `set_immunity` on a dead ship only writes the document (immune from the next load).
- **set_hp on an immune ship** sets HP as asked in both intents (immunity stops damage, not the director's own sets):
  `set_hp` armor 20 % plus `immune: true` is a battered hero who takes no more. A gameplay set to 0 structure on an
  immune structure leaves the ship alive at 0 (the `destroys` row notes it); once the immunity lifts, the next
  boundary's sweep kills it (`cause: "set_hp"`).
- **Warnings** (`immunityWarning(id, layers)`, for engage and order_fleet targets in S2): `"x" is immune to damage: the
  guns lock, fire and hit, but it takes none`; `"x" cannot be destroyed: its armor and structure are immune (only its
  shield drops)`; `"x" is immune on its armor: hits stop there while it has HP`. A called immune primary is shot for
  ever (no auto-skip: a shot at an immune hero is often the point).
- **The command**: `normalizeImmunityCommand(input, where = "set_immunity")` → `{ <selector>, immune: true | [layers] |
  false }` (`immune` required, `null` lifts; unknown keys are problems): the plain object the tool runs and a timeline
  cue can embed. `toSceneImmunity(scene)` is the id → layers index the page loads on every apply; `sameImmunity`
  compares by layer; `diffScenes` lists kept ships whose immunity changed in `immunity` (no rebuild, no retune).
- **Files**: `combat/immunity.ts` (field, op, command, warning), `combat/damage.ts` (the rule), `combat/accuracy.ts`
  (`immune`), `combat/kill.ts` (`absorbed`), `scene.ts` (`SceneShip.immune`, `SceneDiff.immunity`). Specs:
  `immunity.spec.ts`, `damage.spec.ts` (the table, real resonances, no mutation), `scene.spec.ts` (round trip, diff).

### The page half (S2)

- **`DamageModel`** (`damage.ts`): `SetImmunity(index)` replaces the id → layers index, kept apart from the HP entries
  (a ship is immune before its fit resolves; `Remove`, `Clear` and a refit keep it; a time-control snapshot leaves it
  out as `wiring`: the document is its truth). `Immunity(id)` (`[]` when none). `ApplyHit` passes it to
  `applyLayeredDamage` and returns `absorbed` / `absorbedBy` (omitted when none); `Damage` takes nothing from an immune
  layer with HP; `Destroyed` also needs structure not immune, and `DestroyedShips` (set_hp's sweep) is built on it.
  `SetHp` ignores immunity.
- **`Director.Apply`** calls `damage.SetImmunity(toSceneImmunity(scene))` on every apply, right after the restart block
  (which clears HP) and before the first await. `SimulationChange` counts `diff.immunity` (`"1 ship's immunity"`), so an
  immunity edit cuts the time-control window like any document change.
- **`CombatRules.Land(target, damage)`** (`combat.ts`, private): the one place a hit lands, for turrets, vortons and
  missiles (`ShipOutcome`, `MissileOutcome`). It returns `{ damage, layers, absorbed?, immune }` (`immune`: absorbed > 0
  and nothing taken), or null for a ship the model does not track. `Record` adds `absorbed` to the row and to the
  victim's tally; `Report` gives `absorbed` (omitted at 0). `onDamaged` and the kill check still need damage > 0.
- **`Director.SetImmunity(input)`** (`set_immunity`, `where: page`; the hub's `SLOW_TOOLS`): normalize, then at its turn
  in the edit queue `SelectShips(command)` (sd-selectors), then one `set_immunity` op on the ships whose value changes
  (`sameImmunity`) through `EditNow`, as patch_scene. Returns `{ tick, immune, ships: [{ id, immune, was? (only when
  it changed), destroyed? }], selection? (a filtered selector), warnings? (the op's) }`; an empty selection is `ships:
  []`, not an error. No pilot delay. Not journaled: it is a document edit.
- **Timeline**: `set_immunity` is a cue action of kind `document` (`TIMELINE_ACTIONS`, `selectionEntry` with
  `normalizeImmunityCommand`); `FireCue` runs `ImmunityNow`: the selection resolved at the cue, its op through
  `CueEdit` (the live scene only). A lever given `at` / `when` / `cue` becomes that cue.
- **Warnings**: `Engage` adds `immunityWarning` once for a ship target it armed ships on; `CallWarnings` (order_fleet
  targets) adds one per immune `primary` / `queue` / `set` id. Both read the document's `immune`.
- **set_hp**: a gameplay `destroys` row on an immune structure gets `note: "its structure is immune: it dies once that
  immunity is lifted"`; the sweep skips it until then (`Destroyed`).
- **get_state** per ship: `immune` (the document's, omitted when none), `combat.absorbed`, rows with `absorbed` and
  `result: "immune"`.
- **Files**: `damage.ts`, `combat.ts`, `flight.ts` (`PublishedHull.group`, for the hull filter), `director.ts`
  (`SetImmunity`, `ImmunityNow`, `SelectShips`, `SelectionFacts`, the Apply hook, warnings, get_state); specs
  `damage.spec.ts`, `combat.spec.ts` (immune turret hit, partial absorb keeps its tier, structure immunity never kills
  over 200 hits then a hit after the lift does, vorton and missile read `immune`), `flight.spec.ts`.
- **Verify-page** (S2; in the `combat:` area, `--only immunity` runs them alone): `combat: immunity: immune ships still
  lock and draw fire but take no damage`, `combat: immunity: structure immunity drains shield and armor but the ship
  never dies`, `combat: immunity: set_immunity selects by fleet, role, team, hull and sample, is saved and survives a
  load`. Evidence (2026-10-24, SDE 3646012, headless): two
  Punishers on an immune Rifter at 2 km: 8 shots, 8 hits, `taken` 0, `absorbed` 467.9, every row `immune` within 0.1 of
  the volley through the shield's resists, p1 locked, an impact post on the Rifter; after the lift the shield fell to
  37.7 / 562.5. Three Punishers on a structure-immune Rifter: shield and armor drained by tick 65, structure 437.5 /
  437.5 ten ticks later (absorbed 2645.7), no kill; killed by p2 one tick after the lift. Selections: `fleet b, role
  logi` → g1 (`scoped` 4, `excluded.role` 3); `all, team red, hull Rifter` → r1–r3; `all, hull Frigate, sample { count:
  2, seed: 7 }` → bfc, p2 twice (seed 8: p1, r2); the immunity survived get_scene → load_scene; `team: green` warns
  `(teams there: blue, red)`.

## Stand-in combat (no EVE data)

Without EVE data every ship fights with class values, not dogma (`packages/scene` `combat/stand-ins.ts`,
`STAND_IN_CLASS_COMBAT`; the page's `stand-in-combat.ts`), through the unchanged pipeline.

- **The table** (per class: guns × per shot / cycle, optimal + falloff, tracking, HP shield / armor / structure, lock
  range, scan res, max locks): frigate 3 × 60 / 2 s, 1.5 + 5 km, 300, 500 / 500 / 450, 30 km, 800 mm, 4; destroyer
  6 × 45 / 2.5 s; cruiser 4 × 110 / 3 s, 4 + 8 km, 60, 2,000 × 3, 60 km, 350 mm, 6; battlecruiser 6 × 180 / 4 s;
  battleship 7 × 330 / 4.5 s, 8 + 12 km, 10, 8,500 / 9,000 / 10,000, 100 km, 150 mm; capital and titan rough. Anchored
  on the fixture's max-skills Rifter / Punisher, Ferox and Megathron. Half thermal, half kinetic; EVE's base T1 hull
  resonances on every class; signature resolution 40,000; no capacitor, no missiles, no other modules. The signature
  stays the class flight numbers' (with the MWD bloom). Bands the spec pins: EHP and paper DPS non-decreasing frigate
  to titan, lock range past optimal + falloff, own-class kills at rest in 15–120 s.
- **The class**: `ships[].standIn.class`, else the flight's class (a cruiser: no SOF hull offline). `Director.HullOf`
  gives the live hull, else offline `StandInHullOf` (`ShipHull.shipClass`, which `ShipClassOf` takes first), at the four
  hull reads, so one class drives the flight numbers, the prop mod size, module audio size and the explosion choice.
  The ball stays 100 m (class sizes are the DNA follow-up).
- **The gate**: offline `ResolveFitting` returns `StandInFittingOf` for every ship (fitted or not; key `stand-in`,
  `dogma` null, `standIn` the numbers, `pending` false). `ResolveFlight({ standIn })` puts its `defense` and `targeting`
  on the flight (`math` table), so `DamageModel` tracks it and `ShipLocks` locks with EVE's lock time; `SyncModules`
  gives `StandInModuleSpecsOf`. `IsFitResolved` (dogma or stand-in) replaced the `resolved?.dogma` gates in
  `switch_modules`, `engage`, `cease_fire`, `ArmWeapons` and auto-repair's condition. `set_hp`, free fire, the FC
  brain's `FleetReachNumbers`, kills, succession and get_state's fit rows (`math: stand-in`) follow.
- **Death**: `Destroy` chooses the explosion (timing from the captured constants: `removesAt` as with EVE data) but
  loads no file offline; `DriveExplosions` schedules at once with `facts: null` and `hideAfter: STAND_IN_DEATH_SECONDS`
  (1 s: the pop, `sd-runtime` → Stand-ins). `eveData.refused` stays 0 through locks, shots, kills and removals.
- **Determinism**: the numbers are a pure function of the document, resolved synchronously (no `SimInput`, nothing
  pending); shots use the keyed RNG with stable `high-<n>` keys. verify-page `--eve-data off` (2026-10-24): a lock in
  6.331 s and a kill by `h1:high-2` in 14 ticks for seed 1 (twice), `h2:high-1` for seed 2; two loads at rate 4 kill
  red-1 / red-2 / red-3 at +13 / +20 / +24 ticks from the first blue decision both times; a jump back replays the kill
  at the same tick with no drift. After a lent call's target dies the fleet's queue (not a new brain decision) carries
  the call on.

## Tools

- **`ship_stats`** (K1): turret rows in `fit.modules` carry `damage` (per shot by type, before quality), `volley`,
  `dps`, `tracking`, `signatureResolution`, and `explosion` / `spool`; launcher rows (missiles M1) `damage` (per
  missile), `volley`, `dps`, `velocity`, `flightTime`, `missileRange { lower, upper, upperChance, mean }` (m; `range`
  stays a turret's optimal), `explosion { radius, velocity, drf }` and the charge `note` (`loaded from cargo`, `default
  missile`, or `NO_MISSILE_NOTE`); `stats`, `withPropMod` and `withActive.stats` carry `weapons: { turrets, launchers,
  volley, dps, damage }` (DPS by type; a siege module in `active` raises it). Spec:
  `ship-stats-tool.spec.ts` (a default-fit Rifter text gives the table's numbers; a TFI's empty guns load Barrage L).
- **`patch_scene`**: `set_combat`, `set_immunity` (Damage immunity).
- **`set_immunity`**: Damage immunity → The page half.
- **`set_target`** starts the lock (its answer's `lock`: `{ state, lockTime?, readyIn?, note? }` or `{ refused }`); a
  null target ends the ship's engagement. **`switch_modules`** turrets wait for the lock on the ship's target; remote
  repairers for the lock on the switch's target (`SwitchModules` asks for it).
- **`engage`** `{ selection, target, modules? }`: the target becomes each ship's target and its lock starts, the
  matching weapons (default turrets and launchers) switch active (they wait for the lock), and the engagement keeps
  them firing (`Engagements`). It
  ends on `cease_fire`, `set_target` null, removal or a load, and survives the target's death. Skipped: itself, in
  warp, target in warp, destroyed, fit unresolved, no targeting numbers, no matching weapon ("it fits no weapon matching …"). A `warning` when shooter
  and target share a team (no hostility check), and one when the target is immune (Damage immunity).
- **`cease_fire`** `{ selection, unlock? }`: ends the engagement, its weapons switch online (cycle end; missiles in flight fly on); `unlock` also
  clears the target (the sweep drops the lock).
- **get_state** per ship: `targeting` `{ scanResolution, maxTargetRange, maxLocks }`, `locks`, `engaged`, `combat`
  `{ dealt, taken, dps: { dealt, taken }, shots, hits, misses, lastHits, lastTaken, absorbed?, paperDps, repairs? }` (once it
  fired, was shot or was repaired), `destroyed` `{ tick, by, module, weapon, mode }`; weapon rows `combat` `{ damage,
  volley, dps }` and the lock note while held; scene `combat` `{ seed, death, shots, hits, repaired, kills }`.
- **`set_hp`**: Battle damage, above.
- **`Director.OnKill(listener)`**: for the fleet targeting lever and the automatic camera.

## Snapshot in time control (`sd-time`)

Across a jump, an explosion that started before the landing and whose hull still shows replays from its start at the
landing (`ExplosionReplays`: drawn, or its headless sounds posted again; the ball leaves at the same tick), one past its
wreck switch stays hidden, and ships destroyed after the landing are drawn again (`sd-time` → Effects across a jump).

Time control's snapshots (`Director.CaptureSim`, `sd-time`) hold all of it, and a jump back replays the same fight (verify-page `time:`: the same kill tick, killer and module, no drift). Plain data in its owners: `ShipLocks` (locks, keeps), `DamageModel` (HP), `CombatRules` (tallies with the repair
tallies, kills, destroyed, spools, the scene's repaired total), a remote repairer's pending `retarget`, the
`ModuleCycle` activation counters, `Director.engagements`, `set_hp`'s records (in `DamageModel`) and
`Director.pendingHp` (sets waiting for a fit; `set_hp` is journaled, so a jump back replays it at its tick), `AutoRepair` (owned modules with the target asked, incumbent
targets with their since tick, manual marks, pending adoptions, last resolved settings, pre-locks; `sd-logi`),
`FleetTargets` (own marks, called targets, holds, responses,
the last calls and primaries: `sd-fleets` doc `targets`), the live call book `FleetCommanders` (group key → list, free fire, acting commanders, and each personality fleet's
brain: gate `since` / `readyAt`, memory, refusals, manual levers, `held`, handover, leaderless, the unsettled-since
ticks; the trait book is derived from the document), and
`Director.deaths` (kill, explosion choice, start, hidden, `removeTick`, gone), `DestinyWorld`'s missile entries and
balls, and `MissileFlights` (the drawn missiles replay from the flights). The RNG is the document's seed, so a
re-simulation rolls the same; explosions re-trigger from their kills' times. Missiles add no randomness.

## Seams

- Fleet targeting lever (built, `sd-fleets` doc `targets`): `SetShipTarget(…, { requestedAt })` for called primaries;
  `Engagements` arms `FleetTargets.Armed()` like an engagement; pre-locks join `WantedLocks` under `maxLocks` (not
  `ShipLocks.Keep`: sticky, and at the limit it can block the primary's own lock); the move-on is the boundary sync
  before the lock sweep (not `OnKill`, which runs inside `Shots` and would re-enter ShipModules for no earlier first
  shot); `Director.OnPrimary(listener)` reports each group's primary change for the automatic camera.
- Logi auto-repair (built, `sd-logi` The page half): the `AutoRepair` controller's port reads `DamageModel.Health(id)`,
  `CombatRules.TakenSince(id, boundary, REPAIR_PRESSURE_SECONDS)` (pressure: every shot through `Resolve`, missiles
  included), `ShipLocks.Lockers(target)` (yellow boxes: outside the fleet and team), `ShipModules.RemoteRepairers(id)`
  and `Incoming(id)`, and switches through `ShipModules.Switch` with `retarget`. It runs in the boundary listener after
  `SyncFleetTargets` and before the lock sweep; its landings are tallied by `RecordRepair` as manual reps are.
- Battle damage: `OnKill` listeners get `shot: null` and `kill.cause: "set_hp"` for a set kill (the camera director and
  the timeline's kill events already take a kill without `by`). A timeline beat embeds `normalizeHpSetCommand`'s plain
  object and calls `Director.SetHp` (not wired yet: `set_hp` is no timeline action).
- Damage immunity (built): every hit lands through one `CombatRules.Land(target, damage)` helper over
  `DamageModel.ApplyHit`, so turrets, vortons and missiles all read `result: "immune"` and `absorbed`; a new damage
  source must land there too.
- Missiles (M2a and M2b in: Missiles in the page): hits are `WeaponShot`s with `missile` through `Resolve` and the shared
  `applyLayeredDamage`, wired (M2b: Missiles in the page → The wiring); hits reach `OnShot` with `missile` set, kills
  `OnKill`; no launch hook yet.

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
`a moving FC dies and its fleet flies on: the heir inherits its order` (added 2026-10-23; result below),
`load_scene revives the dead`. Evidence (2026-10-23, SDE 3632936, headless): Rifter killed by p2 15 ticks after
`engage`; the orbiter `stopped: target "rifter" was destroyed`; `order_ship` refused; posted
`ecx_generic_explosive_short_individual_01b_play` and `..._global_01b_play`; the ball gone at tick 85 (removesAt 84),
`audio.gameObjects − emitters` 1 before and after. Fleet: the lead dead at tick 21, the squad anchors on the wing
commander; the FC dead at tick 39, the wing commander acts for it and the member follows it. A load: 6 ships alive at
full HP, no kills, the FC back.

**Re-run 2026-10-23 on dbxpc** (SDE 3646012, headless) for the fleet-personalities S8 regression, the whole suite: 158
ok, 1 skip (`SOF ships' own audio emitters stay inert`: no renderer), 1 FAIL outside combat (`warp-in: the warp-in
shot anchors at an arriving fleet's landing ...`, a cinema check: the refusal note needs every ship of the group still
arriving, and its FC now lands before the shot; filed). K2's and K3's checks give the numbers above (lock 2.617 s; 16 /
16 hits, dealt 803.1 = taken 803.1; 11 of 12 missed at 20,085 m; seed 1 twice 40 shots, the kill 15 ticks after
`engage`; the load revives 6 ships). The moving-FC check first failed on its own assertion: it compared the heir's
speed with its catch-up speed in its slot (wc 295 m/s), but an heir inheriting `direction` at 0.5 slows to the
fleet's speed, the FC's. It now floors at the slower of the two (a halt keeps about a third after 5 ticks): `FC dead at
tick 493; wc flies direction [1,0,0] at 0.5, 228.2 m/s (295.2 before, the FC at 221.8, slowest 228.2)`; run alone,
`FC dead at tick 23; 216.4 m/s (188.9 before, the FC at 221.7, slowest 196.6)`. The four `called` checks and
free fire: `sd-fleets` doc `targets`; the personality check: `sd-personalities`.

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
