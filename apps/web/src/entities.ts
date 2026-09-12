import { z } from 'zod';
import { boardSchema, encryptedEntitySchema, manifestSchema, MAX_BOARD_BYTES, MAX_ENTITIES, type BoardData, type DeltaWrite, type EncryptedEntity, type Envelope, type Vault } from '@quiet/shared';
import { decryptBoard, fromBase64, toBase64 } from './crypto';

const encoder = new TextEncoder();
type Entry = { revision: number; hash: string; fingerprint: string };
// Only hashes/revisions survive between saves: no second plaintext content cache.
export type EntityIndex = Map<string, Entry>;
const metadataSchema = z.object({
  version: z.literal(1), notes: z.array(z.string().uuid()).max(1000),
  groups: z.array(z.string().uuid()).max(500), connections: z.array(z.string().uuid()).max(4000),
}).strict();
const integritySchema = z.object({ version: z.literal(1), root: z.string().length(43), count: z.number().int().min(3).max(MAX_ENTITIES) }).strict();
const aad = (account: string, id: string, revision: number) => encoder.encode(JSON.stringify(['notes-entities', 2, account, id, revision]));
const digest = async (bytes: Uint8Array<ArrayBuffer>) => toBase64(await crypto.subtle.digest('SHA-256', bytes));
export const entityId = (account: string, address: string) => digest(encoder.encode(JSON.stringify(['notes-entity-id', account, address])));
const cipherHash = (envelope: Envelope) => digest(encoder.encode(JSON.stringify([envelope.version, envelope.iv, envelope.ciphertext])));
async function rootHash(index: EntityIndex) {
  return digest(encoder.encode(JSON.stringify([...index].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([id, entry]) => [id, entry.revision, entry.hash]))));
}
async function encrypt(key: CryptoKey, account: string, id: string, revision: number, bytes: Uint8Array<ArrayBuffer>): Promise<Envelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(account, id, revision) }, key, bytes);
  return { version: 1, iv: toBase64(iv), ciphertext: toBase64(cipher) };
}
async function decrypt(key: CryptoKey, account: string, id: string, revision: number, envelope: Envelope) {
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(envelope.iv), additionalData: aad(account, id, revision) }, key, fromBase64(envelope.ciphertext)));
}
function* records(board: BoardData): Generator<[string, unknown]> {
  yield ['meta', { version: 1, notes: board.notes.map(n => n.id), groups: board.groups.map(g => g.id), connections: board.connections.map(e => e.id) }];
  yield ['camera', board.camera];
  yield ['lockKeys', board.lockKeys ?? null];
  for (const note of board.notes) {
    yield [`note-content:${note.id}`, { kind: note.kind, title: note.title, text: note.text, image: note.image, sealed: note.sealed, mentions: note.mentions }];
    yield [`note-layout:${note.id}`, { x: note.x, y: note.y, width: note.width, height: note.height, color: note.color, pinned: note.pinned }];
  }
  for (const group of board.groups) yield [`group:${group.id}`, group];
  for (const edge of board.connections) yield [`connection:${edge.id}`, edge];
}
export async function prepareDelta(key: CryptoKey, accountId: string, revision: number, raw: BoardData, previous: EntityIndex | null) {
  const board = boardSchema.parse(raw);
  const index: EntityIndex = new Map();
  const upserts: DeltaWrite['upserts'] = [];
  let size = 0;
  for (const [address, data] of records(board)) {
    const bytes = encoder.encode(JSON.stringify({ address, data }));
    size += bytes.byteLength;
    try {
      if (size > MAX_BOARD_BYTES) throw new Error('Доска превышает 23 МБ. Удалите часть изображений.');
      const id = await entityId(accountId, address);
      const fingerprint = await digest(bytes);
      const old = previous?.get(id);
      if (old?.fingerprint === fingerprint) { index.set(id, old); continue; }
      const envelope = await encrypt(key, accountId, id, revision + 1, bytes);
      index.set(id, { revision: revision + 1, hash: await cipherHash(envelope), fingerprint });
      upserts.push({ id, envelope });
    } finally { bytes.fill(0); }
  }
  const deletes = [...(previous?.keys() ?? [])].filter(id => !index.has(id));
  if (previous && !upserts.length && !deletes.length) return null;
  // Authenticate the complete object set with a tiny encrypted root. This catches
  // omitted, mixed or replayed individual objects without resending the catalog.
  const bytes = encoder.encode(JSON.stringify({ version: 1, root: await rootHash(index), count: index.size }));
  let manifest: Envelope;
  try { manifest = await encrypt(key, accountId, 'manifest', revision + 1, bytes); }
  finally { bytes.fill(0); }
  const patch: DeltaWrite = { accountId, revision, mutationId: crypto.randomUUID(), migrate: !previous, manifest, upserts, deletes };
  return { patch, index };
}
export async function decodeVault(key: CryptoKey, vault: Vault): Promise<{ board: BoardData; index: EntityIndex | null }> {
  if (vault.format !== 2) return { board: await decryptBoard(key, vault.accountId, vault.revision, vault.envelope), index: null };
  if (!Number.isSafeInteger(vault.revision) || vault.revision < 1 || vault.entities.length > MAX_ENTITIES) throw new Error('Некорректная версия доски.');
  const manifest = manifestSchema.parse(vault.manifest);
  const bytes = await decrypt(key, vault.accountId, 'manifest', vault.revision, manifest);
  let integrity: z.infer<typeof integritySchema>;
  try { integrity = integritySchema.parse(JSON.parse(new TextDecoder().decode(bytes))); }
  finally { bytes.fill(0); }
  const index: EntityIndex = new Map();
  const entities: EncryptedEntity[] = [];
  for (const raw of vault.entities) {
    const entity = encryptedEntitySchema.parse(raw);
    if (entity.revision > vault.revision || index.has(entity.id)) throw new Error('Некорректный набор объектов доски.');
    index.set(entity.id, { revision: entity.revision, hash: await cipherHash(entity.envelope), fingerprint: '' });
    entities.push(entity);
  }
  if (index.size !== integrity.count || await rootHash(index) !== integrity.root) throw new Error('Нарушена целостность доски. Загрузка отменена.');
  const values = new Map<string, unknown>();
  for (const entity of entities) {
    const data = await decrypt(key, vault.accountId, entity.id, entity.revision, entity.envelope);
    try {
      const record = z.object({ address: z.string().max(100), data: z.unknown() }).strict().parse(JSON.parse(new TextDecoder().decode(data)));
      if (await entityId(vault.accountId, record.address) !== entity.id || values.has(record.address)) throw new Error('Некорректный идентификатор объекта.');
      index.get(entity.id)!.fingerprint = await digest(data);
      values.set(record.address, record.data);
    } finally { data.fill(0); }
  }
  function read(address: string) {
    if (!values.has(address)) throw new Error('В доске отсутствует объект.');
    return values.get(address);
  }
  function object(address: string) { return z.record(z.string(), z.unknown()).parse(read(address)); }
  const meta = metadataSchema.parse(read('meta'));
  if (values.size !== 3 + meta.notes.length * 2 + meta.groups.length + meta.connections.length) throw new Error('В доске обнаружены лишние объекты.');
  const board = boardSchema.parse({
    version: 1, camera: read('camera'), lockKeys: read('lockKeys') ?? undefined,
    notes: meta.notes.map(id => ({ id, ...object(`note-content:${id}`), ...object(`note-layout:${id}`) })),
    groups: meta.groups.map(id => read(`group:${id}`)), connections: meta.connections.map(id => read(`connection:${id}`)),
  });
  return { board, index };
}
