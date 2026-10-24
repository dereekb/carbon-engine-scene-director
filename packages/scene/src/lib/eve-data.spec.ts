import { describe, expect, it } from 'vitest';
import { DEFAULT_EVE_DATA_MODE, readEveDataMode, readEveDataStatus, readHubPageConfig } from './eve-data';

describe('readEveDataMode', () => {
  it('takes off and tools-core, trimmed and in any case', () => {
    expect(readEveDataMode('off')).toBe('off');
    expect(readEveDataMode(' OFF ')).toBe('off');
    expect(readEveDataMode('tools-core')).toBe('tools-core');
    expect(readEveDataMode('Tools-Core')).toBe('tools-core');
    expect(DEFAULT_EVE_DATA_MODE).toBe('tools-core');
  });

  it('refuses anything else', () => {
    for (const value of ['on', 'none', '', '1', 1, null, undefined, true]) expect(readEveDataMode(value)).toBeNull();
  });
});

describe('readHubPageConfig', () => {
  it('reads a GET /config body', () => {
    expect(readHubPageConfig({ eveData: { mode: 'off', note: 'why' } })).toEqual({ eveData: { mode: 'off', note: 'why' } });
    expect(readHubPageConfig({ eveData: { mode: 'tools-core' } })).toEqual({ eveData: { mode: 'tools-core' } });
  });

  it('refuses others', () => {
    for (const value of [null, 'off', [], {}, { eveData: 'off' }, { eveData: { mode: 'none' } }]) expect(readHubPageConfig(value)).toBeNull();
    expect(readEveDataStatus({ mode: 'off', note: 3 })).toEqual({ mode: 'off' });
  });
});
