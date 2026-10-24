import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * verify-page's area prefixes and the ref that owns each (the table in sd-dev-env → verify-page). dbx-claude selects a
 * verify-page area with `--only "<prefix>:"`, so every check label starts with one.
 */
const AREAS: Record<string, string> = {
  'scene-document': 'sd-scene-document',
  'ship-stats': 'sd-ship-stats',
  fittings: 'sd-fittings',
  weapons: 'sd-weapons',
  piloting: 'sd-piloting',
  combat: 'sd-combat',
  fleets: 'sd-fleets',
  'free fire': 'sd-personalities',
  personality: 'sd-personalities',
  logi: 'sd-logi',
  locations: 'sd-locations',
  staging: 'sd-staging',
  objects: 'sd-objects',
  'asteroid-fields': 'sd-asteroid-fields',
  cinema: 'sd-cinema',
  'warp-in': 'sd-staging',
  timeline: 'sd-timeline',
  time: 'sd-time',
  'dev-env': 'sd-dev-env',
  director: 'sd-cinema',
  movie: 'sd-timeline',
  export: 'sd-export',
  record: 'sd-export',
  'no EVE data': 'sd-dev-env'
};

const SOURCE = readFileSync(path.resolve(import.meta.dirname, '../../verify-page.ts'), 'utf8');
const LABELS = [...SOURCE.matchAll(/\bCheck\(\s*(['"])(.*?)\1\s*,/gu)].map((match) => match[2]);

describe('verify-page check labels', () => {
  it('reads every check label as a string literal', () => {
    // Every call but the definition and the always-run connect check.
    const calls = [...SOURCE.matchAll(/\bCheck\(/gu)].length;
    const others = [...SOURCE.matchAll(/\bfunction Check\(|\bCheck\(CONNECT_CHECK\b/gu)].length;
    expect(LABELS.length).toBeGreaterThan(200);
    expect(LABELS.length).toBe(calls - others);
  });

  it('starts every label with an area prefix', () => {
    const prefixes = Object.keys(AREAS);
    const offending = LABELS.filter((label) => !prefixes.some((prefix) => label.startsWith(`${prefix}: `)));
    expect(offending).toEqual([]);
  });

  it('selects exactly its own area with --only "<prefix>:"', () => {
    // --only matches a lowercased substring anywhere in the label, so a prefix must not appear inside another label.
    const strays = Object.keys(AREAS).flatMap((prefix) => LABELS.filter((label) => label.toLowerCase().includes(`${prefix.toLowerCase()}:`) && !label.startsWith(`${prefix}: `)).map((label) => `${prefix}: ${label}`));
    expect(strays).toEqual([]);
  });
});
