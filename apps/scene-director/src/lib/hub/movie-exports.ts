/**
 * The hub's side of `export_movie` and `record_movie` (sd-export): one session of either kind at a time. `start` normalizes the command, has the
 * page arm the export (the page checks what needs the scene and answers with the plan), reserves the file and opens
 * an Mp4Writer; the page then streams the track config (JSON), the encoded chunks (binary SDX1 packets, wire.ts) and
 * progress, and `end` has the hub write the moov, rename the part file and answer `saved`. `status` answers from the
 * session with no page call, so it works with no tab and after a reload; `cancel` goes to the export's own tab. The
 * tab closing mid-export fails it and deletes the part. Writes go in order on one promise chain.
 *
 * A live recording (record_movie) is the same session over the same wire: its start arms the page's recorder, and
 * `stop` asks the page to end it, then waits for the session to end (saved: the status with its result; failed:
 * thrown), at most RECORD_STOP_TIMEOUT_MS. Each tool's status reports its own kind's last session.
 */

import type { Maybe } from '@dereekb/util';
import type { WebSocket } from 'ws';
import {
  decodeExportPacket,
  exportBase64ToBytes,
  type MovieExportFile,
  type MovieExportHubMessage,
  type MovieExportPageStart,
  type MovieExportPlan,
  type MovieExportResult,
  type MovieExportStartCommand,
  type MovieExportStartResult,
  type MovieExportState,
  type MovieExportStatus,
  type MovieExportTrack,
  type MovieFileReport,
  type MovieRecordPageStart,
  type MovieRecordPlan,
  type MovieRecordReport,
  type MovieRecordStartCommand,
  type MovieRecordStartResult,
  type MovieRecordState,
  type MovieRecordStatus,
  normalizeMovieExportCommand,
  normalizeMovieRecordCommand,
  RUNNING_MOVIE_EXPORT_STATES,
  RUNNING_MOVIE_RECORD_STATES
} from '@scene-director/scene';
import { DefaultMovieName, type MovieFileStore } from '../store/movie-files';
import { Mp4Writer } from './mp4-writer';
import { ErrorMessage, ToolError, type ToolArgs } from './tool-call';

export const EXPORT_MOVIE_TOOL = 'export_movie';
export const RECORD_MOVIE_TOOL = 'record_movie';
/**
 * How long record_movie stop waits for the file to be saved before it answers with the status (still finishing).
 */
export const RECORD_STOP_TIMEOUT_MS = 120_000;

type MovieKind = 'export' | 'record';

/**
 * The states a session of either kind still runs in.
 */
const RUNNING_STATES: ReadonlySet<string> = new Set<string>([...RUNNING_MOVIE_EXPORT_STATES, ...RUNNING_MOVIE_RECORD_STATES]);

/**
 * How the sessions reach the viewer tabs.
 */
export interface MovieExportPages {
  /**
   * The newest tab, or null.
   */
  Newest(): Maybe<WebSocket>;
  NotConnected(): Error;
  /**
   * A page tool call to the given tab.
   */
  Call(name: string, args: ToolArgs, page: WebSocket): Promise<unknown>;
}

export interface MovieExportsOptions {
  readonly files: MovieFileStore;
  readonly pages: MovieExportPages;
  /**
   * The hub's URL, ending in "/".
   */
  readonly url: () => string;
  readonly log: (line: string) => void;
  /**
   * WSL_DISTRO_NAME for the Windows path.
   */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * How long record_movie stop waits for the save (default RECORD_STOP_TIMEOUT_MS).
   */
  readonly stopTimeoutMs?: number;
}

interface Session {
  readonly kind: MovieKind;
  readonly id: string;
  readonly page: WebSocket;
  state: MovieExportState | MovieRecordState;
  file: Maybe<MovieExportFile>;
  plan: Maybe<MovieExportPlan | MovieRecordPlan>;
  writer: Maybe<Mp4Writer>;
  /**
   * The writes, in order; starts once the writer is open.
   */
  chain: Promise<void>;
  progress: Maybe<MovieFileReport>;
  result?: MovieExportResult;
  error?: string;
  warnings: string[];
  nextSeq: number;
  readonly startedAt: number;
  endedAt?: number;
  /**
   * Resolves once the session ended (done, cancelled or failed).
   */
  readonly ended: Promise<void>;
  readonly settle: () => void;
}

