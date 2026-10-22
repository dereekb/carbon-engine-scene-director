/**
 * The EFT fit format (the game's and Pyfa's "copy to clipboard"), read without the EVE data: a `[Hull, Fit name]`
 * header, module sections (low, mid, high, rig, subsystem, service) split by blank lines, then quantity sections
 * (`Name xN`: the drone bay, then cargo). Slots here are provisional, from the section order; the typed fit
 * (typed-fit.ts) takes each module's real slot from its EVE type.
 */

import type { Maybe } from '@dereekb/util';
import { propModKindOfName } from '../stats/prop-mods';

/**
 * The longest EFT fit text a scene or composition keeps.
 */
export const MAX_FIT_LENGTH = 20_000;

/**
 * The longest line an EFT fit may have.
 */
export const MAX_EFT_LINE_LENGTH = 300;

/**
 * A fitting slot, in EFT's section order.
 */
export type EftSlot = 'low' | 'mid' | 'high' | 'rig' | 'subsystem' | 'service';

/**
 * EFT's module section order.
 */
export const EFT_SLOTS: readonly EftSlot[] = ['low', 'mid', 'high', 'rig', 'subsystem', 'service'];

/**
 * EVE's most slots of each kind on any hull; more is a warning (service slots are structures', not checked).
 */
export const EFT_SLOT_LIMITS: Readonly<Record<EftSlot, Maybe<number>>> = { low: 8, mid: 8, high: 8, rig: 3, subsystem: 4, service: null };

/**
 * The hull and fit name an EFT fit's header line gives.
 */
export interface EftHeader {
  readonly hull: string;
  readonly name: string;
}

/**
 * A named line of the text.
 */
export interface EftLine {
  /**
   * The type name as written.
   */
  readonly name: string;
  /**
   * The line number in the text, from 1.
   */
  readonly line: number;
}

/**
 * A `Name xN` line: a drone, or a cargo item.
 */
export interface EftItemLine extends EftLine {
  readonly quantity: number;
}

/**
 * A module line: `Module`, `Module, Charge`, either with `/OFFLINE`.
 */
export interface EftModuleLine extends EftLine {
  /**
   * The loaded charge's name, after the comma.
   */
  readonly charge?: string;
  /**
   * Written with `/OFFLINE`.
   */
  readonly offline?: true;
  /**
   * The module section it sits in, from 0.
   */
  readonly section: number;
  /**
   * The slot its section stands for (provisional: the type's slot effect decides).
   */
  readonly slot: EftSlot;
}

export interface EftFit {
  readonly hull: string;
  readonly name: string;
  /**
   * Every module line in written order, offline ones included.
   */
  readonly modules: EftModuleLine[];
  /**
   * The first quantity section after the modules: the drone bay as written (the typed fit corrects it by category).
   */
  readonly drones: EftItemLine[];
  /**
   * The later quantity sections, plus any `xN` line written among the modules.
   */
  readonly cargo: EftItemLine[];
  /**
   * Lines with no quantity after the modules: implants and boosters (reported, not applied).
   */
  readonly implants: EftLine[];
  /**
   * The `[Empty <X> slot]` placeholders by slot.
   */
  readonly empty: Record<EftSlot, number>;
  readonly problems: string[];
  readonly warnings: string[];
}

/**
 * tools-core's EFT header rule: `[Hull, Fit name]`. Fit names may contain brackets and commas.
 */
export const EFT_HEADER_PATTERN = /^\[([^,\]]+),\s*(.*)\]$/u;

const EFT_QUANTITY_PATTERN = /^(.*\S)\s+x(\d+)$/u;

const EFT_EMPTY_SLOT_PATTERN = /^\[empty ([a-z]+) slot\]$/iu;

const EFT_OFFLINE_PATTERN = /\s*\/offline$/iu;

