/**
 * The half of a movie file both drivers share (sd-export): the movie export (MovieExport) and the live recording
 * (MovieRecording) each step the scene their own way, then hand every captured frame here. MovieSink owns the WebCodecs
 * encoder, the track config and the SDX1 packets to the hub, the progress messages, the end → saved handshake with its
 * timeout, the backpressure checks, the draw rate and the draw-failure count. Node-tested, no runtime import: the
 * encoder is an ExportEncoderPort (WebCodecsEncoder in the page).
 */

import type { Maybe } from '@dereekb/util';
import { encodeExportPacket, EXPORT_PROGRESS_MS, exportBytesToBase64, type MovieExportFile, type MovieExportHardware, type MovieExportTrack, type MovieOutputPlan } from '@scene-director/scene';

/**
 * The encoding waits while the encoder holds more frames than this.
 */
export const MAX_EXPORT_ENCODE_QUEUE = 8;
/**
 * The encoding waits while the hub link buffers more bytes than this.
 */
export const MAX_EXPORT_SOCKET_BYTES = 8 * 1024 * 1024;
/**
 * A frame that fails to draw this many times fails the export or recording.
 */
export const EXPORT_FRAME_RETRIES = 3;
/**
 * How long the file waits for the hub's `saved`, ms.
 */
export const EXPORT_SAVE_TIMEOUT_MS = 30_000;
const FRAME_RATE_WINDOW = 30;

/**
 * The frame just drawn, as an encoder source (a canvas), or why it is not (retried; fatal fails the file).
 */
export type ExportCapture = { readonly source: unknown } | { readonly error: string; readonly fatal?: boolean };

/**
 * An encoded chunk, as WebCodecs gives it.
 */
export interface ExportChunk {
  readonly type: 'key' | 'delta';
  readonly timestamp: number;
  readonly duration: Maybe<number>;
  readonly byteLength: number;
  copyTo(destination: Uint8Array): void;
}

/**
 * The first chunk's metadata: the decoder config the file carries.
 */
export interface ExportChunkMetadata {
  readonly decoderConfig?: { readonly codec: string; readonly description?: ArrayBuffer | ArrayBufferView; readonly colorSpace?: { readonly primaries?: Maybe<string>; readonly transfer?: Maybe<string>; readonly matrix?: Maybe<string>; readonly fullRange?: Maybe<boolean> } };
}

export interface ExportEncoderConfig {
  readonly codec: MovieOutputPlan['codec'];
  readonly codecString: string;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly bitrate: number;
  readonly hardware: MovieExportHardware;
}

/**
 * The encoder (WebCodecsEncoder in the page, a fake in the specs).
 */
export interface ExportEncoderPort {
  Configure(config: ExportEncoderConfig, output: (chunk: ExportChunk, metadata?: ExportChunkMetadata) => void, error: (error: Error) => void): void;
  /**
   * Encodes the source (a canvas) as one frame.
   */
  Encode(source: unknown, frame: { readonly timestamp: number; readonly duration: number; readonly keyFrame: boolean }): void;
  /**
   * Frames waiting in the encoder.
   */
  readonly queue: number;
  /**
   * False while the configure is pending.
   */
  readonly ready: boolean;
  Flush(): Promise<void>;
  Close(): void;
}

/**
 * The page's side of the sink: the hub link, the tab's visibility and the time.
 */
export interface MovieSinkPort {
  Send(message: object): boolean;
  SendBinary(bytes: Uint8Array): boolean;
  readonly buffered: number;
  readonly hidden: boolean;
  now(): number;
}

export interface MovieSinkConfig {
  readonly id: string;
  readonly output: MovieOutputPlan;
  readonly port: MovieSinkPort;
  readonly encoder: ExportEncoderPort;
  readonly saveTimeoutMs?: number;
  /**
   * Whether the driver still runs: a chunk after it stopped is dropped.
   */
  readonly running: () => boolean;
  /**
   * The driver's report, for the progress and end messages.
   */
  readonly report: () => object;
  /**
   * Fails the driver; quiet when the hub already knows (its own failure, the link closing).
   */
  readonly fail: (error: string, options?: { readonly quiet?: boolean }) => void;
}

