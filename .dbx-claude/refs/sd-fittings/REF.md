# Fittings: EFT fits on ships, the parser, fit keys

> Ships carry real EVE fits. Fetch before touching `packages/scene/src/lib/fitting/`, a ship's `fit` or the document's
> `fits`, `compositions/expand.ts`'s fit keys, staging's `fit` lines, or anything that reads EFT text. The prop mod
> itself (numbers, switching, audio): `sd-ship-stats`; compositions and `cjs-fleet/1`: `sd-fleets` → `compositions`;
> `add_ships` / `stage_engagement`: `sd-staging`.

**Status (2026-10-22)**: slices C1-C3 of the fitted-modules plan
(`~/.claude/plans/fitted-modules-eft-fits-parsed-into-typed-modules-fit-driven-ship-stats-module-a.md`) are in: fits
are parsed and ride on scene ships, the hub resolves fit names and serves dogma bundles, and the dogma evaluator
computes a fitted ship's HP, resists, capacitor, targeting and flight numbers, which `ship_stats` reports for a `fit`
(below). Not yet: the page flying fitted ships and reporting HP / resists (C4), module activation (`switch_modules`) and
the damage model (C5), module effects and sounds (C6). Until C4 the page ignores a fit except through the prop mod a
composition line writes into `propMod`. Research behind the design: the dbx-claude note
`fitted-modules-dogma-and-module-effects-research`.

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
| `fitting/categories.ts` | `MODULE_CATEGORIES`, `moduleCategoryOf` (group, refined by effect: scram / point, siege / triage, weapons) |
| `fitting/defense.ts` | `shipDefenseOf`, `shipCapacitorOf`, `shipTargetingOf`, `moduleNumbersOf` (cycle, capacitor need, range, falloff, repair), `localRepairRates` |
| `stats/ship-stats.ts` | `computeShipStats`'s `dogma` input and `dogmaShipStats` (the dogma path, below) |
| `apps/scene-director/src/lib/hub/ship-stats-tool.ts` | `ship_stats`' `fit`, `active` and `trace` (`ResolveFit`, `AnswerFitted`) |
| `fitting/fitting.spec-helper.ts` | `DOGMA_FIXTURE` (read from disk), `fixtureAnswer` (a `/fit/type` name table), `fixtureHullStats`, hull ids |
| `fitting/dogma-bundle.ts` | `DogmaBundle` / `DogmaTypeRecord` / `DogmaEffectRecord` / `DogmaAttributeRecord` / `FitTypeAnswer`, `mergeDogmaBundles`, `readDogmaBundle`, `readFitTypeAnswer`, `fitTypeCategoryOf` |
| `fitting/fixtures/dogma-3632936.json` | the committed dogma fixture (below); never imported by the package (it would ship in the page bundle): specs read it from disk |
| `apps/scene-director/src/lib/hub/sde-client.ts` | `SdeClient`: build pin, `GetJson` / `PostJson`, `Cached`, `Type`, `TypeDogma` (with the default effect), failure mapping, readers; `ShipData` delegates to it |
| `apps/scene-director/src/lib/hub/dogma-data.ts` | `DogmaData` (`TypeByName`, `Bundle`, `Skills`), `FIXED_ATTRIBUTE_IDS`, `MAX_DOGMA_TYPE_IDS` |
| `apps/scene-director/src/lib/hub/dogma-data.testing.ts` | `DogmaFixture`, `DogmaRoutes` (tools-core routes rebuilt from the fixture), `MakeRoutedDogmaData`, `MakeFakeDogmaData` |

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
`DEFAULT_PROP_MOD_MODULE` (the hull-sized MWD). The page's director adopts it in C4; today it still reads
`propMod.module ?? DEFAULT_PROP_MOD_MODULE`, which matches for composition ships (their `propMod` is explicit).

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
- **`Bundle(ids)`**: `types/<id>?lang=en` (name, group, category, published, the `mass` / `radius` / `capacity` /
  `volume` columns) + `sde/typeDogma/<id>` (attribute values, effect ids, the `isDefault` effect); then every effect
  the types carry (`sde/dogmaEffects/<id>`: `effectCategoryID`, `guid`, `isWarpSafe`, `isOffensive`, `isAssistance`,
  the duration / discharge / range / falloff / tracking attribute ids, `modifierInfo`); then the attributes those
  modifiers and effects name, `FIXED_ATTRIBUTE_IDS`, and each record's `maxAttributeID` (`sde/dogmaAttributes/<id>`:
  `stackable`, `highIsGood`, `defaultValue`). Attribute values a type has but no effect names get no record. 16
  requests at a time; records are cached per hub.
- **`Skills()`**: `sde/groups?field=categoryID&value=16` (25 groups) → `sde/types?field=groupID&value=<g>` → the
  published ones → `Bundle`. Build 3632936: 512 skills, 726 effects, 686 attributes, ~440 KB.
