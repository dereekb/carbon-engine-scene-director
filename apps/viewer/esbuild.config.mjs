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
 *
 * It also guards against a second runtime copy. `@carbonenginejs/server` imports the runtime too; npm dedupes it onto
 * the page's copy today, but a nested `node_modules/@carbonenginejs/server/node_modules/@carbonenginejs/runtime`
 * would silently bundle every class twice. Any runtime import that resolves outside RUNTIME_DIST fails the build.
 */
const runtimeDistAlias = {
  name: 'runtime-dist',
  setup(build) {
    build.onResolve({ filter: /^runtime-dist\// }, (args) => ({ path: path.join(RUNTIME_DIST, args.path.slice('runtime-dist/'.length)) }));
    build.onResolve({ filter: /^@carbonenginejs\/runtime(\/|$)/ }, async (args) => {
      if (args.pluginData?.runtimeGuard) return undefined;
      const resolved = await build.resolve(args.path, { kind: args.kind, importer: args.importer, resolveDir: args.resolveDir, pluginData: { runtimeGuard: true } });
      if (resolved.errors.length) return { errors: resolved.errors };
      if (!resolved.path.startsWith(RUNTIME_DIST + path.sep)) {
        return { errors: [{ text: `${args.path} (imported by ${args.importer}) resolves to ${resolved.path}, outside the page's runtime ${RUNTIME_DIST}; a second runtime copy would duplicate its classes` }] };
      }
      return { path: resolved.path, namespace: resolved.namespace, external: resolved.external, sideEffects: resolved.sideEffects, suffix: resolved.suffix };
    });
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
