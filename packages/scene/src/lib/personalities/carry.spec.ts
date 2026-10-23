import { describe, expect, it } from 'vitest';
import { normalizeFleetComposition } from '../compositions/normalize';
import { apply, catchSceneError, makeMiniComposition, RIFTER, scene } from '../staging/staging.spec-helper';

const FEROX = 'bc1_t1:caldaribase:caldari';

function withPilots(): Record<string, unknown> {
  const composition = makeMiniComposition() as { commander: Record<string, unknown>; wings: { squads: { ships: Record<string, unknown>[] }[] }[] };
  composition.commander['pilot'] = { command: 0.9 };
  composition.wings[0].squads[0].ships[0]['pilot'] = { reaction: 0.3 };
  return { ...composition, personality: 'brawler' };
}

describe('compositions and staging carry personality and pilot', () => {
  it('a composition round-trips its personality and pilots, and expands them onto the fleet and ships', () => {
    const { composition, problems } = normalizeFleetComposition({ input: withPilots() });
    expect(problems).toEqual([]);
    expect(composition?.personality).toBe('brawler');
    expect(composition?.commander.pilot).toEqual({ command: 0.9 });
    expect(normalizeFleetComposition({ input: JSON.parse(JSON.stringify(composition)) }).composition).toEqual(composition);
    expect(normalizeFleetComposition({ input: { ...withPilots(), personality: 'not a name' } }).problems).toEqual(['composition.personality must be 1-64 letters, digits, "_", "-" or "."']);

    const { scene: after } = apply(scene(), { op: 'add_fleet_composition', composition: withPilots(), position: [0, 0, 0] });
    const fleet = after.fleets?.[0];
    expect(fleet?.personality).toBe('brawler');
    expect(after.ships.find((ship) => ship.id === fleet?.commander)?.pilot).toEqual({ command: 0.9 });
    const line = composition?.wings[0].squads[0];
    const members = fleet?.wings[0].squads.find((squad) => squad.id === line?.id)?.members ?? [];
    expect(members.length).toBeGreaterThan(0);
    for (const id of members.slice(0, composition?.wings[0].squads[0].ships[0].count ?? 1)) expect(after.ships.find((ship) => ship.id === id)?.pilot).toEqual({ reaction: 0.3 });

    const overridden = apply(scene(), { op: 'add_fleet_composition', composition: withPilots(), position: [0, 0, 0], personality: 'sniper' }).scene;
    expect(overridden.fleets?.[0].personality).toBe('sniper');
    expect(catchSceneError(() => apply(scene(), { op: 'add_fleet_composition', composition: withPilots(), position: [0, 0, 0], personality: 'nobody' })).problems).toEqual(['fleets[0].personality "nobody" is not a built-in personality or a key of personalities']);
  });

  it('stage_engagement sides take a personality and ship lines a pilot; free ships refuse a personality', () => {
    const { scene: after } = apply(scene(), {
      op: 'stage_engagement',
      sides: [
        { composition: makeMiniComposition(), personality: 'brawler' },
        { ships: [{ hull: 'Ferox', dna: FEROX, radius: 215, count: 3, pilot: { reaction: 0.9 } }], personality: 'sniper' }
      ]
    });
    expect(after.fleets?.map((fleet) => [fleet.id, fleet.personality])).toEqual([
      ['mini', 'brawler'],
      ['red', 'sniper']
    ]);
    const red = after.ships.filter((ship) => ship.team === 'red');
    expect(red.map((ship) => ship.pilot)).toEqual([{ reaction: 0.9 }, { reaction: 0.9 }, { reaction: 0.9 }]);
    const free = catchSceneError(() => apply(scene(), { op: 'stage_engagement', sides: [{ composition: makeMiniComposition() }, { ships: [{ hull: 'Ferox', dna: FEROX }], fleet: false, personality: 'sniper' }] }));
    expect(free.problems).toEqual(['operations[0].sides[1].personality needs a fleet: free ships (fleet: false) have no FC to run one']);
  });

  it('add_ships gives every ship its pilot and a new fleet its personality', () => {
    const { scene: after } = apply(scene(), { op: 'add_ships', dna: RIFTER, hull: 'Rifter', count: 3, position: [0, 0, 0], pilot: { command: 0.5 }, fleet: { new: true, personality: 'kiter' } });
    expect(after.fleets?.[0].personality).toBe('kiter');
    expect(after.ships.map((ship) => ship.pilot)).toEqual([{ command: 0.5 }, { command: 0.5 }, { command: 0.5 }]);
    const loose = apply(scene(), { op: 'add_ships', dna: RIFTER, hull: 'Rifter', count: 2, position: [0, 0, 0], pilot: { reaction: 1 } }).scene;
    expect(loose.ships.map((ship) => ship.pilot)).toEqual([{ reaction: 1 }, { reaction: 1 }]);
  });
});
