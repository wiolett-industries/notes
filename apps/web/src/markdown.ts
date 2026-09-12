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
  const label = md.utils.escapeHtml(note?.title || token.content || 'Заметка');
  return note ? `<a class="note-mention" href="#note-${id}" data-note-ref="${id}">@${label}</a>` : `<span class="note-mention missing" title="Заметка удалена">@${label}</span>`;
};
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
export function renderMarkdown(text: string, notes: Pick<NoteData, 'id' | 'title'>[]) {
  const tokens = md.parse(text, {});
  decorateMentions(tokens);
  return md.renderer.render(tokens, md.options, { notes: new Map(notes.map(note => [note.id, note])) });
}
export function mentionText(note: Pick<NoteData, 'id' | 'title'>) {
  const title = (note.title || 'Заметка').replace(/([\\`*_[\]<>])/g, '\\$1').replace(/[\r\n]/g, ' ');
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
