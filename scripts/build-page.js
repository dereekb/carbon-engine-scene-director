/**
 * Bundles the viewer page. The runtime's built modules import each other by
 * `#` subpath specifiers, which a browser cannot resolve, so the page ships as
 * one esbuild bundle. `runtime-dist/<file>` reaches runtime files the package
 * does not export (see src/page/runtime.js).
 *
 *   node scripts/build-page.js [--watch] [--minify]
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDist = path.join(root, "node_modules/@carbonenginejs/runtime/dist");

const runtimeDistAlias = {
  name: "runtime-dist",
  setup(build)
  {
    build.onResolve({ filter: /^runtime-dist\// }, args => ({ path: path.join(runtimeDist, args.path.slice("runtime-dist/".length)) }));
  }
};

const options = {
  entryPoints: [ path.join(root, "src/page/main.js") ],
  outfile: path.join(root, "dist/page/main.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  minify: process.argv.includes("--minify"),
  legalComments: "linked",
  // The runtime's package.json lists most files as side-effect free, but many
  // of them register their classes with the schema on import (the Black reader
  // finds a class by name there). Honouring the list drops those registrations
  // and reading fails with "No source shape registered for Black type ...".
  ignoreAnnotations: true,
  logLevel: "info",
  plugins: [ runtimeDistAlias ]
};

if (process.argv.includes("--watch"))
{
  const context = await esbuild.context(options);
  await context.watch();
}
else
{
  await esbuild.build(options);
}
