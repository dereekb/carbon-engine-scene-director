/**
 * The determinism oracle of script edits (Movie mode M3, sd-timeline doc `movie`): a script edited while it plays,
 * re-simulated from the last snapshot before its first difference, must equal a fresh run of the edited script, tick
 * for tick: the master park's balls and every cue's and script's tick.
 */

import type { SceneCue, SceneShipStep } from '@scene-director/scene';
import { describe, expect, it } from 'vitest';
import { TICKS_PER_SECOND } from './clock';
import type { ScriptedShip } from './ship-scripts';
import type { TimeResimulation } from './time-control';
import type { CueRecord } from './timeline';
import { CUES_A, Cue, Direction, SHIPS_A, STEP_0, STEP_1, TimelineRig, type TimelineRigFacts } from './timeline.spec-helper';
import { BeatTime, MoviePresentation, MovieReportOf, SeekChunks } from './movie';

/**
 * The world tick every run is compared at.
 */
const END = 30;

/**
 * Script A run to END, edited there, against a fresh run of the edited script to END.
 */
function Oracle(cues: readonly SceneCue[], ships: readonly ScriptedShip[] = SHIPS_A): { edited: TimelineRigFacts; fresh: TimelineRigFacts; run: TimeResimulation | null } {
  const rig = TimelineRig(CUES_A, SHIPS_A);
  rig.RunTo(END);
  const run = rig.Edit(cues, ships);
  const fresh = TimelineRig(cues, ships);
  fresh.RunTo(END);
  return { edited: rig.Facts(), fresh: fresh.Facts(), run };
}

describe('script edits re-simulate to a fresh run of the edited script (Movie mode M3)', () => {
  it('a cue added at 8, behind now: re-simulated from before it', () => {
    const { edited, fresh, run } = Oracle([...CUES_A, Cue('added', 8, 'c', Direction([1, 1, 0]))]);
    expect(run?.report.resimulated).toBeGreaterThan(0);
    expect(edited.cues.find(({ id }) => id === 'added')).toMatchObject({ state: 'fired' });
    expect(edited).toEqual(fresh);
  });

  it('a fired cue retimed, and a fired cue removed', () => {
    const retimed = Oracle([CUES_A[0], Cue('turn', 9, 'b', Direction([0, 0, 1])), CUES_A[2]]);
    expect(retimed.run).not.toBeNull();
    expect(retimed.edited).toEqual(retimed.fresh);
    const removed = Oracle([CUES_A[0], CUES_A[2]]);
    expect(removed.run).not.toBeNull();
    expect(removed.edited).toEqual(removed.fresh);
  });

  it('an event cue whose event already happened, added', () => {
    const { edited, fresh, run } = Oracle([...CUES_A, { id: 'after-go', when: { cue: 'go', after: 3 }, arms: 2, order_ship: { id: 'b', order: Direction([0, 1, 1]) } } as SceneCue]);
    expect(run).not.toBeNull();
    expect(edited.cues.find(({ id }) => id === 'after-go')).toMatchObject({ state: 'fired' });
    expect(edited).toEqual(fresh);
  });

  it("a ship's step 1 changed while it flies step 0: taken at once, and equal", () => {
    const { edited, fresh, run } = Oracle(CUES_A, [{ id: 'c', orders: [STEP_0, { type: 'direction', direction: [1, 0, 0], speed: 1 } as SceneShipStep] }]);
    expect(run).toBeNull();
    expect(edited.scripts).toEqual([{ ship: 'c', state: 'flying', step: 0 }]);
    expect(edited).toEqual(fresh);
  });

  it('a future-only edit survives a jump back to a snapshot from before it', () => {
    const edited = [...CUES_A, Cue('late', 35, 'b', Direction([1, 0, 1]))];
    const rig = TimelineRig(CUES_A, SHIPS_A);
    rig.RunTo(END);
    expect(rig.Edit(edited, SHIPS_A)).toBeNull();
    rig.control.Command({ back: 12 });
    rig.RunTo(45);
    const fresh = TimelineRig(edited, SHIPS_A);
    fresh.RunTo(45);
    expect(rig.Facts().cues.find(({ id }) => id === 'late')).toMatchObject({ state: 'fired' });
    expect(rig.Facts()).toEqual(fresh.Facts());
  });

  it("a ship's step 0 changed: re-simulated from the origin", () => {
    const { edited, fresh, run } = Oracle(CUES_A, [{ id: 'c', orders: [{ ...STEP_0, direction: [1, 0, -1] } as SceneShipStep, STEP_1] }]);
    expect(run?.snapshot.tick).toBe(3);
    expect(edited).toEqual(fresh);
  });
});

