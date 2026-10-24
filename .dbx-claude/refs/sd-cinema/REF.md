# The cinematic camera: hardpoints, shots, moves and waypoints

> A camera rig in the viewer that plays shots on hardpoints generated from the drawn ships, with timed moves,
> waypoint fly-throughs, a letterbox and a clean HUD, directed by Claude over MCP with a named shot library. Fetch
> before touching the camera tools (`list_hardpoints`, `play_shot`, `play_sequence`, `stop_shot`, `resume_shot`,
> `list_shots`), `packages/scene/src/lib/cinema/`,
> `packages/scene/src/lib/waypoints/`, the viewer's `cinema.ts` / `cinema-moves.ts`, `engine.ts` `FreeCamera`, the
> director's `PlayShot` / `TrackCamera` / takeover, or `main.ts` `Presentation`. The orbit camera, `frame_camera` and
> `ReframesAfterEdit`: `sd-scene-document`; fleets and `selectFleetShips`: `sd-fleets`; the drawn ClientBall samples:
> `sd-destiny`; the runtime d.ts: `sd-runtime`.

## Files

| File | Role |
|---|---|
| `packages/scene/src/lib/cinema/vectors.ts` | float64 vectors and `[x, y, z, w]` quaternions (`quatLookRotation`, `slerpQuat`, `headingAxes`, `fromFrame`), `WORLD_UP` |
| `cinema/pose.ts` | `CameraPose { eye, look, up, fov }`, `blendPoses` (lerp eye, slerp orientation with roll, fov in tan(fov/2)), `rollPose`, `toOrbitView` / `fromOrbitView`, `poseViewMatrix` |
| `cinema/framing.ts` | `viewHalfExtents` / `fitDistance` (Carbon's aspect clamp `CARBON_ASPECT_CLAMP` 1.6), `clearHulls` (`HULL_CLEARANCE` 1.15 radii), `cameraClips` |
| `cinema/subjects.ts` | `CinemaShip`, `CinemaScene` (+ an optional `memo`: `cinemaMemo` caches team, group and engagement selections on a scene that never changes, the director's), `shipFrame`, `groupFrame`, `selectCinemaGroup`, `engagementFrame`, `cinemaSpheres`, `cinemaAnchor` |
| `cinema/subjects.ts` (also) | `CinemaWarp` / `CinemaScene.warpOf`, `findLandmark`, `sceneFocus`, `landmarkFrame` |
| `cinema/hardpoints.ts` | the four catalogs, `HardpointAnchor`, `resolveHardpoint`, `listHardpoints` / `toHardpointListing` (list_hardpoints), `findCelestial` |
| `cinema/shot.ts` | the JSON shot spec: `normalizeCameraShot` / `normalizeCameraSequence` → `{ shot, problems, warnings }`, `normalizeHardpointSubject`, `listCameraShots`, `CAMERA_MOVE_TYPES`, `CINEMA_EASINGS`, `CAMERA_SHOT_ENDS`, `CINEMA_DRIVERS` |
| `cinema/library.ts` | the named shot library: `CAMERA_SHOT_LIBRARY`, `CAMERA_SHOT_NAMES`, `expandLibraryShot` |
| `packages/scene/src/lib/tools.ts` | the six tool entries after `frame_camera`, and get_state's `cinema` sentence |
| `apps/scene-director/src/lib/hub/hub.ts` | `list_shots` (a hub tool: the library is static, so it answers with no tab) |
| `packages/scene/src/lib/waypoints/waypoints.ts` | `Waypoint`, `resolveWaypoint`, `readWaypoints`, `measureWaypointPath`, `pathPointAt` / `pathTangentAt` / `pathDistanceAt`, `catmullRom` |
| `apps/viewer/src/lib/cinema.ts` | `CinemaRig` (`Play`, `Stop`, `Release`, `Frame`, `Report`, `Presentation`, `Subjects`), `CinemaReleases`, `LetterboxRect`; node-tested |
| `apps/viewer/src/lib/cinema-moves.ts` | `EvaluateMoves`, `Ease`, `TrackLag`, `Smooth`, the seeded `Noise` / `ShakeEnvelope`; node-tested |
| `engine.ts` | `FreeCamera`, `Engine.SetCinematicFrame` / `DrawnCamera` / `Aspect`, `OrbitCamera.Drawn` |
| `director.ts` | `cinema`, `TrackCamera`, the tool handlers (`ListHardpoints`, `PlayShot`, `StopShot`, `ResumeShot`), `CinemaScene` (+ `CinemaWarp`), `ReleaseCinema` / `TakeOverCinema`, the `CinemaReleases` call in `Apply` |
| `main.ts` | `Presentation`: `?letterbox=`, `?hud=off`, the L and H keys, a shot's overrides |
| specs | scene `cinema/cinema.spec.ts`, `cinema/warp-landmark.spec.ts`, `cinema/library.spec.ts`, `waypoints/waypoints.spec.ts`; viewer `cinema.spec.ts`; `mcp/server.spec.ts` (`list_shots` with no tab); verify-page `--only cinema` (ten checks) |

## Driving it over MCP

| Tool | where | What |
|---|---|---|
| `list_hardpoints` | page | a subject's hardpoints resolved on the scene as drawn now: `{ kind, subject, hardpoints: [{ name, kind, description, eye, look, up, fov, distance, anchored?, note? }], warnings }` (0.01 m, unit vectors 0.001, fov 0.1°); `subject` is `{ kind, ids, centre, radius, forward, up, starboard }` (+ the engagement's `teams`, `a`, `b`) |
| `play_shot` | page | one shot (explicit, a free `pose`, or a library `{ shot }`); returns `{ state, driver, shots (normalized, library expanded), warnings }` |
| `play_sequence` | page | `{ shots: [...] }`, explicit or library entries; same result |
| `stop_shot` | page | `{ pause?, adopt? = true, cut? }`; returns get_state's `cinema` |
| `resume_shot` | page | continue a paused shot or replay the last stopped one; returns `cinema` |
| `list_shots` | **hub** | the library: `{ shots: [{ name, description, subject, options, duration?, end, example, expanded }] }`, with no tab |

- **A play** (driver `claude`) replaces whatever plays (a blend starts from the drawn pose) and forgets any paused or
  stopped shot. A free placement is `play_shot { pose }`: it holds until stopped, and its eye and look are waypoints.
- **`stop_shot` hands the camera back to the user** by default: `ReleaseCinema` with adopt (the orbit takes the
  shot's last eye and look and follows its ship when there is exactly one, the pointer takeover's path), then the 0.5 s
  release blend. `adopt: false` blends to the orbit's previous view; `cut: true` skips the blend.
- **`pause: true` freezes** the shot clock (moves, paths, sequence timing) at `pausedAt`; the hardpoint still follows
  its subject and the lag runs on real frame seconds. Claude still drives.
- **`resume_shot`**: a paused shot continues (`run.start += now - pausedAt`); otherwise the stopped record
  (`{ shots, index, elapsed, anchor, seed }`, written by every Release / Stop of a driving shot) replays at its elapsed,
  blending in from the drawn pose over `DEFAULT_BLEND_SECONDS` whatever its own transition. Nothing to resume throws
  `nothing to resume: no shot is paused or stopped`; a no-op while playing.
- **What clears the record**: a new play, a load (`Stop({ cut, forget })`), removing the shot's subject, a hardpoint
  with no pose, a shot or sequence finishing. A camera change, `frame_camera`, the pointer and `stop_shot` keep it.
- **Drivers** (`CINEMA_DRIVERS`): `claude`, `director` (the automatic camera, `auto_camera`: below),
  `timeline` (the scene's camera cues), `user` whenever the orbit camera has (or is getting) the view. Never null.
- **Timeline cues** (`sd-timeline`) embed the play_shot / play_sequence object unchanged (library references included)
  and play through `Director.PlayShot(args, 'timeline', time)` from the cue's boundary scene time (so `elapsed` is
  frame-independent): a library reference expands at play time against the live scene. They take the camera whoever
  drove before; a pointer takeover releases as usual and the next camera cue takes it again. A `stop_shot` cue stops
  only a timeline-driven shot (else `skipped`). `timeline { camera: false }` releases a timeline shot (adopt) and skips
  later camera cues ("the timeline's camera is off"); the switch lasts until the tab reloads.
- `list_hardpoints` on a `celestial` while the location is not `ready` warns that its celestials may be missing.
- The console path still works for debugging: `sceneDirector.director.PlayShot(shot)`, `.StopShot()`,
  `.cinema.Report()` (chrome-devtools `evaluate_script`).

## Shot library (`cinema/library.ts`)

`{ shot: "<name>", ...subject, fov?, fill?, bank?, side?, duration?, ...overrides }`. Subject keys and fov / fill / bank
go on the hardpoint (a subject key the entry does not read warns); `side` and `duration` go to the builder (moves timed
in halves of the shot rescale); `end`, `transition`, `lag`, `letterbox`, `hud`, `clearance`, `name` replace; `moves`
append after the library's. Every library move is scale-free (an allow-list spec), and every library shot ends `hold`.

| Name | Subject | Length | Plays |
|---|---|---|---|
| `overlook-pull-out` | engagement (`teams`, `side`) | 24 s | `overlook` fill 1.15, blend 2 s, `push` ×2.2 + `orbit` up 18°, look lag 0.5 |
| `into-sun` | engagement | 16 s | `into-sun`, blend 2 s, `orbit` up 12° + `zoom` 42°, look lag 0.4 |
| `into-celestial` | engagement (`celestial` \| `object`) | 16 s | as into-sun on `into-celestial` |
| `battle-fly-through` | engagement | 18 s | base `overlook`; a subject-frame radii path from port to starboard across the axis, low; zoom 30° then 55° over halves; eye lag 0.15, look 0.6 |
| `warp-in` | group or ship (`side`) | holds | `warp-landing`, **cut** (a blend would swing across the lane), look lag 0.3; on ships still arriving by warp (`warpIn`) too |
| `establishing` | landmark (`object` \| `celestial`) | 14 s | `establishing`, blend 2 s, `push` ×0.85 |
| `chase` | ship | holds | `chase`, blend 1.5 s, eye lag 0.35, look 0.15 |
| `hero` | ship (`side`, default port) | 10 s | `hero-<side>`, `orbit` subject-up ±25° toward the beam (+ port, a spec pins it) + `push` ×0.85 |
| `flyby` | ship | 10 s | `flyby`, cut, look lag 0.15 |
| `over-the-shoulder` | ship (`target`) | holds | `over-the-shoulder`, blend 1.5 s, look lag 0.4 |

## Director mode (`auto_camera`)

The camera directs itself: cuts between hardpoints and library shots by an interest score over live events. Pure and
node-tested in `packages/scene/src/lib/cinema/director/` (camelCase; deterministic for a picture, event stream and
seed); the page's `apps/viewer/src/lib/camera-director.ts` (`CameraDirector` over a `CameraDirectorPort`) collects
events and plays the picks through the rig as driver `director`.

| File | Holds |
|---|---|
| `director/command.ts` | `normalizeAutoCameraCommand`, `resolveCameraDirectorSettings` (per-key merge, null resets), `directorHold`, `DIRECTOR_PACES` (slow 6–20, normal 4–12, fast 3–7 s), `autoCameraReferences` |
| `director/picture.ts` | `CameraDirectorPicture` (master state, health, combat windows, warps, arrivals), `toDirectorScene` (EVE radius, 16:9) |
| `director/events.ts` | `CameraDirectorEvent` (kill, primary, warp, prop-mod; scene ticks), `DIRECTOR_EVENT_WEIGHTS` (starting values), `sortDirectorEvents` |
| `director/interest.ts` | I(s) = (E + C + base) × R; derived engage / arrival lead / Destiny warp lead / bloom / pass; capped subjects |
| `director/framings.ts` | `DIRECTOR_FRAMINGS` (20 framings, scales, weights, variants), `toFramingShot` → play_shot JSON |
| `director/axis.ts` | the axis (teams a→b in id order, else motion), `viewSideOf` (view direction, 20° neutral), `flybyViewSide`, `leanOf`, `axisResets` (60°) |
| `director/step.ts` | `stepCameraDirector` (modes drive / take / watch), the cut rules, transitions, `recordDirectorCut`, `eyeInsideLandmark`, `engagementCoreFactor` |
| `director/report.ts` | `CameraDirectorReport` (get_state `cinema.director`), `describeDirectorPick`, `cameraDirectorText` (HUD) |

- **Hand-offs**: any `auto_camera` call turns it on (a live call picks at once; a cue picks at its boundary's step).
  Claude's and the timeline's shots take precedence: the rig's standby (`SetStandby`) holds their release-ending last
  frame and the director takes back at the first boundary at or past `ReleasesAt()`. `stop_shot` over them hands back
  at once; over the director's own shot, the pointer, a camera change and `frame_camera` yield to the user until
  `auto_camera` or D. `timeline { camera: false }` and a load turn a cue-sourced director off; a jump clears its memory
  (`EndJump`). A shot lost between boundaries (`Lost()`) is re-picked in `TrackCamera`, the one frame-timed path.
- **Decisions** run at the end of the Director's `OnBoundary` listener, from `CameraFacts()` (master state, never drawn),
  stamped at `OnBeforeBoundary`'s exact grid time; warp and prop-mod events reach the next boundary.

### The model

- **Interest** per subject (ships, pairs, fleets / wings / squads, arrival groups, the engagement, landmarks; capped):
  I = (E + C + base) × R. E: decayed events (w × 2^(−age / halfLife), `DIRECTOR_EVENT_WEIGHTS`: kill victim 10,
  arrival 9, engage 7, primary 5, warp exit 6, pass 4, prop-mod bloom 4); C: continuous terms (doom: under
  `DOOM_HEALTH` 0.6 with under `DOOM_SECONDS` 10 to live, heat, logi, motion); R: recognisability (the FC, the called
  primary, the followed subject ×2.5, hull size). Derived in the step: engage (a team opens fire after
  `ENGAGE_QUIET_SECONDS`), the arrival lead (`ARRIVAL_LEAD_SECONDS` 5 before a group's first landing), a Destiny warp
  landing near the action, a fleet's MWD bloom, close passes (`closePasses`, swept along x).
- **Framings** (`DIRECTOR_FRAMINGS`): each row a hardpoint or library shot on a subject kind with a scale (wide /
  medium / close), a weight and its variants; `applies` gates them (bow-on and chase need speed, kill a doomed or killed
  ship with ≥ 3 s before removal, warp-in an arrival lead, overlook-pull-out the first 10 s of an engagement). Every
  candidate must resolve on the director's own scene (`toDirectorScene`: EVE radius, 16:9, a `memo` so group, team and
  engagement selections are computed once per step) and keep its eye out of a landmark × 1.1 (`eyeInsideLandmark`; a
  station or gate at `STRUCTURE_EYE_FRACTION` 0.5 of its map radius).
- **Score** = I × weight × favour × rhythm (a third same-scale shot ×0.3, wide after wide ×0.5) × variety (the same
  framing + subject in the recent five ×0.25, the last shot's framing ×0.5) × axis × a seeded ±3 % jitter.
- **Holds and cuts**: pace presets slow 6–20, normal 4–12, fast 3–7 s (`hold` wins). Past min, cut when the best beats
  the live score × `CUT_RATIO` 1.4 (the live score's continuity falls from ×1.25 to ×0.75 over the hold); at max, cut to
  the best other. An urgent subject (events ≥ `URGENT_INTEREST` 8: a kill, an arrival lead) cuts after
  `URGENT_MIN_HOLD` 2 s, hold or not, never from a kill framing inside its hold. A kill on the framed ship blends
  (`KILL_BLEND_SECONDS`) into the `kill` framing (fill `KILL_FILL` 0.25, 0.4 over 300 m) and holds `KILL_HOLD` 4 s; a
  removal within `REMOVAL_CUT_SECONDS` re-picks. Warp-in holds to 2 × max, 3 s past the first landing.
- **The 180° rule** (`axis.ts`): the axis runs team a → team b (else the followed or biggest fleet's motion); a shot's
  side is the view's side of it (20° neutral band). The first sided shot sets the kept side; the far side needs a
  neutral shot before (×0.6), the fly-through's deliberate cross (which flips the kept side), or an axis that turned
  over 60° (`axisResets`). The cut log marks `crossing` and `free` (no kept side) cuts.
- **Bias** (`auto_camera`): follow, favour (×1.8 on the scale, ×0.6 two away), sun (into-sun ×2.5), teams, pace, hold,
  letterbox, hud, seed. Per key: a value sets, null resets, omitted keeps; it lasts until the tab reloads.
- **get_state `cinema.director`**: `on`, `state` (off / waiting / driving / paused / yielded), `yieldedTo`, `source`,
  `bias`, `pick { framing, shot, scale, side, since, holdsFor, score, why, event?, transition }`, 3 `candidates`,
  `axis`, `cuts`, 5 `recent`, `cost { lastMs, maxMs }`, `note`. auto_camera's result adds the 20-cut `log` (tick from
  the load, at, framing, subject, scale, side, crossing?, free?, why); verify-page reads it off the page
  (`director.cameraDirector.Log()`, ticks + `loadTick`) because any auto_camera call picks again.
- **The cue**: `auto_camera` is a kind `camera` action; `timeline { camera: false }` skips it and turns a cue-sourced
  director off; removing the followed fleet or ship drops `follow` from the cue.
- **Determinism**: memory is plain JSON, events sorted, jitter keyed on (seed, scene tick, candidate), the seed the
  document's combat seed. A scripted scene cuts the same after `timeline restart` (verify-page). A Claude-sourced
  director stays on across a load or restart and picks at t = 0, and keeps the settings a cue changed: start it from
  the cue (or turn it off first) for an exactly repeatable opening.
- **Time control** (`sd-time`): it steps every boundary, fast-forward included (holds in scene time), is neither
  journaled nor snapshotted, and `EndJump` clears its memory (settings kept).
- **Cost**: `stepCameraDirector` on 500 ships ~4 ms in node (step.spec's 20 ms budget is the best of three); on the page
  ~2 ms per boundary (once a second) for 59 ships, including the picture.
- **Limits**: a second kill inside a kill framing's hold is not cut to, and the next pick may skip its blast; wides of
  a whole fleet frame its logi 30 km out (behind-fc and flank read as specks on the TFIs); one
  engagement only (the two biggest teams); kill fill by hull radius, not the explosion file's size; a station's eye
  guard is a sphere; holds run in scene time, so 4× fast-forward cuts about every second.

### verify-page `--only director:` (eight checks, headless, real tools-core)

(a) fast pace on two stats-only fleets: driving within a boundary, 3–7 s gaps (7/7/7/7 seen), no framing + subject
repeat, two scales in six cuts; (b) a Claude 2 s release-ending shot yields (claude) and hands back by the next boundary
with no `user` between, `stop_shot` on the director's shot yields (user), `auto_camera {}` drives; (c, SDE) 3 Punishers
vs 3 Rifters: each victim framed by its kill tick (a doomed p1 from a tick before), held ≥ 3 s, cut away before removal
(a kill inside another kill's hold is excused, at least one framed);
(d) the 180° rule over (a)'s and (c)'s logs; (e, SDE) a `warpIn` add_ships group: warp-in 5 s before its first
landing; (f) a scripted scene (auto_camera cue at 1, engage at 2): equal cut logs across `timeline restart`; (g)
movement-only: axis `motion`, three scales, one side; (h) camera off skips the cue, `on: false` gives driver `user`.

## Across a time-control jump (`sd-time`)

`CinemaRig.Rebase(delta)` shifts every scene-tick stamp (`run.start`, `resumeBlend.start`, `release.start`, `pausedAt`,
`lastTick`, the report time) by the jump: a playing shot continues at its progress, a paused one stays paused, a release
blend runs on. The camera is a viewing control, never rewound (spec'd in `cinema.spec.ts`).

## Hardpoints

Generated every frame from the drawn samples, so they follow a ship that flies, turns or warps. Ship hardpoints scale
with the SOF bounding radius (100 m until built); `[forward, starboard, up]` coefficients, a fill and a lens per row.

| Kind (subject) | Names |
|---|---|
| ship (`ship`) | `chase`, `rear-quarter-{port,starboard}-{high,low}`, `hero-{port,starboard}` (30° lens), `bow-on`, `broadside-{port,starboard}`, `belly`, `top-down`, `over-the-shoulder` (`target`, default the nearest enemy), `flyby` |
| group (`fleet` [+ `wing` \| `squad`], or `ships`) | `behind-fc` (looks past the leader at the nearest enemy centroid, else ahead), `flank-{port,starboard}`, `top-down`, `leading-edge` |
| group (also a lone ship, `ship`) | `warp-landing` (anchored; `side`) |
| engagement (`teams?: [a, b]`, default the two biggest) | `overlook` (`side`), `into-sun`, `into-celestial` (`celestial`: an id or a name from the location, or `object`) |
| landmark (`object`: a scene object id, or `celestial`) | `establishing`, `hero` (`side`), `foreground` (`side`) |

- Overrides: `fill`, `fov`, `bank` (stand in the banked frame instead of the level heading frame).
- **Starboard is `forward × up`**, −X at yaw 0. `staging/placement.ts` `headingVectors().right` is +X, the port
  side: never reuse it as starboard. A spec pins the sign.
- `top-down` and `belly` put the bow at the top of the frame (up = forward): EveCamera's ±1.4 rad pitch clamp is why
  the orbit cannot do this.
- `flyby` is **anchored**: the eye is fixed at shot start, ahead on the drawn velocity at max(6R, speed × 4 s), 2.5R
  to starboard and 0.8R up (a ship at rest uses its forward); the look stays live, so it pans as the hull passes.
- A whole fleet's extent includes the logi 30 km out; a wing or squad frames tighter.
- `hardpointKind`: an engagement name first, then a group (`fleet` / `ships`), then a landmark (`object`, or
  `celestial` on a non-engagement name), else a ship. One subject only: more than one of ship, fleet, ships and object
  (or celestial with object) is a problem.
- **`HardpointAnchor { eye, look?, radius? }`** is what an anchored hardpoint places on the run: the flyby only the
  eye, warp-landing all three.
- **`warp-landing`** reads each ship's Destiny warp through the lazy `CinemaScene.warpOf` (the director's
  `world.Motion(id).warp`; no per-frame cost, no `destiny.ts` change). Reference: the leader if it warps, else the first
  group ship that does. The lane is landing minus the reference's drawn centre (its forward once landed). It frames the
  **core** (the hulls within `WARP_LANDING_CORE_SPREAD` 2.5 × the median hull's distance from the reference, at least
  `MIN_WARP_LANDING_RADIUS`, so logi 30 km behind the DPS or carriers 16 km out do not shrink the hulls to pixels; they
  land deeper up the lane. A fixed 80% share did: on the TFIs it reached the carriers and put the eye 83 km out). Aligning: the core where it stands, its offset turned from the
  reference's heading into the lane's (a formation warp lands every slot in the leader's heading at warp) and moved to
  the landing; in warp: the members' landings, less any farther than `MIN_WARP_DISTANCE` from the reference's (an
  earlier warp's, a pilot delay). **A `landed` warp frames its landing unanchored**: Destiny keeps reporting it until
  the next warp resolves, so anchoring on it would hold the eye at the previous landing. R ≥ 2 km
  (`MIN_WARP_LANDING_RADIUS`), the eye `fitDistance(R)` downstream, 25° to `side` and 12° up, looking back up the lane.
  **No `side`: the sunward one** (the side whose eye direction runs most against `sunDirection`), so the landing is
  front-lit; starboard on a tie. The eye and look anchor on the first frame that sees a warp; **an anchor appearing after the first
  frame resets the rig's lag smoothing**, so the camera cuts to the landing instead of smearing across the lane. No warp:
  it frames the group where it is, with a note.
- **Arrivals (`warpIn`)**: `CinemaScene.arriving` holds the ships with an unfinished arrival (`world.Arriving`: parked
  off-grid, scheduled or in their warp-in) as drawn, **out of `ships`**, so no framing, clearance, team, engagement,
  landmark focus or waypoint anchor sees them until they land. `CinemaScene.incoming` is their drawn spheres once in
  their warp-in within `WARP_IN_HIDDEN_DISTANCE` (2,000 km) of the landing: only `cameraClips` reads it (the rig adds it
  to the clip spheres), so the far plane reaches the streak. `CinemaWarp(id)` reads the arrival first: phase
  **`arriving`** (in `CINEMA_WARP_PHASES`) with the arrival's landing, else the Destiny warp. `warp-landing` (group or
  ship) selects from `ships + arriving` (`selectCinemaGroup(…, { arriving: true })`) and treats `arriving` like
  `warping`: it frames the landings and anchors on the first frame; the lane is landing minus the parked (or
  streaking) drawn centre. A landed leader with members still arriving (a staggered arrival) hands the reference to the
  first arriving member, so the shot still anchors. Every other group or ship hardpoint frames only the landed ships;
  an all-arriving subject has no pose and the note `… is still arriving by warp: play warp-in, or wait for it to
  land` (a playing shot releases with it). `list_hardpoints`' subject says `arriving` (a ship: true; a group: the
  count), with no frame until something landed.
- **Landmarks** frame from the landmark toward the scene's focus (`sceneFocus`: the engagement centre, or the origin).
  `establishing` puts the eye beyond the ships, pitched 8° up, at a distance clamped between 1.5 × focus radius + 2 km
  and the distance where the ships still fill 12 % of the frame; `hero` swings ±50° / 15° up on a 30° lens;
  `foreground` sits behind the limb (-1.2r forward, ±1.3r side, 0.25r up) looking at the focus.
  **`MAX_LANDMARK_EYE_DISTANCE` 1e8 m**: a landmark eye farther from the origin gets no pose ("too far from the scene
  ... (float32)"); a hero or foreground on a far planet or the star hits it. A celestial frames on its map radius (the
  SDE's for stations and gates, often larger than the hull): ask for a larger `fill`.

## The shot spec (`shot.ts`)

```
{ hardpoint: { name, ship | fleet [+ wing | squad] | ships | teams | object | celestial, target?, fill?, fov?, bank?, side? }
    | pose: { eye, look, up?, roll?, fov? }          eye / look: [x, y, z], { position } or { ship | object, offset?, units?, bank? }
    | shot: "<library name>", ...subject, options, overrides,
  moves?: [...], duration?: s (omitted: hold until stopped), end?: "release" | "hold",
  transition?: { type: "cut" } | { type: "blend", duration?, easing? },
  lag?: { eye?, look? } (time constants, s), letterbox?: aspect | false, hud?: boolean, clearance?: radii | false, name? }
```

- Blend default 1.5 s ease-in-out from the last drawn pose. Fov 5–120°; a pose without one takes 45°.
- A sequence (`{ shots }`) advances on each shot's duration; the last shot holds unless it has one, then releases, or
  with **`end: "hold"`** keeps its last frame (moves at their end values, the hardpoint still tracking; `progress` 1,
  `holding: true`) until stopped or replaced. `normalizeCameraShot` expands a `{ shot }` reference first and records
  `library`.
- **Pose waypoints**: a pose eye or look on a hull follows it (a fixed eye watching a moving ship, or a deck camera);
  the eye's hull is exempt from clearance, both are subjects (removing one releases and forgets). "eye and look must
  differ" is checked only for two bare vectors; a resolved coincidence holds the last pose.
- `path.units: "radii"` (needs `frame: "subject"`) scales the bare points by the subject's radius
  (`WaypointContext.frame.scale`), so one path fits any engagement or fleet.
- Moves, each with `at?` (s into the shot), `duration?`, `easing?` (`linear`, `ease-in`, `ease-out`, `ease-in-out`):
  `dolly | truck | crane { distance }`, `push { factor }` (< 1 in), `zoom { fov }`,
  `orbit { axis?, rate? | angle? }`, `roll { rate? | angle? }`, `spin { axis, rate? | angle? }`
  (axis `up` | `subject-up` | `view-up` | `[x, y, z]`), `path { points, frame?, look?, up? }`, `track { lag }`,
  `shake { amplitude °, frequency? Hz, decay? s }`.
- Moves apply in order to the hardpoint's live pose, in its own frame. Timed moves run over their duration (else the
  shot's, else 4 s); rate moves turn steadily until the shot ends. The shake is value noise seeded per shot (no
  `Math.random`), so replays and exported movies repeat it.

## Waypoints (`waypoints/`)

A waypoint is a bare `[x, y, z]` (in the path's `frame`: world, or the subject's `[forward, starboard, up]`),
`{ position }` (scene metres), or `{ ship | object, offset?: [forward, starboard, up], units?: 'metres' | 'radii',
bank? }` riding on a hull, any of them with `time?` (seconds into the path it is passed). A path is a centripetal
Catmull-Rom walked by arc length, resolved and measured again every frame because anchored points move.

- `path.look`: `'path'` (along the tangent), `'subject'`, or a waypoint (a point on a hull ahead pans along it).
  `path.up`: `'base'`, `'world'`, or `{ ship | object }` (the hull's banked up, so a pan over a rolled hull stays level).
- **A path's anchor hulls are exempt from hull clearance**, so the eye can pass over a hull it rides on. `clearance`
  (a radius multiple, or false) sets clearance for the other hulls for the whole shot.
- Nothing in `waypoints/` knows about cameras, on purpose: ship pathing (a ship flying a route at set speeds) is meant
  to reuse `resolveWaypoint` and the path walk.

## How it draws

- **`FreeCamera` writes EveCamera's own `TriView` / `TriProjection`** (`GetViewMatrix().SetTransform`,
  `EveCamera.CalculateProjectionMatrix`) **after** the orbit's `Update`, and **never calls `EveCamera.Update`**: no
  zoom curve, no pitch clamp, no float32 orbit math. The driver reads only those two objects, so picking, the audio
  listener and the planet pass's clip planes keep working. The d.ts gained `SetTransform`, `CustomProjection`,
  `CalculateProjectionMatrix` and `CalculateFovFromProjection`.
- The orbit keeps updating underneath, so a release has a live target: `CINEMA_RELEASE_SECONDS` 0.5 blends the last
  cinematic pose into `OrbitCamera.Drawn()`.
- **The rig runs on the scene clock**, in `Director.TrackCamera(now)` (after `world.Tick`, before `engine.Frame`), on
  the **drawn** ClientBall samples (`world.Curves(id)` translation, rotation, velocity), never the Destiny master,
  which runs up to a tick ahead. A paused clock holds the shot; lag is exponential smoothing on scene seconds.
- It runs without a renderer too (aspect 16:9), which is how verify-page checks it headless.
- Per frame: resolve the hardpoint → moves → lag → `clearHulls` → `cameraClips` (hulls plus `incoming`; near = half
  the nearest surface distance, 0.5 m inside a hull's sphere, never below far / 2e6; far = max(1e5, 1.1 × (farthest
  sphere + reach))).
- `CinemaScene` is built only while a shot plays: ships (arriving ones apart, above), fleets, the sun direction (the
  scene's, else away from the location's star, else down), the location's celestials and the objects' spheres
  (cleared and usable as anchors).

## Takeover, release and cuts

| Event | Effect |
|---|---|
| Left or middle `pointerdown` (not alt), or the wheel, on the canvas, while a shot plays or is paused | release with **adopt** (`ReleaseCinema`, as `stop_shot`): the orbit takes the cinematic eye and look first, so the drag continues from the image; a ship subject is also followed (no document write); resumable |
| Right-click | nothing: the shot keeps playing (the user's call) |
| `frame_camera`, `set_camera`, alt-click, C, the follow buttons (`ChangeCamera`) | release (resumable) |
| A load (`load_scene`, `open_scene`) | cut, forgotten |
| An edit that changes the document camera (resumable), or removes a subject (forgotten) (`CinemaReleases`, beside `ReframesAfterEdit`) | release |
| Any other edit | the shot keeps playing; `ReframesAfterEdit` still drives the orbit underneath |
| A subject left the scene mid-shot, or the hardpoint has no pose | release, forgotten, with a note |

The canvas listeners are capture-phase, so they run before `OrbitCamera`'s own handlers.

## Presentation

- `?letterbox=2.39` (or `off`) resizes the canvas element to the aspect, centred on black, so `screenshot` and later
  movie export capture exactly the frame; L toggles a 2.39 letterbox. `LetterboxRect` pillarboxes a wider window.
- `?hud=off` hides the overlay; H toggles it. `screenshot` never includes the DOM overlay; `take_screenshot` does.
- A shot's `letterbox` / `hud` win while it plays, then the page's settings come back.

## get_state

- `cinema`: `state` (`idle` | `playing` | `paused` | `releasing`), `driver` (`claude` | `director` | `timeline` | `user`), `shot`
  (`name`, `library`, `hardpoint` or `pose`, `moves`, `transition`, `end`, `elapsed`, `duration`, `progress`,
  `holding`), `sequence { index, count, elapsed, duration, progress }` (over the whole sequence; null duration when the
  last shot holds), `resumable { name?, library?, index, count, elapsed }`, `pose`, `near`, `far`, `letterbox`, `hud`,
  `note` (why it ended). Present headless too.
- `camera.view`: `orbit` | `cinema`; `camera.drawn { eye, look, up, fov, near, far }` from the drawn matrices (null
  without a renderer). The orbit's existing fields stay.

## Real-GPU checks

### The director (`auto_camera`, 2026-10-24, Windows Chrome, NVIDIA, 1600 × 900, `?audio=off`)

Private hub on 5522 (temp stores; 5521 was another session's), Jita IV - Moon 4 - CNAP 30 km off, the TFIs (blue,
brawler), an `auto_camera { follow: { fleet: 'tfis' } }` cue at 1 and 15 Caracals (red, line, 40 km off `tfis-fc`,
`warpIn`) at 8; `timeline restart`. Driver, rows and screens in `.scratch/director-gpu/` on dbxpc (`drive.mjs <phase>`,
`sheet.mjs` contact sheets). page_log 0 errors and `gpuErrors` 0 in every run.

- A 100 s run cuts 16 times: establishing on the CNAP, hero FC, **warp-in on fleet red 5 s before its first landing**,
  hero, behind-fc, then kills (each victim framed at its kill tick, held, cut away before removal), flybys, chases and
  over-the-shoulders, all on one side (starboard) after the first sided shot. Hero, flyby, chase and over-the-shoulder
  read well.
- Two fixes from it: **the eye guard took the CNAP's 100 km map radius** (its SOF sphere is 156 km), so a scene 30 km off
  it refused every eye on the station side, warp-in and the engagement wides included: stations and gates now guard at
  half the map radius. **Kill shots at fill 0.12** showed the victim and its blast as a dot: now 0.25 (0.4 over 300 m),
  the fireball mid-frame with the fight around it. Also: urgent cuts now apply past the min hold (a kill 4 s into a
  wide waited for the ratio), and engage dropped from 8 to 7 so a fight opening no longer cuts a doomed ship's shot
  at 2 s.
- Two `timeline restart`s: equal cut logs from the warp-in on; the openings differed by a tick only because the
  driver's closing `auto_camera {}` left a Claude-sourced director on (it picks at t = 0).
- Variants: `favour: 'wide', sun: true` cuts to group wides (behind-fc, flank, leading-edge); overlook reaches the top
  three but loses on rhythm, and into-sun never qualifies here (its eye lands on the CNAP side). `pace: 'fast'`: 4–7 s
  holds. Claude's `play_shot { shot: 'hero', ship: 'tfis-fc', duration: 6, end: 'release' }`: claude for 6 boundaries,
  then director, no `user` between. A canvas pointerdown: yielded (user); D: driving again; the HUD row reads "driving ·
  hero FC · 0 s (FC passes Eos at 514 m/s)". Movement-only (the TFIs flying, a Caracal fleet passing, no teams): axis
  `motion` on the FC, wide / medium / close, one side, mostly FC framings.
- fps: 15–20 mean in the fight (min 1–2 at the Caracals' warp-in builds); over the same 30–60 s window the director off
  (orbit on the FC) 11.9 and on 14.6, so its pick costs nothing visible; cost ~2 ms mean per boundary, max 6 ms.
- Open: whole-fleet wides (behind-fc, flank) frame the TFIs' logi 30 km out and draw the hulls as specks.

### The MCP tools and the library (2026-10-22)

Note `scene-director-cinema-mcp-gpu-check`; screens in `.scratch/cinema-mcp-check/` on dbxpc (driver `shot.sh`). A
fresh hub on 5521 (temp stores) from the new build, driven by `call … --port 5521`; Jita IV - Moon 4 - CNAP, TFIs vs 12
Muninn + 3 Scimitar, an Astrahus; 63 ships. 23–28 fps (13–19 while a headless verify-page shared the box), 0 GPU
errors, page_log clean.

- Every library shot, an explicit roll + spin, a free pose tracking the flying FC, a 3-shot sequence, pause/resume,
  stop/resume, a pointer takeover then resume: all as specified. Hero, flyby, fly-through and the establishing CNAP
  read well; engagement-wide shots (overlook, into-*) draw hulls a few px because the TFIs' logi set the radius.
- `into-sun` put the eye inside the CNAP (the sun is behind it; dressed stations are not cleared): the L3 clearance
  follow-up.
- "Watch a fleet land" found three warp-landing bugs, fixed: the stale landed warp, the formation not turned to the
  lane, and the whole-formation radius (now the core). Landing toward the fight it reads: the fleet settles lit in
  front of the CNAP. Landing away from the sun the hulls are back-lit silhouettes (it looks into the light).

### The warp-in shot on arrivals (2026-10-23, Windows Chrome, NVIDIA, 1600 × 900, `?audio=off`)

Private hub on 5521 (temp stores), Jita IV - Moon 4 - CNAP 30 km off, the TFIs added with `warpIn: true`, then
`play_shot { shot: "warp-in", fleet: "tfis" }`; driver and screens in `.scratch/warp-in-gpu/` on dbxpc.

- The shot anchors at once on the arriving landings ("holding on the landing of fleet tfis's warp") and holds while
  the fleet streaks in, flashes and forms up. 0 GPU errors, page_log clean.
- Two fixes from it: the 80% core reached the TFIs' carriers (eye 83 km out, hulls a few px), now the median spread
  (eye 8.5 km); and the starboard default looked into the light (silhouettes against the nebula), now the sunward side
  (hulls lit, the moon behind).
- Headless (`verify-page --only warp-in`): a Rifter fleet's shot anchors with its look within 5 km of the FC's landing
  while all three are still arriving; `flank-port` on it is refused with "fleet ws is still arriving by warp: play
  warp-in, or wait for it to land".

### The rig (2026-10-22, Windows Chrome, 1600 × 900, `?audio=off`)

Notes `scene-director-cinema-gpu-check`; screens in `.scratch/cinema-check/` on dbxpc.

- Ship hardpoints and the flyby on a Punisher at full speed: 59–60 fps, hull centred and steady, no near-plane cut.
  TFIs `behind-fc`, `flank-*`, `top-down`, `leading-edge`; `overlook` with `push`; `into-sun`; a 2 s blend probed per
  frame (no pop); orbit + roll; a world path between teams; shake; drag takeover; alt-click release. 0 GPU errors.
- A waypoint fly-over riding `tfis-dps-a-03` (radius units, `up: { ship }`) while the 44-ship TFIs flew: 34–58 fps
  (the TFIs in flight), 0 GPU errors. The eye passes inside the hull's bounding sphere (exempt), near drops to 0.5 m,
  and the hull draws intact a few metres off the lens. With `look: 'path'` and the eye 0.3R over the centre the deck
  sits just below the frame mid-pass; look at a waypoint on the hull ahead to keep it in frame.
- `overlook` / `into-sun` on a 100 km engagement draw hulls a few pixels wide: they fit every ship, logi included.
- The orbit then drew at 90° whatever `camera.fov` said (the zoom curve, fixed 2026-10-23: `sd-runtime`), so a release
  blended the fov from the shot's lens to 90°. It now blends to the document's fov (default 90).
- `?letterbox=2.39`: the canvas and `screenshot` are 1600 × 669 (2.392:1); L and H toggle; a shot's `hud: false` and
  `letterbox: 2.39` apply while it plays and restore after. `frame_camera` mid-shot released it ("frame_camera took
  the camera"); a right-click mid-shot left it playing.
