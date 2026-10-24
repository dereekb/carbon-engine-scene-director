/**
 * The engine module's entry (this library's `engine` target → dist/packages/viewer-engine/engine.js): the engine bundled
 * once with the runtime's esbuild rules, for a host whose own bundler cannot apply them (the battle console, which
 * imports `@scene-director/viewer-engine` through an import map). Its types are api.ts's, which never name the runtime.
 */

export type * from './lib/api';
export { StartViewer } from './lib/start-viewer';
