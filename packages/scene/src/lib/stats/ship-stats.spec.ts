import { describe, expect, it } from 'vitest';
import { createPilotContext, type PilotContext } from './pilot';
import { BAKED_PROP_MODS, findBakedPropMod, findHullSizedPropMod, HULL_SIZE_CLASSES, HULL_SIZED_PROP_MODS, normalizePropModName, propModKindOfName, type PropModStats, readPropModKind, readPropModModule, readRigSize, type RigSize } from './prop-mods';
import { computeAlignTime, computeShipStats, type HullStats, normalizeHullStatOverrides } from './ship-stats';

// Published values (EVE typeDogma via ESI, Tranquility, 2026-10-21).
const TEMPEST_FLEET_ISSUE: HullStats = { mass: 103_300_000, maxVelocity: 130, agility: 0.115, signatureRadius: 350, radius: 250, warpSpeedMultiplier: 3, rigSize: 3 };
const GUARDIAN: HullStats = { mass: 11_980_000, maxVelocity: 209, agility: 0.61, signatureRadius: 70, radius: 80, warpSpeedMultiplier: 4, rigSize: 2 };
const REVELATION: HullStats = { mass: 1_290_000_000, maxVelocity: 75, agility: 0.044, signatureRadius: 11_100, radius: 1700, warpSpeedMultiplier: 1.5, rigSize: 4, advancedAgility: 1, advancedCapitalAgility: 1 };
const RIFTER: HullStats = { mass: 1_067_000, maxVelocity: 365, agility: 3.2, signatureRadius: 35, radius: 31, warpSpeedMultiplier: 5, rigSize: 1 };

function propMod(typeID: number, name: string, values: Omit<PropModStats, 'typeID' | 'name'>): PropModStats {
  return { typeID, name, ...values };
}

const MWD_5MN_II = propMod(440, '5MN Microwarpdrive II', { kind: 'microwarpdrive', speedFactor: 510, speedBoostFactor: 1.5e6, massAddition: 5e5, signatureRadiusBonus: 475 });
const AB_10MN_II = propMod(12058, '10MN Afterburner II', { kind: 'afterburner', speedFactor: 135, speedBoostFactor: 1.5e7, massAddition: 5e6, signatureRadiusBonus: 0 });
const MWD_50MN_II = propMod(12076, '50MN Microwarpdrive II', { kind: 'microwarpdrive', speedFactor: 510, speedBoostFactor: 1.5e7, massAddition: 5e6, signatureRadiusBonus: 475 });
const AB_100MN_II = propMod(12068, '100MN Afterburner II', { kind: 'afterburner', speedFactor: 135, speedBoostFactor: 1.5e8, massAddition: 5e7, signatureRadiusBonus: 0 });
const MWD_500MN_II = propMod(12084, '500MN Microwarpdrive II', { kind: 'microwarpdrive', speedFactor: 510, speedBoostFactor: 1.5e8, massAddition: 5e7, signatureRadiusBonus: 475 });
const MWD_500MN_COLD_GAS = propMod(5945, '500MN Cold-Gas Enduring Microwarpdrive', { kind: 'microwarpdrive', speedFactor: 505, speedBoostFactor: 1.5e8, massAddition: 5e7, signatureRadiusBonus: 500 });
const MWD_50000MN_II = propMod(41253, '50000MN Microwarpdrive II', { kind: 'microwarpdrive', speedFactor: 510, speedBoostFactor: 1.5e9, massAddition: 5e8, signatureRadiusBonus: 475 });

interface Fixture {
  readonly label: string;
  readonly hull: HullStats;
  readonly propMod?: PropModStats;
  readonly pilot?: PilotContext;
  readonly mass: number;
  readonly maxVelocity: number;
  readonly agility: number;
  readonly signatureRadius: number;
  readonly alignTime: number;
}

const UNTRAINED = createPilotContext({ name: 'untrained' });
const PARTIAL = createPilotContext({ name: 'partial', skills: { Navigation: 4, 'Evasive Maneuvering': 3, 'Spaceship Command': 5, 'Acceleration Control': 4 } });