export class MovieSink {
  readonly counts = { chunks: 0, keyFrames: 0, bytes: 0 };
  private readonly id: string;
  private readonly output: MovieOutputPlan;
  private readonly port: MovieSinkPort;
  private readonly encoder: ExportEncoderPort;
  private readonly saveTimeoutMs: number;
  private readonly running: () => boolean;
  private readonly report: () => object;
  private readonly fail: MovieSinkConfig['fail'];
  private configured = false;
  private configSent = false;
  private seq = 0;
  private failedDraws = 0;
  private retries = 0;
  private readonly frameMs = { total: 0, count: 0, max: 0 };
  private lastAfter: Maybe<number> = null;
  private readonly drawTimes: number[] = [];
  private lastProgress: number;
  private saved: Maybe<{ readonly resolve: (file: MovieExportFile) => void; readonly reject: (error: Error) => void; readonly timer: ReturnType<typeof setTimeout> }> = null;

  constructor({ id, output, port, encoder, saveTimeoutMs = EXPORT_SAVE_TIMEOUT_MS, running, report, fail }: MovieSinkConfig) {
    this.id = id;
    this.output = output;
    this.port = port;
    this.encoder = encoder;
    this.saveTimeoutMs = saveTimeoutMs;
    this.running = running;
    this.report = report;
    this.fail = fail;
    this.lastProgress = port.now();
  }

  /**
   * Frames waiting in the encoder (0 before it is configured).
   */
  get queue(): number {
    return this.configured ? this.encoder.queue : 0;
  }

  /**
   * Configures the encoder for the output; its error callback fails the driver.
   */
  Configure(): void {
    const { output } = this;
    this.encoder.Configure(
      { codec: output.codec, codecString: output.codecString, width: output.width, height: output.height, fps: output.fps, bitrate: output.bitrate, hardware: output.hardware },
      (chunk, metadata) => this.OnChunk(chunk, metadata),
      (error) => this.fail(`the encoder failed: ${ErrorMessage(error)}`)
    );
    this.configured = true;
  }

  /**
   * Encodes a captured frame.
   *
   * @returns False when the encoder threw (the driver failed).
   */
  Encode(source: unknown, frame: { readonly timestamp: number; readonly duration: number; readonly keyFrame: boolean }): boolean {
    try {
      this.encoder.Encode(source, frame);
      return true;
    } catch (error) {
      this.fail(`the encoder failed: ${ErrorMessage(error)}`);
      return false;
    }
  }

  /**
   * What the drawing waits for now (backpressure, a hidden tab, the encoder configuring), or null.
   */
  Waiting(): Maybe<string> {
    let waiting: Maybe<string> = null;
    if (this.port.hidden) waiting = 'the tab is hidden: drawing stops until it shows';
    else if (!this.encoder.ready) waiting = 'the encoder to configure';
    else if (this.encoder.queue > MAX_EXPORT_ENCODE_QUEUE) waiting = `the encoder (${this.encoder.queue} frames queued)`;
    else if (this.port.buffered > MAX_EXPORT_SOCKET_BYTES) waiting = `the hub link (${Round(this.port.buffered / 1048576, 1)} MiB buffered)`;
    return waiting;
  }

  /**
   * A frame failed to draw.
   *
   * @returns The failures in a row (EXPORT_FRAME_RETRIES fails the driver).
   */
  DrawFailed(): number {
    this.failedDraws += 1;
    this.retries += 1;
    return this.failedDraws;
  }

  /**
   * A frame drew: the failures in a row reset, and the draw is timed.
   */
  Drew(): void {
    this.failedDraws = 0;
    const now = this.port.now();
    if (this.lastAfter != null) {
      const ms = now - this.lastAfter;
      this.frameMs.total += ms;
      this.frameMs.count += 1;
      this.frameMs.max = Math.max(this.frameMs.max, ms);
    }
    this.lastAfter = now;
    this.drawTimes.push(now);
    if (this.drawTimes.length > FRAME_RATE_WINDOW) this.drawTimes.shift();
  }

