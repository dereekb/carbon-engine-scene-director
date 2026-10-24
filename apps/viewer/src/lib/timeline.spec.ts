import { MAX_TIMELINE_EVENTS, type SceneCue, type SceneShipStep, type ShipOrderRequest, type TimelineEvent } from '@scene-director/scene';
import { describe, expect, it } from 'vitest';
import { ShipScripts, type ShipScriptsPort } from './ship-scripts';
import { DescribeWaiting, TIMELINE_PREPARE_LIMIT_SECONDS, TimelinePlayer, TimelineText, type CueFireResult, type TimelinePort, type TimelineSettled } from './timeline';

function OrderCue(id: string, at: number): SceneCue {
  return { id, at, order_ship: { id: 'a', order: { type: 'stop' } } } as SceneCue;
}

function ShotCue(id: string, at: number): SceneCue {
  return { id, at, play_shot: { shot: 'hero', ship: 'a' } } as SceneCue;
}

function EventCue(id: string, when: object, extra: object = {}): SceneCue {
  return { id, when, arms: 0, order_ship: { id: 'a', order: { type: 'stop' } }, ...extra } as SceneCue;
}

function Kill(ship: string, by = 'b1'): TimelineEvent {
  return { kind: 'kill', victim: { ship, team: 'red' }, killer: { ship: by, team: 'blue', fleet: 'b' } };
}

function Shot(ship: string): TimelineEvent {
  return { kind: 'fire', shooter: { ship, team: 'red' }, target: { ship: 'b1', team: 'blue' } };
}

class FakePort implements TimelinePort {
  readonly fired: string[] = [];
  readonly log: string[] = [];
  readonly failing = new Set<string>();
  skip: Maybe<string> = null;
  onFire: Maybe<(cue: SceneCue) => void> = null;
  settled: TimelineSettled = { settled: false, waiting: { builds: 2, lookups: 1 } };
  held = false;
  now = 0;