const EMPTY_SLOT_NAMES: Readonly<Record<string, EftSlot>> = { low: 'low', med: 'mid', mid: 'mid', medium: 'mid', high: 'high', rig: 'rig', subsystem: 'subsystem', service: 'service' };

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

/**
 * Where the parse is: the module sections, or the quantity sections after them.
 */
interface EftCursor {
  modulesEnd: number;
  section: number;
  slotIndex: number;
  sectionLines: number;
  sectionStart: number;
  quantitySections: number;
  quantitySectionOpen: boolean;
  blank: number;
}

/**
 * Parses an EFT fit into its lines by section, with no EVE data.
 *
 * - The header is the first non-empty line; CRLF line ends and leading blank lines are fine.
 * - `/OFFLINE` (any case) is stripped first, then a charge after the first comma.
 * - `[Empty <X> slot]` lines count as empty slots and fix their section's slot.
 * - Module sections run low, mid, high, rig, subsystem, service, split by blank lines. They end at the first double
 *   blank line, or, when the text has none, at the first `xN` line.
 * - After them the first quantity section is the drone bay and the later ones cargo; lines with no quantity are
 *   implants. An `xN` line among the modules counts as cargo, with a warning.
 *
 * @param text - The EFT text.
 * @returns The parsed fit; problems when it has no header, is too long or has a line too long.
 */
export function parseEftFit(text: string): EftFit {
  const fit: EftFit = { hull: '', name: '', modules: [], drones: [], cargo: [], implants: [], empty: { low: 0, mid: 0, high: 0, rig: 0, subsystem: 0, service: 0 }, problems: [], warnings: [] };
  const lines = text.split(/\r?\n/u).map((line) => line.trim());
  const headerIndex = lines.findIndex((line) => line);
  const header = headerIndex < 0 ? null : EFT_HEADER_PATTERN.exec(lines[headerIndex]);
  if (text.length > MAX_FIT_LENGTH) fit.problems.push(`the fit is longer than ${MAX_FIT_LENGTH} characters`);
  if (!header) {
    fit.problems.push('the fit must start with a [Hull, Fit name] header');
    return fit;
  }
  Object.assign(fit, { hull: header[1].trim(), name: header[2].trim() });

  const body = lines.slice(headerIndex + 1);
  const cursor: EftCursor = { modulesEnd: findModulesEnd(body), section: 0, slotIndex: 0, sectionLines: 0, sectionStart: 0, quantitySections: 0, quantitySectionOpen: false, blank: 0 };
  for (const [index, line] of body.entries()) {
    const number = headerIndex + index + 2;
    if (!line) {
      cursor.blank += 1;
      continue;
    }
    if (line.length > MAX_EFT_LINE_LENGTH) {
      fit.problems.push(`line ${number} is longer than ${MAX_EFT_LINE_LENGTH} characters`);
      cursor.blank = 0;
      continue;
    }
    if (index < cursor.modulesEnd) readModuleSectionLine({ fit, cursor, line, number });
    else readQuantitySectionLine({ fit, cursor, line, number });
    cursor.blank = 0;
  }
  warnSlotCounts(fit);
  return fit;
}

/**
 * The body index where the module sections end: the first double blank line, else the first `xN` line.
 *
 * @param body - The trimmed lines after the header.
 * @returns The index of the first line past the modules (body.length when they run to the end).
 */
function findModulesEnd(body: readonly string[]): number {
  let seen = false;
  let end = -1;
  for (const [index, line] of body.entries()) {
    if (line) seen = true;
    else if (seen && index > 0 && !body[index - 1] && body[index - 2]) {
      end = index;
      break;
    }
  }
  if (end < 0) end = body.findIndex((line) => EFT_QUANTITY_PATTERN.test(line) && !EFT_EMPTY_SLOT_PATTERN.test(line));
  return end < 0 ? body.length : end;
}

interface EftLineInput {
  readonly fit: EftFit;
  readonly cursor: EftCursor;
  readonly line: string;
  readonly number: number;
}

