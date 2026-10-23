import { describe, expect, it } from 'vitest';
import { applySceneOperations, normalizeScene, type SceneDocument } from '../scene';
import { normalizeShipOrderRequest } from '../orders';
import { normalizeFleetOrderRequest, resolveFleetOrderRequest } from '../fleets/orders';
import { toLiveFleetScene } from '../fleets/live';
import { catchSceneError, TFI_FLEET_SCENE } from '../fleets/fleets.spec-helper';
import { normalizeShipOrderSteps, shipStepCompletion } from '../timeline/steps';
import { TIMELINE_ACTIONS } from '../timeline/actions';
import { DEFAULT_DISENGAGE, type ShipStance } from './stance';
import { readSceneStance, resolveShipStances } from './stances';

type Stances = { readonly fleet?: object; readonly wing?: object; readonly dps?: object; readonly logi?: object; readonly ships?: Readonly<Record<string, object>> };

/**
 * The TFI fleet with stances on its levels.
 */
function stanceScene(stances: Stances): SceneDocument {
  const input = structuredClone(TFI_FLEET_SCENE) as unknown as { ships: Record<string, unknown>[]; fleets: Record<string, unknown>[] };
  const fleet = input.fleets[0] as { stance?: object; wings: { stance?: object; squads: { id: string; stance?: object }[] }[] };
  if (stances.fleet) fleet.stance = stances.fleet;
  if (stances.wing) fleet.wings[0].stance = stances.wing;
  for (const squad of fleet.wings[0].squads) {
    const stance = squad.id === 'dps' ? stances.dps : stances.logi;
    if (stance) squad.stance = stance;
  }
  for (const ship of input.ships) {
    const stance = stances.ships?.[ship['id'] as string];
    if (stance) ship['stance'] = stance;
  }
  return normalizeScene(input).scene;
}

describe('readSceneStance', () => {
  it('reads every key, warns on unknown ones and drops a formation on a ship', () => {
    const problems: string[] = [];
    const warnings: string[] = [];
    const stance = readSceneStance({ type: 'kite', on: { squad: 'dps' }, range: [20000, 30000], propMods: 'closing', formation: 'loose', disengage: 0.4, colour: 'red' }, { where: 'x', problems, warnings });
    expect(stance).toEqual({ type: 'kite', on: { squad: 'dps' }, range: [20000, 30000], propMods: 'closing', formation: 'loose', disengage: 0.4 });
    expect(problems).toEqual([]);
    expect(warnings).toEqual([expect.stringContaining('colour')]);
    const ship = readSceneStance({ type: 'brawl', formation: 'loose' }, { where: 'y', problems, warnings, level: 'ship' });
    expect(ship).toEqual({ type: 'brawl' });
    expect(warnings[1]).toContain('y.formation is dropped');
  });

  it('refuses bad values and reads an empty stance as none', () => {
    const problems: string[] = [];
    readSceneStance({ type: 'charge', on: 7, range: [5, 1], propMods: 'sometimes', formation: 'scattered', disengage: 1 }, { where: 's', problems, warnings: [] });
    expect(problems.map((problem) => problem.split(' ')[0])).toEqual(['s.type', 's.propMods', 's.formation', 's.on', 's.range', 's.disengage']);
    expect(readSceneStance({}, { where: 's', problems: [], warnings: [] })).toBeNull();
    expect(readSceneStance([1], { where: 's', problems, warnings: [] })).toBeNull();
    expect(problems.at(-1)).toContain('s must be an object');
  });
});

