import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const workspaceRoot = path.resolve(__dirname, '../..');

function sendJson(res: import('node:http').ServerResponse, status: number, payload: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function isSafeWorkspaceTarget(targetPath: string): boolean {
  const relative = path.relative(workspaceRoot, targetPath);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'ascend-dev-scaffold-writer',
      configureServer(server) {
        server.middlewares.use('/__ascend/scaffold', async (req, res, next) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'Method not allowed' });
            return;
          }

          try {
            const chunks: Buffer[] = [];
            for await (const chunk of req) {
              chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
            }

            const raw = Buffer.concat(chunks).toString('utf8');
            const payload = JSON.parse(raw) as {
              request?: string;
              spec?: { path?: string; fileName?: string; content?: string };
            };

            const request = typeof payload.request === 'string' ? payload.request.trim() : '';
            const spec = payload.spec;
            const relDir = typeof spec?.path === 'string' ? spec.path.trim() : '';
            const fileName = typeof spec?.fileName === 'string' ? spec.fileName.trim() : '';
            const content = typeof spec?.content === 'string' ? spec.content : null;

            if (!request || !relDir || !fileName || content === null) {
              sendJson(res, 400, { ok: false, error: 'Invalid scaffold payload' });
              return;
            }

            const targetPath = path.resolve(workspaceRoot, relDir, fileName);
            if (!isSafeWorkspaceTarget(targetPath)) {
              sendJson(res, 403, { ok: false, error: 'Target path must be inside workspace' });
              return;
            }

            await mkdir(path.dirname(targetPath), { recursive: true });
            await writeFile(targetPath, content, 'utf8');

            sendJson(res, 200, {
              ok: true,
              created: true,
              path: path.relative(workspaceRoot, targetPath).split(path.sep).join('/'),
              message: `Created scaffold for ${request}`
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to create scaffold';
            sendJson(res, 500, { ok: false, error: message });
          }
        });
      }
    }
  ],
  resolve: {
    alias: {
      // Point at source rather than dist so the web app never depends on the
      // shared package having been built first.
      '@ascend/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts')
    }
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('react') || id.includes('react-dom')) {
            return 'vendor';
          }
          if (id.includes('@xenova/transformers')) {
            return 'transformers';
          }
          return undefined;
        }
      }
    }
  }
});
