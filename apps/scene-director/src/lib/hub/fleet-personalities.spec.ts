import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BUILT_IN_FLEET_PERSONALITY_NAMES, type FleetPersonality, normalizeScene, type SceneDocument, SceneError } from '@scene-director/scene';
import { beforeEach, describe, expect, it } from 'vitest';
import { FleetPersonalityFileStore } from '../store/personality-files';
import { FleetPersonalities, MergeFleetPersonalityOver, PersonalityOperations } from './fleet-personalities';
import { MakeFakeMapData } from './map-data.testing';
import { MakeFakeShipData } from './ship-data.testing';
import { ToolError } from './tool-call';

const NO_PAGE = {
  Connected: () => false,
  NotConnected: () => new ToolError('No viewer tab is connected.'),
  Call: async () => {
    throw new Error('no page');
  }
};

const SCHEMA = 'cjs-fleet-personality/1';

const SCENE = {
  name: 'two fleets',
  ships: [
    { id: 'a-fc', dna: 'mb2_t1:minmatarnavy:minmatar' },
    { id: 'a-1', dna: 'mb2_t1:minmatarnavy:minmatar', position: [1000, 0, 0] }
  ],
  personalities: { 'scene-style': { schema: SCHEMA, extends: 'veteran', engage: 'when-attacked' } },
  fleets: [{ id: 'a', commander: 'a-fc', wings: [{ id: 'w', squads: [{ id: 's', role: 'dps', members: ['a-1'] }] }] }]
};

let personalities: FleetPersonalities;

async function Problems(action: Promise<unknown>): Promise<string> {
  const error = await action.then(
    () => null,
    (failure: unknown) => failure
  );
  expect(error).toBeInstanceOf(Error);
  return error instanceof SceneError ? error.problems.join('\n') : String((error as Error).message);
}

beforeEach(async () => {
  const files = new FleetPersonalityFileStore(await mkdtemp(path.join(os.tmpdir(), 'fleet-personalities-')));
  personalities = new FleetPersonalities({ files, shipData: MakeFakeShipData().shipData, mapData: MakeFakeMapData().mapData, page: NO_PAGE });
});

describe('MergeFleetPersonalityOver', () => {
  it("keeps the head's fields and identity, takes the base's others and extends what the base extended", () => {
    const head: FleetPersonality = { schema: SCHEMA, id: 'head', extends: 'base', name: 'Head', targeting: { queue: 0 }, movement: { stance: 'kite' } };
    const base: FleetPersonality = { schema: SCHEMA, id: 'base', extends: 'sniper', name: 'Base', description: 'the base', engage: 'on-sight', targeting: { queue: 3, prefer: 'weakest' } };
    expect(MergeFleetPersonalityOver(head, base)).toEqual({ schema: SCHEMA, id: 'head', extends: 'sniper', name: 'Head', engage: 'on-sight', targeting: { queue: 0, prefer: 'weakest' }, movement: { stance: 'kite' } });
    expect(MergeFleetPersonalityOver({ schema: SCHEMA, id: 'head', extends: 'base' }, { schema: SCHEMA, id: 'base' })).toEqual({ schema: SCHEMA, id: 'head' });
  });
});

