import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { imageFiles } from './image-files.js';
import type { WebAuthnCredential } from '@simplewebauthn/server';
import { MAX_ENCRYPTED_BYTES, MAX_ENTITIES, type Envelope, type DeltaWrite, type InitialEntities, type Vault, type EntityWrite } from '@quiet/shared';

export class StorageLimitError extends Error {}

export type Account = {
  id: string; credential_id: string; public_key: Uint8Array; counter: number;
  transports: string; revision: number; envelope: string;
};
export type Ceremony = {
  kind: 'register' | 'activate' | 'login' | 'unlock'; challenge: string; accountId?: string;
  credential?: Omit<WebAuthnCredential, 'publicKey'> & { publicKey: string };
};

export function openStore(path: string, imagesPath = process.env.IMAGES_PATH ?? `${path}.images`) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY, credential_id TEXT UNIQUE NOT NULL,
      public_key BLOB NOT NULL, counter INTEGER NOT NULL, transports TEXT NOT NULL,
      revision INTEGER NOT NULL, envelope TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS ceremonies (
      token_hash TEXT PRIMARY KEY, payload TEXT NOT NULL, expires INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS key_credentials (
      account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      auth_hash TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      expires INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS session_expiry ON sessions(expires);
    CREATE INDEX IF NOT EXISTS ceremony_expiry ON ceremonies(expires);
    CREATE TABLE IF NOT EXISTS entity_boards (
      account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      manifest TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS board_entities (
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      entity_id TEXT NOT NULL, revision INTEGER NOT NULL, envelope TEXT NOT NULL,
      byte_length INTEGER NOT NULL,
      PRIMARY KEY (account_id, entity_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS board_mutations (
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      mutation_id TEXT NOT NULL, revision INTEGER NOT NULL, request_hash TEXT NOT NULL,
      PRIMARY KEY (account_id, mutation_id)
    ) STRICT;
  `);
  if (!(db.prepare('PRAGMA table_info(board_entities)').all() as { name: string }[]).some(column => column.name === 'file_name')) {
    db.exec('ALTER TABLE board_entities ADD COLUMN file_name TEXT');
  }
  const files = imageFiles(imagesPath);
  // Serialize recovery with writers, including other processes sharing this DB.
  db.exec('BEGIN IMMEDIATE');
  try {
    const references = db.prepare('SELECT file_name FROM board_entities WHERE file_name IS NOT NULL').all() as { file_name: string }[];
    files.sweep(new Set(references.map(row => row.file_name)));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  let createdFiles: string[] = [], obsoleteFiles: string[] = [];
  function removeFiles(names: string[]) {
    for (const name of names) {
      try { files.remove(name); } catch { console.error('Encrypted image cleanup deferred until restart.'); }
    }
  }
  function beginWrite() { db.exec('BEGIN IMMEDIATE'); createdFiles = []; obsoleteFiles = []; }
  function commitWrite() { db.exec('COMMIT'); removeFiles(obsoleteFiles); createdFiles = []; obsoleteFiles = []; }
  function rollbackWrite() { db.exec('ROLLBACK'); removeFiles(createdFiles); createdFiles = []; obsoleteFiles = []; }
  function retireFile(id: string, entityId: string) {
    const old = db.prepare('SELECT file_name FROM board_entities WHERE account_id = ? AND entity_id = ?').get(id, entityId) as { file_name: string | null } | undefined;
    if (old?.file_name) obsoleteFiles.push(old.file_name);
  }
  function putEntities(id: string, revision: number, entities: EntityWrite[]) {
    const upsert = db.prepare('INSERT INTO board_entities (account_id, entity_id, revision, envelope, byte_length, file_name) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (account_id, entity_id) DO UPDATE SET revision = excluded.revision, envelope = excluded.envelope, byte_length = excluded.byte_length, file_name = excluded.file_name');
    for (const entity of entities) {
      const envelope = JSON.stringify(entity.envelope);
      retireFile(id, entity.id);
      const file = entity.storage === 'file' ? files.write(entity.envelope) : null;
      if (file) createdFiles.push(file);
      upsert.run(id, entity.id, revision, file ? '' : envelope, envelope.length, file);
    }
    const size = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(byte_length), 0) AS bytes FROM board_entities WHERE account_id = ?').get(id) as { count: number; bytes: number };
    if (size.count > MAX_ENTITIES || size.bytes > MAX_ENCRYPTED_BYTES) throw new StorageLimitError('Доска превышает допустимый размер.');
  }
  return {
    db,
    cleanup(now: number) {
      db.prepare('DELETE FROM ceremonies WHERE expires <= ?').run(now);
      db.prepare('DELETE FROM sessions WHERE expires <= ?').run(now);
    },
    putCeremony(hash: string, payload: Ceremony, expires: number) {
      db.prepare('INSERT INTO ceremonies VALUES (?, ?, ?)').run(hash, JSON.stringify(payload), expires);
    },
    takeCeremony(hash: string, now: number): Ceremony | undefined {
      const row = db.prepare('DELETE FROM ceremonies WHERE token_hash = ? RETURNING payload, expires').get(hash) as { payload: string; expires: number } | undefined;
      return row && row.expires > now ? JSON.parse(row.payload) : undefined;
    },
    accountByCredential(id: string) {
      return db.prepare('SELECT * FROM accounts WHERE credential_id = ?').get(id) as Account | undefined;
    },
    keyAuthHash(id: string) {
      return (db.prepare('SELECT auth_hash FROM key_credentials WHERE account_id = ?').get(id) as { auth_hash: string } | undefined)?.auth_hash;
    },
    accountBySession(hash: string, now: number) {
      return db.prepare('SELECT a.* FROM accounts a JOIN sessions s ON a.id = s.account_id WHERE s.token_hash = ? AND s.expires > ?').get(hash, now) as Account | undefined;
    },
    createAccount(id: string, credential: WebAuthnCredential, envelope: Envelope) {
      db.prepare('INSERT INTO accounts VALUES (?, ?, ?, ?, ?, 1, ?)').run(id, credential.id, credential.publicKey, credential.counter, JSON.stringify(credential.transports ?? []), JSON.stringify(envelope));
    },
    createEntityAccount(id: string, credential: WebAuthnCredential, initial: InitialEntities, keyAuthHash?: string) {
      beginWrite();
      try {
        db.prepare('INSERT INTO accounts VALUES (?, ?, ?, ?, ?, 1, ?)').run(id, credential.id, credential.publicKey, credential.counter, JSON.stringify(credential.transports ?? []), '');
        putEntities(id, 1, initial.entities);
        db.prepare('INSERT INTO entity_boards VALUES (?, ?)').run(id, JSON.stringify(initial.manifest));
        if (keyAuthHash) db.prepare('INSERT INTO key_credentials VALUES (?, ?)').run(id, keyAuthHash);
        commitWrite();
      } catch (error) { rollbackWrite(); throw error; }
    },
    advanceCounter(id: string, oldCounter: number, counter: number) {
      return db.prepare('UPDATE accounts SET counter = ? WHERE id = ? AND counter = ?').run(counter, id, oldCounter).changes === 1;
    },
    save(id: string, revision: number, envelope: Envelope) {
      // An older open tab must never overwrite the migrated entity store.
      return db.prepare("UPDATE accounts SET revision = revision + 1, envelope = ? WHERE id = ? AND revision = ? AND envelope != ''").run(JSON.stringify(envelope), id, revision).changes === 1;
    },
    readVault(id: string): Vault {
      // Keep file references alive until the snapshot has been read.
      db.exec('BEGIN IMMEDIATE');
      try {
        const row = db.prepare('SELECT a.revision, a.envelope, b.manifest FROM accounts a LEFT JOIN entity_boards b ON b.account_id = a.id WHERE a.id = ?').get(id) as { revision: number; envelope: string; manifest: string | null };
        let vault: Vault;
        if (row.manifest === null) vault = { accountId: id, revision: row.revision, envelope: JSON.parse(row.envelope) };
        else {
          const rows = db.prepare('SELECT entity_id, revision, envelope, file_name FROM board_entities WHERE account_id = ?').all(id) as { entity_id: string; revision: number; envelope: string; file_name: string | null }[];
          vault = { format: 2, accountId: id, revision: row.revision, manifest: JSON.parse(row.manifest), entities: rows.map(entity => ({ id: entity.entity_id, revision: entity.revision, envelope: entity.file_name ? files.read(entity.file_name) : JSON.parse(entity.envelope) })) };
        }
        db.exec('COMMIT'); return vault;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    patch(id: string, patch: DeltaWrite, requestHash: string): { revision: number } | null {
      beginWrite();
      try {
        const receipt = db.prepare('SELECT revision, request_hash FROM board_mutations WHERE account_id = ? AND mutation_id = ?').get(id, patch.mutationId) as { revision: number; request_hash: string } | undefined;
        if (receipt) {
          rollbackWrite();
          return receipt.request_hash === requestHash ? { revision: receipt.revision } : null;
        }
        const row = db.prepare('SELECT revision FROM accounts WHERE id = ?').get(id) as { revision: number };
        const migrated = Boolean(db.prepare('SELECT 1 FROM entity_boards WHERE account_id = ?').get(id));
        if (row.revision !== patch.revision || migrated === patch.migrate || (!migrated && patch.deletes.length)) { rollbackWrite(); return null; }
        const revision = row.revision + 1;
        const remove = db.prepare('DELETE FROM board_entities WHERE account_id = ? AND entity_id = ?');
        for (const entityId of patch.deletes) { retireFile(id, entityId); remove.run(id, entityId); }
        putEntities(id, revision, patch.upserts);
        db.prepare('INSERT INTO entity_boards VALUES (?, ?) ON CONFLICT (account_id) DO UPDATE SET manifest = excluded.manifest').run(id, JSON.stringify(patch.manifest));
        db.prepare("UPDATE accounts SET revision = ?, envelope = '' WHERE id = ?").run(revision, id);
        db.prepare('INSERT INTO board_mutations VALUES (?, ?, ?, ?)').run(id, patch.mutationId, revision, requestHash);
        db.prepare('DELETE FROM board_mutations WHERE account_id = ? AND revision < ?').run(id, revision - 256);
        commitWrite(); return { revision };
      } catch (error) { rollbackWrite(); throw error; }
    },
    putSession(hash: string, id: string, expires: number) {
      db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(hash, id, expires);
    },
    extendSession(hash: string, id: string, now: number, expires: number) {
      return db.prepare('UPDATE sessions SET expires = MAX(expires, ?) WHERE token_hash = ? AND account_id = ? AND expires > ?').run(expires, hash, id, now).changes === 1;
    },
    deleteSession(hash: string) { db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash); },
    close() { db.close(); },
  };
}
export type Store = ReturnType<typeof openStore>;
