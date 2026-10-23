import { describe, expect, it } from 'vitest';
import { parseEftFit } from '../fitting/eft';
import { DOGMA_FIXTURE, fixtureAnswer, fixtureTypeID, REVELATION_ID, RIFTER_ID } from '../fitting/fitting.spec-helper';
import { typeEftFit } from '../fitting/typed-fit';
import { DEFAULT_LAUNCHERS, DEFAULT_TURRETS, defaultWeaponsOf, weaponFamilyOf, weaponSizeOf, type DefaultWeapons } from './default-weapons';

function defaultsOf(hull: string, extra: { readonly sofRace?: string } = {}): DefaultWeapons {
  return defaultWeaponsOf({ hull: DOGMA_FIXTURE.types[fixtureTypeID(hull)], ...extra });
}

describe('defaultWeaponsOf', () => {
  it('names default weapons the SDE knows by their exact names and ids', () => {
    const types = [...Object.values(DEFAULT_TURRETS).flatMap((sizes) => Object.values(sizes).flatMap((pick) => (pick ? [pick.turret, pick.charge] : []))), ...Object.values(DEFAULT_LAUNCHERS).flatMap((launcher) => (launcher ? [launcher] : []))];
    for (const type of types) expect(fixtureAnswer(type.name)?.typeID, type.name).toBe(type.typeID);
  });

  it.each([
    ['Rifter', 'turret', 3, '200mm AutoCannon II', 'EMP S'],
    ['Punisher', 'turret', 4, 'Small Focused Pulse Laser II', 'Multifrequency S'],
    ['Ferox', 'turret', 6, '250mm Railgun II', 'Antimatter Charge M'],
    ['Megathron', 'turret', 7, 'Neutron Blaster Cannon II', 'Antimatter Charge L'],
    ['Tornado', 'turret', 8, '800mm Repeating Cannon II', 'EMP L'],
    ['Revelation', 'turret', 3, 'Dual Giga Pulse Laser II', 'Multifrequency XL'],
    ['Caracal', 'launcher', 5, 'Heavy Missile Launcher II', null],
    ['Vedmak', 'turret', 1, 'Heavy Entropic Disintegrator II', 'Baryon Exotic Plasma M'],
    ['Stormbringer', 'turret', 1, 'Medium Vorton Projector II', 'ElectroPunch Ultra M']
  ])('gives a %s %s × %i %s', (hull, kind, count, weapon, charge) => {
    const defaults = defaultsOf(hull);
    expect({ kind: defaults.kind, count: defaults.count, weapon: defaults.weapon?.name, charge: defaults.charge?.name ?? null }).toEqual({ kind, count, weapon, charge });
    const highs = Array.from({ length: count }, () => (charge ? `${weapon}, ${charge}` : weapon));
    expect(defaults.text).toBe([`[${hull}, Default weapons]`, '[Empty Low slot]', '', '[Empty Med slot]', '', ...highs].join('\n'));
  });

  it('gives a hull with no weapon hardpoints none, with a note', () => {
    expect(defaultsOf('Apostle')).toMatchObject({ text: null, kind: null, count: 0, note: 'Apostle has no weapon hardpoints' });
  });

  it('picks the family by SDE race, else the DNA race, else projectiles', () => {
    expect([1, 2, 4, 8, 135, 168].map((race) => weaponFamilyOf(race))).toEqual(['rail', 'projectile', 'laser', 'blaster', 'disintegrator', 'vorton']);
    expect(weaponFamilyOf(16, 'Amarr')).toBe('laser');
    expect(weaponFamilyOf(null, 'concord')).toBe('vorton');
    expect(weaponFamilyOf(null, 'jove')).toBe('projectile');
    const raceless = { ...DOGMA_FIXTURE.types[RIFTER_ID], raceID: undefined };
    expect(defaultWeaponsOf({ hull: raceless, sofRace: 'caldari' }).weapon?.name).toBe('150mm Railgun II');
    expect(defaultWeaponsOf({ hull: raceless }).weapon?.name).toBe('200mm AutoCannon II');
  });

  it('sizes by rig size, attack battlecruisers large, else the SOF class', () => {
    const rifter = DOGMA_FIXTURE.types[RIFTER_ID];
    expect(weaponSizeOf(rifter)).toBe('S');
    expect(weaponSizeOf(DOGMA_FIXTURE.types[REVELATION_ID])).toBe('XL');
    expect(weaponSizeOf(DOGMA_FIXTURE.types[fixtureTypeID('Tornado')])).toBe('L');
    const noRigSize = { ...rifter, attributes: { ...rifter.attributes, 1547: undefined as unknown as number } };
    expect(weaponSizeOf(noRigSize, 3)).toBe('L');
    expect(weaponSizeOf(noRigSize)).toBe('S');
  });

  it('notes a size the family has no gun for', () => {
    const revelation = DOGMA_FIXTURE.types[REVELATION_ID];
    expect(defaultWeaponsOf({ hull: { ...revelation, raceID: 168 } })).toMatchObject({ text: null, family: 'vorton', size: 'XL', note: 'Revelation has no default vorton turret of size XL' });
  });

  it('round-trips through the parser and the typed fit to high keys with charges', () => {
    const text = defaultsOf('Rifter').text as string;
    const fit = typeEftFit(parseEftFit(text), { answer: fixtureAnswer, bundle: DOGMA_FIXTURE });
    expect(fit.unknown).toEqual([]);
    expect(fit.modules.map((module) => [module.key, module.name, module.weapon, module.charge?.name])).toEqual([
      ['high-0', '200mm AutoCannon II', 'turret', 'EMP S'],
      ['high-1', '200mm AutoCannon II', 'turret', 'EMP S'],
      ['high-2', '200mm AutoCannon II', 'turret', 'EMP S']
    ]);
    expect(parseEftFit(text).modules.map((line) => line.slot)).toEqual(['high', 'high', 'high']);
    const caracal = typeEftFit(parseEftFit(defaultsOf('Caracal').text as string), { answer: fixtureAnswer, bundle: DOGMA_FIXTURE });
    expect(caracal.modules.map((module) => [module.key, module.weapon])).toContainEqual(['high-4', 'launcher']);
  });
});
