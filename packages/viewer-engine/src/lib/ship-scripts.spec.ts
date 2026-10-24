import type { SceneShipStep, SceneVector, ShipOrderRequest } from '@scene-director/scene';
import { describe, expect, it } from 'vitest';
import { ShipScripts, type ShipScriptMotion, type ShipScriptsPort } from './ship-scripts';

interface FakeShip {
  motion: { order: object; pendingOrder?: object; orderNote?: string; speed: number; position: SceneVector; warp?: { phase: string } };
  alive: boolean;
  arriving: boolean;
  inWarp: boolean;
  refuse?: string;
}

class FakePort implements ShipScriptsPort {
  readonly ships = new Map<string, FakeShip>();
  readonly given: { id: string; order: ShipOrderRequest }[] = [];

  Add(id: string, position: SceneVector = [0, 0, 0]): FakeShip {
    const ship: FakeShip = { motion: { order: { type: 'stop' }, speed: 0, position }, alive: true, arriving: false, inWarp: false };
    this.ships.set(id, ship);
    return ship;
  }

  Order(id: string, order: ShipOrderRequest): object {
    const ship = this.Ship(id);
    if (ship.refuse) throw new Error(ship.refuse);
    this.given.push({ id, order });
    ship.motion.order = { ...order };
    delete ship.motion.orderNote;
    return { ...order };
  }

  Motion(id: string): ShipScriptMotion {
    return this.Ship(id).motion;
  }

  /**
   * As the director's: false only for a destroyed ship (a name or an object is alive).
   */
  Alive(id: string): boolean {
    return this.ships.get(id)?.alive ?? true;
  }

  Arriving(id: string): boolean {
    return this.Ship(id).arriving;
  }

  InWarp(id: string): boolean {
    return this.Ship(id).inWarp;
  }

  private Ship(id: string): FakeShip {
    const ship = this.ships.get(id);
    if (!ship) throw new Error(`no ship ${id}`);
    return ship;
  }
}

function Setup(orders: SceneShipStep[]): { port: FakePort; scripts: ShipScripts; ship: FakeShip; Run: (from: number, to: number, each?: (played: number) => void) => void; ships: { id: string; orders: SceneShipStep[] }[] } {
  const port = new FakePort();
  const ship = port.Add('a');
  const scripts = new ShipScripts(port);
  const ships = [{ id: 'a', orders }];
  const Run = (from: number, to: number, each?: (played: number) => void): void => {
    for (let played = from; played <= to; played++) {
      each?.(played);
      scripts.Step(played, ships);
    }
  };
  return { port, scripts, ship, Run, ships };
}

