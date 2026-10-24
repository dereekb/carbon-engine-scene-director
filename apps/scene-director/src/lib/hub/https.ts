/**
 * The hub's HTTPS listener, for another device on the LAN (an iPad's Safari). WebGPU and WebCodecs exist only in a
 * secure context, and a page from http://<lan address> is not one, so a device other than the hub's machine needs
 * HTTPS. The listener runs beside the loopback HTTP one (which is unchanged) and serves the same routes and `/ws`.
 *
 * Its certificate is signed by a local CA that `scene-director https-cert` makes (https-cert.ts) and the device trusts
 * once. The CA is name-constrained to `.local` names, localhost and private IPv4 ranges, so its key can sign nothing
 * else a device would trust.
 *
 * Every request on the listener needs the access token: a `?token=` link once (answered with a cookie and a redirect
 * to the same URL without the token), then the cookie; another machine's hub (using this one's tools-core through the
 * `/tools-core/` passthrough) sends it as `authorization: Bearer <token>`. A WebSocket upgrade also needs the page's
 * own Origin when it sends one. `/ca.crt` (the CA certificate, DER) is the one path served without the token, so a device can fetch it to
 * trust it.
 */

import type { Maybe } from '@dereekb/util';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingHttpHeaders } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { defaultDataDirectory } from '../store/document-files';

export const DEFAULT_HTTPS_PORT = 5521;
/**
 * Every interface: the listener is for other devices.
 */
export const DEFAULT_HTTPS_HOST = '0.0.0.0';
export const HTTPS_TOKEN_COOKIE = 'scene_director_token';
/**
 * The CA certificate (DER), served without the token.
 */
export const HTTPS_CA_PATH = '/ca.crt';
/**
 * The files `scene-director https-cert` writes in the HTTPS directory.
 */
export const HTTPS_FILES = { ca: 'ca.crt', caKey: 'ca.key', cert: 'cert.pem', key: 'key.pem', token: 'token' } as const;
/**
 * 400 days, the longest a browser keeps a cookie.
 */
const TOKEN_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

export interface HubHttpsOptions {
  /**
   * The address to listen on: DEFAULT_HTTPS_HOST by default.
   */
  readonly host?: string;
  /**
   * DEFAULT_HTTPS_PORT by default; 0 picks a free port.
   */
  readonly port?: number;
  /**
   * The server certificate, PEM.
   */
  readonly cert: string;
  /**
   * The server certificate's private key, PEM.
   */
  readonly key: string;
  /**
   * The CA certificate, PEM, served at HTTPS_CA_PATH when given.
   */
  readonly ca?: Maybe<string>;
  /**
   * The access token every request needs.
   */
  readonly token: string;
}

/**
 * What the listener does with a request: serve it, answer a valid `?token=` link with the cookie and a redirect, or
 * refuse it.
 */
export type HttpsAdmission = { readonly kind: 'pass' } | { readonly kind: 'redirect'; readonly location: string; readonly cookie: string } | { readonly kind: 'refuse' };

export interface HttpsRequestLike {
  readonly url?: string;
  readonly headers: IncomingHttpHeaders;
}

/**
 * Whether two tokens are equal, in constant time for equal lengths.
 *
 * @param token - The access token.
 * @param offered - The token a request carries, if any.
 * @returns True when they match.
 */
