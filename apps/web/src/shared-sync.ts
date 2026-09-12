import { type BoardData, type BoardRole, type DeltaWrite, type EntityVault, type NoteData } from '@quiet/shared';
import { decodeVault, prepareDelta, type EntityIndex } from './entities';
import { encryptBoard } from './crypto';
import { ApiError } from './api';
import { BoardSocket } from './socket';

function equal(a: any, b: any): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const keys = Object.keys(a); return keys.length === Object.keys(b).length && keys.every(key => equal(a[key], b[key]));
}
function mergeRows<T extends { id: string }>(base: T[], local: T[], remote: T[]): T[] {
  const before = new Map(base.map(item => [item.id, item])), mine = new Map(local.map(item => [item.id, item]));
  const remoteIds = new Set(remote.map(item => item.id));
  const result: T[] = [];
  for (const item of remote) {
    const old = before.get(item.id), changed = mine.get(item.id);
    if (old && !changed) continue;
    if (!old || !changed) { result.push(item); continue; }
    const next = { ...item };
    for (const field of Object.keys(changed) as (keyof T)[]) if (!equal(changed[field], old[field])) next[field] = changed[field];
    for (const field of Object.keys(old) as (keyof T)[]) if (!(field in changed)) delete next[field];
    result.push(next);
  }
  for (const item of local) if (!before.has(item.id) && !remoteIds.has(item.id)) result.push(item);
  return result;
}
function merge(base: BoardData, local: BoardData, remote: BoardData, role: BoardRole): BoardData {
  const notes = mergeRows(base.notes, local.notes, remote.notes);
  if (role === 'editor') {
    const before = new Map(base.notes.map(note => [note.id, note])), positions = new Map(notes.map((note, index) => [note.id, index]));
    for (const other of remote.notes) {
      const old = before.get(other.id);
      if (other.pinned || other.sealed && !old?.sealed) {
        const index = positions.get(other.id);
        if (index === undefined) notes.push(other); else notes[index] = other;
      }
    }
  }
  const ids = new Set(notes.map(n => n.id));
  const groups = mergeRows(base.groups, local.groups, remote.groups).map(g => ({ ...g, noteIds: g.noteIds.filter(id => ids.has(id)) })).filter(g => g.noteIds.length);
  const used = new Set<string>();
  for (const group of groups) group.noteIds = group.noteIds.filter(id => { if (used.has(id)) return false; used.add(id); return true; });
  const validGroups = groups.filter(g => g.noteIds.length); for (const group of validGroups) ids.add(group.id);
  return { ...remote, camera: local.camera, notes, groups: validGroups, connections: mergeRows(base.connections, local.connections, remote.connections).filter(e => ids.has(e.source) && ids.has(e.target)), lockKeys: equal(base.lockKeys, local.lockKeys) ? remote.lockKeys : local.lockKeys };
}
export class SharedSync {
  private base: BoardData;
  private current: BoardData;
  private index: EntityIndex;
  private vault: EntityVault;
  private chain = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private edited = false;
  private unsubscribe: (() => void)[] = [];
  private pending?: { patch: DeltaWrite; board: BoardData; index: EntityIndex };
  state: 'saved' | 'saving' | 'error' = 'saved';
  constructor(private socket: BoardSocket, private key: CryptoKey, vault: EntityVault, board: BoardData, index: EntityIndex, public role: BoardRole, private changed: (board: BoardData) => void, private notify: (message: string) => void) {
    this.vault = vault; this.base = this.current = board; this.index = index;
    this.unsubscribe.push(socket.on('board.patch', data => this.receive(data)), socket.on('connected', () => { void this.run(async () => { await socket.request('boards.watch', { boardId: this.vault.accountId }); await this.resync(); await this.save(); }); }), socket.on('disconnected', () => this.notify('Нет связи. Изменения остаются в этой вкладке.')));
  }
  receive(data: any) {
    if (data.boardId !== this.vault.accountId) return;
    void this.run(async () => {
      if (data.revision <= this.vault.revision) return;
      if (data.revision !== this.vault.revision + 1) await this.resync();
      else await this.accept(this.apply(data));
      await this.save();
    });
  }
  get board() { return this.current; }
  get dirty() { return Boolean(this.pending) || this.edited; }
  update(board: BoardData) {
    const changed = board.notes !== this.current.notes || board.connections !== this.current.connections || board.groups !== this.current.groups || board.lockKeys !== this.current.lockKeys;
    this.current = this.role === 'viewer' ? { ...this.current, camera: board.camera } : board;
    if (!changed || this.role === 'viewer') return;
    this.edited = true;
    clearTimeout(this.timer); this.timer = setTimeout(() => { void this.run(() => this.save()); }, 180);
  }
  private async run(work: () => Promise<void>) {
    this.chain = this.chain.then(async () => { if (!this.stopped) await work(); }).catch(error => { if (!this.stopped) { this.state = 'error'; this.notify(error instanceof Error ? error.message : 'Не удалось сохранить доску.'); } });
    await this.chain;
  }
  private apply(patch: { revision: number; manifest: EntityVault['manifest']; upserts: any[]; deletes: string[] }): EntityVault {
    const entries = new Map(this.vault.entities.map(e => [e.id, e]));
    for (const id of patch.deletes) entries.delete(id);
    for (const entity of patch.upserts) entries.set(entity.id, { id: entity.id, envelope: entity.envelope, access: entity.access, revision: patch.revision });
    return { ...this.vault, revision: patch.revision, manifest: patch.manifest, entities: [...entries.values()] };
  }
  private async accept(vault: EntityVault) {
    const decoded = await decodeVault(this.key, vault, { board: this.base, index: this.index, vault: this.vault });
    const next = this.role === 'viewer' ? { ...decoded.board, camera: this.current.camera } : merge(this.base, this.current, decoded.board, this.role);
    this.vault = vault; this.index = decoded.index!; this.base = decoded.board; this.current = next; this.changed(next);
    this.edited = !equal({ ...this.base, camera: null }, { ...next, camera: null });
  }
  private async resync() { await this.accept(await this.socket.request<EntityVault>('boards.get', { boardId: this.vault.accountId })); }
  private async save() {
    if (this.stopped || this.role === 'viewer') return;
    let conflicts = 0;
    while (this.dirty && !this.stopped) {
      this.state = 'saving';
      if (!this.pending) {
        const board = { ...this.current, camera: this.base.camera };
        const prepared = await prepareDelta(this.key, this.vault.accountId, this.vault.revision, board, this.index, true, this.base);
        if (!prepared) { this.edited = false; break; }
        this.pending = { ...prepared, board };
      }
      const pending = this.pending;
      try {
        const result = await this.socket.request<{ revision: number }>('boards.patch', { boardId: this.vault.accountId, patch: pending.patch });
        if (result.revision !== pending.patch.revision + 1) throw new Error('Некорректная версия доски.');
        // Own delta may already have been included in a reconnect snapshot.
        if (result.revision > this.vault.revision) {
          this.vault = this.apply({ ...pending.patch, revision: result.revision }); this.index = pending.index; this.base = pending.board;
        }
        this.pending = undefined;
        this.edited = !equal({ ...this.base, camera: null }, { ...this.current, camera: null });
      } catch (error) {
        if (error instanceof ApiError && error.status === 409 && ++conflicts <= 5) { this.pending = undefined; await this.resync(); continue; }
        throw error;
      }
    }
    this.state = 'saved'; this.notify('');
  }
  async flush() { clearTimeout(this.timer); await this.run(() => this.save()); return !this.dirty && this.state !== 'error'; }
  async reload() { await this.run(() => this.resync()); return this.current; }
  async setRole(role: BoardRole) {
    this.role = role;
    if (role === 'viewer') { this.pending = undefined; this.edited = false; }
    await this.reload();
  }
  forgetNote(id: string, sealed: NoteData) {
    for (const snapshot of [this.base, this.current, this.pending?.board]) {
      const note = snapshot?.notes.find(n => n.id === id);
      if (note) { note.text = ''; delete note.image; note.sealed = sealed.sealed; }
    }
    // The sanitized baseline no longer represents its old ciphertext. Force the
    // sealed content to be encrypted and uploaded instead of reusing that cache.
    for (const entity of this.vault.entities) if (entity.access?.address.startsWith('note-') && entity.access.address.endsWith(`:${id}`)) this.index.delete(entity.id);
    this.pending = undefined;
  }
  async backup() { return { format: 'quiet-backup', accountId: this.vault.accountId, revision: this.vault.revision + 1, envelope: await encryptBoard(this.key, this.vault.accountId, this.vault.revision + 1, this.current) }; }
  dispose() { this.stopped = true; clearTimeout(this.timer); for (const off of this.unsubscribe) off(); }
}
