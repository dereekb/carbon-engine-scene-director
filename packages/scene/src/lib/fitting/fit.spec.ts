import { describe, expect, it } from 'vitest';
import { chooseSceneFitKey, FIT_KEY_PATTERN, fitTextOf, isInlineFit, normalizeShipFit, shipPropModModuleOf } from './fit';

const FIT = '[Rifter, Tackle]\nDamage Control II\n\n1MN Afterburner II';

describe('fit keys and values', () => {
  it('takes one or two id segments as a key', () => {
    expect(['tfi', 'tfis/tfi', 'a.b-c_d/e'].every((key) => FIT_KEY_PATTERN.test(key))).toBe(true);
    expect(['', 'a/b/c', '/a', 'a/', 'a b', 'x'.repeat(65)].some((key) => FIT_KEY_PATTERN.test(key))).toBe(false);
  });

  it('tells inline text from a key and reads the text a ship uses', () => {
    expect(isInlineFit('  [Rifter, x]')).toBe(true);
    expect(isInlineFit('tfis/tfi')).toBe(false);
    expect(fitTextOf({ fit: 'tackle' }, { fits: { tackle: FIT } })).toBe(FIT);
    expect(fitTextOf({ fit: FIT }, {})).toBe(FIT);
    expect(fitTextOf({ fit: 'gone' }, {})).toBeNull();
    expect(fitTextOf({}, { fits: { tackle: FIT } })).toBeNull();
  });

  it('refuses a value that is neither text with a header nor a key', () => {
    expect(normalizeShipFit({ input: 'not a key!', where: 'f', fits: null }).problems).toEqual(['f "not a key!" is neither EFT text (starting with a [Hull, Fit name] header) nor a fit key (1-64 letters, digits, "_", "-" or ".", optionally twice with one "/" between)']);
    expect(normalizeShipFit({ input: 3, where: 'f', fits: null }).problems).toEqual(["f must be EFT fit text or a key of the scene's fits"]);
    expect(normalizeShipFit({ input: '[Rifter x]', where: 'f', fits: null }).problems).toEqual(['f must be EFT text starting with a [Hull, Fit name] header']);
  });
});

describe('the prop mod a fitted ship flies', () => {
  it("is propMod.module, else the fit's first MWD or AB, else none for a fit, else the hull-sized MWD", () => {
    expect(shipPropModModuleOf({ propMod: { module: 'ab' } }, FIT)).toBe('ab');
    expect(shipPropModModuleOf({}, FIT)).toBe('1MN Afterburner II');
    expect(shipPropModModuleOf({}, '[Rifter, x]\nDamage Control II')).toBe('none');
    expect(shipPropModModuleOf({}, null)).toBe('mwd');
  });
});

describe('chooseSceneFitKey', () => {
  it('reuses a key holding the same text, falls to the next prefix, then numbers the first', () => {
    expect(chooseSceneFitKey({ fits: null, prefixes: ['tfis', 'tfis-2'], key: 'tfi', text: FIT })).toBe('tfis/tfi');
    expect(chooseSceneFitKey({ fits: { 'tfis/tfi': FIT }, prefixes: ['tfis', 'tfis-2'], key: 'tfi', text: FIT })).toBe('tfis/tfi');
    expect(chooseSceneFitKey({ fits: { 'tfis/tfi': 'other' }, prefixes: ['tfis', 'blue'], key: 'tfi', text: FIT })).toBe('blue/tfi');
    expect(chooseSceneFitKey({ fits: { 'tfis/tfi': 'other' }, prefixes: ['tfis', 'tfis'], key: 'tfi', text: FIT })).toBe('tfis-2/tfi');
  });
});
