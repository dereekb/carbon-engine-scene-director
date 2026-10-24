import { mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ReadMp4 } from './mp4-reader.testing';
import { Mp4Writer, type Mp4TrackConfig } from './mp4-writer';

const AVCC = new Uint8Array([1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 0x28, 1, 0, 2, 0x68, 0xce]);
const TRACK: Mp4TrackConfig = { codec: 'h264', codecString: 'avc1.640028', width: 1920, height: 1080, fps: 30, description: AVCC, colorSpace: { primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'bt709', fullRange: false } };

async function Paths(): Promise<{ readonly partPath: string; readonly path: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mp4-writer-'));
  return { partPath: path.join(directory, '.out.mp4.part'), path: path.join(directory, 'out.mp4') };
}

function Sample(index: number): Uint8Array {
  return new Uint8Array(40 + (index % 7) * 13).map((_, byte) => (index * 31 + byte) % 256);
}

describe('Mp4Writer', () => {
  it('writes ftyp, a 64-bit mdat and a moov that reads back sample for sample', async () => {
    const paths = await Paths();
    const writer = await Mp4Writer.Open({ ...paths, codec: 'h264' });
    writer.Configure(TRACK);
    for (let index = 0; index < 90; index++) await writer.AddSample({ data: Sample(index), key: index % 30 === 0, timestamp: Math.round((index * 1e6) / 30) });
    const result = await writer.Finish();
    await expect(stat(paths.partPath)).rejects.toThrow();
    const bytes = new Uint8Array(await readFile(paths.path));
    expect(result).toEqual({ bytes: bytes.byteLength, samples: 90, seconds: 3 });
    const mp4 = ReadMp4(bytes);
    expect(mp4.boxes.map((box) => box.type)).toEqual(['ftyp', 'mdat', 'moov']);
    expect(mp4.brands).toEqual(['isom', 'isom', 'iso2', 'avc1', 'mp41']);
    const moov = mp4.boxes[2];
    expect(mp4.mdat).toEqual({ offset: mp4.boxes[0].size, size: moov.offset - mp4.boxes[0].size, largeSize: true });
    expect(mp4.mvhd).toEqual({ timescale: 1000, duration: 3000, nextTrack: 2 });
    expect(mp4.tkhd).toEqual({ flags: 3, track: 1, width: 1920, height: 1080 });
    expect(mp4.mdhd).toEqual({ timescale: 30000, duration: 90000 });
    expect(mp4.handler).toBe('vide');
    expect(mp4.stts).toEqual([[90, 1000]]);
    expect(mp4.ctts).toBeUndefined();
    expect(mp4.stss).toEqual([1, 31, 61]);
    expect(mp4.sizes).toEqual(Array.from({ length: 90 }, (_, index) => Sample(index).byteLength));
    for (let index = 0; index < 90; index++) expect([...mp4.samples[index]]).toEqual([...Sample(index)]);
    expect(mp4.offsets[0]).toBe(mp4.mdat.offset + 16);
    expect(mp4.entry.type).toBe('avc1');
    expect(mp4.entry).toMatchObject({ width: 1920, height: 1080, colr: { primaries: 1, transfer: 13, matrix: 1, fullRange: 0 }, pasp: [1, 1] });
    expect([...mp4.entry.config]).toEqual([...AVCC]);
    expect(mp4.seconds).toBe(3);
  });

  it('writes hvc1 + hvcC for HEVC and leaves out colr it cannot map', async () => {
    const paths = await Paths();
    const writer = await Mp4Writer.Open({ ...paths, codec: 'hevc' });
    const hvcc = new Uint8Array(112).fill(7);
    writer.Configure({ ...TRACK, codec: 'hevc', codecString: 'hvc1.1.6.L120.B0', description: hvcc, colorSpace: { primaries: 'bt709', transfer: 'unknown', matrix: 'bt709' } });
    await writer.AddSample({ data: Sample(0), key: true, timestamp: 0 });
    await writer.Finish();
    const mp4 = ReadMp4(new Uint8Array(await readFile(paths.path)));
    expect(mp4.brands).toContain('hvc1');
    expect(mp4.entry.type).toBe('hvc1');
    expect(mp4.entry.colr).toBeUndefined();
    expect([...mp4.entry.config]).toEqual([...hvcc]);
  });

  it('writes ctts version 1 for timestamps out of decode order', async () => {
    const paths = await Paths();
    const writer = await Mp4Writer.Open(paths);
    writer.Configure(TRACK);
    const frames = [0, 2, 1, 3];
    for (const [index, frame] of frames.entries()) await writer.AddSample({ data: Sample(index), key: index === 0, timestamp: Math.round((frame * 1e6) / 30) });
    await writer.Finish();
    const mp4 = ReadMp4(new Uint8Array(await readFile(paths.path)));
    expect(mp4.ctts).toEqual({
      version: 1,
      entries: [
        [1, 0],
        [1, 1000],
        [1, -1000],
        [1, 0]
      ]
    });
  });

  it('deletes the part on Abort, and refuses a sample before Configure', async () => {
    const paths = await Paths();
    const writer = await Mp4Writer.Open(paths);
    await expect(writer.AddSample({ data: Sample(0), key: true, timestamp: 0 })).rejects.toThrow('before the track was configured');
    await writer.Abort();
    await expect(stat(paths.partPath)).rejects.toThrow();
    await expect(stat(paths.path)).rejects.toThrow();
  });
});
