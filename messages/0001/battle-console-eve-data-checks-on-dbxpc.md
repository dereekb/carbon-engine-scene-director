# Battle console EVE-data checks on dbxpc: the full verify-page, TFIs vs Ferox at the CNAP, the GPU look, kill checks

> Queue item: `battle-console-eve-data-checks-on-dbxpc-tools-core-full-verify-page-real-scenari`

## Context

The battle console (plan `~/.claude/plans/i-want-us-to-fuzzy-octopus.md`, ref `sd-console`) was built and checked on a Mac
with no tools-core. Every check there ran with `--eve-data off`: stand-in cubes, dna-only fleets, no location, no fits,
no weapons and so no kills. This item runs, on dbxpc, the checks that need EVE data. dbxpc is the WSL2 box with
tools-core, the SDE and Windows Chrome on a real GPU.

**The prerequisite holds.** A3–A5 landed in `cda2a7e` (scenario loading, the fleet panel, `verify-console`), followed by
`bc69273` (a fleet warp takes the FC from its stance pilot) and `22285b6` (verify-page area prefixes and `--tap`). All
three are on `origin/develop`. Nothing needs parking.

**What research found** (each finding changes what the run must do):

1. **A real bug: a scenario's `location` never reaches `set_location`.** `planScenarioStaging` sends
   `set_location { place: scenario.location }` (`packages/battle/src/lib/scenario/staging.ts:78`, pinned by
   `staging.spec.ts:48`). `set_location` has no `place` argument. It reads `celestial`, `system`, `range`, `direction`,
   `offset` or `origin` (`apps/scene-director/src/lib/hub/locations.ts` `ResolveTarget`), so it refuses with "give
   celestial (a name or id) and/or system, or origin with system". It also does not parse "60 km off …". Offline,
   `set_location` refuses the whole mode, so no check ever ran it. Every console scenario with a location fails to
   stage today. Check (2) cannot pass until this is fixed.
2. **"60 km off the CNAP" plus "Warp out lands at the CNAP" breaks EVE's warp minimum.** `FleetOrders.Warp` refuses a
   leader whose landing is under 150 km away (`DestinyWorld.OrderRefusal`, `packages/viewer-engine/src/lib/destiny.ts`:
   "would land N km away; EVE warps only 150 km or more, so use goto"). The CNAP's SDE radius is 100 km, so from 60 km
   off its surface a warp to it lands about 60 km away and is refused. verify-page's own CNAP warp check stages
   300 km off for this reason. Retreat (an `align` stance) works at any range; only Warp out needs an out at least
   150 km away.
3. **dbxpc cannot auto-commit on the handoff work branch yet.** `commit.autoCommit.branches` is `["develop"]`.
   dbx-claude's receiver warns that this "does not admit dbx-claude/work/**", and panes on that branch cannot commit
   (`dbx-claude/apps/dbx-claude-cli/src/commands/git-handoff-extension.ts`). `send` bases the thread on
   **`origin/develop`** (`handoff/send.ts`, resolved on the remote). A Mac pane cannot push, so a Mac config commit
   would never reach dbxpc. The fix rides in dbxpc's own work commit.
4. **The Angular build cache is still tracked.** `cda2a7e` says the cache "leaves git" and added `/.angular` to
   `.gitignore`, but `.angular/cache/22.1.6/battle-console/{.tsbuildinfo,angular-compiler.db,angular-compiler.db-lock}`
   are still in the index. Every `battle-console` build dirties them.
5. **A loop worktree gets no `node_modules`.** dbx-claude's worktree engine does not link them. This repo resolves
   `file:../carbonenginejs/runtime/npm` relative to its root, so `npm install` inside a worktree would resolve the
   wrong directory.
6. **Prior dbxpc evidence to compare against:**
   - **M6, 2026-10-24, SDE 3646012:** the last full EVE verify-page. 180 checks: 178 ok, 1 skip, 1 known FAIL (`warp-in:
     the warp-in shot anchors at an arriving fleet's landing …`, flank-port, filed). Run as batches, ~40 min.
   - **What landed after M6, untested with EVE data:** the no-EVE-data mode, the frame lock, `record_movie`, C1's engine
     extraction (a large file move), C2's page→hub calls, C3's `engage` / `align` / `until: "gone"` / `calls`, and
     A1–A5.
   - **S8 (`sd-personalities`):** brawler TFIs vs sniper Ferox at the CNAP, 20 km apart. Three loads gave identical
     decisions and kill ticks, and red was wiped by scene tick 113. On the GPU, the 54-ship fight ran at a median
     17 fps (mean ~17, min 9–12) at 1600 × 900.