const FIXTURES: Fixture[] = [
  { label: 'TFI', hull: TEMPEST_FLEET_ISSUE, mass: 103_300_000, maxVelocity: 162.5, agility: 0.077625, signatureRadius: 350, alignTime: 11.116227 },
  { label: 'TFI, 500MN MWD II', hull: TEMPEST_FLEET_ISSUE, propMod: MWD_500MN_II, mass: 153_300_000, maxVelocity: 1176.137476, agility: 0.077625, signatureRadius: 2012.5, alignTime: 16.496782 },
  { label: 'TFI, 500MN Cold-Gas Enduring MWD', hull: TEMPEST_FLEET_ISSUE, propMod: MWD_500MN_COLD_GAS, mass: 153_300_000, maxVelocity: 1166.199853, agility: 0.077625, signatureRadius: 2100, alignTime: 16.496782 },
  { label: 'TFI, 100MN AB II', hull: TEMPEST_FLEET_ISSUE, propMod: AB_100MN_II, mass: 153_300_000, maxVelocity: 430.815802, agility: 0.077625, signatureRadius: 350, alignTime: 16.496782 },
  { label: 'TFI, undersized 50MN MWD II', hull: TEMPEST_FLEET_ISSUE, propMod: MWD_50MN_II, mass: 108_300_000, maxVelocity: 305.981648, agility: 0.077625, signatureRadius: 2012.5, alignTime: 11.654282 },
  { label: 'Guardian', hull: GUARDIAN, mass: 11_980_000, maxVelocity: 261.25, agility: 0.41175, signatureRadius: 70, alignTime: 6.838264 },
  { label: 'Guardian, 50MN MWD II', hull: GUARDIAN, propMod: MWD_50MN_II, mass: 16_980_000, maxVelocity: 1732.512147, agility: 0.41175, signatureRadius: 402.5, alignTime: 9.692298 },
  { label: 'Guardian, 10MN AB II', hull: GUARDIAN, propMod: AB_10MN_II, mass: 16_980_000, maxVelocity: 650.701745, agility: 0.41175, signatureRadius: 70, alignTime: 9.692298 },
  { label: 'Revelation', hull: REVELATION, mass: 1_290_000_000, maxVelocity: 93.75, agility: 0.01670625, signatureRadius: 11_100, alignTime: 29.876116 },
  { label: 'Revelation, 50000MN MWD II', hull: REVELATION, propMod: MWD_50000MN_II, mass: 1_790_000_000, maxVelocity: 594.57926, agility: 0.01670625, signatureRadius: 63_825, alignTime: 41.456007 },
  { label: 'Rifter, 5MN MWD II', hull: RIFTER, propMod: MWD_5MN_II, mass: 1_567_000, maxVelocity: 3240.481414, agility: 2.16, signatureRadius: 201.25, alignTime: 4.692218 },
  { label: 'untrained TFI', hull: TEMPEST_FLEET_ISSUE, pilot: UNTRAINED, mass: 103_300_000, maxVelocity: 130, agility: 0.115, signatureRadius: 350, alignTime: 16.468484 },
  { label: 'untrained Guardian, 50MN MWD II', hull: GUARDIAN, propMod: MWD_50MN_II, pilot: UNTRAINED, mass: 16_980_000, maxVelocity: 1150.607774, agility: 0.61, signatureRadius: 402.5, alignTime: 14.35896 },
  { label: 'untrained Revelation', hull: REVELATION, pilot: UNTRAINED, mass: 1_290_000_000, maxVelocity: 75, agility: 0.044, signatureRadius: 11_100, alignTime: 78.686068 },
  { label: 'partial-pilot Guardian, 50MN MWD II', hull: GUARDIAN, propMod: MWD_50MN_II, pilot: PARTIAL, mass: 16_980_000, maxVelocity: 1606.715194, agility: 0.46665, signatureRadius: 402.5, alignTime: 10.984604 }
];