  /**
   * Frames drawn a wall second over the last frames, and scene seconds a wall second (at the output's fps).
   */
  Rate(): { readonly fps: number; readonly realtime: number } {
    const times = this.drawTimes;
    const span = times.length > 1 ? (times[times.length - 1] - times[0]) / 1000 : 0;
    const fps = span > 0 ? (times.length - 1) / span : 0;
    return { fps: Round(fps, 2), realtime: Round(fps / this.output.fps, 3) };
  }

  /**
   * The frame times for the report.
   */
  FrameMs(): { readonly mean: number; readonly max: number; readonly retries: number } {
    return { mean: this.frameMs.count ? Round(this.frameMs.total / this.frameMs.count, 2) : 0, max: Round(this.frameMs.max, 2), retries: this.retries };
  }

  /**
   * Sends a progress message when EXPORT_PROGRESS_MS passed since the last, or now when forced (a state change).
   *
   * @param force - Send it whatever the time.
   */
  Progress(force = false): void {
    const now = this.port.now();
    if (!force && now - this.lastProgress < EXPORT_PROGRESS_MS) return;
    this.lastProgress = now;
    this.port.Send({ type: 'export', id: this.id, kind: 'progress', report: this.report() });
  }

  /**
   * Flushes the encoder: every frame's chunk has gone to the hub when it resolves.
   */
  async Flush(): Promise<void> {
    await this.encoder.Flush();
  }

  /**
   * Tells the hub the file ended and waits for its saved (EXPORT_SAVE_TIMEOUT_MS).
   *
   * @returns The saved file.
   * @throws {Error} When the link is closed, or the hub did not answer in time.
   */
  async End(): Promise<MovieExportFile> {
    if (!this.port.Send({ type: 'export', id: this.id, kind: 'end', report: this.report() })) throw new Error('the hub link closed');
    return new Promise<MovieExportFile>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.saved = null;
        reject(new Error(`the hub did not confirm the file within ${this.saveTimeoutMs / 1000} s`));
      }, this.saveTimeoutMs);
      this.saved = { resolve, reject, timer };
    });
  }

  /**
   * A hub message for this file: saved (the file) or failed (a disk error).
   *
   * @param message - `{ type: "export", id, kind, ... }`.
   */
  OnHub(message: Record<string, unknown>): void {
    if (message['id'] !== this.id) return;
    if (message['kind'] === 'saved') {
      const saved = this.saved;
      this.saved = null;
      if (saved) {
        clearTimeout(saved.timer);
        saved.resolve(message['file'] as MovieExportFile);
      }
    } else if (message['kind'] === 'failed') this.fail(String(message['error'] ?? 'the hub failed the export'), { quiet: true });
  }

  /**
   * Closes the encoder and drops the saved wait (the driver stopped).
   */
  Close(): void {
    if (this.configured) {
      try {
        this.encoder.Close();
      } catch {
        // Already closed.
      }
    }
    const saved = this.saved;
    this.saved = null;
    if (saved) clearTimeout(saved.timer);
  }

  private OnChunk(chunk: ExportChunk, metadata?: ExportChunkMetadata): void {
    if (!this.running()) return;
    if (!this.configSent) {
      const config = metadata?.decoderConfig;
      if (!config?.description) {
        this.fail('the encoder gave no decoder description (avcC / hvcC) with its first chunk');
        return;
      }
      const colorSpace = config.colorSpace;
      const track: MovieExportTrack = {
        codec: this.output.codec,
        codecString: config.codec,
        width: this.output.width,
        height: this.output.height,
        fps: this.output.fps,
        description: exportBytesToBase64(BytesOf(config.description)),
        ...(colorSpace ? { colorSpace: { primaries: colorSpace.primaries ?? null, transfer: colorSpace.transfer ?? null, matrix: colorSpace.matrix ?? null, fullRange: colorSpace.fullRange ?? null } } : {})
      };
      if (!this.port.Send({ type: 'export', id: this.id, kind: 'config', track })) {
        this.fail('the hub link closed', { quiet: true });
        return;
      }
      this.configSent = true;
    }
    const bytes = new Uint8Array(chunk.byteLength);
    chunk.copyTo(bytes);
    const key = chunk.type === 'key';
    if (!this.port.SendBinary(encodeExportPacket({ id: this.id, seq: this.seq++, key, timestamp: chunk.timestamp, duration: chunk.duration ?? 0 }, bytes))) {
      this.fail('the hub link closed', { quiet: true });
      return;
    }
    this.counts.chunks += 1;
    this.counts.bytes += bytes.byteLength;
    if (key) this.counts.keyFrames += 1;
  }
}

