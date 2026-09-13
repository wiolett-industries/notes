import { t } from './locale';
import MarkdownIt from 'markdown-it';
import type { NoteData, ConnectionData } from '@quiet/shared';

const md = new MarkdownIt({ html: false, linkify: false, breaks: true, typographer: false });
type Token = ReturnType<typeof md.parse>[number];
const mentionUrl = /^note:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const safeLink = md.validateLink.bind(md);
md.validateLink = url => safeLink(url) && (mentionUrl.test(url) || /^(https?:|mailto:|#)/i.test(url));
// External images would leak note-reading activity. Images belong to the
// existing local encrypted image-note flow; Markdown displays their alt text.
md.renderer.rules.image = (tokens, index) => md.utils.escapeHtml(tokens[index].content);
md.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
  tokens[index].attrSet('target', '_blank');
  tokens[index].attrSet('rel', 'noopener noreferrer');
  return renderer.renderToken(tokens, index, options);
};
md.renderer.rules.note_mention = (tokens, index, _options, env) => {
  const token = tokens[index], id = token.meta!.id as string;
  const note = (env?.notes as Map<string, Pick<NoteData, 'title'>> | undefined)?.get(id);
  const label = md.utils.escapeHtml(note?.title || token.content || t("Заметка"));
  return note ? `<a class="note-mention" href="#note-${id}" data-note-ref="${id}">@${label}</a>` : `<span class="note-mention missing" title="${md.utils.escapeHtml(t('Заметка удалена'))}">@${label}</span>`;
};
type Task = { line: number; offset: number; checked: boolean; inline: Token; item: Token; prefixLength: number };
function tasks(text: string, tokens: Token[]): Task[] {
  // Token maps count source lines after newline normalization. Keep original byte-for-byte
  // line endings and indentation so toggling changes only the character inside brackets.
  const lines = [...text.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)];
  const result: Task[] = [];
  for (let index = 2; index < tokens.length; index++) {
    const inline = tokens[index], paragraph = tokens[index - 1], item = tokens[index - 2];
    if (inline.type !== 'inline' || paragraph.type !== 'paragraph_open' || item.type !== 'list_item_open' || !inline.map) continue;
    const marker = /^\[([ xX])\](?:[ \t]+|$)/.exec(inline.content);
    if (!marker) continue;
    const line = inline.map[0], source = lines[line];
    if (!source) continue;
    // A parsed list item can have nested list/quote prefixes on the same physical line.
    const prefix = /^[ \t>]*(?:(?:[-+*]|\d+[.)])[ \t]+[ \t>]*)*\[([ xX])\](?=[ \t\r\n]|$)/.exec(source[0]);
    if (!prefix || prefix[1] !== marker[1]) continue;
    result.push({ line, offset: source.index! + prefix[0].lastIndexOf('[') + 1, checked: marker[1] !== ' ', inline, item, prefixLength: marker[0].length });
  }
  return result;
}
md.renderer.rules.task_checkbox = (tokens, index) => {
  const { line, checked, editable, label } = tokens[index].meta! as { line: number; checked: boolean; editable: boolean; label: string };
  return `<input class="task-checkbox" type="checkbox" data-task-line="${line}" aria-label="${md.utils.escapeHtml(label)}"${checked ? ' checked' : ''}${editable ? '' : ' disabled'}> `;
};
function decorateTasks(text: string, tokens: Token[], env: Record<string, unknown>, editable: boolean) {
  for (const task of tasks(text, tokens)) {
    task.item.attrJoin('class', 'task-list-item');
    const content = task.inline.content.slice(task.prefixLength);
    const children = md.parseInline(content, env)[0].children ?? [];
    const checkbox = md.parseInline('checkbox', env)[0].children![0];
    checkbox.type = 'task_checkbox';
    checkbox.meta = { line: task.line, checked: task.checked, editable, label: content.split('\n')[0] || t("Заметка") };
    task.inline.children = [checkbox, ...children];
  }
}
/** Re-parse before applying a source-line toggle: code fences and ordinary text are never tasks. */
export function toggleMarkdownTask(text: string, line: number, checked: boolean): string {
  if (!Number.isSafeInteger(line) || line < 0) return text;
  const task = tasks(text, md.parse(text, {})).find(task => task.line === line);
  if (!task || task.checked === checked) return text;
  return text.slice(0, task.offset) + (checked ? 'x' : ' ') + text.slice(task.offset + 1);
}
function collect(tokens: Token[]): string[] {
  const ids = new Set<string>();
  for (const token of tokens) {
    if (token.type === 'link_open') {
      const match = mentionUrl.exec(String(token.attrGet('href') ?? ''));
      if (match) ids.add(match[1].toLowerCase());
    }
    if (token.children && token.type !== 'image') for (const id of collect(token.children)) ids.add(id);
  }
  return [...ids];
}
export function mentionIds(text: string) { return collect(md.parse(text, {})); }
function decorateMentions(tokens: Token[]) {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const match = token.type === 'link_open' ? mentionUrl.exec(String(token.attrGet('href') ?? '')) : null;
    if (match) {
      const end = tokens.findIndex((entry, index) => index > i && entry.type === 'link_close');
      if (end !== -1) {
        token.type = 'note_mention'; token.nesting = 0; token.meta = { id: match[1].toLowerCase() };
        token.content = tokens.slice(i + 1, end).map(entry => entry.content).join('').replace(/^@/, '');
        tokens.splice(i + 1, end - i);
      }
    } else if (token.children && token.type !== 'image') decorateMentions(token.children);
  }
}
export function renderMarkdown(text: string, notes: Pick<NoteData, 'id' | 'title'>[], editableTasks = false) {
  const env = { notes: new Map(notes.map(note => [note.id, note])) };
  const tokens = md.parse(text, env);
  decorateTasks(text, tokens, env, editableTasks);
  decorateMentions(tokens);
  return md.renderer.render(tokens, md.options, env);
}
export function mentionText(note: Pick<NoteData, 'id' | 'title'>) {
  const title = (note.title || t("Заметка")).replace(/([\\`*_[\]<>])/g, '\\$1').replace(/[\r\n]/g, ' ');
  return `[@${title}](note:${note.id})`;
}
export type MentionConnection = ConnectionData & { mention?: boolean };
export function mentionConnections(notes: NoteData[]): MentionConnection[] {
  const ids = new Set(notes.map(note => note.id));
  return notes.flatMap(note => [...new Set(note.mentions ?? [])].filter(id => id !== note.id && ids.has(id)).map(target => ({
    id: `mention:${note.id}:${target}`, source: note.id, target, label: '', style: 'dashed' as const, mention: true,
  })));
}
export function remapMentions(text: string, ids: Map<string, string>) {
  return text.replace(/\]\(note:([0-9a-f-]{36})\)/gi, (whole, id: string) => ids.has(id) ? `](note:${ids.get(id)})` : whole);
}
