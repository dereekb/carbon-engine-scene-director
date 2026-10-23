import { describe, expect, it } from 'vitest';
import { createPilotContext } from '../stats/pilot';
import { type DogmaIncomingModifier, type DogmaShip, dogmaResistanceOf, evaluateShipDogma, stackingFactor } from './dogma';
import type { DogmaAttributeRecord, DogmaBundle, DogmaEffectRecord, DogmaModifierRecord, DogmaTypeRecord } from './dogma-bundle';
import { DAMNATION_ID, DOGMA_FIXTURE, fixtureTypeID, RIFTER_ID, TFI_ID } from './fitting.spec-helper';

// A synthetic bundle for the rules: one hull and the modules, charges and skills each case needs.
const VALUE = 1000;
const STACKABLE_VALUE = 1001;
const CAP = 1002;
const CAPPED = 1003;
const AMOUNT = 2000;
const REQUIRED_SKILL_1 = 182;

const HULL_ID = 1;
const SKILL_ID = 90;

function attribute(attributeID: number, name: string, extra: Partial<DogmaAttributeRecord> = {}): DogmaAttributeRecord {
  return { attributeID, name, stackable: false, highIsGood: true, defaultValue: 0, ...extra };
}

const ATTRIBUTES: Record<string, DogmaAttributeRecord> = {
  [VALUE]: attribute(VALUE, 'value'),
  [STACKABLE_VALUE]: attribute(STACKABLE_VALUE, 'stackableValue', { stackable: true }),
  [CAP]: attribute(CAP, 'cap'),
  [CAPPED]: attribute(CAPPED, 'capped', { maxAttributeID: CAP }),
  [AMOUNT]: attribute(AMOUNT, 'amount'),
  [REQUIRED_SKILL_1]: attribute(REQUIRED_SKILL_1, 'requiredSkill1')
};

let nextEffectID = 1;

function modifier(config: Partial<DogmaModifierRecord> & Pick<DogmaModifierRecord, 'operation'>): DogmaModifierRecord {
  return { func: 'ItemModifier', domain: 'shipID', modifiedAttributeID: VALUE, modifyingAttributeID: AMOUNT, ...config };
}

function effect(category: number, modifiers: DogmaModifierRecord[]): DogmaEffectRecord {
  const effectID = nextEffectID++;
  return { effectID, name: `effect${effectID}`, category, guid: '', warpSafe: false, offensive: false, assistance: false, modifiers };
}

interface SyntheticType {
  readonly typeID: number;
  readonly groupID?: number;
  readonly categoryID?: number;
  readonly attributes?: Record<number, number>;
  readonly effects?: DogmaEffectRecord[];
  readonly defaultEffect?: number;
}

function makeBundle(types: readonly SyntheticType[]): DogmaBundle {
  const all: SyntheticType[] = [{ typeID: HULL_ID, groupID: 25, categoryID: 6, attributes: { [VALUE]: 100, [STACKABLE_VALUE]: 100, [CAP]: 150, [CAPPED]: 100 } }, ...types];
  const effects: Record<string, DogmaEffectRecord> = {};
  const records: Record<string, DogmaTypeRecord> = {};
  for (const type of all) {
    for (const record of type.effects ?? []) effects[record.effectID] = record;
    records[type.typeID] = {
      typeID: type.typeID,
      name: `type ${type.typeID}`,
      groupID: type.groupID ?? 1,
      categoryID: type.categoryID ?? 7,
      published: true,
      attributes: Object.fromEntries(Object.entries(type.attributes ?? {}).map(([id, value]) => [id, value])),
      effects: (type.effects ?? []).map((record) => record.effectID),
      ...(type.defaultEffect == null ? {} : { defaultEffect: type.defaultEffect })
    };
  }
  return { sdeBuild: 'synthetic', types: records, effects, attributes: ATTRIBUTES };
}

/**
 * A module that changes the ship's `value` (or another attribute) by `amount` with one operation, while online.
 */
