import { describe, expect, it } from 'vitest';
import { decodeExportPacket, type MovieExportStartCommand, normalizeMovieExportCommand, SceneError } from '@scene-director/scene';
import { TICKS_PER_SECOND } from './clock';
import { ExportFrameMicros, ExportFrameTicks } from './export-frames';
import { SlateLines } from './export-slate';
import { type ExportCapture, type ExportChunk, type ExportChunkMetadata, type ExportEncoderConfig, type ExportEncoderPort, ExportAllows, ExportRefusal, ExportText, MAX_EXPORT_SOCKET_BYTES, MovieExport, type MovieExportPlanInput, type MovieExportPort, PlanMovieExport } from './movie-export';
import { CUES_A, SHIPS_A, TimelineRig } from './timeline.spec-helper';

class FakeEncoder implements ExportEncoderPort {
  queue = 0;
  ready = true;
  closed = false;
  config: ExportEncoderConfig | null = null;
  readonly frames: { readonly timestamp: number; readonly duration: number; readonly keyFrame: boolean }[] = [];
  error: (error: Error) => void = () => undefined;
  private output: (chunk: ExportChunk, metadata?: ExportChunkMetadata) => void = () => undefined;

  Configure(config: ExportEncoderConfig, output: (chunk: ExportChunk, metadata?: ExportChunkMetadata) => void, error: (error: Error) => void): void {
    this.config = config;
    this.output = output;
    this.error = error;
  }

  Encode(_source: unknown, frame: { readonly timestamp: number; readonly duration: number; readonly keyFrame: boolean }): void {
    this.frames.push(frame);
    const chunk: ExportChunk = { type: frame.keyFrame ? 'key' : 'delta', timestamp: frame.timestamp, duration: frame.duration, byteLength: 4, copyTo: (destination) => destination.set([1, 2, 3, 4]) };
    this.output(chunk, this.frames.length === 1 ? { decoderConfig: { codec: 'avc1.64001F', description: new Uint8Array([1, 100, 0, 31]), colorSpace: { primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'bt709', fullRange: false } } } : undefined);
  }

  async Flush(): Promise<void> {
    await Promise.resolve();
  }

  Close(): void {
    this.closed = true;
  }
}

interface Harness {
  readonly rig: ReturnType<typeof TimelineRig>;
  readonly exporter: MovieExport;
  readonly encoder: FakeEncoder;
  readonly port: MovieExportPort & { buffered: number; hidden: boolean };
  readonly messages: Record<string, unknown>[];
  readonly packets: Uint8Array[];
  readonly locks: boolean[];
  readonly seeks: number[];
  readonly captures: { readonly index: number; readonly clock: number; readonly time: number }[];
  /** Capture results to hand out before drawing normally. */
  readonly failures: ExportCapture[];
  zero: number;
}

function Start(command: Record<string, unknown>, timeline: MovieExportPlanInput['timeline'] = null, saveTimeoutMs = 30_000): Harness {
  const rig = TimelineRig(CUES_A, SHIPS_A);
  rig.RunTo(5);
  const start = normalizeMovieExportCommand({ action: 'start', width: 320, height: 180, source: 'slate', ...command }) as MovieExportStartCommand;
  const { plan, warnings } = PlanMovieExport({ command: start, timeline, jumping: false, exporting: false, noRenderer: 'headless' });
  const encoder = new FakeEncoder();
  const messages: Record<string, unknown>[] = [];
  const packets: Uint8Array[] = [];
  const locks: boolean[] = [];
  const seeks: number[] = [];
  const captures: Harness['captures'][number][] = [];
  const failures: ExportCapture[] = [];
  let now = 0;
  const harness = { rig, encoder, messages, packets, locks, seeks, captures, failures, zero: 0 } as unknown as Harness & { exporter: MovieExport; port: Harness['port'] };
  const port: Harness['port'] = {
    time: rig.control,
    clock: rig.clock,
    world: rig.world,
    buffered: 0,
    hidden: false,
    Lock: (on) => void locks.push(on),
    Restart: async () => {
      rig.control.Pause(true);
      harness.zero = rig.world.NextBoundaryTime() ?? 0;
      return harness.zero;
    },
    TimelineOrigin: () => harness.zero,
    CanSeek: () => true,
    Seek: async (clock) => {
      seeks.push(clock);
      return [];
    },
    Capture: (step, time) => {
      const failure = failures.shift();
      if (failure) return failure;
      captures.push({ index: step.index, clock: step.clock, time });
      return { source: 'canvas' };
    },
    Send: (message) => messages.push(message as Record<string, unknown>) > 0,
    SendBinary: (bytes) => packets.push(bytes) > 0,
    GpuErrors: () => 0,
    now: () => (now += 10),
    Changed: () => undefined
  };
  harness.port = port;
  harness.exporter = new MovieExport({ id: 'export-1', plan, port, encoder, warnings, saveTimeoutMs });
  return harness;
}

