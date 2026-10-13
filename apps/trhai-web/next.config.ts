import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The installer ships the standalone build: the server, the pages and only
  // the node_modules they trace to, run with no npm and no source tree. The
  // tracing root is the repo, because the workspace's dependencies are
  // hoisted there; without it Next guesses from the lockfile and warns.
  output: "standalone",
  outputFileTracingRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
  // The dev-only build badge defaults to a corner the app's own controls use
  // (the account menu, the sidebar's status chip); bottom-right is clear.
  devIndicators: { position: "bottom-right" }
};

export default nextConfig;
