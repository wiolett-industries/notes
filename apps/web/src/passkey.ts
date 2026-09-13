import { t, localizeError } from './locale';
import { PRF_INPUT, emptyBoard, type Vault, type BoardData, type NoteData, type LockKeys } from '@quiet/shared';
import { api } from './api';
import { fromBase64, toBase64, deriveKey } from './crypto';
import { createLockKeys, unsealNote } from './note-lock';
import { decodeVault, prepareDelta, type EntityIndex } from './entities';

type CreationJSON = Omit<PublicKeyCredentialCreationOptions, 'challenge' | 'user' | 'excludeCredentials'> & {
  challenge: string; user: { id: string; name: string; displayName: string };
  excludeCredentials?: { id: string; type: 'public-key'; transports?: AuthenticatorTransport[] }[];
};
type RequestJSON = Omit<PublicKeyCredentialRequestOptions, 'challenge' | 'allowCredentials'> & {
  challenge: string; allowCredentials?: { id: string; type: 'public-key'; transports?: AuthenticatorTransport[] }[];
};
type PRFOutputs = AuthenticationExtensionsClientOutputs & { prf?: { enabled?: boolean; results?: { first: ArrayBuffer } } };
type PRFInputs = AuthenticationExtensionsClientInputs & { prf: { eval?: { first: Uint8Array<ArrayBuffer> } } };
export type PendingRegistration = { options: RequestJSON; accountId: string };
export type Unlocked = { key: CryptoKey; accountId: string; revision: number; board: BoardData; entityIndex?: EntityIndex | null; authMethod?: 'passkey' | 'key' };
const PRF_ERROR = t("Этот браузер или passkey не поддерживает шифрование (PRF). Можно создать отдельную доску через «Войти по ключу».");
function supported() {
  if (!window.isSecureContext || !window.PublicKeyCredential || !navigator.credentials || !crypto.subtle) throw new Error(t("Для passkey нужен поддерживаемый браузер и HTTPS (или localhost)."));
}
function requireCredential(value: Credential | null): PublicKeyCredential {
  if (!value || value.type !== 'public-key') throw new Error(t("Passkey не выбран."));
  return value as PublicKeyCredential;
}
// Do not use credential.toJSON(): it can include the PRF secret in clientExtensionResults.
export function serializeRegistration(credential: PublicKeyCredential) {
  const response = credential.response as AuthenticatorAttestationResponse;
  return { id: credential.id, rawId: toBase64(credential.rawId), type: 'public-key' as const,
    response: { clientDataJSON: toBase64(response.clientDataJSON), attestationObject: toBase64(response.attestationObject), transports: response.getTransports?.() ?? [] },
    clientExtensionResults: {},
  };
}
export function serializeAuthentication(credential: PublicKeyCredential) {
  const response = credential.response as AuthenticatorAssertionResponse;
  if (!response.userHandle) throw new Error(t("Нужен обнаруживаемый passkey с идентификатором пользователя."));
  return { id: credential.id, rawId: toBase64(credential.rawId), type: 'public-key' as const,
    response: { clientDataJSON: toBase64(response.clientDataJSON), authenticatorData: toBase64(response.authenticatorData), signature: toBase64(response.signature), userHandle: toBase64(response.userHandle) },
    clientExtensionResults: {},
  };
}
async function assertion(options: RequestJSON) {
  const credential = requireCredential(await navigator.credentials.get({ publicKey: {
    ...options, challenge: fromBase64(options.challenge),
    allowCredentials: options.allowCredentials?.map(item => ({ ...item, id: fromBase64(item.id) })),
    extensions: { prf: { eval: { first: new TextEncoder().encode(PRF_INPUT) } } } as PRFInputs,
  } }));
  const prf = (credential.getClientExtensionResults() as PRFOutputs).prf?.results?.first;
  if (!prf || prf.byteLength !== 32) throw new Error(PRF_ERROR);
  return { credential, prf };
}
export async function beginRegistration(): Promise<PendingRegistration> {
  supported();
  const { options } = await api<{ options: CreationJSON }>('/auth/register/options');
  const credential = requireCredential(await navigator.credentials.create({ publicKey: {
    ...options, challenge: fromBase64(options.challenge), user: { ...options.user, id: fromBase64(options.user.id) },
    excludeCredentials: options.excludeCredentials?.map(item => ({ ...item, id: fromBase64(item.id) })),
    extensions: { ...options.extensions, prf: {} } as PRFInputs,
  } }));
  if (!(credential.getClientExtensionResults() as PRFOutputs).prf?.enabled) throw new Error(PRF_ERROR);
  return api<PendingRegistration>('/auth/register/verify', serializeRegistration(credential));
}
export async function finishRegistration(pending: PendingRegistration): Promise<Unlocked> {
  const { credential, prf } = await assertion(pending.options);
  try {
    const key = await deriveKey(prf, pending.accountId);
    const board = emptyBoard();
    board.lockKeys = await createLockKeys(prf, pending.accountId);
    const initial = (await prepareDelta(key, pending.accountId, 0, board, null))!;
    const snapshot = { format: 2, manifest: initial.patch.manifest, entities: initial.patch.upserts };
    const vault = await api<Vault>('/auth/register/finish', { credential: serializeAuthentication(credential), snapshot });
    if (vault.accountId !== pending.accountId || vault.revision !== 1) throw new Error(t("Некорректный ответ при создании доски."));
    const decoded = await decodeVault(key, vault);
    return { key, board: decoded.board, entityIndex: decoded.index, accountId: vault.accountId, revision: vault.revision };
  } finally { new Uint8Array(prf).fill(0); }
}
export async function login(): Promise<Unlocked> {
  supported();
  const { options } = await api<{ options: RequestJSON }>('/auth/login/options');
  const { credential, prf } = await assertion(options);
  try {
    const vault = await api<Vault>('/auth/login/verify', serializeAuthentication(credential));
    const key = await deriveKey(prf, vault.accountId);
    const { board, index } = await decodeVault(key, vault);
    board.lockKeys ??= await createLockKeys(prf, vault.accountId);
    return { key, board, entityIndex: index, accountId: vault.accountId, revision: vault.revision };
  } finally { new Uint8Array(prf).fill(0); }
}
export async function unlockNote(note: NoteData, keys: LockKeys, accountId: string): Promise<NoteData> {
  const { options } = await api<{ options: RequestJSON }>('/auth/unlock/options', { accountId });
  const { credential, prf } = await assertion(options);
  try {
    await api('/auth/unlock/verify', { accountId, credential: serializeAuthentication(credential) });
    return await unsealNote(note, keys, accountId, prf);
  } finally { new Uint8Array(prf).fill(0); }
}
export async function prepareNoteLocks(accountId: string): Promise<LockKeys> {
  const { options } = await api<{ options: RequestJSON }>('/auth/unlock/options', { accountId });
  const { credential, prf } = await assertion(options);
  try {
    await api('/auth/unlock/verify', { accountId, credential: serializeAuthentication(credential) });
    return await createLockKeys(prf, accountId);
  } finally { new Uint8Array(prf).fill(0); }
}
export function authError(error: unknown): string {
  if (error instanceof DOMException && ['NotAllowedError', 'AbortError'].includes(error.name)) return t("Действие отменено или время ожидания истекло. Можно попробовать ещё раз.");
  if (error instanceof DOMException && error.name === 'OperationError') return t("Не удалось расшифровать данные. Используйте исходный ключ или passkey этой доски.");
  return error instanceof Error ? localizeError(error) : t("Не удалось открыть доску.");
}
