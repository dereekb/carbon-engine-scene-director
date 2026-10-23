import { SceneError } from '@scene-director/scene';
import { describe, expect, it } from 'vitest';
import { MakeFakeDogmaData } from './dogma-data.testing';
import { ShipDataError } from './ship-data';
import { MakeFakeShipData, TFI_DNA } from './ship-data.testing';
import { AnswerShipStats } from './ship-stats-tool';
import { ToolError } from './tool-call';

const GUARDIAN_STATS = { mass: 11_980_000, maxVelocity: 209, agility: 0.61, signatureRadius: 70 };

async function Caught(action: Promise<unknown>): Promise<unknown> {
  return action.then(
    () => {
      throw new Error('expected the call to fail');
    },
    (error: unknown) => error
  );
}

describe('ship_stats', () => {
  it('a TFI by DNA with the MWD sized for its hull', async () => {
    const { shipData } = MakeFakeShipData();
    const answer = await AnswerShipStats(shipData, { dna: TFI_DNA, propMod: 'mwd' });
    expect(answer.hull).toMatchObject({ typeID: 17732, name: 'Tempest Fleet Issue', resolvedFrom: 'dna', candidates: [{ typeID: 90000 }] });
    expect(answer.pilot).toBe('max-skills');
    expect(answer.propMod).toMatchObject({ typeID: 12084, kind: 'microwarpdrive' });
    expect(answer.stats.maxVelocity).toBeCloseTo(162.5, 6);
    expect(answer.stats.propModActive).toBe(false);
    expect(answer.withPropMod?.mass).toBe(153_300_000);
    expect(answer.withPropMod?.maxVelocity).toBeCloseTo(1176.137476, 3);
    expect(answer.withPropMod?.signatureRadius).toBeCloseTo(2012.5, 6);
    expect(answer.withPropMod?.alignTime).toBeCloseTo(16.496782, 5);
  });

  it('a Guardian by type id with a 10MN AB II by module id; digit strings are ids', async () => {
    const { shipData } = MakeFakeShipData();
    const answer = await AnswerShipStats(shipData, { type: '11987', propMod: '12058' });
    expect(answer.hull.typeID).toBe(11987);
    expect(answer.hull.resolvedFrom).toBe('type');
    expect(answer.withPropMod?.maxVelocity).toBeCloseTo(650.701745, 3);
    expect(answer.withPropMod?.signatureRadius).toBe(70);
    expect(answer.withPropMod?.alignTime).toBeCloseTo(9.692298, 5);
  });

  it('all four stats need no tools-core, and explicit prop mod values work without a hull', async () => {
    const { shipData, calls } = MakeFakeShipData();
    const answer = await AnswerShipStats(shipData, { stats: GUARDIAN_STATS, propMod: { speedFactor: 510, speedBoostFactor: 1.5e7, massAddition: 5e6, signatureRadiusBonus: 475 } });
    expect(calls).toEqual([]);
    expect(answer.hull).toEqual({ resolvedFrom: 'stats', candidates: [], overrides: GUARDIAN_STATS });
    expect(answer.propMod?.kind).toBe('microwarpdrive');
    expect(answer.withPropMod?.maxVelocity).toBeCloseTo(1732.512147, 3);
  });

  it('falls back to complete stats when the SDE is unavailable', async () => {
    const { shipData } = MakeFakeShipData({ '/eve/latest/build': 'network-error' });
    const answer = await AnswerShipStats(shipData, { dna: TFI_DNA, stats: GUARDIAN_STATS });
    expect(answer.hull.resolvedFrom).toBe('stats');
    expect(answer.hull.note).toMatch(/unreachable/);
    expect(answer.stats.maxVelocity).toBeCloseTo(261.25, 6);
    expect(await Caught(AnswerShipStats(shipData, { dna: TFI_DNA }))).toBeInstanceOf(ShipDataError);
  });

  it('stats override the published values', async () => {
    const { shipData } = MakeFakeShipData();
    const answer = await AnswerShipStats(shipData, { type: 11987, stats: { maxVelocity: 100 } });
    expect(answer.hull.published?.maxVelocity).toBe(209);
    expect(answer.hull.overrides).toEqual({ maxVelocity: 100 });
    expect(answer.stats.maxVelocity).toBeCloseTo(125, 9);
  });

  it('bad arguments are a SceneError listing every problem', async () => {
    const { shipData } = MakeFakeShipData();
    const error = await Caught(AnswerShipStats(shipData, { dna: 'nope', type: -3, stats: { mass: -1, speed: 2 }, propMod: true, pilot: { skills: { Navigation: 6 } } }));
    expect(error).toBeInstanceOf(SceneError);
    expect((error as SceneError).problems).toEqual([
      'dna must be a SOF DNA string, hull:faction:race[:commands]',
      'type must be a positive integer type id or an EVE type name',
      'propMod must be "mwd", "ab", a module type id or name, or { speedFactor, speedBoostFactor, massAddition, signatureRadiusBonus?, duration? }',
      'stats.mass must be a positive number (kg)',
      'name the hull by dna or type, or give all four stats (mass, maxVelocity, agility, signatureRadius)',
      'pilot: skill "Navigation" must be a skill level, an integer from 0 to 5; got 6'
    ]);
  });

  it('a partial pilot flies the Guardian with a 50MN MWD II', async () => {
    const { shipData } = MakeFakeShipData();
    const answer = await AnswerShipStats(shipData, {
      type: 'Guardian',
      propMod: 12076,
      pilot: { name: 'partial', skills: { Navigation: 4, 'Evasive Maneuvering': 3, 'Spaceship Command': 5, 'Acceleration Control': 4 } }
    });
    expect(answer.pilot).toBe('partial');
    expect(answer.withPropMod?.maxVelocity).toBeCloseTo(1606.715194, 3);
    expect(answer.withPropMod?.agility).toBeCloseTo(0.46665, 9);
    expect(answer.withPropMod?.alignTime).toBeCloseTo(10.984604, 5);
  });

  it('a sized prop mod needs the hull size', async () => {
    const { shipData } = MakeFakeShipData();
    const error = await Caught(AnswerShipStats(shipData, { stats: GUARDIAN_STATS, propMod: 'ab' }));
    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).message).toBe("the hull's size is unknown; pass a module type id or name, or explicit prop mod values");
  });

  it('names a prop mod by its EVE name and reports its cycle time', async () => {
    const { shipData } = MakeFakeShipData();
    const coldGas = await AnswerShipStats(shipData, { dna: TFI_DNA, propMod: '500MN Cold-Gas Enduring Microwarpdrive' });
    expect(coldGas.propMod).toMatchObject({ typeID: 5945, duration: 10_000 });
    expect(coldGas.withPropMod?.maxVelocity).toBeCloseTo(1166.199853, 3);
    expect(coldGas.withPropMod?.signatureRadius).toBeCloseTo(2100, 6);
    expect(coldGas.withPropMod?.propModCycleTime).toBe(10);
    expect(coldGas.stats.propModCycleTime).toBeNull();
    expect((await AnswerShipStats(shipData, { type: 'Guardian', propMod: 'ab' })).withPropMod?.propModCycleTime).toBeCloseTo(7.5, 12);
    const unknown = await Caught(AnswerShipStats(shipData, { type: 'Guardian', propMod: '10MN Nothing II' }));
    expect(unknown).toBeInstanceOf(ShipDataError);
    expect((unknown as ShipDataError).failure).toBe('not-found');
    const none = await Caught(AnswerShipStats(shipData, { type: 'Guardian', propMod: 'none' }));
    expect((none as SceneError).problems).toEqual(['propMod "none" fits no prop mod; omit propMod instead']);
  });

  it('uses the built-in numbers of a baked prop mod when tools-core is unreachable', async () => {
    const { shipData } = MakeFakeShipData({ '/eve/latest/build': 'network-error' });
    const stats = { mass: 103_300_000, maxVelocity: 130, agility: 0.115, signatureRadius: 350 };
    for (const propMod of [12084, '500MN Microwarpdrive II']) {
      const answer = await AnswerShipStats(shipData, { stats, propMod });
      expect(answer.propMod).toMatchObject({ typeID: 12084, duration: 10_000 });
      expect(answer.withPropMod?.maxVelocity).toBeCloseTo(1176.137476, 3);
      expect(answer.propModNote).toMatch(/unreachable.*The built-in numbers of 500MN Microwarpdrive II \(SDE build 3632936\) were used\./su);
    }
    expect(((await Caught(AnswerShipStats(shipData, { stats, propMod: 'Some Odd MWD' }))) as ShipDataError).failure).toBe('unavailable');
  });
});

