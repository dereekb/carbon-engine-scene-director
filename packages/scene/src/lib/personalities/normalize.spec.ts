import { describe, expect, it } from 'vitest';
import { applySceneOperations, normalizeScene, SceneError } from '../scene';
import { BUILT_IN_FLEET_PERSONALITY_NAMES, FLEET_PERSONALITY_EXAMPLES } from './examples';
import { builtInFleetPersonalities, normalizeFleetPersonality, resolveFleetPersonality } from './normalize';
import { DEFAULT_FLEET_PERSONALITY, FLEET_PERSONALITY_SCHEMA, type FleetPersonality } from './personality';
import { normalizeShipPilot, pilotFlightPart } from './pilots';

const DNA = 'ab3_t1:amarrbase:amarr';

function catchSceneError(run: () => unknown): SceneError {
  try {
    run();
  } catch (error) {
    if (error instanceof SceneError) return error;
    throw error;
  }
  throw new Error('expected a SceneError');
}

function fleetScene(extra: Record<string, unknown> = {}, fleet: Record<string, unknown> = {}) {
  return {
    ships: [
      { id: 'fc', dna: DNA },
      { id: 'm', dna: DNA }
    ],
    fleets: [{ id: 'f', commander: 'fc', wings: [{ id: 'w', squads: [{ id: 's', role: 'dps', members: ['m'] }] }], ...fleet }],
    ...extra
  };
}

describe('fleet personalities', () => {
  it('every built-in is valid, described, and resolves complete', () => {
    expect(BUILT_IN_FLEET_PERSONALITY_NAMES).toEqual(['line', 'brawler', 'kiter', 'sniper', 'headhunter', 'alpha', 'green', 'veteran', 'defensive']);
    expect([...builtInFleetPersonalities().keys()]).toEqual(BUILT_IN_FLEET_PERSONALITY_NAMES);
    for (const [index, example] of FLEET_PERSONALITY_EXAMPLES.entries()) {
      const { personality, problems, warnings } = normalizeFleetPersonality({ input: example, where: `example ${index}` });
      expect(problems).toEqual([]);
      expect(warnings).toEqual([]);
      expect(personality?.description?.length).toBeGreaterThan(40);
      const resolved = resolveFleetPersonality({ name: personality?.id ?? '' }).personality;
      expect(resolved?.chain[resolved.chain.length - 1]).toBe(DEFAULT_FLEET_PERSONALITY);
      for (const section of [resolved?.command, resolved?.pilots, resolved?.targeting, resolved?.movement]) {
        expect(Object.values(section ?? {}).every((value) => value !== undefined)).toBe(true);
      }
    }
    const line = resolveFleetPersonality({ name: 'line' }).personality;
    expect(Object.keys(line?.command ?? {}).sort()).toEqual(['ability', 'backups', 'handover', 'succession']);
    expect(Object.keys(line?.targeting ?? {}).sort()).toEqual(['calls', 'freeFire', 'prefer', 'priority', 'queue', 'reach', 'switch']);
    expect(Object.keys(line?.movement ?? {}).sort()).toEqual(['propMods', 'range', 'stance']);
    expect(line?.chain).toEqual(['line']);
  });

  it('extends merges field by field over its base, down to line', () => {
    const personalities: Record<string, FleetPersonality> = {
      fast: { schema: FLEET_PERSONALITY_SCHEMA, id: 'fast', extends: 'brawler', pilots: { reaction: 1 }, targeting: { queue: 0 } },
      faster: { schema: FLEET_PERSONALITY_SCHEMA, id: 'faster', extends: 'fast', name: 'Faster', movement: { range: 5000 } }
    };
    const { personality, problems } = resolveFleetPersonality({ name: 'faster', personalities });
    expect(problems).toEqual([]);
    expect(personality?.chain).toEqual(['faster', 'fast', 'brawler', 'line']);
    expect(personality?.name).toBe('Faster');
    expect(personality?.pilots.reaction).toBe(1);
    expect(personality?.targeting).toMatchObject({ queue: 0, prefer: 'nearest', reach: 'optimal', switch: 'on-kill', freeFire: true });
    expect(personality?.movement).toEqual({ stance: 'brawl', range: 5000, propMods: 'always' });
    expect(personality?.engage).toBe('on-sight');
    expect(personality?.command).toEqual(resolveFleetPersonality({ name: 'line' }).personality?.command);
    const plain = resolveFleetPersonality({ name: 'x', personalities: { x: { schema: FLEET_PERSONALITY_SCHEMA, id: 'x', engage: 'when-attacked' } } }).personality;
    expect(plain?.chain).toEqual(['x', 'line']);
  });

  it('refuses loops, unknown names and bad fields', () => {
    const loop: Record<string, FleetPersonality> = {
      a: { schema: FLEET_PERSONALITY_SCHEMA, id: 'a', extends: 'b' },
      b: { schema: FLEET_PERSONALITY_SCHEMA, id: 'b', extends: 'a' }
    };
    expect(resolveFleetPersonality({ name: 'a', personalities: loop }).problems).toEqual(['personality "a": its extends chain loops (a -> b -> a)']);
    expect(resolveFleetPersonality({ name: 'nope' }).problems).toEqual(['personality "nope": "nope" is not a built-in personality or a key of personalities']);
    const { problems, warnings } = normalizeFleetPersonality({
      input: {
        id: 'bad',
        extends: 'bad',
        colour: 'red',
        command: { ability: [0.9, 0.2], backups: 11, succession: [], handover: 1 },
        pilots: { reaction: 2 },
        engage: 'sometimes',
        targeting: { priority: ['logi', 'logi', 'boss'], reach: 300000, queue: 1.5, freeFire: 'yes' },
        movement: { stance: 'orbit', range: 'far' }
      },
      where: 'p'
    });
    expect(warnings).toEqual(['p.colour is not a known field and was dropped']);
    expect(problems).toEqual([
      'p.extends cannot name the template itself',
      'p.command.ability must be a number in [0, 1] or [lo, hi] with 0 <= lo <= hi <= 1',
      'p.command.backups must be a whole number in [0, 10]',
      'p.command.succession must name at least one of most-able, chain, anyone',
      'p.command.handover (seconds) must be a finite number in [2, 300]',
      'p.pilots.reaction must be a number in [0, 1] or [lo, hi] with 0 <= lo <= hi <= 1',
      'p.engage must be one of on-sight, in-range, when-attacked, got "sometimes"',
      'p.targeting.priority names "logi" more than once',
      'p.targeting.priority[2] must be one of fc, dps, logi, tackle, ewar, boost, support, got "boss"',
      'p.targeting.reach must be one of lock, optimal, falloff or metres in (0, 250000]',
      'p.targeting.queue must be a whole number in [0, 10]',
      'p.targeting.freeFire must be true or false',
      'p.movement.stance must be one of brawl, kite, snipe, hold, got "orbit"',
      'p.movement.range must be one of lock, optimal, falloff or metres in (0, 250000]'
    ]);
  });

  it('the document embeds templates, fleets pick a name, and unknown names are refused', () => {
    const custom = { extends: 'sniper', description: 'Ferox at 60 km', movement: { range: 60000 } };
    const { scene, warnings } = normalizeScene(fleetScene({ personalities: { ferox: custom } }, { personality: 'ferox' }));
    expect(warnings).toEqual([]);
    expect(scene.personalities).toEqual({ ferox: { schema: FLEET_PERSONALITY_SCHEMA, id: 'ferox', ...custom } });
    expect(scene.fleets?.[0].personality).toBe('ferox');
    expect(normalizeScene(JSON.parse(JSON.stringify(scene))).scene).toEqual(scene);
    expect(normalizeScene(fleetScene({}, { personality: 'brawler' })).scene.fleets?.[0].personality).toBe('brawler');
    expect(catchSceneError(() => normalizeScene(fleetScene({}, { personality: 'ferox' }))).problems).toEqual(['fleets[0].personality "ferox" is not a built-in personality or a key of personalities']);
    expect(catchSceneError(() => normalizeScene(fleetScene({ personalities: { brawler: {} } }))).problems).toEqual(['personalities key "brawler" is a built-in personality; pick another key and extend it']);
    expect(catchSceneError(() => normalizeScene(fleetScene({ personalities: { a: { id: 'b' }, c: { extends: 'missing' } } }))).problems).toEqual(['personalities["a"].id "b" must match its key "a"']);
    expect(catchSceneError(() => normalizeScene(fleetScene({ personalities: { c: { extends: 'missing' } } }))).problems).toEqual(['personalities["c"]: "c" extends "missing", which is not a built-in personality or a key of personalities']);
  });

  it('set_personalities merges, deletes a key no fleet uses, and update_fleet picks one', () => {
    const { scene } = normalizeScene(fleetScene());
    const added = applySceneOperations(scene, [
      { op: 'set_personalities', personalities: { ferox: { extends: 'sniper' }, spare: { extends: 'green' } } },
      { op: 'update_fleet', fleet: 'f', set: { personality: 'ferox' } }
    ]);
    expect(Object.keys(added.scene.personalities ?? {})).toEqual(['ferox', 'spare']);
    expect(added.scene.fleets?.[0].personality).toBe('ferox');
    expect(() => applySceneOperations(added.scene, [{ op: 'set_personalities', personalities: { ferox: null } }])).toThrow('personality "ferox" is used by fleet "f"');
    const removed = applySceneOperations(added.scene, [
      { op: 'set_personalities', personalities: { spare: null, gone: null } },
      { op: 'update_fleet', fleet: 'f', set: { personality: null } },
      { op: 'set_personalities', personalities: { ferox: null } }
    ]);
    expect(removed.scene.personalities).toBeUndefined();
    expect(removed.scene.fleets?.[0].personality).toBeUndefined();
    expect(removed.warnings).toEqual(['operations[0]: the scene has no personality "gone" to delete']);
  });
});