/**
 * Each kind's tool and its texts.
 */
const KINDS: Readonly<Record<MovieKind, { readonly tool: string; readonly what: string; readonly ends: string }>> = {
  export: { tool: EXPORT_MOVIE_TOOL, what: 'movie export', ends: 'export_movie { action: "cancel" } stops it' },
  record: { tool: RECORD_MOVIE_TOOL, what: 'live recording', ends: 'record_movie { action: "stop" } ends it' }
};

export class MovieExports {
  /**
   * The running session, or the last one of either kind.
   */
  private session: Maybe<Session> = null;
  /**
   * Each kind's last session, for its status.
   */
  private readonly last: Partial<Record<MovieKind, Session>> = {};
  private count = 0;

  constructor(private readonly options: MovieExportsOptions) {}

  get directory(): string {
    return this.options.files.directory;
  }

  /**
   * The path the /movies route serves for a file name (movie-files.ts).
   *
   * @param fileName - The requested name.
   * @returns The path, or null.
   */
  Resolve(fileName: string): Maybe<string> {
    return this.options.files.Resolve(fileName);
  }

  /**
   * Runs export_movie.
   *
   * @param name - The tool name.
   * @param args - Its arguments.
   * @returns The answer, or null for another tool.
   */
  Call(name: string, args: ToolArgs): Maybe<Promise<unknown>> {
    let run: Maybe<Promise<unknown>> = null;
    if (name === EXPORT_MOVIE_TOOL) run = this.RunExport(args);
    else if (name === RECORD_MOVIE_TOOL) run = this.RunRecord(args);
    return run;
  }

  private async RunExport(args: ToolArgs): Promise<unknown> {
    const command = normalizeMovieExportCommand(args);
    let answer: unknown;
    if (command.action === 'start') answer = await this.Start('export', command);
    else if (command.action === 'cancel') answer = await this.Cancel('export');
    else answer = this.Status();
    return answer;
  }

  private async RunRecord(args: ToolArgs): Promise<unknown> {
    const command = normalizeMovieRecordCommand(args);
    let answer: unknown;
    if (command.action === 'start') answer = await this.Start('record', command);
    else if (command.action === 'stop') answer = await this.StopRecording();
    else if (command.action === 'cancel') answer = await this.Cancel('record');
    else answer = this.RecordStatus();
    return answer;
  }

  /**
   * The last export's status, from the session (no page call).
   *
   * @returns idle before any export, else the session.
   */
  Status(): MovieExportStatus {
    return this.KindStatus('export', 'no movie export has run since the hub started: export_movie { action: "start" } renders the movie') as MovieExportStatus;
  }

  /**
   * The last live recording's status, from the session (no page call).
   *
   * @returns idle before any recording, else the session.
   */
  RecordStatus(): MovieRecordStatus {
    return this.KindStatus('record', 'no live recording has run since the hub started: record_movie { action: "start" } begins one') as MovieRecordStatus;
  }

  private KindStatus(kind: MovieKind, idle: string): MovieExportStatus | MovieRecordStatus {
    const session = this.last[kind];
    if (!session?.plan || !session.file) return { state: 'idle', note: idle };
    const report = session.progress ?? InitialReport(session);
    const file: MovieExportFile = { ...session.file, bytes: session.result?.bytes ?? session.writer?.bytes ?? 0 };
    return {
      ...report,
      state: session.state,
      warnings: [...new Set([...session.warnings, ...report.warnings])],
      ...(session.error ? { error: session.error } : {}),
      file,
      ...(session.result ? { result: session.result } : {})
    } as MovieExportStatus | MovieRecordStatus;
  }

