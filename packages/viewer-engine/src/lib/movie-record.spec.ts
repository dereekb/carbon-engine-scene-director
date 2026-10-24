import { describe, expect, it } from 'vitest';
import { decodeExportPacket, type MovieRecordStartCommand, normalizeMovieRecordCommand, type SceneError } from '@scene-director/scene';
import { TICKS_PER_SECOND } from './clock';
import { ExportFrameMicros, ExportFrameTicks } from './export-frames';
import { MovieRecording, type MovieRecordPort, PlanMovieRecord, RECORD_WARMUP_FRAMES, RecordRefusal, RecordText } from './movie-record';
import { type ExportCapture, type ExportChunk, type ExportChunkMetadata, type ExportEncoderConfig, type ExportEncoderPort, MAX_EXPORT_SOCKET_BYTES } from './movie-sink';
import { CUES_A, SHIPS_A, TimelineRig } from './timeline.spec-helper';

class FakeEncoder implements ExportEncoderPort {
  queue = 0;
  ready = true;
  closed = false;
  config: ExportEncoderConfig | null = null;
  readonly frames: { readonly timestamp: number; readonly duration: number; readonly keyFrame: boolean }[] = [];
  private output: (chunk: ExportChunk, metadata?: ExportChunkMetadata) => void = () => undefined;

  Configure(config: ExportEncoderConfig, output: (chunk: ExportChunk, metadata?: ExportChunkMetadata) => void): void {
    this.config = config;
    this.output = output;
  }

  Encode(_source: unknown, frame: { readonly timestamp: number; readonly duration: number; readonly keyFrame: boolean }): void {
    this.frames.push(frame);
    const chunk: ExportChunk = { type: frame.keyFrame ? 'key' : 'delta', timestamp: frame.timestamp, duration: frame.duration, byteLength: 4, copyTo: (destination) => destination.set([1, 2, 3, 4]) };
    this.output(chunk, this.frames.length === 1 ? { decoderConfig: { codec: 'avc1.64001F', description: new Uint8Array([1, 100, 0, 31]) } } : undefined);
  }

  async Flush(): Promise<void> {
    await Promise.resolve();
  }

  Close(): void {
    this.closed = true;
  }
}

/**
 * A recording over a TimelineRig at tick 5, its frames at 60 Hz (main.ts's loop: Step, then a drawn frame's
 * AfterFrame).
 */
function Record(command: Record<string, unknown> = {}, { paused = false, saveTimeoutMs = 30_000 }: { readonly paused?: boolean; readonly saveTimeoutMs?: number } = {}) {
  const rig = TimelineRig(CUES_A, SHIPS_A);
  rig.RunTo(5);
  rig.clock.Resync();
  const start = normalizeMovieRecordCommand({ action: 'start', width: 320, height: 180, fps: 10, source: 'slate', ...command }) as MovieRecordStartCommand;
  const { plan, warnings } = PlanMovieRecord({ command: start, movieLetterbox: null, jumping: false, exporting: false, recording: false, paused, noRenderer: 'headless' });
  const encoder = new FakeEncoder();
  const messages: Record<string, unknown>[] = [];
  const packets: Uint8Array[] = [];
  const captures: { readonly index: number; readonly clock: number; readonly tick: number }[] = [];
  const failures: ExportCapture[] = [];
  let wall = 0;
  const port: MovieRecordPort & { buffered: number; hidden: boolean } = {
    time: rig.control,
    clock: rig.clock,
    world: rig.world,
    buffered: 0,
    hidden: false,
    Capture: (frame) => {
      const failure = failures.shift();
      if (failure) return failure;
      captures.push(frame);
      return { source: 'canvas' };
    },
    Send: (message) => messages.push(message as Record<string, unknown>) > 0,
    SendBinary: (bytes) => packets.push(bytes) > 0,
    GpuErrors: () => 0,
    now: () => (wall += 1),
    Changed: () => undefined
  };
  const recording = new MovieRecording({ id: 'record-1', plan, port, encoder, warnings, saveTimeoutMs });
  recording.Start();
  let ms = 1_000_000;
  let drawn = 0;
  /** Frames of the page loop, each `frameMs` apart. */
  const Frames = (count: number, frameMs = 1000 / 60, drawAnyway = false): number => {
    let draws = 0;
    for (let index = 0; index < count && recording.driving; index++) {
      ms += frameMs;
      if (!recording.Step(ms, drawAnyway)) continue;
      recording.AfterFrame();
      draws++;
    }
    drawn += draws;
    return draws;
  };
  return { rig, recording, encoder, port, messages, packets, captures, failures, warnings, Frames, drawn: () => drawn };
}

