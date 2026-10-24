import { describe, expect, it } from 'vitest';
import { catchSceneError } from '../fleets/fleets.spec-helper';
import { defaultExportBitrate, exportCodecString, exportPictureRect } from './codec';
import { DEFAULT_EXPORT_PREROLL_SECONDS, MAX_EXPORT_SECONDS, normalizeMovieExportCommand } from './command';
import { decodeExportPacket, encodeExportPacket, exportBase64ToBytes, exportBytesToBase64, isMovieExportMessage } from './wire';

describe('normalizeMovieExportCommand', () => {
  it('reads nothing as a status, and fills the start defaults', () => {
    expect(normalizeMovieExportCommand(undefined)).toEqual({ action: 'status' });
    expect(normalizeMovieExportCommand({ action: 'cancel' })).toEqual({ action: 'cancel' });
    expect(normalizeMovieExportCommand({ action: 'start' })).toEqual({ action: 'start', fps: 30, width: 1920, height: 1080, codec: 'h264', preroll: DEFAULT_EXPORT_PREROLL_SECONDS, source: 'scene' });
    expect(normalizeMovieExportCommand({ action: 'start', from: 30, to: 45, fps: 60, letterbox: false, codec: 'hevc', bitrate: 8_000_000, restart: false, preroll: 0, name: 'Duel.mp4', source: 'slate' })).toEqual({
      action: 'start',
      from: 30,
      to: 45,
      fps: 60,
      width: 1920,
      height: 1080,
      letterbox: false,
      codec: 'hevc',
      bitrate: 8_000_000,
      restart: false,
      preroll: 0,
      name: 'Duel',
      source: 'slate'
    });
  });

  it('passes the page its export id', () => {
    expect(normalizeMovieExportCommand({ action: 'start', id: 'export-1' })).toMatchObject({ action: 'start' });
  });

  it('reports every problem at once', () => {
    const error = catchSceneError(() => normalizeMovieExportCommand({ action: 'start', from: 5, to: 3, width: 321, height: 10, fps: 2.5, codec: 'av1', bitrate: 5, preroll: 11, letterbox: 9, name: '../x', source: 'tv', what: 1 }));
    const text = error.problems.join('\n');
    for (const fragment of [
      'what is not an export_movie field',
      'to (3 s) must be after from (5 s)',
      'width must be pixels',
      '321 is odd',
      'height must be pixels',
      'fps must be frames a second',
      '"av1" is not yet: h264 or hevc',
      'bitrate must be',
      'preroll must be',
      'letterbox must be',
      'name must be',
      'source must be'
    ]) {
      expect(text).toContain(fragment);
    }
  });

  it('refuses start fields on status and cancel, to with duration, and an export over the limit', () => {
    expect(catchSceneError(() => normalizeMovieExportCommand({ action: 'cancel', fps: 30 })).problems).toEqual(['export_movie.fps goes with action "start" ("cancel" takes no other field)']);
    expect(catchSceneError(() => normalizeMovieExportCommand({ action: 'start', to: 10, duration: 5 })).problems).toEqual(['export_movie: give to or duration, not both']);
    expect(catchSceneError(() => normalizeMovieExportCommand({ action: 'start', duration: MAX_EXPORT_SECONDS + 1 })).problems[0]).toContain('longer than');
    expect(catchSceneError(() => normalizeMovieExportCommand({ action: 'start', width: 4096, height: 2304, fps: 60 })).problems[0]).toContain('beyond H.264 High level 5.2');
    expect(() => normalizeMovieExportCommand({ action: 'go' })).toThrow('action must be one of status, start, cancel');
  });
});

describe('exportCodecString', () => {
  it('picks the lowest H.264 High level that fits the frame and its rate', () => {
    expect(exportCodecString({ codec: 'h264', width: 1920, height: 1080, fps: 30 })).toEqual({ codecString: 'avc1.640028', level: '4.0' });
    expect(exportCodecString({ codec: 'h264', width: 1920, height: 1080, fps: 60 })?.codecString).toBe('avc1.64002A');
    expect(exportCodecString({ codec: 'h264', width: 3840, height: 2160, fps: 30 })?.codecString).toBe('avc1.640033');
    expect(exportCodecString({ codec: 'h264', width: 3840, height: 2160, fps: 60 })?.codecString).toBe('avc1.640034');
    expect(exportCodecString({ codec: 'h264', width: 4096, height: 2304, fps: 30 })?.codecString).toBe('avc1.640034');
    expect(exportCodecString({ codec: 'h264', width: 320, height: 180, fps: 10 })?.codecString).toBe('avc1.64001F');
    expect(exportCodecString({ codec: 'h264', width: 4096, height: 2304, fps: 60 })).toBeNull();
  });

  it('picks the HEVC Main levels by luma picture size and rate', () => {
    expect(exportCodecString({ codec: 'hevc', width: 1920, height: 1080, fps: 30 })?.codecString).toBe('hvc1.1.6.L120.B0');
    expect(exportCodecString({ codec: 'hevc', width: 1920, height: 1080, fps: 60 })?.codecString).toBe('hvc1.1.6.L123.B0');
    expect(exportCodecString({ codec: 'hevc', width: 3840, height: 2160, fps: 30 })?.codecString).toBe('hvc1.1.6.L150.B0');
    expect(exportCodecString({ codec: 'hevc', width: 3840, height: 2160, fps: 60 })?.codecString).toBe('hvc1.1.6.L153.B0');
    expect(exportCodecString({ codec: 'hevc', width: 3840, height: 2160, fps: 120 })?.codecString).toBe('hvc1.1.6.L156.B0');
    expect(exportCodecString({ codec: 'hevc', width: 4096, height: 2304, fps: 30 })).toBeNull();
  });
});

