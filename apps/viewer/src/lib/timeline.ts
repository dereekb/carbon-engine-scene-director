/**
 * The timeline player: plays the authored document's `timeline` cues (@scene-director/scene's timeline/) on Destiny
 * ticks, and steps the ships' scripts (ship-scripts.ts). The director calls Boundary from DestinyWorld.OnBeforeBoundary,
 * so a cue is exactly the MCP call made just before that tick: within one tick the scripts step first (in `ships[]`
 * order), then the due cues fire in document order (sorted by `at`).
 *
 * A scripted load prepares with the scene clock held (HoldClock) until the port says the scene settled (every hull's
 * numbers, fit and build), capped at TIMELINE_PREPARE_LIMIT_SECONDS of wall time; t = 0 is the next boundary. Timeline
 * time is whole seconds played: a pause stops it while the ships fly on.
 *
 * Plain data and no runtime: the director is the port, and the specs fake it. Snapshot / Restore round-trip the state
 * (Time control's seam).
 */

import type { Maybe } from '@dereekb/util';
import { cueActionOf, cueDueSecond, TIMELINE_ACTIONS, type CueReport, type CueState, type SceneCue, type ShipScriptReport, type TimelineActionKind, type TimelineActionName, type TimelineState, type TimelineSummary } from '@scene-director/scene';
import type { ScriptedShip, ShipScriptRecord, ShipScripts } from './ship-scripts';

/**
 * Seconds of wall time a scripted load waits for the scene to settle before it starts anyway, with a note.
 */
export const TIMELINE_PREPARE_LIMIT_SECONDS = 60;

/**
 * What a fired cue did: `fired`, or `skipped` with nothing to do (the note says why).
 */
export interface CueFireResult {
  readonly state: 'fired' | 'skipped';
  readonly result?: unknown;
  readonly note?: string;
}

/**
 * Whether the scene is ready for t = 0, and what it still waits for (counts by kind).
 */
export interface TimelineSettled {
  readonly settled: boolean;
  readonly waiting: Readonly<Record<string, number>>;
}

export interface TimelinePort {
  /**
   * Runs a cue's lever now.
   *
   * @throws {Error} When the lever refuses: the cue is `failed` and never fires again.
   */
  Fire(cue: SceneCue, at: { readonly boundary: number; readonly time: number }): CueFireResult;
  Settled(): TimelineSettled;
  /**
   * Holds (or releases) the scene clock.
   */
  HoldClock(held: boolean): void;
  /**
   * Wall time, milliseconds (the prepare cap; the scene clock is held meanwhile).
   */
  Now(): number;
}

/**
 * One cue's record: plain data.
 */
export interface CueRecord {
  readonly id: string;
  readonly at: number;
  readonly due: number;
  readonly name?: string;
  readonly action: TimelineActionName;
  readonly kind: TimelineActionKind;
  state: CueState;
  /**
   * The cue as JSON, to tell an edit.
   */
  key: string;
  tick?: number;
  /**
   * The order cues were processed in.
   */
  seq?: number;
  note?: string;
  error?: string;
  result?: unknown;
  /**
   * Removed from the timeline after it fired: kept in the log only.
   */
  removed?: true;
}

type PlayerState = Exclude<TimelineState, 'done'>;

/**
 * The player's whole state: plain data.
 */
export interface TimelineSnapshot {
  state: PlayerState;
  /**
   * The world tick of t = 0.
   */
  startTick: Maybe<number>;
  /**
   * Boundaries played since t = 0: the next boundary is timeline second `played`.
   */
  played: number;
  camera: boolean;
  cues: SceneCue[];
  records: CueRecord[];
  seq: number;
  preparing: Maybe<{ readonly since: number; resume: 'play' | 'pause'; waiting: Readonly<Record<string, number>> }>;
  note: Maybe<string>;
  scripts: Record<string, ShipScriptRecord>;
}

/**
 * The timeline tool's full report.
 */
export interface TimelineReport extends TimelineSummary {
  readonly cues: Readonly<Record<'total' | CueState, number>>;
  readonly list: CueReport[];
  readonly scripts?: TimelineSummary['scripts'];
  readonly ships: ({ readonly ship: string } & ShipScriptReport)[];
}

export interface TimelinePlayerOptions {
  readonly port: TimelinePort;
  readonly scripts: ShipScripts;
}

