import { describe, expect, it } from 'vitest';
import { CapacitorFractionAfter, CapacitorModel, type CapacitorNumbers } from './capacitor';
import { RoundTrip } from './state-capture.spec-helper';

// A bare TFI with Capacitor Management V (6875 GJ) and a Rifter (312.5 GJ in 93.75 s).
const TFI: CapacitorNumbers = { capacity: 6875, rechargeTime: 1031.25, energyWarfareResistance: 1, remoteCapacitorImpedance: 1 };
const RIFTER: CapacitorNumbers = { capacity: 312.5, rechargeTime: 93.75, energyWarfareResistance: 1, remoteCapacitorImpedance: 1 };

describe('CapacitorFractionAfter', () => {
  it('matches stepping the recharge curve, and peaks at 25 %', () => {
    const { capacity, rechargeTime } = RIFTER;
    // Runge-Kutta at 0.01 s steps.
    const rate = (level: number): number => ((10 * capacity) / rechargeTime) * (Math.sqrt(level / capacity) - level / capacity);
    let level = 0.1 * capacity;
    const h = 0.01;
    for (let step = 0; step < 3000; step++) {
      const k1 = rate(level);
      const k2 = rate(level + (h / 2) * k1);
      const k3 = rate(level + (h / 2) * k2);
      const k4 = rate(level + h * k3);
      level += (h / 6) * (k1 + 2 * k2 + 2 * k3 + k4);
    }
    expect(CapacitorFractionAfter({ fraction: 0.1, seconds: 30, rechargeTime })).toBeCloseTo(level / capacity, 6);
    const dt = 1e-6;
    const peak = ((CapacitorFractionAfter({ fraction: 0.25, seconds: dt, rechargeTime }) - 0.25) * capacity) / dt;
    expect(peak).toBeCloseTo((2.5 * capacity) / rechargeTime, 3);
    expect(CapacitorFractionAfter({ fraction: 0, seconds: 10, rechargeTime })).toBeGreaterThan(0);
    expect(CapacitorFractionAfter({ fraction: 1, seconds: 10, rechargeTime })).toBe(1);
  });
});

describe('CapacitorModel', () => {
  it('starts full, drains and gives within its bounds, and recharges lazily', () => {
    const capacitor = new CapacitorModel();
    capacitor.Set('tfi', TFI, 100);
    expect(capacitor.Report('tfi', 100)).toEqual({ level: 6875, fraction: 1 });
    expect(capacitor.Drain('tfi', 600, 100)).toBe(600);
    expect(capacitor.Level('tfi', 100)).toBeCloseTo(6275, 9);
    expect(capacitor.Level('tfi', 110)).toBeCloseTo(6875 * CapacitorFractionAfter({ fraction: 6275 / 6875, seconds: 10, rechargeTime: TFI.rechargeTime }), 9);
    const before = capacitor.Level('tfi', 110) ?? 0;
    expect(capacitor.Give('tfi', 10_000, 110)).toBeCloseTo(6875 - before, 6);
    expect(capacitor.Level('tfi', 110)).toBeCloseTo(6875, 9);
    expect(capacitor.Give('tfi', 311, 110)).toBeCloseTo(0, 9);
    expect(capacitor.Drain('tfi', 1e9, 110)).toBeCloseTo(6875, 9);
    expect(capacitor.Drain('tfi', 10, 110)).toBe(0);
    expect(capacitor.Drain('nobody', 10, 110)).toBe(0);
    expect(capacitor.Report('nobody', 110)).toBeNull();
  });

  it('keeps the fraction when the numbers change', () => {
    const capacitor = new CapacitorModel();
    capacitor.Set('a', RIFTER, 0);
    capacitor.Drain('a', 156.25, 0);
    capacitor.Set('a', { ...RIFTER, capacity: 625 }, 0);
    expect(capacitor.Report('a', 0)).toEqual({ level: 312.5, fraction: 0.5 });
    capacitor.Remove('a');
    expect(capacitor.Has('a')).toBe(false);
  });

  it('nos drains only above the shooter level, never below it, unless overridden, and caps the gain', () => {
    const capacitor = new CapacitorModel();
    capacitor.Set('shooter', RIFTER, 0);
    capacitor.Set('target', TFI, 0);
    expect(capacitor.Nos('target', 'shooter', 120, false, 0)).toBe(0);
    capacitor.Drain('shooter', 300, 0);
    expect(capacitor.Nos('shooter', 'target', 120, false, 0)).toBe(120);
    expect(capacitor.Level('shooter', 0)).toBeCloseTo(132.5, 9);
    capacitor.Drain('target', (capacitor.Level('target', 0) ?? 0) - 200, 0);
    expect(capacitor.Nos('shooter', 'target', 120, false, 0)).toBeCloseTo(200 - 132.5, 9);
    // The target ends at the shooter's level before the cycle.
    expect(capacitor.Level('target', 0)).toBeCloseTo(132.5, 9);
    expect(capacitor.Level('shooter', 0)).toBeCloseTo(200, 9);
    expect(capacitor.Nos('shooter', 'target', 120, false, 0)).toBe(0);
    expect(capacitor.Nos('shooter', 'target', 120, true, 0)).toBe(120);
    expect(capacitor.Level('shooter', 0)).toBeCloseTo(312.5, 9);
    capacitor.Give('target', 1000, 0);
    expect(capacitor.Nos('shooter', 'target', 120, true, 0)).toBe(120);
    expect(capacitor.Level('shooter', 0)).toBeCloseTo(312.5, 9);
    expect(capacitor.Nos('shooter', 'nobody', 120, true, 0)).toBe(0);
  });
});

describe('CapacitorModel snapshots (sd-time)', () => {
  it('restores every level and its tick', () => {
    const capacitor = new CapacitorModel();
    capacitor.Set('tfi', TFI, 100);
    capacitor.Set('rifter', RIFTER, 100);
    capacitor.Drain('tfi', 600, 100);
    capacitor.Drain('rifter', 200, 104);
    const trip = RoundTrip(
      capacitor,
      (c) => [c.Report('tfi', 120), c.Report('rifter', 120), c.Numbers('tfi')],
      (c) => {
        c.Drain('tfi', 3000, 110);
        c.Give('rifter', 50, 111);
        c.Remove('tfi');
      }
    );
    expect(trip.mutated).not.toEqual(trip.before);
    expect(trip.after).toEqual(trip.before);
    expect(trip.again).toEqual(trip.snapshot);
  });
});
