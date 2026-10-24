import { describe, expect, it } from 'vitest';
import { SceneError } from '../scene';
import { defaultExportBitrate, exportCodecString, MAX_EXPORT_BITRATE } from './codec';
import { MAX_EXPORT_SECONDS, normalizeMovieExportCommand } from './command';
import { movieOutputPlan } from './output';
import { normalizeMovieRecordCommand } from './record';

function Problems(run: () => unknown): string[] {
  try {
    run();
  } catch (error) {
    if (error instanceof SceneError) return error.problems;
    throw error;
  }
  return [];
}

describe('normalizeMovieRecordCommand', () => {
  it('reads the actions and a start with the output defaults', () => {
    expect(normalizeMovieRecordCommand(undefined)).toEqual({ action: 'status' });
    expect(normalizeMovieRecordCommand({ action: 'stop', id: 'record-1' })).toEqual({ action: 'stop' });
    expect(normalizeMovieRecordCommand({ action: 'cancel' })).toEqual({ action: 'cancel' });
    expect(normalizeMovieRecordCommand({ action: 'start' })).toEqual({ action: 'start', fps: 30, width: 1920, height: 1080, codec: 'h264', source: 'scene' });
    expect(normalizeMovieRecordCommand({ action: 'start', duration: 12.5, fps: 60, width: 3840, height: 2160, codec: 'hevc', quality: 'max', letterbox: 2.39, name: 'Brawl', source: 'slate' })).toEqual({
      action: 'start',
      duration: 12.5,
      fps: 60,
      width: 3840,
      height: 2160,
      codec: 'hevc',
      quality: 'max',
      letterbox: 2.39,
      name: 'Brawl',
      source: 'slate'
    });
  });

  it('reports every problem at once', () => {
    expect(Problems(() => normalizeMovieRecordCommand({ action: 'stop', fps: 30, from: 2 }))).toEqual(['record_movie.fps goes with action "start" ("stop" takes no other field)', 'record_movie.from is not a record_movie field (action, duration, fps, width, height, letterbox, codec, bitrate, quality, name, source)']);
    expect(Problems(() => normalizeMovieRecordCommand({ action: 'start', duration: MAX_EXPORT_SECONDS + 1, width: 321, quality: 'ultra', codec: 'av1' }))).toEqual([
      `record_movie.duration must be seconds of video, more than 0 and at most ${MAX_EXPORT_SECONDS}`,
      'record_movie.width must be pixels, an even integer from 64 to 4096 (321 is odd: 4:2:0 video needs even sizes)',
      'record_movie.codec "av1" is not yet: h264 or hevc',
      'record_movie.quality must be one of draft, standard, high, max (default standard)'
    ]);
    expect(Problems(() => normalizeMovieRecordCommand({ action: 'pause' }))).toEqual(['record_movie.action must be one of status, start, stop, cancel']);
  });

  it('takes quality on export_movie too', () => {
    expect(normalizeMovieExportCommand({ action: 'start', quality: 'high' })).toMatchObject({ quality: 'high' });
  });
});

describe('the quality preset', () => {
  it('sets the bitrate: standard is 0.2 bits a pixel a frame, high and max pass the 100 Mbps clamp', () => {
    const hd = { width: 1920, height: 1080, fps: 30 };
    const uhd = { width: 3840, height: 2160, fps: 30 };
    expect(defaultExportBitrate(hd)).toBe(12_441_600);
    expect(defaultExportBitrate({ ...hd, quality: 'standard' })).toBe(12_441_600);
    expect(defaultExportBitrate({ ...hd, quality: 'draft' })).toBe(4_976_640);
    expect(defaultExportBitrate({ ...uhd, quality: 'high' })).toBe(87_091_200);
    expect(defaultExportBitrate({ ...uhd, quality: 'max' })).toBe(149_299_200);
    expect(defaultExportBitrate({ ...uhd, fps: 60, quality: 'standard' })).toBe(99_532_800);
    expect(defaultExportBitrate({ ...uhd, fps: 120, quality: 'standard' })).toBe(100_000_000);
    expect(defaultExportBitrate({ ...uhd, fps: 60, quality: 'max' })).toBe(MAX_EXPORT_BITRATE);
  });

  it('takes the HEVC High tier above 25 Mbps, at a level whose High tier carries the bitrate', () => {
    expect(exportCodecString({ codec: 'hevc', width: 1920, height: 1080, fps: 30, bitrate: 12_441_600 })?.codecString).toBe('hvc1.1.6.L120.B0');
    expect(exportCodecString({ codec: 'hevc', width: 3840, height: 2160, fps: 30, bitrate: 25_000_000 })?.codecString).toBe('hvc1.1.6.L150.B0');
    expect(exportCodecString({ codec: 'hevc', width: 3840, height: 2160, fps: 30, bitrate: 49_766_400 })?.codecString).toBe('hvc1.1.6.H150.B0');
    expect(exportCodecString({ codec: 'hevc', width: 3840, height: 2160, fps: 30, bitrate: 149_299_200 })?.codecString).toBe('hvc1.1.6.H153.B0');
    expect(exportCodecString({ codec: 'hevc', width: 1920, height: 1080, fps: 60, bitrate: 74_649_600 })?.codecString).toBe('hvc1.1.6.H150.B0');
    expect(exportCodecString({ codec: 'hevc', width: 3840, height: 2160, fps: 60, bitrate: MAX_EXPORT_BITRATE })?.codecString).toBe('hvc1.1.6.H156.B0');
    expect(exportCodecString({ codec: 'h264', width: 3840, height: 2160, fps: 30, bitrate: 149_299_200 })?.codecString).toBe('avc1.640033');
  });

  it("plans the output: the quality's bitrate, the codec string for it, the picture and the keyframes", () => {
    const plan = movieOutputPlan({ fps: 30, width: 3840, height: 2160, codec: 'hevc', quality: 'max', source: 'scene' }, 2.39);
    expect(plan).toEqual({ source: 'scene', fps: 30, width: 3840, height: 2160, picture: { x: 0, y: 277, width: 3840, height: 1606 }, letterbox: 2.39, codec: 'hevc', codecString: 'hvc1.1.6.H153.B0', bitrate: 149_299_200, quality: 'max', hardware: 'prefer-hardware', keyframeEvery: 60 });
    expect(movieOutputPlan({ fps: 24, width: 1920, height: 1080, codec: 'h264', bitrate: 8_000_000, source: 'slate' }, false)).toMatchObject({ bitrate: 8_000_000, quality: 'standard', codecString: 'avc1.640028', keyframeEvery: 48 });
  });
});