  private async Start(kind: MovieKind, command: MovieExportStartCommand | MovieRecordStartCommand): Promise<MovieExportStartResult | MovieRecordStartResult> {
    const running = this.session && RUNNING_STATES.has(this.session.state) ? this.session : null;
    if (running) throw new ToolError(`a ${KINDS[running.kind].what} is running (${RunningText(running)}): ${KINDS[running.kind].ends}, or wait for it`);
    const page = this.options.pages.Newest();
    if (!page) throw this.options.pages.NotConnected();
    const id = `${kind}-${Date.now()}-${++this.count}`;
    let open: (writer: Maybe<Mp4Writer>) => void = () => undefined;
    const opened = new Promise<Maybe<Mp4Writer>>((resolve) => (open = resolve));
    const previous = this.session;
    const previousOfKind = this.last[kind];
    let settle: () => void = () => undefined;
    const ended = new Promise<void>((resolve) => (settle = resolve));
    const session: Session = { kind, id, page, state: 'preparing', file: null, plan: null, writer: null, chain: opened.then(() => undefined), progress: null, warnings: [], nextSeq: 0, startedAt: Date.now(), ended, settle };
    this.session = session;
    this.last[kind] = session;
    let started: MovieExportPageStart | MovieRecordPageStart;
    try {
      started = (await this.options.pages.Call(KINDS[kind].tool, { ...command, id }, page)) as MovieExportPageStart | MovieRecordPageStart;
    } catch (error) {
      open(null);
      if (this.session === session) this.session = previous;
      if (this.last[kind] === session) {
        if (previousOfKind) this.last[kind] = previousOfKind;
        else delete this.last[kind];
      }
      throw error;
    }
    session.plan = started.plan;
    session.warnings = [...(started.warnings ?? [])];
    try {
      const reservation = await this.options.files.Reserve(command.name ?? DefaultMovieName(started.scene));
      session.file = { path: reservation.path, url: `${this.options.url()}movies/${reservation.fileName}`, ...WindowsPath(reservation.path, this.options.env ?? process.env) };
      session.writer = await Mp4Writer.Open({ partPath: reservation.partPath, path: reservation.path, codec: started.plan.codec });
    } catch (error) {
      open(null);
      session.file ??= { path: '', url: '' };
      this.Fail(session, `the hub could not create the movie file: ${ErrorMessage(error)}`);
      throw new ToolError(session.error ?? 'the hub could not create the movie file');
    }
    open(session.writer);
    const frames = 'frames' in started.plan ? `${started.plan.frames} frames` : `up to ${started.plan.maxFrames} frames`;
    this.options.log(`${KINDS[kind].what} ${id}: ${frames} at ${started.plan.width}×${started.plan.height} ${started.plan.fps} fps to ${session.file.path}`);
    return { id, state: session.state, file: session.file, plan: started.plan, warnings: session.warnings } as MovieExportStartResult | MovieRecordStartResult;
  }

  private async Cancel(kind: MovieKind): Promise<MovieExportStatus | MovieRecordStatus> {
    const session = this.RunningOf(kind);
    try {
      await this.options.pages.Call(KINDS[kind].tool, { action: 'cancel', id: session.id }, session.page);
    } catch (error) {
      session.warnings.push(`the page did not answer the cancel: ${ErrorMessage(error)}`);
    }
    this.End(session, 'cancelled');
    await session.chain;
    return kind === 'export' ? this.Status() : this.RecordStatus();
  }

