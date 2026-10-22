import { describe, expect, it } from 'vitest';
import { readEftHeader, readEftPropMod } from './eft';
import { normalizeFleetComposition } from './normalize';
import { RIFTER, tfisComposition, TFIS_FIT_KEYS } from './compositions.spec-helper';

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

describe('readEftPropMod', () => {
  it('finds the prop mod of each TFIs fit, the one its line names', () => {
    const composition = tfisComposition();
    const expected: Record<string, string | null> = {
      tfi: '500MN Cold-Gas Enduring Microwarpdrive',
      zarmazd: '50MN Cold-Gas Enduring Microwarpdrive',
      guardian: '10MN Afterburner II',
      revelation: null,
      damnation: '50MN Quad LiF Restrained Microwarpdrive',
      eos: '50MN Quad LiF Restrained Microwarpdrive',
      bhaalgorn: '500MN Quad LiF Restrained Microwarpdrive',
      vindicator: '500MN Quad LiF Restrained Microwarpdrive',
      devoter: '50MN Quad LiF Restrained Microwarpdrive',
      'apostle-active': null,
      thanatos: '10000MN Monopropellant Enduring Afterburner',
      nidhoggur: '10000MN Monopropellant Enduring Afterburner',
      archon: '10000MN Monopropellant Enduring Afterburner'
    };
    expect(Object.keys(expected)).toEqual(TFIS_FIT_KEYS);
    for (const key of TFIS_FIT_KEYS) expect(readEftPropMod(composition.fits?.[key] ?? '')).toBe(expected[key]);
  });

  it('skips cargo, empty slots and the header, and drops charges and /OFFLINE', () => {
    expect(readEftPropMod('[Rifter, 10MN Afterburner II]\n10MN Afterburner II x1\n[Empty Med slot]\n')).toBeNull();
    expect(readEftPropMod('[Rifter, x]\n\n5MN Microwarpdrive II /OFFLINE\n1MN Afterburner II')).toBe('5MN Microwarpdrive II');
    expect(readEftPropMod('[Rifter, x]\n1MN Afterburner II, Some Charge\n')).toBe('1MN Afterburner II');
    expect(readEftPropMod('')).toBeNull();
  });
});
