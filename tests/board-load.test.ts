import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, existsSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { setImmediate as yieldToIO } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { imageFiles } from '../apps/server/src/image-files.ts';
import { CollaborationError, createCollaborationStore, type CollaborationChange } from '../apps/server/src/collaboration-store.ts';
import { attachCollaboration } from '../apps/server/src/collaboration-socket.ts';
import type { Store } from '../apps/server/src/store.ts';
import { CHUNK_CHARS, ChunkReceiver, encodeFrames, encodeSerializedFrames, encodeTreeFrames, jsonPieces, deltaSchema, configureBoardLimit, DEFAULT_BOARD_LIMIT_BYTES, type Envelope } from '../packages/shared/src/index.ts';

const envelope: Envelope = { version: 1, iv: 'a'.repeat(16), ciphertext: 'b'.repeat(128 * 1024) };
function fixture(limitBytes?: number) {
  const directory = mkdtempSync(join(tmpdir(), 'notes-load-'));
  const files = imageFiles(directory), db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE accounts (id TEXT PRIMARY KEY); INSERT INTO accounts VALUES (\'owner\')');
  const store = createCollaborationStore(db, files, limitBytes);
  const json = JSON.stringify(envelope);
  db.prepare('INSERT INTO collaboration_boards VALUES (?, ?, ?, 1, ?, NULL, NULL)').run('a'.repeat(43), 'owner', json, json);
  db.prepare('INSERT INTO collaboration_members VALUES (?, ?, ?, ?, 0)').run('a'.repeat(43), 'owner', 'owner', 'key');
  const names = Array.from({ length: 4 }, (_, index) => {
    const name = files.write(envelope);
    db.prepare('INSERT INTO collaboration_entities VALUES (?, ?, 1, ?, ?, ?, ?)').run('a'.repeat(43), `entity${index}`, '', '{}', json.length, name);
    return name;
  });
  return { directory, files, db, store, names, close() { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('board read yields outside SQLite, retains retired files and returns captured revision', async () => {
  const f = fixture();
  try {
    f.files.read = () => { throw new Error('synchronous read used'); };
    let reads = 0;
    const read = f.files.readAsync;
    f.files.readAsync = async name => { reads++; return read(name); };
    const loading = f.store.get('owner', 'a'.repeat(43));
    assert.equal(reads, 0);
    // This would throw if get held its transaction across await.
    f.db.exec('BEGIN IMMEDIATE; UPDATE collaboration_boards SET revision = 2; COMMIT');
    f.names.forEach(name => f.files.remove(name));
    assert.ok(f.names.every(name => existsSync(join(f.directory, name))));
    let turns = 0, done = false;
    const tick = () => { if (!done) { turns++; setImmediate(tick); } };
    setImmediate(tick);
    const vault = await loading;
    done = true;
    assert.equal(vault.revision, 1);
    assert.equal(vault.format, 2);
    if (vault.format !== 2) throw new Error('wrong format');
    assert.equal(vault.entities.length, 4);
    assert.ok(vault.entities.every(entity => JSON.stringify(entity.envelope) === JSON.stringify(envelope)));
    assert.ok(turns >= 4);
    assert.equal(reads, 4);
    assert.ok(f.names.every(name => !existsSync(join(f.directory, name))));
  } finally { f.close(); }
});

test('revocation during load fails closed and releases retained files', async () => {
  const f = fixture();
  try {
    const loading = f.store.get('owner', 'a'.repeat(43));
    f.db.exec('DELETE FROM collaboration_members');
    f.names.forEach(name => f.files.remove(name));
    await assert.rejects(loading, /Нет доступа/);
    assert.ok(f.names.every(name => !existsSync(join(f.directory, name))));
  } finally { f.close(); }
});

test('async encrypted reads still reject corrupt envelopes and unsafe paths', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.directory, f.names[0]!), JSON.stringify({ ...envelope, iv: 'bad' }));
    await assert.rejects(f.store.get('owner', 'a'.repeat(43)));
    await assert.rejects(f.files.readAsync('../escape.enc'), /Invalid encrypted file/);
  } finally { f.close(); }
});

