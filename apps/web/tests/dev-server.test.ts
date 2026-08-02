import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('dev:web serves the app shell from the workspace root', async () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const isWindows = process.platform === 'win32';
  const child = spawn(
    isWindows ? 'cmd.exe' : 'sh',
    isWindows
      ? ['/d', '/s', '/c', `${npmCommand} run dev:web -- --host 127.0.0.1 --strictPort --port 4173`]
      : ['-c', `${npmCommand} run dev:web -- --host 127.0.0.1 --strictPort --port 4173`],
    {
      cwd: repoRoot,
      env: { ...process.env, CI: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
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

  while (Date.now() - startedAt < 30000) {
    if (child.exitCode !== null) {
      break;
    }

    try {
      const response = await fetch('http://127.0.0.1:4173/');
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

  child.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 1000));

  assert.ok(served, `Expected Vite to serve the app shell. Output:\n${output}`);
});
