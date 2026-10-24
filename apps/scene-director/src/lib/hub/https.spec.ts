import path from 'node:path';
import type os from 'node:os';
import { describe, expect, it } from 'vitest';
import { AdmitHttpsRequest, AdmitHttpsUpgrade, DefaultHttpsDirectory, HTTPS_TOKEN_COOKIE, HttpsNames, HttpsUrls, IsPrivateIpv4, LanAddresses } from './https';

const TOKEN = 'k3y-for-tests_0123456789';
const COOKIE = `${HTTPS_TOKEN_COOKIE}=${TOKEN}`;

/** A network interface entry with what LanAddresses reads. */
function Interface(address: string, family: 'IPv4' | 'IPv6' = 'IPv4', internal = false): os.NetworkInterfaceInfo {
  return { address, family, internal, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: null } as os.NetworkInterfaceInfo;
}

const INTERFACES = {
  lo0: [Interface('127.0.0.1', 'IPv4', true), Interface('::1', 'IPv6', true)],
  en0: [Interface('fe80::1', 'IPv6'), Interface('10.0.0.187')],
  utun4: [Interface('100.101.102.103')],
  bridge100: [Interface('192.168.64.1')]
};

describe('https: admitting requests', () => {
  it('refuses a request with no token, a wrong one, or a wrong cookie', () => {
    expect(AdmitHttpsRequest(TOKEN, { url: '/', headers: {} })).toEqual({ kind: 'refuse' });
    expect(AdmitHttpsRequest(TOKEN, { url: '/?token=nope', headers: {} })).toEqual({ kind: 'refuse' });
    expect(AdmitHttpsRequest(TOKEN, { url: `/?token=${TOKEN}x`, headers: {} })).toEqual({ kind: 'refuse' });
    expect(AdmitHttpsRequest(TOKEN, { url: '/config', headers: { cookie: `${HTTPS_TOKEN_COOKIE}=nope` } })).toEqual({ kind: 'refuse' });
    expect(AdmitHttpsRequest(TOKEN, { url: '/config', headers: { cookie: `other_${COOKIE}` } })).toEqual({ kind: 'refuse' });
  });

  it('answers a token link with the cookie and a redirect to the same URL without the token', () => {
    const admission = AdmitHttpsRequest(TOKEN, { url: `/console/?token=${TOKEN}&eve=off`, headers: {} });
    expect(admission.kind).toBe('redirect');
    if (admission.kind !== 'redirect') return;
    expect(admission.location).toBe('/console/?eve=off');
    expect(admission.cookie).toMatch(new RegExp(`^${COOKIE}; Path=/; `));
    expect(admission.cookie).toContain('Secure');
    expect(admission.cookie).toContain('HttpOnly');
    expect(admission.cookie).toContain('SameSite=Lax');
    const bare = AdmitHttpsRequest(TOKEN, { url: `/?token=${TOKEN}`, headers: {} });
    expect(bare.kind === 'redirect' && bare.location).toBe('/');
  });

  it('passes a request with the cookie, among others', () => {
    expect(AdmitHttpsRequest(TOKEN, { url: '/app/main.js', headers: { cookie: COOKIE } })).toEqual({ kind: 'pass' });
    expect(AdmitHttpsRequest(TOKEN, { url: '/config', headers: { cookie: `theme=dark; ${COOKIE}; other=1` } })).toEqual({ kind: 'pass' });
  });

  it("passes another hub's Bearer token, and refuses a wrong one", () => {
    expect(AdmitHttpsRequest(TOKEN, { url: '/tools-core/eve/latest/build', headers: { authorization: `Bearer ${TOKEN}` } })).toEqual({ kind: 'pass' });
    expect(AdmitHttpsRequest(TOKEN, { url: '/tools-core/eve/latest/build', headers: { authorization: `bearer  ${TOKEN}` } })).toEqual({ kind: 'pass' });
    expect(AdmitHttpsRequest(TOKEN, { url: '/tools-core/eve/latest/build', headers: { authorization: `Bearer ${TOKEN}x` } })).toEqual({ kind: 'refuse' });
    expect(AdmitHttpsRequest(TOKEN, { url: '/tools-core/eve/latest/build', headers: { authorization: `Basic ${TOKEN}` } })).toEqual({ kind: 'refuse' });
  });

  it('admits a WebSocket upgrade with the cookie and the listener origin, or no origin', () => {
    const host = 'mac.local:5521';
    expect(AdmitHttpsUpgrade(TOKEN, { headers: { host, cookie: COOKIE, origin: `https://${host}` } })).toBe(true);
    expect(AdmitHttpsUpgrade(TOKEN, { headers: { host, cookie: COOKIE } })).toBe(true);
    expect(AdmitHttpsUpgrade(TOKEN, { headers: { host, cookie: COOKIE, origin: 'https://evil.test' } })).toBe(false);
    expect(AdmitHttpsUpgrade(TOKEN, { headers: { host, cookie: COOKIE, origin: `http://${host}` } })).toBe(false);
    expect(AdmitHttpsUpgrade(TOKEN, { headers: { host, origin: `https://${host}` } })).toBe(false);
  });
});

describe('https: names and addresses', () => {
  it('names localhost and the mDNS name', () => {
    expect(HttpsNames('Michelles-MacBook-Air.local')).toEqual(['localhost', 'Michelles-MacBook-Air.local']);
    expect(HttpsNames('dbxpc')).toEqual(['localhost', 'dbxpc.local']);
    expect(HttpsNames('box.example.com')).toEqual(['localhost', 'box.local']);
    expect(HttpsNames('localhost')).toEqual(['localhost']);
  });

  it('tells private and loopback IPv4 addresses from the rest', () => {
    for (const address of ['10.0.0.187', '172.16.0.1', '172.31.255.1', '192.168.1.20', '127.0.0.1']) expect(IsPrivateIpv4(address)).toBe(true);
    for (const address of ['172.32.0.1', '100.101.102.103', '8.8.8.8', '192.169.0.1']) expect(IsPrivateIpv4(address)).toBe(false);
  });

  it('lists the non-internal IPv4 addresses', () => {
    expect(LanAddresses(INTERFACES)).toEqual(['10.0.0.187', '100.101.102.103', '192.168.64.1']);
  });

  it('gives the mDNS name then each private address on every interface, or the one host', () => {
    expect(HttpsUrls({ host: '0.0.0.0', port: 5521, hostname: 'mac.local', interfaces: INTERFACES })).toEqual(['https://mac.local:5521/', 'https://10.0.0.187:5521/', 'https://192.168.64.1:5521/']);
    expect(HttpsUrls({ host: '10.0.0.187', port: 5521, hostname: 'mac.local', interfaces: INTERFACES })).toEqual(['https://10.0.0.187:5521/']);
  });

  it('keeps its files in the per-user data directory', () => {
    expect(DefaultHttpsDirectory({}, 'darwin', '/Users/u')).toBe(path.join('/Users/u', 'Library', 'Application Support', 'scene-director', 'https'));
    expect(DefaultHttpsDirectory({ XDG_DATA_HOME: '/data' }, 'linux', '/home/u')).toBe(path.join('/data', 'scene-director', 'https'));
  });
});
