/**
 * Movie export encoding numbers (sd-export): the WebCodecs codec string for a size and fps (the lowest level that fits),
 * the default bitrate and the picture's rect inside the output frame. Runtime-free.
 */

import type { Maybe } from '@dereekb/util';
import type { MovieExportCodec } from './command';

/**
 * The default bitrate's bits per pixel per frame (12.4 Mbps at 1080p30).
 */
export const EXPORT_BITS_PER_PIXEL = 0.2;

/**
 * The default bitrate's bounds, bits a second.
 */
export const MIN_DEFAULT_EXPORT_BITRATE = 500_000;
export const MAX_DEFAULT_EXPORT_BITRATE = 100_000_000;

/**
 * An H.264 level: its avcC level byte and its limits (Table A-1): macroblocks a frame and a second.
 */
export interface H264Level {
  readonly level: string;
  readonly idc: number;
  readonly maxFrameMacroblocks: number;
  readonly maxMacroblocksPerSecond: number;
}

/**
 * H.264 levels from 3.1 to 5.2. A smaller output takes 3.1.
 */
export const H264_LEVELS: readonly H264Level[] = [
  { level: '3.1', idc: 0x1f, maxFrameMacroblocks: 3600, maxMacroblocksPerSecond: 108_000 },
  { level: '3.2', idc: 0x20, maxFrameMacroblocks: 5120, maxMacroblocksPerSecond: 216_000 },
  { level: '4.0', idc: 0x28, maxFrameMacroblocks: 8192, maxMacroblocksPerSecond: 245_760 },
  { level: '4.1', idc: 0x29, maxFrameMacroblocks: 8192, maxMacroblocksPerSecond: 245_760 },
  { level: '4.2', idc: 0x2a, maxFrameMacroblocks: 8704, maxMacroblocksPerSecond: 522_240 },
  { level: '5.0', idc: 0x32, maxFrameMacroblocks: 22_080, maxMacroblocksPerSecond: 589_824 },
  { level: '5.1', idc: 0x33, maxFrameMacroblocks: 36_864, maxMacroblocksPerSecond: 983_040 },
  { level: '5.2', idc: 0x34, maxFrameMacroblocks: 36_864, maxMacroblocksPerSecond: 2_073_600 }
];

/**
 * An HEVC Main tier level (Table A.8): luma samples a picture and a second; the codec string carries level × 30.
 */
export interface HevcLevel {
  readonly level: string;
  readonly idc: number;
  readonly maxLumaPictureSize: number;
  readonly maxLumaSampleRate: number;
}

/**
 * HEVC levels from 4 to 5.2. A smaller output takes 4.
 */
export const HEVC_LEVELS: readonly HevcLevel[] = [
  { level: '4', idc: 120, maxLumaPictureSize: 2_228_224, maxLumaSampleRate: 66_846_720 },
  { level: '4.1', idc: 123, maxLumaPictureSize: 2_228_224, maxLumaSampleRate: 133_693_440 },
  { level: '5', idc: 150, maxLumaPictureSize: 8_912_896, maxLumaSampleRate: 267_386_880 },
  { level: '5.1', idc: 153, maxLumaPictureSize: 8_912_896, maxLumaSampleRate: 534_773_760 },
  { level: '5.2', idc: 156, maxLumaPictureSize: 8_912_896, maxLumaSampleRate: 1_069_547_520 }
];

export interface ExportCodecInput {
  readonly codec: MovieExportCodec;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
}

export interface ExportCodecChoice {
  /**
   * The WebCodecs codec string: `avc1.6400LL` (High) or `hvc1.1.6.L<idc>.B0` (Main).
   */
  readonly codecString: string;
  readonly level: string;
}

/**
 * The codec string for an output: the lowest level whose frame size and rate fit it.
 *
 * @param input - The codec, the output size and the fps.
 * @returns The codec string and its level, or null when the output is beyond the highest level (H.264 5.2, HEVC 5.2).
 */
export function exportCodecString(input: ExportCodecInput): Maybe<ExportCodecChoice> {
  const { codec, width, height, fps } = input;
  let choice: Maybe<ExportCodecChoice>;
  if (codec === 'hevc') {
    const samples = width * height;
    const level = HEVC_LEVELS.find((entry) => samples <= entry.maxLumaPictureSize && samples * fps <= entry.maxLumaSampleRate && Math.max(width, height) <= Math.sqrt(8 * entry.maxLumaPictureSize));
    choice = level ? { codecString: `hvc1.1.6.L${level.idc}.B0`, level: level.level } : null;
  } else {
    const across = Math.ceil(width / 16);
    const down = Math.ceil(height / 16);
    const macroblocks = across * down;
    const level = H264_LEVELS.find((entry) => macroblocks <= entry.maxFrameMacroblocks && macroblocks * fps <= entry.maxMacroblocksPerSecond && Math.max(across, down) ** 2 <= 8 * entry.maxFrameMacroblocks);
    choice = level ? { codecString: `avc1.6400${level.idc.toString(16).toUpperCase().padStart(2, '0')}`, level: level.level } : null;
  }
  return choice;
}

/**
 * The highest level's name, for the message when an output is beyond it.
 *
 * @param codec - The codec.
 * @returns Such as "H.264 High level 5.2".
 */
export function exportCodecLimitText(codec: MovieExportCodec): string {
  return codec === 'hevc' ? `HEVC Main level ${HEVC_LEVELS.at(-1)?.level}` : `H.264 High level ${H264_LEVELS.at(-1)?.level}`;
}

/**
 * The default bitrate: EXPORT_BITS_PER_PIXEL bits a pixel a frame, clamped to 0.5 to 100 Mbps.
 *
 * @param input - The output size and the fps.
 * @param input.width - Pixels.
 * @param input.height - Pixels.
 * @param input.fps - Frames a second.
 * @returns Bits a second (12.4 Mbps at 1080p30).
 */
export function defaultExportBitrate(input: { readonly width: number; readonly height: number; readonly fps: number }): number {
  const { width, height, fps } = input;
  return Math.min(MAX_DEFAULT_EXPORT_BITRATE, Math.max(MIN_DEFAULT_EXPORT_BITRATE, Math.round(width * height * fps * EXPORT_BITS_PER_PIXEL)));
}

/**
 * A rect in output pixels.
 */
export interface ExportRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Where the picture sits in the output frame: the whole frame without a letterbox, else the letterbox's aspect centred,
 * with black bars above and below (a wider aspect) or at the sides (a narrower one). The picture's sides are even.
 *
 * @param width - The output width.
 * @param height - The output height.
 * @param aspect - The letterbox (width / height), or false / null for none.
 * @returns The picture rect (1920 × 1080 at 2.39: { x: 0, y: 138, width: 1920, height: 804 }).
 */
export function exportPictureRect(width: number, height: number, aspect: Maybe<number | false>): ExportRect {
  let rect: ExportRect = { x: 0, y: 0, width, height };
  if (typeof aspect === 'number' && aspect > 0) {
    if (aspect >= width / height) {
      const pictureHeight = Math.min(height, evenRound(width / aspect));
      rect = { x: 0, y: Math.floor((height - pictureHeight) / 2), width, height: pictureHeight };
    } else {
      const pictureWidth = Math.min(width, evenRound(height * aspect));
      rect = { x: Math.floor((width - pictureWidth) / 2), y: 0, width: pictureWidth, height };
    }
  }
  return rect;
}

function evenRound(value: number): number {
  return Math.max(2, 2 * Math.round(value / 2));
}
