import { SceneError } from '@scene-director/scene';
import { describe, expect, it } from 'vitest';
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
    const error = await Caught(AnswerShipStats(shipData, { dna: 'nope', type: -3, stats: { mass: -1, speed: 2 }, propMod: 'warp', pilot: { skills: { Navigation: 6 } } }));
    expect(error).toBeInstanceOf(SceneError);
    expect((error as SceneError).problems).toEqual([
      'dna must be a SOF DNA string, hull:faction:race[:commands]',
      'type must be a positive integer type id or an EVE type name',
      'propMod must be "mwd", "ab", a module type id, or { speedFactor, speedBoostFactor, massAddition, signatureRadiusBonus? }',
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
    expect((error as ToolError).message).toBe("the hull's size is unknown; pass a module type id or explicit prop mod values");
  });
});
