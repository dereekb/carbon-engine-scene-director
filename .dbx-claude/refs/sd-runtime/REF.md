# scene-director × CarbonEngineJS runtime: import point, bundling, renderer gotchas

> How the page talks to `@carbonenginejs/runtime` (the JS port of EVE's engine) and the server (Destiny), and the
> runtime behaviors that have each cost real debugging. Fetch before touching `runtime.ts` / `runtime-sim.ts`, a
> `carbonenginejs-*.d.ts`, `esbuild.config.mjs`, `engine.ts`, `ships.ts`, `environment.ts`, `resources.ts`, `audio.ts`
> or `location-dressing.ts`. Destiny's own quirks are in `sd-destiny`.

## The import point

| File | Role |
|---|---|
| `apps/viewer/src/lib/runtime.ts` | **every** runtime symbol the page uses, one file to fix on an API change. Re-exports `runtime-sim.ts` |
| `apps/viewer/src/lib/runtime-sim.ts` | the light half: math, the Blue curve bases, the Destiny server. Node-tested modules import only this |
| `apps/viewer/src/lib/carbonenginejs-runtime.d.ts` | types for the runtime imports (the runtime ships no `.d.ts`) |
| `apps/viewer/src/lib/carbonenginejs-server.d.ts` | types for the Destiny server imports |

- **Add a member to the `.d.ts` when the page starts using it; never reach for `any`.**
- A runtime-called method we implement either extends a runtime class or implements an interface declared in the
  `.d.ts` first, so a wrong rename fails to compile (see the naming rules in `sd-workspace`).
- **Node-tested modules import `./runtime-sim`, never `./runtime`** (type-only imports are fine): `clock.ts`,
  `destiny.ts`, `flight.ts`, `warp.ts`, `boosters.ts`, `steering.ts`, `camera.ts`, `following.ts`, `location.ts`,
  `celestials.ts`, `prop-mods.ts`, `prop-mod-audio.ts`, `objects.ts`, `audio-guard.ts`, `fittings.ts`, `module-cycle.ts`, `modules.ts`, `damage.ts`, `module-fx.ts`, `module-audio.ts`. The full facade drags in the renderer and the `runtime-dist/`
  alias, which vitest does not have. A new node-tested module joins this list.

## Bundling (`apps/viewer/esbuild.config.mjs`)

- **`ignoreAnnotations: true` is mandatory.** The bundle must ignore the runtime package.json's `sideEffects` list:
  many listed files register classes on import, and without them Black reading fails with
  "No source shape registered for Black type ...".
- **`runtime-dist/<file>` resolves to `node_modules/@carbonenginejs/runtime/dist/<file>`.** It reaches files the package
  does not export by design: the WebGPU internals (`trinityal/webgpu/internal.js`) and `global/blue/children.js`
  (`addChild` / `removeChild`). They must resolve to the same files the public subpaths load, so classes are never
  duplicated.
- **The build fails if any `@carbonenginejs/runtime` import resolves outside the page's runtime copy** (the server's
  imports included): a nested copy under the server would duplicate every class.
- The installed runtime must be the pinned local build, not the registry's (lockfile `resolved` + md5 check:
  `sd-workspace`).

## Runtime API drift we already absorbed

- Runtime HEAD removed `Traverse`: `ships.ts` walks a graph with `blue.FindAllReferences(root).keys()` plus the root.
- Runtime ca8b32652 renamed `Destroy()` to `Destruct()`: `ships.ts` `Teardown` calls whichever exists (some resources
  have neither).
- `ITriVectorFunction`'s base `Update__Ticks` passes arguments in the opposite order from its own docs, so
  `destiny.ts`'s `BallRotation` overrides every `*__Ticks` method it serves directly.

## Registration side effects that must stay

- `runtime.ts`'s `@carbonenginejs/runtime/audio` import (re-exports `CjsAudioMan`) also registers the audio classes
  SOF hull values carry (`AudEmitter` and friends). **Keep it even if audio ever goes.**
- `resources.ts` registers `CjsPngFormat` with `ImageIO` (`ImageIO.registerImageHandler`): the post process reads
  PNGs. `engine.ts` also uses it to encode screenshots.

## The renderer (`engine.ts`) and the client's dressing (`environment.ts`)

- `engine.ts`: WebGPU device, `EveSpaceScene` with its render driver, the frame loop, orbit camera, frame capture
  (ported from the runtime's Oct 3 WebGPU viewer). The scene initializes empty; ships are added and removed live.
- **The scene needs the EVE client's dressing** (`environment.ts`): a sun environment template as the post process,
  with the client's tonemapping and dynamic exposure added when the template lacks them, plus the sun's lens flare. A
  universe file carries none of these. Without dynamic exposure the nebula (median texel ~0.01 linear) renders at
  about the clear colour's level, which is why it once looked like no background (real-GPU A/B 2026-10-21: default
  draws a nebula field, `?post=off` a near-black one). Whether the exposed nebula looks like the client's is still
  open (a flat brown wash that day, possibly the output device).