describe('the movie report (Movie mode M5)', () => {
  const record = (fields: Partial<CueRecord> & Pick<CueRecord, 'id' | 'action' | 'state'>): CueRecord => ({ due: null, kind: fields.action === 'play_shot' ? 'camera' : 'live', key: fields.id, ...fields }) as CueRecord;
  const records = [
    record({ id: 'wait', action: 'engage', state: 'waiting', when: { kill: {}, after: 1, latest: 40 }, whenText: 'the 1st kill + 1 s, at 40 s at the latest', arms: 2, latest: 40 }),
    record({ id: 'late', action: 'order_fleet', state: 'pending', at: 30, due: 30 }),
    record({ id: 'hero', action: 'play_shot', state: 'fired', at: 5, due: 5, second: 5, name: 'Hero' }),
    record({ id: 'go', action: 'order_ship', state: 'fired', at: 1, due: 1, second: 1 }),
    record({ id: 'chain', action: 'stop_shot', state: 'pending', when: { cue: 'hero', after: 8 }, whenText: 'cue hero fired + 8 s', arms: 5, due: 13, event: { second: 5, text: 'cue hero fired' } }),
    record({ id: 'gone', action: 'engage', state: 'fired', at: 0, due: 0, second: 0, removed: true })
  ];
  const summary = { state: 'playing', time: 9, startedAt: 40, camera: true, cues: {}, beat: { fleet: { id: 'go', at: 1 }, camera: { id: 'hero', name: 'Hero', at: 5 } }, scripts: { ships: 2, flying: 2 } } as never;

  it('resolves a beat time from its fired, then due second', () => {
    expect(BeatTime({ second: 4, due: 3 })).toBe(4);
    expect(BeatTime({ due: 13 })).toBe(13);
    expect(BeatTime({ due: null })).toBeNull();
  });

  it('lists the beats in lanes by time, waiting ones last, with the current and next beat', () => {
    const report = MovieReportOf({ summary, records, events: [{ second: 5, text: 'cue hero fired' } as never], time: 9.5, movie: { end: 60 }, driver: 'timeline', window: { earliest: 0, latest: 9.5, origin: true } });
    expect(report.beats.map((beat) => [beat.id, beat.lane, beat.time])).toEqual([
      ['go', 'fleet', 1],
      ['hero', 'camera', 5],
      ['chain', 'camera', 13],
      ['late', 'fleet', 30],
      ['wait', 'fleet', null]
    ]);
    expect(report.beats[2]).toEqual({ id: 'chain', lane: 'camera', action: 'stop_shot', trigger: { when: 'cue hero fired + 8 s', arms: 5, after: 8 }, time: 13, state: 'pending', in: 3.5 });
    expect(report.beats[4]).toMatchObject({ trigger: { when: 'the 1st kill + 1 s, at 40 s at the latest', arms: 2, after: 1, latest: 40 }, time: null, state: 'waiting' });
    expect(report.beats[4]).not.toHaveProperty('in');
    expect(report.beats[0]).toMatchObject({ trigger: { at: 1 } });
    expect(report).toMatchObject({
      state: 'playing',
      time: 9.5,
      end: 60,
      look: { letterbox: 2.39, hud: false, applied: true },
      camera: { driver: 'timeline', beat: 'hero' },
      beat: { fleet: { id: 'go', at: 1 }, camera: { id: 'hero', name: 'Hero', at: 5 } },
      next: { id: 'chain', lane: 'camera', action: 'stop_shot', time: 13, in: 3.5 },
      waiting: 1,
      events: { count: 1, last: [{ second: 5, text: 'cue hero fired' }] },
      window: { earliest: 0, latest: 9.5, origin: true },
      scripts: { ships: 2, flying: 2 }
    });
    expect(report).not.toHaveProperty('ended');
    expect(MovieReportOf({ summary, records, events: [], time: 60, movie: { end: 60 }, driver: 'user', window: null })).toMatchObject({ ended: true });
    expect(MovieReportOf({ summary: null, records: [], events: [], time: 0, movie: null, driver: 'user', window: null })).toEqual({ state: 'idle', time: 0, camera: { driver: 'user' }, beat: {}, beats: [], waiting: 0, events: { count: 0, last: [] } });
  });

  it('chunks a seek past the recorded end into jumps of at most 300 s', () => {
    const s = TICKS_PER_SECOND;
    expect(SeekChunks(100 * s, 50 * s)).toEqual([100 * s]);
    expect(SeekChunks(350 * s, 50 * s)).toEqual([350 * s]);
    expect(SeekChunks(800 * s, 50 * s)).toEqual([350 * s, 650 * s, 800 * s]);
    expect(SeekChunks(10 * s, 50 * s)).toEqual([10 * s]);
  });

  it("presents the page, then the movie (the run's switches win), then the shot", () => {
    const page = { letterbox: null, hud: true };
    const movie = { letterbox: 2.39 as const, hud: false };
    expect(MoviePresentation({ page, movie: null })).toEqual({ letterbox: null, hud: true });
    expect(MoviePresentation({ page, movie })).toEqual({ letterbox: 2.39, hud: false });
    expect(MoviePresentation({ page, movie: { letterbox: false, hud: true } })).toEqual({ letterbox: null, hud: true });
    expect(MoviePresentation({ page, movie, overrides: { hud: true } })).toEqual({ letterbox: 2.39, hud: true });
    expect(MoviePresentation({ page, movie, overrides: { letterbox: null } })).toEqual({ letterbox: null, hud: false });
    expect(MoviePresentation({ page, movie, overrides: { hud: false }, shot: { hud: true, letterbox: 1.85 } })).toEqual({ letterbox: 1.85, hud: true });
    expect(MoviePresentation({ page: { letterbox: 2.39, hud: false }, movie: null, shot: { letterbox: false } })).toEqual({ letterbox: null, hud: false });
  });
});
