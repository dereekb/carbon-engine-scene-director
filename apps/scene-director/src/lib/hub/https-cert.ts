/**
 * `scene-director https-cert`: the HTTPS listener's files (https.ts), made with the openssl command (LibreSSL on
 * macOS works too).
 *
 * - `ca.crt` / `ca.key`: a local CA, made once and kept, so a device trusts it once. It is name-constrained to `.local`
 *   names, localhost and the private IPv4 ranges: its key can sign nothing else a device would trust.
 * - `cert.pem` / `key.pem`: the server certificate, made again each run for the machine's current names and private
 *   addresses (a new DHCP address needs a new run, not a new trust). It keeps to Apple's rules for a TLS server
 *   certificate (RSA 2048, SHA-256, the names in subjectAltName, serverAuth, at most 825 days).
 * - `token`: the access token, made once and kept, so a device's cookie keeps working.
 */

import { execFile } from 'node:child_process';
import { randomBytes, X509Certificate } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { HTTPS_FILES, HttpsNames, IsPrivateIpv4, LanAddresses } from './https';

const run = promisify(execFile);

/**
 * The server certificate's lifetime: under Apple's 825-day limit.
 */
export const HTTPS_CERT_DAYS = 800;
const CA_DAYS = 3650;
const NAME_CONSTRAINTS = ['DNS:local', 'DNS:localhost', 'IP:10.0.0.0/255.0.0.0', 'IP:172.16.0.0/255.240.0.0', 'IP:192.168.0.0/255.255.0.0', 'IP:127.0.0.0/255.0.0.0'];

export interface MakeHttpsCertificateInput {
  /**
   * The HTTPS directory to write (DefaultHttpsDirectory by default in the CLI).
   */
  readonly directory: string;
  /**
   * The machine's host name: os.hostname() by default.
   */
  readonly hostname?: string;
  /**
   * The machine's network interfaces: os.networkInterfaces() by default.
   */
  readonly interfaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  /**
   * The openssl command: "openssl" by default.
   */
  readonly openssl?: string;
}

export interface HttpsCertificateReport {
  readonly directory: string;
  /**
   * The CA certificate a device trusts.
   */
  readonly ca: string;
  /**
   * True when this run made the CA: every device must trust the new one.
   */
  readonly caCreated: boolean;
  /**
   * The CA's subject common name, as a device's trust settings list it.
   */
  readonly caName: string;
  /**
   * The DNS names and IP addresses the server certificate covers.
   */
  readonly names: string[];
  /**
   * LAN addresses left out: outside the private ranges the CA may sign for.
   */
  readonly skipped: string[];
  readonly tokenCreated: boolean;
}

/**
 * Whether a file exists and has content.
 *
 * @param file - The path.
 * @returns True when it can be read and is not blank.
 */
async function HasContent(file: string): Promise<boolean> {
  const text = await readFile(file, 'utf8').catch(() => '');
  return text.trim().length > 0;
}

/**
 * Makes or refreshes the HTTPS listener's files: the CA and the token when missing, the server certificate always.
 *
 * @param input - The directory, and the machine's names, interfaces and openssl command.
 * @returns What was made and what the certificate covers.
 * @throws {Error} When openssl is missing or fails.
 */
export async function MakeHttpsCertificate(input: MakeHttpsCertificateInput): Promise<HttpsCertificateReport> {
  const { directory, hostname = os.hostname(), interfaces, openssl = 'openssl' } = input;
  const at = (file: string): string => path.join(directory, file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const work = await mkdtemp(path.join(os.tmpdir(), 'scene-director-https-'));
  const caName = `scene-director dev CA (${HttpsNames(hostname).at(-1)})`;
  const lan = LanAddresses(interfaces);
  const addresses = ['127.0.0.1', ...lan.filter(IsPrivateIpv4)];
  const names = [...HttpsNames(hostname), ...addresses];
  const openSsl = async (args: string[]): Promise<void> => {
    try {
      await run(openssl, args);
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { stderr?: string };
      const detail = failure.code === 'ENOENT' ? `the ${openssl} command was not found` : (failure.stderr?.trim() ?? failure.message);
      throw new Error(`openssl ${args[0]} failed: ${detail}`, { cause: error });
    }
  };
  try {
    const caCreated = !((await HasContent(at(HTTPS_FILES.ca))) && (await HasContent(at(HTTPS_FILES.caKey))));
    if (caCreated) {
      const config = path.join(work, 'ca.cnf');
      const permitted = NAME_CONSTRAINTS.map((name) => `permitted;${name}`).join(', ');
      await writeFile(config, ['[req]', 'distinguished_name = dn', '[dn]', '[v3_ca]', 'basicConstraints = critical, CA:TRUE, pathlen:0', 'keyUsage = critical, keyCertSign, cRLSign', 'subjectKeyIdentifier = hash', `nameConstraints = critical, ${permitted}`, ''].join('\n'));
      await openSsl(['req', '-x509', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', String(CA_DAYS), '-subj', `/O=scene-director/CN=${caName}`, '-config', config, '-extensions', 'v3_ca', '-keyout', at(HTTPS_FILES.caKey), '-out', at(HTTPS_FILES.ca)]);
    }
    const config = path.join(work, 'leaf.cnf');
    const altNames = names.map((name) => (/^[\d.]+$/.test(name) ? `IP:${name}` : `DNS:${name}`)).join(', ');
    await writeFile(
      config,
      ['[req]', 'distinguished_name = dn', '[dn]', '[v3_leaf]', 'basicConstraints = critical, CA:FALSE', 'keyUsage = critical, digitalSignature, keyEncipherment', 'extendedKeyUsage = serverAuth', `subjectAltName = ${altNames}`, 'subjectKeyIdentifier = hash', 'authorityKeyIdentifier = keyid', ''].join('\n')
    );
    const request = path.join(work, 'leaf.csr');
    await openSsl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${HttpsNames(hostname).at(-1)}`, '-config', config, '-keyout', at(HTTPS_FILES.key), '-out', request]);
    await openSsl(['x509', '-req', '-in', request, '-CA', at(HTTPS_FILES.ca), '-CAkey', at(HTTPS_FILES.caKey), '-set_serial', `0x${randomBytes(16).toString('hex')}`, '-sha256', '-days', String(HTTPS_CERT_DAYS), '-extfile', config, '-extensions', 'v3_leaf', '-out', at(HTTPS_FILES.cert)]);
    const tokenCreated = !(await HasContent(at(HTTPS_FILES.token)));
    if (tokenCreated) await writeFile(at(HTTPS_FILES.token), `${randomBytes(16).toString('base64url')}\n`, { mode: 0o600 });
    for (const secret of [HTTPS_FILES.caKey, HTTPS_FILES.key, HTTPS_FILES.token]) await chmod(at(secret), 0o600);
    const subject = new X509Certificate(await readFile(at(HTTPS_FILES.ca))).subject.split('\n');
    const commonName = subject.find((part) => part.startsWith('CN='))?.slice('CN='.length) ?? caName;
    return { directory, ca: at(HTTPS_FILES.ca), caCreated, caName: commonName, names, skipped: lan.filter((address) => !IsPrivateIpv4(address)), tokenCreated };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