function readModuleSectionLine(input: EftLineInput): void {
  const { fit, cursor, line, number } = input;
  if (cursor.blank > 0 && cursor.sectionLines > 0) {
    cursor.section += 1;
    cursor.slotIndex = Math.min(cursor.slotIndex + 1, EFT_SLOTS.length - 1);
    cursor.sectionLines = 0;
    cursor.sectionStart = fit.modules.length;
  }
  cursor.sectionLines += 1;
  const empty = EFT_EMPTY_SLOT_PATTERN.exec(line);
  const quantity = EFT_QUANTITY_PATTERN.exec(line);
  if (empty) {
    const slot = EMPTY_SLOT_NAMES[empty[1].toLowerCase()];
    if (slot) {
      fit.empty[slot] += 1;
      cursor.slotIndex = EFT_SLOTS.indexOf(slot);
      for (let at = cursor.sectionStart; at < fit.modules.length; at += 1) fit.modules[at] = { ...fit.modules[at], slot };
    } else {
      fit.warnings.push(`line ${number}: "${line}" is not an empty slot EFT knows; skipped`);
    }
  } else if (quantity) {
    fit.cargo.push({ name: quantity[1].trim(), quantity: Number(quantity[2]), line: number });
    fit.warnings.push(`line ${number}: "${line}" has a quantity among the modules; counted as cargo`);
  } else {
    fit.modules.push(readModuleLine(line, { number, section: cursor.section, slot: EFT_SLOTS[cursor.slotIndex] }));
  }
}

function readModuleLine(line: string, place: { readonly number: number; readonly section: number; readonly slot: EftSlot }): EftModuleLine {
  const offline = EFT_OFFLINE_PATTERN.test(line);
  const written = line.replace(EFT_OFFLINE_PATTERN, '');
  const comma = written.indexOf(',');
  const name = (comma < 0 ? written : written.slice(0, comma)).trim();
  const charge = comma < 0 ? '' : written.slice(comma + 1).trim();
  return { name, ...(charge ? { charge } : {}), ...(offline ? { offline: true as const } : {}), section: place.section, slot: place.slot, line: place.number };
}

function readQuantitySectionLine(input: EftLineInput): void {
  const { fit, cursor, line, number } = input;
  if (cursor.blank > 0) cursor.quantitySectionOpen = false;
  const quantity = EFT_QUANTITY_PATTERN.exec(line);
  if (EFT_EMPTY_SLOT_PATTERN.test(line)) {
    fit.warnings.push(`line ${number}: "${line}" comes after the modules; skipped`);
  } else if (quantity) {
    if (!cursor.quantitySectionOpen) {
      cursor.quantitySectionOpen = true;
      cursor.quantitySections += 1;
    }
    const item: EftItemLine = { name: quantity[1].trim(), quantity: Number(quantity[2]), line: number };
    if (cursor.quantitySections === 1) fit.drones.push(item);
    else fit.cargo.push(item);
  } else {
    fit.implants.push({ name: line, line: number });
  }
}

function warnSlotCounts(fit: EftFit): void {
  for (const slot of EFT_SLOTS) {
    const limit = EFT_SLOT_LIMITS[slot];
    const count = fit.modules.filter((module) => module.slot === slot).length + fit.empty[slot];
    if (limit != null && count > limit) fit.warnings.push(`the fit has ${count} ${slot} slots; EVE hulls have at most ${limit}`);
  }
}

/**
 * The prop mod an EFT fit fits: its first module line, in written order, naming a microwarpdrive or an afterburner
 * (offline ones included). Drones, cargo and empty slots are not modules.
 *
 * @param text - The EFT text.
 * @returns The module name as written, or null when the fit fits no prop mod.
 */
export function readEftPropMod(text: string): Maybe<string> {
  return parseEftFit(text).modules.find((module) => propModKindOfName(module.name))?.name ?? null;
}
