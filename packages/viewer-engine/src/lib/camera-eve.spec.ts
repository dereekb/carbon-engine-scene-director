import '@carbonenginejs/runtime/trinity';
import { EveCamera } from '@carbonenginejs/runtime/trinity';
import { viewHalfExtents } from '@scene-director/scene';
import { describe, expect, it } from 'vitest';
import { DriveEveCamera, type DrivenOrbit } from './camera';
import { TICKS_PER_MS } from './clock';

/**
 * DriveEveCamera on the runtime's real EveCamera, frame by frame as the page drives it: what it draws is the orbit's
 * fov (Carbon's narrowing above an aspect of 1.6 included) and eye, from the first frame.
 */

const DEGREES = Math.PI / 180;

/**
 * The animation frame's time in ticks, as Engine.Frame hands it over: rAF milliseconds at 60 fps.
 */
function FrameTicks(frame: number): number {
  return Math.round((16.7 + (frame * 1000) / 60) * TICKS_PER_MS);
}

function Orbit(fov: number, yaw = 45, pitch = -15): DrivenOrbit {
  return { focus: [1200, -300, 800], distance: 2500, yaw, pitch, fov, reach: 0 };
}

describe('DriveEveCamera', () => {
  it("draws at the orbit's field of view from the first frame", () => {
    for (const fov of [20, 45, 90, 120]) {
      for (const aspect of [0.7, 1, 1.6, 1960 / 1062, 2.4]) {
        const eve = new EveCamera();
        const { halfWidth, halfHeight } = viewHalfExtents(fov, aspect);
        for (let frame = 0; frame < 60; frame++) {
          DriveEveCamera(eve, Orbit(fov), FrameTicks(frame), aspect);
          const projection = eve.GetProjection().transform;
          expect(1 / projection[5]).toBeCloseTo(halfHeight, 5);
          expect(1 / projection[0]).toBeCloseTo(halfWidth, 5);
        }
      }
    }
  });

  it("is needed: the runtime's default zoom curve overwrites fieldOfView on a fresh camera", () => {
    const eve = new EveCamera();
    eve.fieldOfView = 45 * DEGREES;
    eve.Update(FrameTicks(0), 1.6, FrameTicks(0));
    expect(Math.abs(eve.fieldOfView - 45 * DEGREES)).toBeGreaterThan(0.01);
  });

  it('puts the eye where the orbit says, frame after frame', () => {
    for (const pitch of [-15, 40, -75]) {
      const eve = new EveCamera();
      for (let frame = 0; frame < 120; frame++) {
        const orbit = Orbit(90, (frame * 300) / 119, pitch);
        DriveEveCamera(eve, orbit, FrameTicks(frame), 1.6);
        const view = eve.GetViewMatrix().transform;
        // The view matrix rows are the camera's right, up and back axes in world space; its translation gives the eye.
        const right = [view[0], view[4], view[8]];
        const up = [view[1], view[5], view[9]];
        const back = [view[2], view[6], view[10]];
        const eye = [0, 1, 2].map((axis) => -(view[12] * right[axis] + view[13] * up[axis] + view[14] * back[axis]));
        // camera.ts: the eye sits at focus + distance × (sin yaw cos pitch, -sin pitch, cos yaw cos pitch).
        const yaw = orbit.yaw * DEGREES;
        const tilt = orbit.pitch * DEGREES;
        const direction = [Math.sin(yaw) * Math.cos(tilt), -Math.sin(tilt), Math.cos(yaw) * Math.cos(tilt)];
        for (let axis = 0; axis < 3; axis++) expect(eye[axis]).toBeCloseTo(orbit.focus[axis] + orbit.distance * direction[axis], 1);
      }
    }
  });
});
