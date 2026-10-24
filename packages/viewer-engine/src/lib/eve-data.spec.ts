import { afterEach, describe, expect, it, vi } from 'vitest';
import { EVE_DATA_ON, EveDataReport, EveDataText, FetchHubConfig, HUB_EVE_DATA_OFF_NOTE, HubModeChanged, PageEveDataOf, URL_EVE_DATA_OFF_NOTE, type HubConfigFetch } from './eve-data';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PageEveDataOf', () => {
  it('takes the hub off first, then ?eve=off, else on', () => {
    expect(PageEveDataOf({ hub: { mode: 'off' }, search: '' })).toEqual({ on: false, from: 'hub', note: HUB_EVE_DATA_OFF_NOTE });
    expect(PageEveDataOf({ hub: { mode: 'off' }, search: '?eve=off' }).from).toBe('hub');
    expect(PageEveDataOf({ hub: { mode: 'tools-core' }, search: '?eve=off' })).toEqual({ on: false, from: 'url', note: URL_EVE_DATA_OFF_NOTE });
    expect(PageEveDataOf({ hub: { mode: 'tools-core' }, search: '?tier=hi' })).toEqual(EVE_DATA_ON);
    expect(PageEveDataOf({ hub: null, search: '' })).toEqual(EVE_DATA_ON);
  });
});

describe('FetchHubConfig', () => {
  const answering =
    (status: number, body: unknown): HubConfigFetch =>
    async () => ({ ok: status === 200, status, json: async () => body });

  it('reads the hub answer', async () => {
    expect(await FetchHubConfig(answering(200, { eveData: { mode: 'off', note: 'why' } }))).toEqual({ eveData: { mode: 'off', note: 'why' } });
  });

  it('is null with one warning for a 404, a bad body or a timeout', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await FetchHubConfig(answering(404, null))).toBeNull();
    expect(await FetchHubConfig(answering(200, { eveData: 'off' }))).toBeNull();
    expect(
      await FetchHubConfig(async () => {
        throw new Error('The operation was aborted due to timeout');
      })
    ).toBeNull();
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls[0][0]).toMatch(/booting with EVE data on/u);
  });
});

describe('HubModeChanged', () => {
  const hubOff = PageEveDataOf({ hub: { mode: 'off' }, search: '' });
  const urlOff = PageEveDataOf({ hub: { mode: 'tools-core' }, search: '?eve=off' });

  it('reloads a tab whose mode came from the hub when the hub changed mode', () => {
    expect(HubModeChanged(hubOff, { mode: 'tools-core' })).toBe(true);
    expect(HubModeChanged(EVE_DATA_ON, { mode: 'off' })).toBe(true);
  });

  it('keeps a url-forced tab, the same mode and a hub with no mode', () => {
    expect(HubModeChanged(urlOff, { mode: 'tools-core' })).toBe(false);
    expect(HubModeChanged(urlOff, { mode: 'off' })).toBe(false);
    expect(HubModeChanged(hubOff, { mode: 'off' })).toBe(false);
    expect(HubModeChanged(EVE_DATA_ON, { mode: 'tools-core' })).toBe(false);
    expect(HubModeChanged(hubOff, null)).toBe(false);
  });
});

describe('EveDataText and EveDataReport', () => {
  it('say the mode plainly, with no row while on', () => {
    expect(EveDataText(EVE_DATA_ON)).toBeNull();
    expect(EveDataText(PageEveDataOf({ hub: { mode: 'off' }, search: '' }))).toBe('off · the hub runs with --eve-data off · ships and objects are stand-in cubes');
    expect(EveDataText(PageEveDataOf({ hub: null, search: '?eve=off' }))).toMatch(/\?eve=off/u);
    expect(EveDataReport(EVE_DATA_ON)).toEqual({ mode: 'tools-core' });
    expect(EveDataReport(PageEveDataOf({ hub: { mode: 'off' }, search: '' }))).toEqual({ mode: 'off', from: 'hub', note: HUB_EVE_DATA_OFF_NOTE });
  });
});
