import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DefaultMovieName, DefaultMoviesDirectory, MovieFileStem, MovieFileStore } from './movie-files';

describe('MovieFileStore', () => {
  it('defaults to a scene-director/movies folder in the per-user data directory', () => {
    expect(DefaultMoviesDirectory({ XDG_DATA_HOME: '/data' }, 'linux', '/home/a')).toBe(path.join('/data', 'scene-director', 'movies'));
    expect(DefaultMoviesDirectory({}, 'linux', '/home/a')).toBe(path.join('/home/a', '.local', 'share', 'scene-director', 'movies'));
    expect(DefaultMoviesDirectory({}, 'darwin', '/Users/a')).toBe(path.join('/Users/a', 'Library', 'Application Support', 'scene-director', 'movies'));
    expect(DefaultMoviesDirectory({ LOCALAPPDATA: 'C:\\Local' }, 'win32', 'C:\\Users\\a')).toBe(path.join('C:\\Local', 'scene-director', 'movies'));
  });

  it('sanitizes names and names a default from the scene and the time', () => {
    expect(MovieFileStem('Duel at Jita!')).toBe('duel-at-jita');
    expect(MovieFileStem('final.mp4')).toBe('final');
    expect(MovieFileStem('Ünïcode Fight')).toBe('unicode-fight');
    expect(MovieFileStem('???')).toBe('movie');
    expect(MovieFileStem('x'.repeat(200))).toHaveLength(80);
    expect(DefaultMovieName('Duel', new Date('2026-10-24T10:15:00.123Z'))).toBe('Duel-20261024-101500');
    expect(DefaultMovieName(null, new Date('2026-10-24T10:15:00Z'))).toBe('movie-20261024-101500');
  });

  it('reserves unique names past existing files and part files', async () => {
    const directory = path.join(await mkdtemp(path.join(os.tmpdir(), 'movie-files-')), 'movies');
    const store = new MovieFileStore(directory);
    const first = await store.Reserve('Duel');
    expect(first).toEqual({ fileName: 'duel.mp4', path: path.join(directory, 'duel.mp4'), partPath: path.join(directory, '.duel.mp4.part') });
    await writeFile(first.partPath, '');
    expect((await store.Reserve('duel')).fileName).toBe('duel-2.mp4');
    await writeFile(path.join(directory, 'duel-2.mp4'), '');
    expect((await store.Reserve('duel')).fileName).toBe('duel-3.mp4');
  });

  it('resolves only movie names inside the directory', () => {
    const store = new MovieFileStore('/tmp/movies');
    expect(store.Resolve('duel.mp4')).toBe(path.resolve('/tmp/movies/duel.mp4'));
    for (const name of ['../duel.mp4', '.duel.mp4.part', 'duel.json', 'a/b.mp4', 'Duel.mp4', '', '..', '%2e%2e.mp4']) expect(store.Resolve(name)).toBeNull();
  });
});
