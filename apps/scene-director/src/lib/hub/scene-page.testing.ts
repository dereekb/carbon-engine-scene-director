/**
 * What the page answers for a hub tool given `at`, on a fake tab's authored document: `get_scene { at }` projects it to
 * that timeline time, and `patch_scene { at, cue?, name? }` adds the operations as one cue (the page's AddCue) without
 * applying them.
 */

import { applySceneOperations, type SceneDocument, sceneAtTimelineTime } from '@scene-director/scene';
import type { ToolArgs } from './tool-call';

/**
 * get_scene: the document, or with `at` the document as it will be then.
 *
 * @param scene - The tab's authored document.
 * @param args - get_scene's arguments.
 * @returns The answer.
 */
export function FakeGetScene(scene: SceneDocument, args: ToolArgs): SceneDocument {
  return typeof args['at'] === 'number' ? sceneAtTimelineTime(scene, args['at'], applySceneOperations) : scene;
}

/**
 * patch_scene with `at`: the operations become one patch_scene cue in the document's timeline.
 *
 * @param scene - The tab's authored document.
 * @param args - patch_scene's arguments.
 * @returns The document with the cue, and the page's answer.
 */
export function FakeAddCue(scene: SceneDocument, args: ToolArgs): { readonly scene: SceneDocument; readonly result: object } {
  const id = typeof args['cue'] === 'string' ? args['cue'] : null;
  const known = new Set((scene.timeline?.cues ?? []).map((cue) => cue.id));
  const cue = { ...(id ? { id } : {}), at: args['at'], ...(typeof args['name'] === 'string' ? { name: args['name'] } : {}), patch_scene: { operations: args['operations'] } };
  const applied = applySceneOperations(scene, [{ op: 'add_cue', cue }]);
  const stored = applied.scene.timeline?.cues.find((candidate) => (id ? candidate.id === id : !known.has(candidate.id))) ?? null;
  return { scene: applied.scene, result: { cue: stored, state: 'pending', timeline: null, warnings: [] } };
}
