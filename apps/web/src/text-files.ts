import { MAX_NOTE_TEXT_LENGTH } from '@quiet/shared';
import { t } from './locale';

export function isTextFile(file: File): boolean {
  return file.type.startsWith('text/') || /\.(txt|md|markdown|csv|json|log|yaml|yml|xml|ini|toml)$/i.test(file.name);
}

export async function readTextFile(file: File): Promise<string> {
  if (file.size > 1_000_000) throw new Error(t('Текстовый файл должен быть не больше 1 МБ.'));
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); }
  catch { throw new Error(t('Не удалось прочитать текстовый файл. Используйте UTF-8.')); }
  if (text.includes('\0') || text.length > MAX_NOTE_TEXT_LENGTH) throw new Error(t('Не удалось прочитать текстовый файл. Используйте UTF-8.'));
  return text;
}