describe('ShipScripts', () => {
  it('waits after, gives the order, ends it after its duration and chains the next step', () => {
    const { port, scripts, Run } = Setup([
      { type: 'direction', direction: [0, 0, 1], speed: 1, after: 2, duration: 3 },
      { type: 'stop', after: 1 }
    ]);
    Run(0, 1);
    expect(port.given).toEqual([]);
    expect(scripts.Report('a', 1)).toMatchObject({ state: 'waiting', step: 0, steps: 2, startsIn: 1, order: 'direction' });
    Run(2, 2);
    expect(port.given.map(({ order }) => order.type)).toEqual(['direction']);
    expect(scripts.Report('a', 2)).toMatchObject({ state: 'flying', endsIn: 3 });
    Run(3, 4);
    expect(port.given).toHaveLength(1);
    Run(5, 5);
    expect(scripts.Report('a', 5)).toMatchObject({ state: 'waiting', step: 1, startsIn: 1 });
    Run(6, 6);
    expect(port.given.map(({ order }) => order.type)).toEqual(['direction', 'stop']);
    expect(port.given[0].order).not.toHaveProperty('after');
    expect(port.given[0].order).not.toHaveProperty('duration');
    Run(7, 7);
    expect(scripts.Report('a', 7)).toMatchObject({ state: 'done', step: 2 });
    expect(scripts.Counts()).toMatchObject({ ships: 1, done: 1 });
  });

  it('completes a warp on its own landing, not a landing it began with', () => {
    const { port, scripts, ship, Run } = Setup([{ type: 'warp', point: [0, 0, 500_000], range: 0 }, { type: 'stop' }]);
    ship.motion.warp = { phase: 'landed' };
    Run(0, 2);
    expect(scripts.Report('a', 2)).toMatchObject({ state: 'flying', step: 0 });
    ship.motion.warp = { phase: 'warping' };
    Run(3, 3);
    ship.motion.warp = { phase: 'landed' };
    Run(4, 4);
    expect(port.given.map(({ order }) => order.type)).toEqual(['warp', 'stop']);
  });

  it('ends a goto near its point and slow, or very close, and a stop once slow', () => {
    const { scripts, ship, Run } = Setup([{ type: 'goto', point: [0, 0, 20_000], speed: 1 }, { type: 'stop' }, { type: 'orbit', target: 'b', range: 500, speed: 1 }]);
    Run(0, 0);
    ship.motion.position = [0, 0, 19_500];
    ship.motion.speed = 50;
    Run(1, 1);
    expect(scripts.Report('a', 1)).toMatchObject({ state: 'flying', step: 0 });
    ship.motion.speed = 0.5;
    Run(2, 2);
    expect(scripts.Report('a', 2)).toMatchObject({ state: 'flying', step: 1 });
    ship.motion.speed = 2;
    Run(3, 3);
    expect(scripts.Report('a', 3)).toMatchObject({ step: 1 });
    ship.motion.speed = 0.2;
    Run(4, 4);
    expect(scripts.Report('a', 4)).toMatchObject({ state: 'holding', step: 2, order: 'orbit b' });
    expect(scripts.Settled()).toBe(true);
  });

  it('waits while arriving or in warp, then gives the order', () => {
    const { port, scripts, ship, Run } = Setup([{ type: 'stop' }]);
    ship.arriving = true;
    Run(0, 1);
    expect(scripts.Report('a', 1)).toMatchObject({ state: 'arriving' });
    ship.arriving = false;
    ship.inWarp = true;
    Run(2, 2);
    expect(scripts.Report('a', 2)).toMatchObject({ state: 'waiting', note: 'waits for its warp to land' });
    ship.inWarp = false;
    Run(3, 3);
    expect(port.given).toHaveLength(1);
    expect(scripts.Report('a', 3)).not.toHaveProperty('note');
    Run(4, 4);
    expect(scripts.Report('a', 4)).toMatchObject({ state: 'done' });
  });

  it('ends a step whose target is destroyed and goes on; skips a later step at the dead target', () => {
    const { port, scripts, ship, Run } = Setup([
      { type: 'orbit', target: 'b', range: 2500, speed: 1, duration: 30 },
      { type: 'approach', target: 'b', speed: 1, duration: 5 },
      { after: 2, type: 'stop' }
    ]);
    const target = port.Add('b');
    Run(0, 4);
    expect(scripts.Report('a', 4)).toMatchObject({ state: 'flying', step: 0, endsIn: 26 });
    target.alive = false;
    ship.motion.order = { type: 'stop' };
    ship.motion.orderNote = 'stopped: target "b" was destroyed';
    Run(5, 5);
    expect(scripts.Report('a', 5)).toMatchObject({ state: 'waiting', step: 2, startsIn: 2, note: 'step 1 (approach b) was skipped: its target was destroyed' });
    Run(6, 8);
    expect(port.given.map((given) => given.order.type)).toEqual(['orbit', 'stop']);
    expect(scripts.Report('a', 8)).toMatchObject({ state: 'done' });

    const ended = Setup([{ type: 'orbit', target: 'b', range: 2500, speed: 1, duration: 30 }, { type: 'stop' }]);
    const other = ended.port.Add('b');
    ended.Run(0, 0);
    other.alive = false;
    ended.ship.motion.order = { type: 'stop' };
    ended.ship.motion.orderNote = 'stopped: target "b" was destroyed';
    ended.Run(1, 1);
    expect(ended.scripts.Report('a', 1)).toMatchObject({ state: 'flying', step: 1, order: 'stop', note: 'step 0 (orbit b) ended: its target was destroyed' });
    ended.Run(2, 2);
    expect(ended.scripts.Report('a', 2)).toMatchObject({ state: 'done' });
  });

  it('fails on a refusal and on a dropped order, and is interrupted by another order', () => {
    const refused = Setup([{ type: 'approach', target: 'b', speed: 1 }]);
    refused.ship.refuse = 'no ship "b"';
    refused.Run(0, 0);
    expect(refused.scripts.Report('a', 0)).toMatchObject({ state: 'failed', note: 'step 0 (approach b) was refused: no ship "b"' });

    const dropped = Setup([{ type: 'approach', target: 'b', speed: 1, duration: 10 }]);
    dropped.Run(0, 0);
    dropped.ship.motion.order = { type: 'stop' };
    dropped.ship.motion.orderNote = 'stopped: target "b" was removed';
    dropped.Run(1, 1);
    expect(dropped.scripts.Report('a', 1)).toMatchObject({ state: 'failed', note: 'step 0 (approach b) was dropped: stopped: target "b" was removed' });

    const taken = Setup([{ type: 'orbit', target: 'b', range: 500, speed: 1 }]);
    taken.Run(0, 0);
    taken.ship.motion.pendingOrder = { type: 'stop' };
    taken.Run(1, 1);
    expect(taken.scripts.Report('a', 1)).toMatchObject({ state: 'interrupted' });
    expect(taken.scripts.Settled()).toBe(true);
  });

  it('marks a destroyed ship, drops a removed one, and restarts on an orders edit at the next tick', () => {
    const { port, scripts, ship, Run, ships } = Setup([{ type: 'stop', after: 5 }]);
    Run(0, 1);
    ships[0].orders = [{ type: 'direction', direction: [1, 0, 0], speed: 1, duration: 2 }];
    Run(2, 2);
    expect(port.given.map(({ order }) => order.type)).toEqual(['direction']);
    expect(scripts.Report('a', 2)).toMatchObject({ state: 'flying', note: 'its orders changed: restarted from step 0' });
    ship.alive = false;
    Run(3, 3);
    expect(scripts.Report('a', 3)).toMatchObject({ state: 'destroyed' });
    scripts.Step(4, []);
    expect(scripts.Report('a', 4)).toBeNull();
  });

  it('swaps the steps it has not reached in place: no restart, and the next step follows the new after (Movie mode M3)', () => {
    const { port, scripts, Run, ships } = Setup([
      { type: 'direction', direction: [0, 0, 1], speed: 1, duration: 3 },
      { type: 'stop', after: 1 }
    ]);
    Run(0, 1);
    const swapped: SceneShipStep[] = [ships[0].orders[0], { type: 'warp', point: [0, 0, 400_000], after: 4 } as SceneShipStep];
    expect(scripts.Swap('a', swapped)).toBe(true);
    expect(scripts.Swap('a', swapped)).toBe(false);
    expect(scripts.Swap('ghost', swapped)).toBe(false);
    ships[0].orders = swapped;
    Run(2, 3);
    expect(scripts.Report('a', 3)).toMatchObject({ state: 'waiting', step: 1, steps: 2, startsIn: 4, order: 'warp' });
    expect(scripts.Report('a', 3)?.note).toBeUndefined();
    Run(4, 7);
    expect(port.given.map(({ order }) => order.type)).toEqual(['direction', 'warp']);
  });

  it('snapshots and restores into a fresh instance that continues the same', () => {
    const first = Setup([
      { type: 'direction', direction: [0, 0, 1], speed: 1, duration: 3 },
      { type: 'stop', after: 2 }
    ]);
    first.Run(0, 1);
    const snapshot = first.scripts.Snapshot();
    const second = new ShipScripts(first.port);
    second.Restore(snapshot);
    expect(structuredClone(snapshot)).toEqual(snapshot);
    for (let played = 2; played <= 6; played++) second.Step(played, first.ships);
    expect(first.port.given.map(({ order }) => order.type)).toEqual(['direction', 'stop']);
    expect(second.Report('a', 6)).toMatchObject({ state: 'done' });
  });
});