describe('defaultExportBitrate', () => {
  it('is 0.2 bits a pixel a frame, clamped to 0.5 to 100 Mbps', () => {
    expect(defaultExportBitrate({ width: 1920, height: 1080, fps: 30 })).toBe(12_441_600);
    expect(defaultExportBitrate({ width: 1920, height: 1080, fps: 60 })).toBe(24_883_200);
    expect(defaultExportBitrate({ width: 3840, height: 2160, fps: 30 })).toBe(49_766_400);
    expect(defaultExportBitrate({ width: 320, height: 180, fps: 10 })).toBe(500_000);
    expect(defaultExportBitrate({ width: 4096, height: 2304, fps: 120 })).toBe(100_000_000);
  });
});

describe('exportPictureRect', () => {
  it('letterboxes a wider aspect, pillarboxes a narrower one, and fills without one', () => {
    expect(exportPictureRect(1920, 1080, 2.39)).toEqual({ x: 0, y: 138, width: 1920, height: 804 });
    expect(exportPictureRect(320, 180, 2.39)).toEqual({ x: 0, y: 23, width: 320, height: 134 });
    expect(exportPictureRect(1920, 1080, false)).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    expect(exportPictureRect(1920, 1080, null)).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    expect(exportPictureRect(1080, 1920, 2.39)).toEqual({ x: 0, y: 734, width: 1080, height: 452 });
    expect(exportPictureRect(1920, 1080, 4 / 3)).toEqual({ x: 240, y: 0, width: 1440, height: 1080 });
    expect(exportPictureRect(1920, 804, 2.39)).toEqual({ x: 0, y: 0, width: 1920, height: 804 });
  });
});

describe('the export wire', () => {
  it('round-trips a chunk packet', () => {
    const payload = new Uint8Array([0, 0, 0, 1, 0x65, 9, 8, 7]);
    const header = { id: 'export-1', seq: 4, key: true, timestamp: 133_333, duration: 33_334 };
    const packet = encodeExportPacket(header, payload);
    expect(new TextDecoder().decode(packet.subarray(0, 4))).toBe('SDX1');
    const decoded = decodeExportPacket(packet);
    expect(decoded?.header).toEqual(header);
    expect([...(decoded?.payload ?? [])]).toEqual([...payload]);
    const offset = new Uint8Array(packet.byteLength + 3);
    offset.set(packet, 3);
    expect(decodeExportPacket(offset.subarray(3))?.header).toEqual(header);
  });

  it('refuses a bad magic, length or header', () => {
    const packet = encodeExportPacket({ id: 'e', seq: 0, key: false, timestamp: 0, duration: 1 }, new Uint8Array([1]));
    const badMagic = packet.slice();
    badMagic[0] = 0x41;
    expect(decodeExportPacket(badMagic)).toBeNull();
    const badLength = packet.slice();
    new DataView(badLength.buffer).setUint32(4, 9999, true);
    expect(decodeExportPacket(badLength)).toBeNull();
    const badJson = packet.slice();
    badJson[8] = 0x7a;
    expect(decodeExportPacket(badJson)).toBeNull();
    expect(decodeExportPacket(new Uint8Array(3))).toBeNull();
  });

  it('carries the description as base64 and tells export messages apart', () => {
    const bytes = new Uint8Array(70_000).map((_, index) => index % 251);
    expect([...exportBase64ToBytes(exportBytesToBase64(bytes))]).toEqual([...bytes]);
    expect(isMovieExportMessage({ type: 'export', id: 'e', kind: 'end' })).toBe(true);
    expect(isMovieExportMessage({ type: 'result', id: 'e' })).toBe(false);
  });
});
