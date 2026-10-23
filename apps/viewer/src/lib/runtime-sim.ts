/**
 * The light half of the runtime import point: math, the Blue curve bases and the Destiny server. runtime.ts
 * re-exports all of it. The node-tested modules (clock.ts, destiny.ts) import only this file, so their specs load in
 * milliseconds and never need the renderer or the `runtime-dist/` alias.
 */

export { ITriQuaternionFunction, ITriVectorFunction } from '@carbonenginejs/runtime/blue';
export type { TriVectorCurve } from '@carbonenginejs/runtime/blue';
export { quat } from '@carbonenginejs/runtime/math/quat';
export type { Quat } from '@carbonenginejs/runtime/math/quat';
export { vec3 } from '@carbonenginejs/runtime/math/vec3';
export type { Vec3 } from '@carbonenginejs/runtime/math/vec3';
export { CjsBallparkController, CjsDestinyBall, CjsDestinyClientBall, CjsDestinyStream } from '@carbonenginejs/server/destiny';
export type { DestinyInt64 } from '@carbonenginejs/server/destiny';
export { CollideTwoSpheres } from '@carbonenginejs/server/destiny/geometry';
