/**
 * Ranged audio reads served from local copies of tools-core's sound banks. tools-core answers every range from a bank
 * by reading the whole cached file (CjsToolAudioSource.ReadRange): ~0.8 s for the 390 MB turrets.bnk against ~70 ms for
 * the 37 MB modules.bnk, each read allocating the whole file. The runtime reads one range per media variant, so a
 * fight's turret sounds queued hundreds of those behind the browser's six connections and never played (Windows
 * Chrome, 2026-10-23). The first ranged read of a file downloads it whole, once (concurrent reads wait for that one
 * download), into a file named by a hash of its tools-core URL, which pins the build; every range after is a slice
 * of that file on disk.
 *
 * A download that fails or answers anything but 200 is not kept: the caller proxies the read as before, and the next
 * read tries again. Writes go to a unique part file renamed into place, so hubs may share the directory.
 */

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

/**
 * The cache the hub keeps when it is not given another: under the OS temp directory, shared by every hub on the
 * machine (a cache, not a store: it holds tools-core's files as they are, per build).
 */
export const DEFAULT_AUDIO_CACHE_DIRECTORY = path.join(os.tmpdir(), 'scene-director-audio-cache');

/**
 * A cached file's sidecar.
 */
interface AudioCacheEntry {
  /**
   * The tools-core URL's path (`/eve/<build>/audio/path/<res path>`): the key, whatever host serves it.
   */
  readonly path: string;
  readonly size: number;
  readonly contentType: string;
  readonly etag?: string;
}

export interface AudioBankCacheOptions {
  readonly directory?: string;
  readonly log?: (line: string) => void;
}

export class AudioBankCache {
  readonly directory: string;
  private readonly log: (line: string) => void;
  private readonly entries = new Map<string, Promise<AudioCacheEntry | null>>();

  constructor(options: AudioBankCacheOptions = {}) {
    this.directory = options.directory ?? DEFAULT_AUDIO_CACHE_DIRECTORY;
    this.log = options.log ?? (() => undefined);
  }

  /**
   * Answers a ranged read of a tools-core audio file from the local copy, downloading it whole first when needed.
   *
   * @param input - The file's tools-core URL, the request's Range header, the response, and the fetch that downloads
   *   from tools-core (the global one by default; ToolsCoreApi.fetch carries a shared tools-core's token).
   * @returns Whether it answered; false (nothing written) for a Range it does not serve (not one `bytes=a-b` or
   *   `bytes=a-`) or a file it could not download, which the caller then proxies.
   */
  async Serve(input: { readonly url: string; readonly range: string; readonly response: ServerResponse; readonly fetch?: typeof fetch }): Promise<boolean> {
    const range = /^bytes=(\d+)-(\d*)$/u.exec(input.range.trim());
    if (!range) return false;
    const entry = await this.Entry(input.url, input.fetch ?? fetch);
    if (!entry) return false;
    const { response } = input;
    const start = Number(range[1]);
    const end = Math.min(range[2] ? Number(range[2]) : entry.size - 1, entry.size - 1);
    if (start >= entry.size || end < start) {
      response.writeHead(416, { 'content-range': `bytes */${entry.size}`, 'cache-control': 'no-store' });
      response.end();
      return true;
    }
    response.writeHead(206, {
      'content-type': entry.contentType,
      'content-length': String(end - start + 1),
      'content-range': `bytes ${start}-${end}/${entry.size}`,
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
      ...(entry.etag ? { etag: entry.etag } : {})
    });
    // A client that goes away mid-body ends the read; nothing to report.
    await pipeline(createReadStream(this.DataPath(input.url), { start, end }), response).catch(() => undefined);
    return true;
  }

  /**
   * The local copy of a file, downloaded once.
   *
   * @param url - Its tools-core URL.
   * @param fetchFile - The fetch that downloads it.
   * @returns Its sidecar, or null when it could not be downloaded.
   */
  private Entry(url: string, fetchFile: typeof fetch): Promise<AudioCacheEntry | null> {
    let entry = this.entries.get(url);
    if (!entry) {
      entry = this.ReadEntry(url).then((cached) => cached ?? this.Download(url, fetchFile));
      this.entries.set(url, entry);
      void entry.then((value) => {
        if (!value) this.entries.delete(url);
      });
    }
    return entry;
  }

  private async ReadEntry(url: string): Promise<AudioCacheEntry | null> {
    try {
      const entry = JSON.parse(await readFile(this.EntryPath(url), 'utf8')) as AudioCacheEntry;
      // A temp cleaner may have taken the data and left the sidecar.
      return entry.path === new URL(url).pathname && (await stat(this.DataPath(url))).size === entry.size ? entry : null;
    } catch {
      return null;
    }
  }

  private async Download(url: string, fetchFile: typeof fetch): Promise<AudioCacheEntry | null> {
    const part = `${this.DataPath(url)}.${randomUUID()}.part`;
    const started = Date.now();
    try {
      await mkdir(this.directory, { recursive: true });
      const upstream = await fetchFile(url);
      if (upstream.status !== 200 || !upstream.body) {
        await upstream.body?.cancel();
        return null;
      }
      await pipeline(Readable.fromWeb(upstream.body as WebReadableStream<Uint8Array>), createWriteStream(part));
      const written = (await stat(part)).size;
      const length = Number(upstream.headers.get('content-length') ?? Number.NaN);
      if (Number.isFinite(length) && written !== length) throw new Error(`downloaded ${written} of ${length} bytes`);
      const etag = upstream.headers.get('etag');
      const entry: AudioCacheEntry = { path: new URL(url).pathname, size: written, contentType: upstream.headers.get('content-type') ?? 'application/octet-stream', ...(etag ? { etag } : {}) };
      await rename(part, this.DataPath(url));
      await writeFile(this.EntryPath(url), JSON.stringify(entry));
      this.log(`audio cache: ${decodeURIComponent(path.basename(new URL(url).pathname))} (${Math.round(written / 1048576)} MB) in ${Date.now() - started} ms`);
      return entry;
    } catch (error) {
      await rm(part, { force: true });
      this.log(`audio cache: downloading ${url} failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private DataPath(url: string): string {
    return path.join(this.directory, `${Key(url)}.bin`);
  }

  private EntryPath(url: string): string {
    return path.join(this.directory, `${Key(url)}.json`);
  }
}

function Key(url: string): string {
  return createHash('sha256').update(new URL(url).pathname).digest('hex').slice(0, 32);
}
