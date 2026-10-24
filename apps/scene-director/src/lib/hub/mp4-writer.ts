/**
 * A minimal MP4 writer for one video track (sd-export): a non-fragmented ISO BMFF with the moov at the end. `Open`
 * writes `ftyp` and an `mdat` header whose 64-bit size is patched at the end; each sample's bytes are appended in
 * order with positional writes, so a long 4K export streams to disk and never sits in memory; `Finish` writes the
 * `moov` (one track: `avc1` + `avcC` or `hvc1` + `hvcC` from the encoder's own description, `colr` nclx and `pasp`,
 * the sample table with `co64` offsets), then renames the part file. Chrome plays a moov-at-end file over the hub's
 * Range route, so no faststart pass.
 *
 * Timing: the track's timescale is fps × 1000 and every sample lasts 1000 units (one `stts` entry); the movie's is
 * 1000. A sample whose timestamp is not its index's frame time gets a `ctts` (version 1) offset; Chrome's encoders
 * emit none today (no B-frames).
 */

import { open, rename, unlink, type FileHandle } from 'node:fs/promises';
import type { MovieExportTrack } from '@scene-director/scene';

/**
 * One sample as the page sent it.
 */
export interface Mp4Sample {
  readonly data: Uint8Array;
  readonly key: boolean;
  /**
   * Microseconds from the start.
   */
  readonly timestamp: number;
}

/**
 * The track: the page's config, its description decoded.
 */
export type Mp4TrackConfig = Omit<MovieExportTrack, 'description'> & { readonly description: Uint8Array };

export interface Mp4WriterResult {
  readonly bytes: number;
  readonly samples: number;
  readonly seconds: number;
}

interface SampleRecord {
  readonly size: number;
  readonly key: boolean;
  readonly offset: number;
  readonly timestamp: number;
}

const MOVIE_TIMESCALE = 1000;
const SAMPLE_DELTA = 1000;
const MDAT_HEADER_SIZE = 16;
const UNITY_MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];
const COLOR_PRIMARIES: Record<string, number> = { bt709: 1, bt470bg: 5, smpte170m: 6, bt2020: 9, smpte432: 12 };
const COLOR_TRANSFERS: Record<string, number> = { bt709: 1, smpte170m: 6, linear: 8, 'iec61966-2-1': 13, pq: 16, hlg: 18 };
const COLOR_MATRICES: Record<string, number> = { rgb: 0, bt709: 1, bt470bg: 5, smpte170m: 6, 'bt2020-ncl': 9 };

export class Mp4Writer {
  private readonly samples: SampleRecord[] = [];
  private track: Mp4TrackConfig | null = null;
  private position: number;
  private closed = false;

  private constructor(
    private readonly handle: FileHandle,
    private readonly partPath: string,
    private readonly path: string,
    private readonly mdatOffset: number
  ) {
    this.position = mdatOffset + MDAT_HEADER_SIZE;
  }

  /**
   * Creates the part file and writes its header.
   *
   * @param input - Where to write, and the finished file's path.
   * @param input.partPath - The part file.
   * @param input.path - The finished file (Finish renames the part to it).
   * @param input.codec - The codec, for the compatible brands.
   * @returns The writer.
   */
  static async Open(input: { readonly partPath: string; readonly path: string; readonly codec?: MovieExportTrack['codec'] }): Promise<Mp4Writer> {
    const handle = await open(input.partPath, 'wx');
    const ftyp = Box('ftyp', Ascii('isom'), U32(512), Ascii('isom'), Ascii('iso2'), Ascii(input.codec === 'hevc' ? 'hvc1' : 'avc1'), Ascii('mp41'));
    const mdat = Concat(U32(1), Ascii('mdat'), U64(0));
    await handle.write(Concat(ftyp, mdat), 0, ftyp.byteLength + mdat.byteLength, 0);
    return new Mp4Writer(handle, input.partPath, input.path, ftyp.byteLength);
  }

  /**
   * Bytes written so far.
   */
  get bytes(): number {
    return this.position;
  }

  get sampleCount(): number {
    return this.samples.length;
  }

  /**
   * Takes the track (once, before the first sample).
   *
   * @param track - The encoder's config.
   */
  Configure(track: Mp4TrackConfig): void {
    if (this.track) throw new Error('the track is already configured');
    if (!Number.isInteger(track.fps) || track.fps < 1) throw new Error(`a track's fps must be a positive integer (${track.fps})`);
    this.track = track;
  }

  /**
   * Appends one sample's bytes.
   *
   * @param sample - The sample, in decode order.
   */
  async AddSample(sample: Mp4Sample): Promise<void> {
    if (!this.track) throw new Error('a sample arrived before the track was configured');
    if (this.closed) throw new Error('the file is closed');
    const offset = this.position;
    this.position += sample.data.byteLength;
    this.samples.push({ size: sample.data.byteLength, key: sample.key, offset, timestamp: sample.timestamp });
    await this.handle.write(sample.data, 0, sample.data.byteLength, offset);
  }

  /**
   * Writes the moov, patches the mdat size, closes the file and renames it.
   *
   * @returns The file's bytes, samples and seconds.
   */
  async Finish(): Promise<Mp4WriterResult> {
    const track = this.track;
    if (!track) throw new Error('no track: the encoder never configured one');
    if (!this.samples.length) throw new Error('no samples were written');
    const moov = this.Moov(track);
    const moovOffset = this.position;
    await this.handle.write(moov, 0, moov.byteLength, moovOffset);
    await this.handle.write(U64(moovOffset - this.mdatOffset), 0, 8, this.mdatOffset + 8);
    await this.Close();
    await rename(this.partPath, this.path);
    return { bytes: moovOffset + moov.byteLength, samples: this.samples.length, seconds: this.samples.length / track.fps };
  }

