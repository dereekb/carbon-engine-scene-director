import { createEmptyScene, DEFAULT_CAMERA_FOV, type SceneDocument } from '@scene-director/scene';
import { describe, expect, it } from 'vitest';
import { FromSceneRecord, SCENE_RECORD_VERSION } from './store';

function Scene(fov: number): SceneDocument {
  const scene = createEmptyScene('stored');
  return { ...scene, camera: { ...scene.camera, fov } };
}

describe('FromSceneRecord', () => {
  it('reads a record from before the honoured fov at its old default 45 as the 90 degrees it was drawn at', () => {
    const scene = Scene(45);
    const read = FromSceneRecord({ scene });
    expect(read.camera.fov).toBe(DEFAULT_CAMERA_FOV);
    expect(read.camera.yaw).toBe(scene.camera.yaw);
    expect(scene.camera.fov).toBe(45);
  });

  it('keeps a fov set on purpose, and every fov of a current record', () => {
    expect(FromSceneRecord({ scene: Scene(30) }).camera.fov).toBe(30);
    expect(FromSceneRecord({ scene: Scene(45), version: SCENE_RECORD_VERSION }).camera.fov).toBe(45);
    const scene = Scene(60);
    expect(FromSceneRecord({ scene, version: SCENE_RECORD_VERSION })).toBe(scene);
  });
});
