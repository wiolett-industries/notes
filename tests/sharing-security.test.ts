import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { identityFor, encryptValue, contactCode, verifyContactCode, sealRecipient, verifiedRecipient, wrapBoardKey, boardSecret } from '../apps/web/src/sharing-crypto.ts';
import { toBase64 } from '../apps/web/src/crypto.ts';
import { prepareDelta, decodeVault } from '../apps/web/src/entities.ts';
import { emptyBoard, type BoardEntry, type EntityVault } from '../packages/shared/src/index.ts';
import { imageFiles } from '../apps/server/src/image-files.ts';
import { createCollaborationStore } from '../apps/server/src/collaboration-store.ts';

const uid = 'a'.repeat(43), member = 'b'.repeat(43), survivor = 'c'.repeat(43), boardId = 'd'.repeat(43);
const aes = () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
async function rsa() {
  const pair = await crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt']);
  return { pair, publicKey: toBase64(await crypto.subtle.exportKey('spki', pair.publicKey)), privateBytes: toBase64(await crypto.subtle.exportKey('pkcs8', pair.privateKey)) };
}
const identities = Promise.all([rsa(), rsa(), rsa()]);

test('server substitution of owner public key cannot capture a new board key', async () => {
  const [owner, attacker] = await identities, key = await aes();
  const privateKey = await encryptValue(key, uid, 'identity', owner.privateBytes);
  await assert.rejects(identityFor({ request: async () => ({ publicKey: attacker.publicKey, privateKey, initialized: true }) } as any, { accountId: uid, key } as any));
  const identity = await identityFor({ request: async () => ({ publicKey: owner.publicKey, privateKey, initialized: true }) } as any, { accountId: uid, key } as any);
  assert.equal(identity.publicKey, owner.publicKey);
  assert.equal(identity.private.extractable, false);
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const entry = { id: boardId, wrappedKey: await wrapBoardKey(secret, boardId, uid, identity.publicKey) } as BoardEntry;
  await assert.rejects(boardSecret(entry, uid, { ...identity, private: attacker.pair.privateKey }));
  assert.deepEqual(await boardSecret(entry, uid, identity), secret);
});

test('invitation codes detect first-contact substitution; recipient proofs bind board and UID', async () => {
  const [owner, attacker] = await identities, key = await aes();
  const code = await contactCode(uid, owner.publicKey);
  assert.equal(await verifyContactCode(code, owner.publicKey), uid);
  await assert.rejects(verifyContactCode(code, attacker.publicKey));
  await assert.rejects(verifyContactCode(uid, owner.publicKey));
  const proof = await sealRecipient(key, boardId, uid, owner.publicKey);
  assert.equal(await verifiedRecipient(key, boardId, uid, proof), owner.publicKey);
  await assert.rejects(verifiedRecipient(key, boardId, member, proof));
  await assert.rejects(verifiedRecipient(key, 'e'.repeat(43), uid, proof));
  await assert.rejects(verifiedRecipient(key, boardId, uid, null));
});

