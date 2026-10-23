# Weapons: turrets on every ship, default guns, slots, charges, the weapon route

> Fetch before touching `packages/scene/src/lib/weapons/`, a fit's weapon modules or charges, the hub's `/weapon`
> route (`hub/weapon-data.ts`), or anything that mounts, aims or fires turrets on the page. The typed fit, dogma and
> the activation layer the guns ride on: `sd-fittings`; the runtime classes: `sd-runtime`.

**Status (2026-10-23)**: the turrets plan
(`~/.claude/plans/turrets-on-every-ship-mount-from-the-parsed-fit-target-fire-on-the-weapon-cycle.md`) lands in four
slices. **W1 is in**: the runtime-free half in `packages/scene` (default weapons, turret slots, charges, the weapon
graphic) and the hub's `/weapon` route. Still to come: W2 mounting (the page's default fit, `WeaponLookup`,
`ShipTurrets`), W3 `set_target` and firing on the weapon cycle with impacts and the `Director.OnShot` hook, W4 turret
sounds. Research: the dbx-claude notes `turrets-runtime-pipeline-research` and
`scene-director-locations-objects-turrets-research`.

## Files

| File | Role |
|---|---|
| `weapons/default-weapons.ts` | `WEAPON_FAMILIES`, `DEFAULT_TURRETS`, `DEFAULT_LAUNCHERS`, `RACE_WEAPON_FAMILIES`, `SOF_RACE_WEAPON_FAMILIES`, `ATTACK_BATTLECRUISER_GROUP`, `DEFAULT_WEAPONS_FIT_NAME`, `weaponFamilyOf`, `weaponSizeOf`, `defaultWeaponsOf` |
| `weapons/slots.ts` | `CLASSIC_TURRET_LOCATOR`, `TURRET_LOCATOR_COLLECTIONS`, `MAX_TURRET_SLOT`, `turretLocatorSlots`, `assignTurretSlots` |
| `weapons/graphic.ts` | `WeaponGraphic`, `WEAPON_SLOTS`, `readWeaponGraphic` (the page reads the hub's answer through it) |
| `weapons/charges.ts` | `CHARGE_GROUP_ATTRIBUTES`, `CHARGE_SIZE_ATTRIBUTE`, `chargeFitsModule`, `loadCargoCharges`, `ChargedModule` |
| `weapons/fixtures/weapons-3632936.json` | tools-core's `weapons/types/<id>` records for every default weapon, captured live; specs read it from disk, never the package |
| `fitting/categories.ts` | `WEAPON_KIND_EFFECTS` (42 turret, 40 launcher), `weaponKindOf`; `typeEftFit` sets `FittedModule.weapon` when the bundle has the module's effects |
| `apps/scene-director/src/lib/hub/weapon-data.ts` | `WeaponData` (`Weapon(typeID)`) over `SdeClient`, cached per hub |
| `hub/weapon-data.testing.ts` | `WeaponRoutes`, `MakeRoutedWeaponData`, `MakeFakeWeaponData` over the captured records |

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
  hardpoints (101): launchers (Light / Heavy / Cruise Missile Launcher II, no XL, no charge; refused activation until
  the Missiles entry). Neither: no fit, note `<hull> has no weapon hardpoints`. A family with no gun of the size (XL
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
3 × Dual Giga Pulse Laser II, Caracal 5 × Heavy Missile Launcher II, Vedmak 1 × Heavy Entropic Disintegrator II,
Stormbringer 1 × Medium Vorton Projector II, Apostle none.

## Charges (`loadCargoCharges`)

- A charge fits a module when the module's chargeGroup1-5 (604, 605, 606, 609, 610) hold the charge's group and the
  chargeSize (128) matches (when the module names one). The 800mm Repeating Cannon II takes groups 83 / 372, size 3.
- A turret with no loaded charge takes the first fitting cargo charge (`ShipFitting.charges`, written order):
  `chargeNote: 'loaded from cargo'`; with none that fits, `'no charge loaded'` (it fires on its own numbers). A loaded
  charge is kept; launchers and modules or charges the bundle lacks are left alone.
- The TFIs doctrine fits load no charges: the TFI's guns load `Barrage L`, the Revelation's `Conflagration XL`.
- `fittingTypeIDs` returns the cargo charges' ids too, so their dogma lands with the fit in one request. W2 runs
  `loadCargoCharges` after `WithPropMod` and passes the charge to dogma as `chargeTypeID`.

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

## Test data

The dogma fixture (`sd-fittings`) carries the default weapons, their charges, the TFI's and the Revelation's cargo
charges, the hulls the default-weapons spec names, and `raceID` on every record. Weapon records: for each default
weapon id, `curl http://127.0.0.1:5510/eve/3632936/weapons/types/<id>`, merged by id into one compact JSON object.
