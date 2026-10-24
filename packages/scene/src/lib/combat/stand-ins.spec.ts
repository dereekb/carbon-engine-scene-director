import { describe, expect, it } from 'vitest';
import { catchSceneError } from '../fleets/fleets.spec-helper';
import { applySceneOperations, diffScenes, normalizeScene } from '../scene';
import { SHIP_CLASSES, type ShipClass } from '../stats/ship-classes';
import { applyLayeredDamage, type DamageLayers } from './damage';
import { normalizeShipStandIn, sameStandIn, STAND_IN_CLASS_COMBAT, STAND_IN_GUN_TYPE_ID, STAND_IN_SIGNATURE_RESOLUTION, standInActivationOf, standInCombatOf, standInTurretNumbersOf } from './stand-ins';

const DNA = 'wreck_s:genericbase:generic';

describe('STAND_IN_CLASS_COMBAT', () => {
  it('has every class, with positive finite numbers', () => {
    expect(Object.keys(STAND_IN_CLASS_COMBAT).sort()).toEqual([...SHIP_CLASSES].sort());
    for (const shipClass of SHIP_CLASSES) {
      const numbers = STAND_IN_CLASS_COMBAT[shipClass];
      const values = [numbers.guns, numbers.volley, numbers.cycleTime, numbers.optimal, numbers.falloff, numbers.tracking, numbers.shieldRecharge, ...Object.values(numbers.hp), ...Object.values(numbers.targeting)];
      for (const value of values) expect(Number.isFinite(value) && value > 0, shipClass).toBe(true);
    }
  });

  it('grows EHP and paper DPS from frigate to titan, and locks beyond optimal + falloff', () => {
    let previous: ReturnType<typeof standInCombatOf> | null = null;
    for (const shipClass of SHIP_CLASSES) {
      const combat = standInCombatOf(shipClass);
      if (previous) {
        expect(combat.defense.ehp, shipClass).toBeGreaterThanOrEqual(previous.defense.ehp);
        expect(combat.gun.dps * combat.guns, shipClass).toBeGreaterThanOrEqual(previous.gun.dps * previous.guns);
      }
      expect(combat.targeting.maxTargetRange, shipClass).toBeGreaterThan(combat.gun.optimal + combat.gun.falloff);
      previous = combat;
    }
  });
});

describe('standInCombatOf', () => {
  it('builds layers on the base T1 resonances, resists in percent, and layer and total EHP', () => {
    const { defense, targeting, shipClass } = standInCombatOf('cruiser');
    expect(shipClass).toBe('cruiser');
    expect(defense.shield.hp).toBe(2000);
    expect(defense.shield.resonances).toEqual({ em: 1, thermal: 0.8, kinetic: 0.6, explosive: 0.5 });
    expect(defense.shield.resists).toEqual({ em: 0, thermal: 20, kinetic: 40, explosive: 50 });
    expect(defense.armor.resists).toEqual({ em: 50, thermal: 35, kinetic: 25, explosive: 10 });
    expect(defense.structure.resists).toEqual({ em: 33, thermal: 33, kinetic: 33, explosive: 33 });
    expect(defense.shield.ehp).toBeCloseTo(2000 / 0.725, 6);
    expect(defense.ehp).toBeCloseTo(defense.shield.ehp + defense.armor.ehp + defense.structure.ehp, 6);
    expect(defense.shieldRecharge).toBe(1000);
    expect(targeting).toEqual({ maxTargetRange: 60_000, scanResolution: 350, maxLockedTargets: 6 });
  });

  it('gives turret numbers: half thermal, half kinetic, dps = volley / cycle, no charge or note', () => {
    const combat = standInCombatOf('cruiser');
    const gun = standInTurretNumbersOf(combat, 2);
    expect(gun).toEqual({
      key: 'high-2',
      typeID: STAND_IN_GUN_TYPE_ID,
      name: 'Stand-in cruiser gun',
      kind: 'tracking',
      damage: { em: 0, thermal: 55, kinetic: 55, explosive: 0 },
      volley: 110,
      cycleTime: 3,
      dps: 110 / 3,
      optimal: 4000,
      falloff: 8000,
      tracking: 60,
      signatureResolution: STAND_IN_SIGNATURE_RESOLUTION
    });
  });

  it('gives a targeted turret activation with no capacitor, delay or effect', () => {
    const activation = standInActivationOf(standInCombatOf('frigate'), 'high-0');
    expect(activation).toMatchObject({ key: 'high-0', category: 'weapon', weapon: 'turret', targeted: true, reach: Number.POSITIVE_INFINITY, cycleTime: 2, capacitorNeed: 0, reactivationDelay: 0, range: 1500, falloff: 5000, repair: null, refusal: null, warpSafe: false, flight: false, groupID: 0 });
    expect(activation).not.toHaveProperty('effectGuid');
    expect(activation).not.toHaveProperty('note');
  });

  it('kills its own class at rest within optimal in 15-120 s (frigate through battleship)', () => {
    const killSeconds = (shipClass: ShipClass): number => {
      const combat = standInCombatOf(shipClass);
      let layers: DamageLayers = { shield: { hp: combat.defense.shield.hp, resonances: combat.defense.shield.resonances }, armor: { hp: combat.defense.armor.hp, resonances: combat.defense.armor.resonances }, structure: { hp: combat.defense.structure.hp, resonances: combat.defense.structure.resonances } };
      let volleys = 0;
      while (layers.structure.hp > 0 && volleys < 10_000) {
        for (let gun = 0; gun < combat.guns && layers.structure.hp > 0; gun += 1) layers = applyLayeredDamage(layers, combat.gun.damage).layers;
        volleys += 1;
      }
      return (volleys - 1) * combat.gun.cycleTime;
    };
    for (const shipClass of ['frigate', 'destroyer', 'cruiser', 'battlecruiser', 'battleship'] as const) {
      const seconds = killSeconds(shipClass);
      expect(seconds, shipClass).toBeGreaterThanOrEqual(15);
      expect(seconds, shipClass).toBeLessThanOrEqual(120);
    }
  });
});

