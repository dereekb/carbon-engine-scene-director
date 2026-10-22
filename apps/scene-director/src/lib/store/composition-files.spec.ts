import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { defaultFleetCompositionsDirectory, FleetCompositionFileStore } from './composition-files';

const MINI = { id: 'mini', commander: { hull: 'Rifter', dna: 'mf1_t1:minmatarbase:minmatar', radius: 31 }, wings: [{ id: 'w', squads: [{ id: 's', role: 'dps', ships: [{ hull: 'Rifter', count: 3, dna: 'mf1_t1:minmatarbase:minmatar' }] }] }] };

let directory: string;
let store: FleetCompositionFileStore;

beforeEach(async () => {
  directory = path.join(await mkdtemp(path.join(os.tmpdir(), 'composition-files-')), 'fleets');
  store = new FleetCompositionFileStore(directory);
});

describe('FleetCompositionFileStore', () => {
  it('defaults to scene-director/fleets in the per-user data directory', () => {
    expect(defaultFleetCompositionsDirectory({ XDG_DATA_HOME: '/data' })).toMatch(/scene-director[/\\]fleets$/u);
  });

  it('saves under the name, else the id, and reads, lists and deletes', async () => {
    const byId = await store.Put(null, MINI);
    expect(byId).toMatchObject({ name: 'mini', ships: 4, file: path.join(directory, 'mini.json') });
    expect(byId.document.name).toBe('mini');
    const byName = await store.Put(null, { ...MINI, id: 'other', name: 'Rifter Gang' });
    expect(byName.file).toBe(path.join(directory, 'rifter-gang.json'));
    expect((await store.Get('rifter gang'))?.document.id).toBe('other');
    expect((await store.List()).compositions.map((entry) => entry.name).sort()).toEqual(['Rifter Gang', 'mini']);
    expect(await store.Delete('MINI')).toBe(true);
    expect(await store.Delete('mini')).toBe(false);
  });

  it('refuses another composition on the same file, and invalid ones, in fleet composition terms', async () => {
    await store.Put('gang', MINI);
    await expect(store.Put('Gang!', { ...MINI, id: 'x' })).rejects.toThrow(/holds the fleet composition "gang"/u);
    await expect(store.Put('bad', { id: 'bad' })).rejects.toThrow(/Invalid fleet composition:\n- composition\.commander must be an object/u);
    await expect(store.Put(' ', MINI)).rejects.toThrow(/a fleet composition name is required/u);
  });

  it('lists a hand-placed invalid file as unreadable', async () => {
    await store.Put(null, MINI);
    await writeFile(path.join(directory, 'scene.json'), JSON.stringify({ schema: 'cjs-scene/1', name: 'oops' }));
    const listing = await store.List();
    expect(listing.compositions.map((entry) => entry.name)).toEqual(['mini']);
    expect(listing.unreadable).toEqual([{ file: path.join(directory, 'scene.json'), error: expect.stringMatching(/is not a valid fleet composition: composition\.schema must be "cjs-fleet\/1"/u) }]);
  });
});
