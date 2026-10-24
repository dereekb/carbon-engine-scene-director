/**
 * Exported movies on disk (sd-export): one MP4 per export in a single directory, written as a hidden `.<file>.part`
 * and renamed when the hub finishes it. File names follow document-files.ts's stem rules (lowercased, every run of
 * other characters collapsed to "-", at most 80 characters), unique with -2, -3, ...; the `/movies/<file>` route
 * resolves only such names inside the directory.
 */

import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { defaultDataDirectory, documentFileStem } from './document-files';

export const MOVIE_FILE_EXTENSION = '.mp4';
const MOVIE_NOUN = 'movie';
const MOVIE_FILE_NAME = /^[a-z0-9][a-z0-9_-]*\.mp4$/u;
const MAX_UNIQUE_SUFFIX = 1000;

/**
 * A reserved export file.
 */
export interface MovieFileReservation {
  /**
   * The finished file's name, such as `duel-20261024-101500.mp4`.
   */
  readonly fileName: string;
  readonly path: string;
  /**
   * Where the hub writes until it finishes: `.<fileName>.part`.
   */
  readonly partPath: string;
}

/**
 * Where exported movies live when no directory is configured: a `scene-director/movies` folder in the platform's
 * per-user data directory.
 *
 * @param env - The environment (XDG_DATA_HOME, LOCALAPPDATA).
 * @param platform - The platform.
 * @param home - The user's home directory.
 * @returns The absolute directory path.
 */
export function DefaultMoviesDirectory(env: NodeJS.ProcessEnv = process.env, platform?: NodeJS.Platform, home?: string): string {
  return defaultDataDirectory({ folder: 'movies', env, ...(platform ? { platform } : {}), ...(home ? { home } : {}) });
}

/**
 * The default export name: the scene's name and the UTC time.
 *
 * @param scene - The scene's name, if it has one.
 * @param at - The time.
 * @returns Such as `duel-at-jita-20261024-101500`.
 */
export function DefaultMovieName(scene: string | null | undefined, at: Date = new Date()): string {
  const stamp = at.toISOString().replaceAll(/[-:]/gu, '').replace('T', '-').slice(0, 15);
  return `${scene?.trim() || 'movie'}-${stamp}`;
}

export class MovieFileStore {
  readonly directory: string;

  constructor(directory: string = DefaultMoviesDirectory()) {
    this.directory = path.resolve(directory);
  }

  /**
   * Picks a free file name for an export (neither the file nor its part exists), creating the directory.
   *
   * @param name - The export's name; sanitized by the stem rules.
   * @returns The file name and its paths.
   */
  async Reserve(name: string): Promise<MovieFileReservation> {
    await mkdir(this.directory, { recursive: true });
    const stem = MovieFileStem(name);
    for (let index = 1; index <= MAX_UNIQUE_SUFFIX; index++) {
      const unique = index === 1 ? stem : `${stem}-${index}`;
      const fileName = `${unique}${MOVIE_FILE_EXTENSION}`;
      const reservation = { fileName, path: path.join(this.directory, fileName), partPath: path.join(this.directory, `.${fileName}.part`) };
      if (!(await Exists(reservation.path)) && !(await Exists(reservation.partPath))) return reservation;
    }
    throw new Error(`no free file name for "${stem}" in ${this.directory}`);
  }

  /**
   * The path the route serves for a file name.
   *
   * @param fileName - The requested name.
   * @returns The path inside the directory, or null for any other name (traversal, a part file, another extension).
   */
  Resolve(fileName: string): string | null {
    let file: string | null = null;
    if (MOVIE_FILE_NAME.test(fileName)) {
      const resolved = path.resolve(this.directory, fileName);
      if (path.dirname(resolved) === this.directory) file = resolved;
    }
    return file;
  }
}

/**
 * An export name's file stem.
 *
 * @param name - The name.
 * @returns The stem; "movie" when the name has no letter or digit.
 */
export function MovieFileStem(name: string): string {
  let stem: string;
  try {
    stem = documentFileStem({ name: name.replace(/\.mp4$/iu, ''), noun: MOVIE_NOUN });
  } catch {
    stem = MOVIE_NOUN;
  }
  // The route serves ASCII names only.
  const ascii = stem
    .normalize('NFKD')
    .replaceAll(/\p{M}+/gu, '')
    .replaceAll(/[^a-z0-9_-]+/gu, '-')
    .replaceAll(/^-+|-+$/gu, '');
  return /^[a-z0-9]/u.test(ascii) ? ascii : `movie-${ascii}`.replace(/-+$/u, '');
}

async function Exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false
  );
}