describe('stances in the document', () => {
  it('keeps a stance on a fleet, wing, squad and ship', () => {
    const scene = stanceScene({ fleet: { type: 'kite' }, wing: { propMods: 'never' }, logi: { type: 'orbit', on: { squad: 'dps' }, range: [20000, 30000] }, ships: { 'tfi-2': { type: 'brawl' } } });
    const fleet = scene.fleets?.[0];
    expect(fleet?.stance).toEqual({ type: 'kite' });
    expect(fleet?.wings[0].stance).toEqual({ propMods: 'never' });
    expect(fleet?.wings[0].squads[1].stance).toEqual({ type: 'orbit', on: { squad: 'dps' }, range: [20000, 30000] });
    expect(scene.ships.find((ship) => ship.id === 'tfi-2')?.stance).toEqual({ type: 'brawl' });
  });

  it('refuses an on that names no ship, or a squad the fleet does not hold; a ship in no fleet warns', () => {
    const error = catchSceneError(() => stanceScene({ fleet: { type: 'orbit', on: 'nobody' }, dps: { on: { squad: 'tackle' } } }));
    expect(error.problems).toEqual([expect.stringContaining('fleets[0].stance.on "nobody" is not a ship id'), expect.stringContaining('fleet "tfi" has no squad "tackle"')]);
    const self = catchSceneError(() => stanceScene({ ships: { 'tfi-1': { type: 'orbit', on: 'tfi-1' } } }));
    expect(self.problems).toEqual([expect.stringContaining('a ship cannot fly a stance on itself')]);
    const loose = normalizeScene({ ships: [{ id: 'a', dna: 'mb2_t1:minmatarnavy:minmatar', stance: { type: 'orbit', on: { squad: 'dps' } } }] });
    expect(loose.warnings).toEqual([expect.stringContaining('the ship is in no fleet, so it has no squad "dps"; it flies on its focus')]);
  });

  it('sets and clears a stance with update_fleet, update_squad and update_ship', () => {
    const scene = stanceScene({});
    const set = applySceneOperations(scene, [
      { op: 'update_fleet', fleet: 'tfi', set: { stance: { type: 'kite', range: 'ideal' } } },
      { op: 'update_squad', fleet: 'tfi', squad: 'logi', set: { stance: { type: 'support' } } },
      { op: 'update_ship', id: 'tfi-3', set: { stance: { type: 'tackle', range: 'point' } } }
    ]).scene;
    expect(set.fleets?.[0].stance).toEqual({ type: 'kite', range: 'ideal' });
    expect(set.fleets?.[0].wings[0].squads[1].stance).toEqual({ type: 'support' });
    expect(set.ships.find((ship) => ship.id === 'tfi-3')?.stance).toEqual({ type: 'tackle', range: 'point' });
    const cleared = applySceneOperations(set, [
      { op: 'update_fleet', fleet: 'tfi', set: { stance: null } },
      { op: 'update_ship', id: 'tfi-3', set: { stance: null } }
    ]).scene;
    expect(cleared.fleets?.[0].stance).toBeUndefined();
    expect(cleared.ships.find((ship) => ship.id === 'tfi-3')?.stance).toBeUndefined();
  });

  it('falls an on back to the focus when its ship or squad is removed', () => {
    const scene = stanceScene({ fleet: { type: 'orbit', on: 'guardian-2', range: 5000 }, logi: { type: 'orbit', on: { squad: 'dps' } }, ships: { 'tfi-1': { type: 'keep-at-range', on: { squad: 'dps' } } } });
    const removedShip = applySceneOperations(scene, [{ op: 'remove_ship', id: 'guardian-2' }]);
    expect(removedShip.scene.fleets?.[0].stance).toEqual({ type: 'orbit', range: 5000 });
    expect(removedShip.warnings).toContain(`fleet "tfi"'s stance now flies on its focus (its on ship "guardian-2" was removed)`);
    const removedSquad = applySceneOperations(scene, [{ op: 'remove_squad', fleet: 'tfi', squad: 'dps' }]);
    expect(removedSquad.scene.fleets?.[0].wings[0].squads[0].stance).toEqual({ type: 'orbit' });
    expect(removedSquad.scene.ships.find((ship) => ship.id === 'tfi-1')?.stance).toEqual({ type: 'keep-at-range' });
    expect(removedSquad.warnings).toEqual(expect.arrayContaining([expect.stringContaining(`squad "logi"'s stance now flies on its focus (its on squad "dps" was removed)`), expect.stringContaining(`ship "tfi-1"'s stance now flies on its focus`)]));
  });
});