const GUARDIAN_FIT = ['[Guardian, test]', 'Damage Control II', 'Domination Thermal Armor Hardener', 'Damage Control II /OFFLINE', '', '10MN Afterburner II', 'Not A Module', '', 'Large Remote Armor Repairer II', '', '', 'Nanite Repair Paste x10'].join('\n');

describe('ship_stats with a fit', () => {
  it('flies the fit by dogma: the hull from its header, keyed modules, defense, the prop mod as withPropMod', async () => {
    const { shipData } = MakeFakeShipData();
    const answer = await AnswerShipStats(shipData, { fit: GUARDIAN_FIT }, MakeFakeDogmaData());
    expect(answer.hull).toMatchObject({ typeID: 11987, name: 'Guardian' });
    expect(answer.fit?.modules.map((module) => [module.key, module.category, module.offline ?? false, module.prop ?? false])).toEqual([
      ['low-0', 'damage-control', false, false],
      ['low-1', 'hardener', false, false],
      ['low-2', 'damage-control', true, false],
      ['mid-0', 'prop', false, true],
      ['mid-1', 'other', false, false],
      ['high-0', 'remote-armor-repairer', false, false]
    ]);
    expect(answer.fit?.unknown).toEqual(['Not A Module']);
    expect(answer.stats.math).toBe('dogma');
    expect(answer.stats.propModActive).toBe(false);
    expect(answer.stats.defense?.armor.resonances.em).toBeLessThan(0.5);
    expect(answer.stats.capacitor?.capacity).toBeGreaterThan(0);
    expect(answer.propMod).toMatchObject({ typeID: 12058 });
    // The fit's online modules change no flight number, so the AB flies as the table path's Guardian.
    expect(answer.withPropMod?.propModActive).toBe(true);
    expect(answer.withPropMod?.maxVelocity).toBeCloseTo(650.701745, 3);
    expect(answer.withPropMod?.mass).toBe(16_980_000);
    expect(answer.withPropMod?.propModCycleTime).toBe(7.5);
    expect(answer.trace).toBeUndefined();
  });

  it('runs the active modules by key, category or name, leaves offline ones off, and traces on request', async () => {
    const { shipData } = MakeFakeShipData();
    const dogmaData = MakeFakeDogmaData();
    const answer = await AnswerShipStats(shipData, { fit: GUARDIAN_FIT, active: ['hardener', 'damage control ii', 'high-0'], trace: true }, dogmaData);
    expect(answer.withActive?.modules).toEqual(['low-0', 'low-1', 'high-0']);
    expect(answer.activeNote).toBe('left off: low-2 Damage Control II (offline)');
    expect(answer.withActive?.stats.defense?.armor.resonances.thermal).toBeLessThan(answer.stats.defense?.armor.resonances.thermal ?? 0);
    expect(answer.withActive?.stats.capacitor?.drain).toBeGreaterThan(0);
    expect(answer.trace?.['armorThermalDamageResonance']?.map((step) => step.source)).toContain('Domination Thermal Armor Hardener (low-1)');
    const unmatched = await Caught(AnswerShipStats(shipData, { fit: GUARDIAN_FIT, active: ['scram'] }, dogmaData));
    expect(unmatched).toBeInstanceOf(ToolError);
    expect((unmatched as ToolError).message).toMatch(/no fitted module matches "scram"/u);
  });

  it("without the fit lookups flies the hull with the fit's prop mod, with a note", async () => {
    const { shipData } = MakeFakeShipData();
    const answer = await AnswerShipStats(shipData, { fit: GUARDIAN_FIT });
    expect(answer.stats.math).toBe('table');
    expect(answer.stats.defense).toBeNull();
    expect(answer.fit).toBeUndefined();
    expect(answer.fitNote).toMatch(/need the SDE/u);
    expect(answer.propMod).toMatchObject({ typeID: 12058 });
    expect(answer.withPropMod?.maxVelocity).toBeCloseTo(650.701745, 3);
  });

  it('refuses a fit with a propMod, active without a fit, and text that is no fit', async () => {
    const { shipData } = MakeFakeShipData();
    const problems = async (args: Record<string, unknown>) => ((await Caught(AnswerShipStats(shipData, args, MakeFakeDogmaData()))) as SceneError).problems;
    expect(await problems({ fit: GUARDIAN_FIT, propMod: 'mwd' })).toEqual(["propMod and fit do not go together: the fit's prop mod is the one it flies"]);
    expect(await problems({ type: 'Guardian', active: ['all'] })).toEqual(['active needs a fit']);
    expect(await problems({ type: 'Guardian', fit: 'Damage Control II' })).toEqual(['fit must be EFT text starting with "[Hull, Fit name]", at most 20000 characters']);
    expect(await problems({ fit: GUARDIAN_FIT, trace: 'yes' })).toEqual(['trace must be true or false']);
  });
});
