// Bundles the API into one file the installer ships: dist/server.mjs.
//
// Everything the API imports is pure JavaScript, so it all goes into the one
// file and the install carries no node_modules. The two files the API runs
// as separate processes are copied beside it, because they are found next
// to the running file (see appRunner.ts and frameRenderer.ts).
//
// `npm run bundle` from apps/api. `npm run build` is unchanged: tsc with
// noEmit, the type check.

import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const out = path.join(root, "dist");
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [path.join(root, "src", "index.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  tsconfig: path.join(root, "tsconfig.json"),
  outfile: path.join(out, "server.mjs"),
  // The bundled CommonJS dependencies call require(); an ES module has to be
  // given one.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: "warning"
});

for (const beside of ["loopbackOnly.cjs", "frameRendererElectron.mjs"]) {
  copyFileSync(path.join(root, "src", "services", beside), path.join(out, beside));
}

console.log(`bundled the API into ${path.relative(process.cwd(), path.join(out, "server.mjs"))}`);
