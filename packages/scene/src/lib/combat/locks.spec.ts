import { describe, expect, it } from 'vitest';
import { createPilotContext, MAX_SKILLS_PILOT } from '../stats/pilot';
import { lockTime, pilotLockLimit, shipLockLimit } from './locks';

describe('lockTime', () => {
  it("gives EVE's lock times for the max-skills default fits", () => {
    expect(lockTime(825, 37)).toBeCloseTo(2.617, 3); // Rifter → Punisher
    expect(lockTime(800, 35)).toBeCloseTo(2.77, 3); // Punisher → Rifter
    expect(lockTime(243.75, 35)).toBeCloseTo(9.09, 2); // Ferox → Rifter
    expect(lockTime(155, 35)).toBeCloseTo(14.3, 2); // Megathron → Rifter
    expect(lockTime(825, 380)).toBeCloseTo(1.1, 2); // Rifter → Megathron
  });

  it('is Infinity when either number is not positive or finite', () => {
    expect(lockTime(0, 37)).toBe(Infinity);
    expect(lockTime(825, 0)).toBe(Infinity);
    expect(lockTime(-1, 37)).toBe(Infinity);
    expect(lockTime(Number.NaN, 37)).toBe(Infinity);
  });
});

describe('lock limits', () => {
  it('gives the max-skills pilot 12 and an untrained one 2', () => {
    expect(pilotLockLimit(MAX_SKILLS_PILOT)).toBe(12);
    expect(pilotLockLimit(createPilotContext())).toBe(2);
    expect(pilotLockLimit(createPilotContext({ skills: { 'Target Management': 3 } }))).toBe(5);
  });

  it("caps a ship's own limit by its pilot's", () => {
    expect(shipLockLimit({ maxLockedTargets: 4 }, MAX_SKILLS_PILOT)).toBe(4);
    expect(shipLockLimit({ maxLockedTargets: 16 }, MAX_SKILLS_PILOT)).toBe(12);
    expect(shipLockLimit({ maxLockedTargets: 7 }, createPilotContext())).toBe(2);
  });
});
