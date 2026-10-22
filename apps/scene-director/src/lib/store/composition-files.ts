/**
 * Saved fleet compositions on disk: one `cjs-fleet/1` JSON file per composition in a single directory (see
 * document-files.ts for the file naming rules). A composition saves under its name, else its id; saving under a name
 * sets its name.
 */

import { countFleetCompositionShips, type FleetComposition, normalizeFleetComposition, SceneError } from '@scene-director/scene';
import { defaultDataDirectory, type DocumentFile, type DocumentFileKind, DocumentFileStore, type DocumentFileSummary, type UnreadableDocumentFile } from './document-files';

export const FLEET_COMPOSITION_NOUN = 'fleet composition';

export type FleetCompositionFile = DocumentFile<FleetComposition>;

export interface FleetCompositionFileListing {
  readonly directory: string;
  /**
   * Newest first.
   */
  readonly compositions: DocumentFileSummary[];
  readonly unreadable: UnreadableDocumentFile[];
}

/**
 * A composition that cannot be used, with every problem found. A SceneError, so tool errors keep the problem list.
 */
export class FleetCompositionError extends SceneError {
  constructor(problems: string[]) {
    super(problems);
    this.name = 'FleetCompositionError';
    this.message = `Invalid fleet composition:\n- ${problems.join('\n- ')}`;
  }
}

const COMPOSITION_FILE_KIND: DocumentFileKind<FleetComposition> = {
  noun: FLEET_COMPOSITION_NOUN,
  normalize: (input) => {
    const { composition, problems, warnings } = normalizeFleetComposition({ input });
    if (!composition) throw new FleetCompositionError(problems);
    return { document: composition, warnings };
  },
  nameOf: (composition) => composition.name ?? composition.id,
  named: (composition, name) => ({ ...composition, name }),
  ships: (composition) => countFleetCompositionShips(composition)
};

/**
 * Where saved fleet compositions live when no directory is configured: a `scene-director/fleets` folder in the
 * platform's per-user data directory.
 *
 * @param env - The environment (XDG_DATA_HOME, LOCALAPPDATA).
 * @returns The absolute directory path.
 */
export function defaultFleetCompositionsDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return defaultDataDirectory({ folder: 'fleets', env });
}

export class FleetCompositionFileStore extends DocumentFileStore<FleetComposition> {
  constructor(directory: string = defaultFleetCompositionsDirectory()) {
    super(directory, COMPOSITION_FILE_KIND);
  }

  /**
   * Every composition file in the directory, newest first; files that do not read as compositions are listed apart.
   *
   * @returns The listing; empty when the directory does not exist yet.
   */
  async List(): Promise<FleetCompositionFileListing> {
    const { directory, documents, unreadable } = await this.listDocuments();
    return { directory, compositions: documents, unreadable };
  }
}
