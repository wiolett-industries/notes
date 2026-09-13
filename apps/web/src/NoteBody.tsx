import { t } from './locale';
import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { MAX_NOTE_TEXT_LENGTH, type NoteData } from '@quiet/shared';
import './task-lists.css';
import { mentionText, renderMarkdown, toggleMarkdownTask } from './markdown';

type Props = {
  note: NoteData; notes: (Pick<NoteData, 'id' | 'title'> & { group?: boolean })[]; editing: boolean; busy: boolean; editable?: boolean;
  change: (text: string) => void; edit: () => void; done: () => void; follow: (id: string) => void;
  resize?: (height: number) => void;
};
type Completion = { start: number; end: number; query: string };
function completion(input: HTMLTextAreaElement): Completion | null {
  if (input.selectionStart !== input.selectionEnd) return null;
  const before = input.value.slice(0, input.selectionStart);
  const match = /(?:^|[\s(])@([^\n\r@\[\]()]{0,80})$/.exec(before);
  if (!match) return null;
  return { start: before.length - match[1].length - 1, end: before.length, query: match[1].toLocaleLowerCase() };
}
// Textareas remain the single editing surface: shortcuts insert Markdown and
// return the selection to the wrapped text, rather than editing rendered HTML.
export function markdownShortcut(text: string, start: number, end: number, code: string, shift: boolean) {
  const selected = text.slice(start, end);
  let before = '', after = '';
  if (code === 'KeyB') before = after = '**';
  else if (code === 'KeyI') before = after = '*';
  else if (code === 'KeyE') {
    if (selected.includes('\n')) { before = '```\n'; after = '\n```'; }
    else { before = after = selected.includes('`') ? '``' : '`'; }
  } else if (code === 'KeyX' && shift) before = after = '~~';
  else if (code === 'KeyK') {
    const label = selected || t("текст");
    const inserted = `[${label}](https://)`;
    return { text: text.slice(0, start) + inserted + text.slice(end), start: start + label.length + 3, end: start + inserted.length - 1 };
  } else return null;
  if (selected.startsWith(before) && selected.endsWith(after) && selected.length >= before.length + after.length) {
    const value = selected.slice(before.length, selected.length - after.length);
    return { text: text.slice(0, start) + value + text.slice(end), start, end: start + value.length };
  }
  if (text.slice(Math.max(0, start - before.length), start) === before && text.slice(end, end + after.length) === after) {
    return { text: text.slice(0, start - before.length) + selected + text.slice(end + after.length), start: start - before.length, end: end - before.length };
  }
  return { text: text.slice(0, start) + before + selected + after + text.slice(end), start: start + before.length, end: end + before.length };
}
export function NoteBody({ note, notes, editing, busy, editable = false, change, edit, done, follow, resize }: Props) {
  const input = useRef<HTMLTextAreaElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const resizeRef = useRef(resize); resizeRef.current = resize;
  const [mention, setMention] = useState<Completion | null>(null);
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<{ x: number; y: number; above: boolean }>({ x: 8, y: 36, above: false });
  const composing = useRef(false);
  const tasksEditable = editable && !busy && !note.sealed && !note.pinned;
  const html = useMemo(() => renderMarkdown(note.text, notes, tasksEditable), [note.text, notes, tasksEditable]);
  useLayoutEffect(() => {
    if (!note.textStyle || note.sealed) return;
    const element = editing ? input.current : content.current;
    if (!element) return;
    const measure = () => {
      if (editing && input.current) {
        input.current.style.height = '0px';
        input.current.style.height = `${input.current.scrollHeight}px`;
      }
      resizeRef.current?.(Math.max(16, Math.ceil(element.offsetHeight + 2)));
    };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, [editing, html, note.textStyle, note.width]);
  const candidates = mention ? notes.filter(n => n.id !== note.id && (n.title || t("Заметка")).toLocaleLowerCase().includes(mention.query)).slice(0, 8) : [];
  useLayoutEffect(() => { if (editing) input.current?.focus({ preventScroll: true }); else setMention(null); }, [editing]);
  function inspect() {
    const el = input.current;
    if (!el || composing.current) return;
    const value = completion(el);
    setMention(value); setActive(0);
    if (!value) return;
    // Mirror the textarea wrapping to position the menu beside the caret.
    const mirror = document.createElement('div');
    const computed = getComputedStyle(el);
    for (const prop of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'padding', 'boxSizing', 'wordBreak', 'overflowWrap'] as const) mirror.style[prop] = computed[prop];
    Object.assign(mirror.style, { position: 'fixed', left: '-10000px', top: '0', visibility: 'hidden', whiteSpace: 'pre-wrap', width: `${el.clientWidth}px` });
    const marker = document.createElement('span'); marker.textContent = '\u200b';
    mirror.append(document.createTextNode(el.value.slice(0, value.end)), marker); document.body.append(mirror);
    const y = marker.offsetTop - el.scrollTop, line = parseFloat(computed.lineHeight) || 26;
    setPlace({ x: Math.max(8, Math.min(marker.offsetLeft, el.clientWidth - 220)), y: Math.max(0, Math.min(y + line, el.clientHeight)), above: y + 160 > el.clientHeight && y > 140 });
    mirror.remove();
  }
  function apply(result: { text: string; start: number; end: number }) {
    if (busy || result.text.length > MAX_NOTE_TEXT_LENGTH) return;
    change(result.text); setMention(null);
    requestAnimationFrame(() => { input.current?.focus({ preventScroll: true }); input.current?.setSelectionRange(result.start, result.end); });
  }
  function pick(target: Pick<NoteData, 'id' | 'title'>) {
    if (!mention || !input.current) return;
    const text = input.current.value;
    const value = mentionText(target) + ' ';
    apply({ text: text.slice(0, mention.start) + value + text.slice(mention.end), start: mention.start + value.length, end: mention.start + value.length });
  }
  if (!editing) return <div ref={content} className="note-content markdown-body" dangerouslySetInnerHTML={{ __html: html }}
    onPointerDown={e => { if ((e.target as Element).closest('a, .task-checkbox')) e.stopPropagation(); }}
    onClick={e => {
      if ((e.target as Element).closest('.task-checkbox')) { e.stopPropagation(); return; }
      const link = (e.target as Element).closest<HTMLElement>('[data-note-ref]');
      if (link) { e.preventDefault(); e.stopPropagation(); follow(link.dataset.noteRef!); }
    }}
    onChange={e => {
      const checkbox = (e.target as Element).closest<HTMLInputElement>('input.task-checkbox[data-task-line]');
      if (!checkbox) return;
      e.stopPropagation();
      if (!tasksEditable) { checkbox.checked = checkbox.defaultChecked; return; }
      const next = toggleMarkdownTask(note.text, Number(checkbox.dataset.taskLine), checkbox.checked);
      if (next !== note.text) change(next);
    }}
    onDblClick={e => { e.stopPropagation(); if (!(e.target as Element).closest('a, .task-checkbox')) edit(); }} />;
  return <div className="note-editor">
    <textarea ref={input} aria-label={t("Текст заметки")} maxLength={MAX_NOTE_TEXT_LENGTH} value={note.text} spellcheck readOnly={busy}
      aria-autocomplete="list" aria-expanded={Boolean(mention)} aria-controls={mention ? `mentions-${note.id}` : undefined}
      aria-activedescendant={mention && candidates.length ? `mention-${note.id}-${candidates[Math.min(active, candidates.length - 1)].id}` : undefined}
      onInput={e => { change(e.currentTarget.value); inspect(); }} onClick={inspect} onSelect={inspect}
      onScroll={() => setMention(null)} onBlur={() => { setMention(null); done(); }}
      onCompositionStart={() => { composing.current = true; setMention(null); }} onCompositionEnd={() => { composing.current = false; inspect(); }}
      onKeyDown={e => {
        if (e.isComposing || composing.current) return;
        if ((e.ctrlKey || e.metaKey) && !e.altKey) {
          const result = markdownShortcut(e.currentTarget.value, e.currentTarget.selectionStart, e.currentTarget.selectionEnd, e.code, e.shiftKey);
          if (result) { e.preventDefault(); e.stopPropagation(); apply(result); return; }
        }
        if (mention) {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); setActive(index => candidates.length ? (index + (e.key === 'ArrowDown' ? 1 : -1) + candidates.length) % candidates.length : 0); return; }
          if ((e.key === 'Enter' || e.key === 'Tab') && candidates.length) { e.preventDefault(); e.stopPropagation(); pick(candidates[Math.min(active, candidates.length - 1)]); return; }
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setMention(null); return; }
        }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(); }
      }} />
    {mention && <div id={`mentions-${note.id}`} className={`mention-menu floating ${place.above ? 'above' : ''}`} role="listbox" aria-label={t("Упомянуть заметку")} style={{ left: place.x, top: place.y }} onPointerDown={e => { e.preventDefault(); e.stopPropagation(); }} onDblClick={e => e.stopPropagation()}>
      {candidates.length ? candidates.map((target, index) => <button key={target.id} id={`mention-${note.id}-${target.id}`} type="button" role="option" aria-selected={index === active} onClick={() => pick(target)}><span>@</span><span>{target.title || t("Заметка")}</span><small>{target.group ? t("Группа") : target.id.slice(0, 4)}</small></button>) : <span className="mention-empty">{t("Заметок не найдено")}</span>}
    </div>}
  </div>;
}
