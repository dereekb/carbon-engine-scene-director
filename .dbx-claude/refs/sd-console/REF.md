# The battle console: the Angular app, `packages/battle`, scenarios, settings and commands

> The console is the second page on the engine library: an Angular + dbx-components app that loads scenario files,
> stages and starts a battle with no agent, and steers it per fleet. The read-only viewer stays plain DOM. Plan:
> `~/.claude/plans/i-want-us-to-fuzzy-octopus.md` (phases A1 to A5). For the engine library and its bundle see
> `sd-runtime`; for building and serving, `sd-dev-env`; for the FC brain and the levers commands take, `sd-personalities`.

## State (2026-10-24)

| Phase | State |
|---|---|
| A1: app scaffold, dependencies, spike gate | done: boots through the hub at `/console/`, draws in real Chrome, key gate and H verified |
| A2: `packages/battle` (pure, node-tested) | done: scenario, bundle, staging, settings, commands, views (32 specs) |
| A3: loading (drop, zip.js, staging over `CallHub`, dialogs, scenario card, Reset, IndexedDB) | done (specs + `verify-console`) |
| A4: fleet panel (cards, command bar, target list, settings dialog, doctrine picker) | done (specs + `verify-console`) |
| A5: console end-to-end Playwright script, offline verify gaps | `verify-console` passes load, engage, Pull range / Hold, the settings drop and two equal Resets; **Warp out after Retreat fails** (the order is accepted, the FC keeps flying the align stance's direction); the verify-page offline gaps and the real-Chrome pass are a follow-up |

## Projects

| Project | Path | Build | Holds |
|---|---|---|---|
| `battle` (`@scene-director/battle`) | `packages/battle` | `@nx/js:tsc`, node vitest | the `cjs-scenario/1` format and `normalizeScenario`, `readScenarioBundle`, the staging plan, settings to ops, commands to tool calls, the panel's view models. **Pure and camelCase**; imports `@scene-director/scene` only, never the engine library (it declares `BattleFleetView`, the engine's `FleetView` structurally) |
| `battle-console` | `apps/battle-console` | `@angular/build:application` → `dist/apps/battle-console/browser` | the console UI. Angular house style (camelCase members, `console-` selector prefix); it never touches the runtime |

## How the console runs the engine

- **The engine is not re-bundled.** `@angular/build` 22 has no esbuild plugins, and the runtime needs three rules
  (`sd-runtime`). The console lists `@scene-director/viewer-engine` in `externalDependencies`, the build copies
  `dist/packages/viewer-engine/engine.js(.map)` (the library's `engine` target, a `dependsOn` of the console's build)
  to the output root, and an **import map** in `src/index.html` resolves the import to `/console/engine.js`.
  `outputHashing: none`, `baseHref: /console/`.
- **Types without the runtime.** `src/viewer-engine.d.ts` declares the module from `api.ts`'s types alone; the
  console's tsconfig maps `@scene-director/viewer-engine/api` to `packages/viewer-engine/src/lib/api.ts` and drops the
  base `@scene-director/viewer-engine` path, so the console's type check never sees the runtime.
- **Start.** `console.config.ts` provides `CONSOLE_ENGINE_STARTER` (`import('@scene-director/viewer-engine')` then
  `StartViewer`); `ConsoleComponent` starts it on `#view` (the canvas in index.html) after first render with
  `store: { prefix: 'console:' }`, so the console restores its own scene, not the viewer's (same origin). Specs hand
  in a fake starter.
- **Signals, 4 Hz.** `ConsoleViewerService` feeds `fleets`, `time`, `timeline`, `scene` and `uiHidden` signals from
  `ViewerApi.OnChange`, throttled to `CONSOLE_PANEL_REFRESH_MS` (250 ms); a `ui` change applies at once. Components
  read signals; no template getter builds a report.
- **Bootstrap:** zoneless; `provideRouter([])` with `DbxCoreAngularRouterSegueModule.forRoot()` (the router-transition
  service dbx dialogs and popups need; the console has no routes); `provideDbxRouterWebAngularRouterProviderConfig`,
  `provideDbxStyleService` (`console-app`), `provideDbxFormConfiguration`, `provideDbxForgeFormFieldDeclarations`;
  the Material Symbols font (index.html) as `MatIconRegistry`'s default font set class.
- **Theme:** `src/style/_console.scss`, modeled on dbx-components `apps/demo/src/style/_doc.scss`: one dark M3 theme
  (azure / orange) applied to `.console-app`, the class on `<body>`, so overlays are themed too.

## Keys and H