const PROCESSED: ReadonlySet<CueState> = new Set(['fired', 'failed', 'skipped']);

export class TimelinePlayer {
  private readonly port: TimelinePort;
  readonly scripts: ShipScripts;
  private data: Omit<TimelineSnapshot, 'scripts'> = { state: 'idle', startTick: null, played: 0, camera: true, cues: [], records: [], seq: 0, preparing: null, note: null };

  constructor({ port, scripts }: TimelinePlayerOptions) {
    this.port = port;
    this.scripts = scripts;
  }

  /**
   * The player's state (get_state reads `done` when playing has nothing left: Summary).
   */
  get state(): PlayerState {
    return this.data.state;
  }

  /**
   * Whether a timeline shot may take the camera.
   */
  get camera(): boolean {
    return this.data.camera;
  }

  /**
   * Whole seconds played (0 before t = 0).
   */
  get time(): number {
    return this.data.startTick == null ? 0 : Math.max(0, this.data.played - 1);
  }

  /**
   * The world tick of t = 0, once started.
   */
  get startTick(): Maybe<number> {
    return this.data.startTick;
  }

  /**
   * Starts over on a load: a scripted document prepares with the clock held, then plays (or holds at t = 0, `ready`,
   * when loaded paused); an unscripted one is idle and never holds the clock. The camera switch is kept.
   *
   * @param cues - The authored timeline's cues.
   * @param scripted - Whether there are cues or any ship has orders.
   * @param options - `paused`: end the prepare in `ready`.
   */
  Load(cues: readonly SceneCue[], scripted: boolean, { paused = false }: { readonly paused?: boolean } = {}): void {
    this.scripts.Clear();
    this.data = { state: scripted ? 'preparing' : 'idle', startTick: null, played: 0, camera: this.data.camera, cues: [...cues], records: cues.map((cue) => NewRecord(cue)), seq: 0, preparing: scripted ? { since: this.port.Now(), resume: paused ? 'pause' : 'play', waiting: {} } : null, note: null };
    this.port.HoldClock(scripted);
  }

  /**
   * Called every frame: while preparing, checks whether the scene settled (or the cap passed), then releases the clock
   * and plays, or stays held at t = 0 (`ready`).
   */
  Frame(): void {
    const preparing = this.data.preparing;
    if (this.data.state !== 'preparing' || !preparing) return;
    const settled = this.port.Settled();
    preparing.waiting = settled.waiting;
    const seconds = (this.port.Now() - preparing.since) / 1000;
    if (!settled.settled && seconds < TIMELINE_PREPARE_LIMIT_SECONDS) return;
    if (!settled.settled) this.data.note = `started after ${TIMELINE_PREPARE_LIMIT_SECONDS} s with ${DescribeWaiting(settled.waiting)} pending: this run may differ`;
    this.data.preparing = null;
    if (preparing.resume === 'pause') this.data.state = 'ready';
    else {
      this.data.state = 'playing';
      this.port.HoldClock(false);
    }
  }

  /**
   * The pre-boundary hook: while playing, steps the scripts, then fires the due cues.
   *
   * @param boundary - The boundary's world tick.
   * @param time - Its scene-clock time (100 ns ticks).
   * @param ships - The live scene's ships.
   */
  Boundary(boundary: number, time: number, ships: readonly ScriptedShip[]): void {
    if (this.data.state !== 'playing') return;
    if (this.data.startTick == null) {
      this.data.startTick = boundary;
      this.data.played = 0;
    }
    const played = this.data.played;
    this.scripts.Step(played, ships);
    const cues = new Map(this.data.cues.map((cue) => [cue.id, cue]));
    for (const record of this.data.records) {
      if (record.state !== 'pending' || record.due > played) continue;
      const cue = cues.get(record.id);
      if (cue) this.FireOne(record, cue, boundary, time);
    }
    this.data.played = played + 1;
  }

