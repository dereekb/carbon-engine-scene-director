/**
 * Saved scenes on disk: one `cjs-scene/1` JSON file per scene in a single
 * directory, so a scene outlives the browser profile and can be read, diffed
 * or handed around as a plain file.
 *
 * A scene's file is named from its name: lowercased, with every run of
 * characters other than letters, digits, "_" and "-" collapsed to "-"
 * ("Duel at Jita" -> duel-at-jita.json). Nothing that can leave the
 * directory survives that (no "/", "\", ".", ":"), and the result is the same
 * on case-sensitive and case-insensitive filesystems. Names that differ only
 * in case are the same scene; a different name that collapses to a file
 * already holding another scene is refused rather than overwriting it.
 */

import type { Maybe } from '@dereekb/util';
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeScene, SceneError, type SceneDocument } from '@scene-director/scene';
import { ErrorMessage, ErrorProblems, ToolError } from '../hub/tool-call';

const FILE_EXTENSION = '.json';
const MAX_NAME_LENGTH = 128;
const MAX_STEM_LENGTH = 80;
/**
 * Device names Windows refuses as file names, whatever the extension.
 */
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com\d|lpt\d)$/u;

export interface SceneFileSummary {
  /**
   * The name that opens it: the document's name, or the file's stem when the
   * document's name would not map back to this file (a file placed by hand).
   */
  readonly name: string;
  readonly file: string;
  readonly savedAt: string;
  readonly ships: number;
}

export interface SceneFile extends SceneFileSummary {
  readonly scene: SceneDocument;
  readonly warnings: string[];
}

export interface UnreadableSceneFile {
  readonly file: string;
  readonly error: string;
}

export interface SceneFileListing {
  readonly directory: string;
  /**
   * Newest first.
   */
  readonly scenes: SceneFileSummary[];
  readonly unreadable: UnreadableSceneFile[];
}

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
  let base: string;
  if (platform === 'win32') base = env['LOCALAPPDATA'] || path.join(home, 'AppData', 'Local');
  else if (platform === 'darwin') base = path.join(home, 'Library', 'Application Support');
  else base = env['XDG_DATA_HOME'] || path.join(home, '.local', 'share');
  return path.join(base, 'scene-director', 'scenes');
}

/**
 * A trimmed scene name fit for saving.
 *
 * @param name - The candidate name.
 * @returns The trimmed name.
 * @throws {SceneError} When the name is missing, blank, too long or holds control characters.
 */
export function RequireSceneName(name: unknown): string {
  if (typeof name !== 'string' || !name.trim()) throw new SceneError(['a scene name is required']);
  const trimmed = name.trim();
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/u.test(trimmed)) throw new SceneError(['a scene name cannot hold control characters']);
  if (trimmed.length > MAX_NAME_LENGTH) throw new SceneError([`a scene name is at most ${MAX_NAME_LENGTH} characters`]);
  return trimmed;
}

/**
 * The file stem a scene name saves under; see the module comment for the rules.
 *
 * @param name - A scene name.
 * @returns The stem, without the extension.
 * @throws {SceneError} When the name has no letter or digit to name a file with.
 */
export function SceneFileStem(name: string): string {
  const stem = name
    .normalize('NFKC')
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}_-]+/gu, '-')
    .slice(0, MAX_STEM_LENGTH)
    .replaceAll(/^-+|-+$/gu, '');
  if (!/[\p{L}\p{N}]/u.test(stem)) throw new SceneError([`the scene name "${name}" has no letters or digits to name its file with`]);
  return WINDOWS_DEVICE_NAME.test(stem) ? `${stem}-scene` : stem;
}

/**
 * Two names that are the same scene: equal ignoring case and Unicode form.
 *
 * @param a - A name.
 * @param b - Another name.
 * @returns True when they match.
 */
function SameName(a: string, b: string): boolean {
  return a.normalize('NFKC').toLowerCase() === b.normalize('NFKC').toLowerCase();
}

export class SceneFileStore {
  readonly directory: string;

  constructor(directory: string = DefaultScenesDirectory()) {
    this.directory = path.resolve(directory);
  }

