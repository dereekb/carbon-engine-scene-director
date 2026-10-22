/**
 * Documents on disk: one JSON file per document in a single directory, so a document outlives the browser profile
 * and can be read, diffed or handed around as a plain file. Saved scenes and saved fleet compositions both use it.
 *
 * A document's file is named from its name: lowercased, with every run of characters other than letters, digits,
 * "_" and "-" collapsed to "-" ("Duel at Jita" -> duel-at-jita.json). Nothing that can leave the directory survives
 * that (no "/", "\", ".", ":"), and the result is the same on case-sensitive and case-insensitive filesystems. Names
 * that differ only in case are the same document; a different name that collapses to a file already holding another
 * document is refused rather than overwriting it.
 */

import type { Maybe } from '@dereekb/util';
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SceneError } from '@scene-director/scene';
import { ErrorMessage, ErrorProblems, ToolError } from '../hub/tool-call';

const FILE_EXTENSION = '.json';
const MAX_NAME_LENGTH = 128;
const MAX_STEM_LENGTH = 80;
/**
 * Device names Windows refuses as file names, whatever the extension.
 */
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com\d|lpt\d)$/u;

/**
 * What kind of document a store keeps, and how to read it.
 */
export interface DocumentFileKind<T> {
  /**
   * The document's name in messages: "scene", "fleet composition".
   */
  readonly noun: string;
  /**
   * Validates a candidate document.
   *
   * @throws {SceneError} When it cannot be used.
   */
  normalize(input: unknown): { readonly document: T; readonly warnings: string[] };
  /**
   * The name the document saves under when no name is given.
   */
  nameOf(document: T): string;
  /**
   * The document as saved under a name.
   */
  named(document: T, name: string): T;
  /**
   * How many ships it holds, for listings.
   */
  ships(document: T): number;
}

export interface DocumentFileSummary {
  /**
   * The name that opens it: the document's name, or the file's stem when the document's name would not map back to
   * this file (a file placed by hand).
   */
  readonly name: string;
  readonly file: string;
  readonly savedAt: string;
  readonly ships: number;
}

export interface DocumentFile<T> extends DocumentFileSummary {
  readonly document: T;
  readonly warnings: string[];
}

export interface UnreadableDocumentFile {
  readonly file: string;
  readonly error: string;
}

export interface DocumentFileListing {
  readonly directory: string;
  /**
   * Newest first.
   */
  readonly documents: DocumentFileSummary[];
  readonly unreadable: UnreadableDocumentFile[];
}

export interface DefaultDataDirectoryInput {
  /**
   * The folder inside `scene-director`, e.g. "scenes".
   */
  readonly folder: string;
  /**
   * The environment (XDG_DATA_HOME, LOCALAPPDATA).
   */
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  /**
   * The user's home directory.
   */
  readonly home?: string;
}

/**
 * A `scene-director/<folder>` directory in the platform's per-user data directory.
 *
 * @param input - The folder, and the environment, platform and home to read.
 * @returns The absolute directory path.
 */
export function defaultDataDirectory(input: DefaultDataDirectoryInput): string {
  const { folder, env = process.env, platform = process.platform, home = os.homedir() } = input;
  let base: string;
  if (platform === 'win32') base = env['LOCALAPPDATA'] || path.join(home, 'AppData', 'Local');
  else if (platform === 'darwin') base = path.join(home, 'Library', 'Application Support');
  else base = env['XDG_DATA_HOME'] || path.join(home, '.local', 'share');
  return path.join(base, 'scene-director', folder);
}

/**
 * A trimmed document name fit for saving.
 *
 * @param input - The candidate name and the document noun for messages.
 * @returns The trimmed name.
 * @throws {SceneError} When the name is missing, blank, too long or holds control characters.
 */
export function requireDocumentName(input: { readonly name: unknown; readonly noun: string }): string {
  const { name, noun } = input;
  if (typeof name !== 'string' || !name.trim()) throw new SceneError([`a ${noun} name is required`]);
  const trimmed = name.trim();
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/u.test(trimmed)) throw new SceneError([`a ${noun} name cannot hold control characters`]);
  if (trimmed.length > MAX_NAME_LENGTH) throw new SceneError([`a ${noun} name is at most ${MAX_NAME_LENGTH} characters`]);
  return trimmed;
}

/**
 * The file stem a document name saves under; see the module comment for the rules.
 *
 * @param input - A document name and the document noun (its last word suffixes a Windows device name).
 * @returns The stem, without the extension.
 * @throws {SceneError} When the name has no letter or digit to name a file with.
 */
export function documentFileStem(input: { readonly name: string; readonly noun: string }): string {
  const { name, noun } = input;
  const stem = name
    .normalize('NFKC')
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}_-]+/gu, '-')
    .slice(0, MAX_STEM_LENGTH)
    .replaceAll(/^-+|-+$/gu, '');
  if (!/[\p{L}\p{N}]/u.test(stem)) throw new SceneError([`the ${noun} name "${name}" has no letters or digits to name its file with`]);
  return WINDOWS_DEVICE_NAME.test(stem) ? `${stem}-${noun.split(' ').at(-1)}` : stem;
}

