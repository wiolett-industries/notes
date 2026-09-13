import { type AccountIdentity, type BoardEntry, type BoardData, type PublicSnapshot, type Envelope } from '@quiet/shared';
import { fromBase64, toBase64 } from './crypto';
import { BoardSocket } from './socket';
import type { Unlocked } from './passkey';
import { t } from './locale';

const encoder = new TextEncoder();
const context = (scope: string, purpose: string) => encoder.encode(JSON.stringify(['notes-sharing', 1, scope, purpose]));
export async function encryptValue(key: CryptoKey, scope: string, purpose: string, value: unknown): Promise<Envelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12)), bytes = encoder.encode(JSON.stringify(value));
  try { return { version: 1, iv: toBase64(iv), ciphertext: toBase64(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: context(scope, purpose) }, key, bytes)) }; }
  finally { bytes.fill(0); }
}
export async function decryptValue<T>(key: CryptoKey, scope: string, purpose: string, envelope: Envelope): Promise<T> {
  const bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(envelope.iv), additionalData: context(scope, purpose) }, key, fromBase64(envelope.ciphertext)));
  try { return JSON.parse(new TextDecoder().decode(bytes)); } finally { bytes.fill(0); }
}
export type SharingIdentity = AccountIdentity & { private: CryptoKey };
export async function identityFor(socket: BoardSocket, account: Unlocked): Promise<SharingIdentity> {
  let identity = await socket.request<AccountIdentity | null>('identity.get');
  if (!identity) {
    const pair = await crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt']);
    const bytes = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
    try {
      identity = await socket.request<AccountIdentity>('identity.put', { publicKey: toBase64(await crypto.subtle.exportKey('spki', pair.publicKey)), privateKey: await encryptValue(account.key, account.accountId, 'identity', toBase64(bytes)) });
    } finally { bytes.fill(0); }
  }
  const bytes = fromBase64(await decryptValue<string>(account.key, account.accountId, 'identity', identity.privateKey));
  try {
    // Authenticate the separate directory key against the decrypted private key,
    // without exporting private RSA components into JavaScript strings.
    const privateKey = await crypto.subtle.importKey('pkcs8', bytes, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);
    const publicKey = await crypto.subtle.importKey('spki', fromBase64(identity.publicKey), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    let plain: Uint8Array | undefined;
    try {
      const algorithm = { name: 'RSA-OAEP', label: context(account.accountId, 'identity-check') };
      const ciphertext = await crypto.subtle.encrypt(algorithm, publicKey, challenge);
      plain = new Uint8Array(await crypto.subtle.decrypt(algorithm, privateKey, ciphertext));
      if (plain.length !== challenge.length || !plain.every((byte, index) => byte === challenge[index])) throw new Error(t('Некорректный ключ участника.'));
    } finally { challenge.fill(0); plain?.fill(0); }
    return { ...identity, private: privateKey };
  }
  finally { bytes.fill(0); }
}
export async function contactCode(uid: string, publicKey: string) {
  return `notes-contact:${uid}:${toBase64(await crypto.subtle.digest('SHA-256', fromBase64(publicKey)))}`;
}
export function parseContactCode(code: string) {
  const match = /^notes-contact:([A-Za-z0-9_-]{43}):([A-Za-z0-9_-]{43})$/.exec(code.trim());
  if (!match) throw new Error(t('Попросите участника прислать код приглашения из его профиля.'));
  return { uid: match[1], fingerprint: match[2] };
}
export async function verifyContactCode(code: string, publicKey: string) {
  const { uid } = parseContactCode(code);
  if (await contactCode(uid, publicKey) !== code.trim()) throw new Error(t('Ключ участника не совпадает с кодом приглашения. Доступ не выдан.'));
  return uid;
}
export function sealRecipient(accountKey: CryptoKey, boardId: string, uid: string, publicKey: string) {
  return encryptValue(accountKey, boardId, `verified-recipient:${uid}`, publicKey);
}
export async function verifiedRecipient(accountKey: CryptoKey, boardId: string, uid: string, proof?: Envelope | null) {
  if (!proof) throw new Error(t('Сначала подтвердите коды приглашения остальных участников.'));
  const publicKey = await decryptValue<unknown>(accountKey, boardId, `verified-recipient:${uid}`, proof);
  if (typeof publicKey !== 'string') throw new Error(t('Некорректный ключ участника.'));
  // Validate the stored key before it can be used by a rotation or role change.
  await crypto.subtle.importKey('spki', fromBase64(publicKey), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  return publicKey;
}
export async function wrapBoardKey(bytes: Uint8Array<ArrayBuffer>, boardId: string, uid: string, publicKey: string) {
  const key = await crypto.subtle.importKey('spki', fromBase64(publicKey), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  return toBase64(await crypto.subtle.encrypt({ name: 'RSA-OAEP', label: context(boardId, `member:${uid}`) }, key, bytes));
}
export async function boardSecret(entry: BoardEntry, uid: string, identity: SharingIdentity) {
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'RSA-OAEP', label: context(entry.id, `member:${uid}`) }, identity.private, fromBase64(entry.wrappedKey)));
}
export async function boardKey(entry: BoardEntry, uid: string, identity: SharingIdentity) {
  const bytes = await boardSecret(entry, uid, identity);
  try { return await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']); }
  finally { bytes.fill(0); }
}
export function publicSnapshot(name: string, board: BoardData): PublicSnapshot {
  const { lockKeys: _keys, ...rest } = board;
  return { name, lockedIds: board.notes.filter(note => note.sealed).map(note => note.id), board: { ...rest, notes: board.notes.map(note => {
    const { sealed, ...plain } = note;
    return sealed ? { ...plain, kind: 'text', image: undefined, text: '' } : plain;
  }) } };
}
