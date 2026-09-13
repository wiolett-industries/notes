import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { attachCollaboration } from '../apps/server/src/collaboration-socket.ts';
import type { Store } from '../apps/server/src/store.ts';
import type { CachedRevision } from '../packages/shared/src/index.ts';

test('browser reload reuses ciphertext cache, handles changes/deletions and retries evicted hints', { timeout: 30_000 }, async () => {
  const bundled = await build({ stdin: { contents: "export { BoardSocket } from './apps/web/src/socket.ts';", resolveDir: process.cwd() }, bundle: true, format: 'esm', write: false });
  let snapshot = { format: 2, accountId: 'a'.repeat(43), revision: 1, manifest: { version: 1, iv: 'a'.repeat(16), ciphertext: 'm'.repeat(22) }, entities: Array.from({ length: 4 }, (_, index) => ({ id: String(index).repeat(43), revision: 1, envelope: { version: 1, iv: 'a'.repeat(16), ciphertext: String(index).repeat(256 * 1024) } })) };
  const calls: { known: number; returned: number }[] = [];
  const collaboration = {
    role() { return 'owner'; }, color() { return 0; }, onChange() { return () => {}; },
    async get() { return snapshot; },
    async getCached(_uid: string, _boardId: string, known: CachedRevision[]) {
      const revisions = new Map(known.map(item => [item.id, item.revision]));
      const entities = snapshot.entities.map(entity => revisions.get(entity.id) === entity.revision ? { id: entity.id, revision: entity.revision } : entity);
      calls.push({ known: known.length, returned: entities.filter(entity => 'envelope' in entity).length });
      return { ...snapshot, delta: true, entities };
    },
  };
  const server = createServer((req, res) => {
    if (req.url === '/bundle.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(bundled.outputFiles[0]!.text); }
    else res.end('<!doctype html><title>Socket cache test</title>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('no port');
  const origin = `http://127.0.0.1:${address.port}`;
  const stop = attachCollaboration(server, { collaboration, accountBySession() { return { id: 'owner' }; } } as unknown as Store, origin);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.TEST_BROWSER_PATH });
  try {
    const context = await browser.newContext();
    await context.addCookies([{ name: 'quiet-session', value: 'a'.repeat(43), url: origin }]);
    const page = await context.newPage(); await page.goto(origin);
    const load = async () => page.evaluate(async () => {
      const bundlePath = '/bundle.js';
      const { BoardSocket } = await import(/* @vite-ignore */ bundlePath);
      const socket = new BoardSocket();
      const value = await socket.request('boards.open', { boardId: 'a'.repeat(43) });
      await socket.cache.flush(); socket.close();
      return { revision: value.vault.revision, ids: value.vault.entities.map((entity: any) => entity.id), sizes: value.vault.entities.map((entity: any) => entity.envelope.ciphertext.length), manifest: value.vault.manifest.ciphertext };
    });
    assert.equal((await load()).sizes.length, 4);
    assert.deepEqual(calls.at(-1), { known: 0, returned: 4 });
    await page.reload();
    assert.equal((await load()).sizes.length, 4);
    assert.deepEqual(calls.at(-1), { known: 4, returned: 0 });
    snapshot = { ...snapshot, revision: 2, manifest: { ...snapshot.manifest, ciphertext: 'n'.repeat(22) }, entities: snapshot.entities.slice(1).map((entity, index) => index ? entity : { ...entity, revision: 2, envelope: { ...entity.envelope, ciphertext: 'z'.repeat(128 * 1024) } }) };
    const changed = await load();
    assert.equal(changed.revision, 2); assert.equal(changed.ids.length, 3); assert.equal(changed.sizes[0], 128 * 1024); assert.equal(changed.manifest, 'n'.repeat(22));
    assert.deepEqual(calls.at(-1), { known: 4, returned: 1 });
    // Keep hints but remove a record, simulating eviction/corruption between hint
    // lookup and hydration. The public API must retry once and return a full vault.
    await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const open = indexedDB.open('quiet-encrypted-board-cache-v1'); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
      await new Promise<void>((resolve, reject) => { const tx = db.transaction('entities', 'readwrite'); tx.objectStore('entities').delete('1'.repeat(43)); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); db.close();
    });
    assert.equal((await load()).ids.length, 3);
    assert.deepEqual(calls.slice(-2), [{ known: 3, returned: 0 }, { known: 0, returned: 3 }]);
  } finally { await browser.close(); stop(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
