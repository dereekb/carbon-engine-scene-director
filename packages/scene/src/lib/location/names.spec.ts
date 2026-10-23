import { describe, expect, it } from 'vitest';
import { JITA_CELESTIALS } from './dressing.spec-helper';
import { matchCelestialName, normalizeMapName } from './names';

describe('normalizeMapName', () => {
  it('trims, folds spaces and case, and NFKC-normalizes', () => {
    expect(normalizeMapName('  Jita IV  -\tMoon 4 ')).toBe('jita iv - moon 4');
    expect(normalizeMapName('Ｊｉｔａ')).toBe('jita');
  });
});

describe('matchCelestialName', () => {
  const match = (text: string) => {
    const found = matchCelestialName({ celestials: JITA_CELESTIALS, text, systemName: 'Jita' });
    return found && 'celestial' in found ? [found.celestial.id, found.rule] : (found?.candidates.map((celestial) => celestial.id) ?? null);
  };

  it('tries the exact name, the system-prefixed name, a star word, a gate shorthand, then a unique substring', () => {
    expect(match('jita iv - moon 4 - caldari navy assembly plant')).toEqual([60003760, 'exact']);
    expect(match('IV - Moon 4')).toEqual([40009087, 'prefixed']);
    expect(match('Star')).toEqual([40009076, 'prefixed']);
    expect(match('the sun')).toEqual([40009076, 'star']);
    expect(match('gate to Perimeter')).toEqual([50001249, 'gate']);
    expect(match('at the Business Tribunal')).toEqual([60003466, 'substring']);
  });

  it('lists the candidates of an ambiguous substring, and gives null for no match', () => {
    expect(match('Moon 6')).toEqual([40009089, 60004423]);
    expect(match('Amarr')).toBeNull();
  });
});
