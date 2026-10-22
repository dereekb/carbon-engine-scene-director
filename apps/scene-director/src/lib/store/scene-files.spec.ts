import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { SCENE_SCHEMA } from '@scene-director/scene';
import { DefaultScenesDirectory, SceneFileStem, SceneFileStore } from './scene-files';

const DUEL = {
  name: 'duel',
  ships: [
    { id: 'a', dna: 'af1_t1:amarrbase:amarr' },
    { id: 'b', dna: 'mf1_t1:minmatarbase:minmatar', position: [3000, 0, 0] }
  ]
};

let directory: string;
let store: SceneFileStore;

beforeEach(async () => {
  // A fresh directory that does not exist yet: the store creates it on the first save.
  directory = path.join(await mkdtemp(path.join(os.tmpdir(), 'scene-files-')), 'scenes');
  store = new SceneFileStore(directory);
});

describe('SceneFileStem', () => {
  it('collapses everything but letters, digits, "_" and "-", so no name leaves the directory', () => {
    expect(SceneFileStem('Duel at Jita')).toBe('duel-at-jita');
    expect(SceneFileStem('../../etc/passwd')).toBe('etc-passwd');
    expect(SceneFileStem(String.raw`..\..\windows\win.ini`)).toBe('windows-win-ini');
    expect(SceneFileStem('C:/scenes/duel')).toBe('c-scenes-duel');
    expect(SceneFileStem('fleet_2 & Amarr')).toBe('fleet_2-amarr');
    expect(SceneFileStem('Ŝtelo')).toBe('ŝtelo');
  });

  it('avoids Windows device names and refuses names with nothing to name a file with', () => {
    expect(SceneFileStem('CON')).toBe('con-scene');
    expect(SceneFileStem('lpt1')).toBe('lpt1-scene');
    expect(() => SceneFileStem('../..')).toThrow(/no letters or digits/);
    expect(() => SceneFileStem('---')).toThrow(/no letters or digits/);
  });
});

describe('DefaultScenesDirectory', () => {
  it('uses the per-user data directory of each platform', () => {
    expect(DefaultScenesDirectory({}, 'linux', '/home/u')).toBe(path.join('/home/u', '.local', 'share', 'scene-director', 'scenes'));
    expect(DefaultScenesDirectory({ XDG_DATA_HOME: '/data' }, 'linux', '/home/u')).toBe(path.join('/data', 'scene-director', 'scenes'));
    expect(DefaultScenesDirectory({}, 'darwin', '/Users/u')).toBe(path.join('/Users/u', 'Library', 'Application Support', 'scene-director', 'scenes'));
    expect(DefaultScenesDirectory({ LOCALAPPDATA: 'C:/Users/u/AppData/Local' }, 'win32', 'C:/Users/u')).toBe(path.join('C:/Users/u/AppData/Local', 'scene-director', 'scenes'));
  });
});

describe('SceneFileStore', () => {
  it('saves a validated document as one file, then reads, lists and deletes it', async () => {
    const saved = await store.Put('Duel at Jita', DUEL);
    expect(saved.file).toBe(path.join(directory, 'duel-at-jita.json'));
    expect(saved.ships).toBe(2);

    const onDisk = JSON.parse(await readFile(saved.file, 'utf8')) as { schema: string; name: string; ships: { position: number[] }[] };
    expect(onDisk.schema).toBe(SCENE_SCHEMA);
    expect(onDisk.name).toBe('Duel at Jita');
    expect(onDisk.ships[0].position).toEqual([0, 0, 0]);

    const opened = await store.Get('duel at jita');
    expect(opened?.name).toBe('Duel at Jita');
    expect(opened?.document.ships.map((ship) => ship.id)).toEqual(['a', 'b']);

    const listing = await store.List();
    expect(listing.directory).toBe(directory);
    expect(listing.scenes).toEqual([expect.objectContaining({ name: 'Duel at Jita', ships: 2, file: saved.file })]);

    expect(await store.Delete('DUEL AT JITA')).toBe(true);
    expect(await store.Delete('Duel at Jita')).toBe(false);
    expect(await store.Get('Duel at Jita')).toBeNull();
  });

  it("saves under the document's own name when none is given, and lists newest first", async () => {
    await store.Put(null, DUEL);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await store.Put('second', { ships: [] });
    expect((await store.List()).scenes.map((entry) => entry.name)).toEqual(['second', 'duel']);
  });

  it('lists nothing when the directory does not exist yet', async () => {
    expect(await store.List()).toEqual({ directory, scenes: [], unreadable: [] });
    expect(await store.Get('duel')).toBeNull();
  });

  it('refuses an invalid document or name and writes nothing', async () => {
    await expect(store.Put('bad', { ships: [{ id: 'a', dna: 'no-colons' }] })).rejects.toThrow(/Invalid scene document/);
    await expect(store.Put('../..', DUEL)).rejects.toThrow(/no letters or digits/);
    await expect(store.Put('  ', DUEL)).rejects.toThrow(/name is required/);
    await expect(store.Put('line\nbreak', DUEL)).rejects.toThrow(/control characters/);
    expect((await store.List()).scenes).toEqual([]);
  });

  it('a name differing only in case replaces the scene; a different name on the same file is refused', async () => {
    await store.Put('Duel', DUEL);
    await store.Put('duel', { ...DUEL, ships: [DUEL.ships[0]] });
    const listing = await store.List();
    expect(listing.scenes).toEqual([expect.objectContaining({ name: 'duel', ships: 1 })]);

    await expect(store.Put('duel!', DUEL)).rejects.toThrow(/holds the scene "duel"/);
    expect((await store.Get('duel'))?.ships).toBe(1);
    expect((await readdir(directory)).filter((file) => file.endsWith('.tmp'))).toEqual([]);
  });

  it('reports files that are not scenes and opens hand-placed files by their stem', async () => {
    await store.Put('duel', DUEL);
    await writeFile(path.join(directory, 'broken.json'), '{ not json');
    await writeFile(path.join(directory, 'wrong.json'), JSON.stringify({ schema: 'cjs-scene/9' }));
    await writeFile(path.join(directory, 'by-hand.json'), JSON.stringify({ ...DUEL, name: 'Something Else' }));
    await writeFile(path.join(directory, 'notes.txt'), 'ignored');

    const listing = await store.List();
    expect(listing.scenes.map((entry) => entry.name).sort()).toEqual(['by-hand', 'duel']);
    expect(listing.unreadable.map((entry) => path.basename(entry.file)).sort()).toEqual(['broken.json', 'wrong.json']);
    expect(listing.unreadable.find((entry) => entry.file.endsWith('wrong.json'))?.error).toMatch(/schema must be "cjs-scene\/1"/);

    expect((await store.Get('by-hand'))?.document.name).toBe('Something Else');
    await expect(store.Get('broken')).rejects.toThrow(/broken\.json is not a valid scene/);
    await expect(store.Put('broken', DUEL)).rejects.toThrow(/is not a readable scene/);
  });
});
