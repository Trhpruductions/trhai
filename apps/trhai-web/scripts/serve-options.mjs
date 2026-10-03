// What serve.mjs is asked for, read the way `next start` reads it, and where
// that means listening. Pure, so it is tested without a build or a port.

const thisPc = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * -p/--port and -H/--hostname, as `next start` takes them (`-p 3210` and
 * `--port=3210` alike). Without -p, PORT, then 3000 - Next's own default.
 *
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ port: number, hostname: string | null }}
 */
export function serveOptions(argv, env = {}) {
  let port;
  let hostname = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const equals = arg.indexOf("=");
    const flag = equals > 0 ? arg.slice(0, equals) : arg;
    const isPort = flag === "-p" || flag === "--port";
    if (!isPort && flag !== "-H" && flag !== "--hostname") continue;
    let value;
    if (equals > 0) {
      value = arg.slice(equals + 1);
    } else {
      index += 1;
      value = argv[index];
    }
    if (isPort) port = value;
    else hostname = value ?? null;
  }
  const raw = port ?? env.PORT ?? "3000";
  const parsed = Number(raw);
  if (!/^\d+$/.test(String(raw).trim()) || parsed > 65535) throw new Error(`Not a port: ${raw}`);
  return { port: parsed, hostname };
}

/**
 * Where to listen: this PC's two addresses for no hostname or one naming this
 * PC, since either alone leaves some client waiting (serve.mjs says which);
 * any other hostname exactly as given.
 *
 * @param {string | null} hostname
 * @returns {string[]}
 */
export function listenHosts(hostname) {
  if (!hostname || thisPc.has(hostname.toLowerCase())) return ["127.0.0.1", "::1"];
  return [hostname];
}
