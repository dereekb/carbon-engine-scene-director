import { describe, expect, it } from 'vitest';
import { toFleetMemberships } from '../fleets/membership';
import { commandFleet } from './personalities.spec-helper';
import { FLEET_AWARENESS_RANGE, type FleetShipFacts, toFleetPicture, toFleetReachNumbers, toFleetTeam } from './picture';

function facts(id: string, x: number, extra: Partial<FleetShipFacts> = {}): FleetShipFacts {
  return { id, team: 'blue', position: [x, 0, 0], radius: 50, health: 1, remaining: 1000, dps: 10, signature: 50, speed: 400, ...extra };
}

describe('fleet picture', () => {
  it('takes the FC team, else the members most common', () => {
    expect(toFleetTeam('red', ['blue', 'blue'])).toBe('red');
    expect(toFleetTeam(null, ['blue', 'red', 'red', null])).toBe('red');
    expect(toFleetTeam(null, ['blue', 'red'])).toBe('blue');
    expect(toFleetTeam(null, [null])).toBeNull();
  });

  it('medians each reach over the members that have it', () => {
    const reach = (lock: number, optimal: number, falloff: number) => ({ reach: { lock, optimal, falloff } });
    expect(toFleetReachNumbers([reach(50_000, 10_000, 20_000), reach(60_000, 0, 0), reach(70_000, 30_000, 40_000)])).toEqual({ lock: 60_000, optimal: 20_000, falloff: 30_000 });
    expect(toFleetReachNumbers([])).toEqual({ lock: 0, optimal: 0, falloff: 0 });
  });

  it('lists members in fleet order and hostiles of another team by distance, inside awareness', () => {
    const fleet = { ...commandFleet(), wings: [{ id: 'w', squads: [{ id: 's', role: 'dps' as const, members: ['m1', 'm2'] }] }] };
    const enemy = { id: 'e', commander: 'h2', wings: [{ id: 'w', squads: [{ id: 'l', role: 'logi' as const, members: ['h1'] }] }] };
    const memberships = toFleetMemberships({ fleets: [fleet, enemy] });
    const ships = [
      facts('m2', 100, { attackedBy: ['h1'], reach: { lock: 50_000, optimal: 5000, falloff: 10_000 } }),
      facts('fc', 0),
      facts('m1', 200, { away: true }),
      facts('h1', 10_100, { team: 'red', target: 'm2' }),
      facts('h2', 5100, { team: 'red' }),
      facts('n', 3000, { team: undefined }),
      facts('far', FLEET_AWARENESS_RANGE + 1000, { team: 'red' })
    ];
    const seen = toFleetPicture({ fleet, memberships, ships, fc: { ship: 'fc', ability: 0.7 }, call: ['h1'], order: null, freeFire: false, propMods: 'off' });
    expect(seen.team).toBe('blue');
    expect(seen.members.map((ship) => ship.id)).toEqual(['fc', 'm2']);
    expect(seen.members[0]).toMatchObject({ role: 'fc', commands: ['fleet'], distance: 0 });
    expect(seen.members[1]).toMatchObject({ attackedBy: ['h1'], distance: 0 });
    expect(seen.hostiles.map((ship) => ship.id)).toEqual(['h2', 'h1']);
    expect(seen.hostiles[0]).toMatchObject({ role: 'fc', distance: 5000, offset: [5100, 0, 0] });
    expect(seen.hostiles[1]).toMatchObject({ role: 'logi', distance: 10_000, target: 'm2' });
    expect(seen.reach).toEqual({ lock: 50_000, optimal: 5000, falloff: 10_000 });
    expect(JSON.parse(JSON.stringify(seen))).toEqual(seen);
  });

  it('sees no hostiles without a team or an FC', () => {
    const fleet = commandFleet();
    const ships = [facts('fc', 0, { team: undefined }), facts('h', 1000, { team: 'red' })];
    const memberships = toFleetMemberships({ fleets: [fleet] });
    expect(toFleetPicture({ fleet, memberships, ships, fc: { ship: 'fc', ability: 1 }, call: [], order: null, freeFire: false, propMods: 'none' }).hostiles).toEqual([]);
    expect(toFleetPicture({ fleet, memberships, ships: [facts('fc', 0), facts('h', 1000, { team: 'red' })], fc: null, call: [], order: null, freeFire: false, propMods: 'none' }).hostiles).toEqual([]);
  });
});
