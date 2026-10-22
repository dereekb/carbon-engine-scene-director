import { describe, expect, it } from 'vitest';
import { normalizeFleetComposition } from '../compositions/normalize';
import { normalizeStagingShipLines, numberShipIds, toIdSlug, toShipListComposition } from './ships';
import { GUARDIAN, TFI } from './staging.spec-helper';

describe('toIdSlug', () => {
  it('slugs names', () => {
    expect(toIdSlug('Tempest Fleet Issue')).toBe('tempest-fleet-issue');
    expect(toIdSlug('Æon ~ Ève!')).toBe('on-eve');
    expect(toIdSlug('x'.repeat(80))).toHaveLength(56);
    expect(toIdSlug('!!!')).toBe('ship');
    expect(toIdSlug('', 'side')).toBe('side');
  });
});

describe('numberShipIds', () => {
  it('continues after the highest number in use', () => {
    const problems: string[] = [];
    expect(numberShipIds({ prefix: 'rifter', count: 2, ids: ['rifter-01', 'rifter-07', 'rifter-x', 'other-09'], where: 'op', problems }).ids).toEqual(['rifter-08', 'rifter-09']);
    expect(numberShipIds({ prefix: 'rifter', count: 3, ids: ['rifter-98'], where: 'op', problems })).toEqual({ ids: ['rifter-099', 'rifter-100', 'rifter-101'], numbers: [99, 100, 101] });
    expect(problems).toEqual([]);
  });

  it('refuses ids over 64 characters', () => {
    const problems: string[] = [];
    expect(numberShipIds({ prefix: 'p'.repeat(63), count: 1, ids: [], where: 'op', problems }).ids).toEqual([]);
    expect(problems[0]).toMatch(/longer than 64/u);
  });
});

describe('toShipListComposition', () => {
  const tfi = { hull: 'Tempest Fleet Issue', dna: TFI, radius: 250 };

  it('makes the first ship the FC and each line a squad', () => {
    const candidate = toShipListComposition({
      id: 'red',
      lines: [
        { ...tfi, count: 3 },
        { hull: 'Guardian', dna: GUARDIAN, radius: 80, count: 2, role: 'logi' },
        { ...tfi, count: 2 }
      ]
    });
    const { composition, problems } = normalizeFleetComposition({ input: candidate });
    expect(problems).toEqual([]);
    expect(composition?.commander).toEqual({ hull: 'Tempest Fleet Issue', dna: TFI, radius: 250 });
    expect(composition?.wings[0].squads.map((squad) => [squad.id, squad.role, squad.ships[0].count])).toEqual([
      ['dps', 'dps', 2],
      ['logi', 'logi', 2],
      ['dps-2', 'dps', 2]
    ]);
  });

  it('drops the first squad at one ship', () => {
    expect(toShipListComposition({ id: 'solo', lines: [{ ...tfi, count: 1 }] })['wings']).toBeUndefined();
    const two = normalizeFleetComposition({ input: toShipListComposition({ id: 'two', lines: [tfi, { ...tfi, role: 'tackle' }] }) }).composition;
    expect(two?.wings[0].squads.map((squad) => squad.id)).toEqual(['tackle']);
  });
});

describe('normalizeStagingShipLines', () => {
  it('refuses lines without dna, bad counts and roles, and too many ships', () => {
    const where = 'sides[1].ships';
    const read = (input: unknown) => normalizeStagingShipLines({ input, where, tool: 'stage_engagement' }).problems;
    expect(read([{ hull: 'Ferox' }])[0]).toBe('sides[1].ships[0]: hull "Ferox" has no dna. The stage_engagement tool resolves hull names to DNA through tools-core; patch_scene needs every ship line\'s dna.');
    expect(read([{ dna: TFI, count: 0 }])).toHaveLength(1);
    expect(
      read([
        { dna: TFI, count: 200 },
        { dna: TFI, count: 57 }
      ])[0]
    ).toMatch(/257 ships/u);
    expect(read([{ dna: TFI, role: 'healer' }])[0]).toMatch(/role must be one of/u);
    expect(read([])).toHaveLength(1);
  });
});

describe('toShipListComposition fits', () => {
  it('keys line fits by a slug of their fit name, numbered when two texts share one', () => {
    const a = '[Rifter, Tackle]\nWarp Scrambler II';
    const b = '[Rifter, Tackle]\nStasis Webifier II';
    const candidate = toShipListComposition({
      id: 'x',
      lines: [
        { dna: TFI, fit: a },
        { dna: TFI, fit: b, count: 2 },
        { dna: GUARDIAN, fit: a }
      ]
    });
    expect(candidate['fits']).toEqual({ tackle: a, 'tackle-2': b });
    const composition = normalizeFleetComposition({ input: candidate }).composition;
    expect([composition?.commander.fit, ...(composition?.wings[0].squads.map((squad) => squad.ships[0].fit) ?? [])]).toEqual(['tackle', 'tackle-2', 'tackle']);
  });
});
