# The cinematic camera: hardpoints, shots, moves and waypoints

> A camera rig in the viewer that plays shots on hardpoints generated from the drawn ships, with timed moves,
> waypoint fly-throughs, a letterbox and a clean HUD. Fetch before touching `packages/scene/src/lib/cinema/`,
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
| `cinema/subjects.ts` | `CinemaShip`, `CinemaScene`, `shipFrame`, `groupFrame`, `selectCinemaGroup`, `engagementFrame`, `cinemaSpheres`, `cinemaAnchor` |
| `cinema/hardpoints.ts` | the three catalogs, `resolveHardpoint`, `listHardpoints` (for the coming `list_hardpoints`), `findCelestial` |
| `cinema/shot.ts` | the JSON shot spec: `normalizeCameraShot` / `normalizeCameraSequence` → `{ shot, problems, warnings }`, `CAMERA_MOVE_TYPES`, `CINEMA_EASINGS` |
| `packages/scene/src/lib/waypoints/waypoints.ts` | `Waypoint`, `resolveWaypoint`, `readWaypoints`, `measureWaypointPath`, `pathPointAt` / `pathTangentAt` / `pathDistanceAt`, `catmullRom` |
| `apps/viewer/src/lib/cinema.ts` | `CinemaRig` (`Play`, `Stop`, `Release`, `Frame`, `Report`, `Presentation`, `Subjects`), `CinemaReleases`, `LetterboxRect`; node-tested |
| `apps/viewer/src/lib/cinema-moves.ts` | `EvaluateMoves`, `Ease`, `TrackLag`, `Smooth`, the seeded `Noise` / `ShakeEnvelope`; node-tested |
| `engine.ts` | `FreeCamera`, `Engine.SetCinematicFrame` / `DrawnCamera` / `Aspect`, `OrbitCamera.Drawn` |
| `director.ts` | `cinema`, `TrackCamera`, `PlayShot` / `StopShot`, `CinemaScene`, `TakeOverCinema`, the `CinemaReleases` call in `Apply` |
| `main.ts` | `Presentation`: `?letterbox=`, `?hud=off`, the L and H keys, a shot's overrides |
| specs | scene `cinema/cinema.spec.ts`, `waypoints/waypoints.spec.ts`; viewer `cinema.spec.ts`; verify-page `--only cinema` (four checks) |

## Driving it (no MCP tool yet)

The hub refuses tool names that are not in `TOOLS`, and the MCP tools (`play_shot`, `play_sequence`, `stop_shot`,
`list_hardpoints`) and the named shot library are the next child's. Until then, drive it in the page:

```js
sceneDirector.director.PlayShot({ hardpoint: { name: 'hero-port', ship: 'punisher-1' }, duration: 6, moves: [{ type: 'push', factor: 0.7 }] });
sceneDirector.director.PlayShot({ shots: [shotA, shotB] });          // a sequence (or a bare array)
sceneDirector.director.StopShot();                                   // release; { cut: true } cuts
sceneDirector.director.cinema.Report();                              // what get_state.cinema shows
```

chrome-devtools `evaluate_script` or Playwright `page.evaluate`. `PlayShot` returns `{ state, shots, warnings }` and
**throws** `Invalid camera shot:` with the normalizer's problems (the playing shot carries on). A new play while one
runs blends from its pose. The driver defaults to `claude`.

## Hardpoints

Generated every frame from the drawn samples, so they follow a ship that flies, turns or warps. Ship hardpoints scale
with the SOF bounding radius (100 m until built); `[forward, starboard, up]` coefficients, a fill and a lens per row.

| Kind (subject) | Names |
|---|---|
| ship (`ship`) | `chase`, `rear-quarter-{port,starboard}-{high,low}`, `hero-{port,starboard}` (30° lens), `bow-on`, `broadside-{port,starboard}`, `belly`, `top-down`, `over-the-shoulder` (`target`, default the nearest enemy), `flyby` |
| group (`fleet` [+ `wing` \| `squad`], or `ships`) | `behind-fc` (looks past the leader at the nearest enemy centroid, else ahead), `flank-{port,starboard}`, `top-down`, `leading-edge` |
| engagement (`teams?: [a, b]`, default the two biggest) | `overlook` (`side`), `into-sun`, `into-celestial` (`celestial`: an id or a name from the location) |

- Overrides: `fill`, `fov`, `bank` (stand in the banked frame instead of the level heading frame).
- **Starboard is `forward × up`**, −X at yaw 0. `staging/placement.ts` `headingVectors().right` is +X, the port
  side: never reuse it as starboard. A spec pins the sign.
- `top-down` and `belly` put the bow at the top of the frame (up = forward): EveCamera's ±1.4 rad pitch clamp is why
  the orbit cannot do this.
- `flyby` is **anchored**: the eye is fixed at shot start, ahead on the drawn velocity at max(6R, speed × 4 s), 2.5R
  to starboard and 0.8R up (a ship at rest uses its forward); the look stays live, so it pans as the hull passes.
