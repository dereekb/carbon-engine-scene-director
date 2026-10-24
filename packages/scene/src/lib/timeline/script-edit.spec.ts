import { describe, expect, it } from 'vitest';
import { applySceneOperations, normalizeScene, type SceneDocument } from '../scene';
import { firstChangedStep, scriptChanged, scriptEditIsEmpty, scriptEditOf, withScriptOrders } from './script-edit';
import type { SceneShipStep } from './steps';

const RIFTER = 'mf1_t1:minmatarbase:minmatar';

const ORBIT: SceneShipStep = { type: 'orbit', target: 'b', range: 2500, duration: 30 } as SceneShipStep;
const STOP: SceneShipStep = { type: 'stop' } as SceneShipStep;
const WARP: SceneShipStep = { type: 'warp', point: [0, 0, 400_000] } as SceneShipStep;

function Scene(): SceneDocument {
  return normalizeScene({
    name: 'script',
    ships: [
      { id: 'a', dna: RIFTER, team: 'red', position: [0, 0, 0], orders: [ORBIT, STOP] },
      { id: 'b', dna: RIFTER, team: 'blue', position: [0, 0, 20_000] }
    ],
    timeline: {
      cues: [
        { id: 'go', at: 1, order_ship: { id: 'b', order: { type: 'stop' } } },
        { id: 'later', at: 10, order_ship: { id: 'a', order: { type: 'stop' } } }
      ]
    }
  }).scene;
}

function Edit(scene: SceneDocument, operations: unknown[]): SceneDocument {
  return applySceneOperations(scene, operations).scene;
}

describe('scriptEditOf (Movie mode M3)', () => {
  it('classifies cue edits: added, removed, changed (a retime), and the movie block', () => {
    const before = Scene();
    const after = Edit(before, [
      { op: 'add_cue', cue: { id: 'new', at: 4, order_ship: { id: 'b', order: { type: 'stop' } } } },
      { op: 'remove_cue', id: 'later' },
      { op: 'update_cue', id: 'go', set: { at: 6 } },
      { op: 'set_movie', movie: { end: 60 } }
    ]);
    const edit = scriptEditOf(before, after);
    expect(edit).toEqual({ cues: { added: ['new'], removed: ['later'], changed: ['go'] }, ships: [], movie: true });
    expect(edit && scriptEditIsEmpty(edit)).toBe(false);
    expect(scriptChanged(before, after)).toBe(true);
  });

  it("classifies a ship's orders with the first changed step", () => {
    const before = Scene();
    expect(scriptEditOf(before, Edit(before, [{ op: 'update_ship', id: 'a', set: { orders: [ORBIT, WARP] } }]))?.ships).toEqual([{ id: 'a', step: 1 }]);
    expect(scriptEditOf(before, Edit(before, [{ op: 'update_ship', id: 'a', set: { orders: null } }]))?.ships).toEqual([{ id: 'a', step: 0 }]);
    expect(scriptEditOf(before, Edit(before, [{ op: 'update_ship', id: 'b', set: { orders: [STOP] } }]))?.ships).toEqual([{ id: 'b', step: 0 }]);
  });

  it('is null for an edit mixing in anything else, and empty for an edit that changes nothing in the script', () => {
    const before = Scene();
    const mixed = Edit(before, [
      { op: 'add_cue', cue: { id: 'new', at: 4, order_ship: { id: 'b', order: { type: 'stop' } } } },
      { op: 'update_ship', id: 'b', set: { position: [0, 0, 30_000] } }
    ]);
    expect(scriptEditOf(before, mixed)).toBeNull();
    expect(scriptChanged(before, mixed)).toBe(true);
    const renamed = Edit(before, [{ op: 'update_ship', id: 'b', set: { name: 'Bob' } }]);
    expect(scriptEditOf(before, renamed)).toBeNull();
    expect(scriptChanged(before, renamed)).toBe(false);
    const same = scriptEditOf(before, Edit(before, [{ op: 'update_cue', id: 'go', set: { at: 1 } }]));
    expect(same && scriptEditIsEmpty(same)).toBe(true);
  });
});

describe('firstChangedStep', () => {
  it('is null when equal, the first different index, or the shorter length', () => {
    expect(firstChangedStep([ORBIT, STOP], [ORBIT, STOP])).toBeNull();
    expect(firstChangedStep(undefined, [])).toBeNull();
    expect(firstChangedStep([ORBIT, STOP], [ORBIT, WARP])).toBe(1);
    expect(firstChangedStep([ORBIT, STOP], [STOP])).toBe(0);
    expect(firstChangedStep([ORBIT], [ORBIT, STOP])).toBe(1);
    expect(firstChangedStep([ORBIT, STOP], [ORBIT])).toBe(1);
    expect(firstChangedStep(undefined, [STOP])).toBe(0);
    expect(firstChangedStep([STOP], null)).toBe(0);
  });
});

describe('withScriptOrders', () => {
  it("gives the live scene's authored ships their edited orders, keeping a live edit's own orders and the timeline's ships", () => {
    const before = Scene();
    const after = Edit(before, [
      { op: 'update_ship', id: 'a', set: { orders: [ORBIT, WARP] } },
      { op: 'update_ship', id: 'b', set: { orders: [STOP] } }
    ]);
    const { timeline: _timeline, ...live } = before;
    const swapped = withScriptOrders(live, before, after);
    expect(swapped.ships.map((ship) => [ship.id, ship.orders?.map((step) => step.type)])).toEqual([
      ['a', ['orbit', 'warp']],
      ['b', ['stop']]
    ]);
    expect(withScriptOrders(live, before, before)).toBe(live);
    // A patch cue gave b orders of its own and added "late": both keep theirs.
    const cued = Edit(live, [
      { op: 'update_ship', id: 'b', set: { orders: [WARP] } },
      { op: 'add_ship', ship: { id: 'late', dna: RIFTER, position: [0, 0, 5000], orders: [STOP] } }
    ]);
    const kept = withScriptOrders(cued, before, after);
    expect(kept.ships.map((ship) => [ship.id, ship.orders?.map((step) => step.type)])).toEqual([
      ['a', ['orbit', 'warp']],
      ['b', ['warp']],
      ['late', ['stop']]
    ]);
    // Orders cleared by the edit leave the live ship without any.
    const cleared = withScriptOrders(live, before, Edit(before, [{ op: 'update_ship', id: 'a', set: { orders: null } }]));
    expect(cleared.ships[0].orders).toBeUndefined();
  });
});
