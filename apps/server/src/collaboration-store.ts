import { createHash, createPublicKey, randomBytes } from 'node:crypto';
import { setImmediate as yieldToIO } from 'node:timers/promises';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  MAX_BOARD_BYTES, MAX_ENCRYPTED_BYTES, MAX_ENTITIES, MAX_TRANSFER_BYTES, base64url, deltaSchema, entityWriteSchema, jsonPieces,
  envelopeSchema, initialEntitiesSchema, publicSnapshotSchema,
  type AccountIdentity, type BoardEntry, type BoardRole, type DeltaWrite,
  type EntityWrite, type Envelope, type InitialEntities, type PublicSnapshot, type Vault, type CachedRevision, type DeltaVault,
} from '@quiet/shared';
import type { imageFiles } from './image-files.js';
import { storageLimitBytes } from './storage-limit.js';

export class CollaborationError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
const fail = (status: number, message: string): never => { throw new CollaborationError(status, message); };
const identifier = base64url.length(43);
const wrappedKeySchema = base64url.length(512); // RSA-OAEP, 3072 bits.
const publicFilePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.public\.json$/;
const nameSchema = envelopeSchema.extend({ ciphertext: base64url.min(22).max(4096) });
const identitySchema = z.object({ publicKey: base64url.max(2000), privateKey: envelopeSchema.extend({ ciphertext: base64url.min(22).max(16000) }) }).strict();
type Access = NonNullable<EntityWrite['access']>;
type EntityRow = { entity_id: string; revision: number; envelope: string; access: string; file_name: string | null };
type BoardRow = { id: string; owner_id: string; name: string; revision: number; manifest: string; public_token: string | null; public_snapshot: string | null };
export type CollaborationChange =
  | { event: 'board.patch'; boardId: string; data: { boardId: string; usedBytes: number; revision: number; manifest: Envelope; upserts: (EntityWrite & { revision: number })[]; deletes: string[] } }
  | { event: 'board.access'; boardId: string; uids: string[] }
  | { event: 'boards.changed'; boardId: string; uids: string[] };

