import { MAX_ENCRYPTED_BYTES, type CachedRevision, type DeltaVault, type EntityVault, type Envelope } from '@quiet/shared';

// A disposable, single-board ciphertext cache. No keys, titles, decrypted notes,
// access policies or manifests are persisted. A generation fences other tabs and
// interrupted writes; only complete generations may advertise revisions.
type Header = { boardId: string; generation: string; complete: boolean; revisions: CachedRevision[] };
type Record = { id: string; revision: number; envelope: Envelope };
export class CiphertextCacheMiss extends Error {}
const request = <T>(value: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error);
});
const completed = (tx: IDBTransaction): Promise<void> => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('Cache transaction failed.'));
});

export class EncryptedBoardCache {
  private database?: Promise<IDBDatabase | undefined>;
  private saving = Promise.resolve();
  private db() {
    return this.database ??= new Promise<IDBDatabase | undefined>(resolve => {
      if (typeof indexedDB === 'undefined') { resolve(undefined); return; }
      let settled = false;
      const finish = (db?: IDBDatabase) => { if (settled) { db?.close(); return; } settled = true; clearTimeout(timeout); resolve(db); };
      const timeout = setTimeout(() => finish(), 1000);
      try {
        const open = indexedDB.open('quiet-encrypted-board-cache-v1', 1);
        open.onupgradeneeded = () => { open.result.createObjectStore('header'); open.result.createObjectStore('entities', { keyPath: 'id' }); };
        open.onsuccess = () => { open.result.onversionchange = () => open.result.close(); finish(open.result); };
        open.onerror = open.onblocked = () => finish();
      } catch { finish(); }
    });
  }
  async hints(boardId: string): Promise<CachedRevision[]> {
    try {
      const db = await this.db(); if (!db) return [];
      const header = await request<Header | undefined>(db.transaction('header').objectStore('header').get(0));
      return header?.boardId === boardId && header.complete ? header.revisions : [];
    } catch { return []; }
  }
  async hydrate(delta: DeltaVault): Promise<EntityVault> {
    const db = await this.db();
    // Materialize into a separate array; never mutate an object already observed
    // by listeners or a generation currently being persisted.
    const entities: EntityVault['entities'] = [];
    for (let offset = 0; offset < delta.entities.length; offset += 16) {
      const batch = delta.entities.slice(offset, offset + 16);
      const missing = batch.filter(entity => !entity.envelope);
      const cached = new Map<string, Record>();
      if (missing.length) {
        if (!db) throw new CiphertextCacheMiss();
        // State and records come from the same IDB read transaction. Generation
        // replacement between batches is safe because every revision is checked.
        const tx = db.transaction(['header', 'entities']);
        const headerRead = request<Header | undefined>(tx.objectStore('header').get(0));
        const records = missing.map(entity => request<Record | undefined>(tx.objectStore('entities').get(entity.id)));
        const [header, values] = await Promise.all([headerRead, Promise.all(records)]);
        if (header?.boardId !== delta.accountId || !header.complete) throw new CiphertextCacheMiss();
        for (const record of values) if (record) cached.set(record.id, record);
      }
      for (const entity of batch) {
        const record = cached.get(entity.id);
        const envelope = entity.envelope ?? (record?.revision === entity.revision ? record.envelope : undefined);
        if (!envelope) throw new CiphertextCacheMiss();
        entities.push({ ...entity, envelope });
      }
    }
    return { format: 2, accountId: delta.accountId, revision: delta.revision, manifest: delta.manifest, entities };
  }
  save(vault: EntityVault): void {
    // One queued save per instance. This only retains the latest snapshot while
    // IDB is busy, rather than accumulating every intervening large response.
    this.latest = vault;
    if (this.writing) return;
    this.writing = true;
    this.saving = (async () => {
      while (this.latest) {
        const value = this.latest; this.latest = undefined;
        try { await this.persist(value); } catch { /* cache is optional */ }
      }
    })().finally(() => { this.writing = false; });
  }
  private latest?: EntityVault;
  private writing = false;
  async flush() { await this.saving; }
  async clear(boardId: string) {
    if (this.latest?.accountId === boardId) this.latest = undefined;
    try {
      const db = await this.db(); if (!db) return;
      const tx = db.transaction(['header', 'entities'], 'readwrite'), done = completed(tx);
      const header = tx.objectStore('header').get(0);
      header.onsuccess = () => {
        if ((header.result as Header | undefined)?.boardId === boardId) { tx.objectStore('entities').clear(); tx.objectStore('header').clear(); }
      };
      await done;
    } catch { /* unavailable cache */ }
  }
  private async persist(vault: EntityVault) {
    const db = await this.db(); if (!db) return;
    // Bound persistent ciphertext, independently of browser quota. One complete
    // board fits; oversized snapshots simply operate without a cache.
    let bytes = 0;
    for (const entity of vault.entities) { bytes += entity.envelope.ciphertext.length + entity.id.length + 128; if (bytes > MAX_ENCRYPTED_BYTES) return; }
    const generation = crypto.randomUUID();
    const header: Header = { boardId: vault.accountId, generation, complete: false, revisions: [] };
    {
      const tx = db.transaction(['header', 'entities'], 'readwrite'), done = completed(tx);
      tx.objectStore('entities').clear(); tx.objectStore('header').put(header, 0);
      await done;
    }
    // Batches cap both structured-clone work and transaction size. Another tab
    // can replace this generation; then this writer stops without touching it.
    for (let offset = 0; offset < vault.entities.length;) {
      const batch: Record[] = []; let batchBytes = 0;
      while (offset < vault.entities.length && batch.length < 128 && batchBytes < 2 * 1024 * 1024) {
        const entity = vault.entities[offset++]!;
        batch.push({ id: entity.id, revision: entity.revision, envelope: entity.envelope });
        batchBytes += entity.envelope.ciphertext.length;
      }
      const tx = db.transaction(['header', 'entities'], 'readwrite'), done = completed(tx);
      const state = tx.objectStore('header').get(0); let current = false;
      state.onsuccess = () => {
        current = state.result?.generation === generation;
        if (current) for (const entity of batch) tx.objectStore('entities').put(entity);
      };
      await done;
      if (!current) return;
    }
    const tx = db.transaction('header', 'readwrite'), done = completed(tx);
    const state = tx.objectStore('header').get(0);
    state.onsuccess = () => {
      if (state.result?.generation === generation) tx.objectStore('header').put({ ...header, complete: true, revisions: vault.entities.map(({ id, revision }) => ({ id, revision })) }, 0);
    };
    await done;
  }
}