describe('computeShipStats', () => {
  it.each(FIXTURES)('$label matches the in-game numbers', (fixture) => {
    const stats = computeShipStats({ hull: fixture.hull, propMod: fixture.propMod, pilot: fixture.pilot });
    expect(stats.mass).toBe(fixture.mass);
    expect(stats.maxVelocity).toBeCloseTo(fixture.maxVelocity, 3);
    expect(stats.agility).toBeCloseTo(fixture.agility, 9);
    expect(stats.signatureRadius).toBeCloseTo(fixture.signatureRadius, 6);
    expect(stats.alignTime).toBeCloseTo(fixture.alignTime, 5);
    expect(stats.alignTime).toBe(computeAlignTime(stats.mass, stats.agility));
    expect(stats.propModActive).toBe(fixture.propMod != null);
  });

  it('flies with the max-skills pilot by default and passes radius and warp speed through', () => {
    const stats = computeShipStats({ hull: GUARDIAN });
    expect(stats.pilot).toBe('max-skills');
    expect(stats.radius).toBe(80);
    expect(stats.warpSpeedMultiplier).toBe(4);
    expect(computeShipStats({ hull: { mass: 1, maxVelocity: 1, agility: 1, signatureRadius: 1 } }).radius).toBeNull();
  });

  it('applies overrides before the pilot and the prop mod', () => {
    const stats = computeShipStats({ hull: GUARDIAN, overrides: { maxVelocity: 100 } });
    expect(stats.maxVelocity).toBeCloseTo(125, 9);
    expect(stats.applied[0]).toEqual({ source: 'stats override', attribute: 'maxVelocity', from: 209, to: 100 });
  });

  it('computes from overrides alone and requires all four without a hull', () => {
    const stats = computeShipStats({ hull: null, overrides: { mass: 11_980_000, maxVelocity: 209, agility: 0.61, signatureRadius: 70 } });
    expect(stats.maxVelocity).toBeCloseTo(261.25, 9);
    expect(stats.radius).toBeNull();
    expect(() => computeShipStats({ hull: null, overrides: { mass: 1, maxVelocity: 1, agility: 1 } })).toThrow(/overrides\.signatureRadius is required/);
  });

  it('rejects invalid hull, override and prop mod values, naming the field', () => {
    expect(() => computeShipStats({ hull: { ...GUARDIAN, agility: 0 } })).toThrow(new RangeError('hull.agility must be a positive number'));
    expect(() => computeShipStats({ hull: { ...GUARDIAN, mass: Number.NaN } })).toThrow(/hull\.mass must be a positive number/);
    expect(() => computeShipStats({ hull: GUARDIAN, overrides: { maxVelocity: -1 } })).toThrow(/overrides\.maxVelocity/);
    expect(() => computeShipStats({ hull: GUARDIAN, propMod: { ...MWD_50MN_II, massAddition: -5 } })).toThrow(/propMod\.massAddition/);
    expect(() => computeShipStats({ hull: { ...REVELATION, advancedAgility: 0 } })).toThrow(/hull\.advancedAgility/);
  });

  it('rejects a pilot that answers an impossible level', () => {
    const broken: PilotContext = { name: 'broken', skillLevel: () => 7 as never };
    expect(() => computeShipStats({ hull: GUARDIAN, pilot: broken })).toThrow(RangeError);
  });

  it('traces every step: skills by level, capital hooks only on capitals, then the prop mod', () => {
    const sources = (hull: HullStats, mod?: PropModStats) => computeShipStats({ hull, propMod: mod }).applied.map((step) => `${step.source}: ${step.attribute}`);
    expect(sources(GUARDIAN, MWD_50MN_II)).toEqual(['Navigation V: maxVelocity', 'Evasive Maneuvering V: agility', 'Spaceship Command V: agility', 'Acceleration Control V: propModSpeedFactor', '50MN Microwarpdrive II: mass', '50MN Microwarpdrive II: maxVelocity', '50MN Microwarpdrive II: signatureRadius']);
    expect(sources(GUARDIAN, AB_10MN_II)).not.toContain('10MN Afterburner II: signatureRadius');
    expect(sources(REVELATION)).toEqual(['Navigation V: maxVelocity', 'Evasive Maneuvering V: agility', 'Spaceship Command V: agility', 'Advanced Spaceship Command V (capital hull): agility', 'Capital Ships V (capital hull): agility']);
    expect(computeShipStats({ hull: GUARDIAN, pilot: PARTIAL }).applied.map((step) => step.source)).toEqual(['Navigation IV', 'Evasive Maneuvering III', 'Spaceship Command V']);
    expect(computeShipStats({ hull: GUARDIAN, propMod: { ...AB_10MN_II, name: null } }).applied.at(-1)?.source).toBe('prop mod');
  });

  it('applies a capital hull hook other than 1', () => {
    expect(computeShipStats({ hull: { ...REVELATION, advancedAgility: 0.5 }, pilot: UNTRAINED }).agility).toBeCloseTo(0.022, 12);
  });
});