  /**
   * Validates a document and writes it under a name, replacing that scene's file.
   *
   * @param name - The name to save under; the document's own name when null.
   * @param input - A scene document.
   * @returns The saved file and the document's warnings.
   * @throws {SceneError} When the document or the name is invalid.
   * @throws {ToolError} When the name's file holds another scene, or a file that is not a scene.
   */
  async Put(name: Maybe<unknown>, input: unknown): Promise<SceneFile> {
    const { scene, warnings } = normalizeScene(input);
    const key = RequireSceneName(name ?? scene.name);
    const stem = SceneFileStem(key);
    const existing = await this.Read(stem).catch((error: unknown) => {
      throw new ToolError(`${this.FilePath(stem)} is not a readable scene, so "${key}" will not replace it; move or delete it first`, { message: ErrorMessage(error), problems: ErrorProblems(error) ?? [] });
    });
    if (existing && !SameName(existing.name, key)) {
      throw new ToolError(`the name "${key}" saves to ${existing.file}, which holds the scene "${existing.name}"; pick another name or delete "${existing.name}" first`);
    }

    const document: SceneDocument = { ...scene, name: key };
    const file = this.FilePath(stem);
    const temporary = path.join(this.directory, `.${stem}.${process.pid}.${Date.now()}.tmp`);
    await mkdir(this.directory, { recursive: true });
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    try {
      await rename(temporary, file);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    const info = await stat(file);
    return { name: key, file, savedAt: info.mtime.toISOString(), ships: document.ships.length, scene: document, warnings };
  }

  /**
   * The saved scene a name maps to.
   *
   * @param name - A scene name; case does not matter.
   * @returns The scene, or null when nothing is saved under the name.
   * @throws {ToolError} When the file exists but is not a valid scene.
   */
  async Get(name: unknown): Promise<Maybe<SceneFile>> {
    return this.Read(SceneFileStem(RequireSceneName(name)));
  }

  /**
   * Deletes a saved scene.
   *
   * @param name - A scene name; case does not matter.
   * @returns True when a file was deleted.
   */
  async Delete(name: unknown): Promise<boolean> {
    const file = this.FilePath(SceneFileStem(RequireSceneName(name)));
    let deleted = true;
    try {
      await unlink(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      deleted = false;
    }
    return deleted;
  }

  /**
   * Every scene file in the directory, newest first; files that do not read as scenes are listed apart.
   *
   * @returns The listing; empty when the directory does not exist yet.
   */
  async List(): Promise<SceneFileListing> {
    let entries: string[] = [];
    try {
      entries = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const scenes: SceneFileSummary[] = [];
    const unreadable: UnreadableSceneFile[] = [];
    for (const entry of entries.filter((name) => name.endsWith(FILE_EXTENSION) && !name.startsWith('.')).sort()) {
      try {
        const scene = await this.Read(entry.slice(0, -FILE_EXTENSION.length));
        if (scene) scenes.push({ name: scene.name, file: scene.file, savedAt: scene.savedAt, ships: scene.ships });
      } catch (error) {
        unreadable.push({ file: this.FilePath(entry.slice(0, -FILE_EXTENSION.length)), error: ErrorMessage(error) });
      }
    }
    scenes.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    return { directory: this.directory, scenes, unreadable };
  }

  private FilePath(stem: string): string {
    return path.join(this.directory, `${stem}${FILE_EXTENSION}`);
  }

  /**
   * Reads and validates one file by stem.
   *
   * @param stem - The file's stem.
   * @returns The scene, or null when the file does not exist.
   * @throws {ToolError} When the file is not JSON or not a valid scene.
   */
  private async Read(stem: string): Promise<Maybe<SceneFile>> {
    const file = this.FilePath(stem);
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    let scene: SceneDocument;
    let warnings: string[];
    try {
      ({ scene, warnings } = normalizeScene(JSON.parse(text)));
    } catch (error) {
      const problems = ErrorProblems(error);
      throw new ToolError(`${file} is not a valid scene: ${problems ? problems.join('; ') : ErrorMessage(error)}`, { message: ErrorMessage(error), ...(problems ? { problems } : {}) });
    }
    const info = await stat(file);
    const name = MapsTo(scene.name, stem) ? scene.name : stem;
    return { name, file, savedAt: info.mtime.toISOString(), ships: scene.ships.length, scene, warnings };
  }
}

/**
 * Whether a document's name saves to the file it was read from.
 *
 * @param name - The document's name.
 * @param stem - The file's stem.
 * @returns True when the name maps to the stem.
 */
function MapsTo(name: string, stem: string): boolean {
  let maps = false;
  try {
    maps = SceneFileStem(RequireSceneName(name)) === stem;
  } catch {
    maps = false;
  }
  return maps;
}
