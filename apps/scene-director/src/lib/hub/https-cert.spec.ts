import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { copyFile, mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { HTTPS_FILES } from './https';
import { MakeHttpsCertificate } from './https-cert';

/** A fresh temp HTTPS directory. */
async function TempDirectory(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'scene-director-https-cert-'));
}

describe.skipIf(spawnSync('openssl', ['version']).status !== 0)('https-cert', () => {
  let origin: string;
  let sharedCa: string;

  beforeAll(async () => {
    origin = await TempDirectory();
    await MakeHttpsCertificate({ directory: origin, hostname: 'mac', interfaces: {} });
    sharedCa = path.join(origin, HTTPS_FILES.ca);
  });

  it('signs with the shared CA once its key is copied in, and makes no CA of its own', async () => {
    const directory = await TempDirectory();
    await expect(MakeHttpsCertificate({ directory, hostname: 'pc', interfaces: {}, sharedCa })).rejects.toThrow(/copy ca\.key from a machine that has it/);
    await copyFile(path.join(origin, HTTPS_FILES.caKey), path.join(directory, HTTPS_FILES.caKey));
    const report = await MakeHttpsCertificate({ directory, hostname: 'pc', interfaces: {}, sharedCa });
    expect(report).toMatchObject({ caCreated: false, caShared: sharedCa, caName: 'scene-director dev CA (mac.local)', names: ['localhost', 'pc.local', '127.0.0.1'] });
    const ca = new X509Certificate(await readFile(sharedCa));
    expect((await readFile(path.join(directory, HTTPS_FILES.ca), 'utf8')) === ca.toString()).toBe(true);
    const leaf = new X509Certificate(await readFile(path.join(directory, HTTPS_FILES.cert)));
    expect(leaf.verify(ca.publicKey)).toBe(true);
    expect(leaf.checkHost('pc.local')).toBe('pc.local');
  });

  it('refuses another CA key beside the shared CA', async () => {
    const other = await TempDirectory();
    await MakeHttpsCertificate({ directory: other, hostname: 'other', interfaces: {} });
    await expect(MakeHttpsCertificate({ directory: other, hostname: 'other', interfaces: {}, sharedCa })).rejects.toThrow(/is not the key of the shared CA/);
  });

  it('adds --san names the CA may sign and refuses the rest', async () => {
    const report = await MakeHttpsCertificate({ directory: origin, hostname: 'mac', interfaces: {}, extraNames: ['192.168.1.40', 'dbxpc.local', '127.0.0.1'] });
    expect(report.names).toEqual(['localhost', 'mac.local', '127.0.0.1', '192.168.1.40', 'dbxpc.local']);
    const leaf = new X509Certificate(await readFile(path.join(origin, HTTPS_FILES.cert)));
    expect(leaf.checkIP('192.168.1.40')).toBe('192.168.1.40');
    for (const name of ['example.com', '8.8.8.8', 'dbxpc']) await expect(MakeHttpsCertificate({ directory: origin, hostname: 'mac', interfaces: {}, extraNames: [name] })).rejects.toThrow(/the CA may only sign/);
  });
});
