# Fittings: EFT fits on ships, the parser, fit keys

> Ships carry real EVE fits. Fetch before touching `packages/scene/src/lib/fitting/`, a ship's `fit` or the document's
> `fits`, `compositions/expand.ts`'s fit keys, staging's `fit` lines, or anything that reads EFT text. The prop mod
> itself (numbers, switching, audio): `sd-ship-stats`; compositions and `cjs-fleet/1`: `sd-fleets` → `compositions`;
> `add_ships` / `stage_engagement`: `sd-staging`.

**Status (2026-10-23)**: the fitted-modules plan
(`~/.claude/plans/fitted-modules-eft-fits-parsed-into-typed-modules-fit-driven-ship-stats-module-a.md`) is in, C1-C6:
fits are parsed and ride on scene ships, the hub resolves fit names and serves dogma bundles, the dogma evaluator
computes a fitted ship's HP, resists, capacitor, targeting and flight numbers (`ship_stats` reports them for a `fit`),
the page flies fitted ships by their fit and reports their modules, defense and capacitor in `get_state`,
`switch_modules` runs the modules on EVE's timing into a page-side damage model, and running modules draw the client's
effects and play its sounds (below). Since 2026-10-23 targeted modules also act on their targets: webs and painters,
points and scrams (with the scram's MWD block), neuts, nos and cap transmitters ("Target effects", the plan
`~/.claude/plans/targeted-module-effects-on-their-targets.md`). Research behind the design: the dbx-claude note
`fitted-modules-dogma-and-module-effects-research`.

**No-EVE-data mode** (`sd-dev-env`): the page's `FitLookup` answers every name unavailable and fails every type and the
skills at once with the mode's note (no request), so a fitted ship flies its hull's class numbers; the fit routes
(`/fit/type`, `/dogma/types`, `/dogma/skills`) answer 503.

## Files