test('member removal rotates all content atomically; revoked key cannot read new vault', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'notes-rotation-')), db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=ON; CREATE TABLE accounts (id TEXT PRIMARY KEY)');
    for (const id of [uid, member, survivor]) db.prepare('INSERT INTO accounts VALUES (?)').run(id);
    const store = createCollaborationStore(db, imageFiles(directory));
    const people = await identities, accountKey = await aes();
    for (const [index, id] of [uid, member, survivor].entries()) store.putIdentity(id, { publicKey: people[index].publicKey, privateKey: await encryptValue(accountKey, id, 'identity', people[index].privateBytes) });
    const oldBytes = crypto.getRandomValues(new Uint8Array(32)), oldKey = await crypto.subtle.importKey('raw', oldBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
    const board = emptyBoard();
    board.notes.push({ id: crypto.randomUUID(), kind: 'text', title: 'private title', text: 'private body', x: 0, y: 0, width: 272, height: 248, pinned: false, mentions: [], color: 'sage' });
    const initial = (await prepareDelta(oldKey, boardId, 0, board, null, true))!;
    await store.create(uid, { id: boardId, name: await encryptValue(oldKey, boardId, 'name', 'private'), wrappedKey: await wrapBoardKey(oldBytes, boardId, uid, people[0].publicKey), snapshot: { format: 2, manifest: initial.patch.manifest, entities: initial.patch.upserts } });
    for (const [index, id] of [member, survivor].entries()) store.invite(uid, boardId, id, 'editor', await wrapBoardKey(oldBytes, boardId, id, people[index + 1].publicKey), await sealRecipient(accountKey, boardId, id, people[index + 1].publicKey), 1);
    const newBytes = crypto.getRandomValues(new Uint8Array(32)), newKey = await crypto.subtle.importKey('raw', newBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
    const next = (await prepareDelta(newKey, boardId, 1, board, null, true))!;
    const oldEntry = store.list(uid)[0];
    const rotation = { expectedName: oldEntry.name, target: member, revision: 1, mutationId: crypto.randomUUID(), name: await encryptValue(newKey, boardId, 'name', 'private'), snapshot: { format: 2 as const, manifest: next.patch.manifest, entities: next.patch.upserts }, members: await Promise.all([{ uid, publicKey: people[0].publicKey }, { uid: survivor, publicKey: people[2].publicKey }].map(async person => ({ uid: person.uid, wrappedKey: await wrapBoardKey(newBytes, boardId, person.uid, person.publicKey) }))) };
    await assert.rejects(() => store.rotate(survivor, boardId, rotation));
    await assert.rejects(() => store.rotate(uid, boardId, { ...rotation, members: rotation.members.slice(0, 1) }));
    assert.equal(store.role(member, boardId), 'editor');
    assert.deepEqual(await store.rotate(uid, boardId, rotation), { revision: 2 });
    assert.deepEqual(await store.rotate(uid, boardId, rotation), { revision: 2 });
    assert.throws(() => store.rename(uid, boardId, oldEntry.name, oldEntry.wrappedKey));
    await assert.rejects(store.get(member, boardId));
    const vault = await store.get(survivor, boardId) as EntityVault;
    await assert.rejects(decodeVault(oldKey, vault));
    assert.equal((await decodeVault(newKey, vault)).board.notes[0].text, 'private body');
    await assert.rejects(() => store.patch(survivor, boardId, { ...initial.patch, migrate: false }));
    const entry = store.list(survivor)[0];
    assert.deepEqual(await boardSecret(entry, survivor, { publicKey: people[2].publicKey, private: people[2].pair.privateKey, privateKey: { version: 1, iv: '', ciphertext: '' } }), newBytes);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('failed stale rekey preserves the working key for subsequent saves', async () => {
  const { SharedSync } = await import('../apps/web/src/shared-sync.ts');
  const key = await aes(), staleKey = await aes(), board = emptyBoard();
  board.notes.push({ id: crypto.randomUUID(), kind: 'text', title: 'current', text: 'before', x: 0, y: 0, width: 272, height: 248, pinned: false, mentions: [], color: 'sage' });
  const initial = (await prepareDelta(key, boardId, 4, board, null, true))!;
  let vault: EntityVault = { format: 2, accountId: boardId, revision: 5, manifest: initial.patch.manifest, entities: initial.patch.upserts.map(entity => ({ ...entity, revision: 5 })) };
  const decoded = await decodeVault(key, vault);
  const socket = { on: () => () => {}, request: async (method: string, params: any) => {
    if (method === 'boards.get') return vault;
    if (method !== 'boards.patch') throw new Error('unexpected request');
    const patch = params.patch, entries = new Map(vault.entities.map(entity => [entity.id, entity]));
    for (const id of patch.deletes) entries.delete(id);
    for (const entity of patch.upserts) entries.set(entity.id, { ...entity, revision: patch.revision + 1 });
    vault = { ...vault, revision: patch.revision + 1, manifest: patch.manifest, entities: [...entries.values()] };
    await decodeVault(key, vault); // rejects any save encrypted with the failed candidate
    return { revision: vault.revision };
  } };
  const sync = new SharedSync(socket as any, key, vault, decoded.board, decoded.index!, 'editor', () => {}, () => {});
  try {
    await assert.rejects(sync.rekey(staleKey, 'editor'));
    sync.update({ ...sync.board, notes: sync.board.notes.map(note => ({ ...note, text: 'after' })) });
    assert.equal(await sync.flush(), true);
    assert.equal((await decodeVault(key, vault)).board.notes[0].text, 'after');
  } finally { sync.dispose(); }
});