7. **Gaps in the current checks:**
   - verify-page's EVE run has no check for C3's levers under real weapons. The `no EVE data:` group covers them, with
     a lent call ended by a removal or a warp-off, never by a kill.
   - `verify-console` hard-codes `eveData: 'off'` and a dna-only duel.
   - `AlignPoint` (`director.ts`) silently falls back to "away from the hostiles" when a name does not resolve, so a
     Retreat check must read the stance's `why`, not only `aligned`.
   - The brain's decision log keeps only the latest 20 entries (`MAX_FLEET_DECISIONS`, `personalities/brain.ts`), so a
     long-window Reset comparison must collect decisions while it polls.

## Where this runs

This item needs tools-core, the SDE and Windows Chrome on a GPU. **Only dbxpc has them**: on the Mac,
`../carbonenginejs` holds only `runtime` and `server`. The item's `dataLocation: michelles-macbook-air` was set when it
was filed on the Mac; it is wrong. `send` re-pins it to `dbxpc`.

### On the Mac (a Mac pane claimed it): route it, nothing else

1. Confirm the prerequisite on the remote. Both commands must succeed:
   `git merge-base --is-ancestor cda2a7e origin/develop && git merge-base --is-ancestor bc69273 origin/develop`.
   If either fails, park the item with `dbx-claude-queue-ask` and stop.
2. Make no edits, builds or commits: anything committed here would not reach dbxpc without a push.
3. Send it to dbxpc. dbxpc is in `queue.gitHandoff.machines`, so a loop pane may do this:

   ```
   dbx-claude-handoff {
     action: "send",
     id: "battle-console-eve-data-checks-on-dbxpc-tools-core-full-verify-page-real-scenari",
     to: "dbxpc",
     merge: false,
     note: "Mac → dbxpc. A3–A5 are on origin/develop (cda2a7e, bc69273, 22285b6). Nothing ran here: no tools-core.
            Do the dbxpc steps D0–D9 of the attached plan. First: the work commit adds dbx-claude/work/** to
            commit.autoCommit.branches (the receiver warns without it) and untracks .angular. Known bug to fix:
            staging sends set_location { place }, which set_location does not take."
   }
   ```

4. If `send` is refused, park the item with `dbx-claude-queue-ask`, quoting the refusal: `claimed` by another session,
   `base-unknown` or `write-failed`. Never start the dbxpc steps here. Stop after a successful send. The item is
   `handed-off`, and the result comes back for review on `dbx-claude/work/<id>`.

### On dbxpc (the imported task): steps D0–D9 below

dbxpc cannot see the Mac's logs, plans or notes. Everything the Mac needs must land in the work branch (refs) or the
item's close-out result. That includes the evidence numbers and any follow-ups. Follow-ups filed on dbxpc stay in
dbxpc's queue, so repeat them in the close-out.

## dbxpc steps

### D0. Orient, long cache, branch policy

- Check that `hostname` is dbxpc and that the cwd is the provisioned worktree on `dbx-claude/work/<id>`, forked from
  `origin/develop`.
- This item needs long tool calls: the full verify-page is ~40 min, the console e2e ~15 min, the GPU pass ~45 min. On
  the 5-minute cache, first call
  `dbx-claude-queue-requeue { cacheTtl: "1h", longRunningTasks: true, handoff: "<progress>" }`.
- Keep a progress checklist (D1–D9) in the item's handoff, so a successor pane resumes without re-running finished
  batches.
- **Branch policy:** in the worktree's `.dbx-claude/dbx-claude.json`, set
  `"commit": { "autoCommit": { "enabled": true, "branches": ["develop", "dbx-claude/work/**"] } }`.
- **Angular cache:** run `git rm -r --cached .angular`. The files stay on disk, and `.gitignore` already lists
  `/.angular`.
- Both changes ride in this item's single commit, and the close-out names them.

