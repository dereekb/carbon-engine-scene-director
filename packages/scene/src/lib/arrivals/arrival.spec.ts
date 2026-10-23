import { describe, expect, it } from 'vitest';
import { apply, catchSceneError, makeMiniComposition, RIFTER, scene, TFI_FLEET_SCENE } from '../staging/staging.spec-helper';
import { DEFAULT_WARP_IN_STAGGER, keepSceneArrivals, readWarpIn, toArrivalLane, toArrivalOffsets } from './arrival';

function read(value: unknown, fromRefused: string | null = null): { readonly request: ReturnType<typeof readWarpIn>; readonly problems: string[]; readonly warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  const draft = { ships: [{ id: 'enemy', position: [1000, 0, 5000] }], objects: [{ id: 'keep', position: [-2000, 0, 0] }] };
  const request = readWarpIn(value, { where: 'op.warpIn', problems, warnings, draft, fromRefused });
  return { request, problems, warnings };
}

describe('readWarpIn', () => {
  it('reads true as the defaults and false or null as none', () => {
    expect(read(true).request).toEqual({ stagger: DEFAULT_WARP_IN_STAGGER, together: true });
    expect(read(false).request).toBeNull();
    expect(read(null).request).toBeNull();
    expect(read({}).request).toEqual({ stagger: DEFAULT_WARP_IN_STAGGER, together: true });
  });

  it('reads stagger, together and from (a point, a ship or an object)', () => {
    expect(read({ stagger: 10, together: false, from: [0, 0, -1e9] }).request).toEqual({ stagger: 10, together: false, from: [0, 0, -1e9] });
    expect(read({ from: 'enemy' }).request?.from).toEqual([1000, 0, 5000]);
    expect(read({ from: 'keep' }).request?.from).toEqual([-2000, 0, 0]);
  });

  it('refuses a bad stagger, together or from, and from where it is refused', () => {
    expect(read({ stagger: 31 }).problems[0]).toMatch(/stagger/);
    expect(read({ stagger: -1 }).problems[0]).toMatch(/stagger/);
    expect(read({ together: 'yes' }).problems[0]).toMatch(/together must be true or false/);
    expect(read({ from: 'nobody' }).problems[0]).toMatch(/no ship or object "nobody"/);
    expect(read({ from: [0, 0, 0] }, 'joins land at their slots').problems[0]).toBe('op.warpIn.from: joins land at their slots');
    expect(read(5).problems[0]).toMatch(/must be true or/);
  });

  it('warns about unknown keys', () => {
    expect(read({ speed: 3 }).warnings[0]).toMatch(/speed is not a known field/);
  });
});

describe('toArrivalOffsets', () => {
  const ships = ['fc', 'a', 'b', 'c', 'd', 'e'];

  it('puts the leader first and the rest within the stagger, the same every time', () => {
    const offsets = toArrivalOffsets({ key: 'fleet', tick: 10, ships, leader: 'fc', stagger: 4 });
    expect(offsets.get('fc')).toBe(0);
    for (const id of ships.slice(1)) {
      expect(offsets.get(id)).toBeGreaterThanOrEqual(0);
      expect(offsets.get(id)).toBeLessThanOrEqual(4);
    }
    expect(new Set(offsets.values()).size).toBe(ships.length);
    expect(toArrivalOffsets({ key: 'fleet', tick: 10, ships, leader: 'fc', stagger: 4 })).toEqual(offsets);
    expect(toArrivalOffsets({ key: 'fleet', tick: 11, ships, leader: 'fc', stagger: 4 })).not.toEqual(offsets);
  });

  it('gives every ship 0 for a stagger of 0', () => {
    expect([...toArrivalOffsets({ key: 'k', tick: 0, ships, stagger: 0 }).values()]).toEqual(ships.map(() => 0));
  });
});