  /**
   * record_movie stop: the page ends the recording, then the hub waits for the file (RECORD_STOP_TIMEOUT_MS).
   *
   * @returns The status: done with its result, cancelled (nothing was recorded), or still finishing after the timeout.
   * @throws {ToolError} When no recording runs, or it failed.
   */
  private async StopRecording(): Promise<MovieRecordStatus> {
    const session = this.RunningOf('record');
    const report = (await this.options.pages.Call(RECORD_MOVIE_TOOL, { action: 'stop', id: session.id }, session.page)) as Maybe<MovieRecordReport>;
    if (report && RUNNING_STATES.has(session.state)) {
      session.progress = report;
      if (report.state === 'cancelled') this.End(session, 'cancelled');
      else if (RUNNING_STATES.has(report.state)) session.state = report.state;
    }
    let timer: Maybe<ReturnType<typeof setTimeout>> = null;
    const timedOut = new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(true), this.options.stopTimeoutMs ?? RECORD_STOP_TIMEOUT_MS)));
    const late = await Promise.race([session.ended.then(() => false), timedOut]);
    if (timer) clearTimeout(timer);
    await (late ? null : session.chain);
    if (session.state === 'failed') throw new ToolError(`the live recording failed: ${session.error ?? 'unknown error'}`);
    const status = this.RecordStatus();
    return late ? ({ ...status, note: `the file is still being written: record_movie status shows when it is saved` } as MovieRecordStatus) : status;
  }

  /**
   * The running session of a kind.
   *
   * @throws {ToolError} When none runs.
   */
  private RunningOf(kind: MovieKind): Session {
    const session = this.session;
    if (!session || session.kind !== kind || !RUNNING_STATES.has(session.state)) throw new ToolError(`no ${KINDS[kind].what} is running (${KINDS[kind].tool} status shows the last one)`);
    return session;
  }

  /**
   * A text message from a page: `{ type: "export", id, kind, ... }`.
   *
   * @param ws - The page.
   * @param message - The parsed message.
   */
  Message(ws: WebSocket, message: { readonly id?: unknown; readonly kind?: unknown } & Record<string, unknown>): void {
    const session = this.session;
    if (!session || session.page !== ws || message.id !== session.id) return;
    const report = message['report'] as Maybe<MovieFileReport>;
    if (report && RUNNING_STATES.has(session.state)) {
      session.progress = report;
      if (RUNNING_STATES.has(report.state)) session.state = report.state;
    }
    switch (message.kind) {
      case 'config': {
        const track = message['track'] as MovieExportTrack;
        this.Write(session, async (writer) => writer.Configure({ ...track, description: exportBase64ToBytes(track.description) }));
        break;
      }
      case 'end':
        if (!RUNNING_STATES.has(session.state)) break;
        session.state = 'finishing';
        this.Write(session, async (writer) => {
          const written = await writer.Finish();
          this.Saved(session, written.bytes, written.seconds, written.samples);
        });
        break;
      case 'failed':
        if (RUNNING_STATES.has(session.state)) this.End(session, 'failed', String(message['error'] ?? 'the page reported a failure'));
        break;
      case 'cancelled':
        if (RUNNING_STATES.has(session.state)) this.End(session, 'cancelled');
        break;
      default:
        break;
    }
  }

  /**
   * A binary message from a page: one encoded chunk.
   *
   * @param ws - The page.
   * @param data - The packet.
   */
  Binary(ws: WebSocket, data: Uint8Array): void {
    const session = this.session;
    if (!session || session.page !== ws || !RUNNING_STATES.has(session.state)) return;
    const packet = decodeExportPacket(data);
    if (!packet || packet.header.id !== session.id) return;
    if (packet.header.seq !== session.nextSeq) {
      this.Fail(session, `chunk ${session.nextSeq} never arrived (chunk ${packet.header.seq} came instead)`);
      return;
    }
    session.nextSeq++;
    const sample = { data: packet.payload, key: packet.header.key, timestamp: packet.header.timestamp };
    this.Write(session, (writer) => writer.AddSample(sample));
  }

  /**
   * A socket closed.
   *
   * @param ws - The socket.
   */
  Closed(ws: WebSocket): void {
    const session = this.session;
    if (session?.page === ws && RUNNING_STATES.has(session.state)) this.End(session, 'failed', `the viewer tab closed or reloaded during the ${session.kind === 'record' ? 'recording' : 'export'}`);
  }

  /**
   * Aborts a running export (the hub stopping).
   */
  async Stop(): Promise<void> {
    const session = this.session;
    if (session && RUNNING_STATES.has(session.state)) this.End(session, 'failed', `the hub stopped during the ${session.kind === 'record' ? 'recording' : 'export'}`);
    await session?.chain;
  }

  private Write(session: Session, write: (writer: Mp4Writer) => Promise<void>): void {
    session.chain = session.chain.then(async () => {
      if (!session.writer || !RUNNING_STATES.has(session.state)) return;
      try {
        await write(session.writer);
      } catch (error) {
        this.Fail(session, `the hub could not write the movie: ${ErrorMessage(error)}`);
      }
    });
  }

  /**
   * A hub-side failure: aborts the file and tells the page to stop.
   */
  private Fail(session: Session, error: string): void {
    if (!RUNNING_STATES.has(session.state)) return;
    this.End(session, 'failed', error);
    this.Send(session, { type: 'export', id: session.id, kind: 'failed', error });
  }

  private End(session: Session, state: 'failed' | 'cancelled', error?: string): void {
    if (!RUNNING_STATES.has(session.state)) return;
    session.state = state;
    session.endedAt = Date.now();
    if (error) session.error = error;
    const why = error ? `: ${error}` : '';
    this.options.log(`${KINDS[session.kind].what} ${session.id} ${state}${why}`);
    session.chain = session.chain.then(() => session.writer?.Abort());
    void session.chain.then(session.settle, session.settle);
  }

  private Saved(session: Session, bytes: number, seconds: number, frames: number): void {
    const plan = session.plan as MovieExportPlan | MovieRecordPlan;
    const file = session.file as MovieExportFile;
    const endedAt = Date.now();
    const wallSeconds = (endedAt - session.startedAt) / 1000;
    session.state = 'done';
    session.endedAt = endedAt;
    session.result = { path: file.path, url: file.url, ...(file.windowsPath ? { windowsPath: file.windowsPath } : {}), bytes, frames, seconds, fps: plan.fps, width: plan.width, height: plan.height, codec: plan.codecString, wallSeconds, meanFps: wallSeconds > 0 ? Math.round((frames / wallSeconds) * 100) / 100 : 0 };
    this.options.log(`${KINDS[session.kind].what} ${session.id} saved ${file.path} (${frames} frames, ${bytes} bytes, ${wallSeconds.toFixed(1)} s)`);
    this.Send(session, { type: 'export', id: session.id, kind: 'saved', file: { ...file, bytes } });
    session.settle();
  }

  private Send(session: Session, message: MovieExportHubMessage): void {
    try {
      session.page.send(JSON.stringify(message));
    } catch {
      // The tab is gone; its close fails the session.
    }
  }
}