- The page never sends a whole fit to the hub (the HTTP layer is GET-only and Node's 16 KB header limit rules out EFT
  text in a query): it parses the fit itself and resolves names one `/fit/type` at a time (C4).

### The fixture (`fitting/fixtures/dogma-3632936.json`)

The merge of `/dogma/types` for 6 hulls (587 Rifter, 17732 TFI, 11987 Guardian, 19720 Revelation, 22474 Damnation,
37604 Apostle), the 13 `BAKED_PROP_MODS` and 24 modules (plates, membranes, DC II, extender, hardeners, local / remote /
ancillary reps and paste, booster, scram, point, web, cap transmitter, siege, triage, suppressor, rig, neut, a turret)
with `/dogma/skills`: 555 types, 814 effects, 764 attributes, 514 KB. Specs read it from disk (`readFileSync`), the
hub's through `DogmaFixture()`. **Re-capture when CCP rebalances** (and re-check the stats parity spec, C3):

```sh
node bin/scene-director.js serve --port 5521 --scenes /tmp/sd/scenes --fleets /tmp/sd/fleets &   # tools-core on 5510
IDS=587,17732,11987,19720,22474,37604,438,440,12058,12076,12068,12084,41239,41253,5945,5975,35662,35660,41238,20347,11269,2048,3831,2281,13992,1183,3540,33103,28668,10850,448,3244,527,26914,3608,16487,4292,4294,4409,31900,25894,12271,2929
curl -s "http://127.0.0.1:5521/dogma/types?ids=$IDS" -o types.json && curl -s http://127.0.0.1:5521/dogma/skills -o skills.json
# merge: { sdeBuild, types, effects, attributes } = union of both, keys sorted numerically, compact JSON
```

## The typed fit (`typeEftFit`)

- Each name resolves through an answer function (the hub's `/fit/type`; specs use `fixtureAnswer`). A module takes its
  slot from its type's slot effect and the key `<slot>-<n>` (written order within the slot, unknown names counted, so
  keys stay put when a name later resolves). Empty slots are counted in `empty`, never keyed.
- A module line whose type is not a module (a charge, a drone) moves to the items with a warning. Quantity lines sort
  by category: drones and fighters, `charges` (the ammo pool), `cargo` (cargo modules are never fitted). Names that do
  not resolve are listed in `unknown` and left out of dogma.
- `prop: true` marks the first fitted MWD / AB (group 46) in written order: the module the ship's `propMod` stands for.
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
  charges in the ship, `OwnerRequiredSkillModifier` on charges. Skipped and listed in `skipped`: target, structure and
  character domains (the char-domain `LocationGroupModifier` targets boosters; drones come later). `EffectStopper` and
  operation 9 are ignored.
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
  static profile). Every other code effect (reps, webs, neuts, cap boosters) changes no ship attribute: read its numbers
  with `moduleAttribute` / `moduleNumbersOf`.
- **Trace** steps: `{ source, effect, operation, amount, penalty?, from, to }`; sources are `ship`, `<module name>
  (<key>)` or `<skill> <level>` (`Navigation V`).
- Cost: ~2 ms per TFI evaluation (every skill runs). Re-evaluate only when module states, the fit or lookups change;
  cache a per-pilot skill index if a 44-ship retune is slow.

### Defense and module numbers (`defense.ts`)

- `shipDefenseOf`: per layer `{ hp, resonances, resists` (percent, 2 decimals) `, ehp` (hp ÷ mean resonance) `}`, the
  total `ehp`, `shieldRecharge` (s). `shipTargetingOf`: maxTargetRange, scanResolution, maxLockedTargets.
- `shipCapacitorOf(ship, bundle, activeKeys)`: capacity, rechargeTime (s), `peakRecharge` = 2.5 × capacity ÷
  rechargeTime, `drain` = Σ capacitorNeed ÷ cycle of the active modules, `stable` with `stableAt` (the fraction where
  `10·C/τ·(√c − c)` meets the drain) or `lastsFor` (s, stepped at 0.1 s). Numbers only: no live level, nothing stops.
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
  error, offline or unknown ones are left off with `activeNote`) adds `withActive: { modules, stats }`. `trace: true`
  adds the dogma steps behind the flight, HP, resonance and capacitor attributes. Without an SDE (or without
  DogmaData) the hull flies with the fit's prop mod (`readEftPropMod`, baked numbers when tools-core is down) and a
  `fitNote`. The `GET /ship-stats` route takes no fit (query length).
- **Not modelled**: implants and boosters, command burst buffs, heat, drones, fitting resources and slot counts, a live
  capacitor, the effects of targeted modules on their targets, server tick rounding.

## Why not tools-core's `fitting/parse`

`POST /eve/<b>/fitting/parse` drops `/OFFLINE`, fails the whole text with a 400 on a `Module, Charge` line or any
unknown name, and marks cargo `xN` modules as fitted. C2 uses it only to resolve one name at a time
(`[<hull>, x]\n<name>`).
