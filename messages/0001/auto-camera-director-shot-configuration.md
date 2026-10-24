# Auto camera director: shot rules (limit which shots it picks)

> Queue item: `auto-camera-director-shot-configuration-limit-which-shots-it-picks`

Give the automatic camera director (`auto_camera`, ref `sd-cinema`) hard shot rules: the scales and framings it may
pick, framings it never picks, and a floor on how small its subject's ships may be on screen. A wide shot of a
spread-out fight is then tightened or skipped. The first pick follows `favour` and the rules. Coming back after a
drag, D or `on: false` picks the best shot instead of opening wide again. The director no longer mistakes a fight
already in progress for "opening fire". The rules can be set per call (as today) or saved in the scene document
(`autoCamera`, edited with `set_auto_camera`), so they survive reloads, saves and exports. The director stays
deterministic for a given scene, event stream, seed and configuration.

## Why, and the use case

On 2026-10-24 the user watched a TFIs-vs-TFIs fight on an iPad: 88 ships, `stage_engagement` brawler vs kiter, 30 km
apart, no EVE data (stand-in cubes). Every time the director was turned on, its first pick was `overlook-pull-out` on
the engagement at scale `wide` ("teams blue and red open fire · overlook-pull-out starboard on the engagement · first
pick"), even with `favour: "medium"`. That frame was nearly all green screen with a few pixel-sized ships. A drag
yields the camera, and handing it back opened on a wide again. `favour` is only a bias, so nothing could rule a shot
kind or scale out or cap how far the camera pulls back. The user wants to keep the director to shots where the ships
can actually be seen.

## What exists (research)

- **The pure director** is `packages/scene/src/lib/cinema/director/` (camelCase; deterministic for a picture, event
  stream, settings, memory and seed). `step.ts` `stepCameraDirector` scores every candidate (a framing row × subject ×
  variant) in `buildCandidates` (`step.ts:390`). It refuses a candidate only when the hardpoint has no pose or its eye
  is inside a landmark (`step.ts:412-414`). Nothing checks how big the ships come out.
- **The first pick** (`step.ts:269-276`) goes urgent → `establishing` when calm → `wide ?? best`, and it ignores
  `favour`. It runs on every `take`, because `current` is null whenever the mode is `take` (`step.ts:246`). That covers
  turning on, the hand-back after Claude's or the timeline's shot, `auto_camera` / D after a user drag, and a `Lost()`
  re-pick.
- **Engage** (`interest.ts:397-417`) is detected as a team pair firing with `firing[pair]` null or older than
  `ENGAGE_QUIET_SECONDS` 15. `CameraDirector.Command` nulls the memory whenever the director was off
  (`camera-director.ts:160-163`), so turning it on mid-fight records a fresh `engage`. `pictureFacts` makes that event
  `engagedAt` (`interest.ts:623-632`), and `applies` admits `overlook-pull-out` for 10 s after it (`step.ts:363`). The
  pull-out has the highest weight (1.1) on the most interesting subject.
- **`favour`** (`scaleWeight`, `step.ts:380-388`) multiplies its own scale by 1.8, the next scale by 1 and the far one
  by 0.6. `favour: medium` never penalizes wide.
- **The director judges on its own scene**: `toDirectorScene` (`picture.ts:137`) uses EVE (physics) radii at
  `DIRECTOR_ASPECT` 16:9, so a rule built on it gives the same result at any resolution, device or export fps. The rig
  then frames the shot on the drawn SOF spheres.
- **Sizes**: without EVE data every ball has `DEFAULT_FLIGHT_RADIUS` 100 m (`flight.ts:242`, `:304`), and a stand-in
  cube's corners touch it (`stand-ins.ts:72`). The TFIs' EVE radii run from 80 to 3,000 m (`compositions/examples/tfis.json`):
  Tempest FI 250, Bhaalgorn 400, Guardian 80, carriers 1,000–1,643, Apostle 3,000.
- **The engagement core factor** (`engagementCoreFactor`, `step.ts:322-334`) tightens the fill only when the frame's
  radius is more than twice its core's. On the TFIs it stays 1.00.
- **Settings** (`command.ts:73-100`) merge per key from every `auto_camera` call: a value sets, null resets to the
  default, an omitted key keeps (`resolveCameraDirectorSettings`, `command.ts:207-217`). They live on the page until a
  reload, survive loads and restarts, and are captured in time-control snapshots (`CaptureFields`,
  `camera-director.ts:120`). Nothing in the document holds them.
- **They already flow through two paths unchanged**: timeline `auto_camera` cues read their arguments with
  `normalizeAutoCameraCommand` (`timeline/actions.ts:341-347`), and the battle console's scenario `camera.auto` becomes
  a t = 0 cue (`packages/battle/src/lib/scenario/staging.ts:159`, `scenario.ts:459-475`).
- **The pattern for a merged settings block** is the document's `combat` with `set_combat` (`combat/document.ts`). The
  page applies it on every apply (`director.ts:4648` `this.combat.SetCombat(...)`). A load clears the director at
  `director.ts:4641`.
- **The hardpoint fill** is capped at 1.5 by `readRange` (`shot.ts:367`). `framings.ts:207` repeats the 1.5 as a
  literal.

### The probe (offline, the current code)

An esbuild bundle of the package source in `/tmp/sd-probe`, with no hub, page or repo file touched. It built two TFIs
fleets with `expandFleetComposition` (headings 0 and 180, 30 km apart, every ship firing) and stepped
`stepCameraDirector`:

| Case | First pick |
|---|---|
| Fresh memory, mid-fight, `favour: medium` (both radius sets) | `overlook-pull-out port wide`: "teams blue and red open fire · … · first pick" (the reported log line) |
| Memory that already saw the fight (no engage), `favour` null or medium | `overlook port wide`: "the fight at 40 % intensity · … · first pick" |
| Take-back after 3 cuts, `favour: medium` | `behind-fc wide on fleet red`: "first pick" |

The typical framed hull is the median EVE radius over the eye distance times the view's half height (the measure
below). It is shown as a share of the frame height, with px for an 820 px tall iPad view and for 1080 p:

