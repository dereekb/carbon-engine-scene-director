import { describe, expect, it } from 'vitest';
import { evaluateShipDogma } from './dogma';
import { BHAALGORN_ID, DOGMA_FIXTURE, fixtureTypeID, GUARDIAN_ID, RIFTER_ID, VINDICATOR_ID } from './fitting.spec-helper';
import { incomingModifiersOf, microwarpdriveBlockNoteOf, moduleTargetEffectOf, scaleModifierAmount, warpScrambleNoteOf } from './target-effects';

function targetEffects(hullTypeID: number, ...names: string[]) {
  const ship = evaluateShipDogma({ bundle: DOGMA_FIXTURE, hullTypeID, modules: names.map((name, index) => ({ key: `m-${index}`, typeID: fixtureTypeID(name), state: 'online' })) });
  return names.map((_name, index) => moduleTargetEffectOf(ship, DOGMA_FIXTURE, `m-${index}`));
}

describe('moduleTargetEffectOf', () => {
  it('reads webs and painters as code effects with their resistance, and the Vindicator bonus', () => {
    const [web, painter] = targetEffects(RIFTER_ID, 'Stasis Webifier II', 'Target Painter II');
    expect(web).toEqual({ effect: 'remoteWebifierFalloff', modifiers: [{ attributeID: 37, operation: 6, amount: -60 }], resistanceAttributeID: 2115 });
    // Signature Focusing V: +25 % on the painter's 30 %.
    expect(painter).toEqual({ effect: 'remoteTargetPaintFalloff', modifiers: [{ attributeID: 552, operation: 6, amount: 37.5 }], resistanceAttributeID: 2114 });
    const [navy] = targetEffects(VINDICATOR_ID, 'Federation Navy Stasis Webifier');
    expect(navy?.modifiers[0]?.amount).toBeCloseTo(-90, 9);
  });

  it('reads points and scrams from the SDE, skipping the NPC assign, and marks the MWD block', () => {
    const [scram, point] = targetEffects(RIFTER_ID, 'Warp Scrambler II', 'Warp Disruptor II');
    expect(scram).toEqual({ effect: 'warpScrambleBlockMWDWithNPCEffect', modifiers: [{ attributeID: 104, operation: 2, amount: 2 }], blocksMicrowarpdrive: true });
    expect(point).toEqual({ effect: 'warpDisrupt', modifiers: [{ attributeID: 104, operation: 2, amount: 1 }] });
  });

  it('reads neuts, nos and transmitters as capacitor transfers, with the Bhaalgorn nos override', () => {
    const [neut, nos, transmitter] = targetEffects(GUARDIAN_ID, 'Heavy Energy Neutralizer II', 'Heavy Energy Nosferatu II', 'Large Inductive Compact Remote Capacitor Transmitter');
    expect(neut).toEqual({ effect: 'energyNeutralizerFalloff', modifiers: [], resistanceAttributeID: 2045, capacitor: { kind: 'neut', amount: 600 } });
    expect(nos).toEqual({ effect: 'energyNosferatuFalloff', modifiers: [], resistanceAttributeID: 2045, capacitor: { kind: 'nos', amount: 120 } });
    expect(transmitter).toMatchObject({ effect: 'shipModuleRemoteCapacitorTransmitter', resistanceAttributeID: 6463, capacitor: { kind: 'transfer' } });
    expect(transmitter?.capacitor?.amount).toBeGreaterThan(0);
    const [bloodNos, bloodNeut] = targetEffects(BHAALGORN_ID, 'Heavy Energy Nosferatu II', 'Heavy Energy Neutralizer II');
    expect(bloodNos?.capacitor).toEqual({ kind: 'nos', amount: expect.closeTo(210, 9), override: true });
    expect(bloodNeut?.capacitor?.amount).toBeCloseTo(1050, 9);
  });

  it('gives nothing for remote reps and untargeted modules', () => {
    const [remote, plate] = targetEffects(GUARDIAN_ID, 'Large Remote Armor Repairer II', '200mm Steel Plates II');
    expect(remote).toBeNull();
    expect(plate).toBeNull();
  });
});

describe('incomingModifiersOf and scaleModifierAmount', () => {
  it('scales by effectiveness and labels the source', () => {
    const [web] = targetEffects(RIFTER_ID, 'Stasis Webifier II');
    const incoming = incomingModifiersOf([{ from: 'tackle', key: 'mid-0', name: 'Stasis Webifier II', effect: web!, effectiveness: 0.5 }]);
    expect(incoming).toEqual([{ source: 'tackle: Stasis Webifier II (mid-0)', effect: 'remoteWebifierFalloff', attributeID: 37, operation: 6, amount: -30, resistanceAttributeID: 2115 }]);
    expect(scaleModifierAmount(4, 0.5, 0.5)).toBe(0.75);
    expect(scaleModifierAmount(5, 2, 0.5)).toBeCloseTo(1 / 0.75, 12);
    expect(scaleModifierAmount(2, 2, 0.25)).toBe(0.5);
  });
});

describe('warpScrambleNoteOf and microwarpdriveBlockNoteOf', () => {
  it('names what pins a ship, and says when it can warp', () => {
    const steps = [
      { source: 'tackle: Warp Scrambler II (mid-1)', from: 0, to: 2 },
      { source: 'tfi-02: Warp Disruptor II (mid-0)', from: 2, to: 3 }
    ];
    expect(warpScrambleNoteOf({ status: 3, steps })).toBe('warp scramble status 3 (tackle: Warp Scrambler II (mid-1) +2, tfi-02: Warp Disruptor II (mid-0) +1): above 0 it cannot warp');
    expect(
      warpScrambleNoteOf({
        status: -1,
        steps: [
          { source: 'Warp Core Stabilizer II (low-0)', from: 0, to: -2 },
          { source: 'x: Warp Disruptor II (mid-0)', from: -2, to: -1 }
        ]
      })
    ).toBe('warp scramble status -1 (Warp Core Stabilizer II (low-0) -2, x: Warp Disruptor II (mid-0) +1): it can warp');
    expect(warpScrambleNoteOf({ status: 0, steps: [] })).toBeNull();
    expect(microwarpdriveBlockNoteOf(['tackle: Warp Scrambler II (mid-1)'])).toBe('a warp scrambler blocks its microwarpdrive (tackle: Warp Scrambler II (mid-1))');
    expect(microwarpdriveBlockNoteOf([])).toBeNull();
  });
});
