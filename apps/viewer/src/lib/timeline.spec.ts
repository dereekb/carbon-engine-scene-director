import type { SceneCue, SceneShipStep, ShipOrderRequest } from '@scene-director/scene';
import { describe, expect, it } from 'vitest';
import { ShipScripts, type ShipScriptsPort } from './ship-scripts';
import { DescribeWaiting, TIMELINE_PREPARE_LIMIT_SECONDS, TimelinePlayer, type CueFireResult, type TimelinePort, type TimelineSettled } from './timeline';

function OrderCue(id: string, at: number): SceneCue {
  return { id, at, order_ship: { id: 'a', order: { type: 'stop' } } } as SceneCue;
}

function ShotCue(id: string, at: number): SceneCue {
  return { id, at, play_shot: { shot: 'hero', ship: 'a' } } as SceneCue;
}

class FakePort implements TimelinePort {
  readonly fired: string[] = [];
  readonly log: string[] = [];
  readonly failing = new Set<string>();
  skip: Maybe<string> = null;
  settled: TimelineSettled = { settled: false, waiting: { builds: 2, lookups: 1 } };
  held = false;
  now = 0;

  Fire(cue: SceneCue, { boundary }: { readonly boundary: number }): CueFireResult {
    this.log.push(`cue ${cue.id}`);
    if (this.failing.has(cue.id)) throw new Error(`${cue.id} refused`);
    this.fired.push(`${cue.id}@${boundary}`);
    return this.skip ? { state: 'skipped', note: this.skip } : { state: 'fired', result: { ok: cue.id } };
  }

  Settled(): TimelineSettled {
    return this.settled;
  }

  HoldClock(held: boolean): void {
    this.held = held;
  }

  Now(): number {
    return this.now;
  }
}

type Maybe<T> = T | null | undefined;

class FakeShips implements ShipScriptsPort {
  constructor(private readonly log: string[]) {}

  Order(id: string, order: ShipOrderRequest): object {
    this.log.push(`step ${id} ${order.type}`);
    return order;
  }

  Motion(): { order: object; speed: number; position: [number, number, number] } {
    return { order: { type: 'other' }, speed: 0, position: [0, 0, 0] };
  }

  Alive(): boolean {
    return true;
  }

  Arriving(): boolean {
    return false;
  }

  InWarp(): boolean {
    return false;
  }
}

function Setup(cues: SceneCue[], ships: { id: string; orders?: SceneShipStep[] }[] = []): { port: FakePort; player: TimelinePlayer; Run: (ticks: number) => void; tick: () => number } {
  const port = new FakePort();
  const player = new TimelinePlayer({ port, scripts: new ShipScripts(new FakeShips(port.log)) });
  let boundary = 100;
  player.Load(cues, cues.length > 0 || ships.some((ship) => ship.orders?.length));
  const Run = (ticks: number): void => {
    for (let index = 0; index < ticks; index++) {
      player.Frame();
      if (!port.held) player.Boundary(boundary, boundary * 10, ships);
      boundary += 1;
    }
  };
  return { port, player, Run, tick: () => boundary };
}