/**
 * The WebCodecs encoder (the page): a VideoEncoder configured for the plan, H.264 in avcC or HEVC in hvcC form.
 */
export class WebCodecsEncoder implements ExportEncoderPort {
  private encoder: Maybe<VideoEncoder> = null;

  /**
   * Whether this page encodes video at all.
   */
  static get available(): boolean {
    return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
  }

  /**
   * The encoder preference WebCodecs accepts for a plan: prefer-hardware, else no-preference.
   *
   * @param config - The plan's encoder config (its hardware is ignored).
   * @returns The preference.
   * @throws {Error} When neither is supported.
   */
  static async Support(config: Omit<ExportEncoderConfig, 'hardware'>): Promise<MovieExportHardware> {
    if (!WebCodecsEncoder.available) throw new Error('this browser has no WebCodecs VideoEncoder: use a current Chrome or Edge');
    for (const hardware of ['prefer-hardware', 'no-preference'] as const) {
      const support = await VideoEncoder.isConfigSupported(EncoderConfig({ ...config, hardware })).catch(() => null);
      if (support?.supported) return hardware;
    }
    throw new Error(`the encoder does not support ${config.codecString} (${config.codec}) at ${config.width} × ${config.height}, ${config.fps} fps, ${config.bitrate} bits a second`);
  }

  get queue(): number {
    return this.encoder?.encodeQueueSize ?? 0;
  }

  get ready(): boolean {
    return this.encoder?.state === 'configured';
  }

  Configure(config: ExportEncoderConfig, output: (chunk: ExportChunk, metadata?: ExportChunkMetadata) => void, error: (error: Error) => void): void {
    const encoder = new VideoEncoder({ output: (chunk, metadata) => output(chunk as ExportChunk, (metadata as Maybe<ExportChunkMetadata>) ?? undefined), error });
    encoder.configure(EncoderConfig(config));
    this.encoder = encoder;
  }

  Encode(source: unknown, { timestamp, duration, keyFrame }: { readonly timestamp: number; readonly duration: number; readonly keyFrame: boolean }): void {
    const encoder = this.encoder;
    if (!encoder) throw new Error('the encoder is not configured');
    const frame = new VideoFrame(source as CanvasImageSource, { timestamp, duration });
    try {
      encoder.encode(frame, { keyFrame });
    } finally {
      frame.close();
    }
  }

  async Flush(): Promise<void> {
    await this.encoder?.flush();
  }

  Close(): void {
    const encoder = this.encoder;
    this.encoder = null;
    if (encoder && encoder.state !== 'closed') encoder.close();
  }
}

function EncoderConfig(config: ExportEncoderConfig): VideoEncoderConfig {
  const base = { codec: config.codecString, width: config.width, height: config.height, displayWidth: config.width, displayHeight: config.height, bitrate: config.bitrate, bitrateMode: 'variable', framerate: config.fps, latencyMode: 'quality', hardwareAcceleration: config.hardware } as const;
  return (config.codec === 'hevc' ? { ...base, hevc: { format: 'hevc' } } : { ...base, avc: { format: 'avc' } }) as VideoEncoderConfig;
}

function BytesOf(source: ArrayBuffer | ArrayBufferView): Uint8Array {
  return ArrayBuffer.isView(source) ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength) : new Uint8Array(source);
}

export function ErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function Round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
