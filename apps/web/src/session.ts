import { t, localizeError } from './locale';
import { SESSION_SECONDS, type Vault } from '@quiet/shared';
import { api, ApiError } from './api';
import { decodeVault } from './entities';
import type { Unlocked } from './passkey';

const TAB_SESSION = 'notes:tab-session';
const STORE = 'sessions';
type SavedSession = Pick<Unlocked, 'key' | 'accountId' | 'authMethod'> & { expires: number };
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('notes-session', 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function access<T>(write: boolean, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, write ? 'readwrite' : 'readonly');
      const request = operation(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}
export async function rememberSession(value: Unlocked) {
  // Structured clone preserves a non-extractable CryptoKey. No board plaintext,
  // master key, PRF output, auth token or decrypted note-lock key is persisted.
  await forgetSession();
  const id = crypto.randomUUID();
  const saved: SavedSession = { key: value.key, accountId: value.accountId, authMethod: value.authMethod, expires: Date.now() + SESSION_SECONDS * 1000 };
  await access(true, store => {
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      const entry = cursor.result;
      if (entry) { if (entry.value.expires <= Date.now()) entry.delete(); entry.continue(); }
    };
    return store.put(saved, id);
  });
  try { sessionStorage.setItem(TAB_SESSION, id); }
  catch (error) { await access(true, store => store.delete(id)); throw error; }
}
export async function forgetSession() {
  const id = sessionStorage.getItem(TAB_SESSION);
  sessionStorage.removeItem(TAB_SESSION);
  if (id) await access(true, store => store.delete(id));
}
export async function restoreSession(): Promise<Unlocked | null> {
  const id = sessionStorage.getItem(TAB_SESSION);
  if (!id) return null;
  const saved = await access<SavedSession | undefined>(false, store => store.get(id));
  if (!saved || saved.expires <= Date.now()) { await forgetSession(); return null; }
  const vault = await api<Vault>('/board', undefined, 'GET');
  if (vault.accountId !== saved.accountId) { await forgetSession(); return null; }
  const { board, index } = await decodeVault(saved.key, vault);
  return { key: saved.key, accountId: saved.accountId, authMethod: saved.authMethod, board, revision: vault.revision, entityIndex: index };
}
async function extendSavedSession(accountId: string, expires: number) {
  const id = sessionStorage.getItem(TAB_SESSION);
  if (!id) return;
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const request = store.get(id);
      request.onsuccess = () => {
        const saved = request.result as SavedSession | undefined;
        // A late refresh must not recreate access after logout or account switch.
        if (saved?.accountId === accountId && sessionStorage.getItem(TAB_SESSION) === id) {
          store.put({ ...saved, expires: Math.max(saved.expires, expires) }, id);
        }
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}
export function refreshSessionOnActivity(accountId: string, expired: (message: string) => void) {
  let stopped = false, pending = false, nextAttempt = 0;
  const events = ['pointerdown', 'pointermove', 'keydown', 'wheel'] as const;
  async function activity(event: Event) {
    if (stopped || pending || !event.isTrusted || document.visibilityState !== 'visible' || Date.now() < nextAttempt) return;
    pending = true;
    nextAttempt = Date.now() + 60_000;
    try {
      const result = await api<{ accountId: string; expiresIn: number }>('/session/refresh', { accountId });
      if (stopped) return;
      if (result.accountId !== accountId || result.expiresIn !== SESSION_SECONDS) throw new Error(t("Некорректный ответ продления сессии."));
      try { await extendSavedSession(accountId, Date.now() + result.expiresIn * 1000); }
      catch { /* An active session also works when browser storage is disabled. */ }
    } catch (error) {
      if (stopped) return;
      if (error instanceof ApiError && error.status === 401) {
        stopped = true;
        try { await forgetSession(); } catch { /* Remove saved access where possible. */ }
        expired(localizeError(error));
      }
      // Network failures retry on later interaction, never on an idle timer.
    } finally { pending = false; }
  }
  for (const event of events) window.addEventListener(event, activity, { capture: true, passive: true });
  return () => {
    stopped = true;
    for (const event of events) window.removeEventListener(event, activity, true);
  };
}
