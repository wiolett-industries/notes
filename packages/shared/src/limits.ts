export const DEFAULT_BOARD_LIMIT_BYTES = 200_000_000;
export let BOARD_STORAGE_LIMIT = DEFAULT_BOARD_LIMIT_BYTES;
export let MAX_BOARD_BYTES = BOARD_STORAGE_LIMIT;
// Transport envelopes need room for base64, authentication tags and bounded
// entity metadata. These are derived framing allowances, not another board quota.
export let MAX_ENCRYPTED_BYTES = Math.ceil(BOARD_STORAGE_LIMIT * 4 / 3) + 1_000_000;
export let MAX_TRANSFER_BYTES = MAX_ENCRYPTED_BYTES + 20_000_000;

export function configureBoardLimit(bytes: number) {
  const encrypted = Math.ceil(bytes * 4 / 3) + 1_000_000;
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || !Number.isSafeInteger(encrypted + 20_000_000)) throw new Error('Invalid board storage limit.');
  BOARD_STORAGE_LIMIT = MAX_BOARD_BYTES = bytes;
  MAX_ENCRYPTED_BYTES = encrypted;
  MAX_TRANSFER_BYTES = encrypted + 20_000_000;
}
