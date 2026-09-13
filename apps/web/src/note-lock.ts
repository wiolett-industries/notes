import { noteContentSchema, type LockKeys, type NoteData, type Envelope } from '@quiet/shared';
import { deriveKey, toBase64, fromBase64 } from './crypto';
import { mentionIds } from './markdown';
import { t } from './locale';

const encoder = new TextEncoder();
const domain = 'notes/note-lock/private-key/v1';
const context = (...parts: string[]) => encoder.encode(JSON.stringify(['notes-note-lock', 1, ...parts]));
async function encrypt(key: CryptoKey, bytes: Uint8Array<ArrayBuffer>, aad: Uint8Array<ArrayBuffer>): Promise<Envelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const result = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, bytes);
  return { version: 1, iv: toBase64(iv), ciphertext: toBase64(result) };
}
async function decrypt(key: CryptoKey, envelope: Envelope, aad: Uint8Array<ArrayBuffer>) {
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(envelope.iv), additionalData: aad }, key, fromBase64(envelope.ciphertext));
}
// Keep only the public sealing key in the unlocked board. The private key is
// encrypted under a separate PRF-derived key, never the in-memory board key.
export async function createLockKeys(prf: ArrayBuffer, accountId: string): Promise<LockKeys> {
  const pair = await crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt']);
  const privateBytes = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  try {
    const key = await deriveKey(prf, accountId, domain);
    return { publicKey: toBase64(await crypto.subtle.exportKey('spki', pair.publicKey)), privateKey: await encrypt(key, privateBytes, context(accountId, 'private')) };
  } finally { privateBytes.fill(0); }
}
export async function sealNote(note: NoteData, keys: LockKeys, accountId: string): Promise<NoteData> {
  if (note.sealed) return note;
  if (note.textStyle) throw new Error(t('Текстовый блок нельзя заблокировать.'));
  const publicKey = await crypto.subtle.importKey('spki', fromBase64(keys.publicKey), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const plaintext = encoder.encode(JSON.stringify(noteContentSchema.parse({ title: note.title, text: note.text, image: note.image })));
  try {
    const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
    const wrappedKey = await crypto.subtle.encrypt({ name: 'RSA-OAEP', label: context(accountId, note.id, 'key') }, publicKey, rawKey);
    const content = await encrypt(key, plaintext, context(accountId, note.id, 'content'));
    const { image: _image, ...rest } = note;
    return { ...rest, text: '', mentions: mentionIds(note.text).filter(id => id !== note.id), sealed: { wrappedKey: toBase64(wrappedKey), content, visibleTitle: true } };
  } finally { rawKey.fill(0); plaintext.fill(0); }
}
export async function unsealNote(note: NoteData, keys: LockKeys, accountId: string, prf: ArrayBuffer): Promise<NoteData> {
  if (!note.sealed) return note;
  const key = await deriveKey(prf, accountId, domain);
  const privateBytes = new Uint8Array(await decrypt(key, keys.privateKey, context(accountId, 'private')));
  let rawKey: Uint8Array<ArrayBuffer> | undefined, plaintext: Uint8Array<ArrayBuffer> | undefined;
  try {
    const privateKey = await crypto.subtle.importKey('pkcs8', privateBytes, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);
    const bindingId = note.sealed.bindingId ?? note.id;
    rawKey = new Uint8Array(await crypto.subtle.decrypt({ name: 'RSA-OAEP', label: context(accountId, bindingId, 'key') }, privateKey, fromBase64(note.sealed.wrappedKey)));
    const contentKey = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt']);
    plaintext = new Uint8Array(await decrypt(contentKey, note.sealed.content, context(accountId, bindingId, 'content')));
    const content = noteContentSchema.parse(JSON.parse(new TextDecoder().decode(plaintext)));
    const { sealed: _sealed, ...rest } = note;
    return { ...rest, ...content, mentions: mentionIds(content.text).filter(id => id !== note.id), title: note.sealed.visibleTitle ? note.title : content.title };
  } finally { privateBytes.fill(0); rawKey?.fill(0); plaintext?.fill(0); }
}
