/**
 * The timeline's projection: the scene as it will be when each cue fires. Starting from the document without its
 * timeline, the patch cues are applied in time order with the pure applySceneOperations (passed in by scene.ts, which
 * avoids a module cycle and lets specs inject it), so a cue is checked against what earlier cues add or remove, and
 * each patch cue's added ids are derived (`adds`).
 */

import type { Maybe } from '@dereekb/util';
import { type NormalizedScene, type SceneDocument, SceneError } from '../scene';
import { cueDueSecond, SCENE_CUE_ADDS_KEYS, type SceneCueAdds, type SceneCueAddsKey, type SceneTimeline } from './timeline';

/**
 * applySceneOperations' signature.
 */
export type ApplySceneOperations = (scene: SceneDocument, operations: unknown) => NormalizedScene;

/**
 * The ids a scene holds, by kind; wings and squads as `<fleet>/<id>` keys.
 *
 * @param scene - A normalized document.
 * @returns Each kind's ids.
 */
export function sceneIdsOf(scene: SceneDocument): Record<SceneCueAddsKey, Set<string>> {
  const fleets = scene.fleets ?? [];
  return {
    ships: new Set(scene.ships.map((ship) => ship.id)),
    objects: new Set((scene.objects ?? []).map((object) => object.id)),
    fleets: new Set(fleets.map((fleet) => fleet.id)),
    wings: new Set(fleets.flatMap((fleet) => fleet.wings.map((wing) => `${fleet.id}/${wing.id}`))),
    squads: new Set(fleets.flatMap((fleet) => fleet.wings.flatMap((wing) => wing.squads.map((squad) => `${fleet.id}/${squad.id}`))))
  };
}

/**
 * The ids `after` holds that `before` does not.
 *
 * @param before - The scene before a patch.
 * @param after - The scene after it.
 * @returns The added ids, empty lists omitted.
 */
export function sceneAddsBetween(before: SceneDocument, after: SceneDocument): SceneCueAdds {
  const old = sceneIdsOf(before);
  const now = sceneIdsOf(after);
  const adds: { -readonly [K in SceneCueAddsKey]?: string[] } = {};
  for (const key of SCENE_CUE_ADDS_KEYS) {
    const added = [...now[key]].filter((id) => !old[key].has(id));
    if (added.length) adds[key] = added;
  }
  return adds;
}

/**
 * Every id a cue's adds names, by kind, flattened: `ship "a"`, `fleet "red"`.
 *
 * @param adds - A cue's adds.
 * @returns Labelled ids.
 */
export function describeCueAdds(adds: Maybe<SceneCueAdds>): string[] {
  const nouns: Record<SceneCueAddsKey, string> = { ships: 'ship', objects: 'object', fleets: 'fleet', wings: 'wing', squads: 'squad' };
  return SCENE_CUE_ADDS_KEYS.flatMap((key) => (adds?.[key] ?? []).map((id) => `${nouns[key]} "${id}"`));
}

/**
 * The scene as the timeline will have it at a time: the document without its timeline, with every patch cue due by then
 * (cueDueSecond(at) ≤ seconds) applied in order. A patch that no longer applies is skipped (normalize reports it).
 *
 * @param scene - A normalized document.
 * @param seconds - Timeline time, seconds from play start.
 * @param apply - applySceneOperations.
 * @returns The projected document, without a timeline.
 */
export function sceneAtTimelineTime(scene: SceneDocument, seconds: number, apply: ApplySceneOperations): SceneDocument {
  const { timeline, ...rest } = scene;
  let current: SceneDocument = rest;
  for (const cue of (timeline as Maybe<SceneTimeline>)?.cues ?? []) {
    if (cueDueSecond(cue.at) > seconds) break;
    if (!('patch_scene' in cue)) continue;
    try {
      current = apply(current, cue.patch_scene.operations).scene;
    } catch (error) {
      if (!(error instanceof SceneError)) throw error;
    }
  }
  return current;
}