### D1. Node modules and builds

- **The main checkout's install:** compare its `package-lock.json` with the worktree's (the base's). If they differ, or
  `node_modules/@dereekb/util` is not 14.23.0 (A1 moved every `@dereekb` package and added Angular 22.1.4, ngrx,
  uirouter, ng-forge, zip.js):
  - run `npm install` in the **main checkout**, npm only;
  - check `npm ls @carbonenginejs/runtime` (deduped under the server);
  - check the runtime lock entry still `"resolved": "file:../carbonenginejs/runtime/npm"`, and the `CjsSchema.js` md5
    is `ed288d32` (`sd-workspace`).
  - The runtime pin (`f77ed790c`) and server pin (`eadbdd1`) have not moved since 2026-10-21, so the forks need nothing.
- **The worktree:** if it has no `node_modules`, link the main one: `ln -s <main checkout>/node_modules node_modules`.
  Never run `npm install` inside the worktree (finding 5).
- **Build:** `dbx-claude-build` with `project: scene-director`, then with `project: battle-console`. Building the
  console builds the engine bundle first; building `scene-director` does not build the console.

### D2. tools-core and the SDE

- Start tools-core on Node 22 as `sd-dev-env` → tools-core says. Watch for the moved-clones caveat (run from
  `/mnt/a/github/_pre-wsl-move/...` with `--cache` / `--data` under `/root/github/...` while
  `/root/github/carbonenginejs/tools-core` lacks `node_modules`).
- Read `/eve/latest/build`. If EVE's build moved since SDE 3646012, prepare its SDE (`cjs-sde-prepare.js --build <n>`)
  and its audio library (`cjs-tools-prefetch.js audio --build <n>`).
- Make sure the map index is not degraded. A degraded index names moon stations after their planet, and the CNAP name
  would not resolve. The fix is `cjs-sde-prepare.js --build <n> --refresh`.
- Record the SDE build for the evidence.

### D3. Code (one commit, with the docs in D9)

**a) `packages/battle`: the location reaches `set_location` (finding 1).** camelCase; pure.

- `scenario/staging.ts`: export
  `toScenarioLocationArgs(location: string): { readonly celestial: string; readonly range?: number }`:
  - trim the string, then match `/^(\d+(?:\.\d+)?)\s*(km|m)\s+off\s+(.+)$/iu`;
  - on a match, return `{ celestial: <rest>, range: n × 1000 | n }`;
  - otherwise return `{ celestial: <text> }`. `set_location` already resolves "<celestial> in <system>", "IV - Moon 4"
    and the gate shorthands.
  - `planScenarioStaging` pushes `{ tool: 'set_location', args: toScenarioLocationArgs(scenario.location) }`.
- `scenario/scenario.ts`:
  - the `location` doc comment names the two forms;
  - `normalizeScenario` reports a problem when the celestial part is empty (`"60 km off "`).
  - No object form, and the hub is unchanged.
- Specs:
  - `staging.spec.ts`: the old `{ place: 'Jita IV - Moon 4' }` case becomes `{ celestial: 'Jita IV - Moon 4' }`. New
    cases: `60 km off <CNAP>` → `range: 60000`, `1.5 km off …` → 1500, `500 m off …` → 500, any case, and a name passed
    through as-is.
  - A plan spec for this item's scenario (below): steps `set_location { celestial: CNAP, range: 300000 }`, then
    `stage_engagement` with blue `composition: 'tfis'`, `warpIn`, template `blue-fc` extending `brawler`, red's line
    `fit` replaced by the EFT text, `range: 60000`, `heading: 90`, `at: 0`, `cue: 'scenario-stage'`. This guards the
    scenario offline on the Mac too.
  - `scenario.spec.ts`: the empty-celestial problem.

**b) `verify-console`: a `--eve-data tools-core` run** (`apps/scene-director/src/verify-console.ts`). Match the file:
PascalCase functions, `Check` / `WaitFor` / `Expect`.

- **Options:**
  - `--eve-data off|tools-core`. The default stays `off`, so the Mac's offline run is unchanged. Any other value exits
    2 on stderr.
  - `--tools-core <url>`, default `DEFAULT_TOOLS_CORE`.
  - With `tools-core`: `await new ToolsCore({ url }).Status()`. If it is unreachable, print `verify-console cannot run:
    …` and exit 2. The hub gets `eveData: 'tools-core'` and `audioCache: new AudioBankCache()`, as verify-page does.
