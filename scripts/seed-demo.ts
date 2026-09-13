// Creates a disposable local account. Never opens or modifies an existing DB.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { emptyBoard, publicSnapshotSchema } from '@quiet/shared';
import { openStore } from '../apps/server/src/store';
import { prepareDelta } from '../apps/web/src/entities';
import { deriveKey, toBase64 } from '../apps/web/src/crypto';
import { createLockKeys } from '../apps/web/src/note-lock';
import { encryptValue, wrapBoardKey } from '../apps/web/src/sharing-crypto';

const directory = process.argv[2];
if (!directory) throw new Error('Usage: node --import tsx scripts/seed-demo.ts /path/to/empty-demo-directory');
const root = resolve(directory), database = resolve(root, 'notes.sqlite');
if (existsSync(database)) throw new Error('Refusing to overwrite an existing database. Choose a fresh directory.');
mkdirSync(root, { recursive: true, mode: 0o700 });
const fixture = publicSnapshotSchema.parse(JSON.parse(readFileSync(new URL('../docs/demo-board.json', import.meta.url), 'utf8')));
const seed = new Uint8Array(randomBytes(32)), encoder = new TextEncoder();
const material = await crypto.subtle.importKey('raw', seed, 'HKDF', false, ['deriveBits']);
const derive = async (purpose: string) => toBase64(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('notes/access-key/v1'), info: encoder.encode(purpose) }, material, 256));
const uid = await derive('account-id'), authentication = await derive('authentication');
const accountKey = await deriveKey(seed.buffer, uid, 'notes/access-key/board/v1');
const legacy = emptyBoard(); legacy.lockKeys = await createLockKeys(seed.buffer, uid);
const initial = (await prepareDelta(accountKey, uid, 0, legacy, null))!;
const store = openStore(database, resolve(root, 'images'));
try {
  store.createEntityAccount(uid, { id: `key:${uid}`, publicKey: new Uint8Array(), counter: 0 }, { format: 2, manifest: initial.patch.manifest, entities: initial.patch.upserts }, createHash('sha256').update(authentication).digest('hex'));
  const pair = await crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt']);
  const publicKey = toBase64(await crypto.subtle.exportKey('spki', pair.publicKey));
  const privateBytes = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  try { store.collaboration.putIdentity(uid, { publicKey, privateKey: await encryptValue(accountKey, uid, 'identity', toBase64(privateBytes)) }); }
  finally { privateBytes.fill(0); }
  const boardId = toBase64(randomBytes(32)), boardBytes = new Uint8Array(randomBytes(32));
  try {
    const boardKey = await crypto.subtle.importKey('raw', boardBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
    const board = { ...fixture.board, lockKeys: legacy.lockKeys };
    const prepared = (await prepareDelta(boardKey, boardId, 0, board, null, true))!;
    store.collaboration.create(uid, { id: boardId, name: await encryptValue(boardKey, boardId, 'name', fixture.name), wrappedKey: await wrapBoardKey(boardBytes, boardId, uid, publicKey), snapshot: { format: 2, manifest: prepared.patch.manifest, entities: prepared.patch.upserts } });
  } finally { boardBytes.fill(0); }
  writeFileSync(resolve(root, 'access-key.txt'), `notes_${toBase64(seed)}\n`, { mode: 0o600, flag: 'wx' });
  console.log(`Demo database: ${database}\nDisposable access key: ${resolve(root, 'access-key.txt')}`);
} finally { seed.fill(0); store.close(); }