describe('TimelinePlayer', () => {
  it('holds the clock while preparing and releases it once settled; t = 0 is the next boundary', () => {
    const { port, player, Run, tick } = Setup([OrderCue('go', 0), OrderCue('later', 2.5)]);
    expect(player.state).toBe('preparing');
    expect(port.held).toBe(true);
    Run(3);
    expect(port.fired).toEqual([]);
    expect(player.Summary()).toMatchObject({ state: 'preparing', preparing: { waiting: { builds: 2, lookups: 1 } } });
    port.settled = { settled: true, waiting: {} };
    const start = tick();
    Run(4);
    expect(port.held).toBe(false);
    expect(port.fired).toEqual([`go@${start}`, `later@${start + 3}`]);
    expect(player.Summary()).toMatchObject({ state: 'done', time: 3, startedAt: start, cues: { total: 2, fired: 2, pending: 0 } });
  });

  it('starts anyway after the cap with a note, and a paused load ends its prepare in ready, held at t = 0', () => {
    const capped = Setup([OrderCue('go', 1)]);
    capped.port.now = TIMELINE_PREPARE_LIMIT_SECONDS * 1000;
    capped.Run(1);
    expect(capped.player.Summary()).toMatchObject({ state: 'playing', note: 'started after 60 s with 2 builds and 1 lookup pending: this run may differ' });

    const paused = Setup([OrderCue('go', 0)]);
    paused.player.Load([OrderCue('go', 0)], true, { paused: true });
    paused.port.settled = { settled: true, waiting: {} };
    paused.Run(3);
    expect(paused.player.state).toBe('ready');
    expect(paused.port.held).toBe(true);
    expect(paused.port.fired).toEqual([]);
    paused.player.Play();
    expect(paused.port.held).toBe(false);
    const start = paused.tick();
    paused.Run(1);
    expect(paused.port.fired).toEqual([`go@${start}`]);
  });

  it('steps the scripts first, then fires due cues in document order, each on the first tick at or after its time', () => {
    const { port, Run } = Setup([OrderCue('b', 0.5), OrderCue('a', 2), OrderCue('c', 2)], [{ id: 'a', orders: [{ type: 'stop', after: 2 }] }]);
    port.settled = { settled: true, waiting: {} };
    Run(4);
    expect(port.log).toEqual(['cue b', 'step a stop', 'cue a', 'cue c']);
    expect(DescribeWaiting({ builds: 3, lookups: 0, fleets: 1 })).toBe('3 builds and 1 fleet');
  });

  it('records a throwing lever as failed once, and a skipped one with its note', () => {
    const { port, player, Run } = Setup([OrderCue('bad', 0), OrderCue('ok', 1)]);
    port.settled = { settled: true, waiting: {} };
    port.failing.add('bad');
    Run(1);
    port.skip = "the camera is claude's";
    Run(3);
    expect(port.log.filter((line) => line === 'cue bad')).toHaveLength(1);
    const summary = player.Summary();
    expect(summary).toMatchObject({ cues: { failed: 1, skipped: 1 }, failed: [{ id: 'bad', error: 'bad refused' }] });
    expect(summary?.last?.[0]).toMatchObject({ id: 'ok', state: 'skipped', note: "the camera is claude's" });
  });

  it('pauses the cursor so later cues shift, and plays on', () => {
    const { port, player, Run, tick } = Setup([OrderCue('a', 0), OrderCue('b', 4)]);
    port.settled = { settled: true, waiting: {} };
    const start = tick();
    Run(2);
    player.Pause();
    Run(5);
    expect(port.fired).toEqual([`a@${start}`]);
    expect(player.Summary()).toMatchObject({ state: 'paused', time: 1 });
    player.Play();
    Run(3);
    expect(port.fired).toEqual([`a@${start}`, `b@${start + 2 + 5 + 2}`]);
  });

  it('takes edits: a cue in the past is missed, a pending one follows, a fired one keeps its record', () => {
    const { port, player, Run, tick } = Setup([OrderCue('a', 0), OrderCue('b', 5)]);
    port.settled = { settled: true, waiting: {} };
    const start = tick();
    Run(3);
    player.Edit([{ ...OrderCue('a', 0), name: 'renamed' } as SceneCue, OrderCue('b', 6), OrderCue('old', 1), OrderCue('new', 8)], true);
    const report = player.Report();
    expect(report?.list.map(({ id, state, note }) => ({ id, state, note }))).toEqual([
      { id: 'a', state: 'fired', note: 'edited after it fired: the edit plays on a restart' },
      { id: 'b', state: 'pending', note: undefined },
      { id: 'old', state: 'missed', note: 'added after its time: it plays from the next restart' },
      { id: 'new', state: 'pending', note: undefined }
    ]);
    player.Edit([OrderCue('b', 6), OrderCue('new', 8)], true);
    expect(player.Report()?.list.find(({ id }) => id === 'a')).toMatchObject({ state: 'fired', note: 'removed after it fired' });
    expect(player.Summary()?.cues.total).toBe(2);
    Run(6);
    expect(port.fired).toEqual([`a@${start}`, `b@${start + 6}`, `new@${start + 8}`]);
    expect(player.Summary()?.state).toBe('done');
    player.Edit([OrderCue('b', 6), OrderCue('new', 8), OrderCue('more', 12)], true);
    expect(player.Summary()).toMatchObject({ state: 'playing', next: [{ id: 'more', in: 4 }] });
  });

  it('skips camera cues while the camera is off', () => {
    const { port, player, Run } = Setup([ShotCue('hero', 0), ShotCue('wide', 1)]);
    port.settled = { settled: true, waiting: {} };
    Run(1);
    player.SetCamera(false);
    Run(1);
    expect(port.fired.map((line) => line.split('@')[0])).toEqual(['hero']);
    expect(player.Report()?.list[1]).toMatchObject({ id: 'wide', kind: 'camera', state: 'skipped', note: "the timeline's camera is off" });
  });

  it('a live scene that gains a script is stopped until play, and play starts it at the next tick', () => {
    const { port, player, Run, tick } = Setup([]);
    expect(player.state).toBe('idle');
    expect(player.Summary()).toBeNull();
    expect(() => player.Play()).toThrow('the scene has no timeline or ship orders');
    player.Edit([OrderCue('a', 1)], true);
    expect(player.state).toBe('stopped');
    Run(3);
    expect(port.fired).toEqual([]);
    player.Play();
    const start = tick();
    Run(2);
    expect(port.fired).toEqual([`a@${start + 1}`]);
  });

  it('snapshots and restores into a fresh player that fires the same', () => {
    const cues = [OrderCue('a', 0), OrderCue('b', 3), OrderCue('c', 5)];
    const first = Setup(cues);
    first.port.settled = { settled: true, waiting: {} };
    first.Run(2);
    const snapshot = first.player.Snapshot();
    expect(structuredClone(snapshot)).toEqual(snapshot);
    const second = new TimelinePlayer({ port: first.port, scripts: new ShipScripts(new FakeShips(first.port.log)) });
    second.Restore(snapshot);
    let boundary = first.tick();
    for (let index = 0; index < 5; index++) second.Boundary(boundary++, 0, []);
    first.Run(5);
    const fired = first.port.fired;
    expect(fired.filter((line) => line.startsWith('b@'))).toHaveLength(2);
    expect(new Set(fired.filter((line) => !line.startsWith('a@'))).size).toBe(2);
  });
});