- The engine's keys (Space, [ ], ←, H, L, C, D) skip events inside `[data-ui]`, native controls and key-taking ARIA
  roles (`ui-focus.ts`); a focused `mat-select` is a `combobox`. Verified headless and in real Chrome: with the rate
  select focused, Space opens it, ← changes its value (no jump back) and H does nothing.
- After clicking a console button the button keeps focus, so H waits until the canvas or the body has it.
- **H hides the whole console UI**: the service toggles `console-ui-hidden` on `<body>`; `styles.scss` hides
  `console-root` and `.cdk-overlay-container`. CDK 22 renders select and menu panels as popovers **inline** (inside
  their trigger), so hiding `console-root` hides them; the container rule covers dialogs.

## Components and services (`apps/battle-console/src/app`)

| File | Does |
|---|---|
| `console.component.ts` (`console-root`) | starts the engine, restores the kept scenario, lays the UI over the canvas (`pointer-events: none` except `.console-panel`s) |
| `console-status.component.ts` | the read-only status: scene, ships, fleets, clock, timeline status |
| `console-run-bar.component.ts` | play / pause, back 10 s, rate (`time_control`), director camera (`auto_camera`); each one `ViewerApi.Call` |
| `console-scenario-card.component.ts` | the scenario's name, description, state and staging warnings; Load (`dbx-file-upload-button`, the e2e's input) and Reset |
| `console-drop-overlay.component.ts` | the window-level drop: `window:drag*` listeners, an overlay with no pointer events, folders walked through `webkitGetAsEntry`; a drop on a `[data-console-fleet]` card goes to that fleet |
| `console-fleet-panel.component.ts`, `console-fleet-card.component.ts` | the right column of fleet cards (below) |
| `console-fleet-settings.ts` | the FC settings dialog: `DbxForgeActionDialogComponent.openDialogWithForm` over `FleetSettingsFormValue` |
| `console-scenario.service.ts` | the loading rules, settings, doctrine drops and Reset (below) |
| `console-scenario.store.ts` | IndexedDB `scene-director-console` / `scenario` / `current`: `{ scenario, savedAt }` |
| `console-files.ts` | dropped / picked files to `{ path, text }`: zips through zip.js (`useWebWorkers: false`), the rest as text |
| `console-dialogs.ts` / `console-dialogs.component.ts` | the abstract `ConsoleDialogs` (confirm, same-scenario choice, problems) and `ConsoleMatDialogs` on MatDialog (`DbxPromptConfirmDialogComponent` + two `AbstractDialogDirective` dialogs), provided in `console.config.ts` |

- **Why the dialogs are split:** vitest's Angular JIT cannot compile dbx-web's partial components (`Cannot create
  property '__anonymousType' on string 'block()'`), so anything a spec imports keeps dbx-web components out of its
  import graph: services ask the abstract `ConsoleDialogs`, specs provide a fake.
- dbx-web's `dbx-file-upload-area` is not used: its drop sees files only (a folder comes as an empty File) and a drop
  there would bubble to the window handler too. The window overlay is the drop area.

## Loading (A3, `ConsoleScenarioService`)

- `drop(files, fleet?)` → `readConsoleFiles` → `load` → `readScenarioBundle`. Problems (the bundle's, a
  `ScenarioError`'s, a hub refusal's `HubCallError.problems`, via `problemsOfError`) all go to one problems dialog.