  /**
   * Takes a user edit of the authored timeline or ship orders. Cues not fired yet follow it (one added or retimed into
   * the past while playing is `missed`: it plays from the next restart); fired cues keep their records and effects. A
   * scene that gains its first cue or steps is `stopped` (timeline play starts it); one that loses them is idle.
   *
   * @param cues - The authored timeline's cues after the edit.
   * @param scripted - Whether there are cues or any ship has orders.
   */
  Edit(cues: readonly SceneCue[], scripted: boolean): void {
    if (!scripted) {
      if (this.data.state === 'preparing' || this.data.state === 'ready') this.port.HoldClock(false);
      this.scripts.Clear();
      this.data = { ...this.data, state: 'idle', startTick: null, played: 0, cues: [], records: [], preparing: null, note: null };
      return;
    }
    const started = this.data.startTick != null;
    if (this.data.state === 'idle') this.data.state = 'stopped';
    const previous = new Map(this.data.records.filter((record) => !record.removed).map((record) => [record.id, record]));
    const records: CueRecord[] = [];
    for (const cue of cues) {
      const old = previous.get(cue.id);
      previous.delete(cue.id);
      const key = JSON.stringify(cue);
      if (old && PROCESSED.has(old.state)) {
        if (old.key !== key) old.note = 'edited after it fired: the edit plays on a restart';
        records.push(old);
        continue;
      }
      if (old && old.key === key) {
        records.push(old);
        continue;
      }
      const record = NewRecord(cue);
      if (started && record.due < this.data.played) {
        record.state = 'missed';
        record.note = old ? 'retimed into the past while playing: it plays from the next restart' : 'added after its time: it plays from the next restart';
      }
      records.push(record);
    }
    for (const old of previous.values()) {
      if (!PROCESSED.has(old.state)) continue;
      old.removed = true;
      old.note = 'removed after it fired';
      records.push(old);
    }
    const kept = new Map(this.data.cues.map((cue) => [cue.id, cue]));
    for (const cue of cues) kept.set(cue.id, cue);
    this.data.cues = [...kept.values()];
    this.data.records = records;
  }

  /**
   * Plays: a stopped timeline starts with t = 0 at the next tick (live, no hold); a ready one releases the clock; a
   * paused one resumes; a preparing one plays once prepared.
   *
   * @throws {Error} When the scene has no script.
   */
  Play(): void {
    switch (this.data.state) {
      case 'idle':
        throw new Error('the scene has no timeline or ship orders');
      case 'stopped':
        this.data.state = 'playing';
        this.data.startTick = null;
        this.data.played = 0;
        break;
      case 'ready':
        this.data.state = 'playing';
        this.port.HoldClock(false);
        break;
      case 'preparing':
        if (this.data.preparing) this.data.preparing.resume = 'play';
        break;
      case 'paused':
        this.data.state = 'playing';
        break;
      default:
        break;
    }
  }

  /**
   * Pauses the cursor and the scripts (the ships fly on); a preparing timeline ends its prepare in `ready`.
   */
  Pause(): void {
    if (this.data.state === 'playing') this.data.state = 'paused';
    else if (this.data.state === 'preparing' && this.data.preparing) this.data.preparing.resume = 'pause';
  }

  /**
   * Switches the timeline's camera cues on or off (a viewing preference, kept across loads).
   */
  SetCamera(on: boolean): void {
    this.data.camera = on;
  }

