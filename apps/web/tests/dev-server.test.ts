import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const isWindows = process.platform === 'win32';

// The dev server is launched through a shell wrapper (cmd.exe / sh), which in turn
// spawns npm and then Vite. Signalling only the direct child leaves Vite running,
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
  const child = spawn(
    isWindows ? 'cmd.exe' : 'sh',
    isWindows
      ? ['/d', '/s', '/c', `${npmCommand} run dev:web -- --host 127.0.0.1 --strictPort --port 4173`]
      : ['-c', `${npmCommand} run dev:web -- --host 127.0.0.1 --strictPort --port 4173`],
    {
      cwd: repoRoot,
      env: { ...process.env, CI: '1' },
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

  try {
    while (Date.now() - startedAt < 30000) {
      if (child.exitCode !== null) {
        break;
      }

      try {
        const response = await fetch('http://127.0.0.1:4173/', {
          signal: AbortSignal.timeout(2000)
        });
        const text = await response.text();
        if (response.ok && text.includes('<div id="root"></div>')) {
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

  assert.ok(served, `Expected Vite to serve the app shell. Output:\n${output}`);
});