/** main.ts's loop: Step, then (a frame drawn) AfterFrame, until the export stops driving. */
function Drive(exporter: MovieExport, limit = 100_000): number {
  let drawn = 0;
  for (let guard = 0; guard < limit && exporter.driving; guard++) {
    if (!exporter.Step()) continue;
    exporter.AfterFrame();
    drawn++;
  }
  return drawn;
}

async function Settle(): Promise<void> {
  for (let index = 0; index < 5; index++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('MovieExport', () => {
  it('renders every frame on the grid, encodes them with exact timestamps and keyframes, and ends on the hub save', async () => {
    const { exporter, encoder, messages, packets, locks, rig, captures } = Start({ duration: 3, fps: 10 });
    const origin = rig.clock.now;
    await exporter.Start();
    expect(exporter.state).toBe('rendering');
    expect(rig.control.exporting).toBe(true);
    expect(encoder.config).toMatchObject({ codecString: 'avc1.64001F', width: 320, height: 180, fps: 10 });
    expect(Drive(exporter)).toBe(30);
    expect(encoder.frames).toEqual(Array.from({ length: 30 }, (_, index) => ({ timestamp: ExportFrameMicros(index, 10), duration: ExportFrameMicros(index + 1, 10) - ExportFrameMicros(index, 10), keyFrame: index % 20 === 0 })));
    expect(captures.map((capture) => capture.clock)).toEqual(Array.from({ length: 30 }, (_, index) => origin + ExportFrameTicks(index, 10)));
    expect(captures[12].time).toBeCloseTo(1.2, 9);
    // The config goes before the first chunk, the chunks count up.
    expect(messages[0]).toMatchObject({ type: 'export', id: 'export-1', kind: 'config', track: { codec: 'h264', codecString: 'avc1.64001F', width: 320, fps: 10, colorSpace: { primaries: 'bt709' } } });
    expect(packets.map((packet) => decodeExportPacket(packet)?.header.seq)).toEqual(Array.from({ length: 30 }, (_, index) => index));
    expect(decodeExportPacket(packets[20])?.header).toMatchObject({ key: true, timestamp: 2_000_000 });
    expect(exporter.state).toBe('finishing');
    expect(rig.control.exporting).toBe(false);
    expect(rig.control.paused).toBe(true);
    expect(rig.clock.now).toBe(origin + ExportFrameTicks(29, 10));
    await Settle();
    expect(messages.at(-1)).toMatchObject({ kind: 'end', report: { frame: 30, frames: 30 } });
    exporter.OnHub({ type: 'export', id: 'export-1', kind: 'saved', file: { path: '/tmp/a.mp4', url: 'http://hub/movies/a.mp4', bytes: 999 } });
    await Settle();
    expect(exporter.state).toBe('done');
    expect(exporter.Report()).toMatchObject({ state: 'done', frame: 30, progress: 1, eta: 0, encoder: { chunks: 30, keyFrames: 2, bytes: 120 }, file: { path: '/tmp/a.mp4' } });
    expect(encoder.closed).toBe(true);
    expect(locks).toEqual([true, false]);
    expect(exporter.Summary()).toEqual({ frames: 30, minStepTicks: 1_000_000, maxStepTicks: 1_000_000 });
  });

  it('restarts the movie, seeks to the preroll and draws the preroll without encoding it', async () => {
    const harness = Start({ from: 3, to: 4, fps: 10, preroll: 0.5 }, { state: 'playing', started: true, held: false, end: 10, letterbox: 2.39 });
    const { exporter, encoder, captures, seeks } = harness;
    expect(exporter.plan).toMatchObject({ restart: true, timeline: true, frames: 10, preroll: { frames: 5, seconds: 0.5 }, picture: { y: 23, height: 134 } });
    await exporter.Start();
    expect(exporter.state).toBe('prerolling');
    const origin = harness.zero + 3 * TICKS_PER_SECOND;
    expect(seeks).toEqual([origin - TICKS_PER_SECOND / 2]);
    Drive(exporter);
    expect(captures.map((capture) => capture.index)).toEqual(Array.from({ length: 15 }, (_, index) => index - 5));
    expect(captures[0].clock).toBe(origin - TICKS_PER_SECOND / 2);
    expect(captures[5]).toMatchObject({ index: 0, clock: origin });
    expect(captures[5].time).toBeCloseTo(3, 9);
    expect(encoder.frames.map((frame) => frame.timestamp)).toEqual(Array.from({ length: 10 }, (_, index) => ExportFrameMicros(index, 10)));
    expect(encoder.frames[0].keyFrame).toBe(true);
  });

  it('waits on backpressure and a hidden tab without moving the clock', async () => {
    const { exporter, encoder, port, rig } = Start({ duration: 2, fps: 10 });
    await exporter.Start();
    exporter.Step();
    exporter.AfterFrame();
    const clock = rig.clock.now;
    encoder.queue = 9;
    expect(exporter.Step()).toBeNull();
    expect(exporter.Report().waiting).toBe('the encoder (9 frames queued)');
    encoder.queue = 0;
    port.buffered = MAX_EXPORT_SOCKET_BYTES + 1;
    expect(exporter.Step()).toBeNull();
    expect(exporter.Report().waiting).toMatch(/^the hub link \(8 MiB buffered\)$/u);
    port.buffered = 0;
    port.hidden = true;
    expect(exporter.Step()).toBeNull();
    expect(exporter.Report().waiting).toBe('the tab is hidden: drawing stops until it shows');
    encoder.ready = false;
    port.hidden = false;
    expect(exporter.Step()).toBeNull();
    expect(rig.clock.now).toBe(clock);
    encoder.ready = true;
    expect(exporter.Step()?.index).toBe(1);
  });

  it('redraws a failed frame at the same clock, and fails after three tries', async () => {
    const { exporter, failures, captures, messages, locks, rig } = Start({ duration: 2, fps: 10 });
    await exporter.Start();
    failures.push({ error: 'no texture' }, { error: 'no texture' });
    const first = exporter.Step();
    exporter.AfterFrame();
    const again = exporter.Step();
    exporter.AfterFrame();
    const third = exporter.Step();
    exporter.AfterFrame();
    expect(again?.clock).toBe(first?.clock);
    expect(third?.clock).toBe(first?.clock);
    expect(captures).toHaveLength(1);
    expect(exporter.Report().frameMs.retries).toBe(2);
    exporter.Step();
    failures.push({ error: 'gone' }, { error: 'gone' }, { error: 'gone' });
    exporter.AfterFrame();
    exporter.Step();
    exporter.AfterFrame();
    exporter.Step();
    exporter.AfterFrame();
    expect(exporter.state).toBe('failed');
    expect(exporter.Report().error).toMatch(/^frame 1 \(timeline 0\.1 s\) failed to draw 3 times: gone$/u);
    expect(messages.at(-1)).toMatchObject({ kind: 'failed', error: exporter.Report().error });
    expect(locks).toEqual([true, false]);
    expect(rig.control.exporting).toBe(false);
    expect(rig.control.paused).toBe(true);
  });

  it('cancels mid-way: the encoder closes, the hub hears it, the page unlocks and the clock pauses', async () => {
    const { exporter, encoder, messages, locks, rig } = Start({ duration: 2, fps: 10 });
    await exporter.Start();
    Drive(exporter, 5);
    const report = exporter.Cancel('Esc in the tab');
    expect(report).toMatchObject({ state: 'cancelled', note: 'cancelled: Esc in the tab' });
    expect(encoder.closed).toBe(true);
    expect(messages.at(-1)).toMatchObject({ kind: 'cancelled' });
    expect(locks).toEqual([true, false]);
    expect(rig.control.exporting).toBe(false);
    expect(rig.control.paused).toBe(true);
    expect(exporter.Step()).toBeNull();
    expect(() => exporter.Cancel('again')).toThrow(/no movie export is running/u);
  });

  it('fails on the encoder error, the link closing, a hub failure and a missing save', async () => {
    const broken = Start({ duration: 2, fps: 10 });
    await broken.exporter.Start();
    broken.encoder.error(new Error('boom'));
    expect(broken.exporter.Report()).toMatchObject({ state: 'failed', error: 'the encoder failed: boom' });

    const closed = Start({ duration: 2, fps: 10 });
    await closed.exporter.Start();
    closed.exporter.LinkClosed();
    expect(closed.exporter.Report()).toMatchObject({ state: 'failed', error: 'the hub link closed' });
    expect(closed.messages.some((message) => message['kind'] === 'failed')).toBe(false);

    const disk = Start({ duration: 2, fps: 10 });
    await disk.exporter.Start();
    disk.exporter.OnHub({ type: 'export', id: 'export-1', kind: 'failed', error: 'the hub could not write the movie: ENOSPC' });
    expect(disk.exporter.state).toBe('failed');

    const unsaved = Start({ duration: 1, fps: 10 }, null, 5);
    await unsaved.exporter.Start();
    Drive(unsaved.exporter);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(unsaved.exporter.Report()).toMatchObject({ state: 'failed', error: 'the hub did not confirm the file within 0.005 s' });
  });
});

describe('PlanMovieExport', () => {
  const command = (input: Record<string, unknown>) => normalizeMovieExportCommand({ action: 'start', ...input }) as MovieExportStartCommand;
  const timeline = { state: 'playing' as const, started: true, held: false, end: 95, letterbox: 2.39 };

  it("plans the movie's whole length with its look", () => {
    const { plan, warnings } = PlanMovieExport({ command: command({}), timeline, jumping: false, exporting: false, noRenderer: null });
    expect(plan).toMatchObject({ from: 0, to: 95, seconds: 95, frames: 2850, fps: 30, width: 1920, height: 1080, picture: { x: 0, y: 138, width: 1920, height: 804 }, letterbox: 2.39, codecString: 'avc1.640028', bitrate: 12_441_600, restart: true, preroll: { frames: 0 }, keyframeEvery: 60 });
    expect(warnings).toEqual([]);
    expect(PlanMovieExport({ command: command({ from: 30, to: 100, letterbox: false }), timeline, jumping: false, exporting: false, noRenderer: null })).toMatchObject({
      plan: { frames: 2100, picture: { y: 0, height: 1080 }, preroll: { frames: 60 } },
      warnings: ["to is past the movie's end (95 s): the scene plays on after it"]
    });
  });

  it('refuses what needs the scene, with every problem at once', () => {
    const problems = (input: MovieExportPlanInput): string[] => {
      try {
        PlanMovieExport(input);
      } catch (error) {
        expect(error).toBeInstanceOf(SceneError);
        return (error as SceneError).problems;
      }
      return [];
    };
    expect(problems({ command: command({ to: 4 }), timeline: null, jumping: true, exporting: true, noRenderer: 'no adapter' })).toEqual([
      'export_movie: a movie export is running: export_movie { action: "cancel" } stops it',
      'export_movie: a time-control jump is running: wait for it',
      'export_movie: no renderer (no adapter): export_movie needs WebGPU; source: "slate" exports the timing only',
      'export_movie: this scene has no timeline: give duration, seconds from now'
    ]);
    expect(problems({ command: command({ source: 'slate' }), timeline: { ...timeline, end: null }, jumping: false, exporting: false, noRenderer: null })).toEqual(['export_movie: the movie has no end: give to or duration, or movie set { movie: { end } }']);
    expect(problems({ command: command({ restart: false, to: 3 }), timeline: { ...timeline, state: 'stopped', started: false }, jumping: false, exporting: false, noRenderer: null })[0]).toMatch(/restart: false needs a started timeline \(it is stopped\)/u);
    expect(problems({ command: command({ restart: false, to: 3 }), timeline: { ...timeline, state: 'preparing', held: true }, jumping: false, exporting: false, noRenderer: null })[0]).toMatch(/holds the clock/u);
  });
});

describe('the export locks and texts', () => {
  it('allows the reads, save, screenshot and the status forms only', () => {
    for (const name of ['get_state', 'get_scene', 'get_overview', 'list_hardpoints', 'screenshot', 'list_scenes', 'save_scene', 'export_movie']) expect(ExportAllows(name, {})).toBe(true);
    expect(ExportAllows('timeline', {})).toBe(true);
    expect(ExportAllows('timeline', { action: 'status' })).toBe(true);
    expect(ExportAllows('timeline', { action: 'play' })).toBe(false);
    expect(ExportAllows('movie', { action: 'status' })).toBe(true);
    expect(ExportAllows('movie', { action: 'seek', to: 3 })).toBe(false);
    expect(ExportAllows('time_control', {})).toBe(true);
    expect(ExportAllows('time_control', { pause: false })).toBe(false);
    for (const name of ['patch_scene', 'load_scene', 'play_shot', 'order_ship', 'a_new_tool']) expect(ExportAllows(name, {})).toBe(false);
    expect(ExportRefusal({ state: 'rendering', frame: 412, frames: 2850 })).toBe('a movie export is running (rendering, frame 412 of 2850): export_movie { action: "cancel" } stops it');
  });

  it('writes the overlay row and the slate', async () => {
    const { exporter } = Start({ duration: 2, fps: 10 });
    const report = { ...exporter.Report(), waiting: undefined, state: 'rendering' as const, frame: 412, frames: 2850, progress: 412 / 2850, rate: { fps: 5.2, realtime: 0.17 }, eta: 468 };
    expect(ExportText(report)).toBe('rendering · frame 412/2850 (14 %) · 5.2 fps · 7 min 48 s left · Esc cancels');
    expect(ExportText({ ...report, state: 'failed', error: 'the hub link closed' })).toBe('failed: the hub link closed');
    expect(SlateLines({ scene: 'duel', time: 12.0333, index: 360, frames: 900, tick: 15, fps: 30 })).toEqual(['duel', 'timeline 12.033 s', 'frame 361 / 900', 'tick 15', 'fps 30']);
    expect(SlateLines({ scene: null, time: 0, index: -3, frames: 9, tick: 2, fps: 10 })[2]).toBe('preroll -3');
  });
});
