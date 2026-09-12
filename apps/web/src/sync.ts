import { type BoardData, type NoteData, type DeltaWrite, type Vault } from '@quiet/shared';
import { api, ApiError } from './api';
import { encryptBoard } from './crypto';
import { decodeVault, prepareDelta, type EntityIndex } from './entities';
import type { Unlocked } from './passkey';

export type SyncState = 'saved' | 'pending' | 'saving' | 'error' | 'conflict';
type Notify = (state: SyncState, message?: string) => void;
export type Transport = <T>(path: string, data?: unknown, method?: string) => Promise<T>;
// Serialized saves; edits during encryption/network requests remain queued.
export class BoardSync {
  private current: BoardData;
  private saved: BoardData;
  private revision: number;
  private timer?: ReturnType<typeof setTimeout>;
  private active?: Promise<boolean>;
  private disposed = false;
  private blocked = false;
  private uncertain?: { patch: DeltaWrite; index: EntityIndex; board: BoardData };
  private index: EntityIndex | null;
  private needsScan = true;
  private unlocked: Pick<Unlocked, 'accountId' | 'key'>;
  state: SyncState = 'saved';
  constructor(unlocked: Unlocked, private notify: Notify, private request: Transport = api) {
    this.unlocked = { accountId: unlocked.accountId, key: unlocked.key };
    this.current = this.saved = unlocked.board;
    this.revision = unlocked.revision;
    this.index = unlocked.entityIndex ?? null;
    // Migrate legacy ciphertext only after client decryption. A fresh board is
    // already entity-based, so this initial scan normally sends nothing.
    queueMicrotask(() => { if (!this.disposed) void this.flush(); });
  }
  get dirty() { return this.needsScan || this.current !== this.saved; }
  get board() { return this.current; }
  // Call after the save queue settles. Purge plaintext from retained snapshots,
  // not only from the visible component. JS strings themselves are GC-managed.
  forgetNote(id: string, sealed: NoteData) {
    for (const snapshot of [this.current, this.saved, this.uncertain?.board]) {
      const note = snapshot?.notes.find(n => n.id === id);
      if (note) { note.title = sealed.title; note.text = ''; delete note.image; note.sealed = sealed.sealed; }
    }
    this.uncertain = undefined;
  }
  private emit(state: SyncState, message?: string) {
    this.state = state;
    if (!this.disposed) this.notify(state, message);
  }
  update(board: BoardData) {
    this.current = board;
    if (this.blocked || this.disposed) return;
    clearTimeout(this.timer);
    if (!this.active) this.emit('pending');
    this.timer = setTimeout(() => void this.flush(), 650);
  }
  async flush(): Promise<boolean> {
    clearTimeout(this.timer);
    if (this.disposed || this.blocked) return false;
    if (this.active) return this.active;
    this.active = this.saveLoop();
    try { return await this.active; }
    finally { this.active = undefined; }
  }
  private async saveLoop() {
    try {
      // Retry the identical mutation, without downloading the board to discover
      // whether a lost response had committed. The server keeps atomic receipts.
      if (this.uncertain) await this.sendPending();
      while (this.dirty && !this.disposed) {
        this.emit('saving');
        const board = this.current;
        const prepared = await prepareDelta(this.unlocked.key, this.unlocked.accountId, this.revision, board, this.index);
        if (this.disposed) return false;
        if (!prepared) { this.saved = board; this.needsScan = false; continue; }
        this.uncertain = { ...prepared, board };
        await this.sendPending();
      }
      this.emit('saved'); return true;
    } catch (error) {
      const conflict = error instanceof ApiError && error.status === 409;
      this.blocked = conflict;
      this.emit(conflict ? 'conflict' : 'error', error instanceof Error && !(error instanceof TypeError) && !(error instanceof DOMException) ? error.message : 'Нет связи с сервером. Изменения остаются в этой вкладке.');
      return false;
    }
  }
  private async sendPending() {
    const pending = this.uncertain!;
    const result = await this.request<{ revision: number }>('/board', pending.patch, 'PATCH');
    if (result.revision !== pending.patch.revision + 1) throw new Error('Неожиданный ответ сервера.');
    this.revision = result.revision; this.index = pending.index; this.saved = pending.board;
    this.needsScan = false; this.uncertain = undefined;
  }
  async reload(): Promise<BoardData> {
    if (this.active) await this.active;
    const remote = await this.request<Vault>('/board', undefined, 'GET');
    if (remote.accountId !== this.unlocked.accountId) throw new Error('В другой вкладке открыта другая доска. Заблокируйте эту и войдите снова.');
    const { board, index } = await decodeVault(this.unlocked.key, remote);
    this.current = this.saved = board; this.index = index; this.needsScan = index === null;
    this.revision = remote.revision; this.blocked = false; this.uncertain = undefined;
    this.emit('saved'); return board;
  }
  async backup() {
    const envelope = await encryptBoard(this.unlocked.key, this.unlocked.accountId, this.revision + 1, this.current);
    return { format: 'quiet-backup', accountId: this.unlocked.accountId, revision: this.revision + 1, envelope };
  }
  dispose() { this.disposed = true; clearTimeout(this.timer); }
}
