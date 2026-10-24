/**
 * Movie export encoding numbers (sd-export): the WebCodecs codec string for a size and fps (the lowest level that fits),
 * the default bitrate and the picture's rect inside the output frame. Runtime-free.
 */

import type { Maybe } from '@dereekb/util';
import type { MovieExportCodec } from './output';

/**
 * The bitrate bounds a command takes, bits a second.
 */
export const MIN_EXPORT_BITRATE = 100_000;
export const MAX_EXPORT_BITRATE = 200_000_000;

/**
 * The default bitrate's bits per pixel per frame (12.4 Mbps at 1080p30): the standard quality.
 */
export const EXPORT_BITS_PER_PIXEL = 0.2;

/**
 * The quality presets (export_movie, record_movie): each sets the bitrate when bitrate is not given. draft is small,
 * standard (the default) is EXPORT_BITS_PER_PIXEL, high and max go past the default's 100 Mbps clamp up to
 * MAX_EXPORT_BITRATE.
 */
export const MOVIE_QUALITIES = ['draft', 'standard', 'high', 'max'] as const;

export type MovieQuality = (typeof MOVIE_QUALITIES)[number];

export const DEFAULT_MOVIE_QUALITY: MovieQuality = 'standard';

/**
 * Each quality's bits a pixel a frame, and the most bits a second it asks for.
 */
export const MOVIE_QUALITY_BITRATES: Readonly<Record<MovieQuality, { readonly bitsPerPixel: number; readonly max: number }>> = {
  draft: { bitsPerPixel: 0.08, max: 100_000_000 },
  standard: { bitsPerPixel: EXPORT_BITS_PER_PIXEL, max: 100_000_000 },
  high: { bitsPerPixel: 0.35, max: MAX_EXPORT_BITRATE },
  max: { bitsPerPixel: 0.6, max: MAX_EXPORT_BITRATE }
};

/**
 * Above this many bits a second an HEVC output takes the High tier: the Main tier tops out at 25 Mbps at level 5.
 */
export const HEVC_HIGH_TIER_BITRATE = 25_000_000;

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
 * An HEVC level (Table A.8): luma samples a picture and a second, and the High tier's bits a second; the codec string
 * carries level × 30.
 */
export interface HevcLevel {
  readonly level: string;
  readonly idc: number;
  readonly maxLumaPictureSize: number;
  readonly maxLumaSampleRate: number;
  readonly maxHighTierBitrate: number;
}

/**
 * HEVC levels from 4 to 5.2. A smaller output takes 4.
 */
export const HEVC_LEVELS: readonly HevcLevel[] = [
  { level: '4', idc: 120, maxLumaPictureSize: 2_228_224, maxLumaSampleRate: 66_846_720, maxHighTierBitrate: 30_000_000 },
  { level: '4.1', idc: 123, maxLumaPictureSize: 2_228_224, maxLumaSampleRate: 133_693_440, maxHighTierBitrate: 50_000_000 },
  { level: '5', idc: 150, maxLumaPictureSize: 8_912_896, maxLumaSampleRate: 267_386_880, maxHighTierBitrate: 100_000_000 },
  { level: '5.1', idc: 153, maxLumaPictureSize: 8_912_896, maxLumaSampleRate: 534_773_760, maxHighTierBitrate: 160_000_000 },
  { level: '5.2', idc: 156, maxLumaPictureSize: 8_912_896, maxLumaSampleRate: 1_069_547_520, maxHighTierBitrate: 240_000_000 }
];

export interface ExportCodecInput {
  readonly codec: MovieExportCodec;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  /**
   * Bits a second: an HEVC output above HEVC_HIGH_TIER_BITRATE takes the High tier, at a level whose High tier carries
   * it. Left out: the Main tier.
   */
  readonly bitrate?: number;
}

export interface ExportCodecChoice {
  /**
   * The WebCodecs codec string: `avc1.6400LL` (High), `hvc1.1.6.L<idc>.B0` (Main, Main tier) or `hvc1.1.6.H<idc>.B0`
   * (Main, High tier).
   */
  readonly codecString: string;
  readonly level: string;
}

/**
 * The codec string for an output: the lowest level whose frame size and rate fit it (and, for HEVC above
 * HEVC_HIGH_TIER_BITRATE, whose High tier carries the bitrate).
 *
 * @param input - The codec, the output size, the fps and the bitrate.
 * @returns The codec string and its level, or null when the output is beyond the highest level (H.264 5.2, HEVC 5.2).
 */
export function exportCodecString(input: ExportCodecInput): Maybe<ExportCodecChoice> {
  const { codec, width, height, fps, bitrate = 0 } = input;
  let choice: Maybe<ExportCodecChoice>;
  if (codec === 'hevc') {
    const samples = width * height;
    const high = bitrate > HEVC_HIGH_TIER_BITRATE;
    const fits = (entry: HevcLevel): boolean => samples <= entry.maxLumaPictureSize && samples * fps <= entry.maxLumaSampleRate && Math.max(width, height) <= Math.sqrt(8 * entry.maxLumaPictureSize);
    const level = HEVC_LEVELS.find((entry) => fits(entry) && (!high || bitrate <= entry.maxHighTierBitrate)) ?? (high ? HEVC_LEVELS.findLast(fits) : null);
    choice = level ? { codecString: `hvc1.1.6.${high ? 'H' : 'L'}${level.idc}.B0`, level: level.level } : null;
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
 * The default bitrate: the quality's bits a pixel a frame (standard: EXPORT_BITS_PER_PIXEL), clamped to 0.5 Mbps and
 * the quality's most (100 Mbps for draft and standard, MAX_EXPORT_BITRATE for high and max).
 *
 * @param input - The output size, the fps and the quality.
 * @param input.width - Pixels.
 * @param input.height - Pixels.
 * @param input.fps - Frames a second.
 * @param input.quality - Default standard.
 * @returns Bits a second (12.4 Mbps at 1080p30 standard).
 */
export function defaultExportBitrate(input: { readonly width: number; readonly height: number; readonly fps: number; readonly quality?: MovieQuality }): number {
  const { width, height, fps, quality = DEFAULT_MOVIE_QUALITY } = input;
  const { bitsPerPixel, max } = MOVIE_QUALITY_BITRATES[quality];
  return Math.min(max, Math.max(MIN_DEFAULT_EXPORT_BITRATE, Math.round(width * height * fps * bitsPerPixel)));
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