describe('the operations record arrivals', () => {
  it('add_fleet_composition: the fleet, its FC first, landing at the document placements along the heading', () => {
    const result = apply(scene(), { op: 'add_fleet_composition', composition: makeMiniComposition(), position: [0, 0, 0], heading: 90, warpIn: { stagger: 6 } });
    const [arrival] = result.arrivals ?? [];
    expect(arrival).toMatchObject({ group: 'mini', fleet: 'mini', leader: 'mini-fc', landing: 'document', stagger: 6, together: true });
    expect(arrival.ships).toEqual(result.scene.ships.map((ship) => ship.id));
    expect(arrival.lane[0]).toBeCloseTo(1);
    expect(arrival.lane[2]).toBeCloseTo(0);
    // The document never records arrivals.
    expect(JSON.stringify(result.scene)).not.toMatch(/warpIn|arriv/);
  });

  it('add_fleet_composition: from sets the heading, and is refused with heading or facing', () => {
    const result = apply(scene(), { op: 'add_fleet_composition', composition: makeMiniComposition(), position: [0, 0, 0], warpIn: { from: [-1e9, 0, 0] } });
    expect(result.scene.ships.find((ship) => ship.id === 'mini-fc')?.rotation[0]).toBeCloseTo(90);
    expect(result.arrivals?.[0].lane[0]).toBeCloseTo(1);
    expect(catchSceneError(() => apply(scene(), { op: 'add_fleet_composition', composition: makeMiniComposition(), position: [0, 0, 0], heading: 0, warpIn: { from: [-1e9, 0, 0] } })).problems.join('\n')).toMatch(/warpIn.from sets the heading/);
  });

  it('add_ships free and as a new fleet: the lead or FC first', () => {
    const free = apply(scene(), { op: 'add_ships', dna: RIFTER, count: 3, position: [0, 0, 0], warpIn: true });
    expect(free.arrivals).toEqual([expect.objectContaining({ group: free.scene.ships[0].id, leader: free.scene.ships[0].id, ships: free.scene.ships.map((ship) => ship.id), landing: 'document' })]);
    const fleet = apply(scene(), { op: 'add_ships', dna: RIFTER, count: 3, position: [0, 0, 0], fleet: { new: true, id: 'gang' }, warpIn: { together: false } });
    expect(fleet.arrivals?.[0]).toMatchObject({ group: 'gang', fleet: 'gang', leader: fleet.scene.fleets?.[0].commander, together: false });
  });

  it('add_ships joining a fleet: formation landings along the FC heading, from refused', () => {
    const before = scene(TFI_FLEET_SCENE);
    const squad = before.fleets?.[0].wings[0].squads[0].id;
    const fleetId = before.fleets?.[0].id ?? '';
    const joined = apply(before, { op: 'add_ships', dna: RIFTER, count: 2, fleet: { id: fleetId, squad }, warpIn: true });
    const arrival = joined.arrivals?.[0];
    expect(arrival).toMatchObject({ fleet: fleetId, leader: before.fleets?.[0].commander, landing: 'formation' });
    expect(arrival?.ships).toHaveLength(2);
    expect(arrival?.ships.includes(arrival.leader ?? '')).toBe(false);
    expect(catchSceneError(() => apply(before, { op: 'add_ships', dna: RIFTER, fleet: { id: fleetId, squad }, warpIn: { from: [0, 0, 0] } })).problems.join('\n')).toMatch(/warpIn.from: ships joining a fleet/);
  });

  it('stage_engagement: each side its own, along its heading; from refused', () => {
    const result = apply(scene(), { op: 'stage_engagement', sides: [{ composition: makeMiniComposition(), warpIn: true }, { composition: makeMiniComposition() }], center: [0, 0, 0] });
    expect(result.arrivals?.map((arrival) => arrival.fleet)).toEqual(['mini']);
    expect(result.arrivals?.[0].lane[2]).toBeCloseTo(1);
    const b = apply(scene(), { op: 'stage_engagement', sides: [{ composition: makeMiniComposition() }, { composition: makeMiniComposition(), warpIn: true }], center: [0, 0, 0] });
    expect(b.arrivals?.[0].lane[2]).toBeCloseTo(-1);
    expect(catchSceneError(() => apply(scene(), { op: 'stage_engagement', sides: [{ composition: makeMiniComposition(), warpIn: { from: [0, 0, 0] } }, { composition: makeMiniComposition() }] })).problems.join('\n')).toMatch(/an engagement side flies in along its heading/);
  });

  it('add_ship: the ship along its rotation yaw', () => {
    const result = apply(scene(), { op: 'add_ship', ship: { id: 'solo', dna: RIFTER, position: [0, 0, 0], rotation: [180, 0, 0] }, warpIn: true });
    expect(result.arrivals).toEqual([expect.objectContaining({ group: 'solo', ships: ['solo'], landing: 'document' })]);
    expect(result.arrivals?.[0].lane[2]).toBeCloseTo(-1);
    expect(catchSceneError(() => apply(scene(), { op: 'add_ship', ship: { id: 'solo', dna: RIFTER }, warpIn: { from: [0, 0, 0] } })).problems.join('\n')).toMatch(/add_ship lands along its rotation/);
  });

  it('drops ships a later operation removed, and a result without arrivals has none', () => {
    const result = apply(scene(), { op: 'add_ship', ship: { id: 'solo', dna: RIFTER }, warpIn: true }, { op: 'remove_ship', id: 'solo' }, { op: 'rename', name: 'x' });
    expect(result.arrivals).toBeUndefined();
    expect(apply(scene(), { op: 'add_ships', dna: RIFTER, count: 2, position: [0, 0, 0] }).arrivals).toBeUndefined();
  });

  it('keepSceneArrivals re-picks a removed lead', () => {
    const kept = keepSceneArrivals([{ where: 'w', group: 'g', leader: 'a', ships: ['a', 'b', 'c'], lane: toArrivalLane(0), landing: 'document', stagger: 4, together: true }], new Set(['b', 'c']));
    expect(kept).toEqual([expect.objectContaining({ ships: ['b', 'c'], leader: 'b' })]);
  });
});
