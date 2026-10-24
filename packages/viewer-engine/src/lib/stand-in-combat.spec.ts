import { STAND_IN_GUN_TYPE_ID, standInCombatOf } from '@scene-director/scene';
import { describe, expect, it } from 'vitest';
import { IsFitResolved, ShipFitReportOf, type ResolvedShipFitting } from './fittings';
import { ShipClassOf } from './flight';
import type { ShipModuleEvent } from './modules';
import { WeaponShotsOf } from './shots';
import { StandInFittingOf, StandInHullOf, StandInModuleSpecsOf } from './stand-in-combat';

const NOTE = 'no EVE data (the hub runs with --eve-data off)';
const PROP = { name: '50MN Microwarpdrive II', typeID: 12_076 };

describe('StandInFittingOf', () => {
  it('fits its class guns as high-0 and up, and the prop mod as mid-0', () => {
    const fitting = StandInFittingOf({ doc: {}, combat: standInCombatOf('cruiser'), propMod: PROP, note: NOTE });
    expect(fitting).toMatchObject({ key: 'stand-in', dogma: null, pending: false, typeIDs: [], text: '' });
    expect(fitting.standIn?.shipClass).toBe('cruiser');
    expect(fitting.fitting).toMatchObject({ hull: 'Cruiser stand-in', name: 'Stand-in weapons' });
    expect(fitting.modules.map((module) => [module.key, module.name, module.weapon ?? null, module.prop ?? null])).toEqual([
      ['high-0', 'Stand-in cruiser gun', 'turret', null],
      ['high-1', 'Stand-in cruiser gun', 'turret', null],
      ['high-2', 'Stand-in cruiser gun', 'turret', null],
      ['high-3', 'Stand-in cruiser gun', 'turret', null],
      ['mid-0', '50MN Microwarpdrive II', null, true]
    ]);
    expect(fitting.note).toBe(`${NOTE}: stand-in guns for its class (cruiser)`);
  });

  it('fits no prop row for "none", and names a fitted ship\'s own fit in the note', () => {
    const fitting = StandInFittingOf({ doc: { fit: 'brawler' }, combat: standInCombatOf('frigate'), propMod: null, note: NOTE });
    expect(fitting.modules.map((module) => module.key)).toEqual(['high-0', 'high-1', 'high-2']);
    expect(fitting.note).toBe(`${NOTE}: stand-in guns for its class (frigate); its fit "brawler" needs the EVE data`);
    expect(StandInFittingOf({ doc: { fit: '[Rifter, x]\nDamage Control II' }, combat: standInCombatOf('frigate'), propMod: null, note: NOTE }).note).toContain('its fit "inline" needs the EVE data');
  });

  it('reports math stand-in, with no type id and no default flag', () => {
    const fitting = StandInFittingOf({ doc: {}, combat: standInCombatOf('cruiser'), propMod: PROP, note: NOTE });
    const report = ShipFitReportOf(fitting, () => ({ state: 'online' }));
    expect(report).toMatchObject({ key: 'stand-in', name: 'Stand-in weapons', hull: 'Cruiser stand-in', math: 'stand-in', note: fitting.note });
    expect(report).not.toHaveProperty('default');
    expect(report).not.toHaveProperty('typeID');
    expect(report.modules.at(-1)).toMatchObject({ module: 'mid-0', prop: true });
  });
});

describe('StandInModuleSpecsOf', () => {
  it('gives one turret spec per gun and none for the prop mod', () => {
    const combat = standInCombatOf('battleship');
    const specs = StandInModuleSpecsOf(StandInFittingOf({ doc: {}, combat, propMod: PROP, note: NOTE }));
    expect(specs).toHaveLength(7);
    expect(specs[6]).toMatchObject({ key: 'high-6', name: 'Stand-in battleship gun', typeID: STAND_IN_GUN_TYPE_ID, offline: false, activation: { key: 'high-6', weapon: 'turret', targeted: true, cycleTime: 4.5 }, combat: { key: 'high-6', volley: 330, optimal: 8000 } });
  });

  it('gives none for a fitting without standIn', () => {
    const fitting = StandInFittingOf({ doc: {}, combat: standInCombatOf('cruiser'), propMod: null, note: NOTE });
    const { standIn: _standIn, ...plain } = fitting;
    expect(StandInModuleSpecsOf(plain)).toEqual([]);
  });

  it('raises shots named for the stand-in gun from its cycles', () => {
    const fitting = StandInFittingOf({ doc: {}, combat: standInCombatOf('cruiser'), propMod: null, note: NOTE });
    const event: ShipModuleEvent = { kind: 'cycle', tick: 12, cycle: 1, activation: 1, ship: 'h1', module: 'high-1', cycleTime: 3, target: 'prey', effectiveness: 1, at: 12 };
    const shots = WeaponShotsOf([event], {
      Turret: (_ship, key) => {
        const module = fitting.modules.find((candidate) => candidate.key === key && candidate.weapon === 'turret' && candidate.typeID != null);
        return module?.typeID == null ? null : { typeID: module.typeID, name: module.name };
      },
      KindOf: () => 'ship',
      SurfaceDistance: () => 2000
    });
    expect(shots).toEqual([expect.objectContaining({ ship: 'h1', module: 'high-1', typeID: STAND_IN_GUN_TYPE_ID, name: 'Stand-in cruiser gun', target: 'prey', distance: 2000 })]);
  });
});

describe('StandInHullOf', () => {
  it("carries the document's class, which ShipClassOf takes first", () => {
    expect(StandInHullOf({ standIn: { class: 'frigate' } })).toEqual({ category: null, radius: null, shipClass: 'frigate' });
    expect(StandInHullOf({})).toBeNull();
    expect(ShipClassOf(StandInHullOf({ standIn: { class: 'titan' } }))).toBe('titan');
    expect(ShipClassOf({ category: 'battleship', radius: 10, shipClass: 'frigate' })).toBe('frigate');
    expect(ShipClassOf(StandInHullOf({}))).toBe('cruiser');
  });
});

describe('IsFitResolved', () => {
  it('takes dogma or a stand-in fitting', () => {
    const fitting = StandInFittingOf({ doc: {}, combat: standInCombatOf('cruiser'), propMod: null, note: NOTE });
    const { standIn: _standIn, ...pending } = fitting;
    expect(IsFitResolved(fitting)).toBe(true);
    expect(IsFitResolved(pending as ResolvedShipFitting)).toBe(false);
    expect(IsFitResolved(null)).toBe(false);
  });
});