  Fire(cue: SceneCue, { boundary }: { readonly boundary: number }): CueFireResult {
    this.log.push(`cue ${cue.id}`);
    if (this.failing.has(cue.id)) throw new Error(`${cue.id} refused`);
    this.fired.push(`${cue.id}@${boundary}`);
    this.onFire?.(cue);
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

  it('keeps an event cue waiting with no due second until its event, and reports it', () => {
    const event = { id: 'first-blood', when: { kill: {}, after: 1 }, arms: 0, order_ship: { id: 'a', order: { type: 'stop' } } } as SceneCue;
    const { port, player, Run } = Setup([OrderCue('go', 0), event]);
    port.settled = { settled: true, waiting: {} };
    Run(6);
    expect(port.fired.map((fired) => fired.split('@')[0])).toEqual(['go']);
    const summary = player.Summary();
    expect(summary).toMatchObject({ state: 'playing', cues: { total: 2, fired: 1, waiting: 1, pending: 0 }, waiting: [{ id: 'first-blood', when: 'the 1st kill + 1 s' }] });
    expect(summary?.next).toBeUndefined();
    expect(TimelineText(summary)).toBe('playing · 5 s · 1/2 cues · 1 waiting');
    expect(player.Report()?.list.find((cue) => cue.id === 'first-blood')).toMatchObject({ state: 'waiting', whenText: 'the 1st kill + 1 s', arms: 0, when: { kill: {}, after: 1 } });
  });

  it('resolves a kill, a landing, a warp, a primary, an opened fire and a cue chain to the event second + max(1, ceil(after))', () => {
    const cues = [EventCue('k', { kill: { ship: 'r1' }, after: 2 }), EventCue('l', { arrival: { fleet: 'wr' } }), EventCue('w', { warp: { ship: 'r2' } }), EventCue('p', { primary: { fleet: 'b' } }), EventCue('f', { fire: { team: 'red' } }), EventCue('c', { cue: 'k', after: 0.5 })];
    const { port, player, Run, tick } = Setup(cues);
    port.settled = { settled: true, waiting: {} };
    const start = tick();
    Run(3);
    // Between boundaries: the events belong to second 2, the boundary that last ran.
    player.Event(Kill('r1'));
    player.Event({ kind: 'arrival', group: 'wr', fleet: 'wr', phase: 'landed', ships: ['wr-1'] });
    player.Event({ kind: 'warp', ship: { ship: 'r2', team: 'red' }, phase: 'exit', arrival: false });
    player.Event({ kind: 'primary', fleet: 'b', primary: 'r1', previous: null });
    player.Event(Shot('r3'));
    expect(player.Report()?.list.find((cue) => cue.id === 'k')).toMatchObject({ state: 'pending', due: 4, event: { second: 2, text: 'r1 destroyed by b1' } });
    Run(4);
    expect(port.fired).toEqual([`l@${start + 3}`, `w@${start + 3}`, `p@${start + 3}`, `f@${start + 3}`, `k@${start + 4}`, `c@${start + 5}`]);
    expect(player.Events().map(({ second, text }) => `${second} ${text}`)).toContain('4 cue k fired');
    const summary = player.Summary();
    expect(summary).toMatchObject({ state: 'done', beat: { fleet: { id: 'c', at: 5 } }, events: { count: 11 } });
    expect(summary?.events?.last[0]).toEqual({ second: 5, text: 'cue c fired' });
  });

  it('counts to the nth match, ignores events before arms and while paused, applies the fire quiet rule, and fires latest with its note', () => {
    const cues = [EventCue('two', { kill: {}, count: 2 }), EventCue('armed', { kill: {} }, { arms: 3 }), EventCue('late', { kill: { ship: 'ghost' }, latest: 4.5 }), EventCue('volley', { fire: { ship: 's1' }, count: 2 })];
    const { port, player, Run, tick } = Setup(cues);
    port.settled = { settled: true, waiting: {} };
    const start = tick();
    Run(3);
    player.Event(Kill('x'));
    player.Event(Shot('s1'));
    player.Pause();
    player.Event(Kill('y'));
    player.Play();
    expect(player.Report()?.list.map(({ id, state }) => `${id} ${state}`)).toEqual(['two waiting', 'armed waiting', 'late waiting', 'volley waiting']);
    expect(player.Summary()?.waiting?.find((cue) => cue.id === 'late')).toMatchObject({ latestIn: 3 });
    Run(1);
    player.Event(Kill('z'));
    // A shot one second after the last is no opened fire; ten seconds of quiet later it is.
    player.Event(Shot('s1'));
    Run(3);
    expect(port.fired).toEqual([`two@${start + 4}`, `armed@${start + 4}`, `late@${start + 5}`]);
    expect(player.Report()?.list.find((cue) => cue.id === 'late')).toMatchObject({ state: 'fired', note: 'its event (the kill of ghost) had not happened by 4.5 s' });
    Run(9);
    player.Event(Shot('s1'));
    Run(2);
    expect(port.fired.at(-1)).toBe(`volley@${start + 16}`);
    expect(player.Events().filter(({ event }) => event.kind === 'fire')).toHaveLength(2);
  });

  it('gives an event in Boundary second played, and one between boundaries (a live call, or its tape replay before the next boundary) played − 1', () => {
    const cues = [OrderCue('call', 2), EventCue('in', { primary: { fleet: 'b', ship: 'r1' } }), EventCue('out', { primary: { fleet: 'b', ship: 'r2' } })];
    const { port, player, Run, tick } = Setup(cues);
    port.settled = { settled: true, waiting: {} };
    port.onFire = (cue) => {
      if (cue.id === 'call') player.Event({ kind: 'primary', fleet: 'b', primary: 'r1', previous: null });
    };
    const start = tick();
    Run(2);
    player.Event({ kind: 'primary', fleet: 'b', primary: 'r2', previous: null });
    Run(3);
    expect(player.Events().map(({ second, event }) => `${second} ${event.kind}`)).toEqual(['1 primary', '2 primary', '2 cue', '2 cue', '3 cue']);
    expect(port.fired).toEqual([`call@${start + 2}`, `out@${start + 2}`, `in@${start + 3}`]);
  });

  it('keeps the log across Snapshot → Restore when the same events are re-written, and truncates at a different one', () => {
    const { port, player, Run } = Setup([EventCue('third', { kill: {}, count: 3 })]);
    port.settled = { settled: true, waiting: {} };
    Run(2);
    player.Event(Kill('a'));
    const early = player.Snapshot();
    Run(1);
    player.Event(Kill('b'));
    Run(1);
    player.Event(Kill('c'));
    const late = player.Snapshot();
    const texts = (): string[] => player.Events().map(({ second, text }) => `${second} ${text}`);
    const recorded = texts();
    expect(recorded).toEqual(['1 a destroyed by b1', '2 b destroyed by b1', '3 c destroyed by b1']);
    player.Restore(early);
    expect(texts()).toEqual(['1 a destroyed by b1']);
    Run(1);
    player.Event(Kill('b'));
    // The recorded future is still there: a jump forward reads it.
    player.Restore(late);
    expect(texts()).toEqual(recorded);
    expect(player.Report()?.list[0]).toMatchObject({ state: 'pending', due: 4 });
    player.Restore(early);
    Run(1);
    player.Event(Kill('d'));
    expect(texts()).toEqual(['1 a destroyed by b1', '2 d destroyed by b1']);
    player.Restore(late);
    expect(texts()).toHaveLength(2);
  });

  it('stops logging at MAX_TIMELINE_EVENTS but still resolves event cues', () => {
    const { port, player, Run } = Setup([EventCue('end', { kill: { ship: 'last' } })]);
    port.settled = { settled: true, waiting: {} };
    Run(1);
    for (let index = 0; index < MAX_TIMELINE_EVENTS + 5; index++) player.Event(Kill(`r${index}`));
    player.Event(Kill('last'));
    expect(player.Summary()).toMatchObject({ events: { count: MAX_TIMELINE_EVENTS, full: true }, cues: { pending: 1 } });
  });

  it('resolves an event cue added while playing against the log: its past event makes it missed, a recent one pending', () => {
    const { port, player, Run } = Setup([OrderCue('go', 0)]);
    port.settled = { settled: true, waiting: {} };
    Run(3);
    player.Event(Kill('r1'));
    Run(3);
    player.Event(Kill('r2'));
    player.Edit([OrderCue('go', 0), EventCue('old', { kill: { ship: 'r1' } }), EventCue('recent', { kill: { ship: 'r2' }, after: 3 }), EventCue('later', { kill: { ship: 'r3' } })], true);
    expect(player.Report()?.list.map(({ id, state, due, note }) => ({ id, state, due, note }))).toEqual([
      { id: 'go', state: 'fired', due: 0, note: undefined },
      { id: 'old', state: 'missed', due: 3, note: 'its event came before it was added: it plays from the next restart' },
      { id: 'recent', state: 'pending', due: 8, note: undefined },
      { id: 'later', state: 'waiting', due: undefined, note: undefined }
    ]);
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

describe('TimelinePlayer script edits (Movie mode M3)', () => {
  const REJOIN = { type: 'rejoin' } as SceneShipStep;
  const STOP = { type: 'stop', after: 3 } as SceneShipStep;
  const WARP = { type: 'warp', point: [0, 0, 400_000] } as SceneShipStep;

  it('accepts a timed or event cue edit only while the state is before its first difference', () => {
    const cues = [OrderCue('go', 1), OrderCue('later', 10)];
    const { port, player, Run } = Setup(cues);
    port.settled = { settled: true, waiting: {} };
    Run(1);
    const early = player.Snapshot();
    Run(2);
    player.Event(Kill('r1'));
    Run(2);
    expect(player.Summary()).toMatchObject({ time: 4, cues: { fired: 1 } });
    const accepts = (edited: SceneCue[]) => [player.Accepts(edited, []), player.Accepts(edited, [], { state: early })];
    // A cue added behind now (due 4, played 5) changes the past; at 6 only the future.
    expect(accepts([...cues, OrderCue('add', 4)])).toEqual([false, true]);
    expect(accepts([...cues, OrderCue('add', 6)])).toEqual([true, true]);
    // The fired cue retimed or removed; the pending one retimed.
    expect(accepts([OrderCue('go', 2), cues[1]])).toEqual([false, true]);
    expect(accepts([cues[1]])).toEqual([false, true]);
    expect(accepts([cues[0], OrderCue('later', 7)])).toEqual([true, true]);
    // r1 died in second 2: due at 3, behind now; with after 5 at 7, ahead; one that never came, due at its latest 4.
    expect(accepts([...cues, EventCue('dies', { kill: { ship: 'r1' } })])).toEqual([false, true]);
    expect(accepts([...cues, EventCue('dies', { kill: { ship: 'r1' }, after: 5 })])).toEqual([true, true]);
    expect(accepts([...cues, EventCue('never', { kill: { ship: 'r9' }, latest: 4 })])).toEqual([false, true]);
    expect(accepts([...cues, EventCue('never', { kill: { ship: 'r9' }, latest: 6 })])).toEqual([true, true]);
  });

  it("accepts a ship's orders edit while its script has not reached the first changed step", () => {
    const orders = [REJOIN, STOP];
    const { port, player, Run } = Setup([OrderCue('go', 1)], [{ id: 'a', orders }]);
    port.settled = { settled: true, waiting: {} };
    // Prepared and playing, before t = 0's boundary: the time-control origin's state.
    player.Frame();
    const before = player.Snapshot();
    Run(1);
    expect(player.Script('a')).toMatchObject({ state: 'waiting', step: 1 });
    expect(player.Accepts([OrderCue('go', 1)], [{ id: 'a', orders }], { state: { ...before, state: 'stopped' } })).toBe(false);
    const cues = [OrderCue('go', 1)];
    const accepts = (ships: { id: string; orders?: SceneShipStep[] }[], previous = [{ id: 'a', orders }, { id: 'b' }]) => [player.Accepts(cues, ships, { previous }), player.Accepts(cues, ships, { state: before, previous })];
    expect(accepts([{ id: 'a', orders: [REJOIN, STOP, WARP] }])).toEqual([true, true]);
    expect(accepts([{ id: 'a', orders: [REJOIN, WARP] }])).toEqual([false, true]);
    expect(accepts([{ id: 'a', orders: [STOP] }])).toEqual([false, true]);
    expect(accepts([{ id: 'a' }])).toEqual([false, true]);
    // b gains orders: only before the first boundary; unchanged, or a ship without a script, passes.
    expect(
      accepts([
        { id: 'a', orders },
        { id: 'b', orders: [STOP] }
      ])
    ).toEqual([false, true]);
    expect(accepts([{ id: 'a', orders }, { id: 'b' }])).toEqual([true, true]);
  });

  it('Rescript takes the edit with no missed cue and swaps a running script without a restart', () => {
    const cues = [OrderCue('go', 1), OrderCue('later', 10)];
    const ships: { id: string; orders?: SceneShipStep[] }[] = [{ id: 'a', orders: [REJOIN, STOP] }];
    const { port, player, Run } = Setup(cues, ships);
    port.settled = { settled: true, waiting: {} };
    Run(2);
    player.Event(Kill('r1'));
    ships[0] = { id: 'a', orders: [REJOIN, STOP, WARP] };
    const edited = [...cues, OrderCue('new', 4), EventCue('dies', { kill: { ship: 'r1' }, after: 2 })];
    expect(player.Accepts(edited, ships, { previous: [{ id: 'a', orders: [REJOIN, STOP] }] })).toBe(true);
    player.Rescript(edited, ships);
    expect(player.Report()?.list.map(({ id, state, due }) => [id, state, due])).toEqual([
      ['go', 'fired', 1],
      ['later', 'pending', 10],
      ['new', 'pending', 4],
      ['dies', 'pending', 3]
    ]);
    expect(player.Script('a')).toMatchObject({ state: 'waiting', step: 1, steps: 3 });
    Run(3);
    expect(port.fired.map((fired) => fired.split('@')[0])).toEqual(['go', 'dies', 'new']);
    expect(port.log.filter((line) => line === 'step a rejoin')).toHaveLength(1);
    expect(player.Script('a')?.note ?? '').not.toMatch(/restarted/);
    expect(player.Summary()?.cues.missed).toBe(0);
  });

  it('AbandonFuture drops the log past the cursor', () => {
    const { port, player, Run } = Setup([OrderCue('go', 0)]);
    port.settled = { settled: true, waiting: {} };
    Run(2);
    const snapshot = player.Snapshot();
    player.Event(Kill('r1'));
    player.Restore(snapshot);
    player.AbandonFuture();
    player.Event(Kill('r2'));
    expect(player.Events().map(({ text }) => text)).toEqual(['cue go fired', expect.stringContaining('r2')]);
  });
});
