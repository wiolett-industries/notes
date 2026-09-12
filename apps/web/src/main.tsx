import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { emptyBoard, type BoardData } from '@quiet/shared';
import { z } from 'zod';
import { envelopeSchema, base64url, boardSchema, MAX_ENCRYPTED_BYTES } from '@quiet/shared';
import { Board } from './Board';
import { Button, Icon } from './ui';
import { login, beginRegistration, finishRegistration, unlockNote, prepareNoteLocks, authError, type Unlocked } from './passkey';
import { BoardSync, type SyncState } from './sync';
import { api } from './api';
import { decryptBoard } from './crypto';
import { sealNote } from './note-lock';
import './style.css';

const backupSchema = z.object({ format: z.literal('quiet-backup'), accountId: base64url.length(43), revision: z.number().int().positive(), envelope: envelopeSchema }).strict();
const BOARD_MARKER = 'notes:has-board';
function App() {
  const [hasBoard, setHasBoard] = useState(() => {
    try { return localStorage.getItem(BOARD_MARKER) === '1'; }
    catch { return false; }
  });
  const [unlocked, setUnlocked] = useState<Unlocked | null>(null);
  const [board, setBoard] = useState<BoardData>(emptyBoard);
  const [busy, setBusy] = useState(false);
  const [noteBusy, setNoteBusy] = useState<string | null>(null);
  const noteOperation = useRef(false);
  const [error, setError] = useState('');
  const [syncState, setSyncState] = useState<SyncState>('saved');
  const [lockDialog, setLockDialog] = useState(false);
  const [reloadDialog, setReloadDialog] = useState(false);
  const [backupReady, setBackupReady] = useState(false);
  const sync = useRef<BoardSync | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  function open(value: Unlocked) {
    try { localStorage.setItem(BOARD_MARKER, '1'); } catch { /* Storage may be disabled. */ }
    setHasBoard(true);
    sync.current?.dispose(); setUnlocked({ ...value, board: emptyBoard() }); setBoard(value.board); setError(''); setBackupReady(false);
    sync.current = new BoardSync(value, (state, message) => { setSyncState(state); setError(message ?? ''); });
    setSyncState('saved');
  }
  useEffect(() => {
    function preventWheelZoom(e: WheelEvent) { if (e.ctrlKey || e.metaKey) e.preventDefault(); }
    function preventKeyZoom(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && (['+', '-', '=', '0'].includes(e.key) || ['Equal', 'Minus', 'Digit0', 'NumpadAdd', 'NumpadSubtract', 'Numpad0'].includes(e.code))) e.preventDefault();
    }
    function preventGestureZoom(e: Event) { e.preventDefault(); }
    window.addEventListener('wheel', preventWheelZoom, { passive: false, capture: true });
    window.addEventListener('keydown', preventKeyZoom, true);
    window.addEventListener('gesturestart', preventGestureZoom, { passive: false });
    window.addEventListener('gesturechange', preventGestureZoom, { passive: false });
    return () => {
      window.removeEventListener('wheel', preventWheelZoom, true);
      window.removeEventListener('keydown', preventKeyZoom, true);
      window.removeEventListener('gesturestart', preventGestureZoom);
      window.removeEventListener('gesturechange', preventGestureZoom);
    };
  }, []);
  useEffect(() => {
    function beforeUnload(e: BeforeUnloadEvent) { if (sync.current?.dirty) { e.preventDefault(); e.returnValue = ''; } }
    function online() { if (sync.current?.state === 'error') void sync.current.flush(); }
    window.addEventListener('beforeunload', beforeUnload); window.addEventListener('online', online);
    return () => { window.removeEventListener('beforeunload', beforeUnload); window.removeEventListener('online', online); sync.current?.dispose(); };
  }, []);
  async function auth(create = false) {
    if (busy) return;
    setBusy(true); setError('');
    try { open(create ? await finishRegistration(await beginRegistration()) : await login()); }
    catch (err) { setError(authError(err)); }
    finally { setBusy(false); }
  }
  function change(next: BoardData) { setBoard(next); setBackupReady(false); sync.current?.update(next); }
  async function toggleNoteLock(id: string) {
    const manager = sync.current;
    if (!manager || !unlocked || noteOperation.current || busy) return;
    noteOperation.current = true; setNoteBusy(id);
    try {
      change(boardSchema.parse(manager.board));
      await manager.flush();
      const note = manager.board.notes.find(n => n.id === id);
      if (!note) return;
      let keys = manager.board.lockKeys;
      if (!keys) {
        keys = await prepareNoteLocks(unlocked.accountId);
        if (sync.current !== manager) return;
        change({ ...manager.board, lockKeys: keys });
      }
      const wasSealed = Boolean(note.sealed);
      const result = wasSealed ? await unlockNote(note, keys, unlocked.accountId) : await sealNote(note, keys, unlocked.accountId);
      if (sync.current !== manager) return;
      // A second note may have changed while the passkey dialog was open.
      const latest = manager.board.notes.find(n => n.id === id);
      if (!latest) return;
      if (!wasSealed) {
        manager.forgetNote(id, result);
        const retained = unlocked.board.notes.find(n => n.id === id);
        if (retained) { retained.title = result.title; retained.text = ''; delete retained.image; retained.sealed = result.sealed; }
      }
      change({ ...manager.board, notes: manager.board.notes.map(n => n.id === id ? { ...result, x: latest.x, y: latest.y, width: latest.width, height: latest.height } : n) });
      await manager.flush();
    } catch (err) { setError(authError(err)); }
    finally { noteOperation.current = false; setNoteBusy(null); }
  }
  async function lock(discard = false) {
    if (!sync.current || busy || noteOperation.current) return;
    setBusy(true);
    if (!discard && !(await sync.current.flush())) { setLockDialog(true); setBusy(false); return; }
    // Erase local keys/UI immediately even if logout cannot reach the server.
    sync.current.dispose(); sync.current = null; setUnlocked(null); setBoard(emptyBoard()); setLockDialog(false); setError(''); setBackupReady(false);
    try { await api('/logout'); } catch { /* HttpOnly session cannot decrypt a board. It expires server-side. */ }
    finally { setBusy(false); }
  }
  async function download() {
    if (!sync.current) return;
    try {
      const backup = await sync.current.backup();
      const url = URL.createObjectURL(new Blob([JSON.stringify(backup)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = 'quiet-encrypted-backup.json'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000); setBackupReady(true);
    } catch { setError('Не удалось сохранить копию.'); }
  }
  async function importBackup(file?: File) {
    if (!file || !unlocked || noteOperation.current) return;
    try {
      if (file.size > MAX_ENCRYPTED_BYTES + 100_000) throw new Error('Слишком большой файл.');
      const backup = backupSchema.parse(JSON.parse(await file.text()));
      if (backup.accountId !== unlocked.accountId) throw new Error('Эта копия относится к другой доске.');
      const restored = await decryptBoard(unlocked.key, unlocked.accountId, backup.revision, backup.envelope);
      if (!window.confirm('Заменить текущие заметки содержимым зашифрованной копии?')) return;
      change(restored);
    } catch (err) { setError(err instanceof Error && !(err instanceof z.ZodError) ? err.message : 'Не удалось прочитать зашифрованную копию.'); }
    finally { if (fileInput.current) fileInput.current.value = ''; }
  }
  async function reload() {
    if (noteOperation.current) return;
    setBusy(true);
    try { const next = await sync.current!.reload(); setBoard(next); setReloadDialog(false); setBackupReady(false); }
    catch (err) { setError(authError(err)); }
    finally { setBusy(false); }
  }
  return <main>
    {unlocked ? <Board key={unlocked.accountId} board={board} onChange={change} noteBusy={noteBusy} onToggleLock={toggleNoteLock}
      clipboardKey={unlocked.key} accountId={unlocked.accountId} interactionBlocked={lockDialog || reloadDialog}
      actions={<><Button icon="download" label="Скачать зашифрованную копию" disabled={Boolean(noteBusy)} onClick={download} /><Button icon="upload" label="Открыть зашифрованную копию" disabled={Boolean(noteBusy)} onClick={() => fileInput.current?.click()} /><Button icon="lock" label="Выйти" disabled={busy || Boolean(noteBusy)} onClick={() => void lock()} /></>}
    /> : <div className="login-screen">
      <Button className="primary login-button" onClick={() => void auth()} disabled={busy} aria-busy={busy}>
        {busy ? <span className="spinner" aria-label="Загрузка доски" role="status" /> : 'Войти с passkey'}
      </Button>
      {!hasBoard && <Button className="create-key-link" onClick={() => void auth(true)} disabled={busy}>Создать новый ключ</Button>}
      {error && <p className={`login-error ${!hasBoard ? 'with-create-link' : ''}`} role="alert">{error}</p>}
    </div>}
    <input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={e => void importBackup(e.currentTarget.files?.[0])} />
    {unlocked && error && <div className="error-banner" role="alert"><div><strong>{syncState === 'conflict' ? 'Конфликт версий' : 'Не удалось сохранить'}</strong><p>{error}</p></div><div className="error-actions">{syncState !== 'conflict' && <Button icon="retry" onClick={() => void sync.current?.flush()}>Повторить</Button>}<Button icon="download" onClick={download}>Скачать копию</Button>{syncState === 'conflict' && <Button onClick={() => setReloadDialog(true)}>Загрузить с сервера</Button>}</div></div>}
    {(lockDialog || reloadDialog) && <div className="modal-backdrop"><section className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><Icon name="lock" size={28} /><h2 id="dialog-title">Сначала сохрани свою версию.</h2><p>{lockDialog ? 'На сервер ушли не все изменения. Скачай зашифрованную копию или вернись к доске.' : 'Загрузка с сервера заменит локальные изменения. Сначала можно скачать зашифрованную копию.'}</p><p className="muted">Копия открывается только с тем же passkey.</p><Button className="primary" icon="download" onClick={download}>{backupReady ? 'Скачать копию ещё раз' : 'Скачать копию'}</Button><Button className="secondary" disabled={busy} onClick={() => lockDialog ? void lock(true) : void reload()}>{lockDialog ? 'Заблокировать и убрать локальные изменения' : 'Заменить локальную версию'}</Button><Button className="text-button" onClick={() => { setLockDialog(false); setReloadDialog(false); }}>Вернуться к доске</Button></section></div>}
  </main>;
}
render(<App />, document.getElementById('app')!);
