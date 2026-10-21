/**
 * esbuild options for the viewer bundle; @nx/esbuild merges them with the build target in project.json.
 *
 * The runtime's built modules import each other by `#` subpath specifiers, which a browser cannot resolve,
 * so the page ships as one bundle.
 */

import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

/** The runtime's dist directory, resolved the way its public subpaths are, so both reach the same files and no class is bundled twice. */
const RUNTIME_DIST = path.dirname(require.resolve('@carbonenginejs/runtime'));

/**
 * `runtime-dist/<file>` reaches runtime files the package does not export: the WebGPU abstraction-layer context
 * (trinityal/webgpu/internal.js), which the runtime keeps internal by design, and global/blue/children.js.
 */
const runtimeDistAlias = {
  name: 'runtime-dist',
  setup(build) {
    build.onResolve({ filter: /^runtime-dist\// }, (args) => ({ path: path.join(RUNTIME_DIST, args.path.slice('runtime-dist/'.length)) }));
  }
};

export default {
  // The runtime's package.json lists most files as side-effect free, but many of them register their classes with
  // the schema on import (the Black reader finds a class by name there). Honouring the list drops those
  // registrations and reading fails with "No source shape registered for Black type ...".
  ignoreAnnotations: true,
  legalComments: 'linked',
  logLevel: 'info',
  plugins: [runtimeDistAlias]
};
