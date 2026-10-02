// Loaded with `node --require` into every app TRH AI starts (appRunner.ts).
//
// Keeps the app on this PC. A listen() with no address is one Node takes to
// mean every address, so anything on the same network could connect while the
// app ran - which is what every generated server.js did until the generator
// named 127.0.0.1 itself. Here such a listen(), or one naming an address that
// means every address, is given 127.0.0.1 instead - and so is "localhost",
// which can resolve to ::1 alone and miss the 127.0.0.1 address TRH AI opens
// the app at. A listen() naming any other address, a pipe or a handle is left
// exactly as it was.
"use strict";

const net = require("node:net");

const thisPc = "127.0.0.1";
const replaced = new Set(["", "0.0.0.0", "::", "::0", "[::]", "localhost"]);
const listen = net.Server.prototype.listen;

function isPort(value) {
  return typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value));
}

function needsThisPc(host) {
  return host === undefined || host === null || (typeof host === "string" && replaced.has(host.toLowerCase()));
}

net.Server.prototype.listen = function listenOnThisPc(...args) {
  const [first] = args;
  if (isPort(first)) {
    // listen(port), listen(port, callback), listen(port, host, ...), listen(port, backlog, ...)
    if (typeof args[1] === "string") {
      if (needsThisPc(args[1])) args[1] = thisPc;
    } else {
      args.splice(1, 0, thisPc);
    }
  } else if (first !== null && typeof first === "object" && "port" in first && first.path === undefined) {
    // listen({ port, host })
    if (needsThisPc(first.host)) args[0] = { ...first, host: thisPc };
  } else if (first === undefined || typeof first === "function") {
    // listen() or listen(callback): a port of the system's choosing.
    args.unshift(0, thisPc);
  }
  return listen.apply(this, args);
};
