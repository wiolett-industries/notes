import { z } from 'zod';
import { boardSchema, encryptedEntitySchema, manifestSchema, MAX_BOARD_BYTES, MAX_ENTITIES, type BoardData, type DeltaWrite, type EncryptedEntity, type Envelope, type Vault } from '@quiet/shared';
import { decryptBoard, fromBase64, toBase64 } from './crypto';

const encoder = new TextEncoder();
type Entry = { revision: number; hash: string; fingerprint: string; bytes: number };
// Only hashes/revisions survive between saves: no second plaintext content cache.
export type EntityIndex = Map<string, Entry>;
const metadataSchema = z.object({
  version: z.literal(1), notes: z.array(z.string().uuid()).max(10_000),
  groups: z.array(z.string().uuid()).max(5000), connections: z.array(z.string().uuid()).max(40_000),
  images: z.array(z.string().uuid()).max(10_000).default([]),
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
  yield ['meta', { version: 1, notes: board.notes.map(n => n.id), groups: board.groups.map(g => g.id), connections: board.connections.map(e => e.id), images: board.notes.filter(n => n.kind === 'image' || n.image).map(n => n.id) }];
  yield ['camera', board.camera];
  yield ['lockKeys', board.lockKeys ?? null];
  for (const note of board.notes) {
    const hasImage = note.kind === 'image' || Boolean(note.image);
    yield [`note-content:${note.id}`, { kind: note.kind, title: note.title, text: note.text, sealed: hasImage ? undefined : note.sealed, mentions: note.mentions }];
    if (hasImage) yield [`note-image:${note.id}`, { image: note.image, sealed: note.sealed }];
    yield [`note-layout:${note.id}`, { x: note.x, y: note.y, width: note.width, height: note.height, color: note.color, pinned: note.pinned }];
  }
  for (const group of board.groups) yield [`group:${group.id}`, group];
  for (const edge of board.connections) yield [`connection:${edge.id}`, edge];
}
function accessFor(notes: Map<string, BoardData['notes'][number]>, address: string) {
  const note = address.startsWith('note-') ? notes.get(address.split(':')[1]) : undefined;
  return { address, ...(note ? { pinned: note.pinned, sealed: Boolean(note.sealed) } : {}) };
}
function sameValue(a: any, b: any): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const keys = Object.keys(a); return keys.length === Object.keys(b).length && keys.every(key => sameValue(a[key], b[key]));
}
export async function prepareDelta(key: CryptoKey, accountId: string, revision: number, raw: BoardData, previous: EntityIndex | null, shared = false, previousBoard?: BoardData) {
  const board = boardSchema.parse(raw);
  const notes = new Map(board.notes.map(note => [note.id, note]));
  const oldRecords = previousBoard ? new Map(records(previousBoard)) : null;
  const oldNotes = previousBoard ? new Map(previousBoard.notes.map(note => [note.id, note])) : null;
  const index: EntityIndex = new Map();
  const upserts: DeltaWrite['upserts'] = [];
  let size = 0;
  for (const [address, data] of records(board)) {
    const id = await entityId(accountId, address);
    const old = previous?.get(id);
    const access = shared ? accessFor(notes, address) : undefined;
    if (old && oldRecords?.has(address) && sameValue(data, oldRecords.get(address)) && (!shared || sameValue(access, accessFor(oldNotes!, address)))) {
      size += old.bytes; if (size > MAX_BOARD_BYTES) throw new Error('Доска превышает 300 МБ.');
      index.set(id, old); continue;
    }
    const bytes = encoder.encode(JSON.stringify({ address, data }));
    size += bytes.byteLength;
    try {
      if (size > MAX_BOARD_BYTES) throw new Error('Доска превышает 300 МБ. Удалите часть изображений.');
      const fingerprint = await digest(shared ? encoder.encode(JSON.stringify([JSON.stringify({ address, data }), access])) : bytes);
      if (old?.fingerprint === fingerprint) { index.set(id, old); continue; }
      const envelope = await encrypt(key, accountId, id, revision + 1, bytes);
      index.set(id, { revision: revision + 1, hash: await cipherHash(envelope), fingerprint, bytes: bytes.byteLength });
      upserts.push({ id, envelope, ...(access ? { access } : {}), ...(address.startsWith('note-image:') ? { storage: 'file' as const } : {}) });
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
export async function decodeVault(key: CryptoKey, vault: Vault, previous?: { board: BoardData; index: EntityIndex; vault: Vault }): Promise<{ board: BoardData; index: EntityIndex | null }> {
  if (vault.format !== 2) return { board: await decryptBoard(key, vault.accountId, vault.revision, vault.envelope), index: null };
  if (!Number.isSafeInteger(vault.revision) || vault.revision < 1 || vault.entities.length > MAX_ENTITIES) throw new Error('Некорректная версия доски.');
  const manifest = manifestSchema.parse(vault.manifest);
  const bytes = await decrypt(key, vault.accountId, 'manifest', vault.revision, manifest);
  let integrity: z.infer<typeof integritySchema>;
  try { integrity = integritySchema.parse(JSON.parse(new TextDecoder().decode(bytes))); }
  finally { bytes.fill(0); }
  const index: EntityIndex = new Map();
  const cached = previous?.vault.format === 2 ? new Map(previous.vault.entities.map(entity => [entity.id, entity])) : null;
  const cachedValues = previous ? new Map(records(previous.board)) : null;
  const reusable = new Set<string>();
  const entities: EncryptedEntity[] = [];
  for (const raw of vault.entities) {
    const entity = encryptedEntitySchema.parse(raw);
    if (entity.revision > vault.revision || index.has(entity.id)) throw new Error('Некорректный набор объектов доски.');
    const old = cached?.get(entity.id), entry = previous?.index.get(entity.id);
    if (old && entry && old.revision === entity.revision && sameValue(old.envelope, entity.envelope) && sameValue(old.access, entity.access)) {
      index.set(entity.id, entry); reusable.add(entity.id);
    } else index.set(entity.id, { revision: entity.revision, hash: await cipherHash(entity.envelope), fingerprint: '', bytes: 0 });
    entities.push(entity);
  }
  if (index.size !== integrity.count || await rootHash(index) !== integrity.root) throw new Error('Нарушена целостность доски. Загрузка отменена.');
  const values = new Map<string, unknown>();
  for (const entity of entities) {
    if (reusable.has(entity.id) && entity.access && cachedValues?.has(entity.access.address)) { values.set(entity.access.address, cachedValues.get(entity.access.address)); continue; }
    const data = await decrypt(key, vault.accountId, entity.id, entity.revision, entity.envelope);
    try {
      const record = z.object({ address: z.string().max(100), data: z.unknown() }).strict().parse(JSON.parse(new TextDecoder().decode(data)));
      if (await entityId(vault.accountId, record.address) !== entity.id || values.has(record.address)) throw new Error('Некорректный идентификатор объекта.');
      if (entity.access && entity.access.address !== record.address) throw new Error('Нарушены права объекта доски.');
      index.get(entity.id)!.fingerprint = await digest(entity.access ? encoder.encode(JSON.stringify([new TextDecoder().decode(data), entity.access])) : data);
      index.get(entity.id)!.bytes = data.byteLength;
      values.set(record.address, record.data);
    } finally { data.fill(0); }
  }
  function read(address: string) {
    if (!values.has(address)) throw new Error('В доске отсутствует объект.');
    return values.get(address);
  }
  function object(address: string) { return z.record(z.string(), z.unknown()).parse(read(address)); }
  const meta = metadataSchema.parse(read('meta'));
  const imageIds = new Set(meta.images), noteIds = new Set(meta.notes);
  if (imageIds.size !== meta.images.length || meta.images.some(id => !noteIds.has(id)) || values.size !== 3 + meta.notes.length * 2 + meta.images.length + meta.groups.length + meta.connections.length) throw new Error('В доске обнаружены лишние объекты.');
  const board = boardSchema.parse({
    version: 1, camera: read('camera'), lockKeys: read('lockKeys') ?? undefined,
    notes: meta.notes.map(id => ({ id, ...object(`note-content:${id}`), ...object(`note-layout:${id}`), ...(imageIds.has(id) ? object(`note-image:${id}`) : {}) })),
    groups: meta.groups.map(id => read(`group:${id}`)), connections: meta.connections.map(id => read(`connection:${id}`)),
  });
  const notes = new Map(board.notes.map(note => [note.id, note]));
  for (const entity of entities) {
    if (entity.access && JSON.stringify(entity.access) !== JSON.stringify(accessFor(notes, entity.access.address))) throw new Error('Нарушены права заметки.');
  }
  return { board, index };
}