async function Settle(): Promise<void> {
  for (let index = 0; index < 5; index++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('MovieRecording', () => {
  it('warms up, then encodes only grid frames as file frames k / fps, each exactly one grid step of scene time', async () => {
    const { rig, recording, encoder, messages, packets, captures, Frames } = Record();
    const before = rig.clock.now;
    expect(Frames(RECORD_WARMUP_FRAMES)).toBe(RECORD_WARMUP_FRAMES);
    expect([recording.state, rig.clock.now, encoder.frames.length]).toEqual(['preparing', before, 0]);
    Frames(1);
    expect(recording.state).toBe('recording');
    expect(rig.control.Report().lock).toEqual({ fps: 10, by: 'record_movie' });
    // 60 Hz frames under a 10 fps grid: one in six is a grid frame, the rest wait (nothing drawn, nothing encoded).
    Frames(120);
    const frames = recording.Report().frame;
    expect(frames).toBeGreaterThanOrEqual(20);
    expect(frames).toBeLessThanOrEqual(21);
    expect(encoder.frames.map((frame) => frame.timestamp)).toEqual(Array.from({ length: frames }, (_, k) => ExportFrameMicros(k, 10)));
    expect(encoder.frames.every((frame, k) => frame.duration === 100_000 && frame.keyFrame === (k % 20 === 0))).toBe(true);
    const log = recording.Log();
    expect(log.map((entry) => entry.index)).toEqual(captures.map((capture) => capture.index));
    for (let k = 1; k < log.length; k++) expect(log[k].clock - log[k - 1].clock).toBe(ExportFrameTicks(1, 10));
    expect(messages[0]).toMatchObject({ kind: 'progress', report: { state: 'recording', frame: 0 } });
    expect(messages[1]).toMatchObject({ kind: 'config', track: { codec: 'h264', width: 320, fps: 10 } });
    expect(decodeExportPacket(packets[0])?.header).toEqual({ id: 'record-1', seq: 0, key: true, timestamp: 0, duration: 100_000 });
    const stopped = recording.Stop('record_movie stop');
    expect(stopped).toMatchObject({ state: 'finishing', note: 'stopped: record_movie stop', seconds: frames / 10 });
    expect(rig.control.recordingMovie).toBe(false);
    expect(rig.control.frameLock).toBeNull();
    expect(Frames(10)).toBe(0);
    await Settle();
    expect(messages.at(-1)).toMatchObject({ kind: 'end', report: { frame: frames } });
    recording.OnHub({ type: 'export', id: 'record-1', kind: 'saved', file: { path: '/tmp/r.mp4', url: 'http://hub/movies/r.mp4' } });
    await Settle();
    expect(recording.Report()).toMatchObject({ state: 'done', frame: frames, file: { path: '/tmp/r.mp4' } });
    expect(encoder.closed).toBe(true);
    expect(RecordText(recording.Report())).toBe(`done · 0:0${(frames / 10).toFixed(1)} · ${frames} frames · /tmp/r.mp4`);
  });

  it('draws but never encodes while paused: the file has no gap and no repeated frame', () => {
    const { rig, recording, Frames } = Record();
    Frames(RECORD_WARMUP_FRAMES + 1);
    Frames(60);
    const before = recording.Report().frame;
    rig.control.Pause(true);
    // Paused frames are holds: drawn at the frozen clock, never encoded.
    expect(Frames(120)).toBe(120);
    expect(recording.Report().frame).toBe(before);
    rig.control.Pause(false);
    Frames(60);
    const log = recording.Log();
    expect(log.length).toBeGreaterThan(before);
    for (let k = 1; k < log.length; k++) expect(log[k].clock - log[k - 1].clock).toBe(ExportFrameTicks(1, 10));
  });

  it('runs a beat under the record lock, and stops by itself at its duration', async () => {
    const { rig, recording, messages, Frames } = Record({ duration: 1.5 });
    Frames(RECORD_WARMUP_FRAMES + 1);
    rig.control.Pause(true);
    const ends: unknown[] = [];
    rig.control.PlayFor(1, (end) => ends.push(end));
    Frames(200, 300);
    expect(ends).toMatchObject([{ endedBy: 'played', played: 1 }]);
    expect(recording.Report().frame).toBe(11);
    // The hold after the beat sends the count at once (the hub's status), not up to a second later.
    expect(messages.filter((message) => message['kind'] === 'progress').at(-1)).toMatchObject({ report: { frame: 11 } });
    rig.control.PlayFor(1, () => undefined);
    Frames(200, 300);
    expect(recording.Report()).toMatchObject({ state: 'finishing', frame: 15, seconds: 1.5, note: 'stopped: its duration (1.5 s of video)' });
    const log = recording.Log();
    for (let k = 1; k < log.length; k++) expect(log[k].clock - log[k - 1].clock).toBe(ExportFrameTicks(1, 10));
    await Settle();
    expect(messages.at(-1)).toMatchObject({ kind: 'end' });
  });

  it('holds the clock on backpressure and a hidden tab; a waiting screenshot still draws a frame', () => {
    const { rig, recording, port, encoder, Frames } = Record();
    Frames(RECORD_WARMUP_FRAMES + 1);
    Frames(30);
    const at = rig.clock.now;
    const frames = recording.Report().frame;
    port.buffered = MAX_EXPORT_SOCKET_BYTES + 1;
    expect(Frames(60)).toBe(0);
    expect(recording.Report().waiting).toMatch(/^the hub link/u);
    expect(Frames(2, 1000 / 60, true)).toBe(2);
    port.buffered = 0;
    encoder.queue = 9;
    expect(Frames(10)).toBe(0);
    encoder.queue = 0;
    port.hidden = true;
    expect(Frames(10)).toBe(0);
    expect([rig.clock.now, recording.Report().frame]).toEqual([at, frames]);
    port.hidden = false;
    Frames(30);
    expect(recording.Report().frame).toBeGreaterThan(frames);
  });

  it('redraws a failed capture at the same grid frame, and fails after three tries', () => {
    const { rig, recording, failures, captures, messages, Frames } = Record();
    Frames(RECORD_WARMUP_FRAMES + 1);
    Frames(12);
    const k = recording.Report().frame;
    failures.push({ error: 'no swap-chain image' });
    Frames(12);
    const redrawn = captures.find((capture) => capture.index === k);
    expect(redrawn?.clock).toBe(recording.Log().find((entry) => entry.index === k)?.clock);
    expect(recording.Report().frameMs.retries).toBe(1);
    failures.push({ error: 'lost' }, { error: 'lost' }, { error: 'lost' });
    Frames(30);
    expect(recording.Report()).toMatchObject({ state: 'failed', error: expect.stringMatching(/failed to draw 3 times: lost$/u) });
    expect(messages.at(-1)).toMatchObject({ kind: 'failed' });
    expect(rig.control.recordingMovie).toBe(false);
  });

  it('cancels, fails quietly when the link closes, and stops with no frame as cancelled', () => {
    const cancelled = Record();
    cancelled.Frames(RECORD_WARMUP_FRAMES + 20);
    expect(cancelled.recording.Cancel('record_movie cancel')).toMatchObject({ state: 'cancelled', note: 'cancelled: record_movie cancel' });
    expect(cancelled.messages.at(-1)).toMatchObject({ kind: 'cancelled' });
    expect([cancelled.encoder.closed, cancelled.rig.control.recordingMovie]).toEqual([true, false]);
    const linked = Record();
    linked.Frames(RECORD_WARMUP_FRAMES + 20);
    const sent = linked.messages.length;
    linked.recording.LinkClosed();
    expect(linked.recording.Report()).toMatchObject({ state: 'failed', error: 'the hub link closed' });
    expect(linked.messages.length).toBe(sent);
    const empty = Record({}, { paused: true });
    empty.rig.control.Pause(true);
    empty.Frames(RECORD_WARMUP_FRAMES + 20);
    expect(empty.recording.Stop('Esc in the tab')).toMatchObject({ state: 'cancelled', note: 'cancelled: Esc in the tab, before any frame was recorded: no file' });
  });

  it('fails when the hub never confirms the file', async () => {
    const { recording, Frames } = Record({}, { saveTimeoutMs: 5 });
    Frames(RECORD_WARMUP_FRAMES + 20);
    recording.Stop('record_movie stop');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(recording.Report()).toMatchObject({ state: 'failed', error: 'the hub did not confirm the file within 0.005 s' });
  });
});

describe('PlanMovieRecord', () => {
  const command = (fields: Record<string, unknown>) => normalizeMovieRecordCommand({ action: 'start', ...fields }) as MovieRecordStartCommand;

  it("plans the output with the movie's look, the duration's frames or the cap's", () => {
    const { plan, warnings } = PlanMovieRecord({ command: command({ duration: 12 }), movieLetterbox: 2.39, jumping: false, exporting: false, recording: false, paused: false, noRenderer: null });
    expect(plan).toMatchObject({ fps: 30, width: 1920, picture: { y: 138, height: 804 }, letterbox: 2.39, codecString: 'avc1.640028', bitrate: 12_441_600, quality: 'standard', duration: 12, maxFrames: 360, keyframeEvery: 60 });
    expect(warnings).toEqual([]);
    expect(PlanMovieRecord({ command: command({ letterbox: false, fps: 24 }), movieLetterbox: 2.39, jumping: false, exporting: false, recording: false, paused: true, noRenderer: null })).toMatchObject({
      plan: { letterbox: false, duration: null, maxFrames: 86_400 },
      warnings: ['the scene is paused: nothing is recorded until it plays (time_control { pause: false } or { play: N })']
    });
  });

  it('refuses a running export, recording or jump and a scene source without a renderer, all at once', () => {
    let problems: string[] = [];
    try {
      PlanMovieRecord({ command: command({}), movieLetterbox: null, jumping: true, exporting: true, recording: true, paused: false, noRenderer: 'no adapter' });
    } catch (error) {
      problems = (error as SceneError).problems;
    }
    expect(problems).toEqual([
      'record_movie: a movie export is running: export_movie { action: "cancel" } stops it',
      'record_movie: a live recording is running: record_movie { action: "stop" } ends it',
      'record_movie: a time-control jump is running: wait for it',
      'record_movie: no renderer (no adapter): record_movie needs WebGPU; source: "slate" records the timing only'
    ]);
  });

  it('refuses only what would cut the video, and writes the overlay row', () => {
    expect(RecordRefusal('time_control', { seek: 3, rate: 2 })).toBe('a live recording is running: time_control seek would cut the video (record_movie { action: "stop" } ends it)');
    expect(RecordRefusal('time_control', { fps: false })).toMatch(/time_control fps would cut/u);
    expect(RecordRefusal('time_control', { rate: 0.25, pause: true, play: 2 })).toBeNull();
    expect(RecordRefusal('movie', { action: 'retake' })).toMatch(/movie retake would cut/u);
    expect(RecordRefusal('movie', { action: 'restart' })).toBeNull();
    expect(RecordRefusal('export_movie', { action: 'start' })).toMatch(/one movie at a time/u);
    expect(RecordRefusal('export_movie', {})).toBeNull();
    expect(RecordRefusal('patch_scene', { operations: [] })).toBeNull();
    const { recording, Frames } = Record();
    Frames(RECORD_WARMUP_FRAMES + 1);
    const report = { ...recording.Report(), state: 'recording' as const, frame: 2502, seconds: 83.4, rate: { fps: 12.6, realtime: 0.42 }, waiting: undefined };
    expect(RecordText({ ...report, plan: { ...report.plan, fps: 30 } })).toBe('recording · 1:23.4 · 2,502 frames · 30 fps · 0.42× real time · Esc stops');
    expect(TICKS_PER_SECOND).toBe(1e7);
  });
});