| Framing (whole engagement, R 53–56 km; whole fleet, R 29–32 km) | Stand-ins (100 m) | EVE radii |
|---|---|---|
| `overlook` | 0.16 % (1.3 / 1.7 px) | 0.37 % (3.1 / 4.0 px) |
| `overlook-pull-out` at its end (push ×2.2) | 0.09 % (0.7 / 1.0 px) | 0.21 % (1.7 / 2.3 px) |
| `into-sun` | 0.13 % | 0.31 % |
| `group-top-down` (fleet) | 0.27 % | 0.62 % |
| `flank` (fleet) | 0.48 % | 1.08 % |
| `behind-fc` (fleet) | 0.60 % | 1.36 % |
| `leading-edge` (fleet) | 1.32 % | 2.90 % |

So there are three causes. A fresh memory reads an ongoing fight as "opening fire". The opener takes the best wide
whatever `favour` says. No rule keeps a wide whose ships are a pixel across from being picked.

## The design

### 1. Shot rules (hard)

Four new `auto_camera` bias keys, each merged per key like the existing ones:

- **`scales: ["medium", "close"]`**: the scales the director may pick, a non-empty subset of wide / medium / close
  (null: all). A group framing's scale depends on its subject (`framingScale`: wide on a whole fleet, medium on a
  wing, squad or handful), so `scales` without wide still allows `behind-fc` on a squad.
- **`framings: ["hero", "chase", "flyby", "over-the-shoulder", "kill"]`**: the only framings it may pick (non-empty;
  null: all).
- **`exclude: ["overlook-pull-out"]`**: framings it never picks (`[]`: none).
- **`minShipSize: 0.01`**: the visibility floor (section 2).

The names are the director's 20 framings (`DIRECTOR_FRAMING_NAMES`: hero, rear-quarter, broadside, bow-on, flyby,
top-down, chase, kill, over-the-shoulder, behind-fc, flank, leading-edge, group-top-down, warp-in, overlook,
overlook-pull-out, into-sun, into-celestial, battle-fly-through, establishing). They are not hardpoint or library
names. The tool description lists each one with its scale and subject kind, generated from `DIRECTOR_FRAMINGS` the way
the pace numbers are interpolated today, and the schema enumerates them.

- **They are hard rules.** `buildCandidates` never scores a candidate that fails one, so every pick obeys them: the
  opener, a ratio cut, an urgent cut, a max-hold cut and the kill blend. When `kill` is ruled out, the existing "no kill
  candidate" path holds the current shot through the blast (`step.ts:289`).
- **The shot on screen**: if a call rules out the shot that is playing, the shot becomes invalid and is cut at the next
  boundary (cut rule 1), with the why "auto_camera rules out <framing> now".
- **Refused calls**: a call whose resolved rules leave no framing at all is refused, and the settings stay as they
  were. "No framing at all" means `framings` lie outside `scales`, or every allowed framing is excluded; for example
  `auto_camera: the rules leave no framing to pick (framings overlook; scales close)`. A row's possible scales are its
  own, plus both wide and medium for `group` rows.
- **Nothing allowed resolves now** (for example `framings: ["warp-in"]` with no arrival): the director waits with the
  note "nothing the rules allow resolves on the scene (…)", which reuses the note branch at `step.ts:268`.

