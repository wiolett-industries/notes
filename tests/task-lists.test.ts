import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderMarkdown, toggleMarkdownTask } from '../apps/web/src/markdown';

const inputs = (html: string) => html.match(/<input\b[^>]*>/g) ?? [];
test('task list markers render native checkboxes, including uppercase X and empty tasks', () => {
  const html = renderMarkdown('- [ ] Todo\n- [x] Done\n- [X] Also done\n- [ ]', [], true);
  const boxes = inputs(html);
  assert.equal(boxes.length, 4);
  assert.ok(boxes.every(box => box.includes('type="checkbox"') && !box.includes('disabled')));
  assert.ok(!boxes[0].includes(' checked')); assert.ok(boxes[1].includes(' checked')); assert.ok(boxes[2].includes(' checked'));
  assert.doesNotMatch(html, /\[[ xX]\]/);
  assert.equal(toggleMarkdownTask('- [X] Done', 0, false), '- [ ] Done');
});

test('rendering is disabled by default and explicit editability controls every nested checkbox', () => {
  const text = '- [ ] Outer\n  - [x] Inner';
  for (const html of [renderMarkdown(text, []), renderMarkdown(text, [], false)]) {
    assert.equal(inputs(html).length, 2);
    assert.ok(inputs(html).every(box => box.includes(' disabled')));
  }
  assert.ok(inputs(renderMarkdown(text, [], true)).every(box => !box.includes(' disabled')));
});

test('source-line toggles preserve CRLF, indentation, nested quotes, and all unrelated text', () => {
  const text = 'Heading\r\n\r\n> 1. [ ] First\r\n>    - [X] Nested **task**\r\n>      continuation\r\n\r\n- [ ] Last\r\n';
  const html = renderMarkdown(text, [], true);
  assert.deepEqual(inputs(html).map(box => /data-task-line="(\d+)"/.exec(box)![1]), ['2', '3', '6']);
  assert.equal(toggleMarkdownTask(text, 3, false), text.replace('[X]', '[ ]'));
  const toggled = toggleMarkdownTask(text, 6, true);
  assert.equal(toggled, text.replace('- [ ] Last', '- [x] Last'));
  assert.equal(toggleMarkdownTask(toggled, 6, false), text);
});

test('compact nested lists and tasks following empty list-marker lines use the actual source line', () => {
  assert.equal(toggleMarkdownTask('- - [ ] Nested', 0, true), '- - [x] Nested');
  const text = '-\n  [ ] Task';
  assert.equal(inputs(renderMarkdown(text, [], true)).length, 1);
  assert.equal(toggleMarkdownTask(text, 1, true), '-\n  [x] Task');
});

test('fenced and indented code, inline code, escaped brackets, and ordinary paragraphs never toggle', () => {
  const text = '```md\n- [ ] fenced\n```\n\n    - [x] indented\n\n[ ] paragraph\n\n- `[ ]` inline\n- \\[ ] escaped\n- ordinary item\n\n  [ ] second paragraph';
  assert.equal(inputs(renderMarkdown(text, [], true)).length, 0);
  for (let line = 0; line < text.split('\n').length; line++) assert.equal(toggleMarkdownTask(text, line, true), text);
  for (const line of [-1, NaN, Infinity, 0.5, 1000]) assert.equal(toggleMarkdownTask(text, line, true), text);
});

test('task labels and content remain escaped while formatting, safe links and mentions keep working', () => {
  const id = '12345678-1234-1234-1234-123456789abc';
  const text = `- [ ] "><img src=x onerror="alert(1)"> **bold** [site](https://example.org) [@title](note:${id})`;
  const html = renderMarkdown(text, [{ id, title: 'Русское название' }], true);
  assert.equal(inputs(html).length, 1);
  assert.ok(html.includes('&lt;img')); assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&quot;&gt;')); assert.ok(html.includes('<strong>bold</strong>'));
  assert.ok(html.includes('rel="noopener noreferrer"'));
  assert.ok(html.includes(`data-note-ref="${id}"`)); assert.ok(html.includes('Русское название'));
  assert.equal(toggleMarkdownTask(text, 0, true), text.replace('- [ ]', '- [x]'));
});

test('task parsing retains reference-link definitions and does not reinterpret partial markers', () => {
  const html = renderMarkdown('- [ ] [site][ref]\n\n[ref]: https://example.org\n\n- [x]suffix\n- [y] other', [], true);
  assert.equal(inputs(html).length, 1);
  assert.ok(html.includes('href="https://example.org"'));
  assert.ok(html.includes('[x]suffix'));
});
