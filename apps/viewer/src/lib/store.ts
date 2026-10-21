/**
 * Saved scenes in IndexedDB. One object store keyed by name; the working copy
 * the page restores on reload lives under a reserved key that listings hide.
 */

import type { Maybe } from '@dereekb/util';
import type { SceneDocument } from '@scene-director/scene';

const DATABASE = 'scene-director';
const STORE = 'scenes';
export const CURRENT_KEY = '__current__';

interface SceneRecord {
  readonly name: string;
  readonly scene: SceneDocument;
  readonly savedAt: string;
}

export interface SavedSceneSummary {
  readonly name: string;
  readonly savedAt: string;
  readonly ships: number;
}

export class SceneStore {
  private db: Maybe<Promise<IDBDatabase>> = null;

  async Put(name: string, scene: SceneDocument): Promise<void> {
    const record: SceneRecord = { name, scene, savedAt: new Date().toISOString() };
    await this.Run('readwrite', (store) => store.put(record));
  }

  async Get(name: string): Promise<Maybe<SceneDocument>> {
    const record = (await this.Run('readonly', (store) => store.get(name))) as SceneRecord | undefined;
    return record?.scene ?? null;
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
      .filter((record) => record.name !== CURRENT_KEY)
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