describe('FleetPersonalities', () => {
  it('lists the saved ones newest first, then every built-in with its description', async () => {
    await personalities.Save({ personality: { schema: SCHEMA, id: 'mine', extends: 'brawler', name: 'Mine', description: 'Mine to pick.' } });
    const listed = (await personalities.Call('list_fleet_personalities', {})) as { personalities: Record<string, unknown>[]; directory: string };
    expect(listed.personalities[0]).toMatchObject({ name: 'mine', store: 'disk', title: 'Mine', extends: 'brawler', description: 'Mine to pick.' });
    expect(listed.personalities.slice(1).map((entry) => entry['name'])).toEqual([...BUILT_IN_FLEET_PERSONALITY_NAMES]);
    expect(listed.personalities.slice(1).every((entry) => entry['store'] === 'built-in' && typeof entry['description'] === 'string')).toBe(true);
    expect(listed.personalities.find((entry) => entry['name'] === 'line')).not.toHaveProperty('extends');
    expect(listed.directory).toBe(personalities.files.directory);
  });

  it('gets a built-in or a saved one as written and resolved through its saved chain', async () => {
    const line = (await personalities.Get({ name: 'Line' })) as { name: string; store: string; resolved: { chain: string[] } };
    expect(line).toMatchObject({ name: 'line', store: 'built-in', resolved: { chain: ['line'] } });
    await personalities.Save({ personality: { schema: SCHEMA, id: 'base', extends: 'kiter', targeting: { queue: 4 } } });
    await personalities.Save({ name: 'top', personality: { schema: SCHEMA, id: 'ignored', extends: 'base', engage: 'on-sight' } });
    const top = (await personalities.Get({ name: 'TOP' })) as { name: string; personality: FleetPersonality; resolved: { id: string; chain: string[]; engage: string; targeting: { queue: number } } };
    expect(top.name).toBe('top');
    expect(top.personality).toMatchObject({ id: 'top', extends: 'base' });
    expect(top.resolved).toMatchObject({ id: 'top', chain: ['top', 'base', 'kiter', 'line'], engage: 'on-sight', targeting: { queue: 4 } });
    await expect(personalities.Get({ name: 'nobody' })).rejects.toThrow(/no fleet personality "nobody"/u);
  });

  it('refuses built-in names in any case, bad keys, unknown bases, loops and invalid fields', async () => {
    await expect(personalities.Save({ personality: { schema: SCHEMA, id: 'Brawler' } })).rejects.toThrow(/built-in personality "brawler"; built-ins are read-only/u);
    await expect(personalities.Save({ personality: { schema: SCHEMA }, name: 'has space' })).rejects.toThrow(/1-64 letters/u);
    expect(await Problems(personalities.Save({ personality: { schema: SCHEMA, id: 'orphan', extends: 'missing' } }))).toMatch(/"orphan" extends "missing", which is not a built-in personality, a saved one; save it first/u);
    await personalities.Save({ personality: { schema: SCHEMA, id: 'loop-a' } });
    await personalities.Save({ personality: { schema: SCHEMA, id: 'loop-b', extends: 'loop-a' } });
    expect(await Problems(personalities.Save({ personality: { schema: SCHEMA, id: 'loop-a', extends: 'loop-b' } }))).toMatch(/loops \(loop-a -> loop-b -> loop-a\)/u);
    expect(await Problems(personalities.Save({ personality: { schema: SCHEMA, id: 'bad', command: { handover: 1 } } }))).toMatch(/handover/u);
  });

  it('deletes a saved one, naming the saved ones extending it, and keeps the built-ins', async () => {
    await personalities.Save({ personality: { schema: SCHEMA, id: 'base' } });
    await personalities.Save({ personality: { schema: SCHEMA, id: 'child', extends: 'base' } });
    expect(await personalities.Delete({ name: 'base' })).toEqual({ deleted: true, name: 'base', note: 'saved personalities extending it no longer resolve until it is saved again: child' });
    expect(await personalities.Delete({ name: 'base' })).toMatchObject({ deleted: false });
    expect(await personalities.Delete({ name: 'sniper' })).toMatchObject({ deleted: false, note: '"sniper" is a built-in personality; built-ins are read-only' });
  });

  it('embeds a built-in as is, a scene key as is, and a saved or inline one flattened over its saved bases', async () => {
    const scene: SceneDocument = normalizeScene(SCENE).scene;
    const builtIn = await personalities.Embed('ALPHA', { scene, where: 'personality' });
    expect(builtIn).toMatchObject({ key: 'alpha', from: 'built-in', templates: {} });
    expect(await personalities.Embed('scene-style', { scene, where: 'personality' })).toMatchObject({ key: 'scene-style', from: 'scene', templates: {}, personality: { chain: ['scene-style', 'veteran', 'line'] } });

    await personalities.Save({ personality: { schema: SCHEMA, id: 'base', extends: 'headhunter', pilots: { reaction: [0.2, 0.4] } } });
    await personalities.Save({ personality: { schema: SCHEMA, id: 'Saved-Top', extends: 'base', movement: { propMods: 'never' } } });
    const saved = await personalities.Embed('saved-top', { scene, where: 'personality' });
    expect(saved.key).toBe('Saved-Top');
    expect(saved.templates).toEqual({ 'Saved-Top': { schema: SCHEMA, id: 'Saved-Top', extends: 'headhunter', pilots: { reaction: [0.2, 0.4] }, movement: { propMods: 'never' } } });
    expect(saved.personality.chain).toEqual(['Saved-Top', 'headhunter', 'line']);

    // An inline template's chain may end at a key the scene holds; that link stays an extends.
    const inline = await personalities.Embed({ schema: SCHEMA, id: 'inline', extends: 'scene-style', bogus: 1 }, { scene, where: 'personality' });
    expect(inline).toMatchObject({ key: 'inline', from: 'inline', templates: { inline: { extends: 'scene-style' } }, personality: { chain: ['inline', 'scene-style', 'veteran', 'line'] } });
    expect(inline.warnings.join()).toMatch(/bogus/u);
    expect(PersonalityOperations([builtIn, saved, null, inline])).toEqual([{ op: 'set_personalities', personalities: { ...saved.templates, ...inline.templates } }]);
    expect(PersonalityOperations([builtIn])).toEqual([]);

    await expect(personalities.Embed({ schema: SCHEMA, id: 'line' }, { scene, where: 'sides[0].personality' })).rejects.toThrow(/sides\[0\]\.personality\.id "line" is the built-in personality "line"/u);
    await expect(personalities.Embed('nobody', { scene, where: 'personality' })).rejects.toThrow(/personality: no fleet personality "nobody" is built in, saved in .* or a key of the scene's personalities/u);
    await expect(personalities.Embed(7, { scene, where: 'personality' })).rejects.toThrow(/must be a personality name/u);
  });

  it("sets a fleet's personality in one patch, embedding a saved one, and clears it with null", async () => {
    await personalities.Save({ personality: { schema: SCHEMA, id: 'my-brawler', extends: 'brawler', engage: 'on-sight' } });
    const set = (await personalities.Call('set_fleet_personality', { fleet: 'a', personality: 'my-brawler', scene: SCENE })) as { fleet: string; personality: object; loaded: boolean; scene: SceneDocument };
    expect(set.fleet).toBe('a');
    expect(set.loaded).toBe(false);
    expect(set.personality).toEqual({ name: 'my-brawler', from: 'disk', chain: ['my-brawler', 'brawler', 'line'], embedded: ['my-brawler'] });
    expect(set.scene.fleets?.[0].personality).toBe('my-brawler');
    expect(Object.keys(set.scene.personalities ?? {})).toEqual(['scene-style', 'my-brawler']);

    const cleared = (await personalities.SetFleetPersonality({ fleet: 'a', personality: null, scene: set.scene })) as { personality: null; scene: SceneDocument };
    expect(cleared.personality).toBeNull();
    expect(cleared.scene.fleets?.[0]).not.toHaveProperty('personality');

    await expect(personalities.SetFleetPersonality({ fleet: 'b', personality: 'line', scene: SCENE })).rejects.toThrow(/no fleet "b"/u);
    await expect(personalities.SetFleetPersonality({ fleet: 'a', scene: SCENE })).rejects.toThrow(/personality is required/u);
    await expect(personalities.SetFleetPersonality({ fleet: 'a', personality: 'line' })).rejects.toThrow(/No viewer tab is connected/u);
  });
});
