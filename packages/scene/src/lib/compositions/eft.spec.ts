import { describe, expect, it } from 'vitest';
import { readEftHeader } from './eft';
import { normalizeFleetComposition } from './normalize';
import { RIFTER } from './compositions.spec-helper';

describe('readEftHeader', () => {
  it('reads a fit name with brackets', () => {
    expect(readEftHeader('[Tempest Fleet Issue, [FL33T] Tempest Fleet Issue]\n\nDamage Control II')).toEqual({ hull: 'Tempest Fleet Issue', name: '[FL33T] Tempest Fleet Issue' });
  });

  it('skips leading blank lines and reads Windows line endings', () => {
    expect(readEftHeader('\r\n  \r\n[Guardian, Logi]\r\nDamage Control II\r\n')).toEqual({ hull: 'Guardian', name: 'Logi' });
  });

  it('answers null for text that is not EFT', () => {
    expect(readEftHeader('Damage Control II\n[Guardian, Logi]')).toBeNull();
    expect(readEftHeader('')).toBeNull();
  });

  it('makes a fits value that is not EFT a problem', () => {
    const result = normalizeFleetComposition({ input: { id: 'x', commander: { dna: RIFTER }, fits: { bad: 'Damage Control II' } } });
    expect(result.problems).toEqual(['composition.fits.bad must be EFT text starting with a [Hull, Fit name] header']);
  });
});