| File | Role |
|---|---|
| `fitting/eft.ts` | `parseEftFit` (the parser), `readEftHeader`, `readEftPropMod`, `EFT_HEADER_PATTERN`, `MAX_FIT_LENGTH` (20,000), slot limits |
| `fitting/fit.ts` | `FIT_KEY_PATTERN`, `isInlineFit`, `readFitText`, `normalizeSceneFits`, `normalizeShipFit`, `fitTextOf`, `shipPropModModuleOf`, `chooseSceneFitKey`, `sceneFitKey` |
| `fitting/operation.ts` | `FIT_OPERATIONS` (`set_fits`), `applyFitOperation` |
| `compositions/eft.ts` | re-exports the readers (its `eft.spec.ts` is unchanged and pins `readEftPropMod`) |
| `compositions/expand.ts` | `toSceneFits`: line ships get `fit: "<composition id>/<key>"`, the expansion returns the texts |
| `compositions/operation.ts` | `mergeDraftFits`, `readDraftFits` (also used by staging) |
| `staging/ships.ts` | a line's `fit` (EFT text; the hull defaults to its header's), `stagedFitKey`, `toShipListComposition` carries `fits` |
| `staging/add-ships.ts` | `pushStagedShips` moves a staged ship's inline fit into `fits` |
| `fitting/dogma.ts` | `evaluateShipDogma` (the evaluator, below), `stackingFactor`, `STACKING_EXEMPT_CATEGORIES`, `DOGMA_OPERATIONS`, `DOGMA_ATTRIBUTES` |
| `fitting/typed-fit.ts` | `typeEftFit` (the typed fit), `eftTypeNames`, `fittingTypeIDs`, `toDogmaModules`, `selectFittedModules` (module selectors) |
| `fitting/categories.ts` | `MODULE_CATEGORIES`, `moduleCategoryOf` (group, refined by effect: scram / point, siege / triage, weapons), `WEAPON_KIND_EFFECTS` / `weaponKindOf` (42 turret, 40 launcher: `sd-weapons`) |
| `fitting/defense.ts` | `shipDefenseOf`, `shipCapacitorOf`, `shipTargetingOf`, `moduleNumbersOf` (cycle, capacitor need, range, falloff, repair), `localRepairRates` |
| `stats/ship-stats.ts` | `computeShipStats`'s `dogma` input and `dogmaShipStats` (the dogma path, below) |
| `apps/scene-director/src/lib/hub/ship-stats-tool.ts` | `ship_stats`' `fit`, `active` and `trace` (`ResolveFit`, `AnswerFitted`) |
| `fitting/fitting.spec-helper.ts` | `DOGMA_FIXTURE` (read from disk), `fixtureAnswer` (a `/fit/type` name table), `fixtureHullStats`, hull ids |
| `fitting/dogma-bundle.ts` | `DogmaBundle` / `DogmaTypeRecord` / `DogmaEffectRecord` / `DogmaAttributeRecord` / `FitTypeAnswer`, `mergeDogmaBundles`, `readDogmaBundle`, `readFitTypeAnswer`, `fitTypeCategoryOf` |
| `fitting/fixtures/dogma-3632936.json` | the committed dogma fixture (below); never imported by the package (it would ship in the page bundle): specs read it from disk |
| `apps/scene-director/src/lib/hub/sde-client.ts` | `SdeClient`: build pin, `GetJson` / `PostJson`, `Cached`, `Type`, `TypeDogma` (with the default effect), failure mapping, readers; `ShipData` delegates to it |
| `apps/scene-director/src/lib/hub/dogma-data.ts` | `DogmaData` (`TypeByName`, `Bundle`, `Skills`), `FIXED_ATTRIBUTE_IDS`, `MAX_DOGMA_TYPE_IDS` |
| `apps/scene-director/src/lib/hub/dogma-data.testing.ts` | `DogmaFixture`, `DogmaRoutes` (tools-core routes rebuilt from the fixture), `MakeRoutedDogmaData`, `MakeFakeDogmaData` |
| `packages/viewer-engine/src/lib/fittings.ts` | the page's fit lookups (`FitLookup`), `ResolveShipFitting`, the get_state reports (`ShipFitReportOf`, `ShipDefenseReportOf`, `ShipCapacitorReportOf`, `FleetModuleCountsOf`); node-tested over the fixture (`fittings.spec.ts`) |
| `packages/viewer-engine/src/lib/flight.ts` / `director.ts` | `ResolveFlight`'s `dogma` path; the director's `ResolveFitting`, `LookupFit`, `PropModModule` / `FitsPropMod`, get_state's `fit` / `defense` / `capacitor` and fleet `modules`; `SwitchModules`, `SyncModules`, `LiveDogma`, `ModuleEvents` (activation, below) |
| `fitting/switch.ts` | `normalizeModuleSwitch` (the `switch_modules` arguments, a plain object a `switch_modules` timeline cue embeds), `MODULE_SWITCH_STATES` |
| `fitting/activation.ts` | `moduleActivationOf` (how a module activates: refusal, targeted, warp safe, cycle, reactivation, reach, repair, group limits, `flight`, `note`), `UNACTIVATABLE_GROUPS`, `EFFECTLESS_CATEGORIES`, `falloffEffectiveness`, `moduleReach` |
| `packages/viewer-engine/src/lib/module-cycle.ts` | `ModuleCycle` (one module's state machine), `CycleEnd` (moved from destiny.ts, which re-exports it) |
| `packages/viewer-engine/src/lib/modules.ts` | `ShipModules`: the activation layer over a world port (`SurfaceDistance`, `InWarp`, `HasShip`, `tickSeconds`); `Targeting(target)` / `TargetIndex()` (the running targeted modules on a ship, each with `applied`), `CapacitorLandings(events)` |
| `packages/viewer-engine/src/lib/damage.ts` | `DamageModel`: current / max HP per layer, resonances, repairs and incoming repairs |
| `fitting/target-effects.ts` | `moduleTargetEffectOf` (what a module does to its target, from the shooter's evaluation), `incomingModifiersOf`, `scaleModifierAmount`, `incomingSourceLabel`, `warpScrambleNoteOf`, `microwarpdriveBlockNoteOf`, `TARGET_EFFECT_ATTRIBUTES`, `HIGH_SPEED_MANEUVERING` (3454); the evaluator's side is `dogma.ts`' `incoming`, `dogmaResistanceOf`, `applyIncomingModifiers` |
| `packages/viewer-engine/src/lib/capacitor.ts` | `CapacitorModel`: the live capacitor level of every fitted ship (`Set`, `Level`, `Drain`, `Give`, `Nos`, `Report`), recharged lazily on EVE's curve; node-tested |
| `fitting/effects.ts` | `MODULE_EFFECTS` (the client effect per default dogma effect guid), `moduleEffectOf`, `moduleEffectSounds`, `nearestSoundDuration`, `MODULE_EFFECT_SOUND_DURATIONS` |
| `packages/viewer-engine/src/lib/module-fx.ts` | `ModuleFxCommands`: module events → `start` / `cycle` / `stop` effect commands keyed `<ship>\|<module>` (node-tested) |
| `packages/viewer-engine/src/lib/module-audio.ts` | `ModuleAudioPost`: a command → the hull-sized sound events and stops on the module's ship (node-tested) |
| `packages/viewer-engine/src/lib/module-effects.ts` | `ModuleEffects` (runtime): loads, hydrates, attaches, places and tears down the drawn effects |

## Fits in the document

- **`ships[].fit`**: EFT text (starts with `[` after trimming; stored trimmed) or a key of **`fits`** (top level,
  `{ "<key>": "<EFT text>" }`, omitted when empty). Keys: one or two segments of 1-64 `[A-Za-z0-9_.-]` joined by one `/`
  (`tfis/tfi`). Every text needs a `[Hull, Fit name]` header and at most 20,000 characters.
- A ship's key must exist in `fits` (a problem otherwise). A string `type` naming another hull than the fit's header
  warns; the ship flies as its type.
- **Why a map**: a TFIs fleet with inline fits would put ~66 KB of EFT into every `get_scene`; its 13 shared fits are
  ~20 KB. Unused keys stay until `set_fits` deletes them; nothing prunes them.
- **`set_fits { fits: { key: text | null } }`** merges; `null` deletes, refused while a ship uses the key. A ship's own
  fit: `update_ship { set: { fit } }` (`null` clears).
- **Diff**: no new field. A ship whose resolved fit text changed (inline edit, another key, or its `fits[key]` edited)
  joins `retuned`; `diffScenes` compares `fitTextOf(ship, scene)` before and after.
- **Live only**: module states (C5) are never written to the document. A fit's `/OFFLINE` is the persistent offline
  marker.

## Fit keys from compositions and staging

- `add_fleet_composition` / `stage_engagement` composition sides: each line ship gets `fit: "<composition id>/<key>"`;
  only fits a line uses enter the scene. `chooseSceneFitKey` takes the first of `<composition id>/<key>`,
  `<fleet id>/<key>` that is free or already holds the same text (so a second TFIs fleet reuses `tfis/*`), else numbers
  the first prefix (`tfis-2/<key>`).
- `add_ships` / `stage_engagement` ship lines take `fit` (EFT text). A new fleet or a fleet side goes through the
  ship-list composition: its fits are keyed by `stagedFitKey` (a slug of the fit name, numbered on a clash), so
  `<fleet id>/<fit name slug>`. Free ships and joins carry the text inline until `pushStagedShips` moves it to
  `<ship id prefix>/<fit name slug>` (the prefix is the id minus its `-<nn>`). The `template` `add_ships` returns
  carries `fits`. The hub fills a missing `hull` from the fit header before resolving the DNA.
- `shipPropMod` in `expand.ts` still writes the explicit `propMod.module` a line's fit implies, so composition prop mods
  behave as before.

## The parser (`parseEftFit`)

Pure, no EVE data. Returns `{ hull, name, modules, drones, cargo, implants, empty, problems, warnings }`; a module line
is `{ name, charge?, offline?, section, slot, line }`, an item line `{ name, quantity, line }`.

- Header: the first non-empty line (CRLF and leading blank lines are fine). No header is a problem, as is text over
  20,000 characters or a line over 300.
- Per line, `/OFFLINE` (any case) is stripped first, then a charge after the first comma (`Module, Charge`).
- Module sections run **low, mid, high, rig, subsystem, service**, split by blank lines. `[Empty <X> slot]` (Low, Med,
  High, Rig, Subsystem, Service) counts in `empty` and fixes its section's slot; the next section follows from there.
- **Where modules end**: the first double blank line; when the text has none, the first `xN` line. After that the first
  quantity section is `drones` and later ones `cargo`; lines with no quantity are `implants` (implants and boosters:
  reported, never applied). An `xN` line before a double blank is cargo, with a warning.
- Slots are **provisional** (section order). The typed fit (C3) takes each module's slot from its EVE type, and drones
  vs cargo from the type's category: the Revelation's fit has no drone bay, so its cargo parses as `drones` here.
- Warnings: more of a slot than EVE hulls have (8 high / mid / low, 3 rig, 4 subsystem).
- TFIs check (`fitting/eft.spec.ts`): the TFI fit is 7 low, 5 mid, 8 high, 3 rig, 3 drone lines, 27 cargo lines; the
  Devoter has one `[Empty High slot]`; the Damnation's four bursts are lowercase `/offline`.

## The prop mod a fitted ship flies

`shipPropModModuleOf(ship, fitText)`: `propMod.module` if set; else, with a fit, `readEftPropMod` (the first module
line, in written order, naming an MWD or AB, offline ones included; never cargo), `"none"` when it has none; else
`DEFAULT_PROP_MOD_MODULE` (the hull-sized MWD). The page's director uses it everywhere it asks what a ship flies
(`PropModModule`, `FitsPropMod`): a fitted ship without an MWD or AB fits none, and `switch_prop_mods` skips it with "it
fits no prop mod (its fit has no MWD or AB)".

## Names and dogma from tools-core (hub)

Routes (`hub.ts`, GET; errors map like `/ship-stats`: 400 invalid, 404 not found, 409 ambiguous, 503 no SDE or no
tools-core):

| Route | Answer |
|---|---|
| `/fit/type?name=<exact name>&hull=<header hull>` | `FitTypeAnswer { typeID, name, groupID, categoryID, category, slot }` |
| `/dogma/types?ids=<comma list, 1-200>` | `DogmaBundle` (`missing` lists ids the SDE lacks) |
| `/dogma/skills` | `DogmaBundle` of the 512 published skills (~4.5 s the first time, then cached per hub) |

- **`TypeByName`**: `POST fitting/parse { text: "[<hull>, resolve]\n<name>" }`, one name per call. The header hull
  only has to be a published hull; 400 `Unknown hull in EFT header` is retried on `ANCHOR_HULL` (`Rifter`), and 400
  `Unknown type in EFT text` becomes `not-found`. **Names are case-sensitive** (tools-core matches exact English
  names; `warp scrambler ii` is not found). Slot from the item's `slot` (`medium` → `mid`; `null` for drones, charges,
  cargo); group and category from `types/<id>?lang=en`. Cached per exact name.
- **`Bundle(ids)`**: `types/<id>?lang=en` (name, group, category, published, `raceID`, the `mass` / `radius` /
  `capacity` / `volume` columns) + `sde/typeDogma/<id>` (attribute values, effect ids, the `isDefault` effect); then every effect
  the types carry (`sde/dogmaEffects/<id>`: `effectCategoryID`, `guid`, `isWarpSafe`, `isOffensive`, `isAssistance`,
  the duration / discharge / range / falloff / tracking / `resistanceAttributeID` attribute ids, `modifierInfo`); then
  the attributes those modifiers and effects name, `FIXED_ATTRIBUTE_IDS`, and each record's `maxAttributeID`
  (`sde/dogmaAttributes/<id>`: `stackable`, `highIsGood`, `defaultValue`). Attribute values a type has but no effect
  names get no record. `FIXED_ATTRIBUTE_IDS` carries the tackle, transfer and resistance attributes (97, 90, 104, 105,
  1349, 1350, 1945, 2138, 2045, 2112-2116, 2135, 2253, 6463): webs and painters name their resistance only through a
  module attribute value (`remoteResistanceID` 2138), which nothing else collects. 16 requests at a time; records are
  cached per hub. `/ship-stats` hulls carry `warpScrambleStatus` (104, as `rigSize`) for the table path.
- **`Skills()`**: `sde/groups?field=categoryID&value=16` (25 groups) → `sde/types?field=groupID&value=<g>` → the
  published ones → `Bundle`. Build 3632936: 512 skills, 726 effects, 686 attributes, ~440 KB.
- The page never sends a whole fit to the hub (the HTTP layer is GET-only and Node's 16 KB header limit rules out EFT
  text in a query): it parses the fit itself and resolves names one `/fit/type` at a time (C4).

### The fixture (`fitting/fixtures/dogma-3632936.json`)

The merge of `/dogma/types` for 16 hulls (587 Rifter, 17732 TFI, 11987 Guardian, 19720 Revelation, 22474 Damnation,
37604 Apostle, 17740 Vindicator, 17920 Bhaalgorn, and for the default weapons 597 Punisher, 16227 Ferox, 641 Megathron,
642 Apocalypse, 621 Caracal, 4310 Tornado, 47270 Vedmak, 54732 Stormbringer), the 13 `BAKED_PROP_MODS`, 28 modules
(plates, membranes, DC II, extender, hardeners, local / remote / ancillary reps and paste, booster, scram, point, webs
(Stasis Webifier II, Federation Navy Stasis Webifier), cap transmitter, siege, triage, suppressor, rig, neut, Heavy
Energy Nosferatu II, Target Painter II, Warp Core Stabilizer II, a turret), the default weapons' 23 turrets, 3
launchers and their charges, and the TFI's and Revelation's cargo charges (`sd-weapons`), with `/dogma/skills`: 618
types, 869 effects, 782 attributes, ~567 KB (re-captured 2026-10-23 with effects' `resistanceAttributeID`). Missiles M1
added 43 types by merge (new keys only, every existing record unchanged): the T1 missiles of every default group
(202-213, 266, 267, 2506-2516 even, 20306-20308, 21867, 17857-17863 odd, 32436-32442 even), the Kestrel 602, Raven 638
and Drake 24698, Ballistic Control System II 22291, Rapid Light / Heavy Assault Missile Launcher II 1877 / 25715,
Medium Warhead Calefaction Catalyst I 31622, Bomb Launcher I 27914, Core Probe Launcher II 4258, Core Scanner Probe
I 30013 and Shrapnel Bomb 27918: 661 types. Every type
record carries its `raceID` when it has one. Specs read it from disk (`readFileSync`), the hub's through
`DogmaFixture()`. **Re-capture when CCP rebalances** (and re-check the stats parity spec, C3, and the weapon records,
`sd-weapons`):

```sh
node bin/scene-director.js serve --port 5521 --scenes /tmp/sd/scenes --fleets /tmp/sd/fleets &   # tools-core on 5510
IDS=587,17732,11987,19720,22474,37604,438,440,12058,12076,12068,12084,41239,41253,5945,5975,35662,35660,41238,20347,11269,2048,3831,2281,13992,1183,3540,33103,28668,10850,448,3244,527,26914,3608,16487,4292,4294,4409,31900,25894,12271,2929
IDS=$IDS,597,16227,641,642,621,4310,47270,54732,2889,2913,37306,3041,3520,3057,37298,3074,3082,3090,37303,3178,3146,3186,37302,47914,47918,47922,52915,54742,54748,54753,2404,2410,19739
IDS=$IDS,185,193,201,17668,246,254,262,17686,222,230,238,17648,47924,47928,47932,52916,54784,54786,54783,12775,12779,21894,41332,41330
IDS=$IDS,17559,12263,19806,11640,17740,17920
IDS=$IDS,202,203,204,205,206,207,208,209,210,211,212,213,266,267,2506,2508,2510,2512,2514,2516,20306,20307,20308,21867
IDS=$IDS,17857,17859,17861,17863,32436,32438,32440,32442,602,638,24698,22291,1877,25715,31622,27914,4258,30013,27918
curl -s "http://127.0.0.1:5521/dogma/types?ids=$IDS" -o types.json && curl -s http://127.0.0.1:5521/dogma/skills -o skills.json
# merge: { sdeBuild, types, effects, attributes } = union of both, keys sorted numerically, compact JSON
```

**The hub reads tools-core's latest SDE** (`/eve/latest/build` → `builds.sde`; `--build` pins only the resources).
Since 2026-10-23 tools-core's latest is 3646012, so a capture for the 3632936 fixture needs the build pinned: run a
proxy in front of tools-core that answers `/eve/latest/build` with `sde: 3632936` and forwards the rest, and point the
hub's `--tools-core` at it (the missiles M1 capture did, `/tmp/msl/pin-proxy.mjs` on dbxpc). A batch over 200 ids
splits across requests.

## The typed fit (`typeEftFit`)

- Each name resolves through an answer function (the hub's `/fit/type`; specs use `fixtureAnswer`). A module takes its
  slot from its type's slot effect and the key `<slot>-<n>` (written order within the slot, unknown names counted, so
  keys stay put when a name later resolves). Empty slots are counted in `empty`, never keyed.
- A module line whose type is not a module (a charge, a drone) moves to the items with a warning. Quantity lines sort
  by category: drones and fighters, `charges` (the ammo pool), `cargo` (cargo modules are never fitted). Names that do
  not resolve are listed in `unknown` and left out of dogma.
- `prop: true` marks the first fitted MWD / AB (group 46) in written order: the module the ship's `propMod` stands for.
- `weapon: 'turret' | 'launcher'` marks a module with effect 42 `turretFitted` / 40 `launcherFitted`, when the bundle
  has its effects (`weaponKindOf`). `fittingTypeIDs` returns the modules, their loaded charges **and the cargo
  charges**, so a turret with none loaded can take one from cargo (`loadCargoCharges`, `sd-weapons`) with its dogma
  already in the bundle.
- `toDogmaModules`: resolved modules only, `/OFFLINE` ones `offline`, the rest `online` unless the state callback says
  otherwise. `selectFittedModules(fit, selectors)`: a key (`mid-2`), a category keyword, `all`, or a module name in any
  case; it returns the modules in fit order and the selectors that matched none.

## The dogma evaluator (`evaluateShipDogma`)

Input: `{ bundle, hullTypeID, overrides?, modules: [{ key, typeID, state, chargeTypeID? }], pilot?, skillTypeIDs? }`;
the accessors (`attribute`, `moduleAttribute`, `chargeAttribute`, `trace`) are lazy and memoized.

- **Items**: the ship (typeDogma values, plus the `mass` / `radius` / `capacity` / `volume` columns; `overrides`
  replace mass, maxVelocity, agility and signatureRadius as base values, which is what a scene ship's `stats` means),
  the modules and their charges (located in the ship; a charge and its module are each other's `otherID`), and every
  skill in the bundle at the pilot's level. **A level-0 skill still runs**: its `...SkillLevelPreMulShipBonus...`
  effect multiplies the hull's per-level trait to 0 (skipping it left the unscaled per-level bonus: an untrained
  Damnation got 4 % armor resists).
- **Which effects run**: the ship and skills, category 0. A module: category 0 always (rigs are passive), category 4
  (online: plates, membranes, the DC, extenders, the MWD's capacitor penalty) when online or active, its default
  effect (category 1, e.g. hardeners) when active. Overload (5) never. A charge: category 0 while its module is on.
- **Funcs**: `ItemModifier` (itemID, shipID, otherID), `LocationModifier`, `LocationGroupModifier` (groupID) and
  `LocationRequiredSkillModifier` (the skill among requiredSkill1-6, `-1` = the source skill) on the modules and
  charges in the ship, `OwnerRequiredSkillModifier` on charges. Skipped and listed in `skipped`: target and structure
  domains, and charID `ItemModifier`s except `missileDamageMultiplier` (the char-domain `LocationGroupModifier` targets
  boosters; drones come later). `EffectStopper` and operation 9 are ignored.
- **The character item** (missiles M1): one synthetic item per evaluation for `CHARACTER_ATTRIBUTES` = {
  `missileDamageMultiplier` 212 }, at the bundle's default (1 without a record). A charID `ItemModifier` on 212
  targets it: Ballistic Control Systems (763 `missileDMGBonus`, category 4, so online) and Warhead Calefaction rigs
  (2851) preMul it by 213, stacking-penalized like any module. `DogmaShip.characterAttribute(attribute)` reads it
  (null for any other attribute); missile damage is the charge's × it (`sd-combat` → Missiles).
- **Order**: preAssign, preMul, preDiv, modAdd, modSub, postMul, postDiv, postPercent, postAssign (the last assign
  wins). A modifier's amount is its modifying attribute evaluated on its source, so chains work: skill → the hull's
  `shipBonus*` → hull effect → resonance.
- **Stacking penalty**: on a non-stackable attribute, for preMul, preDiv, postMul, postDiv and postPercent, from a source
  whose category is not ship 6, charge 8, skill 16, implant 20 or subsystem 32. Each operation is its own group, bonuses
  and maluses apart, strongest first; the i-th (from 0) counts `exp(-(i / 2.67)²)` = 1, 0.869, 0.571, 0.283, 0.106.
- `maxAttributeID` caps the result; a dependency cycle uses the base value with a warning. A type the bundle lacks is
  left out with a warning; a hull it lacks throws.
- **Code effects** (no modifiers in the SDE; built in as Pyfa does): `moduleBonusMicrowarpdrive` /
  `moduleBonusAfterburner` when active add `massAddition` (modAdd) and maxVelocity postPercent `speedFactor ×
  speedBoostFactor / mass` (the mass with the addition; never penalized), and the MWD adds signatureRadius postPercent
  `signatureRadiusBonus` (penalized). `adaptiveArmorHardener` when active preMuls the armor resonances by its own (a
  static profile). The missile skills' 660 `missileEMDmgBonus`, 661 `missileExplosiveDmgBonus`, 662
  `missileThermalDmgBonus`, 668 `missileKineticDmgBonus2` (`MISSILE_SKILL_DAMAGE_EFFECTS`, on a skill only) add the
  skill's evaluated `damageMultiplierBonus` (292) postPercent to EM 114 / explosive 116 / thermal 118 / kinetic 117 of
  every charge requiring the skill (+25 % at V); the specializations' 1851 `selfRof` adds its `rofBonus` (293)
  postPercent to the speed (51) of every module requiring it (−10 % at V, T2 launchers). Effects 152 / 163 already
  multiply 292 / 293 by the level, so the code effects never do; skills are stacking-exempt. Every other code effect (reps, webs, neuts, cap boosters) changes no attribute of its own ship: read
  its numbers with `moduleAttribute` / `moduleNumbersOf`. What webs, painters, points and scrams do to their target
  enters the target's evaluation as `incoming` ("Target effects").
- **Trace** steps: `{ source, effect, operation, amount, penalty?, from, to }`; sources are `ship`, `<module name>
  (<key>)` or `<skill> <level>` (`Navigation V`).
- Cost: ~2 ms per TFI evaluation (every skill runs). Re-evaluate only when module states, the fit or lookups change;
  cache a per-pilot skill index if a 44-ship retune is slow.

### Defense and module numbers (`defense.ts`)

- `shipDefenseOf`: per layer `{ hp, resonances, resists` (percent, 2 decimals) `, ehp` (hp ÷ mean resonance) `}`, the
  total `ehp`, `shieldRecharge` (s). `shipTargetingOf`: maxTargetRange, scanResolution, maxLockedTargets.
- `shipCapacitorOf(ship, bundle, activeKeys)`: capacity, rechargeTime (s), `peakRecharge` = 2.5 × capacity ÷
  rechargeTime, `drain` = Σ capacitorNeed ÷ cycle of the active modules, `stable` with `stableAt` (the fraction where
  `10·C/τ·(√c − c)` meets the drain) or `lastsFor` (s, stepped at 0.1 s), and `energyWarfareResistance` (2045) /
  `remoteCapacitorImpedance` (6463), 1 when the hull lacks them. Numbers only: the live level is the page's
  `CapacitorModel` ("Target effects"), and nothing stops when it runs dry.
- `moduleNumbersOf`: the default effect's duration (cycle, s), discharge (capacitor need), range and falloff; `repair`
  by group (local / remote shield, armor, hull), an ancillary armor repairer × `chargedArmorDamageMultiplier` while it
  has paste; `reactivationDelay` (s). `localRepairRates`: HP/s of the active local repairers.
- Fixture checks (`defense.spec.ts`, max skills): bare Rifter 562.5 / 562.5 / 437.5 HP, capacitor 312.5 GJ in 93.75 s,
  shield recharge 468.75 s (= tools-core's `dogma/evaluate`); + 200mm Steel Plates II armor 1312.5 and mass 1,168,250
  kg (Armor Layering V and Advanced Armor Layering V cut the plate's 150,000 kg); + DC II + 2 Multispectrum Energized
  Membrane II armor EM resonance 0.199594 (80.04 %); + Medium Shield Extender II shield 1937.5, signature 42 m; an
  active Multispectrum Shield Hardener II shield EM 0.675 (online: no change); an active 5MN MWD II takes the capacitor
  to 250 GJ; the Large Ancillary Armor Repairer repairs 518, 1554 with Nanite Repair Paste.

## Ship stats with a fit

- `computeShipStats({ dogma: { bundle, hullTypeID, modules, propModKey? }, overrides?, pilot? })` runs the evaluator:
  mass, maxVelocity, agility, signatureRadius, radius, warp speed and align time come from the evaluated ship, plus
  `defense`, `capacitor` (with the active modules running) and `targeting`, `math: 'dogma'`. `propModCycleTime` is the
  prop module's cycle whatever its state; `propModActive` is it running. `applied` lists the changing steps of the
  flight four. `dogmaShipStats(ship, ...)` does the same for a ship the caller evaluated (the hub, for its trace).
- Without `dogma` the table path runs unchanged, with `math: 'table'` and `defense` / `capacitor` / `targeting` null.
- **Parity** (`ship-stats.spec.ts`): TFI, Guardian, Revelation and Rifter, bare and with each of the 13 baked prop mods,
  max skills and untrained: the dogma path equals the table path (mass, maxVelocity, agility, signatureRadius,
  alignTime, propModCycleTime) within 1e-9 relative. It guards the SDE against `SHIP_SKILLS`; re-check both when CCP
  rebalances.
- **`ship_stats` `fit`** (EFT text; `type` defaults to its header's hull; not with `propMod`): the hub resolves each
  unique name (`TypeByName`, 16 at a time; not-found and invalid names become `unknown`), types the fit, fetches
  `Bundle([hull, ...fittingTypeIDs])` merged with `Skills()`, and answers `fit` (modules by key with slot, category,
  offline, charge, prop; drones; unknown; warnings), `stats` (modules online, prop mod off), `withPropMod` (the prop
  module active, unless fitted offline) and `propMod` (its numbers). `active` (selectors; an unmatched one is an
  error, offline or unknown ones are left off with `activeNote`) adds `withActive: { modules, stats }`. Turret rows add their combat numbers
  (`turretCombatNumbersOf`: `damage` per shot by type, `volley`, `dps`, `tracking`, `signatureResolution`, a vorton's
  `explosion`, a disintegrator's `spool`), and `stats` / `withPropMod` / `withActive.stats` add `weapons`
  (`shipWeaponsOf`: turrets, volley, paper DPS and DPS by type) when the fit has guns; empty guns first load a fitting
  cargo charge (`loadCargoCharges`, as the page does). Numbers and rules: `sd-combat`. `trace: true`
  adds the dogma steps behind the flight, HP, resonance and capacitor attributes. Without an SDE (or without
  DogmaData) the hull flies with the fit's prop mod (`readEftPropMod`, baked numbers when tools-core is down) and a
  `fitNote`. The `GET /ship-stats` route takes no fit (query length).
- **Not modelled**: implants and boosters, command burst buffs, heat, drones, fitting resources and slot counts, the
  ship's own capacitor use, modules stopping when it runs dry, cap boosters (the L3 follow-up
  `live-capacitor-for-fitted-ships`; the live level only takes capacitor warfare: "Target effects"), server tick
  rounding.

## The page: fitted ships fly by their fit (`fittings.ts`)

- **`FitLookup`** (one per page session, the director's `fits` option): `/fit/type?name=&hull=` once per exact name,
  `/dogma/types?ids=` for every id asked for in one turn of the event loop (at most 200 per request), `/dogma/skills`
  once; every answer lands in one merged bundle. A name the EVE data lacks (400 / 404) is `unknown`; no answer, 502,
  503 or 504 is retried after 1 s and 3 s (a 44-ship load once met a dropped tools-core connection, which a cached
  failure would have kept for the whole session), then cached as unavailable. Failures are forgotten on every load /
  open (`ForgetFailures`). `Prepare({ text, typeIDs })` runs a fit's names, then its types and the skills; it never
  rejects. `ShipStats` memoizes `computeShipStats` per bundle and input, so the 44 TFIs ships evaluate their 13 fits once
  per bundle (~2 ms each); an input with incoming target effects skips the memo (per-cycle falloff values would pile
  up in it).
- **`ResolveShipFitting({ doc, scene, lookup, hullTypeID, hullNote, propMod, fallback })`** is synchronous over the
  caches and returns `{ text, key, default?, fitting, modules, dogma, pending, note, typeIDs }` (null without a fit or a
  fallback). `fallback: { text, key }` is the fit of a ship without one: the director's default weapons fit
  (`sd-weapons`), keyed `default` and flagged `default: true`; the ship's own fit always wins. So **an unfitted ship
  with an SDE hull rides the dogma path too**. After `WithPropMod`, `loadCargoCharges` gives each turret or launcher
  without a charge the first fitting cargo charge, and a launcher with none there the hull race's default missile
  (`sd-weapons` → Default missiles; its id joins `typeIDs`); rows show `charge` and the note `loaded from cargo` /
  `default missile` / `no charge loaded`, and the charge enters dogma as `chargeTypeID`. Pending names keep the
  text's provisional keys and are not `unknown` yet. `dogma` is set once every name has settled, the hull's type is known
  (the ship's `/ship-stats` answer: a ship flies as its `type`, whatever its fit's header says), and the hull, modules,
  charges and skills are in the bundle; otherwise `note` says why (`resolving 3 of the fit's 40 names`, `waiting for the
  hull's EVE type`, `the fit's modules need the EVE data: ...`) and the ship flies the table path. A module type the SDE
  lacks is left out with a note.
- **The prop module** (`WithPropMod`, after the names land): the fit's first group-46 module. An explicit
  `propMod.module` that names another (by type, or by name; `mwd` / `ab` always by type) replaces it (same key, a note);
  on a fit with none, the ship's prop mod is added as the next `mid-<n>` (`prop: true`, a note); `"none"` leaves the fit's
  own offline. A non-explicit mismatch (the `/prop-mod` lookup still pending, its stand-in differing) keeps the fit's.
- **The director**: `Flight` resolves the fit beside the prop mod and passes `dogma` to `ResolveFlight` (`sd-destiny`
  physics); `Retune` calls `LookupFit` after `SetFlight`, which `Prepare`s a pending fit (or a fit waiting on its hull,
  to resolve the names meanwhile) and retunes the ship when it lands, if its fit text is unchanged; a resolution still
  pending then (a replacing prop mod's type) prepares once more. The prop mod lookup's and the hull lookup's callbacks
  call it too. A fit change arrives as `retuned` (`sd-scene-document`). For a ship without a fit, `LookupFit` first
  runs `LookupTypes([hull])` (the default weapons need the hull's dogma record) and retunes when it lands; its "same fit"
  check compares the text it resolved, the document's or the default's (`FitTextOf`).
- **`get_state`** per ship: `fit` (null without one) `{ name, key, hull, typeID?, unknown, modules: [{ module, name,
  state, charge?, prop?, note? }], drones, math, note? }`, rows compact; `defense` `{ shield | armor | structure: { hp,
  max, resists, ehp }, ehp, shieldRecharge }` (C4: hp = max, the static evaluation); `capacitor` (rounded; with the prop
  mod's drain while it runs). Both null on the table path. Module states in C4: `offline` (`/OFFLINE`, or the prop
  module under `"none"`), `online`, and the prop module's Destiny state while it runs (`off` reads `online`). Per fleet,
  `modules` counts every member's rows by state (offline, online, activating, active, stopping, reactivating).
- **verify-page**: "the dogma path matches tools-core's evaluation on a bare hull" (a Rifter with `[Rifter, Bare]`: 18
  HP, resist and capacitor values equal `dogma/evaluate` with Shield / Armor / Hull Upgrades, Mechanics, Capacitor
  Management and Operation at V); "a fitted TFIs fleet reports fit-driven defense" (all 44 on dogma, `tfis-fc` armor
  52,527.2 HP = `ship_stats { fit }` for `tfis/tfi`, 23 modules online, 2026-10-22).

## Module activation (`switch_modules`, C5)

Live only (never in the document; a fit's `/OFFLINE` is the persistent offline marker). Node-tested: `module-cycle.ts`,
`modules.ts`, `damage.ts`, `fitting/switch.ts`, `fitting/activation.ts`.

- **States**: `offline`, `online`, `activating` (applies at the next 1 s tick boundary), `active` (cycling: get_state
  `cycle: { number, endsIn }`), `stopping` (runs to its cycle end, rounded up to a tick: `CycleEnd`), `reactivating`
  (after a stop, for `moduleReactivationDelay`, 669). Passive modules only go online / offline; rigs and subsystems
  refuse offline.
- **Gate and activations** (Combat rules): `ModuleCycle.Boundary(boundary, { hold })` keeps an activating module
  waiting with the hold as its note (a turret's lock: `ShipModulesPort.LockHold` = `ShipLocks.Hold`); without
  `LockHold` nothing waits. `activations` counts `on` events and every event carries `activation` (it keys the shot
  rolls). `ShipModules.Spec(ship, key)` returns a module's spec; a turret's carries `combat`
  (`turretCombatNumbersOf`, from `ShipModuleSpecsOf`'s evaluation). `Remove(id, boundary, why)` names why the modules
  on it stop.
- **Rules** (the prop mod's, generalized; `ModuleCycle`): `active` on online → activating, on stopping → active again,
  on reactivating → queued until ready (`activatesIn`), on offline → onlined and activated at the same boundary. `online`
  cancels an activation, stops a running module at its cycle end, and onlines an offline one at the next boundary.
  `offline` stops a running module at its cycle end and then takes it offline; the rest go offline at the next boundary.
  A pilot `delay` (`toPilotDelays`, key `modules|fleet|wing|squad`) queues the switch to its tick (`respondsIn`).
- **Events**: `on`, `cycle` (cycle n starts), `end` (cycle n ends), `off` (with `why` when it stopped on its own). A
  cycle boundary between ticks fires at the first tick boundary at or after it; `cycle` and `end` carry `at`, the exact
  fractional master tick (cycle n starts at since + (n − 1) × cycleTicks), which the turret shots draw on (`sd-weapons`). Online / offline transitions fire no
  event: the director compares the live states instead (below).
- **What runs** (`moduleActivationOf`, from the ship evaluated with its live states, so skills, hull bonuses and triage
  apply): category 1 and 2 default effects activate; cycle = the default effect's duration (10 s when it has none).
  Turrets and launchers run (`weapon`, `sd-weapons`: a launcher is `targeted` though its `useMissiles` is category 1,
  reach Infinity); refused: bomb launchers 862, a launcher without a missile loaded (`NO_MISSILE_REFUSAL`, "it has no
  missiles loaded"), MJD 1189, MJFG 1533, cloaks 330, cynos 658, bubbles 899, smartbombs 72, ECM bursts 80, passive
  modules. Webs, painters, points, scrams, neuts, nos and cap transmitters act on their target
  (`activation.targetEffect`, "Target effects"). Without effect, with a `note`: sensor dampeners and ECM (`locks are not
  modelled yet`), weapon disruptors (`weapons are not modelled yet`), cap boosters (`cap boosters do not refill the live
  capacitor yet`), command bursts; any other targeted module with neither `repair` nor `targetEffect` notes `cycles
  without effect on its target yet`.
- **Group limits**: activation beyond the evaluated `maxGroupActive` (763) is refused; modules beyond `maxGroupOnline`
  (978) start offline with a note, and onlining one is refused.
- **Targeted modules** (default effect category 2) need `target`: another ship in the scene. Distance is
  surface to surface on the EVE radii (`DestinyWorld.SurfaceDistance`). Refused beyond `activation.reach`
  (`moduleReach`: optimal + 2 × falloff; Infinity for turrets and untargeted modules), on its own ship, on a ship in
  warp, or while running on another target. **Turrets** differ (`sd-weapons`): their target is the ship's
  (`set_target`), may be an authored object (port `HasObject`), and a running one given another target retargets at
  its next cycle (`ShipModules.Retarget`) instead of being refused. `effectiveness` =
  `0.5^((max(0, d − optimal) / falloff)²)` scales repairs and target effects. A running one whose target drifts out of
  reach stops at its cycle end (`its target is out of range`); target removed or in warp: it stops at once (`its
  target is gone` / `entered warp`). Each running targeted module keeps `applied`, its effectiveness at its latest
  cycle start (`on` carries cycle 1); a stopping one keeps its cycle's effect until `off`. `Targeting(target)` /
  `TargetIndex()` list the running targeted modules on a ship (turrets excluded) with `applied`.
- **Remote repairers lock** (logi L2): they are lock-gated like weapons (`IsLockGated`: a weapon, or
  `activation.repair.remote`). Switched on before the lock completes they wait in `activating` with the lock note; a
  lost lock stops them at their cycle end; ships without targeting numbers repair unlocked. `SwitchModules` requests
  the lock on the switch's target for switched remote repairers. `LockAims()` (was `WeaponAims`) lists what every
  lock-gated module running, stopping or engaged aims at, a pending retarget included: the director's `WantedLocks` and
  `RequestLock` keep those locks. Webs, scrams, points, neuts, nos, transmitters and EWAR still run unlocked.
- **The retarget option** (`SwitchModuleOptions.retarget`, auto-repair only): a lock-gated module running or stopping
  on another target takes the new one at its next cycle start once locked (`entry.retarget`, the weapon path; a
  stopping one resumes, so the old cycle still lands on the old target). Without it a remote repairer on another
  target is refused (`it is running on "x"; switch it online first`). The first `cycle` event on the new target carries
  `retargeted: true`; `ModuleFxCommands` turns it into `start`, so `ModuleEffects.Start` discards the old beam and
  draws one to the new target, and `ModuleAudioPost` posts the start sounds. `RemoteRepairers(id)` lists a ship's
  remote repairers that can run (`{ key, spec, state, target, retarget? }`, fit order).
- **Warp**: entering proper warp (`OnWarp` enter) stops at once every running module that is not warp safe and every
  targeted one, plus every module targeting the ship. The prop mod already did this in DestinyWorld.
- **The prop mod** stays DestinyWorld's: `switch_modules` on the `prop: true` module calls `PropModRefusal` /
  `SwitchPropMod` exactly as `switch_prop_mods` does (offline refused; its row maps `off` → `online`). A second group-46
  module (or the fit's own under `propMod.module "none"`) is refused. **Duplication** (the plan's §2.7 fallback):
  DestinyWorld keeps its own prop mod code, so `destiny.spec.ts` stays untouched, and `ModuleCycle` copies its rules
  (`SwitchPropMod`, `ApplyPropMods`) for the other modules. A timing rule changed in one must change in the other.
- **Director wiring**: `ShipModules` over the world port; `world.OnBoundary` → `modules.Boundary` (right after
  `ApplyPropMods`, before orders: `sd-destiny`); `OnWarp` enter → `OnWarpEnter`; ship removal → `Remove` + damage
  `Remove`; a load → `Clear`. `Flight` passes `LiveDogma` (the fit's dogma modules with the layer's states through
  `DogmaStateOf`, by key and type id; the prop key untouched), so HP, resists, capacitor drain, signature (a suppressor)
  and siege / triage physics follow the running modules. `SetFlight` → `SyncModules`: `ShipModuleSpecsOf` (every resolved
  module but the prop mod, evaluated with live states) goes to `SetFit` when its JSON changed; states carry over by
  (key, type id), a running module that vanished stops (`refitted`) and the flight is recomputed once. `ModuleEvents`
  (each boundary, warp, removal) re-flies every scene ship whose `FlownKey` (live states + the incoming target effects
  and their `applied`) differs from the one it flies, then lands the repairs and capacitor transfers. Cost: a key per
  ship per tick (one `TargetIndex()` pass); the evaluations are memoized by fit and states, and bypass the memo only
  with incoming modifiers.
- **Selectors** (`selectFittedModules`): a key, a category, a weapon kind (`turret`, `launcher`), `all`, or a name.
  A running module's row carries `cycleTime` (s, 2 decimals); a running turret's `nextTarget` until it retargets.
- **Result**: `{ tick, state, ships: [{ id, modules: [{ module, name, state, at?, stopsIn?, activatesIn?, respondsIn?,
  target?, effectiveness? }] }], skipped: [{ id, module?, reason }] }`. Skipped: a ship without a resolved fit, a
  selector matching none of a ship's modules (`module` = the selector), every refusal (`module` = the key). A `target`
  naming no ship throws.
- **get_state rows** (`ShipModuleRowState`): `module`, `name`, `state` always; `cycle`, `at`, `stopsIn`,
  `activatesIn`, `readyIn`, `respondsIn`, `target`, `targetDistance`, `effectiveness`, `note` when they apply. Fleet
  `modules` counts the rows by state.

## The damage model (`damage.ts`, C5)

- Per fitted ship (the dogma path only): `{ hp, max, resonances }` per layer, `shieldRecharge`, `repairs` (HP/s of the
  running local repairers) and `incoming` (`{ from, module, layer, amount, cycleTime, effectiveness }`).
- `SetDefense` on every `SetFlight`: current HP starts at max; when max changes the fraction is kept, clamped to max.
- Repairs land at cycle events (`RepairLandings`): shield boosters at `cycle` (including the first, at `on`), armor and
  hull repairers at `end`; remote ones on their target × effectiveness; ancillary armor reps × their charge multiplier
  while paste is loaded (`moduleNumbersOf`).
- `ApplyHit(id, damage)` (Combat rules, `sd-combat`): raw damage shield first, then armor, then structure, each through
  its resonances, the unabsorbed share spilling on (`applyLayeredDamage`); `Destroyed(id)` at 0 structure.
  `Recharge(seconds)` runs the passive shield recharge (`passiveRecharge`, the capacitor's curve; `CapacitorFractionAfter`
  calls it too) at each boundary. `Damage(id, layer, amount)` stays for specs. get_state's `defense` is `Report`: hp,
  max, resists, ehp of the current HP, `repairs`, `incoming`.
- **`set_hp`** (`sd-combat` → Battle damage): `Health(id)` (per layer `{ hp, max }`, null untracked; auto-repair reads it
  too), `SetHp(id, hp, record)` (each layer clamped to [0, max], the record kept: the only way a set changes HP),
  `HpSet(id)` (the latest set; `SetDefense` keeps it, a ship leaving the model drops it with its HP), `DestroyedShips()`
  (tracked ships at 0 structure, by id: Combat rules' sweep).
- verify-page (2026-10-23, SDE 3632936): "switch_modules runs a Guardian's armor hardener" (Domination Thermal Armor
  Hardener: thermal 44.75 % → 75.14 % from the next tick, back after `online` and its 24 s cycle end; DC II refused as
  passive, an unmatched `weapon` selector skipped); "switch_modules prop matches switch_prop_mods" (the 10MN AB II
  through Destiny, 650.7 m/s; `switch_prop_mods` off reads `stopping` in its row; offline refused); "remote reps take a
  target and stop when it is removed" (two Large Remote Armor Repairer II on a TFI 3 km off: refused without a target,
  then `incoming` on the TFI, stopped with `its target is gone` on `remove_ship`). The Guardian's Large RAR II reaches
  57.6 km optimal + 16.8 km falloff in this build (14.4 km base, +300 % Amarr Cruiser V). Since logi L2 the same check
  sees the reps wait in `activating` with `waiting for its lock on "tfi"` while the lock is `locking` (lockTime 1.937
  s), run once locked 2 ticks later, and the TFI's `combat.repairs.lastReceived` shows two rows from `logi` 6 ticks
  after activation with `nominal` 512 and `amount` 0 (full armor).

## Target effects (webs, painters, points, scrams, capacitor warfare)

Running targeted modules change the ship they run on, from the SDE's numbers (build 3632936, checked against
tools-core 2026-10-22; max skills):

| Module (fixture type) | Default effect | On the target | Numbers |
|---|---|---|---|
| Stasis Webifier II (527), Federation Navy Stasis Webifier (17559) | 6426 `remoteWebifierFalloff`, code effect | `maxVelocity` (37) postPercent `speedFactor` (20), penalized; resistance 2115 | −60 %, 10 / 14 km, no falloff; a Vindicator's −90 % (`shipBonusMB` 10 %/lvl) |
| Target Painter II (19806) | 6425 `remoteTargetPaintFalloff`, code effect | `signatureRadius` (552) postPercent `signatureRadiusBonus` (554), penalized; resistance 2114 | +37.5 % with Signature Focusing V (30 % base); 36 km + 90 km falloff |
| Warp Disruptor II (3244) | 39 `warpDisrupt` | SDE `ItemModifier targetID`: 104 modAdd 105 | +1; 24 km |
| Warp Scrambler II (448) | 5934 `warpScrambleBlockMWDWithNPCEffect` | 104 modAdd 105; `LocationRequiredSkillModifier targetID` 1349 on skill 3454 (MWDs) = the MWD block; the NPC postAssign (1470) skipped | +2; 9 km |
| Heavy Energy Neutralizer II (12271) | 6187 `energyNeutralizerFalloff`, resistance 2045 | drains `energyNeutralizerAmount` (97) | 600 GJ / 24 s; a Bhaalgorn's 1050 |
| Heavy Energy Nosferatu II (12263) | 6197 `energyNosferatuFalloff`, resistance 2045 | moves `powerTransferAmount` (90) to the shooter | 120 GJ / 10 s; a Bhaalgorn's 210 with `override` |
| Remote capacitor transmitters (16487) | 6184 `shipModuleRemoteCapacitorTransmitter`, resistance 6463 | gives 90 | 311 GJ / 5 s (Large Inductive Compact); a Guardian's Large RCT II 351 |

- **Source** (`moduleTargetEffectOf(ship, bundle, key)`, on the shooter evaluated with its live states, so skills and
  hull bonuses apply; `moduleActivationOf` carries it as `targetEffect`): only a category-2 default effect. Each SDE
  `ItemModifier` on domain `targetID` / `target` becomes a `TargetModifier` (amount = the module's evaluated modifying
  attribute); assigns (−1, 7) are skipped; the scram's skill-3454 `activationBlocked` modifier sets
  `blocksMicrowarpdrive`. Code effects by name, as Pyfa: webs, painters, neuts, nos (`override` when the module's
  evaluated `nosOverride` 1945 > 0: the Blood Raider hulls' effect 5854), transmitters. Null for remote reps (they have
  `repair`), damps, disruptors and ECM.
- **Scaling**: × the module's `applied` effectiveness (falloff at its latest cycle start, kept for the cycle; a stopping
  one keeps its cycle's effect until `off`). Additive and percent amounts × e, multipliers `1 + (m − 1) × e`
  (`scaleModifierAmount`). × the target's resistance: the effect's `resistanceAttributeID`, else the module's
  `remoteResistanceID` (2138), read on the target's evaluation (Titans 0.2 web / damp, supercarriers 0.5); a hull
  without it and a bundle without its record give 1, never 0 (`dogmaResistanceOf`).
- **Dogma path**: `evaluateShipDogma({ incoming })` adds each as a synthetic category-7 source on the ship, so stacking
  treats it as a module: a web shares the negative postPercent maxVelocity chain with the ship's own penalized
  modules. Trace steps name `<ship>: <module name> (<key>)`. (The Large Trimark Armor Pump's drawback is agility, not
  velocity: the chain spec uses synthetic modules.)
- **Table path**: `computeShipStats({ incoming })` applies 37 and 552 after the prop mod step through
  `applyIncomingModifiers` (non-stackable, `applied` steps), and 104 modAdd / modSub onto `hull.warpScrambleStatus ??
  0`. Table ships resist nothing. Parity: one web on a bare TFI, Guardian and Rifter gives the same max velocity on
  both paths.
- **`ShipStats.warpScrambleStatus`** (104, "if greater than zero the ship cannot warp"): the hull's 0 (−2 on a
  Venture), a running Warp Core Stabilizer II −2 (effect 8121 makes it an active module), siege and triage +100 (852
  `siegeModeWarpStatus`), plus each point and scram.
- **The flight**: `ResolveFlight({ incoming })` gives it to both computes, so a running MWD's numbers are webbed too.
  `FitLookup.ShipStats` bypasses its memo with incoming; a ship re-flies only when its `FlownKey` changes. The
  director builds incoming from `Targeting(id)`; with incoming it also resolves the flight without it
  (`unaffectedFlights`, a memo hit) for `speedFactor` / `signatureFactor`. Destiny sees new numbers through
  `SetPhysics` only (`sd-destiny`); align time is unchanged, as in EVE.
- **Tackle**: `FlyFlight` calls `DestinyWorld.SetTackle(id, TackleOf(...))` after `SetPhysics`: `warp` =
  `warpScrambleNoteOf` when the status is above 0; `propMod` = `microwarpdriveBlockNoteOf` of the running
  `blocksMicrowarpdrive` modules on a ship flying an MWD. DestinyWorld enforces them (`sd-destiny` "Tackle"):
  warps refused and cancelled, a scrammed MWD off at once and kept off. Afterburners are unaffected.
- **Capacitor warfare** (`CapacitorModel`): every dogma-path ship has a live level (`SetFlight` → `Set` from
  `flight.capacitor`, else `Remove`; full at first, a new evaluation keeps the fraction; `Remove` / `Clear` beside the
  damage model's). `ModuleOutputs` lands `CapacitorLandings(events)` after the repairs: at each `cycle` event (cycle 1
  with `on`) of a module with `targetEffect.capacitor`, amount × the event's effectiveness × the target's 2045 (neut,
  nos) or 6463 (transmitter). A neut drains at most the level, a transmitter gives at most capacity − level, a nos
  drains only while the target holds more than the shooter and never below the shooter's level (absolute GJ, EVE's
  rule since Odyssey 1.1) unless `override`; the shooter gains it up to its capacity. Recharge in between:
  `√c(t) = 1 + (√c0 − 1)·e^(−5t/τ)`, the closed form of `10·C/τ·(√c − c)`, exact for any step. A ship with no live
  capacitor (a fit-less table-path ship: no weapon hardpoints, no EVE type) takes nothing. Unfitted ships with an SDE
  hull fly their default weapons fit (`sd-weapons`), so they have one.
- **get_state**: per ship `targeted`, null when nothing runs on it and it can warp: `{ by: [{ from, module, name,
  category, effectiveness, amount?, cycleTime, moved?, note? }], speedFactor?, signatureFactor?, warpScrambleStatus,
  canWarp, warpNote?, mwdBlocked? }`. `by` lists every running targeted module on it, remote reps included, turrets not
  (they are `set_target`'s); `amount` is per cycle before falloff (a web's percent, a point's strength, GJ, HP);
  `moved` the GJ its latest cycle start moved; `note` `no live capacitor (no fit)` for capacitor warfare on a ship
  without one. `speedFactor` / `signatureFactor`: with the effects over without (absent when 1; `physics` already
  includes them). `capacitor` gains `level` (GJ, 1 decimal) and `fraction` (3 decimals) on a live capacitor, and
  `energyWarfareResistance` / `remoteCapacitorImpedance` when not 1.
- **Not modelled**: the ship's own capacitor use, modules stopping when it runs dry, cap boosters (L3 follow-up
  `live-capacitor-for-fitted-ships`); damps, weapon disruptors and ECM (no locks or weapons yet: follow-up); siege,
  triage and bastion immunity to offensive modules and assistance (follow-up); resistances on table-path ships; MJD and
  bubble tackle (those modules are refused); target effects in `ship_stats`.
- **verify-page** (2026-10-23, SDE 3632936, scene `verify-tackle`): "webs slow their target and points pin it" (a
  Rifter's Stasis Webifier II: a bare TFI 162.5 → 65 m/s and a default-fit Rifter 456.25 → 182.5 m/s, `speedFactor`
  0.4, each back when it stops; its Warp Disruptor II: status 1, `order_ship` warp refused `ship "tfi" cannot warp:
  warp scramble status 1 (tackle: Warp Disruptor II (mid-2) +1): above 0 it cannot warp`, accepted after `online` and
  the 5 s cycle end); "a scram switches its target's MWD off and keeps it off" (the default-fit Rifter's 5MN
  Microwarpdrive II `off: a warp scrambler blocks its microwarpdrive (tackle: Warp Scrambler II (mid-1))` within a
  tick; `switch_prop_mods` and `switch_modules` prop refused; still off after the scram, then switched on); "neuts
  drain and transmitters refill a fitted target's capacitor" (a Guardian's Heavy Energy Neutralizer II moved 600 GJ,
  the TFI 6875 → 6278.4 GJ; its Large Remote Capacitor Transmitter II gave 351 then 238.7 GJ, capped at 6875; a neut on
  a Minmatar Shuttle, no weapon hardpoints so no fit, notes `no live capacitor (no fit)`). The full run: 91 ok, 1 skip
  (no renderer), none failed.
- **Use case** (2026-10-23, own hub on 5521, headless tab): `stage_engagement { sides: [{ composition: "tfis" }, {
  ships: [{ hull: "Ferox", count: 10 }] }], range: 5000 }`. The TFIs ewar squad is 3 Bhaalgorns (one Federation Navy
  Stasis Webifier each, −60 %) and 2 Vindicators (two each, −90 %), all in reach of `red-fc` without an approach.
  `switch_modules { fleet: "tfis", squad: "ewar", modules: ["web"] }`: `red-fc` (a default-fit Ferox) 181.25 → 1.311
  m/s, `speedFactor` 0.007 (= 4 × −90 % and 3 × −60 %, stacking-penalized). The fleet's `point` selector runs 21
  Warp Disruptor IIs (the FC and both dps squads; the Devoters' M-36 bubbles do not match `point`): `warpScrambleStatus`
  21, `canWarp` false; `order_ship red-fc warp` and `order_fleet red warp` refused `ship "red-fc" cannot warp: warp
  scramble status 21 (tfis-fc: Warp Disruptor II (mid-4) +1, ...)`; an untackled Ferox warped off. The note lists
  every source (~1.6 KB for 21 points).

## Module effects and sounds (C6)

Running modules draw what the EVE client draws and play its sounds. Not drawn: weapons, prop mods (their boosters and
sound are `sd-ship-stats`'), siege, command bursts, cap boosters and anything else whose default effect guid is not in
`MODULE_EFFECTS`.

- **Paused**: every module effect holds still with the animation clock (`sd-time`); a beam or overlay replayed at a
  paused landing holds its first frame until play resumes.
- **Catalog** (`fitting/effects.ts`, by the default effect's `guid`; paths and events checked against build 3632936's
  res index and audio library):

  | Kind | Effects (`effects.*`) | File | Sounds (`<size>` = the hull's S / M / L / XL) |
  |---|---|---|---|
  | overlay | ShieldBoosting, ArmorRepair, StructureRepair, ArmorHardening, ModifyShieldResonance | `res:/dx9/model/effect/<name>_skinned.black` | `ship_effect_<size>_shieldboost_play` each cycle; `_armorrepair_play`, `_hullrepair_play`, `_armorhardener_play` loop until their `_stop`; `_shieldhardener_play` once |
  | overlay | Invulnerability, TriageMode | `res:/fisfx/module/{invulnerability,triagemode}_ov_t1a_skinned.black` | `ship_effect_invulnerability_field_play`, `ship_effect_triage_overlay_play` |
  | beam (EveStretch3) | RemoteArmourRepair, ShieldTransfer, RemoteHullRepair | `res:/fisfx/module/<name>_st_t1a.black` | `remote_shipeffect_switch_size_<size>`, `remote_shipeffect_switch_duration_<cycle ms>`, then `remote_armorrepair` / `remote_shieldbooster` / `remote_hullrepair`, at the start and **every cycle** (the event lasts about one cycle); `remote_shipeffect_stop` on a stop |
  | beam (EveStretch) | EnergyTransfer, WarpScramble, WarpDisrupt, EnergyDestabilization, EnergyVampire | the same folder | none in the library |
  | trigger | ModifyTargetSpeed (web) | `res:/fisfx/module/stasisweb_tr_t1a.black` | none |

- **Commands** (`ModuleFxCommands`): `on` → `start`, `cycle` n > 1 → `cycle`, `off` → `stop`; `end` gives none. A
  beam or trigger needs the module's `target` (except a stop). Overlays play on the module's ship, beams from it to the
  target, the trigger at the target.
- **Sounds** (`ModuleAudioPost`, posted by `Director.ModuleOutputs` through `PageAudio.Post` on the module's ship's
  emitter, beams included): `<size>` from `HULL_SIZE_CLASSES[RigSizeOf(...)]` as the prop mod's; the duration switch is
  the nearest of `MODULE_EFFECT_SOUND_DURATIONS` to the cycle. A stop posts the `off` events and stops the loops the
  start began (the Web Audio backend ignores authored stop relationships). A removed ship posts nothing: its emitter is
  released with it.
- **Drawing** (`ModuleEffects`, created only with a renderer; one effect per key: `loading`, `live` or `failed`):
  - Each file loads once (`ResourceValues`); every start hydrates a new object from it inside `PageAudio.Detached`,
    and a beam's own `audio` / `stretchAudio` are dropped, so nothing plays twice and no emitter registers.
  - **Overlay**: `ship.AddOverlayEffect` once the hull is built (its curve set plays on load and is replayed each cycle:
    `ResetTimeRange` + `Play`); on a stop it stays until the last replay's curve set ends (`GetMaxCurveDuration`: 1 s
    shield boost, 6 s armor / hull repair, 10 s shield hardener, suppressor and triage, 20 s armor hardener), then
    `RemoveOverlayEffect` and `Destruct()` of its Tr2Effects. A rebuilt hull gets a fresh overlay.
  - **Beam**: added to `scene.objects` and `StartFiring(0)` on its first placement; ends written every frame (before
    `engine.Frame`) from the drawn ClientBall positions into its loaded `source` / `dest` Tr2TranslationAdapters' `value`
    (`sd-runtime`: why not `SetFiringTransform`); re-fired each cycle (EveStretch `StartFiring(0)`, EveStretch3
    `PlayCurveSet('play_start')`); a stop `StopFiring()`s it and removes it `BEAM_LINGER` (2 s) later.
  - **Trigger**: the web's EveTransform (curve LOD off) inside a new EveRootTransform on the target's curves, scaled to
    2 × the target's drawn radius ÷ 2.7 m (its authored size); played each cycle, removed `TRIGGER_LINGER` (5 s) after
    its last play once the module stops.
  - Every frame (`DriveModuleEffects`, after `DriveAudio`): a beam whose ship or target is gone and an overlay whose
    ship is gone are removed. A load clears every effect after the modules' stop commands. Teardown retires the root
    through `RetireShips` against every other live root (ships, dressing, objects, effects).
- **get_state**: `renderer.moduleEffects` `{ live, loading, failed, errors }` (the 5 latest errors; a failure is also a
  `console.warn` in `page_log`).

### Real-GPU evidence (2026-10-23, Windows Chrome, RTX 40 series, SDE 3632936)

Scene (`.scratch/c6-gpu/` on dbxpc: `scene.json`, `setup.sh`, screenshots): a Guardian (Domination Thermal Armor
Hardener, DC II, 10MN AB II, 2 × Large Remote Armor Repairer II, Heavy Energy Neutralizer II, Large Remote Capacitor
Transmitter II) on a bare TFI 3 km off; a tackle Rifter (Stasis Webifier II, Warp Scrambler II, Warp Disruptor II) on
the TFI; a Rifter with Small Armor Repairer II, Thermal Armor Hardener II, Medium Shield Booster II and Multispectrum
Shield Hardener II. All 12 effects live, 0 failed, `gpuErrors` 0, 60 fps, no warnings in `page_log`;
`audio.gameObjects` stayed the page's 2 emitters plus the listener.

- **Beams**: remote armor repair (teal stream), neut (thin line with a travelling flare), cap transfer (a ~3 s pulse of
  each 5 s cycle, impact flare at the target), scram (blue), point (faint green strands) all run from the shooter to the
  target (`rar-beams.png`, `neut-beam.png`, `cap-transfer-beam.png`, `scram-beam.png`, `point-beam.png`).
  **`EveStretch.SetFiringTransform` turned every EveStretch beam away from its target** (it marks the stretch -Z
  forward: the turret muzzle path), so beams write their adapters instead.
- **Web**: a bluish field around the TFI, sized to it (`web-trigger.png`).
- **Overlays on an animated hull** (the Rifter, `isAnimated` true): an on / off A/B shows the hardener's lit pattern
  and glints on the hull (`overlay-rifter-on.png` vs `-off.png`); replays measured (the shield hardener's curve time
  restarts each 10 s cycle). Subtle at 75 m, as in the client.
- **Overlays on a non-animated hull** (the Guardian, `isAnimated` false; only `_skinned` overlay files exist): the
  overlay emits its additive batch every frame (an `emitOverlayBatches` probe) with no GPU error, but nothing visible
  changes in an A/B (`overlay-guardian-on.png` / `-off.png`). Follow-up.
- **Teardown**: switching every module `online` emptied the effects as timed (12 → 3 at +4 s → 1 → 0 by the hardener's
  20 s curve), left no overlay on either hull and only the 4 ships in `scene.objects`, and stopped every loop
  (`GetPlayingEvents` empty). Removing the target took its beams and web at once; a `load_scene` cleared the rest.
- **Sounds** (measured, not heard: `posted` with `played` true, and the emitter's `GetPlayingEvents`):
  `ship_effect_S_shieldboost_play` each 3 s cycle; `ship_effect_{S,M}_armorhardener_play` and
  `ship_effect_S_armorrepair_play` looping until stopped; `ship_effect_S_shieldhardener_play` once;
  `remote_shipeffect_switch_size_M`, `remote_shipeffect_switch_duration_6000`, `remote_armorrepair` (plays ~6 s, so it
  is posted every cycle) and `remote_shipeffect_stop`. Not posted in this check: the hull repairer, suppressor and
  triage sounds, and the shield transfer / remote hull beams (same code path as remote armor).

## Why not tools-core's `fitting/parse`

`POST /eve/<b>/fitting/parse` drops `/OFFLINE`, fails the whole text with a 400 on a `Module, Charge` line or any
unknown name, and marks cargo `xN` modules as fitted. C2 uses it only to resolve one name at a time
(`[<hull>, x]\n<name>`).
