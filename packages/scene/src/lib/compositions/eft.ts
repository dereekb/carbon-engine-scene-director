import type { Maybe } from '@dereekb/util';
import { propModKindOfName } from '../stats/prop-mods';

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

const EFT_QUANTITY_PATTERN = /\sx\d+$/u;

const EFT_EMPTY_SLOT_PATTERN = /^\[empty [^\]]*\]$/iu;

/**
 * The prop mod an EFT fit fits: its first fitted line naming a microwarpdrive or an afterburner. The header, blank
 * lines, `[Empty … slot]` lines and quantity lines ending in ` x<N>` (drones and cargo) are skipped; `/OFFLINE` and a
 * charge after a comma are dropped.
 *
 * @param text - The EFT text.
 * @returns The module name as written, or null when the fit fits no prop mod.
 */
export function readEftPropMod(text: string): Maybe<string> {
  const lines = text.split(/\r?\n/u).map((line) => line.trim());
  const header = lines.findIndex((line) => line);
  let propMod: Maybe<string> = null;
  for (const line of lines.slice(header + 1)) {
    if (!line || EFT_EMPTY_SLOT_PATTERN.test(line) || EFT_QUANTITY_PATTERN.test(line)) continue;
    const module = line
      .split(',')[0]
      .replace(/\/offline$/iu, '')
      .trim();
    if (module && propModKindOfName(module)) {
      propMod = module;
      break;
    }
  }
  return propMod;
}