test('serialized frames retain wire format and serialize a logical payload once', () => {
  let calls = 0;
  const expected = { text: ('🙂\\\"\n').repeat(CHUNK_CHARS) };
  const payload = { toJSON() { calls++; return expected; } };
  const receiver = new ChunkReceiver();
  let actual;
  for (const frame of encodeFrames(payload)) actual = receiver.push(frame);
  assert.equal(calls, 1);
  assert.deepEqual(actual, expected);
  const serialized = JSON.stringify(payload);
  for (const frame of encodeSerializedFrames(serialized)) actual = receiver.push(frame);
  assert.equal(calls, 2);
  assert.deepEqual(actual, expected);
});

async function socketFixture(tree = false) {
  let resolve!: (value: unknown) => void;
  let started!: () => void;
  const loading = new Promise<unknown>(yes => { resolve = yes; });
  const loadingStarted = new Promise<void>(yes => { started = yes; });
  let listener!: (change: CollaborationChange) => void;
  let authorized = true;
  const collaboration = {
    role() { if (!authorized) throw new Error('revoked'); return 'owner'; },
    color() { return 0; },
    get() { started(); return loading; },
    onChange(callback: typeof listener) { listener = callback; return () => {}; },
  };
  const store = { collaboration, accountBySession() { return { id: 'owner' }; } } as unknown as Store;
  const server = createServer();
  const stop = attachCollaboration(server, store, 'http://localhost');
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/socket${tree ? '?transfer=2' : ''}`, { origin: 'http://localhost', headers: { cookie: `quiet-session=${'a'.repeat(43)}` } });
  await once(ws, 'open');
  return { ws, resolve, loadingStarted, emit(change: CollaborationChange) { listener(change); }, revoke() { authorized = false; }, async close() { ws.terminate(); stop(); await new Promise<void>(yes => server.close(() => yes())); } };
}

test('async open reserves snapshot ordering ahead of patches and serializes it once', { timeout: 5000 }, async () => {
  const f = await socketFixture();
  try {
    const messages: any[] = [], receiver = new ChunkReceiver();
    let finish!: () => void;
    const received = new Promise<void>(yes => { finish = yes; });
    f.ws.on('message', data => { const value = receiver.push(data.toString()); if (value) { messages.push(value); if (value.event === 'board.patch') finish(); } });
    f.ws.send(JSON.stringify({ id: 'open', method: 'boards.open', params: { boardId: 'a'.repeat(43) } }));
    await f.loadingStarted;
    f.emit({ event: 'board.patch', boardId: 'a'.repeat(43), data: { boardId: 'a'.repeat(43), usedBytes: 0, revision: 2, manifest: envelope, upserts: [], deletes: [] } });
    let serializations = 0;
    f.resolve({ toJSON() { serializations++; return { revision: 1, data: 'a'.repeat(CHUNK_CHARS * 4) }; } });
    await received;
    assert.equal(serializations, 1);
    assert.ok(messages.findIndex(value => value.id === 'open') < messages.findIndex(value => value.event === 'board.patch'));
    assert.equal(messages.find(value => value.id === 'open').result.vault.revision, 1);
  } finally { await f.close(); }
});

test('membership is rechecked between snapshot frames', { timeout: 5000 }, async () => {
  const f = await socketFixture();
  try {
    const closed = once(f.ws, 'close');
    let chunks = 0;
    f.ws.on('message', data => { if (JSON.parse(data.toString()).chunk) { chunks++; f.revoke(); } });
    f.ws.send(JSON.stringify({ id: 'get', method: 'boards.get', params: { boardId: 'a'.repeat(43) } }));
    await f.loadingStarted;
    f.resolve({ data: 'a'.repeat(CHUNK_CHARS * 64) });
    await closed;
    assert.ok(chunks > 0 && chunks < 64, `received ${chunks} chunks`);
  } finally { await f.close(); }
});


test('quota failure still rolls back the synchronous patch transaction', async () => {
  const f = fixture(1);
  try {
    await assert.rejects(() => f.store.patch('owner', 'a'.repeat(43), {
      accountId: 'a'.repeat(43), revision: 1, mutationId: crypto.randomUUID(), migrate: false,
      manifest: { ...envelope, ciphertext: 'a'.repeat(22) }, upserts: [], deletes: ['c'.repeat(43)],
    }), (error: any) => error.status === 413);
    assert.equal(f.db.prepare('SELECT revision FROM collaboration_boards').get()!.revision, 1);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM collaboration_mutations').get()!.count, 0);
    assert.ok(f.names.every(name => existsSync(join(f.directory, name))));
  } finally { f.close(); }
});

test('serialized framing continues enforcing UTF-8 byte limits', () => {
  configureBoardLimit(1);
  try {
    // Fewer UTF-16 characters than the limit, but too many UTF-8 bytes.
    const json = JSON.stringify({ data: 'я'.repeat(11_000_000) });
    assert.throws(() => encodeSerializedFrames(json).next(), /Слишком большой пакет/);
  } finally { configureBoardLimit(DEFAULT_BOARD_LIMIT_BYTES); }
});


test('revocation during an async RPC returns its error instead of dropping the response', { timeout: 5000 }, async () => {
  const f = await socketFixture();
  try {
    const received = once(f.ws, 'message');
    f.ws.send(JSON.stringify({ id: 'get', method: 'boards.get', params: { boardId: 'a'.repeat(43) } }));
    await f.loadingStarted;
    f.revoke();
    f.resolve(Promise.reject(new CollaborationError(403, 'Нет доступа к доске.')));
    const [data] = await received;
    assert.deepEqual(JSON.parse(data.toString()), { id: 'get', status: 403, error: 'Нет доступа к доске.' });
  } finally { await f.close(); }
});

test('v2 round trip preserves Unicode, nested objects and canonical hash bytes', () => {
  const value = { nested: [{ text: ('🙂\\\"\n\ud800я').repeat(10_000), empty: '', nil: null }, [], {}], number: 1e30, omitted: undefined };
  const receiver = new ChunkReceiver(); let result: any, frames = 0;
  for (const frame of encodeTreeFrames(value)) { assert.ok(Buffer.byteLength(frame) < 512 * 1024); result = receiver.push(frame); frames++; }
  assert.ok(frames > 1);
  assert.deepEqual(result, JSON.parse(JSON.stringify(value)));
  assert.equal([...jsonPieces(value)].join(''), JSON.stringify(value));
  const dangerous = JSON.parse('{"__proto__":{"polluted":true},"constructor":1}');
  for (const frame of encodeTreeFrames(dangerous)) result = receiver.push(frame);
  assert.deepEqual(result, dangerous);
  assert.equal(({} as any).polluted, undefined);
});

test('v2 rejects invalid sequence, duplicate keys, interleaving and byte overflow', () => {
  const frames = [...encodeTreeFrames({ text: 'a'.repeat(CHUNK_CHARS * 2) })];
  assert.throws(() => new ChunkReceiver().push(frames[1]!));
  const receiver = new ChunkReceiver(); receiver.push(frames[0]!);
  assert.throws(() => receiver.push('{"event":"interleaved"}'));
  const bad = { tree: { id: 'a', index: 0, done: true, ops: [['o'], ['k', 'key'], ['v', 1], ['k', 'key'], ['v', 2], ['e']] } };
  assert.throws(() => new ChunkReceiver().push(JSON.stringify(bad)));
  configureBoardLimit(1);
  try {
    const oversized = { text: 'я'.repeat(11_000_000) };
    assert.throws(() => { for (const _frame of encodeTreeFrames(oversized)) { /* consume */ } }, /Слишком большой пакет/);
  } finally { configureBoardLimit(DEFAULT_BOARD_LIMIT_BYTES); }
});

test('v2 rechecks membership between streamed snapshot frames', { timeout: 5000 }, async () => {
  const f = await socketFixture(true);
  try {
    const closed = once(f.ws, 'close'); let frames = 0;
    f.ws.on('message', data => { if (JSON.parse(data.toString()).tree) { frames++; f.revoke(); } });
    for (const frame of encodeTreeFrames({ id: 'get', method: 'boards.get', params: { boardId: 'a'.repeat(43) } })) f.ws.send(frame);
    await f.loadingStarted;
    f.resolve({ data: 'a'.repeat(CHUNK_CHARS * 64) });
    await closed;
    assert.ok(frames > 0 && frames < 64, `received ${frames} frames`);
  } finally { await f.close(); }
});

test('warm snapshots read no unchanged files; changed revisions and deletes remain authoritative', async () => {
  const f = fixture();
  try {
    const before = await f.store.get('owner', 'a'.repeat(43));
    if (before.format !== 2) throw new Error('wrong format');
    let reads = 0; const read = f.files.readAsync;
    f.files.readAsync = async name => { reads++; return read(name); };
    const known = before.entities.map(({ id, revision }) => ({ id, revision }));
    const warm = await f.store.getCached('owner', 'a'.repeat(43), known);
    assert.equal(reads, 0); assert.ok(warm.entities.every(entity => !entity.envelope));
    f.db.exec("UPDATE collaboration_entities SET revision = 2 WHERE entity_id = 'entity0'; DELETE FROM collaboration_entities WHERE entity_id = 'entity1'; UPDATE collaboration_boards SET revision = 2");
    const changed = await f.store.getCached('owner', 'a'.repeat(43), known);
    assert.equal(reads, 1); assert.equal(changed.revision, 2);
    assert.equal(changed.entities.length, 3); assert.ok(changed.entities[0]!.envelope);
    assert.deepEqual(changed.manifest, before.manifest);
  } finally { f.close(); }
});

test('patch prestages asynchronously, preserves canonical mutation hash and cleans rejected files', async () => {
  const f = fixture();
  try {
    f.files.write = () => { throw new Error('sync file write used'); };
    const boardId = 'a'.repeat(43), address = `note-image:${crypto.randomUUID()}`;
    const id = createHash('sha256').update(JSON.stringify(['notes-entity-id', boardId, address])).digest('base64url');
    const patch = { accountId: boardId, revision: 1, mutationId: crypto.randomUUID(), migrate: false, manifest: { ...envelope, ciphertext: 'a'.repeat(22) }, upserts: [{ id, envelope, access: { address }, storage: 'file' as const }], deletes: [] };
    let wrote = 0; const write = f.files.writeAsync;
    f.files.writeAsync = async value => {
      f.db.exec('BEGIN IMMEDIATE; COMMIT'); // staging never holds SQLite
      wrote++; return write(value);
    };
    assert.deepEqual(await f.store.patch('owner', boardId, patch), { revision: 2 });
    assert.equal(wrote, 1);
    assert.equal(f.db.prepare('SELECT request_hash FROM collaboration_mutations').get()!.request_hash, createHash('sha256').update(JSON.stringify(deltaSchema.parse(patch))).digest('hex'));
    const persisted = readdirSync(f.directory).sort();
    assert.deepEqual(await f.store.patch('owner', boardId, patch), { revision: 2 });
    assert.deepEqual(readdirSync(f.directory).sort(), persisted); // duplicate staging removed
    await assert.rejects(f.store.patch('owner', boardId, { ...patch, mutationId: crypto.randomUUID() }), (error: any) => error.status === 409);
    assert.deepEqual(readdirSync(f.directory).sort(), persisted);
    const vault = await f.store.get('owner', boardId);
    if (vault.format !== 2) throw new Error('wrong format');
    assert.deepEqual(vault.entities.find(entity => entity.id === id)!.envelope, envelope);
  } finally { f.close(); }
});

test('async image staging yields and rejects invalid envelopes without orphaning files', async () => {
  const f = fixture();
  try {
    let finished = false, turns = 0;
    const saving = f.files.writeAsync({ ...envelope, ciphertext: 'a'.repeat(4 * 1024 * 1024) }).finally(() => { finished = true; });
    while (!finished) { await yieldToIO(); turns++; }
    const name = await saving;
    assert.ok(turns > 1); assert.equal((await f.files.readAsync(name)).ciphertext.length, 4 * 1024 * 1024);
    const files = readdirSync(f.directory).sort();
    await assert.rejects(f.files.writeAsync({ ...envelope, iv: 'bad' }));
    assert.deepEqual(readdirSync(f.directory).sort(), files);
  } finally { f.close(); }
});
