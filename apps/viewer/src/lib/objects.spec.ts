import { describe, expect, it } from 'vitest';
import type { CelestialTarget, SceneObject } from '@scene-director/scene';
import { NearestShips, ObjectBallRadius, ObjectReach, ObjectStateRow, ObjectsText, PlanCelestialTargetSync, TargetedBy, type ShipOrders } from './objects';

const ASTRA: SceneObject = { id: 'astra', dna: 'cm1_t1:upwell:generic', type: 'Astrahus', position: [0, 0, 100000], rotation: [90, 0, 0], radius: 45000 };

describe('objects', () => {
  it('takes the ball radius from the document, then the SOF, then the default', () => {
    expect(ObjectBallRadius({ radius: 45000, sofRadius: 21900 })).toEqual({ radius: 45000, from: 'document' });
    expect(ObjectBallRadius({ sofRadius: 21900 })).toEqual({ radius: 21900, from: 'sof' });
    expect(ObjectBallRadius({})).toEqual({ radius: 1000, from: 'default' });
  });

  it('reaches the farthest object and twice its larger radius', () => {
    expect(ObjectReach([])).toBe(0);
    expect(
      ObjectReach([
        { position: [0, 0, 100000], radius: 45000, sofRadius: 21900 },
        { position: [300000, 0, 0], sofRadius: 70 }
      ])
    ).toBe(300140);
  });

  it('lists the nearest ships surface to surface, negative inside, ties by id', () => {
    const ships = [
      { id: 'b', position: [0, 0, 50000] as [number, number, number], radius: 31 },
      { id: 'a', position: [0, 0, 150000] as [number, number, number], radius: 31 },
      { id: 'c', position: [0, 0, 100000] as [number, number, number], radius: 31 },
      { id: 'd', position: [0, 0, -100000] as [number, number, number], radius: 31 }
    ];
    expect(NearestShips({ position: [0, 0, 100000], radius: 45000, ships })).toEqual([
      { id: 'c', distance: -45031 },
      { id: 'a', distance: 4969 },
      { id: 'b', distance: 4969 }
    ]);
  });

  it('finds the ships targeting an object from pending and applied orders', () => {
    const orders = new Map<string, ShipOrders>([
      ['r1', { order: { type: 'orbit', target: 'astra', range: 5000, speed: 1 } }],
      ['r2', { order: { type: 'stop' }, pendingOrder: { type: 'approach', target: 'astra', speed: 1 } }],
      ['r3', { order: { type: 'warp', target: 'astra', range: 0 } }],
      ['r4', { order: { type: 'approach', target: 'other', speed: 1 } }]
    ]);
    expect(TargetedBy('astra', orders)).toEqual(['r1', 'r2', 'r3']);
    const row = ObjectStateRow({ object: ASTRA, entry: { status: 'ready', sofRadius: 21900.4 }, ball: { position: [0, 0, 100000], radius: 45000 }, ships: [], orders });
    expect(row).toEqual({ id: 'astra', type: 'Astrahus', dna: ASTRA.dna, status: 'ready', position: [0, 0, 100000], rotation: [90, 0, 0], radius: 45000, radiusFrom: 'document', sofRadius: 21900, distance: 100000, nearestShips: [], targetedBy: ['r1', 'r2', 'r3'] });
  });

  it('summarizes the overlay line', () => {
    expect(ObjectsText([])).toBeNull();
    expect(ObjectsText([{ status: 'ready' }, { status: 'building' }, { status: 'ready' }])).toBe('3 · 2 ready · 1 building');
  });

  it('re-syncs celestial targets only when the location key changes', () => {
    const targets: CelestialTarget[] = [{ target: 'celestial:1', id: 1, kind: 'station', name: 'CNAP', position: [0, 0, 0], radius: 100000, distance: 130000 }];
    expect(PlanCelestialTargetSync({ currentKey: 'k', current: ['celestial:1'], nextKey: 'k', targets })).toEqual({ remove: [], add: [] });
    expect(PlanCelestialTargetSync({ currentKey: 'k', current: ['celestial:1'], nextKey: 'j', targets })).toEqual({ remove: ['celestial:1'], add: targets });
    expect(PlanCelestialTargetSync({ currentKey: 'k', current: ['celestial:1'], nextKey: null, targets })).toEqual({ remove: ['celestial:1'], add: [] });
  });
});

describe('ObjectsText stand-ins', () => {
  it('counts stand-in objects', () => {
    expect(ObjectsText([{ status: 'stand-in' }, { status: 'stand-in' }, { status: 'ready' }])).toBe('3 · 1 ready · 2 stand-in');
  });
});