### 2. The visibility floor: `minShipSize`

`minShipSize` is the smallest on-screen size the director may show its subject's ships at. It is a share of the frame
height, like `fill`. **Default `DEFAULT_MIN_SHIP_SIZE` 0.005** (0.5 %: about 4 px of an 820 px iPad view, 5.4 px at
1080 p). 0 turns it off; the maximum is 0.25.

**The measure** (`framedShipSize`, new `director/visibility.ts`): size = median EVE radius of the subject's ships ÷
(eye distance × `viewHalfExtents(pose.fov, DIRECTOR_ASPECT).halfHeight`). That is the typical hull's diameter over the
frame's height, with Carbon's 1.6 aspect clamp included.

- **Which ships**: a ship framing takes the ship itself. A pair takes the shooter, whose frame the over-the-shoulder
  hardpoint stands in. A group takes its landed members; for warp-in that includes the arriving ones, which is the frame
  warp-landing resolves. An engagement or landmark framing takes the axis teams' landed ships, else every landed ship.
  The median is the lower median of the sorted radii, computed once per subject per step (memoized on the director
  scene with `cinemaMemo`, like the group and engagement selections).
- **Eye distance**: from the pose's eye to the resolved subject frame's centre (`ResolvedHardpoint.subject.centre`; a
  landmark framing uses the focus centre, `sceneFocus`), times the framing's reach.
- **Reach** (`DIRECTOR_FRAMING_REACH`, derived once from the library entries' built moves and pinned by a spec):
  - Push moves above 1 multiply. `overlook-pull-out` ends 2.2 times farther out, so it is judged at its end.
  - A path in radii judges the eye at the path's farthest point. `battle-fly-through` starts about 1.51 subject radii
    out (its farthest point).
  - Push-in, zoom-in and orbit moves leave the base pose as the worst case.
- **Ship and pair framings** measure about their fill (0.25–0.6), so the floor bites on group, engagement, landmark and
  warp-in framings.

**Tighten before skipping.** A group framing (not warp-in) or an engagement framing (not the fly-through, whose path
ignores fill) that falls below the floor is re-resolved with a raised fill:
fill′ = min(`MAX_HARDPOINT_FILL` 1.5, fill × floor ÷ size × 1.05).

- The starting fill is the candidate's own (the core factor's), else the row's (`ENGAGEMENT_FILLS`, the group rows'
  0.85).
- At most two tries, because hardpoint distances are not exactly proportional to fill.
- A candidate that reaches the floor is kept, and its shot carries the fill (`withHardpointOptions`, `step.ts:592`).
  Otherwise it is skipped.
- On the probe, the EVE-radius overlook rises from 0.37 % to about 0.6 % at fill 1.5 and is kept: it frames both main
  bodies and leaves the logi and capitals out. The stand-in overlook tops out near 0.25 % and is skipped.

**The shot on screen** is invalid when its size falls under `SIZE_KEEP_FACTOR` 0.8 × the floor, for example a group
spreading out under a held wide. It is then cut at the next boundary with the why "<framing> on <subject> shrank to
0.3 % (floor 0.5 %)". The 0.8 margin stops a shot picked just above the floor from being cut by drift.

**Why on-screen size, not a maximum camera distance**: a distance is not scale-free. A battleship reads at 20 km and a
frigate does not, and stand-ins are 100 m while a TFI's EVE radius is 250 m. The size rule also covers the lens and is
the quantity the complaint was about. One knob, not two.

**Calibration**: 0.005 is provisional. The implementer screenshots the cuts nearest the floor (no-EVE on the Mac, real
hulls on dbxpc) and moves the default within 0.005–0.01 if those still read as specks, then records the numbers in
`sd-cinema`.

### 3. The first pick, coming back, and "open fire"

- **Opening vs take-back** (`step.ts` first-pick branch, split on `memory.cuts`):
  - **Opening** (`cuts === 0`: the first pick since a load, since a jump cleared the memory, or the very first turn-on)
    goes in this order:
    1. urgent;
    2. the best candidate of the favoured scale, when `favour` is set ("first pick (favour medium)");
    3. `establishing` when calm ("first pick: setting the scene");
    4. the best wide, now readable because of the floor ("first pick");
    5. the best.
  - **Take-back** (`cuts > 0`: on again after D or `on: false`, after a yield to the user, Claude or the timeline, or a
    `Lost()` re-pick): urgent, else the best ("taking back"). It does not re-establish.
  - Interest's `first` flag (a landmark is worth an establishing shot) follows the opening only.
