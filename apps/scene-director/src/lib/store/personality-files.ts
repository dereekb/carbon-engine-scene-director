/**
 * Saved fleet personalities on disk: one `cjs-fleet-personality/1` JSON file per template in a single directory (see
 * document-files.ts for the file naming rules). A template saves under its id; saving under a name sets its id, so the
 * name is the key a scene embeds it under and a fleet picks it by.
 */

import { type FleetPersonality, normalizeFleetPersonality, SceneError } from '@scene-director/scene';
import { defaultDataDirectory, type DocumentFile, type DocumentFileKind, DocumentFileStore, type DocumentFileSummary, type UnreadableDocumentFile } from './document-files';

export const FLEET_PERSONALITY_NOUN = 'fleet personality';

export type FleetPersonalityFile = DocumentFile<FleetPersonality>;

export interface FleetPersonalityFileListing {
  readonly directory: string;
  /**
   * Newest first.
   */
  readonly personalities: DocumentFileSummary[];
  readonly unreadable: UnreadableDocumentFile[];
}

/**
 * A personality that cannot be used, with every problem found. A SceneError, so tool errors keep the problem list.
 */
export class FleetPersonalityError extends SceneError {
  constructor(problems: string[]) {
    super(problems);
    this.name = 'FleetPersonalityError';
    this.message = `Invalid fleet personality:\n- ${problems.join('\n- ')}`;
  }
}

const PERSONALITY_FILE_KIND: DocumentFileKind<FleetPersonality> = {
  noun: FLEET_PERSONALITY_NOUN,
  normalize: (input) => {
    const { personality, problems, warnings } = normalizeFleetPersonality({ input, where: 'personality' });
    if (!personality) throw new FleetPersonalityError(problems);
    return { document: personality, warnings };
  },
  nameOf: (personality) => personality.id,
  named: (personality, name) => ({ ...personality, id: name })
};

/**
 * Where saved fleet personalities live when no directory is configured: a `scene-director/personalities` folder in
 * the platform's per-user data directory.
 *
 * @param env - The environment (XDG_DATA_HOME, LOCALAPPDATA).
 * @returns The absolute directory path.
 */
export function defaultFleetPersonalitiesDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return defaultDataDirectory({ folder: 'personalities', env });
}

export class FleetPersonalityFileStore extends DocumentFileStore<FleetPersonality> {
  constructor(directory: string = defaultFleetPersonalitiesDirectory()) {
    super(directory, PERSONALITY_FILE_KIND);
  }

  /**
   * Every personality file in the directory, newest first; files that do not read as personalities are listed apart.
   *
   * @returns The listing; empty when the directory does not exist yet.
   */
  async List(): Promise<FleetPersonalityFileListing> {
    const { directory, documents, unreadable } = await this.listDocuments();
    return { directory, personalities: documents, unreadable };
  }
}
