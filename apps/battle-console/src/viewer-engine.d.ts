/**
 * The engine module the console imports at run time (the import map in index.html resolves it to /console/engine.js,
 * the viewer-engine library's `engine` bundle). Its types are api.ts's alone, which never name the runtime, so the
 * console's type check never sees the runtime (sd-console).
 */
declare module '@scene-director/viewer-engine' {
  import type { StartViewerOptions, ViewerApi } from '@scene-director/viewer-engine/api';

  export type * from '@scene-director/viewer-engine/api';

  /**
   * Boots the engine on the canvas: restores the working scene, joins the hub and starts the loop.
   *
   * @param options - The canvas, the store prefix, the keys and the change listener.
   * @returns The running engine.
   */
  export function StartViewer(options: StartViewerOptions): Promise<ViewerApi>;
}