function shipModule(typeID: number, operation: number, amount: number, extra: Partial<SyntheticType> & { readonly modified?: number } = {}): SyntheticType {
  return { typeID, attributes: { [AMOUNT]: amount }, effects: [effect(4, [modifier({ operation, modifiedAttributeID: extra.modified ?? VALUE })])], ...extra };
}

function evaluate(types: readonly SyntheticType[], modules: readonly { readonly typeID: number; readonly state?: 'offline' | 'online' | 'active'; readonly chargeTypeID?: number }[] = types.map((type) => ({ typeID: type.typeID }))): DogmaShip {
  return evaluateShipDogma({ bundle: makeBundle(types), hullTypeID: HULL_ID, modules: modules.map((module, index) => ({ key: `mid-${index}`, typeID: module.typeID, state: module.state ?? 'online', ...(module.chargeTypeID == null ? {} : { chargeTypeID: module.chargeTypeID }) })) });
}

describe('evaluateShipDogma rules', () => {
  it('applies the operations in tools-core order', () => {
    const types = [shipModule(10, 7, 7), shipModule(11, 6, 10), shipModule(12, 5, 2), shipModule(13, 4, 3), shipModule(14, 3, 5), shipModule(15, 2, 10), shipModule(16, 1, 4), shipModule(17, 0, 2), shipModule(18, -1, 50)].map((type) => ({
      ...type,
      effects: type.effects?.map((record) => ({ ...record, modifiers: record.modifiers.map((entry) => ({ ...entry, modifiedAttributeID: STACKABLE_VALUE })) }))
    }));
    const withoutAssign = evaluate(types.slice(1));
    expect(withoutAssign.attribute('stackableValue')).toBeCloseTo(((((50 * 2) / 4 + 10 - 5) * 3) / 2) * 1.1, 12);
    expect(withoutAssign.trace('stackableValue').map((step) => step.operation)).toEqual(['preAssign', 'preMul', 'preDiv', 'modAdd', 'modSub', 'postMul', 'postDiv', 'postPercent']);
    expect(evaluate(types).attribute('stackableValue')).toBe(7);
  });

  it('penalizes a non-stackable attribute strongest first, bonuses and maluses apart, each operation its own group', () => {
    expect([0, 1, 2, 3, 4].map((index) => Number(stackingFactor(index).toFixed(3)))).toEqual([1, 0.869, 0.571, 0.283, 0.106]);
    const bonuses = evaluate([shipModule(10, 6, 10), shipModule(11, 6, 20), shipModule(12, 6, 10)]);
    expect(bonuses.attribute('value')).toBeCloseTo(100 * 1.2 * (1 + 0.1 * stackingFactor(1)) * (1 + 0.1 * stackingFactor(2)), 9);
    expect(bonuses.trace('value').map((step) => [step.amount, step.penalty])).toEqual([
      [20, 1],
      [10, stackingFactor(1)],
      [10, stackingFactor(2)]
    ]);
    const mixed = evaluate([shipModule(10, 6, 10), shipModule(11, 6, 10), shipModule(12, 6, -10), shipModule(13, 6, -10)]);
    const bonus = 1.1 * (1 + 0.1 * stackingFactor(1));
    const malus = 0.9 * (1 - 0.1 * stackingFactor(1));
    expect(mixed.attribute('value')).toBeCloseTo(100 * bonus * malus, 9);
    // preMul and postMul do not chain into one another.
    expect(evaluate([shipModule(10, 0, 1.1), shipModule(11, 4, 1.1)]).attribute('value')).toBeCloseTo(121, 9);
    expect(evaluate([shipModule(10, 4, 1.1), shipModule(11, 4, 1.1)]).attribute('value')).toBeCloseTo(100 * 1.1 * (1 + 0.1 * stackingFactor(1)), 9);
  });

  it('never penalizes a stackable attribute, modAdd, or a source of an exempt category', () => {
    expect(evaluate([shipModule(10, 6, 10, { modified: STACKABLE_VALUE }), shipModule(11, 6, 10, { modified: STACKABLE_VALUE })]).attribute('stackableValue')).toBeCloseTo(121, 9);
    expect(evaluate([shipModule(10, 2, 10), shipModule(11, 2, 10)]).attribute('value')).toBe(120);
    for (const categoryID of [6, 8, 16, 20, 32]) {
      expect(evaluate([shipModule(10, 6, 10, { categoryID }), shipModule(11, 6, 10, { categoryID })]).attribute('value')).toBeCloseTo(121, 9);
    }
  });

  it('caps an attribute at the value of its maxAttributeID', () => {
    expect(evaluate([shipModule(10, 6, 100, { modified: CAPPED })]).attribute('capped')).toBe(150);
    expect(evaluate([shipModule(10, 6, 20, { modified: CAPPED })]).attribute('capped')).toBeCloseTo(120, 9);
  });

  it('runs a module online effect only online or active, and its default effect only active', () => {
    const passive = effect(0, [modifier({ operation: 2 })]);
    const online = effect(4, [modifier({ operation: 2, modifiedAttributeID: STACKABLE_VALUE })]);
    const active = effect(1, [modifier({ operation: 2, modifiedAttributeID: CAPPED })]);
    const overload = effect(5, [modifier({ operation: 2, modifiedAttributeID: CAP })]);
    const type: SyntheticType = { typeID: 10, attributes: { [AMOUNT]: 5 }, effects: [passive, online, active, overload], defaultEffect: active.effectID };
    const read = (state: 'offline' | 'online' | 'active'): number[] => {
      const ship = evaluate([type], [{ typeID: 10, state }]);
      return ['value', 'stackableValue', 'capped', 'cap'].map((name) => ship.attribute(name));
    };
    expect(read('offline')).toEqual([105, 100, 100, 150]);
    expect(read('online')).toEqual([105, 105, 100, 150]);
    expect(read('active')).toEqual([105, 105, 105, 150]);
  });

  it('links a charge to its module (otherID) and runs the charge only while the module is on', () => {
    const charge: SyntheticType = { typeID: 20, categoryID: 8, attributes: { [AMOUNT]: 3 }, effects: [effect(0, [modifier({ operation: 4, domain: 'otherID' })])] };
    const module: SyntheticType = { typeID: 10, attributes: { [VALUE]: 10 } };
    expect(evaluate([module, charge], [{ typeID: 10, chargeTypeID: 20 }]).moduleAttribute('mid-0', 'value')).toBe(30);
    expect(evaluate([module, charge], [{ typeID: 10, chargeTypeID: 20, state: 'offline' }]).moduleAttribute('mid-0', 'value')).toBe(10);
    expect(evaluate([module, charge], [{ typeID: 10 }]).moduleAttribute('mid-0', 'value')).toBe(10);
    expect(evaluate([module, charge], [{ typeID: 10, chargeTypeID: 20 }]).chargeAttribute('mid-0', 'amount')).toBe(3);
  });

  it("acts on the ship's modules by group and by required skill, and on charges by the owner's skill", () => {
    const skill: SyntheticType = {
      typeID: SKILL_ID,
      categoryID: 16,
      attributes: { [AMOUNT]: 2 },
      effects: [
        effect(0, [modifier({ func: 'LocationGroupModifier', groupID: 55, operation: 4 })]),
        effect(0, [modifier({ func: 'LocationRequiredSkillModifier', skillTypeID: -1, operation: 4, modifiedAttributeID: STACKABLE_VALUE })]),
        effect(0, [modifier({ func: 'OwnerRequiredSkillModifier', domain: 'charID', skillTypeID: -1, operation: 4, modifiedAttributeID: CAP })])
      ]
    };
    const inGroup: SyntheticType = { typeID: 10, groupID: 55, attributes: { [VALUE]: 10, [STACKABLE_VALUE]: 10 } };
    const needsSkill: SyntheticType = { typeID: 11, attributes: { [VALUE]: 10, [STACKABLE_VALUE]: 10, [REQUIRED_SKILL_1]: SKILL_ID } };
    const charge: SyntheticType = { typeID: 20, categoryID: 8, attributes: { [CAP]: 10, [REQUIRED_SKILL_1]: SKILL_ID } };
    const ship = evaluate([skill, inGroup, needsSkill, charge], [{ typeID: 10 }, { typeID: 11, chargeTypeID: 20 }]);
    expect([ship.moduleAttribute('mid-0', 'value'), ship.moduleAttribute('mid-0', 'stackableValue')]).toEqual([20, 10]);
    expect([ship.moduleAttribute('mid-1', 'value'), ship.moduleAttribute('mid-1', 'stackableValue')]).toEqual([10, 20]);
    expect(ship.chargeAttribute('mid-1', 'cap')).toBe(20);
    expect(ship.attribute('value')).toBe(100);
  });

  it('skips target-domain modifiers and leaves out types the bundle lacks, with warnings', () => {
    const targeted = { typeID: 10, attributes: { [AMOUNT]: 5 }, effects: [effect(4, [modifier({ operation: 2, domain: 'targetID' })])] };
    const ship = evaluate([targeted], [{ typeID: 10 }, { typeID: 99 }]);
    expect(ship.attribute('value')).toBe(100);
    expect(ship.skipped).toEqual([targeted.effects[0].name]);
    expect(ship.modules.has('mid-1')).toBe(false);
    expect(ship.warnings).toEqual(['module mid-1: the dogma bundle has no type 99; it is left out']);
    expect(() => evaluateShipDogma({ bundle: DOGMA_FIXTURE, hullTypeID: 3 })).toThrow(RangeError);
  });
});