describe('normalizeHullStatOverrides', () => {
  it('keeps valid values and reports each bad one', () => {
    const { overrides, problems, warnings } = normalizeHullStatOverrides({
      input: { mass: 0, maxVelocity: 0, agility: -1, signatureRadius: '70', speed: 3 },
      where: 'ships[0].stats'
    });
    expect(overrides).toEqual({ maxVelocity: 0 });
    expect(problems).toEqual(['ships[0].stats.mass must be a positive number (kg)', 'ships[0].stats.agility must be a positive number', 'ships[0].stats.signatureRadius must be a positive number (m)']);
    expect(warnings).toEqual(['ships[0].stats.speed is not a known stat and was dropped']);
  });

  it('treats null, an empty object and null keys as no override', () => {
    for (const input of [null, undefined, {}, { mass: null }]) {
      expect(normalizeHullStatOverrides({ input, where: 'stats' })).toEqual({ overrides: null, problems: [], warnings: [] });
    }
  });

  it('rejects a value that is not an object', () => {
    for (const input of [3, 'fast', [1, 2]]) {
      expect(normalizeHullStatOverrides({ input, where: 'stats' }).problems).toEqual(['stats must be an object of mass, maxVelocity, agility and signatureRadius']);
    }
    expect(normalizeHullStatOverrides({ input: { maxVelocity: Infinity }, where: 'stats' }).problems).toEqual(['stats.maxVelocity must be a number of 0 or more (m/s)']);
  });
});

describe('prop mods', () => {
  it('finds the Tech II module sized for every hull size', () => {
    for (const rigSize of [1, 2, 3, 4] as RigSize[]) {
      expect(findHullSizedPropMod({ rigSize, kind: 'microwarpdrive' })).toBe(HULL_SIZED_PROP_MODS[rigSize].microwarpdrive);
      expect(findHullSizedPropMod({ rigSize, kind: 'afterburner' })).toBe(HULL_SIZED_PROP_MODS[rigSize].afterburner);
    }
    expect(findHullSizedPropMod({ rigSize: 3, kind: 'microwarpdrive' })?.typeID).toBe(12084);
    expect(findHullSizedPropMod({ rigSize: 2, kind: 'afterburner' })?.typeID).toBe(12058);
    expect(findHullSizedPropMod({ rigSize: 5, kind: 'afterburner' })).toBeNull();
    expect(findHullSizedPropMod({ rigSize: null, kind: 'afterburner' })).toBeNull();
  });

  it('reads the kind aliases', () => {
    expect(readPropModKind('MWD')).toBe('microwarpdrive');
    expect(readPropModKind(' microwarpdrive ')).toBe('microwarpdrive');
    expect(readPropModKind('ab')).toBe('afterburner');
    expect(readPropModKind('Afterburner')).toBe('afterburner');
    expect(readPropModKind('constructor')).toBeNull();
    expect(readPropModKind(12084)).toBeNull();
  });
});

describe('prop mod cycle time', () => {
  it('Afterburner V shortens an afterburner cycle by a quarter, never a microwarpdrive', () => {
    expect(computeShipStats({ hull: GUARDIAN, propMod: { ...AB_10MN_II, duration: 10_000 } }).propModCycleTime).toBeCloseTo(7.5, 12);
    expect(computeShipStats({ hull: GUARDIAN, propMod: { ...AB_10MN_II, duration: 10_000 }, pilot: UNTRAINED }).propModCycleTime).toBe(10);
    expect(computeShipStats({ hull: GUARDIAN, propMod: { ...MWD_50MN_II, duration: 10_000 } }).propModCycleTime).toBe(10);
    expect(computeShipStats({ hull: REVELATION, propMod: findBakedPropMod(41239) }).propModCycleTime).toBeCloseTo(15, 12);
  });

  it('is null without a prop mod or its duration, and leaves the other numbers alone', () => {
    expect(computeShipStats({ hull: GUARDIAN }).propModCycleTime).toBeNull();
    expect(computeShipStats({ hull: GUARDIAN, propMod: AB_10MN_II }).propModCycleTime).toBeNull();
    const withDuration = computeShipStats({ hull: GUARDIAN, propMod: { ...AB_10MN_II, duration: 10_000 } });
    expect(withDuration.maxVelocity).toBeCloseTo(650.701745, 5);
    expect(withDuration.applied.map((step) => step.source)).toContain('Afterburner V');
  });

  it('rejects a duration that is not a positive number', () => {
    expect(() => computeShipStats({ hull: GUARDIAN, propMod: { ...AB_10MN_II, duration: 0 } })).toThrow(/propMod\.duration/);
  });
});