function TokenMatches(token: string, offered: Maybe<string>): boolean {
  if (!offered || !token) return false;
  const expected = Buffer.from(token);
  const actual = Buffer.from(offered);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * The token cookie's value in a Cookie header.
 *
 * @param header - The request's Cookie header.
 * @returns The value, or null without the cookie.
 */
function CookieToken(header: Maybe<string>): Maybe<string> {
  const prefix = `${HTTPS_TOKEN_COOKIE}=`;
  const part = (header ?? '')
    .split(';')
    .map((piece) => piece.trim())
    .find((piece) => piece.startsWith(prefix));
  return part ? part.slice(prefix.length) : null;
}

/**
 * The token in an `authorization: Bearer <token>` header.
 *
 * @param header - The request's Authorization header.
 * @returns The token, or null without one.
 */
function BearerToken(header: Maybe<string>): Maybe<string> {
  const match = /^Bearer\s+(\S+)$/iu.exec((header ?? '').trim());
  return match ? match[1] : null;
}

/**
 * Admits a request to the HTTPS listener by its token (HTTPS_CA_PATH is served before this is asked).
 *
 * @param token - The access token.
 * @param request - The request's URL and headers.
 * @returns Pass, a redirect that sets the cookie, or refuse.
 */
export function AdmitHttpsRequest(token: string, request: HttpsRequestLike): HttpsAdmission {
  const url = new URL(request.url ?? '/', 'https://hub');
  let admission: HttpsAdmission;
  if (TokenMatches(token, url.searchParams.get('token'))) {
    url.searchParams.delete('token');
    const cookie = `${HTTPS_TOKEN_COOKIE}=${token}; Path=/; Max-Age=${TOKEN_COOKIE_MAX_AGE_SECONDS}; Secure; HttpOnly; SameSite=Lax`;
    admission = { kind: 'redirect', location: `${url.pathname}${url.search}`, cookie };
  } else {
    const carried = TokenMatches(token, CookieToken(request.headers.cookie)) || TokenMatches(token, BearerToken(request.headers.authorization));
    admission = carried ? { kind: 'pass' } : { kind: 'refuse' };
  }
  return admission;
}

/**
 * Admits a WebSocket upgrade on the HTTPS listener: the token cookie, and when the client sends an Origin (a browser
 * always does), the listener's own.
 *
 * @param token - The access token.
 * @param request - The upgrade request's headers.
 * @returns True when the upgrade may proceed.
 */
export function AdmitHttpsUpgrade(token: string, request: HttpsRequestLike): boolean {
  const { origin, host, cookie } = request.headers;
  return TokenMatches(token, CookieToken(cookie)) && (origin === undefined || origin === `https://${host}`);
}

/**
 * Adds a CA to the certificates Node's TLS clients trust by default (fetch's included), beside the system's: how a hub
 * reaches another machine's HTTPS listener, as for a tools-core shared through it. The shared CA is name-constrained to
 * private names and addresses, so it vouches for nothing public.
 *
 * @param ca - The CA certificate, PEM.
 */
export function TrustHttpsCa(ca: string): void {
  setDefaultCACertificates([...getCACertificates('default'), ca]);
}

/**
 * Where `scene-director https-cert` writes and the hub reads the HTTPS files: a `scene-director/https` folder in the
 * per-user data directory.
 *
 * @param env - The environment (XDG_DATA_HOME, LOCALAPPDATA).
 * @param platform - The platform.
 * @param home - The user's home directory.
 * @returns The directory.
 */
export function DefaultHttpsDirectory(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = os.homedir()): string {
  return defaultDataDirectory({ folder: 'https', env, platform, home });
}

/**
 * The access token in an HTTPS directory, which machines copy from each other so one token opens every hub.
 *
 * @param directory - The directory `scene-director https-cert` wrote.
 * @returns The token, or null when there is none.
 */
export function ReadHttpsToken(directory: string): Maybe<string> {
  let token: Maybe<string> = null;
  try {
    token = readFileSync(path.join(directory, HTTPS_FILES.token), 'utf8').trim() || null;
  } catch {
    token = null;
  }
  return token;
}

/**
 * Reads the HTTPS listener's certificate, key, CA certificate and token from an HTTPS directory.
 *
 * @param directory - The directory `scene-director https-cert` wrote.
 * @returns Every option but the host and port.
 * @throws {Error} When a file is missing or the token is empty, naming the command that writes them.
 */
export function ReadHttpsFiles(directory: string): Pick<HubHttpsOptions, 'cert' | 'key' | 'ca' | 'token'> {
  const read = (file: string): string => {
    const at = path.join(directory, file);
    try {
      return readFileSync(at, 'utf8');
    } catch (error) {
      throw new Error(`the HTTPS listener needs ${at} (${(error as NodeJS.ErrnoException).code ?? 'unreadable'}): run \`scene-director https-cert\` first`, { cause: error });
    }
  };
  const token = read(HTTPS_FILES.token).trim();
  if (!token) throw new Error(`${path.join(directory, HTTPS_FILES.token)} is empty: run \`scene-director https-cert\` to make a token`);
  return { cert: read(HTTPS_FILES.cert), key: read(HTTPS_FILES.key), ca: read(HTTPS_FILES.ca), token };
}

/**
 * The DNS names the certificate covers and the URLs use: localhost and the machine's mDNS name (`<name>.local`, which
 * an iPad resolves on the LAN).
 *
 * @param hostname - The machine's host name.
 * @returns The names.
 */
export function HttpsNames(hostname: string = os.hostname()): string[] {
  const label = hostname.split('.')[0];
  return label && label !== 'localhost' ? ['localhost', `${label}.local`] : ['localhost'];
}

/**
 * Whether an IPv4 address is in a private range (10/8, 172.16/12, 192.168/16) or loopback: the only addresses the CA
 * may sign for.
 *
 * @param address - A dotted IPv4 address.
 * @returns True for a private or loopback address.
 */
export function IsPrivateIpv4(address: string): boolean {
  const [a, b] = address.split('.').map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * The machine's LAN IPv4 addresses: every non-internal one.
 *
 * @param interfaces - The network interfaces.
 * @returns The addresses, in interface order.
 */
export function LanAddresses(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string[] {
  const addresses = Object.values(interfaces).flatMap((infos) => (infos ?? []).filter((info) => info.family === 'IPv4' && !info.internal).map((info) => info.address));
  return [...new Set(addresses)];
}

export interface HttpsUrlsInput {
  readonly host: string;
  readonly port: number;
  readonly hostname?: string;
  readonly interfaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
}

/**
 * The URLs the HTTPS listener answers on for another device: on every interface, the mDNS name then each private LAN
 * address; on one address, that address.
 *
 * @param input - The listener's host and port, and the machine's host name and interfaces.
 * @returns The URLs, each ending in `/`.
 */
export function HttpsUrls(input: HttpsUrlsInput): string[] {
  const { host, port, hostname, interfaces } = input;
  const hosts = host === '0.0.0.0' || host === '::' ? [...HttpsNames(hostname).filter((name) => name !== 'localhost'), ...LanAddresses(interfaces).filter(IsPrivateIpv4)] : [host];
  return hosts.map((name) => `https://${name}:${port}/`);
}