describe('normalizeShipStandIn', () => {
  const read = (input: unknown) => normalizeShipStandIn({ input, where: 'ships[0].standIn' });

  it('reads a class', () => {
    expect(read({ class: 'Frigate' })).toEqual({ standIn: { class: 'frigate' }, problems: [], warnings: [] });
  });

  it('reports an unknown class with the classes', () => {
    expect(read({ class: 'corvette' }).problems).toEqual(['ships[0].standIn.class must be one of frigate, destroyer, cruiser, battlecruiser, battleship, capital, titan']);
  });

  it('warns and drops unknown keys', () => {
    expect(read({ class: 'titan', hp: 5 })).toEqual({ standIn: { class: 'titan' }, problems: [], warnings: ['ships[0].standIn.hp is not a known field and was dropped'] });
  });

  it('treats null and {} as absent, and refuses a non-object', () => {
    expect(read(null).standIn).toBeNull();
    expect(read({}).standIn).toBeNull();
    expect(read(undefined).standIn).toBeNull();
    expect(read('frigate').problems).toEqual(['ships[0].standIn must be an object { class? }']);
  });

  it('compares by class', () => {
    expect(sameStandIn(null, {})).toBe(true);
    expect(sameStandIn({ class: 'frigate' }, { class: 'frigate' })).toBe(true);
    expect(sameStandIn({ class: 'frigate' }, null)).toBe(false);
  });
});

describe('ships[].standIn in the document', () => {
  const scene = normalizeScene({
    ships: [
      { id: 'a', dna: DNA, standIn: { class: 'frigate' } },
      { id: 'b', dna: DNA, position: [3000, 0, 0] }
    ]
  }).scene;

  it('round-trips through normalizeScene', () => {
    expect(scene.ships[0].standIn).toEqual({ class: 'frigate' });
    expect(scene.ships[1]).not.toHaveProperty('standIn');
    expect(normalizeScene(scene).scene.ships[0].standIn).toEqual({ class: 'frigate' });
    expect(catchSceneError(() => normalizeScene({ ships: [{ id: 'a', dna: DNA, standIn: { class: 'corvette' } }] })).problems[0]).toMatch(/^ships\[0\]\.standIn\.class must be one of/u);
  });

  it('update_ship sets and clears it with null', () => {
    const cleared = applySceneOperations(scene, [{ op: 'update_ship', id: 'a', set: { standIn: null } }]).scene;
    expect(cleared.ships[0]).not.toHaveProperty('standIn');
    const set = applySceneOperations(scene, [{ op: 'update_ship', id: 'b', set: { standIn: { class: 'battleship' } } }]).scene;
    expect(set.ships[1].standIn).toEqual({ class: 'battleship' });
  });

  it('a class change retunes the ship', () => {
    const after = applySceneOperations(scene, [{ op: 'update_ship', id: 'a', set: { standIn: { class: 'destroyer' } } }]).scene;
    const diff = diffScenes(scene, after);
    expect(diff.retuned.map((ship) => ship.id)).toEqual(['a']);
    expect(diff.rebuilt).toEqual([]);
  });
});