- **WebGPU validation errors** reach `page_log` and `get_state.renderer.gpuErrors` only through `engine.ts`'s
  `uncapturederror` listener.
- `Engine.universe` is the document's universe (a change still reloads the tab: the reload trick); `Engine.nebula` is
  what is drawn. Live nebula swap (`SetNebula`) is in `sd-locations`.
- Celestials draw in the planet pass (`scene.planets`, 1 / 1e6 scale, clipped 1e4..1e11 m) before the main pass; the
  sun disc is the planet whose translation curve **is** `scene.sunBall` (Carbon picks the sun by identity). Details:
  `sd-locations`.

## Ships (`ships.ts`)

SOF values from DNA (`hull:faction:race`, e.g. `af1_t1:amarrbase:amarr`), hydration into live `EveShip2` graphs, and
retirement of a removed ship's device resources (only those no retained ship still references). Destiny balls place and
move them (`sd-destiny`).

## Speed chain (why boosters need driving)

The ClientBall's velocity becomes `EveSpaceObject2.worldVelocity` (`UpdateWorldTransform`), `EveShip2.UpdateSyncronous`
sets `speed.value` from it, and `EveBoosterSet2Renderable.CalculateIntensity` divides it by `boosters.maxVel` (runtime
default 250 m/s for every hull). `Director.DriveBoosters` sets that per ship each frame: see `sd-destiny` (`boosters`).

## Module effects (`module-effects.ts`)

The running modules' client effects (what they are and when they play: `sd-fittings` → Module effects and sounds).
`.d.ts` classes: `EveMeshOverlayEffect`, `EveStretch`, `EveStretch3`, `EveTransform`, `EveRootTransform`, `TriCurveSet`,
and `EveShip2.isAnimated` / `overlayEffects` / `AddOverlayEffect` / `RemoveOverlayEffect`.

- **Hydration**: `ResourceValues` once per file, then `CjsSchema.from` on a `structuredClone` of the values inside
  `PageAudio.Detached`, a new object per use. Not `blue.resMan.LoadObject`: it also builds a new object per call
  (`CjsBlueResMan.js` LoadObject), but asynchronously, so it cannot run detached, and an EveStretch3's
  `Tr2AudioStretchBase` (three `AudEmitter`s) or the web's `TriObserverLocal` would register with the page's audio.
  A beam's `audio` / `stretchAudio` are then nulled: `StartFiring` triggers them and controller `Tr2ActionPlaySound`s
  find their emitters through them.
- **Beam ends: write the loaded adapters, never `SetFiringTransform`.** Every module stretch file loads `source` /
  `dest` as `Tr2TranslationAdapter`s (no child curve: they answer `value` at any time). The page copies the drawn
  ClientBall positions into their `value` each frame, before `engine.Frame`.
  - `EveStretch.SetFiringTransform` also calls `SetIsNegZForward(true)` (the turret muzzle path): a module beam then
    points from its source *away* from the target (real GPU 2026-10-23). It also leaves the loaded adapters in place,
    which overwrite the ends.
  - `EveStretch3.SetFiringTransform` nulls `source` / `dest`, but the stretch modifier `Initialize` built
    (`EveChildModifierStretch`) keeps the loaded `dest` and samples it at **Blue's clock**
    (`blue.os.GetCurrentFrameTime()`), so the stretched mesh would aim at the file's `[0, 0, 10000]`; and a notified
    `dest = null` drops the modifier (`OnModified`), leaving the mesh unstretched. Writing the adapter keeps the
    modifier on the target, whatever the clock.
- **Order**: beams and the web's root go into `scene.objects` with `Engine.AddObject` (typed `SceneObjectRoot`: static
  objects and these) when they first place, after the ships built by then.
