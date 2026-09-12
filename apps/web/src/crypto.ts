import { boardSchema, envelopeSchema, MAX_BOARD_BYTES, type BoardData, type Envelope } from '@quiet/shared';

const encoder = new TextEncoder();
export function toBase64(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
export function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}
export async function deriveKey(prf: ArrayBuffer, accountId: string, domain = 'quiet/board/aes-256-gcm/v1'): Promise<CryptoKey> {
  if (prf.byteLength !== 32) throw new Error('Passkey не вернул ключ шифрования.');
  const material = await crypto.subtle.importKey('raw', prf, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(accountId), info: encoder.encode(domain) }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
function aad(accountId: string, revision: number) {
  return encoder.encode(JSON.stringify(['quiet-board', 1, accountId, revision]));
}
export async function encryptBoard(key: CryptoKey, accountId: string, revision: number, board: BoardData): Promise<Envelope> {
  const plaintext = encoder.encode(JSON.stringify(boardSchema.parse(board)));
  if (plaintext.byteLength > MAX_BOARD_BYTES) { plaintext.fill(0); throw new Error('Доска превышает 23 МБ. Удалите часть изображений.'); }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  try {
    const result = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(accountId, revision), tagLength: 128 }, key, plaintext);
    return envelopeSchema.parse({ version: 1, iv: toBase64(iv), ciphertext: toBase64(result) });
  } finally { plaintext.fill(0); }
}
export async function decryptBoard(key: CryptoKey, accountId: string, revision: number, raw: Envelope): Promise<BoardData> {
  const envelope = envelopeSchema.parse(raw);
  const result = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(envelope.iv), additionalData: aad(accountId, revision), tagLength: 128 }, key, fromBase64(envelope.ciphertext));
  try { return boardSchema.parse(JSON.parse(new TextDecoder().decode(result))); }
  finally { new Uint8Array(result).fill(0); }
}