- **Engage needs a watched boundary** (`interest.ts`): `DirectorInterestMemory` gains `observed`, the scene seconds of
  the last interest step (absent on an empty memory).
  - An `engage` event fires only when the director watched the previous boundary: time − observed ≤
    `ENGAGE_WATCH_SECONDS` 2.
  - Otherwise a firing pair is recorded as already firing, with no event. A fight in progress when the director starts
    or comes back is not "opening fire", so the pull-out's 10 s window stays shut.
  - Watch mode (yielded) keeps stepping interest, so a hand-back after a drag is covered. Fast-forward still steps
    every boundary 1 s apart.
- **Memory across off and on** (`camera-director.ts` `Command`): turning the director on keeps its memory (recent
  shots, kept side, interest, cut log). Only a load (`Clear({ load })`) and a jump (`Clear({ keep: 'settings' })`)
  clear it. So D off then D on is a take-back, the log continues and the 180° side holds.

On the user's repro this means: no engage and no pull-out when turned on mid-fight. With `favour: medium` the first
pick is medium. Without it, the first pick is the best wide that passes the floor: with EVE radii a tightened overlook
or a fleet wide; with stand-ins `behind-fc` or `leading-edge` at 0.6–1.3 %; else the best shot.

### 4. Where the configuration lives

1. **Per call**, as today: the keys last until the tab reloads, survive loads and restarts, and are captured by time
   control.
2. **In the scene**: a top-level **`autoCamera`** block holds the director's settings for this scene:
   `{ favour?, sun?, pace?, hold?, scales?, framings?, exclude?, minShipSize?, letterbox?, hud?, seed? }`.
   - It is validated with the same per-key readers as `auto_camera`. Following the document convention, unknown keys
     are warned about and dropped, null means absent, and an empty block is omitted.
   - `on`, `follow` and `teams` are warned about and dropped: one turns the director on, and the other two name scene
     ids that removals would have to prune (Follow-ups).
   - It is edited with **`patch_scene [{ op: "set_auto_camera", … }]`**, following `set_combat`: merged, null resets a
     key, and an emptied block goes.
   - `save_scene` saves it, the IndexedDB working copy keeps it (so a reload restores it), `open_scene` restores it, and
     an export, which restarts from the document, uses it.
3. **Layering**: settings = defaults ← the scene's `autoCamera` ← the live overrides (calls and cues since the tab
   loaded).
   - A call's `null` now drops the live override, so the key falls back to the scene's value, else the default. Without
     a scene block this is the same as today.
   - To lift a scene rule for the session, pass the open value: `scales: ["wide", "medium", "close"]`, `exclude: []`,
     `minShipSize: 0`.
   - `favour` has no open value, so a session cannot clear a scene's favour; that is documented (edit the scene).
   - If the scene block and the live overrides together leave nothing, `SetSceneBias` cannot refuse a document apply.
     The director waits with the note from section 1 instead.
4. **Timeline cues and battle scenarios** carry the new keys with no code change, because the cue reader is
   `normalizeAutoCameraCommand`. A cue's keys are live overrides, as today.
5. **Named presets: not now.** The scene block is the saved configuration, and a preset would just name a bundle of
   these keys. The battle console's picker is the natural home for them (Follow-ups).

On the page, `CameraDirector` keeps two layers:

- `sceneBias`, set by `Director.ApplyNow` on every apply (next to `combat.SetCombat`). It is wiring: never captured or
  restored, so a jump keeps the document's current block.
- `liveBias`, captured like today's `settings`.

The `settings` field becomes a resolved `Settings()`. An `autoCamera` edit is not a `SimulationChange`, so it keeps the
time-control window, as a camera edit does.

### 5. Determinism

- Every new rule is a function of the step's inputs (picture, events, settings, memory, seed). The measure reads the
  director's scene (EVE radii, 16:9), never the drawn SOF radius, the canvas or the letterbox. An iPad, a desktop and
  an export at any fps therefore pick the same shots.
- The memory stays plain JSON (`observed` is a number), so `structuredClone`, snapshots, the movie-owned
  re-simulation and `timeline restart` (the opening at the cue's boundary, `cuts === 0` after the load's clear) all cut
  the same.
- An export cannot change the rules mid-run: `ExportGuard` refuses `auto_camera` and `patch_scene`. A saved
  `autoCamera` reproduces the cut in a fresh tab. Live overrides last until a reload, as today. A recording is live
  capture, so rules changed mid-recording show in the file.

### 6. Reporting

- `bias` (get_state `cinema.director` and auto_camera's result) gains `scales`, `framings`, `exclude`, `minShipSize`
  and `layers { scene: [keys], live: [keys] }`.
- `pick.size` (3 significant figures), plus `pick.fill` when tightened. `candidates[].size`. The cut log's `size` (the
  auto_camera `log` and `Log()`).