/** Shares the legacy DB and encrypted file directory; initialize before any file sweep. */
export function createCollaborationStore(db: DatabaseSync, files: ReturnType<typeof imageFiles>, limitBytes = storageLimitBytes()) {
  const limitMessage = `Достигнут лимит доски — ${limitBytes / 1_000_000} МБ. Удалите часть данных или отключите публичный снимок.`;
  db.exec(`
    CREATE TABLE IF NOT EXISTS collaboration_identities (
      uid TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      public_key TEXT NOT NULL, private_key TEXT NOT NULL, initialized INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    CREATE TABLE IF NOT EXISTS collaboration_boards (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES accounts(id),
      name TEXT NOT NULL, revision INTEGER NOT NULL, manifest TEXT NOT NULL,
      public_token TEXT UNIQUE, public_snapshot TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS collaboration_owner ON collaboration_boards(owner_id);
    CREATE TABLE IF NOT EXISTS collaboration_members (
      board_id TEXT NOT NULL REFERENCES collaboration_boards(id) ON DELETE CASCADE,
      uid TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('owner', 'editor', 'viewer')), wrapped_key TEXT NOT NULL,
      PRIMARY KEY(board_id, uid)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS collaboration_member_uid ON collaboration_members(uid);
    CREATE TABLE IF NOT EXISTS collaboration_verified_keys (
      board_id TEXT NOT NULL, uid TEXT NOT NULL, proof TEXT NOT NULL,
      PRIMARY KEY(board_id, uid),
      FOREIGN KEY(board_id, uid) REFERENCES collaboration_members(board_id, uid) ON DELETE CASCADE
    ) STRICT;
    CREATE TABLE IF NOT EXISTS collaboration_entities (
      board_id TEXT NOT NULL REFERENCES collaboration_boards(id) ON DELETE CASCADE,
      entity_id TEXT NOT NULL, revision INTEGER NOT NULL, envelope TEXT NOT NULL,
      access TEXT NOT NULL, byte_length INTEGER NOT NULL, file_name TEXT,
      PRIMARY KEY(board_id, entity_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS collaboration_mutations (
      board_id TEXT NOT NULL REFERENCES collaboration_boards(id) ON DELETE CASCADE,
      mutation_id TEXT NOT NULL, revision INTEGER NOT NULL, request_hash TEXT NOT NULL,
      PRIMARY KEY(board_id, mutation_id)
    ) STRICT;
  `);
  // Serialize schema upgrade/backfill with other processes opening this database.
  db.exec('BEGIN IMMEDIATE');
  try {
    const memberColumns = db.prepare('PRAGMA table_info(collaboration_members)').all() as { name: string }[];
    if (!memberColumns.some(column => column.name === 'color')) {
      db.exec('ALTER TABLE collaboration_members ADD COLUMN color INTEGER NOT NULL DEFAULT 0');
      const members = db.prepare("SELECT board_id, uid FROM collaboration_members ORDER BY board_id, role != 'owner', uid").all() as { board_id: string; uid: string }[];
      let previous = '', slot = 0;
      for (const member of members) {
        if (member.board_id !== previous) { previous = member.board_id; slot = 0; }
        db.prepare('UPDATE collaboration_members SET color = ? WHERE board_id = ? AND uid = ?').run(slot++ % 10, member.board_id, member.uid);
      }
    }
    const columns = db.prepare('PRAGMA table_info(collaboration_identities)').all() as { name: string }[];
    if (!columns.some(column => column.name === 'initialized')) {
      db.exec('ALTER TABLE collaboration_identities ADD COLUMN initialized INTEGER NOT NULL DEFAULT 0');
    }
    db.exec(`UPDATE collaboration_identities SET initialized = 1
      WHERE initialized = 0 AND EXISTS (
        SELECT 1 FROM collaboration_boards WHERE owner_id = collaboration_identities.uid
      )`);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  const listeners = new Set<(change: CollaborationChange) => void>();
  function notify(change: CollaborationChange) {
    // A transport failure must never turn an already committed write into a failed RPC.
    for (const listener of listeners) { try { listener(change); } catch { /* transport owns connection failures */ } }
  }
  function removeFiles(names: string[]) {
    for (const name of names) try { files.remove(name); } catch { console.error('Encrypted image cleanup deferred until restart.'); }
  }
  function removeSnapshots(names: string[]) {
    for (const name of names) try { files.removeSnapshot(name); } catch { console.error('Public snapshot cleanup deferred until restart.'); }
  }
  function transaction<T>(work: (created: string[], retired: string[], snapshots: { created: string[]; retired: string[] }) => T): T {
    db.exec('BEGIN IMMEDIATE');
    const created: string[] = [], retired: string[] = [];
    const snapshots = { created: [] as string[], retired: [] as string[] };
    let result: T;
    try { result = work(created, retired, snapshots); db.exec('COMMIT'); }
    catch (error) { try { db.exec('ROLLBACK'); } finally { removeFiles(created); removeSnapshots(snapshots.created); } throw error; }
    removeFiles(retired);
    removeSnapshots(snapshots.retired);
    return result;
  }
  function role(uid: string, boardId: string): BoardRole {
    const row = db.prepare('SELECT role FROM collaboration_members WHERE board_id = ? AND uid = ?').get(boardId, uid) as { role: BoardRole } | undefined;
    return row?.role ?? fail(403, 'Нет доступа к доске.');
  }
  function owner(uid: string, boardId: string) { if (role(uid, boardId) !== 'owner') fail(403, 'Доступно только владельцу доски.'); }
  function board(boardId: string) {
    return db.prepare('SELECT * FROM collaboration_boards WHERE id = ?').get(boardId) as BoardRow;
  }
  function memberIds(boardId: string) {
    return (db.prepare('SELECT uid FROM collaboration_members WHERE board_id = ?').all(boardId) as { uid: string }[]).map(row => row.uid);
  }
  function entry(uid: string, boardId: string): BoardEntry {
    const membership = db.prepare('SELECT role, wrapped_key FROM collaboration_members WHERE board_id = ? AND uid = ?').get(boardId, uid) as { role: BoardRole; wrapped_key: string } | undefined;
    if (!membership) return fail(403, 'Нет доступа к доске.');
    const row = board(boardId);
    return { id: row.id, ownerId: row.owner_id, role: membership.role, name: JSON.parse(row.name), wrappedKey: membership.wrapped_key, publicToken: membership.role === 'owner' ? row.public_token : null, usedBytes: usage(boardId), limitBytes };
  }
  function usage(boardId: string) {
    const row = board(boardId);
    const entities = db.prepare('SELECT COALESCE(SUM(byte_length + length(access) + length(entity_id)), 0) AS bytes FROM collaboration_entities WHERE board_id = ?').get(boardId) as { bytes: number };
    const snapshot = row.public_snapshot ? (publicFilePattern.test(row.public_snapshot) ? files.snapshotBytes(row.public_snapshot) : Buffer.byteLength(row.public_snapshot)) : 0;
    return entities.bytes + Buffer.byteLength(row.name) + Buffer.byteLength(row.manifest) + snapshot;
  }
  function checkQuota(boardId: string) { if (usage(boardId) > limitBytes) fail(413, limitMessage); }
  function identity(uid: string): AccountIdentity | null {
    const row = db.prepare('SELECT public_key, private_key, (initialized != 0 OR EXISTS (SELECT 1 FROM collaboration_boards WHERE owner_id = collaboration_identities.uid)) AS initialized FROM collaboration_identities WHERE uid = ?').get(uid) as { public_key: string; private_key: string; initialized: number } | undefined;
    return row ? { publicKey: row.public_key, privateKey: JSON.parse(row.private_key), initialized: Boolean(row.initialized) } : null;
  }
  function rows(boardId: string) { return db.prepare('SELECT * FROM collaboration_entities WHERE board_id = ?').all(boardId) as EntityRow[]; }
  function noteId(access: Access) { return /^note-(?:content|layout|image):/.test(access.address) ? access.address.split(':')[1]! : null; }
  function flags(access: Access) { return `${Boolean(access.pinned)}:${Boolean(access.sealed)}`; }
  function noteFlags(accesses: Iterable<Access>) {
    const notes = new Map<string, Access>();
    for (const access of accesses) {
      const id = noteId(access);
      if (!id) continue;
      const previous = notes.get(id);
      if (previous && flags(previous) !== flags(access)) fail(400, 'Флаги заметки должны совпадать во всех её сущностях.');
      notes.set(id, access);
    }
    return notes;
  }
  function checkPolicy(boardId: string, actorRole: BoardRole, previous: EntityRow[], upserts: EntityWrite[], deletes: string[]) {
    const before = new Map(previous.map(row => [row.entity_id, JSON.parse(row.access) as Access]));
    const notes = noteFlags(before.values());
    const after = new Map(before);
    for (const id of deletes) {
      const access = before.get(id);
      if (actorRole !== 'owner' && access) {
        const note = noteId(access), policy = note ? notes.get(note) : undefined;
        if (access.address === 'lockKeys' || policy?.pinned || policy?.sealed) fail(403, 'Нельзя удалить защищённую сущность.');
      }
      after.delete(id);
    }
    for (const entity of upserts) {
      const access = entity.access;
      if (!access) fail(400, 'Для сущности обязательны метаданные доступа.');
      const policy = access!;
      const expected = createHash('sha256').update(JSON.stringify(['notes-entity-id', boardId, policy.address])).digest('base64url');
      if (entity.id !== expected) fail(400, 'Идентификатор сущности не соответствует адресу.');
      const note = noteId(policy), oldPolicy = note ? notes.get(note) : undefined;
      if (!note && (policy.pinned !== undefined || policy.sealed !== undefined)) fail(400, 'Флаги доступны только сущностям заметок.');
      if (actorRole !== 'owner') {
        if (policy.address === 'lockKeys') fail(403, 'Ключи блокировки меняет только владелец.');
        if (note) {
          if (flags(policy) !== (oldPolicy ? flags(oldPolicy) : 'false:false')) fail(403, 'Флаги защиты меняет только владелец.');
          if (oldPolicy?.pinned || (oldPolicy?.sealed && !policy.address.startsWith('note-layout:'))) fail(403, 'Заметка защищена от изменений.');
        }
      }
      after.set(entity.id, policy);
    }
    noteFlags(after.values());
  }
  // Keep the original schema's canonical field order (mutation hashes are
  // durable), but validate encrypted strings one entity per event-loop turn.
  const entityMetadata = entityWriteSchema.safeExtend({ envelope: z.custom<Envelope>(() => true) });
  const patchMetadata = deltaSchema.safeExtend({ upserts: z.array(entityMetadata).max(MAX_ENTITIES) });
  const snapshotMetadata = initialEntitiesSchema.safeExtend({ entities: z.array(entityMetadata).min(3).max(MAX_ENTITIES) });
  async function validateEnvelopes(entities: { envelope: unknown }[]) {
    let bytes = 0;
    for (const entity of entities) {
      await yieldToIO();
      entity.envelope = envelopeSchema.parse(entity.envelope);
      bytes += (entity.envelope as Envelope).ciphertext.length + 64;
      if (bytes > MAX_ENCRYPTED_BYTES) fail(413, 'Доска превышает допустимый размер.');
    }
  }
  async function mutationHash(value: unknown) {
    const hash = createHash('sha256'); let bytes = 0;
    for (const piece of jsonPieces(value)) {
      hash.update(piece); bytes += piece.length;
      if (bytes >= 64 * 1024) { await yieldToIO(); bytes = 0; }
    }
    return hash.digest('hex');
  }
  type Staged = { entries: Map<string, { file: string | null; serialized: string; bytes: number }>; used: Set<string>; cleanup: (committed?: boolean) => Promise<void> };
  let stagingBytes = 0;
  async function stageEntities(entities: EntityWrite[]): Promise<Staged> {
    const bytes = entities.reduce((sum, entity) => sum + entity.envelope.ciphertext.length + 128, 0);
    if (stagingBytes + bytes > MAX_ENCRYPTED_BYTES * 2) fail(429, 'Сервер занят загрузкой. Повторите попытку.');
    stagingBytes += bytes;
    const entries: Staged['entries'] = new Map(), used = new Set<string>();
    let cleaned = false;
    const cleanup = async (committed = false) => {
      if (cleaned) return;
      cleaned = true;
      try {
        for (const [id, entry] of entries) if (entry.file && (!committed || !used.has(id))) {
          await yieldToIO();
          try { files.remove(entry.file); } catch { console.error('Encrypted image cleanup deferred until restart.'); }
        }
      } finally { stagingBytes -= bytes; }
    };
    try {
      for (const entity of entities) {
        await yieldToIO();
        if (entity.storage === 'file') {
          const file = await files.writeAsync(entity.envelope);
          const bytes = JSON.stringify({ ...entity.envelope, ciphertext: '' }).length + entity.envelope.ciphertext.length;
          entries.set(entity.id, { file, serialized: '', bytes });
        } else {
          const serialized = JSON.stringify(entity.envelope);
          entries.set(entity.id, { file: null, serialized, bytes: serialized.length });
        }
      }
      return { entries, used, cleanup };
    } catch (error) { await cleanup(); throw error; }
  }
  function writeEntities(boardId: string, revision: number, previous: EntityRow[], upserts: EntityWrite[], deletes: string[], created: string[], retired: string[], staged?: Staged) {
    const old = new Map(previous.map(row => [row.entity_id, row]));
    for (const id of deletes) {
      if (old.get(id)?.file_name) retired.push(old.get(id)!.file_name!);
      db.prepare('DELETE FROM collaboration_entities WHERE board_id = ? AND entity_id = ?').run(boardId, id);
    }
    const put = db.prepare(`INSERT INTO collaboration_entities VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(board_id, entity_id) DO UPDATE SET revision=excluded.revision, envelope=excluded.envelope,
      access=excluded.access, byte_length=excluded.byte_length, file_name=excluded.file_name`);
    for (const entity of upserts) {
      const prepared = staged?.entries.get(entity.id);
      if (staged && !prepared) throw new Error('Missing staged entity.');
      const serialized = prepared?.serialized ?? JSON.stringify(entity.envelope);
      if (old.get(entity.id)?.file_name) retired.push(old.get(entity.id)!.file_name!);
      const file = prepared ? prepared.file : entity.storage === 'file' ? files.write(entity.envelope) : null;
      if (file && !staged) created.push(file);
      staged?.used.add(entity.id);
      put.run(boardId, entity.id, revision, file ? '' : serialized, JSON.stringify(entity.access), prepared?.bytes ?? serialized.length, file);
    }
    // Reserve framing space so a valid persisted board can always be downloaded.
    const size = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(byte_length), 0) AS bytes, COALESCE(SUM(byte_length + length(access) + length(entity_id) + 96), 0) AS transfer_bytes FROM collaboration_entities WHERE board_id = ?').get(boardId) as { count: number; bytes: number; transfer_bytes: number };
    if (size.count > MAX_ENTITIES || size.bytes > MAX_ENCRYPTED_BYTES || size.transfer_bytes > MAX_TRANSFER_BYTES - 16_384) fail(413, 'Доска превышает допустимый размер.');
  }
  async function loadSnapshot(uid: string, boardId: string, known?: CachedRevision[], cancelled?: () => boolean): Promise<Vault | DeltaVault> {
    const revisions = new Map(known?.map(item => [item.id, item.revision]));
    // Capture metadata synchronously; never hold SQLite over await. Only changed
    // files are retained/read. The fresh manifest and complete entity inventory
    // remain authoritative, including deletions and key-rotation revisions.
    const snapshot = transaction(() => {
      role(uid, boardId);
      const value = board(boardId), entities = rows(boardId);
      const release = files.retain(entities.flatMap(row => row.file_name && revisions.get(row.entity_id) !== row.revision ? [row.file_name] : []));
      return { value, entities, release };
    });
    try {
      const entities: DeltaVault['entities'] = [];
      let index = 0;
      for (const row of snapshot.entities) {
        const changed = revisions.get(row.entity_id) !== row.revision;
        // Cached metadata is cheap; still yield every 128 records. Changed data
        // yields per entity, with only one file read in flight per snapshot.
        if (changed || index++ % 128 === 0) {
          await yieldToIO();
          if (cancelled?.()) fail(499, 'Загрузка прервана.');
          role(uid, boardId);
        }
        const envelope = changed ? (row.file_name ? await files.readAsync(row.file_name) : JSON.parse(row.envelope)) : undefined;
        entities.push({ id: row.entity_id, revision: row.revision, ...(envelope ? { envelope } : {}), access: JSON.parse(row.access) });
      }
      role(uid, boardId);
      return { format: 2, accountId: boardId, revision: snapshot.value.revision, manifest: JSON.parse(snapshot.value.manifest), entities, ...(known ? { delta: true as const } : {}) } as Vault | DeltaVault;
    } finally { snapshot.release(); }
  }
  return {
    role,
    canDrag(uid: string, boardId: string, ids: string[]): void {
      identifier.parse(boardId);
      const targets = z.array(z.string().uuid()).max(10_000).parse(ids);
      // Read membership and all target policies from one consistent SQLite snapshot.
      transaction(() => {
        if (role(uid, boardId) === 'viewer') fail(403, 'Перемещение доступно только владельцу и редактору.');
        const lookup = db.prepare('SELECT access FROM collaboration_entities WHERE board_id = ? AND entity_id = ?');
        for (const id of new Set(targets)) {
          const address = `note-layout:${id}`;
          const entityId = createHash('sha256').update(JSON.stringify(['notes-entity-id', boardId, address])).digest('base64url');
          const row = lookup.get(boardId, entityId) as { access: string } | undefined;
          if (!row) fail(403, 'Заметка недоступна для перемещения.');
          const access = JSON.parse(row!.access) as Access;
          if (access.address !== address || access.pinned) fail(403, 'Закреплённую или недоступную заметку нельзя переместить.');
          // Sealed notes may move while unpinned; no content or positions are read.
        }
      });
    },
    onChange(listener: (change: CollaborationChange) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    fileReferences() { return (db.prepare('SELECT file_name FROM collaboration_entities WHERE file_name IS NOT NULL').all() as { file_name: string }[]).map(row => row.file_name); },
    publicReferences() { return (db.prepare('SELECT public_snapshot FROM collaboration_boards WHERE public_snapshot IS NOT NULL').all() as { public_snapshot: string }[]).map(row => row.public_snapshot).filter(name => publicFilePattern.test(name)); },
    identity,
    putIdentity(uid: string, input: AccountIdentity): AccountIdentity {
      const value = identitySchema.parse(input);
      return transaction(() => {
        const existing = identity(uid);
        if (existing) return existing;
        try {
          const key = createPublicKey({ key: Buffer.from(value.publicKey, 'base64url'), format: 'der', type: 'spki' });
          if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails?.modulusLength !== 3072) fail(400, 'Ожидается RSA-OAEP ключ 3072 бит.');
          if (key.export({ type: 'spki', format: 'der' }).toString('base64url') !== value.publicKey) fail(400, 'Неканонический публичный ключ.');
        } catch { fail(400, 'Некорректный RSA-OAEP ключ 3072 бит.'); }
        db.prepare('INSERT INTO collaboration_identities (uid, public_key, private_key) VALUES (?, ?, ?)').run(uid, value.publicKey, JSON.stringify(value.privateKey));
        return identity(uid)!;
      });
    },
    userKey(uid: string) {
      identifier.parse(uid);
      const value = identity(uid);
      if (!value) return fail(404, 'Публичный ключ пользователя не найден.');
      return { publicKey: value.publicKey };
    },
    list(uid: string): BoardEntry[] {
      return transaction(() => (db.prepare('SELECT board_id FROM collaboration_members WHERE uid = ? ORDER BY board_id').all(uid) as { board_id: string }[]).map(row => entry(uid, row.board_id)));
    },
    async create(uid: string, input: { id: string; name: Envelope; wrappedKey: string; snapshot: InitialEntities }): Promise<BoardEntry> {
      const value = z.object({ id: identifier, name: nameSchema, wrappedKey: wrappedKeySchema, snapshot: snapshotMetadata }).strict().parse(input) as typeof input;
      if (!identity(uid)) fail(409, 'Сначала создайте ключи пользователя.');
      await validateEnvelopes(value.snapshot.entities);
      const staged = await stageEntities(value.snapshot.entities);
      let committed = false;
      try {
      const result = transaction((created, retired) => {
        const existing = board(value.id);
        if (existing) {
          if (existing.owner_id !== uid) fail(409, 'Идентификатор доски уже занят.');
          db.prepare('UPDATE collaboration_identities SET initialized = 1 WHERE uid = ?').run(uid);
          return entry(uid, value.id);
        }
        const count = db.prepare('SELECT COUNT(*) AS count FROM collaboration_boards WHERE owner_id = ?').get(uid) as { count: number };
        if (count.count >= 3) fail(409, 'Можно создать не больше трёх досок.');
        if (!identity(uid)) fail(409, 'Сначала создайте ключи пользователя.');
        checkPolicy(value.id, 'owner', [], value.snapshot.entities, []);
        db.prepare('INSERT INTO collaboration_boards VALUES (?, ?, ?, 1, ?, NULL, NULL)').run(value.id, uid, JSON.stringify(value.name), JSON.stringify(value.snapshot.manifest));
        db.prepare('INSERT INTO collaboration_members (board_id, uid, role, wrapped_key, color) VALUES (?, ?, ?, ?, 0)').run(value.id, uid, 'owner', value.wrappedKey);
        writeEntities(value.id, 1, [], value.snapshot.entities, [], created, retired, staged);
        checkQuota(value.id);
        db.prepare('UPDATE collaboration_identities SET initialized = 1 WHERE uid = ?').run(uid);
        return entry(uid, value.id);
      });
      committed = true;
      notify({ event: 'boards.changed', boardId: value.id, uids: [uid] });
      return result;
      } finally { await staged.cleanup(committed); }
    },
    get(uid: string, boardId: string, cancelled?: () => boolean): Promise<Vault> { return loadSnapshot(uid, boardId, undefined, cancelled) as Promise<Vault>; },
    getCached(uid: string, boardId: string, known: CachedRevision[], cancelled?: () => boolean): Promise<DeltaVault> {
      return loadSnapshot(uid, boardId, known, cancelled) as Promise<DeltaVault>;
    },
    async patch(uid: string, boardId: string, input: DeltaWrite): Promise<{ revision: number }> {
      if (role(uid, boardId) === 'viewer') fail(403, 'Доска доступна только для чтения.');
      const patch = patchMetadata.parse(input) as DeltaWrite;
      if (patch.accountId !== boardId || patch.migrate) fail(400, 'Некорректная доска или режим миграции.');
      await validateEnvelopes(patch.upserts);
      const requestHash = await mutationHash(patch);
      const staged = await stageEntities(patch.upserts);
      let committed = false;
      let succeeded = false;
      try {
      const result = transaction((created, retired) => {
        const actorRole = role(uid, boardId);
        if (actorRole === 'viewer') fail(403, 'Доска доступна только для чтения.');
        const receipt = db.prepare('SELECT revision, request_hash FROM collaboration_mutations WHERE board_id = ? AND mutation_id = ?').get(boardId, patch.mutationId) as { revision: number; request_hash: string } | undefined;
        if (receipt) {
          if (receipt.request_hash !== requestHash) fail(409, 'Идентификатор изменения уже использован.');
          return { revision: receipt.revision };
        }
        const value = board(boardId);
        if (value.revision !== patch.revision) fail(409, 'Доска изменилась. Загрузите актуальную версию.');
        const previous = rows(boardId);
        checkPolicy(boardId, actorRole, previous, patch.upserts, patch.deletes);
        const revision = value.revision + 1;
        writeEntities(boardId, revision, previous, patch.upserts, patch.deletes, created, retired, staged);
        const updated = db.prepare('UPDATE collaboration_boards SET revision = ?, manifest = ? WHERE id = ? AND revision = ?').run(revision, JSON.stringify(patch.manifest), boardId, patch.revision);
        if (updated.changes !== 1) fail(409, 'Доска изменилась.');
        checkQuota(boardId);
        db.prepare('INSERT INTO collaboration_mutations VALUES (?, ?, ?, ?)').run(boardId, patch.mutationId, revision, requestHash);
        db.prepare('DELETE FROM collaboration_mutations WHERE board_id = ? AND revision < ?').run(boardId, revision - 256);
        committed = true;
        return { revision };
      });
      succeeded = true;
      if (committed) notify({ event: 'board.patch', boardId, data: { boardId, usedBytes: usage(boardId), revision: result.revision, manifest: patch.manifest, upserts: patch.upserts.map(entity => ({ ...entity, revision: result.revision })), deletes: patch.deletes } });
      return result;
      } finally { await staged.cleanup(succeeded); }
    },
    delete(uid: string, boardId: string) {
      identifier.parse(boardId);
      const uids = transaction((_created, retired, snapshots) => {
        owner(uid, boardId);
        const affected = memberIds(boardId);
        const references = db.prepare('SELECT file_name FROM collaboration_entities WHERE board_id = ? AND file_name IS NOT NULL').all(boardId) as { file_name: string }[];
        retired.push(...references.map(row => row.file_name));
        const snapshot = board(boardId).public_snapshot;
        if (snapshot && publicFilePattern.test(snapshot)) snapshots.retired.push(snapshot);
        db.prepare('DELETE FROM collaboration_boards WHERE id = ?').run(boardId);
        return affected;
      });
      notify({ event: 'board.access', boardId, uids });
      notify({ event: 'boards.changed', boardId, uids });
      return { ok: true };
    },
    rename(uid: string, boardId: string, name: Envelope, expectedKey?: string) {
      const value = nameSchema.parse(name);
      const uids = transaction(() => {
        owner(uid, boardId);
        const member = db.prepare('SELECT wrapped_key FROM collaboration_members WHERE board_id = ? AND uid = ?').get(boardId, uid) as { wrapped_key: string };
        if (expectedKey !== undefined && expectedKey !== member.wrapped_key) fail(409, 'Доска изменилась. Загрузите актуальную версию.');
        db.prepare('UPDATE collaboration_boards SET name = ? WHERE id = ?').run(JSON.stringify(value), boardId); checkQuota(boardId); return memberIds(boardId);
      });
      notify({ event: 'boards.changed', boardId, uids });
      return { ok: true };
    },
    invite(uid: string, boardId: string, target: string, memberRole: 'editor' | 'viewer', wrappedKey: string, proof?: Envelope, revision?: number, expectedKey?: string) {
      identifier.parse(target); z.enum(['editor', 'viewer']).parse(memberRole); wrappedKeySchema.parse(wrappedKey);
      if (proof) nameSchema.parse(proof);
      const uids = transaction(() => {
        owner(uid, boardId);
        if (revision !== undefined && board(boardId).revision !== revision) fail(409, 'Доска изменилась. Загрузите актуальную версию.');
        if (expectedKey !== undefined && entry(uid, boardId).wrappedKey !== expectedKey) fail(409, 'Доска изменилась. Загрузите актуальную версию.');
        if (target === uid) fail(400, 'Нельзя пригласить себя.');
        if (!identity(target)) fail(404, 'Пользователь ещё не создал ключи.');
        const existing = db.prepare('SELECT uid, color FROM collaboration_members WHERE board_id = ?').all(boardId) as { uid: string; color: number }[];
        const member = existing.find(item => item.uid === target);
        if (!member && existing.length >= 10) fail(409, 'На доске может быть не больше 10 участников, включая владельца.');
        const color = member?.color ?? Array.from({ length: 10 }, (_, index) => index).find(index => !existing.some(item => item.color === index))!;
        db.prepare(`INSERT INTO collaboration_members (board_id, uid, role, wrapped_key, color) VALUES (?, ?, ?, ?, ?) ON CONFLICT(board_id, uid)
          DO UPDATE SET role=excluded.role, wrapped_key=excluded.wrapped_key`).run(boardId, target, memberRole, wrappedKey, color);
        if (proof) db.prepare('INSERT INTO collaboration_verified_keys VALUES (?, ?, ?) ON CONFLICT(board_id, uid) DO UPDATE SET proof=excluded.proof').run(boardId, target, JSON.stringify(proof));
        return memberIds(boardId);
      });
      notify({ event: 'boards.changed', boardId, uids: [target] });
      notify({ event: 'board.access', boardId, uids });
      return { ok: true };
    },
    color(uid: string, boardId: string): number {
      return (db.prepare('SELECT color FROM collaboration_members WHERE board_id = ? AND uid = ?').get(boardId, uid) as { color: number } | undefined)?.color ?? 0;
    },
    members(uid: string, boardId: string): { uid: string; role: BoardRole; color: number; proof: Envelope | null }[] {
      return transaction(() => {
        owner(uid, boardId);
        const values = db.prepare('SELECT m.uid, m.role, m.color, k.proof FROM collaboration_members m LEFT JOIN collaboration_verified_keys k ON k.board_id = m.board_id AND k.uid = m.uid WHERE m.board_id = ? ORDER BY m.color').all(boardId) as { uid: string; role: BoardRole; color: number; proof: string | null }[];
        return values.map(value => ({ ...value, proof: value.proof ? JSON.parse(value.proof) : null }));
      });
    },
    async rotate(uid: string, boardId: string, input: unknown) {
      owner(uid, boardId);
      const value = z.object({ target: identifier, revision: z.number().int().min(1), mutationId: z.string().uuid(), expectedName: nameSchema, name: nameSchema, snapshot: snapshotMetadata, members: z.array(z.object({ uid: identifier, wrappedKey: wrappedKeySchema }).strict()).min(1).max(10) }).strict().parse(input);
      if (new Set(value.members.map(member => member.uid)).size !== value.members.length) fail(400, 'Некорректный формат данных.');
      await validateEnvelopes(value.snapshot.entities);
      const requestHash = await mutationHash(value);
      const staged = await stageEntities(value.snapshot.entities);
      let committed = false;
      let affected: string[] = [];
      try {
      const result = transaction((created, retired) => {
        owner(uid, boardId);
        const receipt = db.prepare('SELECT revision, request_hash FROM collaboration_mutations WHERE board_id = ? AND mutation_id = ?').get(boardId, value.mutationId) as { revision: number; request_hash: string } | undefined;
        if (receipt) { if (receipt.request_hash !== requestHash) fail(409, 'Идентификатор изменения уже использован.'); return { revision: receipt.revision }; }
        if (value.target === uid) fail(400, 'Нельзя удалить владельца.');
        const existing = memberIds(boardId);
        if (!existing.includes(value.target)) fail(404, 'Нет доступа к доске.');
        const expected = existing.filter(id => id !== value.target).sort();
        if (JSON.stringify(expected) !== JSON.stringify(value.members.map(member => member.uid).sort()) || board(boardId).revision !== value.revision || board(boardId).name !== JSON.stringify(value.expectedName)) fail(409, 'Доска изменилась. Загрузите актуальную версию.');
        const previous = rows(boardId), nextIds = new Set(value.snapshot.entities.map(entity => entity.id));
        const deletes = previous.filter(row => !nextIds.has(row.entity_id)).map(row => row.entity_id);
        checkPolicy(boardId, 'owner', previous, value.snapshot.entities, deletes);
        const revision = value.revision + 1;
        writeEntities(boardId, revision, previous, value.snapshot.entities, deletes, created, retired, staged);
        db.prepare('UPDATE collaboration_boards SET revision = ?, name = ?, manifest = ? WHERE id = ?').run(revision, JSON.stringify(value.name), JSON.stringify(value.snapshot.manifest), boardId);
        for (const member of value.members) db.prepare('UPDATE collaboration_members SET wrapped_key = ? WHERE board_id = ? AND uid = ?').run(member.wrappedKey, boardId, member.uid);
        db.prepare('DELETE FROM collaboration_verified_keys WHERE board_id = ? AND uid = ?').run(boardId, value.target);
        db.prepare('DELETE FROM collaboration_members WHERE board_id = ? AND uid = ?').run(boardId, value.target);
        checkQuota(boardId);
        db.prepare('INSERT INTO collaboration_mutations VALUES (?, ?, ?, ?)').run(boardId, value.mutationId, revision, requestHash);
        affected = existing;
        return { revision };
      });
      committed = true;
      if (affected.length) { notify({ event: 'board.access', boardId, uids: affected }); notify({ event: 'boards.changed', boardId, uids: affected }); }
      return result;
      } finally { await staged.cleanup(committed); }
    },
    removeMember(uid: string, boardId: string, target: string) {
      identifier.parse(target);
      const uids = transaction(() => {
        owner(uid, boardId);
        if (target === uid) fail(400, 'Нельзя удалить владельца.');
        const affected = memberIds(boardId);
        db.prepare('DELETE FROM collaboration_members WHERE board_id = ? AND uid = ?').run(boardId, target);
        return affected;
      });
      notify({ event: 'board.access', boardId, uids });
      notify({ event: 'boards.changed', boardId, uids: [target] });
      return { ok: true };
    },
    public(uid: string, boardId: string, input: PublicSnapshot | null) {
      const snapshot = input === null ? null : publicSnapshotSchema.parse(input);
      if (snapshot) {
        const ids = new Set(snapshot.lockedIds);
        const notes = new Map(snapshot.board.notes.map(note => [note.id, note]));
        if (ids.size !== snapshot.lockedIds.length || [...ids].some(id => {
          const note = notes.get(id);
          return !note || note.text !== '' || note.image !== undefined || note.sealed !== undefined;
        })) fail(400, 'Публичная копия содержит некорректные защищённые заметки.');
      }
      const serialized = snapshot === null ? null : JSON.stringify(snapshot);
      if (serialized && Buffer.byteLength(serialized) > MAX_BOARD_BYTES) fail(413, 'Публичная копия превышает допустимый размер.');
      const result = transaction((_created, _retired, snapshots) => {
        owner(uid, boardId);
        const previous = board(boardId);
        const previousBytes = previous.public_snapshot ? (publicFilePattern.test(previous.public_snapshot) ? files.snapshotBytes(previous.public_snapshot) : Buffer.byteLength(previous.public_snapshot)) : 0;
        if (snapshot !== null && usage(boardId) - previousBytes + Buffer.byteLength(serialized!) > limitBytes) fail(413, limitMessage);
        const token = snapshot === null ? null : previous.public_token ?? randomBytes(32).toString('base64url');
        const reference = snapshot === null ? null : files.writeSnapshot(snapshot);
        if (reference) snapshots.created.push(reference);
        if (previous.public_snapshot && publicFilePattern.test(previous.public_snapshot)) snapshots.retired.push(previous.public_snapshot);
        db.prepare('UPDATE collaboration_boards SET public_token = ?, public_snapshot = ? WHERE id = ?').run(token, reference, boardId);
        return { token };
      });
      notify({ event: 'boards.changed', boardId, uids: [uid] });
      return result;
    },
    publicGet(token: string): PublicSnapshot {
      identifier.parse(token);
      // Keep the reference alive across file reads, including writers in other processes.
      return transaction(() => {
        const row = db.prepare('SELECT public_snapshot FROM collaboration_boards WHERE public_token = ? AND public_snapshot IS NOT NULL').get(token) as { public_snapshot: string } | undefined;
        if (!row) return fail(404, 'Публичная копия не найдена.');
        if (publicFilePattern.test(row.public_snapshot)) return files.readSnapshot(row.public_snapshot);
        // Read-only compatibility with old inline developer snapshots; new writes are files.
        return publicSnapshotSchema.parse(JSON.parse(row.public_snapshot));
      });
    },
  };
}
export type CollaborationStore = ReturnType<typeof createCollaborationStore>;
