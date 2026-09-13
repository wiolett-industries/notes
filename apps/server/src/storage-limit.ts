import { DEFAULT_BOARD_LIMIT_BYTES } from '@quiet/shared';

export function storageLimitBytes(value = process.env.BOARD_LIMIT_MB): number {
  if (value === undefined || value.trim() === '') return DEFAULT_BOARD_LIMIT_BYTES;
  const bytes = Number(value) * 1_000_000;
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error('BOARD_LIMIT_MB must be a positive number of megabytes.');
  return bytes;
}
