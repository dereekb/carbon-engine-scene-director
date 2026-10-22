# Fittings: EFT fits on ships, the parser, fit keys

> Ships carry real EVE fits. Fetch before touching `packages/scene/src/lib/fitting/`, a ship's `fit` or the document's
> `fits`, `compositions/expand.ts`'s fit keys, staging's `fit` lines, or anything that reads EFT text. The prop mod
> itself (numbers, switching, audio): `sd-ship-stats`; compositions and `cjs-fleet/1`: `sd-fleets` → `compositions`;
> `add_ships` / `stage_engagement`: `sd-staging`.

**Status (2026-10-22)**: slices C1-C2 of the fitted-modules plan
(`~/.claude/plans/fitted-modules-eft-fits-parsed-into-typed-modules-fit-driven-ship-stats-module-a.md`) are in: fits
are parsed and ride on scene ships, and the hub resolves fit names and serves dogma bundles. Not yet: the dogma
evaluator and fit-driven `ship_stats` (C3), the page flying fitted ships and reporting HP / resists (C4), module
activation (`switch_modules`) and the damage model (C5), module effects and sounds (C6). Until C4 the page ignores a
fit except through the prop mod a composition line writes into `propMod`. Research behind the design: the dbx-claude
note `fitted-modules-dogma-and-module-effects-research`.

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

## Why not tools-core's `fitting/parse`

`POST /eve/<b>/fitting/parse` drops `/OFFLINE`, fails the whole text with a 400 on a `Module, Charge` line or any
unknown name, and marks cargo `xN` modules as fitted. C2 uses it only to resolve one name at a time
(`[<hull>, x]\n<name>`).
