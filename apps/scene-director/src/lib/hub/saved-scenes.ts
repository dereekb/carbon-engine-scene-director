/**
 * The saved-scene tools (save_scene, list_scenes, open_scene, delete_scene),
 * answered by the hub so they work with no viewer tab open. Each takes a
 * `store`:
 *
 *   disk     scene files in the hub's scenes directory (SceneFileStore)
 *   browser  the viewer tab's IndexedDB, as in phase 1; needs a connected tab
 *
 * Defaults: save_scene writes to disk; open_scene and delete_scene look on
 * disk first and fall back to the browser when the name is not on disk and a
 * tab is connected; list_scenes lists both. Nothing is written through from
 * one store to the other.
 */

import type { Maybe } from '@dereekb/util';
import { SCENE_SCHEMA } from '@scene-director/scene';
import { RequireSceneName, type SceneFileStore } from '../store/scene-files';
import { ToolError, type ToolArgs } from './tool-call';

export type SceneStoreKind = 'disk' | 'browser';

/**
 * The viewer tab, as the saved-scene tools see it.
 */
export interface SavedScenesPage {
  /**
   * Whether a tab is connected to forward to.
   */
  Connected(): boolean;
  /**
   * The error a page tool fails with when no tab is connected.
   */
  NotConnected(): ToolError;
  Call(name: string, args?: ToolArgs): Promise<unknown>;
}

export interface SavedScenesOptions {
  readonly files: SceneFileStore;
  readonly page: SavedScenesPage;
}

export interface SavedSceneEntry {
  readonly name: string;
  readonly store: SceneStoreKind;
  readonly savedAt: string;
  readonly ships: number;
  readonly file?: string;
}

/**
 * Reads the `store` argument.
 *
 * @param value - The argument.
 * @returns The store, or null when it is omitted.
 * @throws {ToolError} When it is neither "disk" nor "browser".
 */
export function ReadStore(value: unknown): Maybe<SceneStoreKind> {
  if (value === undefined || value === null) return null;
  if (value !== 'disk' && value !== 'browser') throw new ToolError(`store must be "disk" or "browser", got ${JSON.stringify(value)}`);
  return value;
}

export class SavedScenes {
  readonly files: SceneFileStore;
  private readonly page: SavedScenesPage;

  constructor({ files, page }: SavedScenesOptions) {
    this.files = files;
    this.page = page;
  }

  /**
   * Runs one saved-scene tool, or returns undefined for any other name.
   *
   * @param name - The tool name.
   * @param args - Its arguments.
   * @returns The tool's value.
   */
  Call(name: string, args: ToolArgs): Maybe<Promise<unknown>> {
    let result: Maybe<Promise<unknown>> = null;
    if (name === 'save_scene') result = this.Save(args);
    else if (name === 'list_scenes') result = this.List(args);
    else if (name === 'open_scene') result = this.Open(args);
    else if (name === 'delete_scene') result = this.Delete(args);
    return result;
  }

  async Save(args: ToolArgs): Promise<object> {
    const store = ReadStore(args['store']) ?? 'disk';
    if (store === 'browser') {
      if (args['scene'] !== undefined) throw new ToolError('"scene" is only accepted for disk saves; load_scene it first to save it in the browser');
      const saved = await this.PageCall('save_scene', { name: args['name'] });
      return { ...(saved as object), store };
    }

    let scene: unknown = args['scene'];
    if (scene === undefined) {
      if (!this.page.Connected()) throw new ToolError(`No viewer tab is connected, so there is no current scene to save. Pass "scene" to save a document directly, or open the viewer and retry.`);
      scene = await this.page.Call('get_scene');
      if (scene === null || scene === undefined) throw new ToolError('the viewer has no scene to save yet');
    }
    const saved = await this.files.Put((args['name'] as Maybe<unknown>) ?? null, scene);
    return { saved: saved.name, store, file: saved.file, ships: saved.ships, ...(saved.warnings.length ? { warnings: saved.warnings } : {}) };
  }