/**
 * Two names that are the same document: equal ignoring case and Unicode form.
 *
 * @param a - A name.
 * @param b - Another name.
 * @returns True when they match.
 */
function sameName(a: string, b: string): boolean {
  return a.normalize('NFKC').toLowerCase() === b.normalize('NFKC').toLowerCase();
}

export class DocumentFileStore<T> {
  readonly directory: string;
  readonly kind: DocumentFileKind<T>;

  constructor(directory: string, kind: DocumentFileKind<T>) {
    this.directory = path.resolve(directory);
    this.kind = kind;
  }

  /**
   * Validates a document and writes it under a name, replacing that document's file.
   *
   * @param name - The name to save under; the document's own name when null.
   * @param input - A document.
   * @returns The saved file and the document's warnings.
   * @throws {SceneError} When the document or the name is invalid.
   * @throws {ToolError} When the name's file holds another document, or a file that is not one.
   */
  async Put(name: Maybe<unknown>, input: unknown): Promise<DocumentFile<T>> {
    const { noun } = this.kind;
    const { document: normalized, warnings } = this.kind.normalize(input);
    const key = requireDocumentName({ name: name ?? this.kind.nameOf(normalized), noun });
    const stem = documentFileStem({ name: key, noun });
    const existing = await this.Read(stem).catch((error: unknown) => {
      throw new ToolError(`${this.FilePath(stem)} is not a readable ${noun}, so "${key}" will not replace it; move or delete it first`, { message: ErrorMessage(error), problems: ErrorProblems(error) ?? [] });
    });
    if (existing && !sameName(existing.name, key)) {
      throw new ToolError(`the name "${key}" saves to ${existing.file}, which holds the ${noun} "${existing.name}"; pick another name or delete "${existing.name}" first`);
    }

    const document = this.kind.named(normalized, key);
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
    return { name: key, file, savedAt: info.mtime.toISOString(), ships: this.kind.ships(document), document, warnings };
  }

  /**
   * The saved document a name maps to.
   *
   * @param name - A document name; case does not matter.
   * @returns The document, or null when nothing is saved under the name.
   * @throws {ToolError} When the file exists but is not a valid document.
   */
  async Get(name: unknown): Promise<Maybe<DocumentFile<T>>> {
    return this.Read(this.StemOf(name));
  }

  /**
   * Deletes a saved document.
   *
   * @param name - A document name; case does not matter.
   * @returns True when a file was deleted.
   */
  async Delete(name: unknown): Promise<boolean> {
    const file = this.FilePath(this.StemOf(name));
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
   * Every document file in the directory, newest first; files that do not read as documents are listed apart.
   *
   * @returns The listing; empty when the directory does not exist yet.
   */
  async listDocuments(): Promise<DocumentFileListing> {
    let entries: string[] = [];
    try {
      entries = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const documents: DocumentFileSummary[] = [];
    const unreadable: UnreadableDocumentFile[] = [];
    for (const entry of entries.filter((name) => name.endsWith(FILE_EXTENSION) && !name.startsWith('.')).sort()) {
      try {
        const read = await this.Read(entry.slice(0, -FILE_EXTENSION.length));
        if (read) documents.push({ name: read.name, file: read.file, savedAt: read.savedAt, ships: read.ships });
      } catch (error) {
        unreadable.push({ file: this.FilePath(entry.slice(0, -FILE_EXTENSION.length)), error: ErrorMessage(error) });
      }
    }
    documents.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    return { directory: this.directory, documents, unreadable };
  }

  private StemOf(name: unknown): string {
    const { noun } = this.kind;
    return documentFileStem({ name: requireDocumentName({ name, noun }), noun });
  }

  private FilePath(stem: string): string {
    return path.join(this.directory, `${stem}${FILE_EXTENSION}`);
  }

  /**
   * Reads and validates one file by stem.
   *
   * @param stem - The file's stem.
   * @returns The document, or null when the file does not exist.
   * @throws {ToolError} When the file is not JSON or not a valid document.
   */
  private async Read(stem: string): Promise<Maybe<DocumentFile<T>>> {
    const { noun } = this.kind;
    const file = this.FilePath(stem);
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    let document: T;
    let warnings: string[];
    try {
      ({ document, warnings } = this.kind.normalize(JSON.parse(text)));
    } catch (error) {
      const problems = ErrorProblems(error);
      throw new ToolError(`${file} is not a valid ${noun}: ${problems ? problems.join('; ') : ErrorMessage(error)}`, { message: ErrorMessage(error), ...(problems ? { problems } : {}) });
    }
    const info = await stat(file);
    const own = this.kind.nameOf(document);
    const name = this.MapsTo(own, stem) ? own : stem;
    return { name, file, savedAt: info.mtime.toISOString(), ships: this.kind.ships(document), document, warnings };
  }

  /**
   * Whether a document's name saves to the file it was read from.
   *
   * @param name - The document's name.
   * @param stem - The file's stem.
   * @returns True when the name maps to the stem.
   */
  private MapsTo(name: string, stem: string): boolean {
    let maps = false;
    try {
      maps = this.StemOf(name) === stem;
    } catch {
      maps = false;
    }
    return maps;
  }
}
