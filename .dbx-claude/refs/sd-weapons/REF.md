# Weapons: turrets on every ship, default guns and missiles, slots, charges, the weapon and missile routes

> Fetch before touching `packages/scene/src/lib/weapons/`, a fit's weapon modules or charges, the hub's `/weapon` or
> `/missile` route (`hub/weapon-data.ts`), or anything that mounts, aims or fires turrets or launchers on the page. The typed fit, dogma and
> the activation layer the guns ride on: `sd-fittings`; the runtime classes: `sd-runtime`.

**Status (2026-10-23)**: the turrets plan
(`~/.claude/plans/turrets-on-every-ship-mount-from-the-parsed-fit-target-fire-on-the-weapon-cycle.md`) lands in four
slices. **W1 is in**: the runtime-free half in `packages/scene` (default weapons, turret slots, charges, the weapon
graphic) and the hub's `/weapon` route. **W2 is in**: the page's default fit, cargo charges, `WeaponLookup` and
mounting (`ShipTurrets`). **W3 is in**: `set_target`, turrets firing on the weapon cycle through `switch_modules`, the
`Director.OnShot` hook, the cycle-exact draw and impacts. **W4 is in**: turret sounds (below); the plan is delivered.
**Missiles** (`~/.claude/plans/missiles-launchers-fire-destiny-pursued-evemissiles-that-hit-through-eve-s-missi.md`):
**M1 is in** (default missiles, launcher charges, the `/missile` route; the numbers: `sd-combat` → Missiles); **M2a is
in** (Destiny missile balls, the flight book, missile hits and expiry rows: `sd-destiny` → Missile balls, `sd-combat` →
Missiles in the page); **M2b is in** (2026-10-23: launchers run and the page fires them, headless: Launchers fire,
below); **M3 is in** (2026-10-23: missiles draw, fly and detonate with the client's effects, checked on the real GPU:
Launchers fire, drawn, below); the plan is delivered. Research: the dbx-claude notes `turrets-runtime-pipeline-research` and
`scene-director-locations-objects-turrets-research`.

## Files