describe('ship pilots', () => {
  it('reads command and reaction, keeps a name and other keys as reserved', () => {
    expect(normalizeShipPilot({ input: { command: 0.7, reaction: 1 }, where: 'p' })).toEqual({ pilot: { command: 0.7, reaction: 1 }, problems: [], warnings: [] });
    const named = normalizeShipPilot({ input: 'fc', where: 'p' });
    expect(named.pilot).toBe('fc');
    expect(named.warnings).toEqual(['p is reserved for the character system and is stored but not used yet; ships fly with the max-skills pilot']);
    const skilled = normalizeShipPilot({ input: { reaction: 0.2, skills: { Navigation: 4 } }, where: 'p' });
    expect(skilled.pilot).toEqual({ reaction: 0.2, skills: { Navigation: 4 } });
    expect(skilled.warnings).toEqual(['p.skills is reserved for the character system and is stored but not used yet; ships fly with the max-skills pilot']);
    expect(normalizeShipPilot({ input: { command: 1.5 }, where: 'p' }).problems).toEqual(['p.command must be a finite number in [0, 1]']);
    expect(normalizeShipPilot({ input: {}, where: 'p' }).pilot).toBeNull();
    expect(pilotFlightPart({ command: 1, reaction: 0 })).toBeNull();
    expect(pilotFlightPart({ command: 1, skills: {} })).toEqual({ skills: {} });
    expect(pilotFlightPart('fc')).toBe('fc');
  });
});
