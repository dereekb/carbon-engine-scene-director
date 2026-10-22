# Boosters (sd-destiny sub-doc)

Code: `apps/viewer/src/lib/boosters.ts` (pure, node-tested), driven by `Director.DriveBoosters(now)` each frame after
`world.Tick` and before drawing.

## Why the page drives them

- `EveShip2` derives its `speed` from the translation curve (the ClientBall) every frame itself. A booster set's
  intensity is a low-pass of 0.8 × speed / `boosters.maxVel` (plus acceleration), **capped at 2**
  (`EveBoosterSet2Renderable.CalculateIntensity`).
- The runtime defaults `boosters.maxVel` to **250 m/s for every hull**, and nothing in it drives `warpIntensity`.
- So every frame, per built ship: `boosters.maxVel` and `maxSpeed` = its Ship-stats max velocity (full speed reads the
  same on every hull), and `boosters.warpIntensity` ramps in from `WARP_GLOW_FROM` to `WARP_GLOW_FULL` (10× to 14× its
  max velocity), so only a warp shows the warp colours.
- **`boosters.maxVel` stays the prop-mod-off max velocity** (`ShipFlight.maxVelocity`; only `get_state`'s `physics`
  swaps in the running numbers). A running AB pushes the flames past full and an MWD drives them to the cap of 2.

## Shader facts the numbers rely on

- **No booster shader reads `shipSpeed`**, so an AU/s warp is safe for ships near the origin.
- `BoosterVolumetric` reads the warp half of its colour gradient for **any** `warpIntensity` > 0 while its tints still
  lerp, so a low blend draws a Minmatar flame violet. That is why `WARP_GLOW_FROM` / `WARP_GLOW_FULL` stay a **short
  ramp** (with 10×–100× a Minmatar flame drew violet for ~0.5 s at the end of a warp). The warp colours follow speed,
  so they leave ~3 s before the ship drops out of warp.
- Trails fade out in warp by the runtime's own rules.
- **Booster LOD** goes by the booster sphere's pixel size: a Slasher's flames vanish beyond ~600 m on a 900 px canvas.
  Dark boosters in a far shot are LOD, not the drive.

## Reporting

`get_state` reports each built ship's `boosters` (`maxVel`, `intensity`, `warpIntensity`) when there is a renderer.

## Real-GPU evidence (2026-10-22, Windows Chrome, NVIDIA; a Slasher and a Tempest Fleet Issue)

- At rest: dark (no flame, flare, light or trail; the runtime culls the flame at intensity 0).
- Full speed: Minmatar flames orange with warm flares; trails ~2.1 km (frigate), a faint 0.6 km (battleship).
  Intensity eases ~0.95 → 0.8 over a few seconds as acceleration fades, in steps at the 1 s ticks, then holds.
- In warp: full-length pale blue-white warp colours with a blue stern light; trails go out above ~12 km/s and come back
  as long streaks at the end of the exit.
