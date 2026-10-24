/**
 * The page → hub wire of a movie export (sd-export). Encoded chunks travel as binary WebSocket packets: "SDX1"
 * (4 bytes), a u32 little-endian header length, a UTF-8 JSON header ({ id, seq, key, timestamp, duration }) and the
 * chunk's bytes. Everything else is a JSON `{ type: "export", id, kind, ... }` message: the page's config, progress,
 * end, failed and cancelled, and the hub's saved and failed. WebSocket keeps text and binary messages in order, so the
 * config always precedes the first chunk. Pure: TextEncoder, TextDecoder and DataView work in node and the browser.
 */

import type { Maybe } from '@dereekb/util';
import { isPlainObject } from '../json';
import type { MovieExportCodec } from './command';
import type { MovieExportFile, MovieExportReport } from './report';

export const EXPORT_PACKET_MAGIC = 'SDX1';

/**
 * The page sends a progress message this often, ms.
 */
export const EXPORT_PROGRESS_MS = 1000;

/**
 * One encoded chunk's header.
 */
export interface ExportChunkHeader {
  readonly id: string;
  /**
   * Counts up from 0 per export; a gap is a lost chunk.
   */
  readonly seq: number;
  readonly key: boolean;
  /**
   * Microseconds from the file's start.
   */
  readonly timestamp: number;
  readonly duration: number;
}

export interface ExportPacket {
  readonly header: ExportChunkHeader;
  readonly payload: Uint8Array;
}

/**
 * The track the hub writes: the encoder's own decoder config.
 */
export interface MovieExportTrack {
  readonly codec: MovieExportCodec;
  /**
   * The encoder's decoderConfig.codec (it may differ from the string asked for).
   */
  readonly codecString: string;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  /**
   * The avcC or hvcC, base64.
   */
  readonly description: string;
  readonly colorSpace?: { readonly primaries?: Maybe<string>; readonly transfer?: Maybe<string>; readonly matrix?: Maybe<string>; readonly fullRange?: Maybe<boolean> };
}

export type MovieExportPageMessage =
  | { readonly type: 'export'; readonly id: string; readonly kind: 'config'; readonly track: MovieExportTrack }
  | { readonly type: 'export'; readonly id: string; readonly kind: 'progress'; readonly report: MovieExportReport }
  | { readonly type: 'export'; readonly id: string; readonly kind: 'end'; readonly report: MovieExportReport }
  | { readonly type: 'export'; readonly id: string; readonly kind: 'failed'; readonly error: string; readonly report: MovieExportReport }
  | { readonly type: 'export'; readonly id: string; readonly kind: 'cancelled'; readonly report: MovieExportReport };

export type MovieExportHubMessage = { readonly type: 'export'; readonly id: string; readonly kind: 'saved'; readonly file: MovieExportFile & { readonly bytes: number } } | { readonly type: 'export'; readonly id: string; readonly kind: 'failed'; readonly error: string };

export const MOVIE_EXPORT_PAGE_KINDS = ['config', 'progress', 'end', 'failed', 'cancelled'] as const;

/**
 * Builds a chunk packet.
 *
 * @param header - The chunk's header.
 * @param payload - The chunk's bytes.
 * @returns The packet.
 */
export function encodeExportPacket(header: ExportChunkHeader, payload: Uint8Array): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const bytes = new Uint8Array(8 + json.byteLength + payload.byteLength);
  bytes.set(new TextEncoder().encode(EXPORT_PACKET_MAGIC), 0);
  new DataView(bytes.buffer).setUint32(4, json.byteLength, true);
  bytes.set(json, 8);
  bytes.set(payload, 8 + json.byteLength);
  return bytes;
}

/**
 * Reads a chunk packet.
 *
 * @param bytes - The binary message.
 * @returns The header and the payload (a view into bytes), or null for a bad magic, length or header.
 */
export function decodeExportPacket(bytes: Uint8Array): Maybe<ExportPacket> {
  let packet: Maybe<ExportPacket> = null;
  if (bytes.byteLength >= 8 && new TextDecoder().decode(bytes.subarray(0, 4)) === EXPORT_PACKET_MAGIC) {
    const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
    if (8 + length <= bytes.byteLength) {
      const header = parseJson(new TextDecoder().decode(bytes.subarray(8, 8 + length)));
      if (isChunkHeader(header)) packet = { header, payload: bytes.subarray(8 + length) };
    }
  }
  return packet;
}

/**
 * Whether a parsed text message is an export message (either way).
 *
 * @param value - The parsed message.
 * @returns True for `{ type: "export", id, kind }`.
 */
export function isMovieExportMessage(value: unknown): value is { readonly type: 'export'; readonly id: string; readonly kind: string } {
  return isPlainObject(value) && value['type'] === 'export' && typeof value['id'] === 'string' && typeof value['kind'] === 'string';
}

/**
 * Bytes to base64 (the track's description).
 *
 * @param bytes - The bytes.
 * @returns Base64 text.
 */
export function exportBytesToBase64(bytes: Uint8Array): string {
  let text = '';
  for (let index = 0; index < bytes.byteLength; index += 0x8000) text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(text);
}

/**
 * Base64 to bytes.
 *
 * @param text - Base64 text.
 * @returns The bytes.
 */
export function exportBase64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isChunkHeader(value: unknown): value is ExportChunkHeader {
  return isPlainObject(value) && typeof value['id'] === 'string' && Number.isInteger(value['seq']) && typeof value['key'] === 'boolean' && Number.isFinite(value['timestamp']) && Number.isFinite(value['duration']);
}
