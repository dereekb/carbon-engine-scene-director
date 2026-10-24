import { describe, expect, it } from 'vitest';
import { catchSceneError } from '../../fleets/fleets.spec-helper';
import { applySceneOperations, diffScenes, normalizeScene } from '../../scene';
import { normalizeSceneAutoCamera } from './document';

describe('normalizeSceneAutoCamera', () => {
  it('reads the bias and shot rules; null and empty are absent', () => {
    expect(normalizeSceneAutoCamera({ scales: ['close', 'medium'], exclude: ['flyby'], minShipSize: 0.01, favour: 'medium', pace: 'fast' })).toEqual({ autoCamera: { scales: ['medium', 'close'], exclude: ['flyby'], minShipSize: 0.01, favour: 'medium', pace: 'fast' }, problems: [], warnings: [] });
    expect(normalizeSceneAutoCamera(undefined).autoCamera).toBeNull();
    expect(normalizeSceneAutoCamera({}).autoCamera).toBeNull();
    expect(normalizeSceneAutoCamera({ favour: null, scales: null }).autoCamera).toBeNull();
    expect(normalizeSceneAutoCamera({ exclude: [], minShipSize: 0 }).autoCamera).toEqual({ exclude: [], minShipSize: 0 });
  });

  it('warns about and drops unknown keys and on, follow and teams; bad values are problems', () => {
    const read = normalizeSceneAutoCamera({ on: true, follow: { fleet: 'blue' }, teams: ['a', 'b'], zoom: 2, sun: true });
    expect(read.autoCamera).toEqual({ sun: true });
    expect(read.warnings).toEqual([
      'autoCamera.on is not kept in the scene (pass it to auto_camera) and was dropped',
      'autoCamera.follow is not kept in the scene (pass it to auto_camera) and was dropped',
      'autoCamera.teams is not kept in the scene (pass it to auto_camera) and was dropped',
      'autoCamera.zoom is not an autoCamera field and was dropped'
    ]);
    expect(normalizeSceneAutoCamera({ scales: [] }).problems).toEqual(['autoCamera.scales must be a non-empty list of wide, medium, close (no repeats), or null']);
    expect(normalizeSceneAutoCamera({ exclude: ['nope'] }).problems[0]).toMatch(/^autoCamera\.exclude\.0 "nope" is not a director framing \(hero, /);
    expect(normalizeSceneAutoCamera(3).problems).toHaveLength(1);
  });
});

describe('the document autoCamera field', () => {
  const base = normalizeScene({ ships: [] }).scene;

  it('round-trips through normalizeScene, is omitted when empty, and refuses bad values', () => {
    const { scene, warnings } = normalizeScene({ ships: [], autoCamera: { scales: ['close'], exclude: ['flyby'] } });
    expect(scene.autoCamera).toEqual({ scales: ['close'], exclude: ['flyby'] });
    expect(warnings).toEqual([]);
    expect(normalizeScene(JSON.parse(JSON.stringify(scene))).scene).toEqual(scene);
    expect('autoCamera' in normalizeScene({ ships: [], autoCamera: {} }).scene).toBe(false);
    expect(catchSceneError(() => normalizeScene({ ships: [], autoCamera: { minShipSize: 1 } })).problems).toEqual(['autoCamera.minShipSize must be a share of the frame height in [0, 0.25] (0 turns it off), or null']);
  });

  it('set_auto_camera merges, null removes a key, and an emptied block goes; the diff flags it', () => {
    const ruled = applySceneOperations(base, [{ op: 'set_auto_camera', scales: ['medium', 'close'], exclude: ['overlook-pull-out'] }]).scene;
    expect(ruled.autoCamera).toEqual({ scales: ['medium', 'close'], exclude: ['overlook-pull-out'] });
    expect(diffScenes(base, ruled).autoCamera).toBe(true);
    expect(diffScenes(ruled, ruled).autoCamera).toBe(false);
    const merged = applySceneOperations(ruled, [{ op: 'set_auto_camera', scales: null, minShipSize: 0.01 }]).scene;
    expect(merged.autoCamera).toEqual({ exclude: ['overlook-pull-out'], minShipSize: 0.01 });
    expect('autoCamera' in applySceneOperations(merged, [{ op: 'set_auto_camera', exclude: null, minShipSize: null }]).scene).toBe(false);
    const warned = applySceneOperations(base, [{ op: 'set_auto_camera', follow: { fleet: 'x' }, favour: 'close' }]);
    expect(warned.scene.autoCamera).toEqual({ favour: 'close' });
    expect(warned.warnings[0]).toMatch(/follow is not kept in the scene/);
    expect(catchSceneError(() => applySceneOperations(base, [{ op: 'set_auto_camera' }])).problems[0]).toMatch(/set_auto_camera needs one of favour, sun, /);
    expect(catchSceneError(() => applySceneOperations(base, [{ op: 'set_auto_camera', scales: ['huge'] }])).problems[0]).toMatch(/autoCamera\.scales must be/);
  });

  it('a timeline auto_camera cue takes the new keys', () => {
    const { scene } = normalizeScene({ ships: [], timeline: { cues: [{ id: 'director', at: 1, auto_camera: { scales: ['medium', 'close'], exclude: ['over-the-shoulder'], minShipSize: 0.01 } }] } });
    expect(scene.timeline?.cues[0]).toMatchObject({ auto_camera: { scales: ['medium', 'close'], exclude: ['over-the-shoulder'], minShipSize: 0.01 } });
  });
});
