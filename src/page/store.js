/**
 * Saved scenes in IndexedDB. One object store keyed by name; the working copy
 * the page restores on reload lives under a reserved key that listings hide.
 */

const DATABASE = "scene-director";
const STORE = "scenes";
export const CURRENT_KEY = "__current__";

export class SceneStore
{
  constructor()
  {
    this._db = null;
  }

  async Put(name, scene)
  {
    await this._Run("readwrite", store => store.put({ name, scene, savedAt: new Date().toISOString() }));
  }

  async Get(name)
  {
    return (await this._Run("readonly", store => store.get(name)))?.scene ?? null;
  }

  async Delete(name)
  {
    const existed = (await this._Run("readonly", store => store.count(name))) > 0;
    if (existed) await this._Run("readwrite", store => store.delete(name));
    return existed;
  }

  /** Saved scenes, newest first, without their documents. */
  async List()
  {
    const records = await this._Run("readonly", store => store.getAll());
    return records
      .filter(record => record.name !== CURRENT_KEY)
      .map(record => ({ name: record.name, savedAt: record.savedAt, ships: record.scene?.ships?.length ?? 0 }))
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }

  async _Open()
  {
    this._db ??= await new Promise((resolve, reject) =>
    {
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "name" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return this._db;
  }

  async _Run(mode, action)
  {
    const db = await this._Open();
    return new Promise((resolve, reject) =>
    {
      const transaction = db.transaction(STORE, mode);
      const request = action(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }
}