- `ruledOut { framings, scales, size }`: the last step's counts, omitted when all are zero.
- Tool texts:
  - `auto_camera`: the four keys, the framing table, the floor's default, the layering and what null now means.
  - get_state's `cinema` sentence.
  - patch_scene's op list gains `set_auto_camera`.
  - `SCENE_FORMAT` gains a top-level `autoCamera` line.
  - `list_shots` is unchanged.

## Implementation

`packages/scene` (camelCase, no runtime imports):

1. `cinema/shot.ts`: export `MAX_HARDPOINT_FILL = 1.5` and use it in the fill `readRange`. `framings.ts:207`'s literal
   uses it too.
2. `cinema/director/command.ts`:
   - The four keys on `AutoCameraCommand` and `CameraDirectorSettings`, plus `DEFAULT_MIN_SHIP_SIZE` and
     `MAX_MIN_SHIP_SIZE`.
   - Per-key readers shared with the scene block (`readAutoCameraKeys(input, keys, where, problems)`), so
     `normalizeAutoCameraCommand` keeps its messages.
   - `mergeAutoCameraBias(previous, command)`: a value sets, null deletes, an omitted key keeps, and `on` is never
     stored.
   - `resolveCameraDirectorSettings(...layers)`: the defaults, then each layer's keys.
   - `directorRulesProblem(settings)`.
   - Messages:
     - `scales must be a non-empty list of wide, medium, close (no repeats), or null`
     - `framings must be a non-empty list of …`
     - `exclude.N "x" is not a director framing (…)`
     - `minShipSize must be a share of the frame height in [0, 0.25] (0 turns it off), or null`
     - `"x" is in both framings and exclude`
3. `cinema/director/framings.ts`: `framingScales(row)` gives the scales a row can take.
4. `cinema/director/visibility.ts` (new): `framedShipSize`, `DIRECTOR_FRAMING_REACH`, `SIZE_KEEP_FACTOR`,
   `TIGHTEN_MARGIN`, and the memoized subject-radius median. Export it from `director/index.ts`.
5. `cinema/director/interest.ts`: `observed`, `ENGAGE_WATCH_SECONDS` and the priming in the engage loop. The caller
   passes `first` with opening semantics.
6. `cinema/director/step.ts`:
   - In `buildCandidates`: the rule filter, then the size measure, then tightening, then the `ruledOut` counts.
   - `liveScore` returns `{ score } | { invalid: why }` (the invalid case covers rules and size).
   - The opening / take-back branch.
   - `size` and `fill` on `DirectorPick`, `size` on `DirectorCutLogEntry` and the candidate report, and `ruledOut` on
     `CameraDirectorStepResult`.
7. `cinema/director/report.ts`: the bias report with `layers`, `pick.size` / `fill` and `ruledOut`.
8. `cinema/director/document.ts` (new): `SceneAutoCamera`, `normalizeSceneAutoCamera`, `AUTO_CAMERA_OPERATIONS` and
   `applyAutoCameraOperation`, modelled on `combat/document.ts`.
   - `scene.ts` → `document.ts` → `command.ts` → `scene.ts` (`SceneError`) is an import cycle. The same cycle already
     exists through `timeline/actions.ts`, and it is harmless as long as nothing imported is evaluated at module top
     level.
   - So build `document.ts`'s key sets from string literals, and call the readers only inside functions.
9. `scene.ts`: the `autoCamera` field, `SCENE_KEYS`, `normalizeScene` (after `combat`), the op dispatch,
   `SceneDiff.autoCamera` and the op-list doc comment.
10. `tools.ts`: the texts listed in section 6.

`packages/viewer-engine`:

