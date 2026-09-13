import { t } from './locale';
import { emptyBoard, type LockKeys, type NoteData, type Vault } from '@quiet/shared';
import { api } from './api';
import { deriveKey, fromBase64, toBase64 } from './crypto';
import { decodeVault, prepareDelta } from './entities';
import { createLockKeys, unsealNote } from './note-lock';
import type { Unlocked } from './passkey';

const encoder = new TextEncoder();
function supported() {
  if (!globalThis.crypto?.subtle) throw new Error(t("Для шифрования нужен HTTPS и браузер с Web Crypto."));
}
export function generateAccessKey() {
  supported();
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  try { return `notes_${toBase64(bytes)}`; } finally { bytes.fill(0); }
}
async function withKey<T>(value: string, run: (seed: Uint8Array<ArrayBuffer>, accountId: string, authToken: string) => Promise<T>) {
  supported();
  const normalized = value.trim();
  if (!/^notes_[A-Za-z0-9_-]{43}$/.test(normalized)) throw new Error(t("Вставьте полный ключ, начинающийся с notes_."));
  const seed = fromBase64(normalized.slice(6));
  let token: Uint8Array<ArrayBuffer> | undefined;
  try {
    if (seed.length !== 32 || toBase64(seed) !== normalized.slice(6)) throw new Error(t("Некорректный ключ."));
    const material = await crypto.subtle.importKey('raw', seed, 'HKDF', false, ['deriveBits']);
    const derive = (purpose: string) => crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('notes/access-key/v1'), info: encoder.encode(purpose) }, material, 256);
    const accountId = toBase64(await derive('account-id'));
    token = new Uint8Array(await derive('authentication'));
    return await run(seed, accountId, toBase64(token));
  } finally { seed.fill(0); token?.fill(0); }
}
export async function openWithKey(value: string, create = false): Promise<Unlocked> {
  return withKey(value, async (seed, accountId, authToken) => {
    const key = await deriveKey(seed.buffer, accountId, 'notes/access-key/board/v1');
    let vault: Vault;
    if (create) {
      const board = emptyBoard();
      board.lockKeys = await createLockKeys(seed.buffer, accountId);
      const initial = (await prepareDelta(key, accountId, 0, board, null))!;
      vault = await api<Vault>('/auth/key/register', { accountId, authToken, snapshot: { format: 2, manifest: initial.patch.manifest, entities: initial.patch.upserts } });
    } else vault = await api<Vault>('/auth/key/login', { accountId, authToken });
    if (vault.accountId !== accountId) throw new Error(t("Сервер вернул другую доску."));
    const { board, index } = await decodeVault(key, vault);
    board.lockKeys ??= await createLockKeys(seed.buffer, accountId);
    // Keep only the board key. Note unlocking requires the original key again.
    return { key, accountId, board, revision: vault.revision, entityIndex: index, authMethod: 'key' };
  });
}
export async function unlockWithKey(value: string, accountId: string, note: NoteData, keys: LockKeys) {
  return withKey(value, async (seed, derivedId, authToken) => {
    if (derivedId !== accountId) throw new Error(t("Ключ относится к другой доске."));
    await api('/auth/key/unlock', { accountId, authToken });
    return unsealNote(note, keys, accountId, seed.buffer);
  });
}
export async function prepareLocksWithKey(value: string, accountId: string) {
  return withKey(value, async (seed, derivedId, authToken) => {
    if (derivedId !== accountId) throw new Error(t("Ключ относится к другой доске."));
    await api('/auth/key/unlock', { accountId, authToken });
    return createLockKeys(seed.buffer, accountId);
  });
}
