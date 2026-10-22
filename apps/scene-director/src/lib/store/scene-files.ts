/**
 * Saved scenes on disk: one `cjs-scene/1` JSON file per scene in a single directory (see document-files.ts for the
 * file naming rules). Names that differ only in case are the same scene; a different name that collapses to a file
 * already holding another scene is refused rather than overwriting it.
 */

import os from 'node:os';
import { normalizeScene, type SceneDocument } from '@scene-director/scene';
import { defaultDataDirectory, type DocumentFile, type DocumentFileKind, type DocumentFileSummary, DocumentFileStore, documentFileStem, requireDocumentName, type UnreadableDocumentFile } from './document-files';

export type SceneFileSummary = DocumentFileSummary;

export type SceneFile = DocumentFile<SceneDocument>;

export type UnreadableSceneFile = UnreadableDocumentFile;

export interface SceneFileListing {
  readonly directory: string;
  /**
   * Newest first.
   */
  readonly scenes: SceneFileSummary[];
  readonly unreadable: UnreadableSceneFile[];
}

const SCENE_NOUN = 'scene';

const SCENE_FILE_KIND: DocumentFileKind<SceneDocument> = {
  noun: SCENE_NOUN,
  normalize: (input) => {
    const { scene, warnings } = normalizeScene(input);
    return { document: scene, warnings };
  },
  nameOf: (scene) => scene.name,
  named: (scene, name) => ({ ...scene, name }),
  ships: (scene) => scene.ships.length
};

/**
 * Where saved scenes live when no directory is configured: a `scene-director/scenes`
 * folder in the platform's per-user data directory.
 *
 * @param env - The environment (XDG_DATA_HOME, LOCALAPPDATA).
 * @param platform - The platform.
 * @param home - The user's home directory.
 * @returns The absolute directory path.
 */
export function DefaultScenesDirectory(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = os.homedir()): string {
  return defaultDataDirectory({ folder: 'scenes', env, platform, home });
}

/**
 * A trimmed scene name fit for saving.
 *
 * @param name - The candidate name.
 * @returns The trimmed name.
 * @throws {SceneError} When the name is missing, blank, too long or holds control characters.
 */
export function RequireSceneName(name: unknown): string {
  return requireDocumentName({ name, noun: SCENE_NOUN });
}

/**
 * The file stem a scene name saves under; see document-files.ts for the rules.
 *
 * @param name - A scene name.
 * @returns The stem, without the extension.
 * @throws {SceneError} When the name has no letter or digit to name a file with.
 */
export function SceneFileStem(name: string): string {
  return documentFileStem({ name, noun: SCENE_NOUN });
}

export class SceneFileStore extends DocumentFileStore<SceneDocument> {
  constructor(directory: string = DefaultScenesDirectory()) {
    super(directory, SCENE_FILE_KIND);
  }

  /**
   * Every scene file in the directory, newest first; files that do not read as scenes are listed apart.
   *
   * @returns The listing; empty when the directory does not exist yet.
   */
  async List(): Promise<SceneFileListing> {
    const { directory, documents, unreadable } = await this.listDocuments();
    return { directory, scenes: documents, unreadable };
  }
}
