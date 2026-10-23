import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { FleetPersonalityFileStore } from './personality-files';

let directory: string;
let store: FleetPersonalityFileStore;

beforeEach(async () => {
  directory = path.join(await mkdtemp(path.join(os.tmpdir(), 'personality-files-')), 'personalities');
  store = new FleetPersonalityFileStore(directory);
});

describe('FleetPersonalityFileStore', () => {
  it('saves under a name that becomes the id, reads it back in any case and lists it without a ship count', async () => {
    const saved = await store.Put('My-Brawler', { schema: 'cjs-fleet-personality/1', id: 'draft', extends: 'brawler', engage: 'on-sight' });
    expect(saved).toMatchObject({ name: 'My-Brawler', file: path.join(directory, 'my-brawler.json'), document: { id: 'My-Brawler', extends: 'brawler', engage: 'on-sight' } });
    expect(saved).not.toHaveProperty('ships');
    expect(JSON.parse(await readFile(saved.file, 'utf8'))).toMatchObject({ id: 'My-Brawler' });
    expect((await store.Get('my-brawler'))?.document.id).toBe('My-Brawler');
    const listing = await store.List();
    expect(listing.personalities).toEqual([{ name: 'My-Brawler', file: saved.file, savedAt: saved.savedAt }]);
    expect(listing.unreadable).toEqual([]);
  });

  it('refuses an invalid template and lists an invalid file apart', async () => {
    await expect(store.Put(null, { schema: 'cjs-fleet-personality/1', id: 'x', engage: 'never' })).rejects.toThrow(/Invalid fleet personality/u);
    await store.Put(null, { schema: 'cjs-fleet-personality/1', id: 'fine' });
    await writeFile(path.join(directory, 'broken.json'), '{ "schema": "cjs-fleet-personality/1", "id": "broken", "targeting": { "queue": 99 } }', 'utf8');
    const listing = await store.List();
    expect(listing.personalities.map((entry) => entry.name)).toEqual(['fine']);
    expect(listing.unreadable).toHaveLength(1);
    expect(listing.unreadable[0].error).toMatch(/queue/u);
  });
});
