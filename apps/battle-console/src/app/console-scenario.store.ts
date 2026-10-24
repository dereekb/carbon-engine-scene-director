import { Injectable } from '@angular/core';
import type { Maybe } from '@dereekb/util';
import type { Scenario } from '@scene-director/battle';

/**
 * The IndexedDB database the console keeps its scenario in (the engine's working scene has its own store).
 */
export const CONSOLE_SCENARIO_DB = 'scene-director-console';
export const CONSOLE_SCENARIO_STORE = 'scenario';
export const CONSOLE_SCENARIO_KEY = 'current';

/**
 * What the console keeps: the scenario it loaded (the file plus the settings merged into it since), so a tab reload
 * keeps Reset working.
 */
export interface ConsoleSavedScenario {
  readonly scenario: Scenario;
  readonly savedAt: number;
}

/**
 * Keeps the console's scenario in IndexedDB. Without IndexedDB (specs) it keeps nothing and reads nothing.
 */
@Injectable({ providedIn: 'root' })
export class ConsoleScenarioStore {
  private _db: Maybe<Promise<Maybe<IDBDatabase>>>;

  /**
   * Reads the kept scenario.
   *
   * @returns The scenario, or null when none is kept.
   */
  async read(): Promise<Maybe<ConsoleSavedScenario>> {
    const db = await this.open();
    let result: Maybe<ConsoleSavedScenario>;

    if (db) {
      result = await this.request<Maybe<ConsoleSavedScenario>>(db.transaction(CONSOLE_SCENARIO_STORE, 'readonly').objectStore(CONSOLE_SCENARIO_STORE).get(CONSOLE_SCENARIO_KEY));
    }

    return result ?? undefined;
  }

  /**
   * Keeps the scenario (replacing the last), or forgets it.
   *
   * @param scenario - The scenario, or null to forget it.
   */
  async write(scenario: Maybe<Scenario>): Promise<void> {
    const db = await this.open();

    if (db) {
      const store = db.transaction(CONSOLE_SCENARIO_STORE, 'readwrite').objectStore(CONSOLE_SCENARIO_STORE);
      const saved: ConsoleSavedScenario | undefined = scenario ? { scenario, savedAt: Date.now() } : undefined;
      await this.request(saved ? store.put(saved, CONSOLE_SCENARIO_KEY) : store.delete(CONSOLE_SCENARIO_KEY));
    }
  }

  private open(): Promise<Maybe<IDBDatabase>> {
    this._db ??= new Promise<Maybe<IDBDatabase>>((resolve) => {
      if (typeof indexedDB === 'undefined') {
        resolve(undefined);
      } else {
        const request = indexedDB.open(CONSOLE_SCENARIO_DB, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(CONSOLE_SCENARIO_STORE);
        request.onsuccess = () => resolve(request.result);
        // a blocked or broken store only costs Reset after a reload
        request.onerror = () => resolve(undefined);
      }
    });

    return this._db;
  }

  private request<T>(request: IDBRequest): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result as T);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
    });
  }
}
