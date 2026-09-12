import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { getConnInfo } from '@hono/node-server/conninfo';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { openStore } from './store.js';
import { createApp } from './app.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const production = process.env.NODE_ENV === 'production';
const frontend = resolve(root, 'apps/web/dist');
if (production && !existsSync(resolve(frontend, 'index.html'))) throw new Error('Frontend build missing. Run npm run build first.');
if (production && (!process.env.ORIGIN || !process.env.RP_ID)) throw new Error('Set ORIGIN and RP_ID in production.');
const origin = process.env.ORIGIN ?? 'http://localhost:5173';
if (production && !origin.startsWith('https://')) throw new Error('Production ORIGIN must use HTTPS.');
const store = openStore(process.env.DATABASE_PATH ?? resolve(root, 'data/quiet.sqlite'));
const app = createApp(store, { origin, rpID: process.env.RP_ID ?? 'localhost', clientAddress: c => getConnInfo(c).remote.address ?? 'local' });
app.get('/assets/*', serveStatic({ root: frontend, onFound: (_path, c) => { c.header('Cache-Control', 'public, max-age=31536000, immutable'); } }));
app.get('/favicon.svg', serveStatic({ path: resolve(frontend, 'favicon.svg') }));
app.get('/', serveStatic({ path: resolve(frontend, 'index.html'), onFound: (_path, c) => { c.header('Cache-Control', 'no-cache'); } }));
const server = serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3001), hostname: process.env.HOST ?? '127.0.0.1' }, info => console.log(`notes listening on port ${info.port}`));
function close() { server.close(() => { store.close(); process.exit(0); }); }
process.on('SIGTERM', close);
process.on('SIGINT', close);