describe('evaluateShipDogma over the fixture', () => {
  const modules = (...entries: [string, 'offline' | 'online' | 'active', number?][]) => entries.map(([name, state, charge], index) => ({ key: `slot-${index}`, typeID: fixtureTypeID(name), state, ...(charge == null ? {} : { chargeTypeID: charge }) }));
  const effectOf = (name: string, effectName: string): DogmaEffectRecord => DOGMA_FIXTURE.types[fixtureTypeID(name)].effects.map((id) => DOGMA_FIXTURE.effects[id]).find((record) => record.name === effectName) as DogmaEffectRecord;

  it('gates plates, membranes and the damage control on online, rigs on nothing, hardeners on active', () => {
    expect(effectOf('200mm Steel Plates II', 'armorHPBonusAdd').category).toBe(4);
    expect(effectOf('Multispectrum Energized Membrane II', 'modifyArmorResonancePostPercent').category).toBe(4);
    expect(effectOf('Damage Control II', 'damageControl').category).toBe(4);
    const hardener = DOGMA_FIXTURE.types[fixtureTypeID('Multispectrum Shield Hardener II')];
    expect(DOGMA_FIXTURE.effects[hardener.defaultEffect as number].category).toBe(1);
    const armor = (state: 'offline' | 'online' | 'active'): number => evaluateShipDogma({ bundle: DOGMA_FIXTURE, hullTypeID: RIFTER_ID, modules: modules(['200mm Steel Plates II', state]) }).attribute('armorHP');
    expect([armor('offline'), armor('online'), armor('active')]).toEqual([562.5, 1312.5, 1312.5]);
    const pump = (state: 'offline' | 'online'): number => evaluateShipDogma({ bundle: DOGMA_FIXTURE, hullTypeID: DAMNATION_ID, modules: modules(['Large Trimark Armor Pump I', state]) }).attribute('armorHP');
    expect(pump('offline')).toBe(pump('online'));
    expect(pump('offline')).toBeGreaterThan(evaluateShipDogma({ bundle: DOGMA_FIXTURE, hullTypeID: DAMNATION_ID }).attribute('armorHP'));
  });

  it('reads skill levels from the pilot: Hull Upgrades 0 drops the Rifter armor by a fifth', () => {
    const pilot = createPilotContext({ name: 'no hull upgrades', skills: { 'Hull Upgrades': 0 }, defaultLevel: 5 });
    expect(evaluateShipDogma({ bundle: DOGMA_FIXTURE, hullTypeID: RIFTER_ID, pilot }).attribute('armorHP')).toBe(450);
    expect(evaluateShipDogma({ bundle: DOGMA_FIXTURE, hullTypeID: RIFTER_ID }).attribute('armorHP')).toBe(562.5);
  });

  it('applies hull traits through the racial hull skills, zero when untrained', () => {
    const damnation = evaluateShipDogma({ bundle: DOGMA_FIXTURE, hullTypeID: DAMNATION_ID });
    const base = DOGMA_FIXTURE.types[DAMNATION_ID].attributes;
    expect(damnation.attribute('armorEmDamageResonance')).toBeCloseTo(base[267] * 0.8, 12);
    expect(damnation.trace('shipBonusABC1')).toEqual([expect.objectContaining({ source: 'Amarr Battlecruiser V', operation: 'preMul', amount: 5 })]);
    expect(damnation.attribute('armorHP')).toBe(8812.5);
    const untrained = evaluateShipDogma({ bundle: DOGMA_FIXTURE, hullTypeID: DAMNATION_ID, pilot: createPilotContext({ name: 'untrained' }) });
    expect(untrained.attribute('armorEmDamageResonance')).toBe(base[267]);
    expect(untrained.attribute('armorHP')).toBe(base[265]);
  });

  it('acts on modules by group (Surgical Strike) and by required skill (Repair Systems)', () => {
    const fit = modules(['800mm Repeating Cannon II', 'online'], ['Large Armor Repairer II', 'online']);
    const max = evaluateShipDogma({ bundle: DOGMA_FIXTURE, hullTypeID: TFI_ID, modules: fit });
    const without = (skill: string) => evaluateShipDogma({ bundle: DOGMA_FIXTURE, hullTypeID: TFI_ID, modules: fit, pilot: createPilotContext({ name: `no ${skill}`, skills: { [skill]: 0 }, defaultLevel: 5 }) });
    expect((max.moduleAttribute('slot-0', 'damageMultiplier') as number) / (without('Surgical Strike').moduleAttribute('slot-0', 'damageMultiplier') as number)).toBeCloseTo(1.15, 12);
    expect((max.moduleAttribute('slot-1', 'duration') as number) / (without('Repair Systems').moduleAttribute('slot-1', 'duration') as number)).toBeCloseTo(0.75, 12);
    expect(max.moduleAttribute('slot-1', 'damageMultiplier')).toBe(without('Surgical Strike').moduleAttribute('slot-1', 'damageMultiplier'));
  });

  it("builds in the MWD's mass, speed and signature and the AB's mass and speed, active only", () => {
    const fly = (name: string, state: 'online' | 'active') => evaluateShipDogma({ bundle: DOGMA_FIXTURE, hullTypeID: RIFTER_ID, modules: modules([name, state]) });
    const bare = evaluateShipDogma({ bundle: DOGMA_FIXTURE, hullTypeID: RIFTER_ID });
    const mwd = fly('5MN Microwarpdrive II', 'active');
    expect(mwd.attribute('mass')).toBe(bare.attribute('mass') + 500_000);
    expect(mwd.attribute('maxVelocity')).toBeCloseTo(bare.attribute('maxVelocity') * (1 + ((mwd.moduleAttribute('slot-0', 'speedFactor') as number) * 1.5e6) / mwd.attribute('mass') / 100), 9);
    expect(mwd.attribute('signatureRadius')).toBeCloseTo(bare.attribute('signatureRadius') * 5.75, 9);
    expect(fly('5MN Microwarpdrive II', 'online').attribute('maxVelocity')).toBe(bare.attribute('maxVelocity'));
    const ab = fly('1MN Afterburner II', 'active');
    expect(ab.attribute('mass')).toBe(bare.attribute('mass') + 500_000);
    expect(ab.attribute('maxVelocity')).toBeGreaterThan(bare.attribute('maxVelocity'));
    expect(ab.attribute('signatureRadius')).toBe(bare.attribute('signatureRadius'));
  });
});

