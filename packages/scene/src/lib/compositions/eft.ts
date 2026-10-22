import type { Maybe } from '@dereekb/util';

/**
 * The hull and fit name an EFT fit's header line gives.
 */
export interface EftHeader {
  readonly hull: string;
  readonly name: string;
}

/**
 * tools-core's EFT header rule: `[Hull, Fit name]`. Fit names may contain brackets and commas.
 */
const EFT_HEADER_PATTERN = /^\[([^,\]]+),\s*(.*)\]$/u;

/**
 * Reads the header of an EFT fit: its first non-empty line, `[Hull, Fit name]`.
 *
 * @param text - The EFT text.
 * @returns The hull and fit name, or null when the text does not start with an EFT header.
 */
export function readEftHeader(text: string): Maybe<EftHeader> {
  const line = text.split(/\r?\n/u).find((candidate) => candidate.trim()) ?? '';
  const match = EFT_HEADER_PATTERN.exec(line.trim());
  return match ? { hull: match[1].trim(), name: match[2].trim() } : null;
}
