import { describe, expect, it } from 'vitest';
import { fitsPropMod, normalizeShipPropMod } from './prop-mod';

function normalize(input: unknown) {
  return normalizeShipPropMod({ input, where: 'ships[0].propMod' });
}

describe('normalizeShipPropMod', () => {
  it('reads the shorthand: a module name, a type id, a kind or none', () => {
    expect(normalize('50MN Microwarpdrive II')).toEqual({ propMod: { module: '50MN Microwarpdrive II' }, problems: [], warnings: [] });
    expect(normalize(12084).propMod).toEqual({ module: 12084 });
    expect(normalize('12084').propMod).toEqual({ module: 12084 });
    expect(normalize('MWD').propMod).toEqual({ module: 'mwd' });
    expect(normalize('Afterburner').propMod).toEqual({ module: 'ab' });
    expect(normalize('NONE').propMod).toEqual({ module: 'none' });
  });

  it('reads the object form, dropping active false and warning on unknown keys', () => {
    expect(normalize({ active: true, module: ' 10MN Afterburner II ' })).toEqual({ propMod: { module: '10MN Afterburner II', active: true }, problems: [], warnings: [] });
    expect(normalize({ active: true }).propMod).toEqual({ active: true });
    expect(normalize({ module: 'ab', active: false }).propMod).toEqual({ module: 'ab' });
    expect(normalize({ active: false })).toEqual({ propMod: null, problems: [], warnings: [] });
    expect(normalize({ module: 'ab', heat: 1 }).warnings).toEqual(['ships[0].propMod.heat is not a known field and was dropped']);
  });

  it('warns about a name that names no microwarpdrive or afterburner', () => {
    expect(normalize('Damage Control II').warnings).toEqual(['ships[0].propMod.module "Damage Control II" does not look like a microwarpdrive or an afterburner; the ship flies the hull-sized module of that kind if the EVE data does not know it']);
    expect(normalize('50MN MWD II').warnings).toEqual([]);
  });

  it('reports bad types and treats null as absent', () => {
    expect(normalize(null)).toEqual({ propMod: null, problems: [], warnings: [] });
    expect(normalize(undefined).propMod).toBeNull();
    expect(normalize(true).problems).toEqual(['ships[0].propMod must be a module (a name, a type id, "mwd", "ab" or "none") or an object { module?, active? }']);
    expect(normalize({ active: 'yes' }).problems).toEqual(['ships[0].propMod.active must be true or false']);
    expect(normalize({ module: -1 }).problems).toEqual(['ships[0].propMod.module must be a prop mod: an EVE module name of at most 100 characters, a type id, "mwd", "ab" or "none"']);
  });

  it('fits a prop mod unless the module is none', () => {
    expect(fitsPropMod(null)).toBe(true);
    expect(fitsPropMod({ active: true })).toBe(true);
    expect(fitsPropMod({ module: 'none' })).toBe(false);
  });
});