describe('resolveShipStances', () => {
  it('leaves every ship in line without a stance anywhere', () => {
    const resolved = resolveShipStances(stanceScene({}));
    for (const stance of resolved.values()) {
      expect(stance).toMatchObject({ type: 'in-line', flownBy: null, on: 'focus', range: 'ideal', propMods: 'auto', formation: 'in-line', disengage: DEFAULT_DISENGAGE });
      expect(stance.sources).toEqual({ type: 'default', propMods: 'default', formation: 'default', disengage: 'default' });
      expect(stance.pilot).toBeUndefined();
    }
  });

  it('flies a fleet stance in line on the FC: the members hold formation on it', () => {
    const resolved = resolveShipStances(stanceScene({ fleet: { type: 'kite', range: 'ideal', disengage: 0.5 } }));
    expect(resolved.get('fc')).toMatchObject({ type: 'kite', flownBy: 'fc', group: { kind: 'fleet', id: 'tfi' }, pilot: { type: 'kite', on: null, range: 'ideal', propMods: 'auto', disengage: 0.5 } });
    expect(resolved.get('tfi-2')).toMatchObject({ type: 'kite', flownBy: 'fc', sources: { type: 'fleet', disengage: 'fleet' } });
    expect(resolved.get('tfi-2')?.pilot).toBeUndefined();
  });

  it('takes type, on and range together from the nearest level that sets type; the rest key by key', () => {
    const resolved = resolveShipStances(stanceScene({ fleet: { type: 'kite', range: 40000, propMods: 'always', formation: 'loose' }, wing: { propMods: 'never', range: 1000 }, dps: { type: 'brawl', disengage: 0.2 }, ships: { 'tfi-1': { propMods: 'closing' } } }));
    expect(resolved.get('tfi-1')).toMatchObject({ type: 'brawl', range: 'ideal', propMods: 'closing', formation: 'loose', disengage: 0.2, flownBy: 'tfi-1' });
    expect(resolved.get('tfi-1')?.sources).toEqual({ type: 'squad', propMods: 'ship', formation: 'fleet', disengage: 'squad' });
    expect(resolved.get('guardian-1')).toMatchObject({ type: 'kite', range: 40000, propMods: 'never', flownBy: 'guardian-1', sources: { type: 'fleet', propMods: 'wing' } });
    // The FC skips its wing's and squads' stances, as it takes only its fleet's call.
    expect(resolved.get('fc')).toMatchObject({ type: 'kite', propMods: 'always', sources: { propMods: 'fleet' } });
  });

  it('flies a squad stance in line on the squad leader, and a ship stance on the ship alone', () => {
    const resolved = resolveShipStances(stanceScene({ dps: { type: 'orbit', on: 'guardian-2', range: [5000, 8000] }, ships: { 'tfi-3': { type: 'snipe' } } }));
    expect(resolved.get('tfi-1')).toMatchObject({ flownBy: 'tfi-1', group: { kind: 'squad', id: 'dps' }, pilot: { type: 'orbit', on: 'guardian-2', range: [5000, 8000] } });
    expect(resolved.get('tfi-2')).toMatchObject({ type: 'orbit', flownBy: 'tfi-1' });
    expect(resolved.get('tfi-3')).toMatchObject({ type: 'snipe', flownBy: 'tfi-3', sources: { type: 'ship' } });
    expect(resolved.get('tfi-3')?.group).toBeUndefined();
    expect(resolved.get('fc')?.type).toBe('in-line');
  });

  it('gives loose members with no type their role default and resolves an on squad to its leader', () => {
    const resolved = resolveShipStances(stanceScene({ fleet: { formation: 'loose' }, logi: { type: 'orbit', on: { squad: 'dps' }, range: [20000, 30000] } }));
    expect(resolved.get('tfi-2')).toMatchObject({ type: 'auto', flownBy: 'tfi-2', sources: { type: 'role', formation: 'fleet' } });
    expect(resolved.get('fc')).toMatchObject({ type: 'auto', flownBy: 'fc' });
    expect(resolved.get('guardian-2')).toMatchObject({ type: 'orbit', flownBy: 'guardian-2', pilot: { on: 'tfi-1', range: [20000, 30000] } });
    const roles = resolveShipStances(stanceScene({ fleet: { formation: 'loose' } }));
    expect(roles.get('guardian-1')?.type).toBe('support');
  });

  it('splices the stance book over the document: group stances through the overlay, ship stances by id', () => {
    const scene = stanceScene({ fleet: { type: 'kite' }, ships: { 'tfi-3': { type: 'brawl' } } });
    const stances = new Map<string, ShipStance | null>([
      ['tfi', null],
      ['tfi/squad/logi', { type: 'support', formation: 'loose' }]
    ]);
    const live = toLiveFleetScene(scene, new Set(), { stances }).scene;
    expect(live.fleets?.[0].stance).toBeUndefined();
    expect(scene.fleets?.[0].stance).toEqual({ type: 'kite' });
    const resolved = resolveShipStances(live, { ships: new Map([['tfi-3', null]]) });
    expect(resolved.get('fc')?.type).toBe('in-line');
    expect(resolved.get('tfi-3')?.type).toBe('in-line');
    expect(resolved.get('guardian-2')).toMatchObject({ type: 'support', flownBy: 'guardian-2' });
  });
});