- **Structure:**
  - Move today's checks unchanged into `NoEveDataChecks(page)` and add `EveDataChecks(page)`.
  - `Check` prints each result as it ends, the same `ok    ` / `FAIL  ` / `info  ` lines, so a killed ~15 min run keeps
    what it reached.
  - Extend the read shapes for what the EVE checks read: `destroyed`, `velocity`, `warp`, `stance.why`, `fit` rows,
    `combat.kills`, `fc.lent`, `location`.
  - Poll every 500 ms for the 54-ship state (a `WaitFor` interval argument).
- **`WriteEveScenarioZip(directory)`:** writes `tfis-vs-ferox.zip` with the parts `tfis-vs-ferox/scenario.json` and
  `tfis-vs-ferox/fits/ferox-rails.eft`. The fit comes as an `.eft` part, which exercises the bundle's
  fit-by-file-stem path. Print the zip's path as an `info` line, for the GPU pass.
- **The EVE checks, in order, on one Load** (`.console-scenario-load input[type=file]`):

  1. **`eve: a dropped TFIs vs Ferox zip stages off the CNAP through set_location and stage_engagement on the hub`**
     - `get_scene`: `location.anchor.celestial === 60003760`, the CNAP by name, and `|anchor.offset| − 100 km` within
       10 m of 300 km;
     - the `scenario-stage` cue's patch holds the pure `stage_engagement` op with red's lines resolved from the hull
       name (dna `bc1_t1:caldaribase:caldari`, the fit text);
     - personalities `blue-fc` (extends brawler) and `red-fc`;
     - two fleet cards.
  2. **`eve: both fleets land and both brains engage on real fits`**
     - all of blue's 44 arrivals land (record `landedAt` while polling, as `LandAndEngage` does);
     - both `fc.engaged`;
     - every red Ferox fit has `math: 'dogma'`, `unknown` empty and six `250mm Railgun II` turret rows loaded with
       `Spike M`;
     - both teams fire: `combat.shots > 0` on members of each fleet.
     - Budget 240 s.
  3. **`eve: Call primary lends the call until its target is killed, then the brain calls again`**
     - On blue's card, take the first target row that is in reach and not called
       (`tr:not(.console-fleet-target-out):not(.console-fleet-target-called)`). The first cell is the ship id. Click its
       `.console-fleet-target-call`.
     - Then `fc.lent.targets` includes it and `fc.manual` includes `call`.
     - Its kill appears in `combat.kills`, `by` a blue ship. Budget 180 s; call the kill tick K.
     - Within 10 s: no `fc.lent`, no `call` in `manual`, and a brain `call` decision at tick ≥ K naming a live red ship.
       Collect decisions while polling.
  4. **`eve: Retreat aligns toward the CNAP while the brain shoots, and Warp out lands at it`**
     - Click Retreat on blue. Within 60 s, the FC's `stance.state` is `aligned`, and its `stance.why` starts with
       `align toward Jita IV - Moon 4 - Caldari Navy Assembly Plant`. Not "away from the hostiles": finding 7's silent
       fallback.
     - The angle between the FC's velocity and the vector to the CNAP's centre (the centre sits at `−anchor.offset`) is
       ≤ 10°, and `manual` still lacks `call`.
     - Then click Warp out. The card shows no `.console-fleet-error`.
     - Within 120 s, the FC's warp lands with `| |FC − centre| − 100 km | ≤ 10 km`. Report how many members warped.
  5. **`eve: two Resets give the same landing and kill ticks and decision logs`**
     - Reset, then record a 240-tick window from the run's first landing, as `LandAndEngage` measures it: the landings,
       the kills as `[ship, tick − base, by]` sorted, and both fleets' decisions collected while polling (keyed
       `tick − base | lever | why`). Then Reset again and record the same.
     - The two runs must be equal, and the window must hold at least one kill, or the comparison proves nothing.
     - If red is not wiped in the first window, widen the window to cover the fight and record the size used.
  6. **`eve: page_log has no error`**: entries at `error` level, other than headless WebGPU's, fail; warnings are
     reported as `info`.

