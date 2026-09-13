import { loadClientConfig, applyBoardListLimits } from '../apps/web/src/client-config';
import { BOARD_STORAGE_LIMIT, MAX_BOARD_BYTES, MAX_ENCRYPTED_BYTES, MAX_TRANSFER_BYTES, configureBoardLimit, emptyBoard } from '@quiet/shared';
import { encryptBoard } from '../apps/web/src/crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { catalog, countLabel, detectLocale, isStorageLimit, localizeError, quotaMessage, storageUsage, translate } from '../apps/web/src/locale';
import { ApiError } from '../apps/web/src/api';
import { renderMarkdown, mentionText } from '../apps/web/src/markdown';
import { boardModeShortcut } from '../apps/web/src/board-hotkeys';

const root = new URL('../', import.meta.url);
test('browser language preference order, region tags, and English fallback', () => {
  for (const [languages, expected] of [
    [[], 'en'], [['fr', 'de'], 'en'], [['ru-RU', 'en-US'], 'ru'],
    [['en-GB', 'ru'], 'en'], [['fr', 'ru-MD'], 'ru'], [['RU_ru'], 'ru'],
  ] as const) assert.equal(detectLocale(languages), expected);
});

test('Node imports need no navigator or document; document language is explicit', () => {
  for (const languages of [null, ['ru-RU'], ['en-US']]) {
    const result = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      delete globalThis.navigator; delete globalThis.document;
      const languages = ${JSON.stringify(languages)};
      if (languages) Object.defineProperty(globalThis, 'navigator', { value: { languages } });
      const {locale, t, applyDocumentLocale} = await import('./apps/web/src/locale.ts');
      const target = { documentElement: { lang: '' } }; applyDocumentLocale(target);
      console.log(JSON.stringify([locale, target.documentElement.lang, t('Заметка')]));
    `], { cwd: root, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(result), languages?.[0] === 'ru-RU' ? ['ru', 'ru', 'Заметка'] : ['en', 'en', 'Note']);
  }
});

test('catalog has English copy and matching typed placeholder names', () => {
  const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
  for (const [key, value] of Object.entries(catalog)) {
    assert.ok(value.trim(), key);
    assert.doesNotMatch(value, /[А-Яа-яЁё]/, key);
    assert.deepEqual(placeholders(key), placeholders(value), key);
  }
  assert.equal(translate('ru', 'Моя доска'), 'Моя доска');
  assert.equal(translate('en', 'Доска {count}', { count: 2 }), 'Board 2');
  // These calls must fail typechecking if placeholder names/types become permissive.
  if (false) {
    // @ts-expect-error missing required title
    translate('en', 'Удалить доску «{title}»');
    // @ts-expect-error misspelled placeholder
    translate('en', 'Удалить доску «{title}»', { name: 'Board' });
  }
});

test('user titles and note content stay verbatim; Markdown HTML remains escaped', () => {
  const title = 'Заметка $& {title} <img src=x onerror=alert(1)>';
  assert.equal(translate('en', 'Удалить доску «{title}»', { title }), `Delete board “${title}”`);
  const id = '12345678-1234-1234-1234-123456789abc';
  const markdown = mentionText({ id, title });
  const html = renderMarkdown(markdown, [{ id, title }]);
  assert.ok(html.includes('Заметка $&amp; {title} &lt;img'));
  assert.ok(!html.includes('<img'));
  assert.ok(renderMarkdown('Привет, это моя заметка.', []).includes('Привет, это моя заметка.'));
});

test('Russian and English plural labels handle 0/1/2/5/11/21/22', () => {
  for (const [count, suffix] of [[0, 'знаков'], [1, 'знак'], [2, 'знака'], [5, 'знаков'], [11, 'знаков'], [21, 'знак'], [22, 'знака']] as const) {
    assert.equal(countLabel('characters', count, 'ru'), `${count} ${suffix}`);
    assert.equal(countLabel('characters', count, 'en'), `${count} ${count === 1 ? 'character' : 'characters'}`);
  }
  assert.equal(countLabel('deleted', 22, 'ru'), '22 заметки удалены');
  assert.equal(countLabel('deleted', 1, 'en'), '1 note deleted');
  assert.equal(countLabel('people', 1, 'en'), '1 person on the board');
  assert.equal(countLabel('people', 2, 'ru'), '2 участника на доске');
});

test('all current literal server errors have translations, unknown errors have a localized fallback', () => {
  const directory = new URL('apps/server/src/', root);
  let checked = 0;
  for (const file of readdirSync(directory).filter(name => name.endsWith('.ts'))) {
    const source = readFileSync(new URL(file, directory), 'utf8');
    for (const match of source.matchAll(/'((?:\\.|[^'\\])*)'/g)) {
      const message = match[1];
      if (!/[А-Яа-яЁё]/.test(message)) continue;
      assert.ok(Object.hasOwn(catalog, message) || isStorageLimit(message), `${file}: ${message}`);
      assert.doesNotMatch(localizeError(message, 'en'), /[А-Яа-яЁё]/);
      checked++;
    }
  }
  assert.ok(checked > 50);
  assert.equal(localizeError('Неизвестная новая ошибка', 'en'), 'Could not complete the action. Please try again.');
  assert.equal(localizeError(new TypeError('Failed to fetch'), 'ru'), 'Не удалось выполнить действие. Попробуйте снова.');
  const error = new ApiError(403, 'Нет доступа к доске.', 'ACCESS_DENIED');
  assert.equal(error.status, 403); assert.equal(error.code, 'ACCESS_DENIED');
  assert.equal(localizeError(error, 'en'), 'You do not have access to this board.');
});

test('dynamic configured quotas round-trip in both locales', () => {
  for (const limit of [200_000_000, 350_000_000, 123_500_000, 1200_000_000]) {
    const ru = quotaMessage(limit, 'ru'), en = quotaMessage(limit, 'en');
    assert.ok(isStorageLimit(ru)); assert.ok(isStorageLimit(en));
    assert.equal(localizeError(ru, 'en'), en);
    assert.equal(localizeError(en, 'ru'), ru);
    assert.equal(localizeError(en, 'en'), en);
  }
  assert.equal(storageUsage(1_250_000, 200_000_000, 'en'), '1.3 / 200 MB');
  assert.equal(storageUsage(1_250_000, 123_500_000, 'ru'), '1,3 / 123,5 МБ');
  for (const message of ['Слишком большой пакет.', 'Доска превышает допустимый размер.']) assert.equal(isStorageLimit(message), false);
});

test('physical mode shortcuts preserve modifiers/clipboard and prevent viewer connections', () => {
  const key = { code: 'KeyV', ctrlKey: false, metaKey: false, altKey: false, isComposing: false };
  assert.equal(boardModeShortcut(key, false), 'select');
  assert.equal(boardModeShortcut({ ...key, code: 'KeyH' }, true), 'hand');
  assert.equal(boardModeShortcut({ ...key, code: 'KeyC' }, false), 'connect');
  assert.equal(boardModeShortcut({ ...key, code: 'KeyC' }, true), null);
  for (const code of ['KeyC', 'KeyV', 'KeyH']) for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'isComposing']) {
    assert.equal(boardModeShortcut({ ...key, code, [modifier]: true }, false), null);
  }
});


test('config loading waits for a valid response and can retry after failures', async () => {
  const previousFetch = globalThis.fetch, previousLimit = BOARD_STORAGE_LIMIT;
  try {
    let release!: (response: Response) => void;
    globalThis.fetch = async (input, init) => {
      assert.equal(input, '/api/config'); assert.equal(init?.method, 'GET'); assert.equal(init?.cache, 'no-store');
      return new Promise<Response>(resolve => { release = resolve; });
    };
    let ready = false;
    const pending = loadClientConfig().then(() => { ready = true; });
    await Promise.resolve();
    assert.equal(ready, false); assert.equal(MAX_BOARD_BYTES, previousLimit);
    release(Response.json({ boardLimitBytes: 350_000_000 }));
    await pending;
    assert.equal(ready, true); assert.equal(MAX_BOARD_BYTES, 350_000_000);
    for (const result of [{}, { boardLimitBytes: -1 }, { boardLimitBytes: '200000000' }, { boardLimitBytes: 1.5 }, null]) {
      globalThis.fetch = async () => Response.json(result);
      await assert.rejects(loadClientConfig());
      assert.equal(MAX_BOARD_BYTES, 350_000_000);
    }
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
    await assert.rejects(loadClientConfig());
    globalThis.fetch = async () => new Response('{}', { status: 503 });
    await assert.rejects(loadClientConfig());
    globalThis.fetch = async () => Response.json({ boardLimitBytes: 200_000_000 });
    await loadClientConfig();
    assert.equal(MAX_BOARD_BYTES, 200_000_000);
  } finally { globalThis.fetch = previousFetch; configureBoardLimit(previousLimit); }
});

test('refreshed board lists update all live limits, while legacy entries retain boot configuration', () => {
  const previousLimit = BOARD_STORAGE_LIMIT;
  try {
    for (const bytes of [400_000_000, 100_000_000]) {
      applyBoardListLimits([{ limitBytes: bytes }, { limitBytes: bytes }]);
      assert.equal(BOARD_STORAGE_LIMIT, bytes); assert.equal(MAX_BOARD_BYTES, bytes);
      assert.ok(MAX_ENCRYPTED_BYTES > bytes); assert.ok(MAX_TRANSFER_BYTES > MAX_ENCRYPTED_BYTES);
      applyBoardListLimits([{}]); applyBoardListLimits([]);
      assert.equal(MAX_BOARD_BYTES, bytes);
    }
    assert.throws(() => applyBoardListLimits([{ limitBytes: 200_000_000 }, { limitBytes: 400_000_000 }]));
    assert.throws(() => applyBoardListLimits([{ limitBytes: 0 }]));
    assert.equal(MAX_BOARD_BYTES, 100_000_000);
  } finally { configureBoardLimit(previousLimit); }
});

test('board encryption consults the current configured limit, with a localized dynamic error', async () => {
  const previousLimit = BOARD_STORAGE_LIMIT;
  try {
    const board = emptyBoard(), bytes = new TextEncoder().encode(JSON.stringify(board)).length;
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    configureBoardLimit(bytes - 1);
    await assert.rejects(encryptBoard(key, 'a'.repeat(43), 1, board), error => {
      assert.equal(localizeError(error, 'en'), quotaMessage(bytes - 1, 'en')); return true;
    });
    configureBoardLimit(bytes + 1);
    assert.equal((await encryptBoard(key, 'a'.repeat(43), 1, board)).version, 1);
  } finally { configureBoardLimit(previousLimit); }
});