- **Overlays**: the overlay's curve set plays on load (`TriCurveSet.playOnLoad` defaults true); the hull drives its
  `Update` (curve LOD-gated by the ship). Teardown: `RemoveOverlayEffect`, then `Destruct()` every `Tr2Effect` in its
  opaque / decal / transparent / additive / distortion lists (ship retirement does not destruct Tr2Effects; `Destruct`
  only unhooks the effect's own resource notifications and bindings, so a shared shader survives). A rebuilt hull gets
  a fresh overlay. Only `_skinned` overlay files exist: on a non-animated hull (`isAnimated` false, e.g. the Guardian)
  the overlay emits its batch but draws nothing visible (2026-10-23; follow-up).
- **Web**: an `EveTransform` scene child needs an `EveRootTransform` parent (`addChild(root, 'children', web)`) to be
  placed by curves; `useLodLevel = false` on the whole tree, or small on screen its curve sets step at 1 Hz.
- **Retire**: stretches and roots go through `RetireShips([root], retained)` with every other live root; the
  director adds `ModuleEffects.Roots()` to the ships', dressing's and objects' retained sets.

## Audio (`audio.ts`)

The runtime's `CjsAudioMan` with a media provider over the hub's `/audio/path` route (the runtime's own provider lives
in its demo, not the package). It enables every sound bank as the demo does (PostEvent is gated on bank status); media
is read per event with HTTP ranges into the banks (the engine stems sit inside the 32 MB `boosters.bnk`, so the hub
proxy must stream and forward `Range`). Emitters start culled, so a fresh emitter's first event plays when the next
audio frame wakes it in range. `CjsAudioMan` starts only after a user gesture (or with autoplay allowed). The Web Audio
backend does not apply an event's authored stop relationships (a `_powerdown` that should stop `_on` leaves it looping),
so the page stops such voices itself (`sd-ship-stats`). Which events play: `sd-ship-stats`.

- **SOF audio stays inert: only the page's emitters play.** `AudGameObjResource` registers with whatever
  `CjsAudioMan` attached to its static seams, so a hull hydrated while audio is on registers its own emitters
  (`Engine_SFX`, `ShipDefense_Module_sfx`, ...; 29 for five battleship-to-capital hulls) and its controllers
  (`Tr2ActionPlaySound`) post EVE's engine sounds (`ship_engine_M_booster_3rd_on`, 26 voices for the TFIs fleet) that
  the page never posted and nothing releases with the ship. **Every SOF hydration runs inside `PageAudio.Detached`**
  (`Director.Build`, and `BuildStaticObject`'s `detachAudio` for the dressing's stations and gates and the scene's
  objects), which detaches the seams for the synchronous build. A new SOF build path must do the same; the engine hum
  must adopt the graphs on purpose (follow-up), not by registration. A failed `Enable` detaches the seams too.
- **The backend is guarded (`audio-guard.ts`), because Chrome throws from the runtime's AudioParam scheduling.**
  Every per-voice scheduler (`ScheduleVoiceVolumeGain`, `ScheduleVoicePitchPlaybackRate`, `ApplyVoiceFilter`, the bus
  gains) runs on each placement and RTPC refresh: `cancelAndHoldAtTime(now)`, `setValueAtTime(v, now)`,
  `param.value = v`, then a `setValueCurveAtTime` per fade boundary. Chrome moves events scheduled after a quantum's
  processing to the next quantum except value curves, so the setValues land inside the curve, `cancelAndHoldAtTime`
  keeps it, and the next `setValueAtTime(now)` throws NotSupportedError ("overlaps setValueCurveAtTime"); a curve
  scheduled from a stale `now` overlaps the next one too. Those throws came out of `EveSpaceScene.Update`
  (`TriObserverLocal.Update` → emitter placement, `Tr2ActionBindRTPC.Update` → RTPC), so `engine.Frame` failed the
  frame and rejected a pending screenshot (16 failed frames heard as a banging loop, 2026-10-22). The guard patches
  the backend instance at enable: the six `_ApplyVoice*` appliers clear their own params
  (`cancelScheduledValues(0)`, the runtime's own non-`cancelAndHold` branch) before scheduling, which removed every
  `setValueAtTime` throw in a headless repro, and retry once on an overlap; the nine entry points emitters and the page
  reach are try/caught (`PostEvent` returns 0). Curve-on-curve throws remain upstream's to fix: contained and counted.
  **On a runtime pin bump, re-check `VOICE_APPLIER_PARAMS` and `CONTAINED_BACKEND_CALLS` against
  `CjsWebAudioSoundEngine.js`** (the names are declared in the `.d.ts`, so a rename fails to compile); drop the
  pre-clear once upstream schedules from a future boundary. Upstream draft: the `carbonenginejs-runtime` note.
- `CjsAudioMan.Process` still schedules AudioParams the guard does not cover (`CjsWwiseSourceEffectRtpcLane.Apply`;
  41 `_on` loops: ~10 throws a second for 35 s); the page counts those frames and goes on.
- `get_state.audio`: `emitters` (the page's), `gameObjects` (registered with the runtime's manager: those plus the
  listener; more means something else registered), `frameErrors` / `lastFrameError` (`Process`), `rescheduled`
  (applier retries that went through), `backendErrors` / `lastBackendError` (contained calls). Each is logged at most
  once per 10 s (`console.info` for rescheduled, `console.warn` with the stack for contained). `verify-page` checks
  that a TFI build leaves `gameObjects − emitters` unchanged (skipped without a renderer or with audio off).
