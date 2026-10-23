import { describe, expect, it } from 'vitest';
import { DOGMA_FIXTURE, fixtureAnswer, fixtureTypeID } from '../fitting/fitting.spec-helper';
import { DEFAULT_MISSILE_DAMAGE_TYPE, DEFAULT_MISSILES, defaultMissileOf, isMissileCharge, missileDamageTypeOf } from './default-missiles';

const record = (name: string) => DOGMA_FIXTURE.types[fixtureTypeID(name)];

describe('DEFAULT_MISSILES', () => {
  it('names T1 missiles the SDE knows by their exact names and ids, in their group, doing their damage type', () => {
    const damageAttribute = { em: 114, explosive: 116, kinetic: 117, thermal: 118 } as const;
    for (const [group, missiles] of Object.entries(DEFAULT_MISSILES)) {
      for (const [type, missile] of Object.entries(missiles)) {
        expect(fixtureAnswer(missile.name)?.typeID, missile.name).toBe(missile.typeID);
        const charge = DOGMA_FIXTURE.types[missile.typeID];
        expect(charge.groupID, missile.name).toBe(Number(group));
        expect(charge.attributes[damageAttribute[type as keyof typeof damageAttribute]], missile.name).toBeGreaterThan(0);
        expect(isMissileCharge(charge), missile.name).toBe(true);
      }
    }
  });
});

describe('missileDamageTypeOf', () => {
  it('picks by SDE race, then SOF race, else kinetic', () => {
    expect([1, 2, 4, 8].map((race) => missileDamageTypeOf(race))).toEqual(['kinetic', 'explosive', 'em', 'thermal']);
    expect(missileDamageTypeOf(135, 'Sansha')).toBe('em');
    expect(missileDamageTypeOf(null, 'angel')).toBe('explosive');
    expect(missileDamageTypeOf(null, 'guristas')).toBe('kinetic');
    expect(missileDamageTypeOf(null, 'serpentis')).toBe('thermal');
    expect(missileDamageTypeOf(null, 'jove')).toBe(DEFAULT_MISSILE_DAMAGE_TYPE);
    expect(missileDamageTypeOf(null)).toBe('kinetic');
  });
});

describe('defaultMissileOf', () => {
  it("picks the launcher's first charge group with a default, at the damage type", () => {
    expect(defaultMissileOf(record('Heavy Missile Launcher II'), 'kinetic')?.name).toBe('Scourge Heavy Missile');
    expect(defaultMissileOf(record('Light Missile Launcher II'), 'explosive')?.name).toBe('Nova Light Missile');
    expect(defaultMissileOf(record('Rapid Light Missile Launcher II'), 'em')?.name).toBe('Mjolnir Light Missile');
    expect(defaultMissileOf(record('Cruise Missile Launcher II'), 'thermal')?.name).toBe('Inferno Cruise Missile');
    expect(defaultMissileOf(record('Heavy Assault Missile Launcher II'), 'kinetic')?.name).toBe('Scourge Heavy Assault Missile');
  });

  it('has none for probe and bomb launchers', () => {
    expect(defaultMissileOf(record('Core Probe Launcher II'), 'kinetic')).toBeNull();
    expect(defaultMissileOf(record('Bomb Launcher I'), 'kinetic')).toBeNull();
  });
});

describe('isMissileCharge', () => {
  it('passes missiles and bombs, fails probes and gun ammo', () => {
    expect(isMissileCharge(record('Scourge Heavy Missile'))).toBe(true);
    expect(isMissileCharge(record('Shrapnel Bomb'))).toBe(true);
    expect(isMissileCharge(record('Core Scanner Probe I'))).toBe(false);
    expect(isMissileCharge(record('EMP S'))).toBe(false);
  });
});