- `project.json` needs no change: `npx nx run scene-director:verify-console --eve-data=tools-core` forwards the flag.

**c) `verify-page`: one EVE check in the `personality:` area** (`apps/scene-director/src/verify-page.ts`, right after the
brain check `personality: the FC brain calls the nearest hostile as its FC; …`).

- Label: `personality: a lent call (until: gone) comes back to the brain once its target is killed`.
- **Scene**, via `LoadCombatScene` with `{ death: 'explode' }`:
  - fleet `b` with personality `verify`, the same template as the check before: ability 1, reaction 1, `on-sight`,
    `freeFire: false`, hold stance, `propMods: 'never'`;
  - blue: `bfc`, `p1`, `p2` as `Punisher`s;
  - red: three `Rifter`s, `k1`, `k2`, `k3`, 2.5 km off.
- **Steps:**
  1. Wait for the brain's call on `k1`, the nearest.
  2. Run `order_fleet { fleet: 'b', order: { type: 'targets', primary: 'k3', until: 'gone' } }`. Then `fc.lent.targets`
     is `["k3"]` and `manual` is `["call"]`.
  3. The members shoot `k3` (`target.source: 'called'`) until it dies (`combat.kills`). Budget 90 s.
  4. `fc.lent` then clears, `manual` is empty, and a brain `call` decision at tick ≥ the kill names `k1` or `k2`.
- Add `lent?: { lever: 'call'; targets: readonly string[] }` to `FleetBrainState`. `labels.spec.ts` already admits
  `personality:`.

Then run `dbx-claude-test` for `battle` and `scene-director`, `dbx-claude-lint-run`, and `npx oxfmt --write` on the
changed files.

### D4. Offline regressions (fast, first)

- `npx nx run scene-director:verify-console`: the dna duel stays green after the split.
- `npx nx run scene-director:verify-page --eve-data=off`.

### D5. The full verify-page with EVE data (check 1)

- Run one batch per area from the worktree, in `sd-dev-env`'s table order (`scene-document:` through `dev-env:`, with
  `personality:|free fire:` and `export:|record:` paired):
  `node dist/apps/scene-director/verify-page.js --only "<area>:"`.
- Run them in the background, one at a time, never alongside the test suites, verify-console or the GPU hub. Log each
  batch to `<main checkout>/.scratch/verify-eve-<date>/<area>.log`, and note each batch's tally in the handoff as it
  ends.
- Expect ~211 checks.
- The known FAIL (`warp-in: the warp-in shot anchors …`) is expected. Every other FAIL goes to D8.

### D6. The console e2e with EVE data (checks 2 and 4)

Run `node dist/apps/scene-director/verify-console.js --eve-data tools-core` (~15 min) and log it under
`.scratch/verify-eve-<date>/console.log`. Every check must pass.

### D7. The real-EVE look and fps parity in Windows Chrome (check 3; the `windows-chrome` skill)

1. Run `setup.sh --check`. Then start a private hub from the worktree, with EVE data on and temp stores:

   ```
   node dist/apps/scene-director/main.js serve --port 5531 --eve-data tools-core \
     --console dist/apps/battle-console/browser \
     --scenes $T/scenes --fleets $T/fleets --personalities $T/personalities --movies $T/movies
   ```

   Drive it with `main.js call <tool> … --port 5531` and a controller WebSocket driver adapted from
   `.scratch/personalities-gpu/fight.mjs`.
2. `new_page http://127.0.0.1:5531/console/`, then `resize_page` to 1600 × 900. Keep the window visible: a background
   tab gets no animation frames.
3. Copy D6's `tfis-vs-ferox.zip` to `<main>/.scratch/console-gpu/` and under the Windows temp dir. Use `take_snapshot`
   to find the Load input, then `upload_file` with the Windows path. If the hidden input has no uid, fall back to a
   synthetic drop on `#view`: `evaluate_script` with the zip inline as base64, as in the A5 pass.
4. Run the driver at 2 Hz: tick, timeline seconds, `renderer.fps`, `gpuErrors`, kills, arrivals. Save renderer frames
   with `call screenshot --port 5531 --out <main>/.scratch/console-gpu/console-<mark>.png` at these marks:
   - the first landing + 2 s (warp-in flashes);
   - the first shots (railgun and autocannon fire, impacts);
   - a Ferox kill + 1.5 s and + 3 s;
   - mid-fight.
