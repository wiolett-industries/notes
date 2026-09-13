import { configureBoardLimit, type BoardEntry } from '@quiet/shared';
import { api } from './api';
import { t } from './locale';

function applyLimit(value: unknown): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error(t("Не удалось загрузить настройки сервера. Попробуйте снова."));
  configureBoardLimit(value);
}

/** Called before mounting any flow that authenticates or decodes stored board data. */
export async function loadClientConfig(): Promise<void> {
  const result = await api<{ boardLimitBytes?: unknown }>('/config', undefined, 'GET');
  applyLimit(result?.boardLimitBytes);
}

/** A reconnect can reach a server with a new environment-configured limit. */
export function applyBoardListLimits(entries: Pick<BoardEntry, 'limitBytes'>[]): void {
  const limits = entries.map(entry => entry.limitBytes).filter(value => value !== undefined);
  if (!limits.length) return; // Older servers omit this field; retain the boot configuration.
  if (limits.some(value => value !== limits[0])) throw new Error(t("Не удалось загрузить настройки сервера. Попробуйте снова."));
  applyLimit(limits[0]);
}
