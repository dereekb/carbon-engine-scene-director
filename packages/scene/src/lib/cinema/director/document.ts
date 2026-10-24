/**
 * The document's `autoCamera`: the camera director's settings saved with the scene (its bias and shot rules), so they
 * survive a reload, a save and an export. The page layers them under the live auto_camera overrides: defaults ← the
 * scene's `autoCamera` ← the calls and cues since the tab loaded.
 *
 * The key sets are string literals and the readers run only inside functions: scene.ts → this → command.ts → scene.ts is
 * an import cycle, harmless while nothing imported is evaluated at module top level.
 */

import type { Maybe } from '@dereekb/util';
import type { FleetOperationContext } from '../../fleets/operations';
import { isPlainObject, type JsonObject } from '../../json';
import { readAutoCameraKeys, type AutoCameraBias, type AutoCameraBiasKey } from './command';

/**
 * The keys the scene block holds: auto_camera's bias less `follow` and `teams` (scene ids a removal would have to prune).
 */
export const SCENE_AUTO_CAMERA_KEYS = ['favour', 'sun', 'pace', 'hold', 'scales', 'framings', 'exclude', 'minShipSize', 'letterbox', 'hud', 'seed'] as const;

export type SceneAutoCameraKey = (typeof SCENE_AUTO_CAMERA_KEYS)[number] & AutoCameraBiasKey;

export type SceneAutoCamera = Pick<AutoCameraBias, SceneAutoCameraKey>;

/**
 * auto_camera keys the scene block does not hold (warned about and dropped).
 */
const LIVE_ONLY_KEYS = new Set<string>(['on', 'follow', 'teams']);

export interface NormalizedSceneAutoCamera {
  /**
   * Null when absent or empty (the document omits it).
   */
  readonly autoCamera: Maybe<SceneAutoCamera>;
  readonly problems: string[];
  readonly warnings: string[];
}

/**
 * Validates a document's `autoCamera` with auto_camera's readers: unknown keys and `on`, `follow`, `teams` warn and are
 * dropped, null means absent, bad values are problems, and an empty block is omitted.
 *
 * @param input - The candidate value.
 * @param where - Where it sits, for messages.
 * @returns The block (or null), problems and warnings.
 */
export function normalizeSceneAutoCamera(input: unknown, where = 'autoCamera'): NormalizedSceneAutoCamera {
  const problems: string[] = [];
  const warnings: string[] = [];
  const keys: readonly string[] = SCENE_AUTO_CAMERA_KEYS;
  let autoCamera: Maybe<SceneAutoCamera> = null;
  if (input != null) {
    if (!isPlainObject(input)) problems.push(`${where} must be an object { ${keys.join('?, ')}? }`);
    else {
      for (const key of Object.keys(input)) {
        if (LIVE_ONLY_KEYS.has(key)) warnings.push(`${where}.${key} is not kept in the scene (pass it to auto_camera) and was dropped`);
        else if (!keys.includes(key)) warnings.push(`${where}.${key} is not an autoCamera field and was dropped`);
      }
      const read = readAutoCameraKeys(input, keys, where, problems);
      const result: Record<string, unknown> = {};
      for (const key of keys) if ((read as Record<string, unknown>)[key] != null) result[key] = (read as Record<string, unknown>)[key];
      if (Object.keys(result).length) autoCamera = result as SceneAutoCamera;
    }
  }
  return { autoCamera, problems, warnings };
}

/**
 * The patch operations that edit the document's `autoCamera`.
 */
export const AUTO_CAMERA_OPERATIONS: ReadonlySet<string> = new Set(['set_auto_camera']);

/**
 * Applies `{ op: "set_auto_camera", favour?, sun?, pace?, hold?, scales?, framings?, exclude?, minShipSize?, letterbox?,
 * hud?, seed? }`: merges into the document's `autoCamera`; null removes a key. An emptied block is removed. The values
 * are checked when the document is normalized.
 *
 * @param operation - The operation.
 * @param context - The draft and where problems and warnings go.
 */
export function applyAutoCameraOperation(operation: JsonObject, context: FleetOperationContext): void {
  const { draft, where, problems, warnings } = context;
  const keys: readonly string[] = SCENE_AUTO_CAMERA_KEYS;
  for (const key of Object.keys(operation)) {
    if (key === 'op') continue;
    if (LIVE_ONLY_KEYS.has(key)) warnings.push(`${where}.${key} is not kept in the scene (pass it to auto_camera) and was ignored`);
    else if (!keys.includes(key)) warnings.push(`${where}.${key} is not a set_auto_camera field and was ignored`);
  }
  if (!keys.some((key) => key in operation)) {
    problems.push(`${where}: set_auto_camera needs one of ${keys.join(', ')} (null removes a key)`);
    return;
  }
  const block: Record<string, unknown> = isPlainObject(draft['autoCamera']) ? { ...draft['autoCamera'] } : {};
  for (const key of keys) {
    if (!(key in operation)) continue;
    if (operation[key] === null) delete block[key];
    else block[key] = operation[key];
  }
  if (Object.keys(block).length) draft['autoCamera'] = block as JsonObject;
  else delete draft['autoCamera'];
}
