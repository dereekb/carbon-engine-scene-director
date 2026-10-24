/**
 * Saved scenes in IndexedDB. One object store keyed by name; the working copy
 * the page restores on reload lives under a reserved key that listings hide.
 * Pages on one origin share the database, so each keeps its working copy under
 * its own prefix (the viewer none, the battle console its own): a reload never
 * restores the other page's scene.
 *
 * Node-tested (FromSceneRecord): it imports no runtime.
 */

import type { Maybe } from '@dereekb/util';
import { DEFAULT_CAMERA_FOV, type SceneDocument } from '@scene-director/scene';

const DATABASE = 'scene-director';
const STORE = 'scenes';
export const CURRENT_KEY = '__current__';

/**
 * 2 since the page draws at the document's camera fov (2026-10-23). A record without one was drawn at 90 degrees,
 * whatever its fov said.
 */
export const SCENE_RECORD_VERSION = 2;

/**
 * camera.fov's default until 2026-10-23, which normalizing wrote into every stored document.
 */
const LEGACY_DEFAULT_FOV = 45;

export interface SceneRecord {
  readonly name: string;
  readonly scene: SceneDocument;
  readonly savedAt: string;
  /**
   * SCENE_RECORD_VERSION when written; absent before 2.
   */
  readonly version?: number;
}

/**
 * The scene a stored record holds, as it was drawn when saved. A record from before the honoured fov reads a fov of 45
 * (the old default) as DEFAULT_CAMERA_FOV, the 90 degrees it was drawn at; any other fov was set on purpose and is kept.
 *
 * @param record - The stored record.
 * @returns Its scene, the record's own object when nothing changes.
 */
export function FromSceneRecord({ scene, version }: Pick<SceneRecord, 'scene' | 'version'>): SceneDocument {
  const legacy = (version ?? 1) < SCENE_RECORD_VERSION && scene?.camera?.fov === LEGACY_DEFAULT_FOV;
  return legacy ? { ...scene, camera: { ...scene.camera, fov: DEFAULT_CAMERA_FOV } } : scene;
}

export interface SavedSceneSummary {
  readonly name: string;
  readonly savedAt: string;
  readonly ships: number;
}

/**
 * Whether a key names a page's working copy (any prefix): reserved, and hidden from listings.
 *
 * @param name - A record key.
 * @returns True for `<prefix>__current__`.
 */
export function IsWorkingCopyKey(name: string): boolean {
  return name.endsWith(CURRENT_KEY);
}

export interface SceneStoreOptions {
  /**
   * The working copy's key prefix; none (the viewer's `__current__`) by default.
   */
  readonly prefix?: string;
}

export class SceneStore {
  private db: Maybe<Promise<IDBDatabase>> = null;
  /**
   * The key this page's working copy lives under.
   */
  readonly currentKey: string;

  constructor({ prefix = '' }: SceneStoreOptions = {}) {
    this.currentKey = `${prefix}${CURRENT_KEY}`;
  }

  async Put(name: string, scene: SceneDocument): Promise<void> {
    const record: SceneRecord = { name, scene, savedAt: new Date().toISOString(), version: SCENE_RECORD_VERSION };
    await this.Run('readwrite', (store) => store.put(record));
  }

  async Get(name: string): Promise<Maybe<SceneDocument>> {
    const record = (await this.Run('readonly', (store) => store.get(name))) as SceneRecord | undefined;
    return record?.scene ? FromSceneRecord(record) : null;
  }

  async Delete(name: string): Promise<boolean> {
    const existed = (await this.Run('readonly', (store) => store.count(name))) > 0;
    if (existed) await this.Run('readwrite', (store) => store.delete(name));
    return existed;
  }

  /**
   * Saved scenes, newest first, without their documents.
   */
  async List(): Promise<SavedSceneSummary[]> {
    const records = (await this.Run('readonly', (store) => store.getAll())) as SceneRecord[];
    return records
      .filter((record) => !IsWorkingCopyKey(record.name))
      .map((record) => ({ name: record.name, savedAt: record.savedAt, ships: record.scene?.ships?.length ?? 0 }))
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }

  private Open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'name' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
    });
    return this.db;
  }

  private async Run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.Open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = action(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    });
  }
}