  async List(args: ToolArgs): Promise<object> {
    const store = ReadStore(args['store']);
    const scenes: SavedSceneEntry[] = [];
    let unreadable: { file: string; error: string }[] = [];
    let note: Maybe<string> = null;

    if (store !== 'browser') {
      const listing = await this.files.List();
      scenes.push(...listing.scenes.map((entry) => ({ ...entry, ships: entry.ships ?? 0, store: 'disk' as const })));
      unreadable = listing.unreadable;
    }
    if (store !== 'disk') {
      if (this.page.Connected()) {
        const browser = (await this.page.Call('list_scenes')) as { name: string; savedAt: string; ships: number }[];
        scenes.push(...browser.map(({ name, savedAt, ships }) => ({ name, savedAt, ships, store: 'browser' as const })));
      } else if (store === 'browser') {
        throw this.page.NotConnected();
      } else {
        note = "No viewer tab is connected, so the browser's saved scenes (IndexedDB) are not listed.";
      }
    }
    scenes.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    return {
      scenes,
      directory: this.files.directory,
      ...(unreadable.length ? { unreadable } : {}),
      ...(note ? { note } : {})
    };
  }

  async Open(args: ToolArgs): Promise<object> {
    const name = RequireSceneName(args['name']);
    const store = ReadStore(args['store']);
    // A scripted scene plays from t = 0 once prepared, or holds there with "pause": the page reads it on both paths.
    const timeline = args['timeline'] != null ? { timeline: args['timeline'] } : {};
    if (store !== 'browser') {
      const saved = await this.files.Get(name);
      if (saved) {
        const opened = { opened: saved.name, store: 'disk', file: saved.file };
        if (!this.page.Connected()) {
          return { ...opened, loaded: false, scene: saved.document, note: 'No viewer tab is connected, so the scene was read but not shown; open the viewer and call open_scene again to show it.' };
        }
        return { ...opened, ...((await this.page.Call('load_scene', { scene: saved.document, ...timeline })) as object) };
      }
      if (store === 'disk' || !this.page.Connected()) {
        const browser = store === 'disk' ? '' : ", and no viewer tab is connected to look in the browser's storage";
        throw new ToolError(`no scene "${name}" is saved on disk (${this.files.directory})${browser}; list_scenes shows what is saved`);
      }
    }
    const loaded = await this.PageCall('open_scene', { name, ...timeline });
    return { opened: name, store: 'browser', ...(loaded as object) };
  }

  async Delete(args: ToolArgs): Promise<object> {
    const name = RequireSceneName(args['name']);
    const store = ReadStore(args['store']);
    let result: Maybe<object> = null;
    if (store !== 'browser') {
      const deleted = await this.files.Delete(name);
      if (deleted || store === 'disk') result = { deleted, name, store: 'disk' };
      else if (!this.page.Connected()) result = { deleted: false, name, store: 'disk', note: "not saved on disk, and no viewer tab is connected to look in the browser's storage" };
    }
    result ??= { ...((await this.PageCall('delete_scene', { name })) as object), store: 'browser' };
    return result;
  }

  /**
   * Forwards to the tab, failing with the usual "open the viewer" error when there is none.
   *
   * @param name - The page tool.
   * @param args - Its arguments.
   * @returns The page's value.
   */
  private PageCall(name: string, args: ToolArgs): Promise<unknown> {
    if (!this.page.Connected()) return Promise.reject(this.page.NotConnected());
    return this.page.Call(name, args);
  }
}

/**
 * The scene document a tool value carries: the value itself (get_scene) or its `scene` field (load_scene, open_scene).
 *
 * @param value - A tool's value.
 * @returns The document, or null when the value carries none.
 */
export function SceneOf(value: unknown): Maybe<object> {
  let scene: Maybe<object> = null;
  if (value && typeof value === 'object') {
    if ('schema' in value && value.schema === SCENE_SCHEMA) scene = value;
    else if ('scene' in value && value.scene && typeof value.scene === 'object') scene = value.scene;
  }
  return scene;
}
