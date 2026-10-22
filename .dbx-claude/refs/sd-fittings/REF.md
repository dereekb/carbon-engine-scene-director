# Fittings: EFT fits on ships, the parser, fit keys

> Ships carry real EVE fits. Fetch before touching `packages/scene/src/lib/fitting/`, a ship's `fit` or the document's
> `fits`, `compositions/expand.ts`'s fit keys, staging's `fit` lines, or anything that reads EFT text. The prop mod
> itself (numbers, switching, audio): `sd-ship-stats`; compositions and `cjs-fleet/1`: `sd-fleets` → `compositions`;
> `add_ships` / `stage_engagement`: `sd-staging`.

**Status (2026-10-22)**: slice C1 of the fitted-modules plan
(`~/.claude/plans/fitted-modules-eft-fits-parsed-into-typed-modules-fit-driven-ship-stats-module-a.md`) is in: fits
are parsed and ride on scene ships. Not yet: name → type resolution and dogma bundles from tools-core (C2), the dogma
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

## Why not tools-core's `fitting/parse`

`POST /eve/<b>/fitting/parse` drops `/OFFLINE`, fails the whole text with a 400 on a `Module, Charge` line or any
unknown name, and marks cargo `xN` modules as fitted. C2 uses it only to resolve one name at a time
(`[<hull>, x]\n<name>`).