describe('evaluateShipDogma incoming modifiers', () => {
  const web = (amount = -60, source = 'tackle: Stasis Webifier II (mid-0)'): DogmaIncomingModifier => ({ source, effect: 'remoteWebifierFalloff', attributeID: 37, operation: 6, amount, resistanceAttributeID: 2115 });
  const speed = (incoming: readonly DogmaIncomingModifier[], extra: Partial<Parameters<typeof evaluateShipDogma>[0]> = {}) => evaluateShipDogma({ bundle: DOGMA_FIXTURE, hullTypeID: TFI_ID, incoming, ...extra }).attribute('maxVelocity');

  it('webs a bare TFI, stacking-penalized, and traces the source', () => {
    const bare = speed([]);
    expect(speed([web()])).toBeCloseTo(bare * 0.4, 9);
    expect(speed([web(), web(-60, 'other: Stasis Webifier II (mid-1)')])).toBeCloseTo(bare * 0.4 * (1 - 0.6 * stackingFactor(1)), 9);
    const ship = evaluateShipDogma({ bundle: DOGMA_FIXTURE, hullTypeID: TFI_ID, incoming: [web()] });
    expect(ship.trace('maxVelocity').at(-1)).toMatchObject({ source: 'tackle: Stasis Webifier II (mid-0)', effect: 'remoteWebifierFalloff', operation: 'postPercent', amount: -60, penalty: 1 });
  });

  it("chains with the ship's own penalized modifiers, as a module of its own would", () => {
    const own = [shipModule(10, 6, -10), shipModule(11, 6, -20)];
    const ship = evaluateShipDogma({
      bundle: makeBundle(own),
      hullTypeID: HULL_ID,
      modules: own.map((type, index) => ({ key: `low-${index}`, typeID: type.typeID, state: 'online' })),
      incoming: [{ source: 'tackle: Stasis Webifier II (mid-0)', effect: 'remoteWebifierFalloff', attributeID: VALUE, operation: 6, amount: -60 }]
    });
    expect(ship.attribute('value')).toBeCloseTo(100 * 0.4 * (1 - 0.2 * stackingFactor(1)) * (1 - 0.1 * stackingFactor(2)), 9);
    expect(ship.trace('value').map((step) => [step.source, step.penalty])).toEqual([
      ['tackle: Stasis Webifier II (mid-0)', 1],
      ['type 11 (low-1)', stackingFactor(1)],
      ['type 10 (low-0)', stackingFactor(2)]
    ]);
  });

  it("scales by the ship's resistance, 1 when the hull lacks it and the bundle has no record", () => {
    const tfi = DOGMA_FIXTURE.types[TFI_ID];
    const resistant: DogmaBundle = { ...DOGMA_FIXTURE, types: { ...DOGMA_FIXTURE.types, [TFI_ID]: { ...tfi, attributes: { ...tfi.attributes, 2115: 0.2 } } } };
    expect(speed([web()], { bundle: resistant })).toBeCloseTo(speed([]) * 0.88, 9);
    const { 2115: _web, ...attributes } = tfi.attributes;
    const { 2115: _record, ...records } = DOGMA_FIXTURE.attributes;
    const lacking: DogmaBundle = { ...DOGMA_FIXTURE, attributes: records, types: { ...DOGMA_FIXTURE.types, [TFI_ID]: { ...tfi, attributes } } };
    expect(speed([web()], { bundle: lacking })).toBeCloseTo(speed([]) * 0.4, 9);
    expect(dogmaResistanceOf(evaluateShipDogma({ bundle: lacking, hullTypeID: TFI_ID }), lacking, 2115)).toBe(1);
  });

  it('adds a point to the warp scramble status, against a running warp core stabilizer', () => {
    const point: DogmaIncomingModifier = { source: 'tfi-02: Warp Disruptor II (mid-0)', effect: 'warpDisrupt', attributeID: 104, operation: 2, amount: 1 };
    const status = (state: 'online' | 'active') => evaluateShipDogma({ bundle: DOGMA_FIXTURE, hullTypeID: RIFTER_ID, modules: [{ key: 'low-0', typeID: fixtureTypeID('Warp Core Stabilizer II'), state }], incoming: [point] }).attribute('warpScrambleStatus');
    expect(status('online')).toBe(1);
    expect(status('active')).toBe(-1);
  });
});