5. Save full-page shots (`take_screenshot` to the Windows temp dir, then copy them as `ui-*.png`) of:
   - the panel mid-fight;
   - the Settings dialog;
   - after H, with all UI hidden;
   - Retreat aligned, then the Warp out landing at the CNAP up close.
6. **Look criteria:**
   - all 54 ships are `ready` (real models, not stand-ins);
   - `gpuErrors` 0, `lastFrameError` null, no failed or unplaced turrets, `page_log` without errors;
   - the CNAP, Jita's sun and the nebula draw behind the fight;
   - the console UI stays legible over the real scene.
7. **fps:** take `renderer.fps` from timeline 10 s to 70 s. Then:
   - `call get_scene --port 5531 --out <main>/.scratch/console-gpu/tfis-vs-ferox.scene.json`;
   - `close_page`, then `new_page http://127.0.0.1:5531/` (the plain viewer, the page verify-page drives);
   - `call load_scene --in …scene.json --port 5531`;
   - the same window and the same director camera (the scenario's t = 0 `auto_camera` cue), saving `viewer-*.png` at
     the same marks.
   - Record mean, median and min for both pages in `fps.json`.
   - **Parity:** the console's median is at least 90 % of the viewer's. S8 measured ~17 on the viewer. If the console
     falls short, measure it again with the UI hidden (H) to separate the Angular panel's cost.
8. Write `<main>/.scratch/console-gpu/notes.md`: what each shot shows, and the numbers. Then stop the private hub.

### D8. Findings

- **Fix in this item:** regressions caused by this repo's code (C1–C3, A1–A5 and after), each with its spec or check,
  then re-run the batch it failed in.
- **Fix the environment, not the code:** an unprepared tools-core build, audio or map. Prepare it and re-run.
- **Flaky checks:** re-run once. If it still fails, record it in the ref as such.
- **Too big for this item:** file it with `dbx-claude-followup` at L4, with the failing label and the first error, and
  list it in the close-out.
- **If the two Resets differ:** compare the first diverging kill or decision against `sd-combat` → The keyed RNG and
  determinism. Suspects: base-document fits resolving after t = 0, or anything keyed on wall time. Fix it if small;
  otherwise file it at L4 with both runs' logs.

### D9. Docs, commit, close-out

- **`sd-console`:**
  - the State table: a dbxpc EVE-data row (date, SDE build, results), replacing "Kill checks wait on offline damage";
  - Checks: `verify-console --eve-data tools-core`, what it checks, and its scenario;
  - the scenario file's `location` forms;
  - the staging step: `set_location { celestial, range }`;
  - a note that a named retreat must be at least 150 km off for Warp out (EVE's warp minimum; Retreat works at any
    range);
  - a dated "Real-GPU evidence (dbxpc)" section: fps for both pages, the look, the screenshot paths under
    `.scratch/console-gpu/` on dbxpc.
- **`sd-dev-env`:**
  - the verify-page full-suite line: check count, duration, date, SDE build and tallies;
  - the console bullet: the EVE run of verify-console.
- **`sd-personalities`:** the new `personality:` EVE check under Verify-page.
- Any area ref whose behavior a D8 fix changed.
- The README and CLAUDE.md stay unchanged.
- **Ref impact:** declare it through `dbx-claude-log` `refImpact` (sd-console, sd-dev-env, sd-personalities, plus any D8
  ref).
- **Commit once** through `dbx-claude-commit` (`auto: true`; D0's policy admits the work branch):
  `fix(battle): a scenario's location reaches set_location; EVE checks`, with a body naming the branch-policy and
  `.angular` changes. If the gate still refuses the work branch, run `precheckOnly`, then park the item with
  `dbx-claude-queue-ask` stating exactly what is uncommitted.
- **Close the item** with a result carrying the numbers (verify-page tallies, verify-console lines, fps for both pages,
  SDE build) and the follow-ups. The loop posts the result and the work tip back to the Mac for review.

## The scenario (verify-console writes it; also the GPU pass's zip)

`tfis-vs-ferox/scenario.json`:

```json
{
  "schema": "cjs-scenario/1",
  "id": "tfis-vs-ferox",
  "name": "TFIs vs Ferox at the CNAP",
  "description": "Brawling TFIs warp in on a Ferox sniper line off the Caldari Navy Assembly Plant.",
  "location": "300 km off Jita IV - Moon 4 - Caldari Navy Assembly Plant",
  "combat": { "seed": 7 },
  "range": 60000,
  "heading": 90,
  "sides": [
    {
      "fleet": "blue", "team": "blue", "composition": "tfis", "warpIn": true,
      "settings": {
        "personality": { "extends": "brawler", "targeting": { "reach": "falloff" } },
        "logi": { "formation": "loose" },
        "retreat": "Jita IV - Moon 4 - Caldari Navy Assembly Plant"
      }
    },
    {
      "fleet": "red", "team": "red", "ships": [{ "hull": "Ferox", "count": 10, "fit": "ferox-rails" }],
      "settings": { "personality": "sniper" }
    }
  ],
  "camera": { "auto": true }
}
```

`tfis-vs-ferox/fits/ferox-rails.eft` follows the Ferox's SDE slots: 4 low, 6 mid, 7 high with 6 turret hardpoints,
3 rigs (type 16227).

```
[Ferox, Rails]
Magnetic Field Stabilizer II
Magnetic Field Stabilizer II
Damage Control II
Tracking Enhancer II

50MN Microwarpdrive II
Large Shield Extender II
Large Shield Extender II
Multispectrum Shield Hardener II
Multispectrum Shield Hardener II
Sensor Booster II

250mm Railgun II, Spike M
250mm Railgun II, Spike M
250mm Railgun II, Spike M
250mm Railgun II, Spike M
250mm Railgun II, Spike M
250mm Railgun II, Spike M
[Empty High slot]

Medium Core Defense Field Extender I
Medium Core Defense Field Extender I
Medium Core Defense Field Extender I


Spike M x2000
Antimatter Charge M x2000
```

What each part of the scenario covers:
- **The location** exercises finding 1's fix.
- **300 km keeps the CNAP a valid warp out** (finding 2). A TFI fleet aligning toward it on MWDs for a minute still
  stays over 150 km off.
- **The 60 km between fronts** sits inside both hulls' lock range, so `on-sight` fires. If a brain stays unengaged
  ("nothing within lock range"), lower `range` to 40 km and record the change rather than editing the doctrines.
- **Red starts engaged**, not held, so the fight and the Resets need no input.
- **The fit:** if the SDE refuses a name (`fit.unknown`), swap in its current name and record the change.

## Pass criteria

| Check | Passes when |
|---|---|
| 1. full verify-page (EVE) | every area batch green except the known `warp-in:` shot FAIL; `--eve-data off` green; the new `personality:` lent-call check ok |
| 2. the real scenario | verify-console EVE checks 1, 2 and 4 ok: staged through `set_location` + `stage_engagement`, both fleets land and engage on real fits, Retreat aligns toward the CNAP, Warp out lands at it |
| 3. GPU look and fps | the look criteria in D7; the console's median fps ≥ 90 % of the viewer's on the same window; screenshots and `fps.json` in `.scratch/console-gpu/` |
| 4. kill checks | verify-console EVE checks 3 and 5 ok and the verify-page `personality:` check ok: a lent call returns after its target's kill, and two Resets have equal landing ticks, kill ticks and decision logs |
| offline | `verify-console` (duel), `battle` and `scene-director` specs, lint 0 errors |

## Follow-ups

- **L3: Warp out to an on-grid named retreat is refused only at the click.**
  - **Use case:** a console scenario fights 60 km off the CNAP with the CNAP as blue's retreat (the original plan's
    example). Retreat works, but Warp out shows "would land 60 km away; EVE warps only 150 km or more" on the card
    mid-fight. The console could disable Warp out with that reason in advance (it has the FC's position, and
    `location.targets` has the out's distance), or the Settings dialog could warn when the retreat is on grid.
  - **Why it matters:** a user finds out the out is useless only when they need it.

## Questions

- [x] Has the prerequisite (A3–A5) landed? (assumed: yes; cda2a7e, bc69273 and 22285b6 are on develop and origin/develop, so nothing parks) — (auto) proceeded with the default
- [x] Which machine runs the work, given the item is pinned to michelles-macbook-air? (assumed: dbxpc; the pin was set when the item was filed on the Mac; a Mac pane only sends the item over the git handoff and runs nothing) — (auto) proceeded with the default
- [x] Should the handoff squash-merge the result onto develop? (assumed: no, merge: false; the result parks for review on dbx-claude/work/<id>, as d99e016 set dbxpc up) — (auto) proceeded with the default
- [x] How does dbxpc commit on dbx-claude/work/<id> when commit.autoCommit.branches is ["develop"]? (assumed: the work commit adds "dbx-claude/work/**" in the worktree's marker, because send bases on origin/develop and a Mac pane cannot push a config commit; if the gate still refuses, run precheckOnly and park with dbx-claude-queue-ask) — (auto) proceeded with the default
- [x] Untrack the Angular build cache? (assumed: yes; git rm -r --cached .angular in the same commit, completing what cda2a7e intended, since .gitignore already lists /.angular) — (auto) proceeded with the default
- [x] How should a scenario's location reach set_location, which takes no place argument? (assumed: packages/battle parses it into set_location's own args: "<celestial>" gives { celestial }, "<n> km|m off <celestial>" gives { celestial, range }; no object form; the hub is unchanged) — (auto) proceeded with the default
- [x] The task's location is 60 km off the CNAP, but Warp out to the CNAP needs a landing at least 150 km away. Which gives? (assumed: stage the scenario 300 km off the CNAP and keep the CNAP as the named retreat; Retreat works at any range; the ref records the rule, and an L3 follow-up covers the on-grid case) — (auto) proceeded with the default
- [x] Does red start held for Engage, as the original plan's example did? (assumed: no; red starts engaged so the fight and the two Resets run with no input and stay comparable) — (auto) proceeded with the default
- [x] Which Ferox rails fit? (assumed: this plan's EFT: 4 low, 6 mid, 6 × 250mm Railgun II with Spike M plus an empty high, 3 rigs, per the SDE's Ferox slots; any name the SDE does not resolve is replaced with its current name and recorded) — (auto) proceeded with the default
- [x] Where do the console's EVE-data checks live? (assumed: a --eve-data tools-core run of verify-console; its default stays off, so the Mac's run is unchanged) — (auto) proceeded with the default
- [x] Where does "a lent call returns to the brain after its target is killed" live? (assumed: both a verify-page EVE check in the personality: area (Punishers vs Rifters) and the console e2e's Call primary on the real scenario) — (auto) proceeded with the default
- [x] What does "fps parity with verify-page" compare? (assumed: the console page against the plain viewer page, the page verify-page drives, on the same staged scenario in Windows Chrome, at the same window size and timeline window; parity means the console's median fps is at least 90 % of the viewer's) — (auto) proceeded with the default
- [x] Which window do the two Resets compare? (assumed: 240 ticks from each run's first landing, widened to cover the fight if needed; landings, kills (ship, tick, by) and both brains' decisions, collected while polling, since the log keeps only the latest 20) — (auto) proceeded with the default
- [x] How are full verify-page failures handled? (assumed: regressions from this repo's code are fixed in this item; the known warp-in shot FAIL is expected; environment problems are fixed by preparing tools-core and re-running; anything too big is filed at L4 and listed in the close-out) — (auto) proceeded with the default
- [x] Where does the GPU pass run, and where do its files go? (assumed: a private hub on a spare port (5531) with temp stores and EVE data on, driven through the CLI's --port and a controller WebSocket; screenshots and logs in the main checkout's .scratch/console-gpu/, which survives worktree cleanup) — (auto) proceeded with the default
- [x] At what speed does the console e2e run? (assumed: rate 1×, polling get_state every 500 ms for the 54-ship scene) — (auto) proceeded with the default
- [x] How does the dbxpc worktree get node_modules? (assumed: symlink the main checkout's node_modules once its install matches the base's lockfile; never npm install inside the worktree, whose ../carbonenginejs paths would resolve wrong) — (auto) proceeded with the default
- [x] Does the README or CLAUDE.md change? (assumed: no; the evidence goes to sd-console, sd-dev-env and sd-personalities, per the project's no-growth rule) — (auto) proceeded with the default