11. `camera-director.ts`:
    - `sceneBias` (in the capture's `wiring`), `liveBias`, `Settings()` and `SetSceneBias`.
    - `Command`: merge into a candidate live bias, check `directorRulesProblem` on the resolved settings and throw
      `SceneError` before changing anything, keep the memory on enable.
    - `Report`: `layers` and `ruledOut`.
    - Update the class and method doc comments.
12. `director.ts`:
    - `ApplyNow`: `this.cameraDirector.SetSceneBias(scene.autoCamera ?? null)` next to `this.combat.SetCombat(...)`.
    - `AutoCamera`: a rules refusal goes out as the tool's error, through the existing throw path.
    - `autoCamera` stays out of `SimulationChange`.

`apps/scene-director`:

13. `verify-page.ts`: `DirectorCutReport.size` and two new `director:` checks (Tests).
14. The hub needs nothing: `auto_camera` is a page tool and `patch_scene` forwards ops. Update the `mcp/server.spec.ts`
    tool-list expectations if it pins the schema.

`packages/battle`: no change. A scenario spec may pin that `camera.auto: { scales: [...] }` reaches the t = 0 cue.

## Tests

- **`command.spec.ts`**:
  - The new keys validate: a bad scale, an unknown framing (the message lists the names), empty `scales` refused, a
    framing in both lists, the `minShipSize` range.
  - The merge: a value sets, null deletes, an omitted key keeps.
  - The layering: scene then live, and a live null falls back to the scene.
  - `directorRulesProblem`: `framings: ["overlook"]` with `scales: ["close"]`.
- **`visibility.spec.ts`** (new):
  - A fitted ship framing measures about its fill.
  - The reach is pinned: pull-out 2.2 from the library, fly-through ≈ 1.51 radii from its path.
  - A TFIs-like spread engagement with 100 m hulls measures its overlook under 0.2 % (the probe as a regression).
- **`interest.spec.ts`**:
  - Priming: a fresh memory or a gap gives no engage; a watched quiet-then-firing transition does.
  - The quiet-spell spec now steps through the spell.
- **`step.spec.ts`**:
  - `exclude: ["overlook-pull-out"]` is never cut to over a fight.
  - `scales: ["medium", "close"]` gives no wide cut in 90 boundaries.
  - `framings: ["hero", "chase"]` gives only those.
  - The floor skips the spread engagement's wides and the opener is not one of them.
  - Tightening plays a near-floor engagement with a raised `fill`, sized at or above the floor.
  - A rules change mid-hold cuts at the next boundary with its why.
  - A group spreading under a held wide is cut once it is under 0.8 × the floor.
  - `favour: medium` opens medium on a firing fight.
  - A take-back (memory with cuts, mode take) picks the best ("taking back").
  - The user's scenario: a fresh memory mid-fight records no engage event and gives no pull-out.
  - Rules that leave nothing give the note.
  - Existing specs that test engagement framings at radius 50 m pass `minShipSize: 0` (for example "favours wide
    shots, and into the sun with sun").
  - The 500-ship budget spec still holds.
- **Scene document** (`director/document.spec.ts`, plus `scene.spec.ts` for the dispatch and diff):
  - normalize `autoCamera`: unknown keys warn, `follow` / `teams` / `on` warn and are dropped, bad values are problems,
    an empty block is omitted;
  - `set_auto_camera` merges and nulls, and an emptied block goes;
  - `diffScenes` flags `autoCamera`;
  - a timeline cue accepts the new keys.
- **`camera-director.spec.ts`**:
  - `SetSceneBias`, then a live override, then null falls back to the scene; `bias.layers` reports it.
  - `Snapshot` / `Restore` restores the live layer and keeps the current scene layer.
  - D off then D on is a take-back: the log continues, why "taking back".
  - A command that empties the rules throws and leaves the settings unchanged.
  - The export-fps case (24 vs 60) stays equal.
- **verify-page `director:`**: the same code runs in the `verify-page` and `verify-page-no-eve` suites. The eight
  existing checks must still pass in both:
  - (a) and (g) need two scales. Their 5-Rifter fleets' whole-fleet wides measure about 2 % (EVE) and 6 % (stand-ins),
    above the floor; the engagement wides there (about 0.2 %) drop out.
  - The two new checks:
    - **"director: a spread fight opens on a readable shot and keeps to the rules"**. Load two 8-ship fleets 30 km
      apart, each with a 3-ship rear squad 25 km behind, and engage both. Once they fire, `auto_camera { pace: "fast"
      }`. Check:
      - the first cut is not `overlook-pull-out`, its why has no "open fire", and its `size` ≥ the floor;
      - over 30 s every cut's `size` ≥ the floor;
      - after `auto_camera { scales: ["medium", "close"], exclude: ["over-the-shoulder"] }`, 20 s more has no wide and
        no over-the-shoulder, and `bias.layers.live` lists both keys.
    - **"director: the scene's autoCamera survives a reload, and null falls back to it"**. `patch_scene set_auto_camera
      { scales: ["close"], exclude: ["flyby"] }`, then check:
      - `get_scene` holds the block;
      - `page.reload()` then `auto_camera {}` gives `layers.scene` and only close cuts with no flyby;
      - `auto_camera { scales: ["medium"] }` gives medium cuts;
      - `auto_camera { scales: null }` brings back close only.

## Verification on the page

- Build with `dbx-claude-build` `project: scene-director`. Run `dbx-claude-test` for `scene`, `viewer-engine` and
  `scene-director`, then `dbx-claude-test { suite: "verify-page-no-eve", testName: "director:" }` and, where tools-core
  runs, `{ suite: "verify-page", testName: "director:" }`.
- **No-EVE real page (the Mac)**:
  - Run a private hub on a spare port with `--eve-data off` and temp `--scenes` / `--fleets` / `--movies` directories.
    Never use the user's 5520 hub, the 5532 / 5521 iPad hub or the iPad tab.
  - Open a real Chrome tab sized 1180 × 820 (Claude in Chrome). Headless has no WebGPU, so stand-ins do not draw there.
  - Run the exact repro: `stage_engagement {"sides":[{"composition":"tfis","fleet":"blue","team":"blue","personality":"brawler"},{"composition":"tfis","fleet":"red","team":"red","personality":"kiter"}],"range":30000}`,
    wait for fire, then `auto_camera {}`. Read the `log`, the first pick's why and size, and take a `screenshot`.
  - Screenshot the smallest-size cut over 90 s.
  - Do a canvas drag, then `auto_camera { favour: "medium" }`: expect a take-back, not a wide.
  - Run `{ scales: ["medium", "close"], exclude: ["overlook-pull-out"] }` for 60 s.
  - Run `{ minShipSize: 0 }` to see the old wides return, for contrast.
  - `set_auto_camera`, reload the tab, then `auto_camera {}`: expect `layers.scene`.
- **Real hulls (dbxpc, the `windows-chrome` skill, at 1600 × 900 and 1180 × 820)**:
  - Run the same staging with EVE data.
  - Record the size and px of the first pick, the tightened overlook and the floor-boundary cut.
  - Move `DEFAULT_MIN_SHIP_SIZE` if the boundary reads as specks.
  - Check `page_log` and `gpuErrors`.
  - If dbxpc cannot be reached from the implementing session, file the real-hull calibration with `dbx-claude-followup`
    at level 4 instead of skipping it silently.

## Docs and refs (same commit)

- **`sd-cinema`**:
  - "Director mode" gets a compact "Shot rules and the visibility floor" part: the keys, the measure, reach,
    tightening, the live 0.8 margin, the default and the calibration numbers.
  - The opening vs take-back, the engage priming and the memory across off and on.
  - The scene's `autoCamera` and the layering.
  - The get_state additions.
  - verify-page `director:` (ten checks).
  - Limits: the "whole-fleet wides … specks" open item is now tightened or skipped.
  - The probe and real-page numbers.
- **`sd-scene-document`**: the top-level `autoCamera?` in Shape, a `set_auto_camera` row in the patch-ops table, and
  the `autoCamera` diff row (`SetSceneBias`, keeps the window).
- **`sd-dev-env`**: only if its verify-page area table counts the `director:` checks.
- **README**: the existing "Director camera" bullet gains "kept to the shot kinds, scales and on-screen ship size you
  allow, per call or saved in the scene". The `auto_camera` tools row becomes "the director camera on or off, its bias
  and shot rules".
- **`.dbx-claude/dbx-claude.json`**: `sd-cinema` triggers gain the words `auto_camera`, `autoCamera`,
  `set_auto_camera`, `minShipSize` and `camera director`, and the path `packages/viewer-engine/src/lib/camera-director`.
- **Commit** (one, through `dbx-claude-commit`): `feat(scene): auto_camera shot rules, ship-size floor, autoCamera`.
  Ref impact: `sd-cinema`, `sd-scene-document` (plus `sd-dev-env` if touched).

## Risks

- **The default floor changes out-of-the-box picks.** Engagement wides on small-hull or spread fights disappear, and
  the director leans on group and ship framings. `minShipSize: 0` restores the old behaviour, and the calibration step
  checks the boundary.
- **Spec churn**: the radius-50 step specs that test engagement framings, and the interest quiet-spell spec.
- **Tightening crops stragglers** out of a wide. That is intended, and the tool text says so.
- **A kept memory carries the old 180° side into a take-back.** That is intended; an axis that turns more than 60°
  still frees it.
- **Cost**: one memoized median per subject per step, and at most two extra resolves per tightenable candidate. Watch
  the 500-ship 20 ms spec.
- **The import cycle** in item 8.

## Not in this item

- A maximum camera distance knob (section 2 explains why not).
- Named presets and a console UI.
- `on`, `follow` and `teams` in the scene block.
- Core-based group frames: framing a fleet's main body the way warp-landing frames its core.
- Applying the floor to Claude's `play_shot` or to timeline shots. It covers the director's own picks only.

## Questions

- [x] Visibility rule: on-screen size or maximum camera distance? (assumed: on-screen size only, `minShipSize`: the median EVE radius of the subject's ships over the eye distance at the director's 16:9 view; no distance knob) — (auto) proceeded with the default
- [x] Is the floor on by default? (assumed: yes, `DEFAULT_MIN_SHIP_SIZE` 0.005 (0.5 % of the frame height), calibrated on no-EVE and real hulls and moved within 0.005–0.01 if the boundary reads as specks; 0 turns it off) — (auto) proceeded with the default
- [x] Unit of `minShipSize`? (assumed: a share of the frame height, like `fill`, in [0, 0.25]) — (auto) proceeded with the default
- [x] Skip or tighten a wide below the floor? (assumed: group (not warp-in) and engagement (not fly-through) framings raise their fill up to the 1.5 cap first, at most twice; everything else is skipped) — (auto) proceeded with the default
- [x] How are moving shots judged? (assumed: at their farthest frame: push factors above 1 multiply (pull-out ×2.2), a radii path at its farthest point (fly-through ≈ 1.51 R)) — (auto) proceeded with the default
- [x] What happens to the shot on screen when the rules change or it shrinks? (assumed: ruled out now, or under 0.8 × the floor: cut at the next boundary with its why) — (auto) proceeded with the default
- [x] Shape of the allow/deny lists? (assumed: `scales` (allow), `framings` (allow) and `exclude` (deny), all hard rules; `favour` stays a bias with unchanged weights) — (auto) proceeded with the default
- [x] Which names do the lists take? (assumed: the director's 20 framing names, not hardpoint or library names; the tool text lists them with scale and subject) — (auto) proceeded with the default
- [x] Rules that leave no framing? (assumed: the call is refused and the settings are unchanged; a scene-plus-live combination that leaves nothing makes the director wait with a note) — (auto) proceeded with the default
- [x] What is the first pick on start? (assumed: urgent → the favoured scale's best → establishing when calm → the best readable wide → the best) — (auto) proceeded with the default
- [x] What is the pick on coming back (D, `on: false` then on, after a yield, a lost shot)? (assumed: a take-back: urgent, else the best; no re-establishing wide) — (auto) proceeded with the default
- [x] Is a fight already in progress at turn-on an "engage"? (assumed: no: engage fires only when the previous boundary was watched (≤ 2 s); otherwise the firing pair is recorded silently) — (auto) proceeded with the default
- [x] Does turning the director off and on clear its memory? (assumed: no; only a load and a jump clear it) — (auto) proceeded with the default
- [x] Where does the configuration live? (assumed: per call (until reload, as today) plus a top-level scene `autoCamera` block edited with `set_auto_camera`; live overrides layer on top, and a call's null falls back to the scene's value) — (auto) proceeded with the default
- [x] Which keys may the scene block hold? (assumed: favour, sun, pace, hold, scales, framings, exclude, minShipSize, letterbox, hud, seed; `on`, `follow` and `teams` are warned about and dropped) — (auto) proceeded with the default
- [x] Named presets? (assumed: not in this item; a follow-up with the battle console's picker) — (auto) proceeded with the default
- [x] Does an `autoCamera` edit cut the time-control window or get captured in snapshots? (assumed: no and no: the scene layer is wiring, the live layer is captured as `settings` is today) — (auto) proceeded with the default
- [x] What does the director report? (assumed: `size` on the pick, candidates and the cut log; `fill` when tightened; `ruledOut` counts; `bias.layers`) — (auto) proceeded with the default
- [x] Does the floor apply to Claude's or the timeline's shots? (assumed: no, only to the director's own picks) — (auto) proceeded with the default
- [x] Reproduce on the user's hub or iPad during planning? (assumed: no; an offline probe of the package code gave the numbers, and the implementer verifies on a private hub) — (auto) proceeded with the default

## Follow-ups

- **L2: Director presets and a style picker in the battle console.**
  - Use case: on the iPad without Claude, pick "close action" (`scales` medium + close, `minShipSize` 0.01) or
    "cinematic" (the defaults) in one tap from the run bar, or in a scenario's `camera.auto`.
  - Why it matters: auto_camera's keys need a call or a scene edit today, and the console is where the user runs a
    fight.
- **L2: The scene block's `follow`, `teams` and `on`, with pruning on removals.**
  - Use case: a saved TFIs scene opens and the director follows fleet blue with no call.
  - Why it matters: the block covers shot choice only, and follow and teams name ids a removal has to drop.
- **L3: Group framings frame the fleet's core, like warp-landing's `WARP_LANDING_CORE_SPREAD`.**
  - Use case: TFIs `flank` and `behind-fc` show the main body large while the logi sit 30 km out.
  - Why it matters: tightening crops by a fill on the whole sphere, which keeps the composition off-centre. A core
    frame composes better, and this is the open item in `sd-cinema`.