  /**
   * Closes and deletes the part file.
   */
  async Abort(): Promise<void> {
    await this.Close().catch(() => undefined);
    await unlink(this.partPath).catch(() => undefined);
  }

  private async Close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.handle.close();
  }

  private Moov(track: Mp4TrackConfig): Uint8Array {
    const count = this.samples.length;
    const movieDuration = Math.round((count * MOVIE_TIMESCALE) / track.fps);
    const mvhd = FullBox('mvhd', 0, 0, U32(0), U32(0), U32(MOVIE_TIMESCALE), U32(movieDuration), U32(0x00010000), U16(0x0100), new Uint8Array(10), Matrix(), new Uint8Array(24), U32(2));
    const tkhd = FullBox('tkhd', 0, 3, U32(0), U32(0), U32(1), U32(0), U32(movieDuration), new Uint8Array(8), U16(0), U16(0), U16(0), U16(0), Matrix(), U32(track.width * 0x10000), U32(track.height * 0x10000));
    const mdhd = FullBox('mdhd', 0, 0, U32(0), U32(0), U32(track.fps * 1000), U32(count * SAMPLE_DELTA), U16(0x55c4), U16(0));
    const hdlr = FullBox('hdlr', 0, 0, U32(0), Ascii('vide'), new Uint8Array(12), Ascii('VideoHandler\0'));
    const vmhd = FullBox('vmhd', 0, 1, U16(0), new Uint8Array(6));
    const dinf = Box('dinf', FullBox('dref', 0, 0, U32(1), FullBox('url ', 0, 1)));
    const stbl = Box(
      'stbl',
      this.Stsd(track),
      FullBox('stts', 0, 0, U32(1), U32(count), U32(SAMPLE_DELTA)),
      ...this.Ctts(track),
      this.Stss(),
      FullBox('stsc', 0, 0, U32(1), U32(1), U32(1), U32(1)),
      FullBox('stsz', 0, 0, U32(0), U32(count), ...this.samples.map((sample) => U32(sample.size))),
      FullBox('co64', 0, 0, U32(count), ...this.samples.map((sample) => U64(sample.offset)))
    );
    const minf = Box('minf', vmhd, dinf, stbl);
    return Box('moov', mvhd, Box('trak', tkhd, Box('mdia', mdhd, hdlr, minf)));
  }

  private Stsd(track: Mp4TrackConfig): Uint8Array {
    const hevc = track.codec === 'hevc';
    const compressor = new Uint8Array(32);
    const visual = Concat(new Uint8Array(6), U16(1), U16(0), U16(0), new Uint8Array(12), U16(track.width), U16(track.height), U32(0x00480000), U32(0x00480000), U32(0), U16(1), compressor, U16(0x0018), U16(0xffff));
    const children = [Box(hevc ? 'hvcC' : 'avcC', track.description), ...ColrBox(track.colorSpace), Box('pasp', U32(1), U32(1))];
    return FullBox('stsd', 0, 0, U32(1), Box(hevc ? 'hvc1' : 'avc1', visual, ...children));
  }

  private Ctts(track: Mp4TrackConfig): Uint8Array[] {
    const offsets = this.samples.map((sample, index) => Math.round((sample.timestamp * track.fps) / 1000) - index * SAMPLE_DELTA);
    if (offsets.every((offset) => offset === 0)) return [];
    const runs: [number, number][] = [];
    for (const offset of offsets) {
      const last = runs.at(-1);
      if (last && last[1] === offset) last[0]++;
      else runs.push([1, offset]);
    }
    return [FullBox('ctts', 1, 0, U32(runs.length), ...runs.flatMap(([run, offset]) => [U32(run), I32(offset)]))];
  }

  private Stss(): Uint8Array {
    const keys = this.samples.flatMap((sample, index) => (sample.key ? [index + 1] : []));
    return FullBox('stss', 0, 0, U32(keys.length), ...keys.map((key) => U32(key)));
  }
}

/**
 * The `colr` nclx box for the encoder's colour space, when its primaries, transfer and matrix all map.
 *
 * @param colorSpace - The encoder's VideoColorSpace.
 * @returns The box, or nothing.
 */
function ColrBox(colorSpace: Mp4TrackConfig['colorSpace']): Uint8Array[] {
  const primaries = COLOR_PRIMARIES[colorSpace?.primaries ?? ''];
  const transfer = COLOR_TRANSFERS[colorSpace?.transfer ?? ''];
  const matrix = COLOR_MATRICES[colorSpace?.matrix ?? ''];
  if (primaries == null || transfer == null || matrix == null) return [];
  return [Box('colr', Ascii('nclx'), U16(primaries), U16(transfer), U16(matrix), new Uint8Array([colorSpace?.fullRange ? 0x80 : 0]))];
}

function Box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const body = Concat(...parts);
  return Concat(U32(8 + body.byteLength), Ascii(type), body);
}

function FullBox(type: string, version: number, flags: number, ...parts: Uint8Array[]): Uint8Array {
  return Box(type, U32(((version & 0xff) << 24) | (flags & 0xffffff)), ...parts);
}

function Matrix(): Uint8Array {
  return Concat(...UNITY_MATRIX.map((value) => U32(value)));
}

function Concat(...parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

function Ascii(text: string): Uint8Array {
  return Uint8Array.from(text, (character) => character.charCodeAt(0));
}

function U16(value: number): Uint8Array {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value);
  return bytes;
}

function U32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0);
  return bytes;
}

function I32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setInt32(0, value);
  return bytes;
}

function U64(value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value));
  return bytes;
}