/**
 * The status's report before the page's first progress message.
 */
function InitialReport(session: Session): MovieFileReport {
  const shared = {
    id: session.id,
    rate: { fps: 0, realtime: 0 },
    encoder: { queue: 0, chunks: 0, keyFrames: 0, bytes: 0 },
    frameMs: { mean: 0, max: 0, retries: 0 },
    startedAt: new Date(session.startedAt).toISOString(),
    wallSeconds: ((session.endedAt ?? Date.now()) - session.startedAt) / 1000,
    gpuErrors: 0,
    warnings: []
  };
  if (session.kind === 'record') {
    const plan = session.plan as MovieRecordPlan;
    return { ...shared, state: session.state as MovieRecordState, plan, frame: 0, seconds: 0, sceneSeconds: null, left: plan.maxFrames / plan.fps };
  }
  const plan = session.plan as MovieExportPlan;
  return {
    id: session.id,
    state: session.state as MovieExportState,
    plan,
    frame: 0,
    frames: plan.frames,
    progress: 0,
    time: plan.from,
    rate: { fps: 0, realtime: 0 },
    eta: null,
    encoder: { queue: 0, chunks: 0, keyFrames: 0, bytes: 0 },
    frameMs: { mean: 0, max: 0, retries: 0 },
    startedAt: new Date(session.startedAt).toISOString(),
    wallSeconds: ((session.endedAt ?? Date.now()) - session.startedAt) / 1000,
    gpuErrors: 0,
    warnings: []
  };
}

function RunningText(session: Session): string {
  const report = session.progress;
  let text: string = session.state;
  if (report && 'frames' in report) text = `${session.state}, frame ${report.frame} of ${report.frames}`;
  else if (report) text = `${session.state}, ${report.seconds} s recorded`;
  return text;
}

/**
 * The file's path from Windows, under WSL.
 *
 * @param file - The Linux path.
 * @param env - WSL_DISTRO_NAME.
 * @returns `{ windowsPath }` or nothing.
 */
export function WindowsPath(file: string, env: NodeJS.ProcessEnv): { windowsPath?: string } {
  const distro = env['WSL_DISTRO_NAME'];
  return distro ? { windowsPath: `\\\\wsl.localhost\\${distro}${file.replaceAll('/', '\\')}` } : {};
}
