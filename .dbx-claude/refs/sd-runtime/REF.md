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
  `celestials.ts`, `prop-mods.ts`, `prop-mod-audio.ts`. The full facade drags in the renderer and the `runtime-dist/`
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

## Audio (`audio.ts`)

The runtime's `CjsAudioMan` with a media provider over the hub's `/audio/path` route (the runtime's own provider lives
in its demo, not the package). It enables every sound bank as the demo does (PostEvent is gated on bank status); media
is read per event with HTTP ranges into the banks (the engine stems sit inside the 32 MB `boosters.bnk`, so the hub
proxy must stream and forward `Range`). Emitters start culled, so a fresh emitter's first event plays when the next
audio frame wakes it in range. `CjsAudioMan` starts only after a user gesture (or with autoplay allowed). The Web Audio
backend does not apply an event's authored stop relationships (a `_powerdown` that should stop `_on` leaves it looping),
so the page stops such voices itself (`sd-ship-stats`). The SOF
ships' own emitters (engine hum) stay inert: nothing adopts their graphs yet. Which events play: `sd-ship-stats`.