  /**
   * get_state's `timeline`.
   *
   * @returns The summary, or null for an idle (unscripted) scene.
   */
  Summary(): Maybe<TimelineSummary> {
    if (this.data.state === 'idle') return null;
    const records = this.data.records.filter((record) => !record.removed);
    const time = this.time;
    const pending = records.filter((record) => record.state === 'pending');
    const processed = this.data.records.filter((record) => record.seq != null).sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0));
    const failed = processed.filter((record) => record.state === 'failed');
    const counts = this.scripts.Counts();
    const done = this.data.state === 'playing' && !pending.length && this.scripts.Settled();
    const preparing = this.data.preparing;
    return {
      state: done ? 'done' : this.data.state,
      time,
      ...(this.data.startTick != null ? { startedAt: this.data.startTick } : {}),
      camera: this.data.camera,
      cues: CountCues(records),
      ...(pending.length ? { next: pending.slice(0, 5).map((record) => ({ id: record.id, at: record.at, action: record.action, in: Math.max(0, record.due - time) })) } : {}),
      ...(processed.length ? { last: processed.slice(0, 5).map((record) => ({ id: record.id, at: record.at, action: record.action, ...(record.tick != null ? { tick: record.tick } : {}), state: record.state, ...(record.note ? { note: record.note } : {}) })) } : {}),
      ...(failed.length ? { failed: failed.slice(0, 10).map((record) => ({ id: record.id, at: record.at, action: record.action, ...(record.tick != null ? { tick: record.tick } : {}), error: record.error ?? 'failed' })) } : {}),
      ...(counts.ships ? { scripts: counts } : {}),
      ...(preparing ? { preparing: { seconds: Math.round((this.port.Now() - preparing.since) / 100) / 10, waiting: preparing.waiting } } : {}),
      ...(this.data.note ? { note: this.data.note } : {})
    };
  }

  /**
   * The timeline tool's report: the summary plus every cue and every script.
   */
  Report(): Maybe<TimelineReport> {
    const summary = this.Summary();
    if (!summary) return null;
    const played = this.data.played;
    return {
      ...summary,
      list: this.data.records.map((record) => ({
        id: record.id,
        at: record.at,
        ...(record.name ? { name: record.name } : {}),
        action: record.action,
        kind: record.kind,
        state: record.state,
        ...(record.tick != null ? { tick: record.tick } : {}),
        ...(record.note ? { note: record.note } : {}),
        ...(record.error ? { error: record.error } : {}),
        ...(record.result !== undefined ? { result: record.result } : {})
      })),
      ships: this.scripts.ships.flatMap((ship) => {
        const report = this.scripts.Report(ship, played);
        return report ? [{ ship, ...report }] : [];
      })
    };
  }

  /**
   * A ship's script report (get_state ships[].script).
   */
  Script(id: string): Maybe<ShipScriptReport> {
    return this.scripts.Report(id, this.data.played);
  }

  Snapshot(): TimelineSnapshot {
    return structuredClone({ ...this.data, scripts: this.scripts.Snapshot() });
  }

  Restore(snapshot: TimelineSnapshot): void {
    const { scripts, ...data } = structuredClone(snapshot);
    this.data = data;
    this.scripts.Restore(scripts);
  }

  private FireOne(record: CueRecord, cue: SceneCue, boundary: number, time: number): void {
    // Processed before it runs: a lever that throws is recorded once and never fired again.
    record.state = 'failed';
    record.tick = boundary;
    record.seq = ++this.data.seq;
    record.error = 'it did not finish';
    if (record.kind === 'camera' && !this.data.camera) {
      record.state = 'skipped';
      record.note = "the timeline's camera is off";
      delete record.error;
      return;
    }
    try {
      const fired = this.port.Fire(cue, { boundary, time });
      record.state = fired.state;
      delete record.error;
      if (fired.note) record.note = fired.note;
      if (fired.result !== undefined) record.result = fired.result;
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error);
    }
  }
}

function NewRecord(cue: SceneCue): CueRecord {
  const { name, args } = cueActionOf(cue);
  return { id: cue.id, at: cue.at, due: cueDueSecond(cue.at), ...(cue.name ? { name: cue.name } : {}), action: name, kind: TIMELINE_ACTIONS[name].kind(args as never), state: 'pending', key: JSON.stringify(cue) };
}

function CountCues(records: readonly CueRecord[]): Record<'total' | CueState, number> {
  const counts: Record<'total' | CueState, number> = { total: 0, pending: 0, fired: 0, failed: 0, skipped: 0, missed: 0 };
  for (const record of records) {
    counts.total += 1;
    counts[record.state] += 1;
  }
  return counts;
}

/**
 * What a prepare still waits for: `3 builds and 1 lookup`.
 *
 * @param waiting - Counts by kind.
 * @returns The phrase.
 */
export function DescribeWaiting(waiting: Readonly<Record<string, number>>): string {
  const parts = Object.entries(waiting)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${count} ${count === 1 ? kind.replace(/s$/, '') : kind}`);
  return parts.length ? parts.join(', ').replace(/, ([^,]*)$/, ' and $1') : 'nothing';
}

/**
 * The overlay's timeline row: `playing · 42 s · 7/12 cues (1 failed)`, `preparing · 3 builds and 1 lookup`.
 *
 * @param summary - get_state's timeline.
 * @returns The row, or null without a script.
 */
export function TimelineText(summary: Maybe<TimelineSummary>): Maybe<string> {
  if (!summary) return null;
  if (summary.state === 'preparing') return `preparing · ${DescribeWaiting(summary.preparing?.waiting ?? {})}`;
  const done = summary.cues.fired + summary.cues.skipped + summary.cues.failed;
  const failed = summary.cues.failed ? ` (${summary.cues.failed} failed)` : '';
  return `${summary.state} · ${summary.time} s · ${done}/${summary.cues.total} cues${failed}`;
}