describe('stance orders', () => {
  const ships = new Set(TFI_FLEET_SCENE.ships.map((ship) => ship.id));

  it('reads order_fleet set and clear, and refuses neither, both, or an empty set', () => {
    expect(normalizeFleetOrderRequest({ fleet: 'tfi', squad: 'logi', order: { type: 'stance', set: { type: 'orbit', on: { squad: 'dps' }, range: [20000, 30000] } } }, { ships }).order).toEqual({ type: 'stance', set: { type: 'orbit', on: { squad: 'dps' }, range: [20000, 30000] } });
    expect(normalizeFleetOrderRequest({ fleet: 'tfi', order: { type: 'stance', clear: true } }).order).toEqual({ type: 'stance', clear: true });
    expect(catchSceneError(() => normalizeFleetOrderRequest({ fleet: 'tfi', order: { type: 'stance' } })).problems).toEqual([expect.stringContaining('needs exactly one of set')]);
    expect(catchSceneError(() => normalizeFleetOrderRequest({ fleet: 'tfi', order: { type: 'stance', set: { type: 'kite' }, clear: true } })).problems).toEqual([expect.stringContaining('needs exactly one of set')]);
    expect(catchSceneError(() => normalizeFleetOrderRequest({ fleet: 'tfi', order: { type: 'stance', set: {} } })).problems).toEqual([expect.stringContaining('set needs at least one of')]);
    expect(catchSceneError(() => normalizeFleetOrderRequest({ fleet: 'tfi', order: { type: 'stance', set: { type: 'kite', colour: 1 } } })).problems).toEqual([expect.stringContaining('colour')]);
    expect(catchSceneError(() => normalizeFleetOrderRequest({ fleet: 'tfi', order: { type: 'stance', set: { on: 'ghost' } } }, { ships })).problems).toEqual(['order_fleet.order.set.on: no ship "ghost"']);
  });

  it('takes the targets order authority, and refuses an on squad the fleet does not hold', () => {
    const scene = stanceScene({});
    const resolved = resolveFleetOrderRequest(scene, normalizeFleetOrderRequest({ fleet: 'tfi', squad: 'logi', order: { type: 'stance', set: { type: 'support' } } }));
    expect(resolved).toMatchObject({ issuer: 'guardian-1', leader: 'guardian-1', ships: ['guardian-1', 'guardian-2'] });
    expect(catchSceneError(() => resolveFleetOrderRequest(scene, normalizeFleetOrderRequest({ fleet: 'tfi', squad: 'logi', by: 'tfi-1', order: { type: 'stance', clear: true } }))).problems[0]).toContain('has no command over');
    expect(catchSceneError(() => resolveFleetOrderRequest(scene, normalizeFleetOrderRequest({ fleet: 'tfi', order: { type: 'stance', set: { on: { wing: 'wing-9' } } } }))).problems).toEqual(['order_fleet.order.set.on: fleet "tfi" has no wing "wing-9"']);
  });

  it("reads order_ship's stance for one pilot: no formation, never on itself", () => {
    expect(normalizeShipOrderRequest({ type: 'stance', set: { type: 'brawl', propMods: 'never' } }, { self: 'tfi-1' })).toEqual({ type: 'stance', set: { type: 'brawl', propMods: 'never' } });
    expect(catchSceneError(() => normalizeShipOrderRequest({ type: 'stance', set: { type: 'brawl', formation: 'loose' } }, { self: 'tfi-1' })).problems).toEqual([expect.stringContaining('order.set.formation is dropped')]);
    expect(catchSceneError(() => normalizeShipOrderRequest({ type: 'stance', set: { on: 'tfi-1' } }, { self: 'tfi-1' })).problems).toEqual(['order.set.on: a ship cannot fly a stance on itself']);
  });

  it('cues a stance order as a live action naming its on, and a ship step sets a stance at once', () => {
    const entry = TIMELINE_ACTIONS.order_fleet;
    const args = entry.read({ fleet: 'tfi', squad: 'logi', order: { type: 'stance', set: { type: 'orbit', on: { squad: 'dps' } } } }, 'cue').args;
    expect(args && entry.kind(args)).toBe('live');
    expect(args && entry.references(args)).toEqual(expect.arrayContaining([{ kind: 'squad', id: 'dps', fleet: 'tfi', path: 'order.set.on.squad' }]));
    const shipArgs = TIMELINE_ACTIONS.order_ship.read({ id: 'tfi-1', order: { type: 'stance', set: { type: 'orbit', on: 'guardian-1' } } }, 'cue').args;
    expect(shipArgs && TIMELINE_ACTIONS.order_ship.references(shipArgs)).toEqual(expect.arrayContaining([{ kind: 'ship', id: 'guardian-1', path: 'order.set.on' }]));
    expect(shipStepCompletion('stance')).toBe('given');
    const steps = normalizeShipOrderSteps({ input: [{ type: 'stance', set: { type: 'kite' } }, { after: 30, type: 'stance', clear: true }], where: 'ships[1].orders', self: 'tfi-1', targets: ships, inFleet: true });
    expect(steps.problems).toEqual([]);
    expect(steps.steps).toEqual([{ type: 'stance', set: { type: 'kite' } }, { after: 30, type: 'stance', clear: true }]);
  });
});