describe('baked prop mods', () => {
  it('carry the SDE numbers the fixtures pin', () => {
    expect(computeShipStats({ hull: TEMPEST_FLEET_ISSUE, propMod: findBakedPropMod(12084) }).maxVelocity).toBeCloseTo(1176.137476, 5);
    const coldGas = computeShipStats({ hull: TEMPEST_FLEET_ISSUE, propMod: findBakedPropMod('500MN Cold-Gas Enduring Microwarpdrive') });
    expect(coldGas.maxVelocity).toBeCloseTo(1166.199853, 5);
    expect(coldGas.signatureRadius).toBeCloseTo(2100, 9);
    for (const rigSize of [1, 2, 3, 4] as RigSize[]) {
      for (const kind of ['microwarpdrive', 'afterburner'] as const) expect(findBakedPropMod(HULL_SIZED_PROP_MODS[rigSize][kind].typeID)?.name).toBe(HULL_SIZED_PROP_MODS[rigSize][kind].name);
    }
    expect(new Set(BAKED_PROP_MODS.map((propMod) => propMod.typeID)).size).toBe(13);
  });

  it('are found by id, exact name, any case and the MWD / AB abbreviations', () => {
    expect(findBakedPropMod(12076)?.name).toBe('50MN Microwarpdrive II');
    expect(findBakedPropMod('50MN Microwarpdrive II')?.typeID).toBe(12076);
    expect(findBakedPropMod('50mn microwarpdrive ii')?.typeID).toBe(12076);
    expect(findBakedPropMod('50MN  MWD II')?.typeID).toBe(12076);
    expect(findBakedPropMod('10MN AB II')?.typeID).toBe(12058);
    expect(findBakedPropMod('50MN Microwarpdrive I')).toBeNull();
    expect(findBakedPropMod(1)).toBeNull();
  });
});

describe('prop mod modules', () => {
  it('canonicalizes the keywords, ids and names', () => {
    const problems: string[] = [];
    expect(readPropModModule('MWD', 'm', problems)).toBe('mwd');
    expect(readPropModModule('Microwarpdrive', 'm', problems)).toBe('mwd');
    expect(readPropModModule(' ab ', 'm', problems)).toBe('ab');
    expect(readPropModModule('afterburner', 'm', problems)).toBe('ab');
    expect(readPropModModule('None', 'm', problems)).toBe('none');
    expect(readPropModModule(12084, 'm', problems)).toBe(12084);
    expect(readPropModModule('12084', 'm', problems)).toBe(12084);
    expect(readPropModModule(' 10MN Afterburner II ', 'm', problems)).toBe('10MN Afterburner II');
    expect(problems).toEqual([]);
  });

  it('refuses what is not a module', () => {
    for (const value of [0, -3, 1.5, '', ' ', 'x'.repeat(101), true, {}, []]) {
      const problems: string[] = [];
      expect(readPropModModule(value, 'ships[0].propMod.module', problems)).toBeNull();
      expect(problems).toEqual(['ships[0].propMod.module must be a prop mod: an EVE module name of at most 100 characters, a type id, "mwd", "ab" or "none"']);
    }
  });

  it('normalizes names and reads their kind', () => {
    expect(normalizePropModName('  50MN   MWD  II ')).toBe('50mn microwarpdrive ii');
    expect(normalizePropModName('Lab Coat')).toBe('lab coat');
    expect(propModKindOfName('500MN Quad LiF Restrained Microwarpdrive')).toBe('microwarpdrive');
    expect(propModKindOfName('10MN AB II')).toBe('afterburner');
    expect(propModKindOfName('Damage Control II')).toBeNull();
  });

  it('names the size classes', () => {
    expect(HULL_SIZE_CLASSES).toEqual({ 1: 'S', 2: 'M', 3: 'L', 4: 'XL' });
    expect(readRigSize(3)).toBe(3);
    expect(readRigSize(5)).toBeNull();
    expect(readRigSize('3')).toBeNull();
  });
});
