import { describe, expect, it } from 'vitest';
import { candidateRangesOf, envelopePointOf } from './envelope';
import { idealRangeOf, STANCE_RISK } from './ideal';
import { CARACAL_PROFILE, contactOf, MEGATHRON_PROFILE, PUNISHER_PROFILE, RIFTER_PROFILE, STASIS_WEBIFIER_RANGE, WARP_DISRUPTOR_RANGE, WARP_SCRAMBLER_RANGE } from './piloting.spec-helper';

const PUNISHER = contactOf({ id: 'punisher', profile: PUNISHER_PROFILE, propModOn: true });

const RIFTER = contactOf({ id: 'rifter', profile: RIFTER_PROFILE, position: [0, 0, 20_000], propModOn: true });

describe('idealRangeOf', () => {
  it('kites a Punisher with an MWD Rifter at 10-11 km (out ~50 / in ~7 dps), still winning from 9 to 14 km', () => {
    const ideal = idealRangeOf({ self: RIFTER, focus: PUNISHER, hostiles: [PUNISHER], type: 'kite', propMods: 'always' });
    expect(ideal).toMatchObject({ type: 'kite', propMod: true, dictates: 'self', dictated: false, disengage: false, constrained: false });
    expect(ideal?.ideal).toBeGreaterThanOrEqual(10_000);
    expect(ideal?.ideal).toBeLessThanOrEqual(11_000);
    expect(ideal?.out).toBeGreaterThan(40);
    expect(ideal?.in).toBeLessThan(8);
    expect(ideal?.window[0]).toBeGreaterThanOrEqual(9000);
    expect(ideal?.window[1]).toBeLessThanOrEqual(14_000);
    for (const range of [9000, 11_000, 12_000, 13_000, 14_000]) {
      const point = envelopePointOf({ self: RIFTER, focus: PUNISHER, hostiles: [PUNISHER], range, posture: 'orbit', propMod: true });
      expect((point?.killRate ?? 0) - STANCE_RISK.kite * (point?.deathRate ?? 0), `${range}`).toBeGreaterThan(0);
    }
    expect(ideal?.ordered).toBeLessThanOrEqual(ideal?.ideal ?? 0);
  });

  it('loses the trade inside ~7 km: at 4 km the Punisher applies as much as the Rifter (~100 dps each)', () => {
    for (const range of [4000, 6000, 7000]) {
      const point = envelopePointOf({ self: RIFTER, focus: PUNISHER, hostiles: [PUNISHER], range, posture: 'orbit', propMod: true });
      expect((point?.killRate ?? 0) - STANCE_RISK.kite * (point?.deathRate ?? 0), `${range}`).toBeLessThan(0);
    }
    const point = envelopePointOf({ self: RIFTER, focus: PUNISHER, hostiles: [PUNISHER], range: 4000, posture: 'orbit', propMod: true });
    expect(point?.out).toBeGreaterThan(95);
    expect(point?.in).toBeGreaterThan(95);
  });

  it('kites outside a scram and web + 1.5 km', () => {
    const tackled = contactOf({ id: 'punisher', profile: { ...PUNISHER_PROFILE, tackle: { scram: WARP_SCRAMBLER_RANGE, web: STASIS_WEBIFIER_RANGE } }, propModOn: true });
    const ideal = idealRangeOf({ self: RIFTER, focus: tackled, hostiles: [tackled], type: 'kite' });
    expect(ideal?.window[0]).toBeGreaterThan(STASIS_WEBIFIER_RANGE + 1500);
    expect(ideal?.constrained).toBe(false);
  });

  it('tackles inside its point', () => {
    const tackler = contactOf({ id: 'rifter', profile: { ...RIFTER_PROFILE, tackle: { point: WARP_DISRUPTOR_RANGE } }, position: [0, 0, 30_000], propModOn: true });
    const ideal = idealRangeOf({ self: tackler, focus: PUNISHER, hostiles: [PUNISHER], type: 'tackle' });
    expect(ideal?.type).toBe('tackle');
    expect(ideal?.window[1]).toBeLessThanOrEqual(0.9 * WARP_DISRUPTOR_RANGE);
  });

  it('kites a Megathron with a Caracal at ~42-70 km and dictates (it is faster)', () => {
    const caracal = contactOf({ id: 'caracal', profile: CARACAL_PROFILE, position: [0, 0, 60_000], propModOn: true });
    const megathron = contactOf({ id: 'megathron', profile: MEGATHRON_PROFILE, propModOn: true });
    const ideal = idealRangeOf({ self: caracal, focus: megathron, hostiles: [megathron], type: 'kite' });
    expect(ideal).toMatchObject({ dictates: 'self', dictated: false });
    expect(ideal?.window[0]).toBeGreaterThanOrEqual(42_000);
    expect(ideal?.window[1]).toBeLessThanOrEqual(CARACAL_PROFILE.lockRange);
    expect(ideal?.ideal).toBeGreaterThan(50_000);
    expect(ideal?.out).toBeGreaterThan(160);
    const auto = idealRangeOf({ self: caracal, focus: megathron, hostiles: [megathron], type: 'auto' });
    expect(['kite', 'snipe']).toContain(auto?.type);
    expect(auto?.why).toMatch(/^auto picks/);
  });

  it("flies a Rifter under a still Megathron's guns with its MWD off", () => {
    const rifter = contactOf({ id: 'rifter', profile: RIFTER_PROFILE, position: [0, 0, 5000] });
    const megathron = contactOf({ id: 'megathron', profile: MEGATHRON_PROFILE });
    const ideal = idealRangeOf({ self: rifter, focus: megathron, hostiles: [megathron], type: 'brawl' });
    expect(ideal).toMatchObject({ type: 'brawl', posture: 'orbit', propMod: false });
    expect(ideal?.ideal).toBeLessThanOrEqual(1500);
    expect(ideal?.in).toBeLessThan(1);
    expect(ideal?.out).toBeGreaterThan(110);
  });

  it('lets a faster focus dictate, and disengages when the trade there is lost', () => {
    const megathron = contactOf({ id: 'megathron', profile: MEGATHRON_PROFILE, position: [0, 0, 10_000], propModOn: true });
    const caracal = contactOf({ id: 'caracal', profile: CARACAL_PROFILE, propModOn: true });
    const ideal = idealRangeOf({ self: megathron, focus: caracal, hostiles: [caracal], type: 'brawl' });
    expect(ideal).toMatchObject({ dictates: 'focus', dictated: true, disengage: true });
    expect(ideal?.ideal).toBeGreaterThan(40_000);
    expect(ideal?.why).toMatch(/caracal is faster/);
  });

  it('weighs only the ranges it can lock, with every breakpoint', () => {
    const ranges = candidateRangesOf({ self: RIFTER, focus: PUNISHER, hostiles: [PUNISHER] });
    expect(Math.max(...ranges)).toBeLessThanOrEqual(RIFTER_PROFILE.lockRange);
    expect(ranges).toContain(750 + 9675);
    expect(ranges).toContain(Math.round(3937.5 + 3125));
  });
});
