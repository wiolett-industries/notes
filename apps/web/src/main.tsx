import { loadClientConfig } from './client-config';
import { t, localizeError, applyDocumentLocale } from './locale';
import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { emptyBoard, type BoardData } from '@quiet/shared';
import { z } from 'zod';
import { envelopeSchema, base64url, boardSchema, MAX_TRANSFER_BYTES } from '@quiet/shared';
import { Board } from './Board';
import { Button, Icon } from './ui';
import { login, beginRegistration, finishRegistration, unlockNote, prepareNoteLocks, authError, type Unlocked } from './passkey';
import { BoardSync, type SyncState } from './sync';
import { api } from './api';
import { decryptBoard } from './crypto';
import { sealNote } from './note-lock';
import { KeyDialog } from './KeyDialog';
import { openWithKey, unlockWithKey, prepareLocksWithKey } from './key-auth';
import { rememberSession, restoreSession, forgetSession, refreshSessionOnActivity } from './session';
import { Workspace } from './Workspace';
import { PublicBoard } from './PublicBoard';
import { Modal } from './Modal';
import { Tooltip } from './Tooltip';
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
  const [busy, setBusy] = useState(true);
  const [keyDialog, setKeyDialog] = useState<'login' | 'unlock' | null>(null);
  const pendingKey = useRef<{ submit: (value: string) => Promise<void>; cancel: () => void } | null>(null);
  const [noteBusy, setNoteBusy] = useState<string | null>(null);
  const noteOperation = useRef(false);
  const [error, setError] = useState('');
  const [syncState, setSyncState] = useState<SyncState>('saved');
  const [lockDialog, setLockDialog] = useState(false);
  const [reloadDialog, setReloadDialog] = useState(false);
  const [backupReady, setBackupReady] = useState(false);
  const sync = useRef<BoardSync | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!unlocked) return;
    return refreshSessionOnActivity(unlocked.accountId, message => { setSyncState('error'); setError(message); });
  }, [unlocked?.accountId]);
  async function open(value: Unlocked, remember = true) {
    if (remember) { try { await rememberSession(value); } catch { /* Login still works when browser storage is disabled. */ } }
    try { localStorage.setItem(BOARD_MARKER, '1'); } catch { /* Storage may be disabled. */ }
    setHasBoard(true);
    sync.current?.dispose(); setUnlocked({ ...value, board: emptyBoard() }); setBoard(value.board); setError(''); setBackupReady(false);
    sync.current = new BoardSync(value, (state, message) => { setSyncState(state); setError(message ?? ''); });
    setSyncState('saved');
  }
  useEffect(() => {
    let active = true;
    void (async () => {
      try { const value = await restoreSession(); if (active && value) await open(value, false); }
      catch { try { await forgetSession(); } catch { /* Storage may be unavailable. */ } }
      finally { if (active) setBusy(false); }
    })();
    return () => { active = false; };
  }, []);
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
    try { await open(create ? await finishRegistration(await beginRegistration()) : await login()); }
    catch (err) { setError(authError(err)); }
    finally { setBusy(false); }
  }
  function change(next: BoardData) { setBoard(next); setBackupReady(false); sync.current?.update(next); }
  function askForKey<T>(operation: (value: string) => Promise<T>) {
    return new Promise<T>((resolve, reject) => {
      pendingKey.current = {
        submit: async value => { const result = await operation(value); pendingKey.current = null; resolve(result); },
        cancel: () => reject(new DOMException(t("Действие отменено."), 'AbortError')),
      };
      setKeyDialog('unlock');
    });
  }
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
        keys = unlocked.authMethod === 'key'
          ? await askForKey(value => prepareLocksWithKey(value, unlocked.accountId))
          : await prepareNoteLocks(unlocked.accountId);
        if (sync.current !== manager) return;
        change({ ...manager.board, lockKeys: keys });
      }
      const wasSealed = Boolean(note.sealed);
      const result = wasSealed && unlocked.authMethod === 'key'
        ? await askForKey(value => unlockWithKey(value, unlocked.accountId, note, keys!))
        : wasSealed ? await unlockNote(note, keys, unlocked.accountId) : await sealNote(note, keys, unlocked.accountId);
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
    try { await forgetSession(); } catch { /* Access marker is removed before IndexedDB cleanup. */ }
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
    } catch { setError(t("Не удалось сохранить копию.")); }
  }
  async function importBackup(file?: File) {
    if (!file || !unlocked || noteOperation.current) return;
    try {
      if (file.size > MAX_TRANSFER_BYTES) throw new Error(t("Слишком большой файл."));
      const backup = backupSchema.parse(JSON.parse(await file.text()));
      if (backup.accountId !== unlocked.accountId) throw new Error(t("Эта копия относится к другой доске."));
      const restored = await decryptBoard(unlocked.key, unlocked.accountId, backup.revision, backup.envelope);
      if (!window.confirm(t("Заменить текущие заметки содержимым зашифрованной копии?"))) return;
      change(restored);
    } catch (err) { setError(err instanceof Error && !(err instanceof z.ZodError) ? localizeError(err) : t("Не удалось прочитать зашифрованную копию.")); }
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
    {unlocked ? <Workspace account={unlocked} initialBoard={board} logout={() => lock()} migrated={async () => {
      change({ ...emptyBoard(), lockKeys: board.lockKeys });
      if (!(await sync.current!.flush())) throw new Error(t("Не удалось завершить перенос старой доски."));
    }} /> : <div className="login-screen">
      <Button className="primary login-button" onClick={() => void auth()} disabled={busy} aria-busy={busy}>
        {busy ? <span className="spinner" aria-label={t("Загрузка доски")} role="status" /> : t("Войти с passkey")}
      </Button>
      <div className="login-links">
        {!hasBoard && <Button className="create-key-link" onClick={() => void auth(true)} disabled={busy}>{t("Создать passkey")}</Button>}
        <Button className="create-key-link" onClick={() => { setError(''); setKeyDialog('login'); }} disabled={busy}>{t("Войти по ключу")}</Button>
      </div>
      {error && <p className={`login-error ${!hasBoard ? 'with-create-link' : ''}`} role="alert">{error}</p>}
    </div>}
    {keyDialog && <KeyDialog unlock={keyDialog === 'unlock'} submit={async (value, create) => {
      if (keyDialog === 'unlock') await pendingKey.current?.submit(value);
      else await open(await openWithKey(value, create));
    }} close={() => {
      pendingKey.current?.cancel(); pendingKey.current = null; setKeyDialog(null);
    }} />}
    <input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={e => void importBackup(e.currentTarget.files?.[0])} />
    {unlocked && error && <div className="error-banner" role="alert"><div><strong>{syncState === 'conflict' ? t("Конфликт версий") : t("Не удалось сохранить")}</strong><p>{error}</p></div><div className="error-actions">{syncState !== 'conflict' && <Button icon="retry" onClick={() => void sync.current?.flush()}>{t("Повторить")}</Button>}<Button icon="download" onClick={download}>{t("Скачать копию")}</Button>{syncState === 'conflict' && <Button onClick={() => setReloadDialog(true)}>{t("Загрузить с сервера")}</Button>}</div></div>}
    <Modal open={lockDialog || reloadDialog} close={() => { if (!busy) { setLockDialog(false); setReloadDialog(false); } }} label={t("Сохранить локальную версию")}><Icon name="lock" size={28} /><h2>{t("Сначала сохрани свою версию.")}</h2><p>{lockDialog ? t("На сервер ушли не все изменения. Скачай зашифрованную копию или вернись к доске.") : t("Загрузка с сервера заменит локальные изменения. Сначала можно скачать зашифрованную копию.")}</p><p className="muted">{t("Копия открывается только исходным ключом этой доски.")}</p><Button className="primary" icon="download" onClick={download}>{backupReady ? t("Скачать копию ещё раз") : t("Скачать копию")}</Button><Button className="secondary" disabled={busy} onClick={() => lockDialog ? void lock(true) : void reload()}>{lockDialog ? t("Выйти без сохранения") : t("Заменить локальную версию")}</Button><Button className="text-button" onClick={() => { setLockDialog(false); setReloadDialog(false); }}>{t("Вернуться к доске")}</Button></Modal>
  </main>;
}
function Root() {
  const read = () => new URLSearchParams(location.hash.slice(1)).get('public');
  const [publicToken, setPublicToken] = useState(read);
  useEffect(() => { const changed = () => setPublicToken(read()); window.addEventListener('hashchange', changed); return () => window.removeEventListener('hashchange', changed); }, []);
  const [configured, setConfigured] = useState(false), [configError, setConfigError] = useState(''), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setConfigError('');
    void loadClientConfig().then(() => { if (active) setConfigured(true); }).catch(() => {
      if (active) setConfigError(t("Не удалось загрузить настройки сервера. Попробуйте снова."));
    });
    return () => { active = false; };
  }, [attempt]);
  // Neither session restoration nor public-board decoding mounts until live limits are configured.
  if (!configured) return <main><div className="login-screen">
    {configError ? <><p className="login-error" role="alert">{configError}</p><Button icon="retry" onClick={() => { setConfigError(''); setAttempt(value => value + 1); }}>{t("Повторить")}</Button></>
      : <Button disabled aria-busy="true"><span className="spinner" role="status" aria-label={t("Загрузка настроек")} /></Button>}
  </div></main>;
  return <><Tooltip />{publicToken ? <PublicBoard key={publicToken} token={publicToken} /> : <App />}</>;
}
applyDocumentLocale();
render(<Root />, document.getElementById('app')!);
