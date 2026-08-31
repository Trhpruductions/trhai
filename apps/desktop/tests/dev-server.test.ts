import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const isWindows = process.platform === 'win32';

// What dev:web actually serves.
//
// The port-agreement test next door reads the numbers out of the files; this
// one runs the thing. Both exist because the shell spawning a server that never
// answers on the port it waits on is invisible to static checks once the two
// numbers happen to match - the server has to actually come up, and it has to
// be the right app.
//
// The dev server is launched through a shell wrapper (cmd.exe / sh), which in turn
// spawns npm and then Next. Signalling only the direct child leaves it running,
// which keeps its stdio pipes open and prevents `node --test` from ever exiting.
function killProcessTree(pid: number | undefined) {
  if (!pid) {
    return;
  }

  if (isWindows) {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }

  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already exited.
    }
  }
}

test('dev:web serves the app shell from the workspace root', async () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const npmCommand = isWindows ? 'npm.cmd' : 'npm';
  // dev:web goes through run-web-dev.ps1, whose param() block takes no
  // arguments — so trailing `-- --port N` was silently discarded. ASCEND_WEB_PORT
  // is the supported override, and a port distinct from the default keeps this
  // test from colliding with a dev server the desktop app already started.
  const child = spawn(
    isWindows ? 'cmd.exe' : 'sh',
    isWindows
      ? ['/d', '/s', '/c', `${npmCommand} run dev:web`]
      : ['-c', `${npmCommand} run dev:web`],
    {
      cwd: repoRoot,
      env: { ...process.env, CI: '1', ASCEND_WEB_PORT: '4173' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: !isWindows
    }
  );

  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });

  const startedAt = Date.now();
  let served = false;

  // Two budgets, not one, because two different things are being waited for.
  //
  // A flat 120s failed here roughly once in a dozen runs, and the captured
  // output showed why: "Ready in 33.7s", then "Compiling /" and nothing more
  // before the wait expired. Next reports itself ready before it compiles the
  // route; the first Turbopack compile on a cold .next is the slow part, and on
  // this machine it shares the disk with whatever else is running. Next printed
  // "Slow filesystem detected" in the same run.
  //
  // So starting keeps the short budget - a server that never comes up is broken
  // and should say so quickly - and compiling gets a generous one. This costs
  // nothing in the failure cases that matter: a server that dies is caught by
  // the exitCode check on the next pass, and one serving the wrong application
  // is caught by the marker on the first fetch that succeeds. Only the genuinely
  // slow case waits longer.
  let deadline = startedAt + 120000;
  let compiling = false;

  try {
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        break;
      }

      if (!compiling && /Ready in|Compiling /.test(output)) {
        compiling = true;
        deadline = Date.now() + 240000;
      }

      try {
        const response = await fetch('http://127.0.0.1:4173/', {
          signal: AbortSignal.timeout(10000)
        });
        const text = await response.text();
        // trhai-web's own wrapper, from apps/trhai-web/src/app/layout.tsx.
        // Vite's marker was `<div id="root"></div>`; matching that here is how
        // this test kept passing while dev:web served the wrong application.
        if (response.ok && text.includes('id="trhai-root"')) {
          served = true;
          break;
        }
      } catch {
        // Retry until the dev server is ready.
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } finally {
    killProcessTree(child.pid);
    // Detach the pipes so a surviving grandchild can never hold the test runner open.
    child.stdout.destroy();
    child.stderr.destroy();
    child.unref();
  }

  // Next 16 refuses to start a second dev server for a directory that already
  // has one, whatever port it is asked for. That refusal is the normal case for
  // anyone running the app while the suite runs, and a test that fails whenever
  // the app is open is a test people learn to ignore.
  //
  // It is also not a miss: the refusal names the directory it found the running
  // server for, so dev:web demonstrably resolved to trhai-web rather than the
  // old client - which is the thing under test. The marker is then checked on
  // the server that does exist, so the assertion still proves TRHAI is served
  // and not merely that a process was pointed at the right folder.
  if (!served) {
    // Only the part after the refusal describes the server that already exists.
    // Next prints its own "Local:" line for the instance it was trying to start
    // first, so matching across the whole output picks the port that is
    // deliberately not listening.
    const refusalAt = output.search(/Another next dev server is already running/i);
    const refusal = refusalAt === -1 ? "" : output.slice(refusalAt);
    const alreadyRunning = refusalAt !== -1;
    const dirMatch = refusal.match(/Dir:\s*(.+?)\s*$/m);
    const localMatch = refusal.match(/Local:\s*(http:\/\/\S+)/);

    if (alreadyRunning && dirMatch && localMatch) {
      assert.match(
        dirMatch[1],
        /trhai-web$/,
        `dev:web resolved to ${dirMatch[1]}, not apps/trhai-web`
      );

      const response = await fetch(localMatch[1], { signal: AbortSignal.timeout(15000) });
      const text = await response.text();
      served = response.ok && text.includes('id="trhai-root"');
      assert.ok(
        served,
        `dev:web pointed at trhai-web, but ${localMatch[1]} did not serve TRHAI's shell.`
      );
      return;
    }
  }

  assert.ok(served, `Expected dev:web to serve TRHAI's shell - ${compiling ? 'it started and was still compiling when the wait ran out' : 'it never reported itself ready'}. Output:\n${output}`);
});
