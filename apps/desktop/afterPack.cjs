// electron-builder's afterPack hook: puts the web app's node_modules in place.
//
// extraResources copies the Next standalone build into resources/web, but
// electron-builder drops every node_modules folder from extraResources, with
// or without a filter naming it (tried both). The standalone build's
// node_modules is exactly what Next traced the server to need - `next`
// itself, React and about 20 MB of their dependencies - and without it the
// web server has nothing to run. So it is copied here, after packaging and
// before the installers are built, into the unpacked app's resources.
"use strict";

const { cpSync, existsSync } = require("node:fs");
const path = require("node:path");

module.exports = async function afterPack(context) {
  const source = path.resolve(__dirname, "..", "trhai-web", ".next", "standalone", "node_modules");
  const target = path.join(context.appOutDir, "resources", "web", "node_modules");
  if (!existsSync(source)) throw new Error(`afterPack: no standalone node_modules at ${source}; build the web app first`);
  cpSync(source, target, { recursive: true });
  console.log(`  • afterPack: copied the web app's node_modules into ${path.relative(process.cwd(), target)}`);
};