| File | Role |
|---|---|
| `weapons/default-weapons.ts` | `WEAPON_FAMILIES`, `DEFAULT_TURRETS`, `DEFAULT_LAUNCHERS`, `RACE_WEAPON_FAMILIES`, `SOF_RACE_WEAPON_FAMILIES`, `ATTACK_BATTLECRUISER_GROUP`, `DEFAULT_WEAPONS_FIT_NAME`, `weaponFamilyOf`, `weaponSizeOf`, `defaultWeaponsOf` |
| `weapons/slots.ts` | `CLASSIC_TURRET_LOCATOR`, `TURRET_LOCATOR_COLLECTIONS`, `MAX_TURRET_SLOT`, `turretLocatorSlots`, `assignTurretSlots` |
| `weapons/graphic.ts` | `WeaponGraphic`, `WEAPON_SLOTS`, `readWeaponGraphic`; `MissileGraphic`, `readMissileGraphic` (the page reads the hub's answers through them) |
| `weapons/charges.ts` | `CHARGE_GROUP_ATTRIBUTES`, `CHARGE_SIZE_ATTRIBUTE`, `chargeFitsModule`, `loadCargoCharges` (`defaultMissile` option), `ChargedModule`, `DEFAULT_MISSILE_LOADED` |
| `weapons/default-missiles.ts` | `DEFAULT_MISSILES`, `RACE_MISSILE_DAMAGE_TYPES`, `SOF_RACE_MISSILE_DAMAGE_TYPES`, `missileDamageTypeOf`, `defaultMissileOf`, `isMissileCharge` |
| `weapons/fixtures/missiles-3632936.json` | `{ ammunition: { <launcher>: rows }, projectiles: { <graphicID>: record } }` for launchers 2404, 2410, 19739, 1877, 25715 (rows trimmed to typeID, name, groupID, graphicID, graphicRole, resPath, projectileGraphicID) and projectiles 21934, 21936, 21937, 21938 |
| `weapons/fixtures/weapons-3632936.json` | tools-core's `weapons/types/<id>` records for every default weapon, captured live; specs read it from disk, never the package |
| `fitting/categories.ts` | `WEAPON_KIND_EFFECTS` (42 turret, 40 launcher), `weaponKindOf`; `typeEftFit` sets `FittedModule.weapon` when the bundle has the module's effects |
| `apps/scene-director/src/lib/hub/weapon-data.ts` | `WeaponData` (`Weapon(typeID)`) over `SdeClient`, cached per hub |
| `hub/weapon-data.testing.ts` | `WeaponRoutes` (weapons, ammunition, projectiles), `MissileFixture`, `MakeRoutedWeaponData`, `MakeFakeWeaponData` over the captured records |
| `apps/viewer/src/lib/weapon-lookup.ts` | `WeaponLookup`: the page's `/weapon` lookups (node-tested) |
| `apps/viewer/src/lib/turret-plan.ts` | `TurretMountsOf`, `TurretMountsKey`, `HighIndexOf`, `TurretFiles`, `TurretFileFacts`, the mount report types (node-tested) |
| `apps/viewer/src/lib/turrets.ts` | `ShipTurrets` (runtime): mount, remount, the animated-hull rebind, report |
| `weapons/target.ts` | `normalizeTargetCommand` (`set_target`), `CELESTIAL_TARGET_REFUSAL` |
| `weapons/shots.ts` | `WeaponShot` (the Combat rules hook's event), `ShotTargetKind` |
| `apps/viewer/src/lib/targets.ts` | `ShipTargets`: each ship's target, cleared on removal, warp and load (node-tested) |
| `apps/viewer/src/lib/shots.ts` | `WeaponShotsOf`, `ShotQueue`: shots from cycle events, the cycle-exact draw time, counts, settle (node-tested) |
| `apps/viewer/src/lib/missile-lookup.ts` | `MissileLookup`, `MISSILE_LOOKUP_TIMEOUT_MS`, `MISSILE_LOOKUP_RETRY_DELAYS_MS`: the page's `/missile` lookups (node-tested) |
| `apps/viewer/src/lib/missile-plan.ts` | `MissileFileFacts`, `MissileFiles`, `MissileDrawPlan`, `MISSILES_LIVE_MAX` (256), `MISSILE_IMPACTS_LIVE_MAX` (64), `MISSILE_FALLBACK_TICKS` (2), `MISSILE_IMPACT_DEFAULT_DURATION` (6 s): the drawn missiles' files and schedule (node-tested) |
| `apps/viewer/src/lib/missile-effects.ts` | `ShipMissiles` (runtime): pooled `EveMissile` / impact roots, launch, arrive, vanish, detonate, `renderer.missiles` |
| `apps/viewer/src/lib/turret-audio.ts` | `TurretAudioPosts`, `TurretSoundQueue`: which emitter posts which turret sound when (node-tested) |
| `apps/viewer/src/lib/fittings.ts` / `director.ts` | the default-fit fallback and cargo charges (`ResolveShipFitting`); `DefaultWeaponsOf`, `SyncTurrets`, `WeaponMount`, `SetTarget`, `OnShot`, `SyncImpactState`, `DriveTurrets` |

## Default weapons (`defaultWeaponsOf`)

A ship without `fit` gets a default fit (W2 wires it on the page; never written to the document). A ship **with** a
fit carries its fit's weapons and nothing else: a logi fit without guns, or `[Hull, Bare]`, has none.

- **Input**: the hull's dogma record (name, `groupID`, `raceID`, attributes), the DNA's SOF race and the SOF class's rig
  size as fallbacks.
- **Family**: the SDE `raceID` (1 rail, 2 projectile, 4 laser, 8 blaster, 135 disintegrator, 168 vorton; pirate hulls
  carry their primary race), else the DNA race (amarr / sansha / bloodraider laser, caldari / guristas rail, gallente /
  serpentis blaster, minmatar / angel projectile, triglavian disintegrator, concord vorton), else projectile.
- **Size**: rigSize 1547 (1 S, 2 M, 3 L, 4 XL); attack battlecruisers (group 1201) L; else the class's rig size; else S.
- **Count**: one turret per turret hardpoint (102), at most the high slots (14). With no turret hardpoints but launcher
  hardpoints (101): launchers (Light / Heavy / Cruise Missile Launcher II, no XL), each loaded with the race's Tech I
  light / heavy / cruise missile (`DEFAULT_LAUNCHER_MISSILE_GROUPS`, Default missiles below):
  `Heavy Missile Launcher II, Scourge Heavy Missile`. Launchers are refused activation until missiles M2. Neither: no
  fit, note `<hull> has no weapon hardpoints`. A family with no gun of the size (XL
  vorton) gives no fit and a note. Hulls with both kinds (Raven, Typhoon) get turrets only.

| Family | S | M | L | XL | Charge |
|---|---|---|---|---|---|
| projectile | 200mm AutoCannon II | 425mm AutoCannon II | 800mm Repeating Cannon II | Hexa 2500mm Repeating Cannon II | EMP S / M / L / XL |
| laser | Small Focused Pulse Laser II | Heavy Pulse Laser II | Mega Pulse Laser II | Dual Giga Pulse Laser II | Multifrequency S / M / L / XL |
| rail | 150mm Railgun II | 250mm Railgun II | 425mm Railgun II | Dual 1000mm Railgun II | Antimatter Charge S / M / L / XL |
| blaster | Light Neutron Blaster II | Heavy Neutron Blaster II | Neutron Blaster Cannon II | Ion Siege Blaster II | Antimatter Charge S / M / L / XL |
| disintegrator | Light Entropic Disintegrator II | Heavy Entropic Disintegrator II | Supratidal Entropic Disintegrator II | Ultratidal Entropic Disintegrator I | Baryon Exotic Plasma S / M / L / XL |
| vorton | Small Vorton Projector II | Medium Vorton Projector II | Large Vorton Projector II | none | ElectroPunch Ultra S / M / L |

Type ids are in the tables (`DEFAULT_TURRETS`); the spec checks every name resolves to its id. The text is EFT with
empty low and mid sections, so its lines key `high-0…` before the names resolve:

```text
[Rifter, Default weapons]
[Empty Low slot]

[Empty Med slot]

200mm AutoCannon II, EMP S
200mm AutoCannon II, EMP S
200mm AutoCannon II, EMP S
```

Fixture check (`default-weapons.spec.ts`): Rifter 3 × 200mm AutoCannon II, Punisher 4 × Small Focused Pulse Laser II,
Ferox 6 × 250mm Railgun II, Megathron 7 × Neutron Blaster Cannon II, Tornado 8 × 800mm Repeating Cannon II, Revelation
3 × Dual Giga Pulse Laser II, Caracal 5 × Heavy Missile Launcher II with Scourge Heavy Missile, Kestrel 4 × Light
Missile Launcher II with Scourge Light Missile, Drake 6 × Heavy Missile Launcher II with Scourge Heavy Missile, Vedmak
1 × Heavy Entropic Disintegrator II, Stormbringer 1 × Medium Vorton Projector II, Apostle none.

### On the page (W2)

- `Director.DefaultWeaponsOf(doc, answer)` runs `defaultWeaponsOf` over the hull's dogma record (the bundle's
  `types[<hull type>]`) with the DNA's race, memoized per (hull type, race); null for a ship with a fit, without the
  hull's EVE type, or while the hull's dogma is pending. `ResolveFitting` passes its text as `ResolveShipFitting`'s
  `fallback: { text, key: 'default' }` (`sd-fittings`), so the default fit runs the whole pipeline: typed fit,
  `WithPropMod` (the document's prop mod, the hull-sized MWD by default, joins as `mid-0`), cargo charges, dogma,
  activation specs, get_state rows and `switch_modules` (turrets are still refused activation until W3).
- `LookupFit` first asks `LookupTypes([hull])` for an unfitted ship and retunes when it lands, then prepares the
  default text's names like a document fit.
- get_state: `fit.key: 'default'` with `default: true`; `fit: null` with `fitNote` when there is none (no EVE type, no
  weapon hardpoints, the hull's dogma failed or still loading). A ship that gains a `fit` drops the default at once.

## Mounting (W2)

- **`WeaponLookup`**: one `GET /weapon?type=` per weapon type per page session, retried after 1 s / 3 s on no answer,
  502, 503, 504; failures kept until `ForgetFailures` (every load / open). A landing graphic syncs every ship.
- **`TurretMountsOf(resolved, graphicOf)`**: one mount per weapon module (`weapon` set) with a type and a graphic,
  offline ones included, high slots by index first: `{ key, typeID, name, kind, resPath, faction, highIndex }`.
  `TurretMountsKey` changes with them.
- **`TurretFiles`**: the turret `.black` and its firing effect as values, once per path (`ResourceValues`); the facts
  read off them (`TurretFileFacts`): `locatorName`, `firingEffectResPath`, the deploy / pack movement events, the
  firing effect's sound curves (`PlayTurretFX` → `fireEvents`, `PlayTurretImpact` → `impactEvents`). A failed effect
  only sets `fxError` (the set mounts without one).
- **`ShipTurrets.Sync(id, ship, dna, mounts)`** (`Director.SyncTurrets`, after a build and every `SetFlight`): when the
  hull object, the DNA or the mounts key changed, every set comes off and fresh ones mount: load the files, assign
  slots over `ship.locators` names (+ bones), hydrate set and effect detached with their audio cut (`sd-runtime`), set
  `slotNumber`, `FreezeHighDetailLOD()` (unless `?turretlod=on`), paint (`SetupTurretMaterial`: the graphic's faction,
  else the ship's DNA), then, if nothing changed meanwhile, state IDLE, `addChild(… { listNotify: ship })` in mount
  order and `StartControllers()`. `Frame` (`Director.DriveTurrets`, each frame) rebinds an animated hull's sets once
  its bones load. `Remove(id)` on retire, before `RetireShips`.
- **get_state**: each weapon row's `mount: { locator, state: loading | mounted | failed | unplaced, models?, error? }`
  (with a renderer only; `loading` while the graphic is pending, `failed` with the hub's note when the type has none);
  `renderer.turrets: { sets, loading, failed, unplaced, errors }` (the 5 latest errors, each also a `console.warn`).
- **verify-page** (headless, 2026-10-23): "an unfitted ship gets default guns sized for its hull and race" (a Rifter
  3 × 200mm AutoCannon II with EMP S, a `type: 'Punisher'` 4 × Small Focused Pulse Laser II with Multifrequency S, both
  `key: 'default'` on dogma with a `mid-0` prop row; the Rifter flies `ship_stats`' numbers), "a fit's guns load their
  charges from cargo" (`tfis-fc`'s six cannons: Barrage L), "a fit without guns gets no default guns" (the modules
  scene's logi and bare TFI).

### Real-GPU evidence: mounting (2026-10-23, Windows Chrome, RTX 40 series, SDE 3632936)

Own hub on 5521; artifacts in `.scratch/turrets-gpu/` on dbxpc. Scene: unfitted Rifter, Punisher, Ferox, Megathron,
Apocalypse, Tornado, Revelation and Caracal (`add_ships` by hull name), then the TFIs fleet and 20 Rifters.

- **Every set mounted**: 8 hulls → 44 sets, then 72 ships → 241 sets; 0 failed, 0 unplaced, `gpuErrors` 0, no
  `console.warn`. Default fits as the table says (the Tornado 8 × 800mm, EMP L; the Megathron 7 × Neutron Blaster
  Cannon II, Antimatter Charge L; the Ferox 6 × 250mm Railgun II); every ship on dogma.
- **Slots**: classic sets on `locator_turret_<high slot + 1>`, two models each (the Rifter's slot 1 three: a, b, c);
  the Revelation's Dual Giga Pulse Lasers on `locator_xl_1-3`; the Caracal's launchers report `locator_turret_1-5`
  (its hull has no launcher locators, so the engine and `assignTurretSlots` both fall back to the classic slots); the
  TFI's interleaved cannons on `locator_turret_1, 2, 4, 5, 7, 8` with Barrage L from cargo.
- **Drawn**: in a probe every set held `models` turrets, geometry loaded at LOD 3 (disabled, frozen), its firing effect
  set, state IDLE, each turret placed inside its hull's bounding radius and `visible` on screen. A display A/B on the
  Punisher at 55 m shows the four pulse lasers on its upper hull, gone with the sets hidden (`punisher-on.jpeg` /
  `-off.jpeg`); on the Apocalypse at 900 m the guns are too small against the 775 m hull to tell apart (set radius
  13.5 m). The animated hulls (Rifter, Revelation, Caracal) rebound to their bones (`bonesBound`).
- **Audio**: `audio.gameObjects` was the same with every set mounted, all removed, and remounted fresh (2, with 0 page
  emitters; the baseline does not come from turrets).
- **Remount**: removing every ship's sets and syncing again mounted all 241 afresh.
- **Cost** (fleet view, 72 ships at ~12 km, 241 sets): frozen LOD 17.1 fps with turrets vs 21.3 without; `?turretlod=on`
  10.6 vs 26.8 (every set at LOD 1, 504 turret models drawn): the runtime's LOD is the slower one here, so frozen high
  detail stays the default (follow-up: turret LOD for large fleets).

## Targets and firing (W3)

**A ship's target** (`ShipTargets`, `Director.targets`) is live state, never in the document: a ship or an authored
object (a document object with a Destiny ball). `celestial:<id>` is refused (`normalizeTargetCommand` and
`switch_modules`; follow-up). Cleared: on load; when the target ship or object is removed ("its target is gone"); when
either ship enters warp (EVE breaks the lock). `set_target` also starts the ship's lock (`ShipLocks`, `sd-combat`):
turrets fire only at a locked target. No hostility check, and no pilot delay on `set_target` itself.

- **Own or called.** A target from `set_target`, `engage` or `switch_modules` is the ship's **own**; a fleet member
  without one takes its group's **called** primary (`order_fleet` targets, `FleetTargets`; `sd-fleets` doc `targets`),
  whose turrets are kept firing like an engagement. An own target wins until it clears; get_state `target.source` says
  which. A targets order's `delay` staggers each member's switch to the new call (it keeps shooting what it shot until
  its response tick); kills, removals and patches move members on at once.

- **`set_target { ships | fleet [, wing | squad], target | null }`** (page tool, `Director.SetTarget`): an unknown
  target is a SceneError; skipped with a reason: the target ship itself, a ship in warp, a target in warp. Returns
  `{ tick, target, ships: [{ id, target, previous?, turrets, retargeted, lock? }], skipped }` (`retargeted`: its running
  turrets that follow the change; `lock`: its lock on the target, or `{ refused }`).
- **Activation**: `moduleActivationOf` lets turrets (`weapon: 'turret'`) run: targeted, `reach` Infinity (EVE refuses
  no turret by range: it waits for its lock, and shots past falloff miss: `sd-combat`), rate of fire = the dogma `speed` with skills. Launchers
  run too (Launchers fire, below). Selectors `turret` / `launcher`.
- **`switch_modules` on turrets**: a given `target` becomes the ship's target first (as `set_target`, and it may be an
  object); without one, the ship's target; neither: "it needs a target: set_target or switch_modules target". Other
  targeted modules still need an explicit ship target. Every existing rule holds (no activation in warp, a stop at
  once when the target goes or warps, a stop on entering warp, reactivation delay, group limits, pilot delay).
- **Retarget** (`ShipModules.Retarget`, from `SetShipTarget`): a running turret takes a new target at its first cycle
  start once that target is locked (it keeps firing at the old, still-locked one until then; row `nextTarget`; the cycle `end` event keeps the old target, the `cycle` event carries the new);
  a starting one at once; null stops it at its cycle end ("its target was cleared").

### Shots: the Combat rules hook and the cadence

> What the hook feeds (locks, the hit roll, damage, kills): `sd-combat`. Its runtime-free rules (hit chance, damage
> roll, layered damage, lock time, the keyed RNG, each turret's combat numbers) are in `packages/scene/src/lib/combat/`.

- Every turret `cycle` event with a target becomes a `WeaponShot` (`WeaponShotsOf`): `{ ship, module, typeID, name,
  charge?, target, targetKind, cycle, tick, at, distance, effectiveness, missed? }`; `at` is the cycle's exact
  fractional master tick (`ModuleCycle` events carry it), `effectiveness` the falloff half of EVE's hit chance.
- **`Director.OnShot(listener)`** returns an unsubscribe. Listeners run at the boundary, in registration order (a
  throwing one is logged), before the shot draws. Combat rules (`CombatRules.Resolve`, `sd-combat`) runs before them:
  every shot arrives with `missed`, `outcome` and, on a kill, `fatal`, and `SyncImpactState` follows the damage.
- **Drawing** (`ShotQueue`): a shot draws at scene clock T(boundary) + (at + 1 − tick) ticks, so a 1.8 s gun fires every
  1.8 s on screen and every draw follows its boundary event. Dropped at draw time when its shooter or target is gone,
  either is in warp, or its set is not mounted. Otherwise `ShipTurrets.Fire`: `SetTargetObject` on the shot's own
  target (a queued shot of an old target still draws there), `SetShotMissed(missed)`, `EnterStateFiring()`.
- **Settle**: after a turret's `off`, its set returns to TARGETING (or IDLE without a target) once its queued shots
  drew and its last burst ran (`fx.GetFiringDuration()` after the draw). `Director.Shots` queues a boundary's shots
  (`ShotQueue.Add`) **before** `combat.Resolve`: a kill in Resolve stops the guns on the victim (`shots.Off`), and an
  `Add` after it cleared those stops (a weapon that fires again is not stopped), leaving every set that shot the victim
  FIRING on the dead hull (`aim: firing`, `renderer.turrets.firing` stuck) once no target followed. Found and fixed in
  the fleet targeting T3 GPU check (2026-10-23).
- The queue, the counts and `OnShot` run without a renderer too (headless shot counts; W4's sounds).
- **Shots at a dying ship** (death `explode`, `sd-combat`): the boundary's shots after the killing one are `overkill`
  and still draw; every target on it clears, so no later shots are raised. Queued shots at it keep drawing (its ball
  stays) until its explosion's wreck switch hides the hull, when `shots.Forget(id)` drops the rest. The killing shot's
  burst start (its draw plus the set's firing delay) starts the explosion.

### The turret state machine (`ShipTurrets`)

- `Aim(id, target)`: the ship's sets `SetTargetObject(<drawn target>)` + `EnterStateTargeting()`; null:
  `target.SetTargetable(null)` + `EnterStateIdle()` (`SetTargetObject(null)` does nothing). Sets mid-burst keep FIRING.
- `Frame()` (each frame, `DriveTurrets`): re-aims a set whose target's drawn object changed (a rebuilt hull, a target
  that finished building, a fresh remount). The aim survives a rebuild (`Remove` keeps it; `Aim(id, null)` forgets it).
- `Fire` / `Settle` above; `MountOf` reports `aim: idle | targeting | firing`; `Report` adds `targeting`, `firing` and
  `bursts`.

### Impacts

`Director.SyncImpactState(id)` calls the drawn hull's or object's `SetImpactDamageState(shield, armor, hull)` with the
damage model's remaining fractions (`DamageModel.Fractions`; (1, 1, 1) without one): at full HP, shield impacts. It
runs after a ship's build, an object's build and repairs landing; Combat rules calls it after damage. The impacts
themselves are the runtime's (the firing effect calls the target's `CreateImpact`); a miss skips them.

### Real-GPU evidence: firing (2026-10-23, Windows Chrome, RTX 40 series, SDE 3632936)

Own hub on 5521; screenshots `w3-*.jpeg` in `.scratch/turrets-gpu/` on dbxpc. `stage_engagement` at 6 km: red Rifter
× 3, Ferox × 2, Megathron; blue Punisher × 3, Tornado, Apocalypse, Revelation (all default guns); then a TFIs-fit TFI
and a Caracal, `set_target` per fleet on the other's FC, `switch_modules { modules: ['turret'], state: 'active' }` per
fleet, a Punisher ordered to orbit the TFI at 2 km with the TFI on it.

- **Every family draws**: autocannon muzzle flashes (Rifter), 800mm tracers with impact flares (TFI), 250mm rail
  tracers (Ferox), blaster bolts (Megathron), small and Mega pulse beams, the Revelation's Dual Giga Pulse beam; the
  TFI's tracers keep landing on the Punisher orbiting it. Shield impacts glow on the hit hulls (a Megathron under another's blasters).
- **Numbers**: 16 ships, 84 sets, 0 failed; 79 firing (the Caracal's 5 launchers stay out: "it fits no module matching
  it" for `turret`); 7,527 bursts by the end; 57-60 fps with verify-page and the test suites running on the same box;
  `gpuErrors` 0; no page warnings; `audio.gameObjects` 1 (the listener), unchanged by the firing.
- **An Astrahus** (`add_objects` 8 km off the red FC: its 45 km SDE ball radius, `sofRadius` 21.9 km, so the drawn hull
  is ~30 km off): the red fleet's sets aim and fire on its damage locators (end points on its near face), but no hit
  shows on it. Its `impactOverlay` has no shield mesh (`mesh` null, `shieldIsEllipsoid` false) where a ship's has one,
  so full-shield hits likely have nothing to draw on (follow-up).

### get_state and tools

- Per ship: `target: { id, kind: ship | object, distance } | null`, `shots` (since the load, omitted at 0); weapon rows
  `cycleTime` (s, while running), `nextTarget`, `mount.aim`; `renderer.turrets` `targeting`, `firing`, `bursts`.
- `ship_stats` fit rows carry `cycleTime`, `range` and `falloff` (`moduleNumbersOf` on the evaluated ship).
- verify-page (headless, 2026-10-23): "set_target aims and switch_modules fires turrets on their cycle" (a default
  Rifter's three guns: `cycleTime` equals ship_stats', shots over 12 s ≈ 3 × elapsed / cycleTime, none after the
  stop; the scene gives the ship `type: 'Rifter'` and its `mf4_t1` DNA: a DNA-only ship flies the lowest type id on its
  hull, and the `mf1_t1` the older checks use is the Slasher's, with other traits), "weapons follow a new target and stop when it is cleared", "a removed or warping target clears and stops the
  guns", "turrets fire at an object" (an Astrahus; a celestial refused), "turrets are not refused by range" (150 km,
  effectiveness 0). The launcher checks: Launchers fire, below.

## Launchers fire (missiles M2b, headless; drawn: next section)

- **Activation** (`moduleActivationOf`, `sd-fittings`): a launcher (`weapon: 'launcher'`) runs `targeted` (its
  `useMissiles` is category 1 in the SDE), `reach` Infinity (missiles past their range expire), cycle = its rate of
  fire (attribute 51), not warp safe. Refused: bomb launchers (group 862 in `UNACTIVATABLE_GROUPS`, "bomb launchers are
  not modelled yet") and a launcher whose charge is no missile or none (`NO_MISSILE_REFUSAL`, "it has no missiles
  loaded": probe and interdiction launchers, a fit without the charge). No falloff `effectiveness` on its row.
- **`ShipModules`**: `IsWeapon` (turrets and launchers) gates what `IsTurret` did: the ship's target (an authored
  object allowed), `LockHold`, `Retarget` at the next cycle start, `Untarget`, the "it needs a target: set_target or
  switch_modules target" text, and the exclusion from `Targeting` / `TargetIndex` (a launcher is no target effect).
  `WeaponAims` / `WeaponKeys` replaced `TurretAims` / `TurretKeys`; logi L2 renamed `WeaponAims` to `LockAims` (remote
  repairers lock too: `IsLockGated`, `sd-fittings`). Specs carry `missile` (`missileCombatNumbersOf`)
  beside a turret's `combat` (`ShipModuleSpecsOf`).
- **The director** (`sd-combat` → Missiles in the page): every turret filter became "a weapon" (`SwitchModules`' aim
  and lock request, `SetTarget`'s counts, `Engage`, `CeaseFire`, `ArmWeapons`, `paperDps`, `WantedLocks`), so launchers
  take any target the ship has: `set_target`, `engage`, a `switch_modules` target, a fleet's called primary.
  `DEFAULT_ENGAGE_MODULES` is `["turret", "launcher"]`. `set_target` rows add `launchers` (omitted at 0) and
  `retargeted` counts both kinds; engage skips "it fits no weapon matching …", cease_fire "its weapons are not firing".
- **get_state**: launcher rows `combat { damage (per missile), volley, dps, velocity, flightTime, range { lower, upper,
  upperChance, mean } }`, `inFlight`, and the note "its last missile was not launched: …" after a refused launch; per
  ship `missiles { launched, inFlight }` (omitted at 0); scene `missiles` (`MissileFlights.Report`, omitted until a
  launch or refusal after a load).
- verify-page (headless, 2026-10-23, SDE 3646012): "launchers fire missiles on their cycle" (a default-fit Caracal
  `cc1_t1:caldaribase:caldari` and a Punisher 15 km off: the 5 launchers wait for the lock, 15 launches in 20.1 s
  against 16.2 expected at 6.1965 s, none after the stop; the row's `cycleTime` is rounded to 6.2), "missiles hit
  through EVE's formula", "a missile that cannot reach its target expires without damage", "missiles at a dead or
  warping target are lost", "a shooter that warps loses its missiles", "missiles kill like turrets, and engage arms
  launchers by default" (evidence: `sd-combat` → Missiles in the page). Every turret, combat and fleet targeting check
  re-ran unchanged (seed 1: 40 shots, the kill 15 ticks after engage by p2 high-0, dealt [824.6, 748]).

## Launchers fire, drawn (missiles M3)

- **`MissileLookup`** (`missile-lookup.ts`): one `/missile?charge=&launcher=` request per (charge, launcher) per page
  session, answered synchronously once cached; `WeaponLookup`'s retry rule (no answer, 502, 503 or 504 retried after
  1 s and 3 s; a failure cached with the hub's message until `ForgetFailures` on every load, logged once).
- **`MissileFiles`** (`missile-plan.ts`) load the charge's EveMissile `.black` and its impact effect once each, with or
  without a renderer (a headless page still posts the impact sound), read into `MissileFileFacts` (`warheads`,
  `impactDuration` from the impact's `duration`, `impactEvents`). `SyncTurrets` preloads them for every launcher module
  with a charge.
- **`DrawLaunch`** (`director.ts`): the launcher set's burst (`ShipTurrets.Fire`; `ShotQueue.Drawn` records it and
  `shots.Off` now runs for every weapon, so launchers settle like turrets) and the outburst sound
  (`missile_outburst_heavy_play`) through `TurretAudioPosts` with `missed: true` (no gun impact). The drawn missile
  (`ShipMissiles.Launch`) starts at the burst start: the draw + the set's `randomFiringDelay`. Nothing for a shooter
  that left or warps, or a missile whose ball is gone.
- **The impact sound** is the impact file's `Tr2ActionPlaySound` event (`missile_explosion_kinetic_medium_play` for
  Scourge), posted on the target's emitter at the detonation (headless: at the hit's draw time). Both it and the
  outburst are learned undecodable (PTADPCM) on the GPU, like the guns' (Sounds, below).
- **The schedule** (`MissileDrawPlan`; the runtime half and its gotchas: `sd-runtime` → EveMissile; the draw times:
  `sd-combat` → Missiles in the page): a flight draws from its burst start until every warhead is DEAD. It arrives
  (curve frozen, target kept) once its ball reaches its target; the runtime detonates it on the drawn hull and the
  impact plays there. An expiry or a loss vanishes at its drawn end (no impact); a hit not detonated
  `MISSILE_FALLBACK_TICKS` after its draw time is forced; a missile whose ball left the parks is frozen. Over 256 live
  missiles a flight flies undrawn (`skipped`); over 64 live impacts a detonation plays its sound and kill without the
  effect (`impactsSkipped`). The simulation never changes.
- **get_state** `renderer.missiles` `{ live, waiting, impacts, detonated, vanished, forced, frozen, skipped,
  impactsSkipped, pools, loading, failed, errors? }` (`pools`: instances per projectile / impact path).
- verify-page (headless, 2026-10-23, SDE 3646012): "launcher and missile impact sounds post"
  (`missile_outburst_heavy_play` on the Caracal, `missile_explosion_kinetic_medium_play` on the Punisher, both then
  recorded undecodable; `gameObjects − emitters` 1). With the boundary draw rule every missile check above and "turret
  sounds post with the shots" re-ran green (launched at tick 57, first hit at 59).

### Real-GPU evidence: missiles (2026-10-23, Windows Chrome, RTX 40 series, SDE 3646012)

Own hub on 5524; drivers in `.scratch/missiles-gpu/` (`call.sh`, `burst.mjs`, `fleet.mjs`, `duel.json`, `miss.json`),
artifacts `run1-launch`, `run2-impact`, `run4-miss`, `run6-fleet`, `run7-scale` there (dbxpc only).

- **Duel**: a Caracal (`cc1_t1`) and a Punisher 20 km off. Five missiles leave the launchers with flame and smoke trails
  and sprites (run1 021 / 022); the Scourge impact cloud (a cyan flash) plays on the Punisher (run2 018). Detonations
  sit 10-25 m from the 28 m Punisher's centre, ~0.5 s after the drawn ball's arrival at ~276 m.
- **Miss**: the Punisher at `maxVelocity` 9000 fleeing: 5 expired, vanished at once, no impact.
- **10 Caracals vs 10 Rifters at 30 km** (run6): 50 launched / 50 hits / 50 detonated, `failed` 0, `skipped` 0,
  `gpuErrors` 0, `page_log` info only (the impact event undecodable), audio `gameObjects − emitters` 1 → 1; red-fc
  killed by a Heavy Missile Launcher II and its explosion played. fps mean 54.2, p10 50, min 21 for ~5 s right after
  the 50-impact volley and kill.
- **TFIs (44) vs 20 Caracals at 25 km** (run7): 95 missiles per volley, 1,050 launched; pools `heavy_missile` 100,
  impact 64 (+2 before the pool-order fix); impacts at the 64 cap (`impactsSkipped` 159), `failed` 0, `gpuErrors` 0.
  fps 13-17 with missiles (one 4 fps sample) against ~22 with turrets alone before the first launch (`sd-combat` K3
  baseline 17-23 between kills).

## Sounds (W4)

Named by the files (`TurretFileFacts`): the firing effect's `PlayTurretFX` events (`ship_turret_<size><family><n>_play`)
on the shooter, its `PlayTurretImpact` events (`ship_impact_*`) on a ship it hits, the set's
`idleToTargetingMovementAudioEvent` (`turret_move_<family>_out_<size>`) and `targetingToIdleMovementAudioEvent`
(`_in_`). Posted through `PageAudio.Post` on each ship's own emitter (`TurretAudioPosts` → `TurretSoundQueue` →
`DriveTurrets`):

- **Fire and impact** as each drawn burst starts: the draw plus the set's `randomFiringDelay` (the client's curves sit at
  t = 0 of `play_start`, played from minus that delay); at the draw without a renderer. No impact on an object (no
  emitter) or for a miss. A shot that does not draw posts nothing.
- **Deploy** when a ship takes a target, a first or a new one (the client's `SetTargetObject` posts it for both);
  **pack** when it loses it (`set_target` null, the target removed, either ship warping). For every weapon module.
- **One post per (ship, event)** per batch, at its earliest time, and per frame. Nothing for a ship that left.
- The director keeps `TurretFiles` with or without a renderer (`SyncTurrets` loads each mount's files), so the event
  names are known headless. Radii (`maxRadiusAttenuation`; the runtime culls each emitter at its playing events'
  largest, 0 = unbounded): `ship_turret_*` 150-260 km, `ship_impact_*` 10-28.5 km (L / XL 0), `turret_move_*` 2.5-4.3
  km (XL 36).
- **Firing and impact sounds are silent for now**: all their media are Wwise PTADPCM and the runtime ships no decoder
  (`sd-runtime` → Audio), so `PageAudio` learns each such event undecodable from its first post and only records it
  after. Deploy and pack media decode and play.
- verify-page (headless): "turret sounds post with the shots" (`ship_turret_sp3_play` on the Rifter,
  `ship_impact_sp3_play` on its target, then recorded undecodable; `turret_move_projectile_out_small` on a retarget and
  `_in_small` on a clear, played; `gameObjects − emitters` unchanged).

### Real-GPU listen check (2026-10-23, Windows Chrome, RTX 40 series, SDE 3632936)

Own hub on 5521; the W3 engagement (`.scratch/turrets-gpu/stage-w3.sh`) plus 4 Rifters and 4 Punishers: 20 ships, 87
sets, every one firing at the other side's FC; camera 2.5 km off a Rifter; the `.scratch/listen/` probe on the master
bus. Clip and cues: `.scratch/turrets-gpu/w4-listen/` on dbxpc.

- **Before the fixes**: the bus stayed silent (median -120 dBFS) while 1,753 events sat `loading` forever (tools-core's
  whole-file range reads, ~0.8 s each), and a tab reload mid-read crashed the hub. With the hub's audio cache and the
  `pipeline` proxy, every event finishes.
- **Deploy** (8 sides' worth at once): p95 -25.3 dBFS, peak -16.8, 7 voices. **Pack**: p95 -34.2, peak -24.2, 20 voices.
- **Fire and impact**: 11 events learned undecodable (PTADPCM), not sent. Before the gate they cost 908 range reads
  (146 MB) per 10 s and 52.5 fps against 55.9; with it, firing runs at 56.7 fps with 0 reads.
- `audio.gameObjects` 21 = 20 page emitters + the listener throughout; `frameErrors`, `backendErrors`, `rescheduled` 0;
  `gpuErrors` 0. Voices never piled up, so no voice budget yet: measure again once PTADPCM decodes.

## Charges (`loadCargoCharges`)

- A charge fits a module when the module's chargeGroup1-5 (604, 605, 606, 609, 610) hold the charge's group and the
  chargeSize (128) matches (when the module names one). The 800mm Repeating Cannon II takes groups 83 / 372, size 3.
- A turret or launcher with no loaded charge takes the first fitting cargo charge (`ShipFitting.charges`, written
  order; a launcher only a missile, `isMissileCharge`): `chargeNote: 'loaded from cargo'`. Otherwise a launcher takes
  the option's `defaultMissile(launcherRecord)` (`'default missile'`, `DEFAULT_MISSILE_LOADED`), and a turret, or a
  launcher without a default, gets `'no charge loaded'` (a turret fires on its own numbers). A loaded charge is kept;
  modules or cargo charges the bundle lacks are left alone; a default missile the bundle lacks still loads (the caller
  fetches its dogma). Turrets get no default charge.
- The TFIs doctrine fits load no charges: the TFI's guns load `Barrage L`, the Revelation's `Conflagration XL`.
- `fittingTypeIDs` returns the cargo charges' ids too, so their dogma lands with the fit in one request. The page runs
  `loadCargoCharges` after `WithPropMod` (generic over the module type, so the page's notes ride along) and passes the
  charge to dogma as `chargeTypeID`.

## Default missiles (`default-missiles.ts`, missiles M1)

A launcher with no missile loaded and none fitting in cargo fires the Tech I missile of its first charge group
(chargeGroup1-5) that `DEFAULT_MISSILES` names, at the hull's damage type (`missileDamageTypeOf`): SDE race 1
Caldari kinetic, 2 Minmatar explosive, 4 Amarr EM, 8 Gallente thermal; else the SOF race (caldari / guristas kinetic,
minmatar / angel explosive, amarr / sansha / bloodraider EM, gallente / serpentis thermal); else kinetic. Probe
launchers carry no `launcherFitted` (40), so they are no launcher at all; bomb launchers (group 862) have no default.

| Group | kinetic (Scourge) | thermal (Inferno) | EM (Mjolnir) | explosive (Nova) |
|---|---|---|---|---|
| light 384 (light, rapid light) | 210 | 211 | 212 | 213 |
| heavy 385 | 209 | 208 | 207 | 206 |
| cruise 386 | 203 | 204 | 202 | 205 |
| rocket 387 | 266 | 2514 | 2512 | 2516 |
| torpedo 89 | 267 | 2510 | 2506 | 2508 |
| heavy assault 772 | 20307 | 20308 | 20306 | 21867 |
| XL torpedo 476 | 17859 | 17861 | 17857 | 17863 |
| XL cruise 1019 | 32436 | 32440 | 32442 | 32438 |

- **The page** (`ResolveShipFitting`): the damage type from the hull record's `raceID` (the fit bundle's), else the
  DNA's SOF race (`sofRace`, the director passes `doc.dna`'s third part). A default missile the bundle lacks joins the
  resolution's `typeIDs`, so `LookupFit` prepares it and the ship resolves on the next pass ("a resolution still
  pending prepares once more"); a default weapons fit names its missile in the text, so it needs no extra pass. Rows
  report `charge` and the note `default missile`.
- **The hub** (`ship_stats` `ResolveFit`): the same option; a second `Bundle(missing)` fetches the default missiles
  the first bundle lacks.

## Turret slots (`assignTurretSlots`)

What the runtime does (`EveMobile.RebuildTurretPositions`; details in `sd-runtime` once W2 lands): a set whose
`locatorName` contains `_turret_` mounts on `slotNumber` (one digit, 1-9) and binds every
`locator_turret_<slot>a, b, c…` (one turret model each); other collections (`locator_xl_`, `locator_launcher_`,
`locator_atomic_`, `locator_chain_`) are numbered by the engine in `turretSets` order, and a hull without the
collection mounts the set on `locator_turret_<slotNumber>`.

- Input: the mounts in key order (`key`, the set's `locatorName`, the high slot index) and the built hull's locator
  names (plus animation bones on an animated hull).
- Classic turrets take `highIndex + 1` when the hull has `locator_turret_<n>a`, then the rest the lowest unused classic
  slot, in mount order. The TFI's interleaved guns (`high-0, 1, 3, 4, 6, 7`) land on 1, 2, 4, 5, 7, 8.
- Other collections: the n-th mount of the collection is number n; past the collection's highest slot it is unplaced
  (the page does not mount it; the engine would fall back onto the classic counter).
- Each assignment: `{ key, collection, slot, locator: 'locator_turret_4', models, placed }`.

Hull locators seen (tools-core `/sof/hulls/<hull>` `locatorTurrets`): TFI `mb2_t1` turret 1-8 (a, b); Rifter `mf1_t1`
turret 1-4 (slot 1 a, b, c); Revelation `adn1_t1` xl 1-3 + turret 1-8; Caldari battleship `cb1_t1` turret 1-8 +
launcher 1-6; Triglavian `tgc01_t1` turret 1-6 + atomic 1; EDENCOM `uwf01_t1` turret 1-4 + chain 1.

## The weapon route (hub)

`GET /weapon?type=<typeID>` answers `WeaponGraphic { typeID, name, kind, slot, size, resPath, sofFactionName?,
chargeSize?, ammunitionTypeIDs? }` from tools-core's `weapons/types/<id>` (`WeaponData`, sharing ShipData's
`SdeClient`; cached per hub). Errors map like `/ship-stats`: 400 for a type that is no id, 404 `not-found` for a type
with no weapon graphic (tools-core: `Weapon type not found`) or an unusable record, 503 without an SDE or tools-core.

| Weapon | typeID | slot | `sofFactionName` |
|---|---|---|---|
| autocannons / repeating cannons | 2889, 2913, 2929 | turrets | brutor |
| Hexa 2500mm Repeating Cannon II | 37306 | xlTurrets | brutor |
| pulse lasers | 3041, 3520, 3057 / XL 37298 | turrets / xlTurrets | sarum |
| railguns | 3074, 3082, 3090 / XL 37303 | turrets / xlTurrets | laidai |
| blasters | 3178, 3146, 3186 / XL 37302 | turrets / xlTurrets | creodron |
| entropic disintegrators | 47914, 47918, 47922, 52915 | atomics | triglavianbase |
| vorton projectors | 54742, 54748, 54753 | chains | none (paint from the ship's DNA) |
| missile launchers | 2404, 2410, 19739 | launchers | laidai |

The Small Focused Pulse Laser II draws `pulse_medium_t1.black`; the three neutron blasters share a file per size
folder. Re-capture `weapons/fixtures/weapons-3632936.json` with the dogma fixture (below) when CCP rebalances.

## The missile route (hub, missiles M1)

`GET /missile?charge=<typeID>&launcher=<typeID>` answers `MissileGraphic { chargeTypeID, name, launcherTypeID,
impactResPath, projectileGraphicID, projectileResPath }` (`WeaponData.Missile`): the launcher's
`weapons/types/<launcher>/ammunition` row for the charge (its `resPath` is the impact effect, graphicRole `impact`,
one per size and damage type: `heavy_impact_scourge.black`; its `projectileGraphicID`), then
`weapons/projectiles/<id>` (the `EveMissile` file, one per size: light 21938, heavy 21936, cruise 21934, heavy
assault 21937, rocket 21939, torpedo 21940, XL torpedo 21931, XL cruise 21933; `heavy_missile.black`). Ammunition is
cached per launcher, projectiles per id. Errors: 400 for values that are not ids, 404 `not-found` for a charge the
launcher does not fire (a launcher's rows list every charge it takes: rapid lights fire light missiles) or one with no
projectile graphic, 503 without an SDE. tools-core answers the ammunition route with a JSON array:
`SdeClient.GetJsonArray` reads it (`GetJson` flattens a non-object body to `{}`). The page reads the answer through
`readMissileGraphic` (ids and `res:/….black` paths only); the page's lookup and drawing: Launchers fire, drawn.

## Test data

The dogma fixture (`sd-fittings`) carries the default weapons, their charges, the TFI's and the Revelation's cargo
charges, the hulls the default-weapons spec names, and `raceID` on every record. Weapon records: for each default
weapon id, `curl http://127.0.0.1:5510/eve/3632936/weapons/types/<id>`, merged by id into one compact JSON object.
Missile records (2026-10-23): for launchers 2404, 2410, 19739, 1877 and 25715,
`/eve/3632936/weapons/types/<id>/ammunition` (rows trimmed as above) and every `projectileGraphicID` they name from
`/eve/3632936/weapons/projectiles/<id>`, written as `missiles-3632936.json`.