- A whole fleet's extent includes the logi 30 km out; a wing or squad frames tighter.

## The shot spec (`shot.ts`)

```
{ hardpoint: { name, ship | fleet [+ wing | squad] | ships | teams, target?, celestial?, fill?, fov?, bank?, side? }
    | pose: { eye, look, up?, roll?, fov? },
  moves?: [...], duration?: s (omitted: hold until stopped), transition?: { type: "cut" } | { type: "blend", duration?, easing? },
  lag?: { eye?, look? } (time constants, s), letterbox?: aspect | false, hud?: boolean, clearance?: radii | false, name? }
```

- Blend default 1.5 s ease-in-out from the last drawn pose. Fov 5–120°; a pose without one takes 45°.
- A sequence (`{ shots }`) advances on each shot's duration; the last shot holds unless it has one, then releases.
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
- Per frame: resolve the hardpoint → moves → lag → `clearHulls` → `cameraClips` (near = half the nearest surface
  distance, 0.5 m inside a hull's sphere, never below far / 2e6; far = max(1e5, 1.1 × (farthest sphere + reach))).
- `CinemaScene` is built only while a shot plays: ships, fleets, the sun direction (the scene's, else away from the
  location's star, else down), the location's celestials and the objects' spheres (cleared and usable as anchors).

## Takeover, release and cuts

| Event | Effect |
|---|---|
| Left or middle `pointerdown` (not alt), or the wheel, on the canvas | release with **adopt**: the orbit takes the cinematic eye and look first, so the drag continues from the image; a ship subject is also followed (no document write) |
| Right-click | nothing: the shot keeps playing (the user's call) |
| `frame_camera`, `set_camera`, alt-click, C, the follow buttons (`ChangeCamera`) | release |
| A load (`load_scene`, `open_scene`) | cut |
| An edit that changes the document camera, or removes a subject (`CinemaReleases`, beside `ReframesAfterEdit`) | release |
| Any other edit | the shot keeps playing; `ReframesAfterEdit` still drives the orbit underneath |
| A subject left the scene mid-shot | release, with a note |

The canvas listeners are capture-phase, so they run before `OrbitCamera`'s own handlers.

## Presentation

- `?letterbox=2.39` (or `off`) resizes the canvas element to the aspect, centred on black, so `screenshot` and later
  movie export capture exactly the frame; L toggles a 2.39 letterbox. `LetterboxRect` pillarboxes a wider window.
- `?hud=off` hides the overlay; H toggles it. `screenshot` never includes the DOM overlay; `take_screenshot` does.
- A shot's `letterbox` / `hud` win while it plays, then the page's settings come back.

## get_state

- `cinema`: `state` (`idle` | `playing` | `releasing`), `driver`, `shot` (`hardpoint` or `pose`, `moves`,
  `transition`, `elapsed`, `duration`, `progress`), `sequence { index, count }`, `pose`, `near`, `far`, `letterbox`,
  `hud`, `note` (why it ended). Present headless too.
- `camera.view`: `orbit` | `cinema`; `camera.drawn { eye, look, up, fov, near, far }` from the drawn matrices (null
  without a renderer). The orbit's existing fields stay.

## Real-GPU checks (2026-10-22, Windows Chrome, 1600 × 900, `?audio=off`)

Notes `scene-director-cinema-gpu-check`; screens in `.scratch/cinema-check/` on dbxpc.

- Ship hardpoints and the flyby on a Punisher at full speed: 59–60 fps, hull centred and steady, no near-plane cut.
  TFIs `behind-fc`, `flank-*`, `top-down`, `leading-edge`; `overlook` with `push`; `into-sun`; a 2 s blend probed per
  frame (no pop); orbit + roll; a world path between teams; shake; drag takeover; alt-click release. 0 GPU errors.
- A waypoint fly-over riding `tfis-dps-a-03` (radius units, `up: { ship }`) while the 44-ship TFIs flew: 34–58 fps
  (the TFIs in flight), 0 GPU errors. The eye passes inside the hull's bounding sphere (exempt), near drops to 0.5 m,
  and the hull draws intact a few metres off the lens. With `look: 'path'` and the eye 0.3R over the centre the deck
  sits just below the frame mid-pass; look at a waypoint on the hull ahead to keep it in frame.
- `overlook` / `into-sun` on a 100 km engagement draw hulls a few pixels wide: they fit every ship, logi included.
- The orbit draws at 90° (the zoom curve overwrites the fov), so a release blends the fov from the shot's lens to 90°.
- `?letterbox=2.39`: the canvas and `screenshot` are 1600 × 669 (2.392:1); L and H toggle; a shot's `hud: false` and
  `letterbox: 2.39` apply while it plays and restore after. `frame_camera` mid-shot released it ("frame_camera took
  the camera"); a right-click mid-shot left it playing.