- **A scenario:** another `id` (or none): confirm only when **a fight runs (the live scene has fleets**; the welcome
  scene's lone ship is not one), then `planScenarioStaging` → `runScenarioStaging(plan, api.CallHub)` →
  `api.Call('load_scene', { scene, ...load })`; the scenario is kept (signal + IndexedDB). The same `id`: the
  same-scenario dialog, default "Apply settings to the running battle" (the sides' settings as a settings drop), "Load
  as a new run" (stage again) or Cancel.
- **A settings drop:** refused for another `id`; else `toSettingsDropOperations` through `patch_scene`, merged
  (`mergeScenarioSettings`), unknown fleets warned.
- **A lone personality** dropped on a card: `applyFleetSettings(fleet, { personality })`.
- `applyFleetSettings` (the Settings dialog, doctrine drops, the doctrine picker): `toFleetSettingsOperations` plus
  `update_fleet set personality <fleet>-fc` when the fleet's personality is not its own key (a no-brain fleet or a
  scene no scenario staged), through `patch_scene`; then merged into the kept scenario.
- **Reset** (confirmed): re-stage the kept scenario (file + merged settings); no scenario: `timeline { action:
  'restart' }`. After a reload the kept scenario is restored (state `restored`), so Reset still re-stages.
- The scenario's own `personalities` go into the base document (`set_personalities` in `planScenarioStaging`): a
  doctrine extending a bundle personality resolves on the hub (it refused before: "not a built-in personality, a
  saved one or a key of the scene's personalities").

## The fleet panel (A4)

- A card per `ConsoleViewerService.fleets()` fleet: `toFleetCardView` (FC, state, alive, engaged, stance, held, free
  fire, primary, HP, the levers you hold), the command bar (`CONSOLE_FLEET_BAR`, disabled with `commandsBlocked` as the
  tooltip), the target list (`toFleetTargetRows`: Call / Clear), Settings, and for a fleet with no brain a doctrine
  picker (built-ins plus the scenario's personalities) instead of the bar.
- A button runs `toFleetCommandCall({ command, fleet, target, retreat: the kept scenario side's settings.retreat,
  fleets })` through `ViewerApi.Call`; a `FleetCommandError` or refusal shows on the card.
- **Settings** (`packages/battle` `settings-form.ts`): `toFleetSettingsFormValue(side.settings)` fills the form;
  Apply → `fromFleetSettingsFormValue` (a template `{ extends: doctrine, ...only the fields set }`, logi, retreat) →
  `applyFleetSettings`. Ranges and reaches are metres or a named reach; the priority is a comma-separated role list;
  fire is focus / free / focus + free (`calls`, `freeFire`); advanced: command ability, backups, handover, reaction.

## The scenario file (`cjs-scenario/1`, `packages/battle/src/lib/scenario/scenario.ts`)

- `id` (required: a settings drop matches on it), `name`, `description`, `location` (a `set_location` place),
  `combat { seed, death }`, `range`, `heading`, `center` xor `near`, `sides` (exactly two, different fleet ids),
  `camera { auto: true | auto_camera args }`, `start: playing | paused`, `timeline` (extra cues), inline
  `compositions`, `personalities`, `fits`, and `scene` (a pre-staged `cjs-scene/1` used instead of location and
  staging; settings still apply by fleet id).
- A side: `stage_engagement`'s side fields (`fleet` required, `team`, `name`, `composition` xor `ships`, `formation`,
  `spacing`, `prefix`, `warpIn`), plus `start: engage | hold` and `settings { personality, logi, retreat }`. A side's
  own `personality` is ignored with a warning (the doctrine lives in settings).
- `normalizeScenario` throws a `ScenarioError` carrying **every** problem; unknown fields are warnings.
- **A settings drop** is the same schema with only `id` and `sides[].fleet` + `settings` (`isScenarioSettingsDrop`:
  no staging field at the top, no staging field on a side). It never restarts.
- Offline (no EVE data) a scenario's lines carry `dna`, it has no `location`, `retreat` is a point or `away`, and
  doctrines give `targeting.reach` in metres (no weapons, so the named reaches call nothing).

## Bundles (`bundle.ts`)

`readScenarioBundle(files: { path, text }[])`: JSON parts by `schema` (`cjs-scenario/1`, `cjs-fleet/1`,
`cjs-fleet-personality/1`, `cjs-scene/1`, keyed by `id`, else the file stem), `.eft` / `.txt` as fits by file stem;
dot files and `__MACOSX/` skipped. Folders are only a convention. Parts merge under the scenario's inline ones; a key in
both, a duplicate part, an unknown schema, invalid JSON, two scenarios or two scenes are problems, all reported
together. Kinds: `scenario`, `settings`, `personality` (one lone template: a fleet card's doctrine), `empty`. Names the
bundle lacks resolve on the hub (library, then built-ins). The zip itself is read in the console with zip.js (A3).

## Staging (`staging.ts`)

1. `planScenarioStaging` (pure): the base document (`createEmptyScene(name)` + `set_combat`, or the pre-staged scene),
   then `set_location { place }` when `location` is set, then `stage_engagement { sides, range, heading | center | near }`
   with `at: 0, cue: "scenario-stage"` when any side warps in (a document never stores an arrival: `sd-staging`). Each
   side carries its composition inline (a bundle one, the scenario's fits merged under its own) or by name, ship lines'
   fit keys swapped for their EFT text, and its doctrine as the inline template `<fleet>-fc` (the hub embeds it).
2. `runScenarioStaging(plan, callHub)`: each step through `ViewerApi.CallHub` on the passed `scene` (nothing loaded),
   then `finishScenarioStaging` (pure): the logi settings ops appended to the `scenario-stage` cue's patch (the fleets
   exist only once it fires; projected with `sceneAtTimelineTime`) or applied to the document; a pre-staged scene's
   fleets get `set_personalities` + `update_fleet personality <fleet>-fc`; then the cues (`toScenarioCues`): each
   `start: hold` side's hold stance + `cease_fire` (on `arrival { fleet, phase: landed }` for a warp-in side, else
   t = 0), a t = 0 `auto_camera` for `camera.auto`, the extra cues. `load` is `{ timeline: 'pause' }` for a paused start.
3. The console then loads it (`load_scene`, A3). Reset reruns the pipeline (same seed, same placements, same warp-ins).

## Settings (`settings.ts`)

| Setting | Maps to |
|---|---|
| Doctrine | the `<fleet>-fc` template (`toFleetDoctrineTemplate`: a base name becomes `{ extends }`; a template keeps its overrides, `extends` default `line`) |
| Brawl / Kite / Snipe / Hold, range, prop mods; opens fire; fire calls / free fire; target priority | template `movement`, `engage`, `targeting` |
| Logi follow the FC / on their own | each logi squad's `stance`: `null` (anchored 30 km on the FC) or `{ formation: 'loose' }` |
| Logi auto-repair | each logi squad's `autoRepair { on, policy }` |
| Retreat to | a console setting (commands), not the document |

`toFleetSettingsOperations` = `set_personalities` + `update_squad` per logi squad, **no `update_fleet`** (the brain's
book rebuilds at the next boundary without releasing a manual lever). `mergeScenarioSettings` merges a drop into the
console's scenario (logi key by key) so Reset keeps it; `toSettingsDropOperations` edits only fleets the live document
has. Settings edits cut the time-control window (document edits); commands are journaled.

## Commands (`commands.ts`): you steer, the brain shoots

| Button | Call |
|---|---|
| Engage | `order_fleet { type: engage }` |
| Hold position | `order_fleet` stance `{ type: hold }` |
| Pull range | stance `{ type: kite, range?, propMods: auto }` (range ideal, falloff, lock or metres) |
| Dive close | stance `{ type: brawl, propMods: always }` |
| Retreat | stance `{ type: align, to, propMods: always }`; `away` aligns `RETREAT_AWAY_DISTANCE` (2,000 km) straight away from the nearest other-team FC |
| Warp out | `order_fleet { type: warp, target }` for a named out, else `{ point }` clamped inside 95 % of the 10,000 km extent (`clampWarpOutPoint`), refused under 150 km |
| Hold fire | `cease_fire { fleet }` |
| Call primary / Clear | `order_fleet` targets `{ primary, until: gone }` / `{ clear: true, until: gone }` |

`toFleetCommandCall` throws `FleetCommandError` while the fleet is arriving, has no FC brain (the card offers a
doctrine instead) or has no ship left (`fleetCommandsBlocked`). `views.ts`: `toFleetCardView`, `toFleetTargetRows`,
`formatDistance`.

## Checks

- Specs: `dbx-claude-test` `project: battle` (node) and `battle-console` (vitest Angular, jsdom; a fake starter, a
  fake engine and fake `ConsoleDialogs` for `ConsoleScenarioService`).
- **`verify-console`** (`apps/scene-director/src/verify-console.ts`, `npx nx run scene-director:verify-console`, or
  `node dist/apps/scene-director/verify-console.js [--only <text>] [--headed]` after building `scene-director` and
  `battle-console`): its own `--eve-data off` hub on temp stores with the built console; opens `/console/` (note
  `hub.url` ends in `/`), gives the Load input a dna-only zip (scenario, two compositions, a doctrine part), then
  through get_state: both fleets land and both brains engage; Pull range and Hold change the FC's stance while the
  calls go on; a settings drop changes `red-fc` without the clock going back; two Resets give equal landing ticks and
  decision logs; Retreat reports aligned and Warp out lands over 1,000 km off.
- Its gotchas: the doctrines engage `in-range` (the stand-ins land outside lock range, so `on-sight` never fires
  offline); a stance shows in `fc.piloted` (move, prop-mods), not `fc.manual`; Destiny's tick runs on across loads,
  so a Reset is detected by a new warp-in and runs compare ticks from their first landing (to 20 after the last);
  `landedAt` shows only until a ship starts to follow, so it is recorded while polling. Page errors
  other than headless WebGPU's are reported as an `info` line.
- Headless boot (offline hub on a spare port with temp stores, `--console dist/apps/battle-console/browser`): the
  engine starts through the import map (headless Chromium here gets a swiftshader adapter and logs WebGPU validation
  errors; drawing is checked in real Chrome).
- Real Chrome on the Mac (Claude in Chrome): the console draws the stand-ins; the select panel is themed; keys and H as
  above.
