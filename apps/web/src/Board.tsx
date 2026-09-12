import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { colors, GRID_SIZE, MAX_BOARD_BYTES, type BoardData, type NoteData, type NoteColor, type ConnectionData, type GroupData } from '@quiet/shared';
import { Button, Icon } from './ui';
import { Connections } from './Connections';
import { clamp, snap, center, routeConnections, draftConnection, magneticTarget, groupBounds, cleanGroups, contains, intersects, type Point, type Rect, type Endpoint } from './geometry';
import { readImage } from './images';
import { UndoToast } from './UndoToast';
import { SearchPopover } from './SearchPopover';
import { CLIPBOARD_PREFIX, copySelection, writeSelection, readSelection, pasteSelection } from './board-clipboard';
import { NoteBody } from './NoteBody';
import { mentionConnections, mentionIds } from './markdown';

const labels: Record<NoteColor, string> = { sand: 'Песочный', sage: 'Шалфей', rose: 'Розовый', lavender: 'Лавандовый', sky: 'Голубой' };
type Props = { board: BoardData; onChange: (board: BoardData) => void; locked?: boolean; noteBusy?: string | null; onToggleLock: (id: string) => Promise<void>; actions?: ComponentChildren; clipboardKey: CryptoKey; accountId: string; interactionBlocked?: boolean };
type Gesture = { kind: 'pan' | 'note' | 'resize' | 'connect' | 'selection' | 'group'; pointer: number; start: Point; camera: BoardData['camera']; note?: NoteData; edge?: string; moved?: NoteData[]; bounds?: ReturnType<typeof groupBounds>; selection?: string[]; group?: string };
type Draft = { source: string; point: Point; target?: string };
export function Board({ board: incoming, onChange, locked = false, noteBusy = null, onToggleLock, actions, clipboardKey, accountId, interactionBlocked = false }: Props) {
  const board = useMemo(() => ({ ...incoming, connections: incoming.connections ?? [], groups: incoming.groups ?? [], notes: incoming.notes.map(note => ({ ...note, title: note.title ?? 'Заметка', kind: note.kind ?? 'text', width: note.width ?? 272, height: note.height ?? 248 })) }), [incoming]);
  const root = useRef<HTMLDivElement>(null);
  const current = useRef(board); current.current = board;
  const catalogSignature = JSON.stringify(board.notes.map(note => [note.id, note.title]));
  const noteCatalog = useMemo(() => board.notes.map(({ id, title }) => ({ id, title })), [catalogSignature]);
  const [selected, select] = useState<string | null>(null);
  const [mode, setMode] = useState<'select' | 'hand' | 'connect' | 'group'>('select');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectionRect, setSelectionRect] = useState<Rect | null>(null);
  const [selectedGroup, selectGroup] = useState<string | null>(null);
  const [editingGroup, editGroup] = useState<string | null>(null);
  const hand = mode === 'hand';
  const [editing, setEditing] = useState<{ id: string; field: 'title' | 'text' } | null>(null);
  const [selectedEdge, selectEdge] = useState<string | null>(null);
  const [editingEdge, editEdge] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const draftRef = useRef<Draft | null>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const [imageBusy, setImageBusy] = useState(false);
  const alive = useRef(true);
  const captures = useRef(new Map<number, Element>());
  const [space, setSpace] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchIndex, setSearchIndex] = useState(0);
  const [cameraFocusing, setCameraFocusing] = useState(false);
  const focusTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clipboardBusy = useRef(false);
  const [clipboardWorking, setClipboardWorking] = useState(false);
  const lastPaste = useRef({ signature: '', count: 0 });
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState('');
  const [lastDeleted, setLastDeleted] = useState<{ note: NoteData; connections: ConnectionData[]; group?: GroupData } | null>(null);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture | null>(null);
  const pinch = useRef<{ distance: number; midpoint: Point; camera: BoardData['camera'] } | null>(null);
  function update(next: BoardData) { current.current = next; onChange(next); }
  function camera(value: BoardData['camera']) {
    update({ ...current.current, camera: { x: clamp(value.x, -1e9, 1e9), y: clamp(value.y, -1e9, 1e9), zoom: clamp(value.zoom, .15, 3) } });
  }
  function local(point: Point) {
    const rect = root.current!.getBoundingClientRect(); return { x: point.x - rect.left, y: point.y - rect.top };
  }
  function world(point: Point) {
    const p = local(point), cam = current.current.camera;
    return { x: (p.x - cam.x) / cam.zoom, y: (p.y - cam.y) / cam.zoom };
  }
  function setConnection(value: Draft | null) { draftRef.current = value; setDraft(value); }
  function chooseMode(value: typeof mode) { setMode(value); setConnection(null); setEditing(null); editEdge(null); editGroup(null); }
  function clearSelection() {
    select(null); selectEdge(null); selectGroup(null); setSelectedIds([]); setSelectionRect(null);
    setConnection(null); setEditing(null); editEdge(null); editGroup(null);
  }
  function selectedNotes() {
    const ids = selectedIds.length ? selectedIds : selected ? [selected] : current.current.groups.find(g => g.id === selectedGroup)?.noteIds ?? [];
    return ids.filter(id => current.current.notes.some(note => note.id === id));
  }
  function openSearch() {
    setSearchOpen(true); setEditing(null); editEdge(null); editGroup(null); setConnection(null);
    requestAnimationFrame(() => { const input = root.current?.querySelector<HTMLInputElement>('.search-popover input'); input?.focus({ preventScroll: true }); input?.select(); });
  }
  function closeSearch() { setSearchOpen(false); root.current?.focus({ preventScroll: true }); }
  function focusNote(id: string) {
    const note = current.current.notes.find(n => n.id === id);
    const rect = root.current?.getBoundingClientRect();
    if (!note || !rect) return;
    const zoom = clamp(Math.min((rect.width - 96) / note.width, (rect.height - 240) / note.height, 1.2), .15, 3);
    clearSelection(); select(id);
    setCameraFocusing(true); clearTimeout(focusTimer.current);
    focusTimer.current = setTimeout(() => setCameraFocusing(false), 220);
    camera({ zoom, x: rect.width / 2 - (note.x + note.width / 2) * zoom, y: (rect.height - 80) / 2 - (note.y + note.height / 2) * zoom });
  }
  const query = searchQuery.trim().toLocaleLowerCase();
  const searchMatches = query ? board.notes.filter(note => `${note.title}\n${note.sealed ? '' : note.text}`.toLocaleLowerCase().includes(query)).map(note => note.id) : [];
  const searchSignature = searchMatches.join(',');
  useEffect(() => {
    if (!searchOpen) return;
    if (!searchMatches.length) { clearSelection(); return; }
    const index = Math.min(searchIndex, searchMatches.length - 1);
    if (index !== searchIndex) setSearchIndex(index);
    focusNote(searchMatches[index]);
  }, [searchOpen, searchQuery, searchSignature, searchIndex]);
  function stepSearch(direction: number) {
    if (searchMatches.length) setSearchIndex(index => (index + direction + searchMatches.length) % searchMatches.length);
  }
  async function copyNotes(cut: boolean) {
    const ids = selectedNotes();
    if (!ids.length || clipboardBusy.current || noteBusy || interactionBlocked) return;
    clipboardBusy.current = true; setClipboardWorking(true);
    try {
      const snapshot = copySelection(current.current, ids);
      await writeSelection(clipboardKey, accountId, snapshot);
      if (!alive.current) return;
      lastPaste.current = { signature: '', count: 0 };
      if (cut) {
        const copied = new Map(snapshot.notes.map(note => [note.id, JSON.stringify(note)]));
        const unchanged = new Set(current.current.notes.filter(note => copied.get(note.id) === JSON.stringify(note)).map(note => note.id));
        update(cleanGroups({ ...current.current, notes: current.current.notes.filter(note => !unchanged.has(note.id)) }));
        clearSelection(); setLastDeleted(null);
        if (unchanged.size !== ids.length) setNotice('Изменённые во время копирования заметки оставлены на доске.');
      }
    } catch { if (alive.current) setNotice(cut ? 'Не удалось записать заметки в буфер обмена. Вырезание отменено.' : 'Не удалось записать заметки в буфер обмена.'); }
    finally { clipboardBusy.current = false; if (alive.current) setClipboardWorking(false); }
  }
  async function pasteNotes(text: string) {
    if (clipboardBusy.current || noteBusy || interactionBlocked) return;
    clipboardBusy.current = true; setClipboardWorking(true);
    try {
      const copied = await readSelection(clipboardKey, accountId, text);
      if (!alive.current || !copied.notes.length) return;
      const rect = root.current!.getBoundingClientRect(), cam = current.current.camera;
      const left = Math.min(...copied.notes.map(n => n.x)), top = Math.min(...copied.notes.map(n => n.y));
      const right = Math.max(...copied.notes.map(n => n.x + n.width)), bottom = Math.max(...copied.notes.map(n => n.y + n.height));
      const signature = text.slice(0, 200);
      const count = signature === lastPaste.current.signature ? lastPaste.current.count + 1 : 1;
      const offset = { x: snap((rect.width / 2 - cam.x) / cam.zoom - (left + right) / 2 + count * 24), y: snap(((rect.height - 100) / 2 - cam.y) / cam.zoom - (top + bottom) / 2 + count * 24) };
      const pasted = pasteSelection(current.current, copied, offset);
      update(pasted.board); clearSelection(); setSelectedIds(pasted.ids); chooseMode('select');
      lastPaste.current = { signature, count };
    } catch (error) { if (alive.current) setNotice(error instanceof Error ? error.message : 'Не удалось вставить заметки.'); }
    finally { clipboardBusy.current = false; if (alive.current) setClipboardWorking(false); }
  }
  function endpoints(): Endpoint[] { return [...groupBounds(current.current.groups, current.current.notes), ...current.current.notes]; }
  function connectionTarget(e: PointerEvent, source: string) {
    const element = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-note], [data-group]');
    const id = element?.dataset.note ?? element?.dataset.group;
    return (id !== source && endpoints().find(n => n.id === id)) || magneticTarget(endpoints(), world({ x: e.clientX, y: e.clientY }), source, current.current.camera.zoom);
  }
  function makeGroup() {
    const ids = selectedIds.filter(id => current.current.notes.some(note => note.id === id));
    if (ids.length < 2) return;
    if (current.current.groups.length >= 500) { setNotice('На доске уже 500 групп.'); return; }
    const group = { id: crypto.randomUUID(), title: 'Группа', noteIds: ids };
    const groups = current.current.groups.map(g => ({ ...g, noteIds: g.noteIds.filter(id => !ids.includes(id)) }));
    update(cleanGroups({ ...current.current, groups: [...groups, group] }));
    selectGroup(group.id); setSelectedIds([]); select(null); chooseMode('group');
  }
  function ungroup(id: string) {
    update(cleanGroups({ ...current.current, groups: current.current.groups.filter(g => g.id !== id) }));
    selectGroup(null); editGroup(null);
  }
  function assignGroups(ids: string[], bounds: ReturnType<typeof groupBounds>) {
    let groups = current.current.groups;
    for (const id of ids) {
      const note = current.current.notes.find(n => n.id === id);
      if (!note) continue;
      const target = bounds.filter(rect => contains(rect, center(note))).sort((a, b) => a.width * a.height - b.width * b.height)[0];
      groups = groups.map(g => ({ ...g, noteIds: [...g.noteIds.filter(member => member !== id), ...(g.id === target?.id ? [id] : [])] }));
    }
    update(cleanGroups({ ...current.current, groups }));
  }
  function startEditing(id: string, field: 'title' | 'text') {
    if (hand || mode === 'connect' || locked || noteBusy === id) return;
    const note = current.current.notes.find(n => n.id === id);
    if (!note || note.kind === 'image' || (note.sealed && field === 'text')) return;
    select(id); setEditing({ id, field });
    requestAnimationFrame(() => {
      const input = root.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-note="${id}"] ${field === 'title' ? 'input' : 'textarea'}`);
      input?.focus({ preventScroll: true }); if (field === 'title') input?.select();
    });
  }
  function zoomTo(zoom: number, point?: Point) {
    if (locked) return;
    const old = current.current.camera;
    const rect = root.current!.getBoundingClientRect();
    const pivot = point ?? { x: rect.width / 2, y: rect.height / 2 };
    const next = clamp(zoom, .15, 3);
    camera({ zoom: next, x: pivot.x - (pivot.x - old.x) * next / old.zoom, y: pivot.y - (pivot.y - old.y) * next / old.zoom });
  }
  function add(point?: Point) {
    if (locked) return;
    if (current.current.notes.length >= 1000) { setNotice('На доске уже 1000 заметок. Удалите ненужные, чтобы добавить новую.'); return; }
    const rect = root.current!.getBoundingClientRect();
    const p = point ?? { x: rect.width / 2, y: rect.height / 2 };
    const cam = current.current.camera;
    const note: NoteData = { id: crypto.randomUUID(), title: 'Заметка', kind: 'text', width: 272, height: 248, text: '', pinned: false, mentions: [], color: colors[current.current.notes.length % colors.length], x: clamp(snap((p.x - cam.x) / cam.zoom - 136), -1e9, 1e9), y: clamp(snap((p.y - cam.y) / cam.zoom - 100), -1e9, 1e9) };
    const bounds = groupBounds(current.current.groups, current.current.notes);
    update({ ...current.current, notes: [...current.current.notes, note] }); assignGroups([note.id], bounds); select(note.id); setSelectedIds([]); chooseMode('select');
  }
  function patch(id: string, patch: Partial<NoteData>) {
    update({ ...current.current, notes: current.current.notes.map(n => {
      if (n.id !== id) return n;
      const next = { ...n, ...patch, ...(n.sealed && patch.title !== undefined ? { sealed: { ...n.sealed, visibleTitle: true } } : {}) };
      if (n.pinned) { next.x = n.x; next.y = n.y; next.width = n.width; next.height = n.height; }
      if (patch.text !== undefined && !n.sealed) next.mentions = mentionIds(patch.text).filter(target => target !== id);
      return next;
    }) });
  }
  function remove(id: string) {
    const note = current.current.notes.find(n => n.id === id);
    if (!note || noteBusy === id) return;
    const group = current.current.groups.find(g => g.noteIds.includes(id));
    const removed = new Set([id, ...(group?.noteIds.length === 1 ? [group.id] : [])]);
    setLastDeleted({ note, group, connections: current.current.connections.filter(edge => removed.has(edge.source) || removed.has(edge.target)) });
    update(cleanGroups({ ...current.current, notes: current.current.notes.filter(n => n.id !== id) })); select(null); setSelectedIds(ids => ids.filter(item => item !== id)); setEditing(null); setConnection(null);
  }
  function removeEdge(id: string) { if (id.startsWith('mention:')) return; update({ ...current.current, connections: current.current.connections.filter(edge => edge.id !== id) }); selectEdge(null); editEdge(null); }
  function connect(source: string, target: string) {
    if (source === target) return;
    const edges = current.current.connections;
    const existing = edges.find(edge => edge.source === source && edge.target === target);
    if (existing) { selectEdge(existing.id); setConnection(null); return; }
    if (edges.length >= 4000) { setNotice('На доске уже 4000 связей.'); setConnection(null); return; }
    const edge: ConnectionData = { id: crypto.randomUUID(), source, target, label: '', style: 'solid' };
    update({ ...current.current, connections: [...edges, edge] }); selectEdge(edge.id); select(null); setConnection(null);
  }
  async function addImages(files: File[], point?: Point) {
    if (locked || imageBusy) return;
    setImageBusy(true);
    try {
      for (const [index, file] of files.entries()) {
        const decoded = await readImage(file);
        if (!alive.current) return;
        if (current.current.notes.length >= 1000) throw new Error('На доске уже 1000 заметок.');
        const rect = root.current!.getBoundingClientRect(), cam = current.current.camera;
        const p = point ?? { x: (rect.width / 2 - cam.x) / cam.zoom, y: (rect.height / 2 - cam.y) / cam.zoom };
        const width = clamp(snap(decoded.ratio >= 1 ? 320 : 240), 160, 2048);
        const height = clamp(snap(width / decoded.ratio + 40), 120, 640);
        const note: NoteData = { id: crypto.randomUUID(), kind: 'image', title: file.name.slice(0, 240), text: '', pinned: false, mentions: [], color: 'sky', width, height, image: decoded.image, x: clamp(snap(p.x - width / 2 + index * 24), -1e9, 1e9), y: clamp(snap(p.y - height / 2 + index * 24), -1e9, 1e9) };
        const next = { ...current.current, notes: [...current.current.notes, note] };
        if (new TextEncoder().encode(JSON.stringify(next)).byteLength > MAX_BOARD_BYTES) throw new Error('На доске недостаточно места для картинки (лимит 23 МБ).');
        const bounds = groupBounds(current.current.groups, current.current.notes);
        update(next); assignGroups([note.id], bounds); select(note.id); setSelectedIds([]); chooseMode('select');
      }
    } catch (error) { if (alive.current) setNotice(error instanceof Error ? error.message : 'Не удалось добавить картинку.'); }
    finally { if (alive.current) setImageBusy(false); if (imageInput.current) imageInput.current.value = ''; }
  }
  function fit() {
    if (locked) return;
    const notes = current.current.notes;
    if (!notes.length) { camera({ x: 0, y: 0, zoom: 1 }); return; }
    const rect = root.current!.getBoundingClientRect();
    const left = Math.min(...notes.map(n => n.x)), top = Math.min(...notes.map(n => n.y));
    const width = Math.max(...notes.map(n => n.x + n.width)) - left;
    const height = Math.max(...notes.map(n => n.y + n.height)) - top;
    const zoom = clamp(Math.min((rect.width - 64) / width, (rect.height - 220) / height, 1.2), .15, 3);
    camera({ zoom, x: (rect.width - width * zoom) / 2 - left * zoom, y: (rect.height - height * zoom) / 2 - top * zoom });
  }
  useEffect(() => {
    const el = root.current!;
    function wheel(e: WheelEvent) {
      if (locked || (e.target as HTMLElement).closest('textarea, input, .floating, .note-tools')) return;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) zoomTo(current.current.camera.zoom * Math.exp(-e.deltaY * .008), local({ x: e.clientX, y: e.clientY }));
      else { const old = current.current.camera; const factor = e.deltaMode === 1 ? 16 : 1; camera({ ...old, x: old.x - e.deltaX * factor, y: old.y - e.deltaY * factor }); }
    }
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [locked]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; clearTimeout(focusTimer.current); }; }, []);
  useEffect(() => {
    function paste(e: ClipboardEvent) {
      if (locked || interactionBlocked || (e.target as HTMLElement).closest('input, textarea, [contenteditable]')) return;
      const text = e.clipboardData?.getData('text/plain') ?? '';
      if (text.startsWith(CLIPBOARD_PREFIX)) { e.preventDefault(); void pasteNotes(text); return; }
      const files = [...(e.clipboardData?.files ?? [])].filter(file => file.type.startsWith('image/'));
      if (files.length) { e.preventDefault(); void addImages(files); }
    }
    window.addEventListener('paste', paste);
    function copy(e: ClipboardEvent) {
      if (locked || interactionBlocked || (e.target as HTMLElement).closest('input, textarea, [contenteditable]') || !selectedNotes().length) return;
      e.preventDefault(); void copyNotes(e.type === 'cut');
    }
    window.addEventListener('copy', copy); window.addEventListener('cut', copy);
    return () => { window.removeEventListener('paste', paste); window.removeEventListener('copy', copy); window.removeEventListener('cut', copy); };
  }, [locked, imageBusy, interactionBlocked, selected, selectedIds, selectedGroup, noteBusy]);
  useEffect(() => {
    const editing = (e: KeyboardEvent) => (e.target as HTMLElement).matches('textarea, input, [contenteditable]');
    function down(e: KeyboardEvent) {
      if (locked || interactionBlocked) return;
      const command = e.ctrlKey || e.metaKey;
      if (command && e.code === 'KeyF') { e.preventDefault(); openSearch(); return; }
      if (editing(e)) return;
      if (command) {
        if (e.code === 'KeyA') { e.preventDefault(); clearSelection(); setSelectedIds(current.current.notes.map(note => note.id)); return; }
        if (e.code === 'KeyD') { e.preventDefault(); clearSelection(); root.current?.focus({ preventScroll: true }); return; }
        if (e.code === 'KeyC' || e.code === 'KeyX') { e.preventDefault(); if (!e.repeat) void copyNotes(e.code === 'KeyX'); return; }
        // Ctrl/Cmd+V goes through the native paste event so clipboard and image
        // access do not require a second permission prompt.
        if (e.code === 'Space') {
          e.preventDefault(); setSpace(false);
          if (!e.repeat) { const modes = ['select', 'hand', 'connect'] as const; chooseMode(modes[(modes.indexOf(mode as typeof modes[number]) + 1) % modes.length]); }
          return;
        }
        return;
      }
      if (e.code === 'Space') { e.preventDefault(); setSpace(true); }
      if (e.key === 'Escape') { clearSelection(); setSearchOpen(false); }
      if (e.code === 'KeyN' && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); add(); }
      if (e.code === 'KeyG' && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); makeGroup(); }
      if ((e.key === 'Delete' || e.key === 'Backspace') && (selected || selectedEdge)) { e.preventDefault(); if (selectedEdge) removeEdge(selectedEdge); else if (selected) remove(selected); }
      if (e.key === '0' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); fit(); }
    }
    function up(e: KeyboardEvent) { if (e.code === 'Space') setSpace(false); }
    function blur() { setSpace(false); pointers.current.clear(); gesture.current = null; pinch.current = null; setDragging(false); }
    window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', blur);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', blur); };
  }, [locked, selected, selectedEdge, selectedIds, selectedGroup, noteBusy, mode, interactionBlocked]);
  function pointerDown(e: PointerEvent) {
    if (locked || interactionBlocked || e.button > 1) return;
    const target = e.target as HTMLElement;
    if (target.closest('.floating, .note-tools')) return;
    clearTimeout(focusTimer.current); setCameraFocusing(false);
    const noteEl = target.closest<HTMLElement>('[data-note]');
    const groupEl = target.closest<HTMLElement>('[data-group]');
    const pan = hand || space || e.button === 1;
    if (noteBusy && (noteEl?.dataset.note === noteBusy || (groupEl && current.current.groups.find(g => g.id === groupEl.dataset.group)?.noteIds.includes(noteBusy)))) return;
    if (!pan && target.closest('input, textarea')) return;
    e.preventDefault();
    root.current!.focus({ preventScroll: true });
    const capture = target instanceof Element ? target : root.current!;
    capture.setPointerCapture(e.pointerId); captures.current.set(e.pointerId, capture);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (e.shiftKey && e.button === 0) {
      gesture.current = { kind: 'selection', pointer: e.pointerId, start: { x: e.clientX, y: e.clientY }, camera: { ...current.current.camera }, selection: selectedIds };
      const point = world({ x: e.clientX, y: e.clientY });
      setSelectionRect({ ...point, width: 0, height: 0 }); select(null); selectGroup(null); setEditing(null); editGroup(null); selectEdge(null); setConnection(null); return;
    }
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), midpoint: local({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }), camera: { ...current.current.camera } };
      gesture.current = null; setConnection(null); return;
    }
    const note = !pan && noteEl ? current.current.notes.find(n => n.id === noteEl.dataset.note) : undefined;
    const group = !pan && groupEl ? groupBounds(current.current.groups, current.current.notes).find(g => g.id === groupEl.dataset.group) : undefined;
    select(note?.id ?? null); selectGroup(group?.id ?? null); selectEdge(null); editEdge(null); setEditing(null); editGroup(null);
    const edge = target.closest<HTMLElement>('[data-resize]')?.dataset.resize;
    const endpoint = note ?? group;
    const kind = endpoint && mode === 'connect' ? 'connect' : group ? 'group' : note ? edge ? 'resize' : 'note' : 'pan';
    if (((kind === 'note' || kind === 'resize') && note?.pinned) || (kind === 'group' && group?.noteIds.some(id => current.current.notes.find(n => n.id === id)?.pinned))) {
      gesture.current = null; setConnection(null); return;
    }
    if (kind === 'connect' && endpoint) {
      const source = endpoints().find(n => n.id === draftRef.current?.source) ?? endpoint;
      setConnection({ source: source.id, point: world({ x: e.clientX, y: e.clientY }), target: source.id === endpoint.id ? undefined : endpoint.id });
    } else setConnection(null);
    const ids = group?.noteIds ?? (note && selectedIds.includes(note.id) ? selectedIds : note ? [note.id] : []);
    if (!note || !selectedIds.includes(note.id)) setSelectedIds([]);
    gesture.current = { kind, pointer: e.pointerId, start: { x: e.clientX, y: e.clientY }, camera: { ...current.current.camera }, note, edge, group: group?.id, moved: current.current.notes.filter(n => ids.includes(n.id) && n.id !== noteBusy && !n.pinned), bounds: groupBounds(current.current.groups, current.current.notes) };
  }
  function pointerMove(e: PointerEvent) {
    if (mode === 'connect' && draftRef.current && !pinch.current) {
      const point = world({ x: e.clientX, y: e.clientY });
      const target = connectionTarget(e, draftRef.current.source);
      setConnection({ ...draftRef.current, point, target: target?.id });
    }
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.current && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()], p = pinch.current;
      const zoom = clamp(p.camera.zoom * Math.hypot(a.x - b.x, a.y - b.y) / p.distance, .15, 3);
      const mid = local({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      camera({ zoom, x: mid.x - (p.midpoint.x - p.camera.x) * zoom / p.camera.zoom, y: mid.y - (p.midpoint.y - p.camera.y) * zoom / p.camera.zoom }); return;
    }
    const g = gesture.current;
    if (!g || g.pointer !== e.pointerId) return;
    const dx = e.clientX - g.start.x, dy = e.clientY - g.start.y;
    if (g.kind === 'selection') {
      const a = world(g.start), b = world({ x: e.clientX, y: e.clientY });
      const rect = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
      setSelectionRect(rect);
      setSelectedIds([...new Set([...(g.selection ?? []), ...current.current.notes.filter(note => intersects(rect, note)).map(note => note.id)])]);
      return;
    }
    if (g.kind === 'connect' || Math.hypot(dx, dy) < 3) return;
    setDragging(true);
    if (g.kind === 'resize' && g.note && g.edge) {
      if (current.current.notes.find(n => n.id === g.note!.id)?.pinned) return;
      const note = g.note;
      const right = snap(note.x + note.width), bottom = snap(note.y + note.height);
      let x = snap(note.x), y = snap(note.y), width = snap(note.width), height = snap(note.height);
      if (g.edge.includes('e')) width = clamp(snap(note.width + dx / g.camera.zoom), 160, 2048);
      if (g.edge.includes('s')) height = clamp(snap(note.height + dy / g.camera.zoom), 120, 2048);
      if (g.edge.includes('w')) { x = clamp(snap(note.x + dx / g.camera.zoom), right - 2048, right - 160); width = right - x; }
      if (g.edge.includes('n')) { y = clamp(snap(note.y + dy / g.camera.zoom), bottom - 2048, bottom - 120); height = bottom - y; }
      patch(note.id, { x: clamp(x, -1e9, 1e9), y: clamp(y, -1e9, 1e9), width, height });
    } else if ((g.kind === 'note' || g.kind === 'group') && g.moved?.length) {
      const moved = new Map(g.moved.map(note => [note.id, note]));
      update({ ...current.current, notes: current.current.notes.map(note => {
        const original = moved.get(note.id);
        return original && !note.pinned ? { ...note, x: clamp(snap(original.x + dx / g.camera.zoom), -1e9, 1e9), y: clamp(snap(original.y + dy / g.camera.zoom), -1e9, 1e9) } : note;
      }) });
    }
    else camera({ ...g.camera, x: g.camera.x + dx, y: g.camera.y + dy });
  }
  function pointerUp(e: PointerEvent) {
    if (gesture.current?.kind === 'connect' && draftRef.current && e.type !== 'pointercancel') {
      const value = draftRef.current;
      const target = connectionTarget(e, value.source);
      if (target) connect(value.source, target.id);
    }
    const g = gesture.current;
    if (g?.kind === 'note' && g.moved && g.bounds && Math.hypot(e.clientX - g.start.x, e.clientY - g.start.y) >= 3) assignGroups(g.moved.map(n => n.id), g.bounds);
    if (g?.kind === 'selection' && Math.hypot(e.clientX - g.start.x, e.clientY - g.start.y) < 3) {
      const point = world({ x: e.clientX, y: e.clientY });
      const note = [...current.current.notes].reverse().find(n => contains(n, point));
      if (note) setSelectedIds(ids => ids.includes(note.id) ? ids.filter(id => id !== note.id) : [...ids, note.id]);
    }
    setSelectionRect(null);
    if (e.type === 'pointercancel') setConnection(null);
    pointers.current.delete(e.pointerId); pinch.current = null; gesture.current = null; setDragging(false);
    const capture = captures.current.get(e.pointerId);
    if (capture?.hasPointerCapture(e.pointerId)) capture.releasePointerCapture(e.pointerId);
    captures.current.delete(e.pointerId);
    const remaining = [...pointers.current.entries()][0];
    if (remaining) gesture.current = { kind: 'pan', pointer: remaining[0], start: remaining[1], camera: { ...current.current.camera } };
  }
  const cam = board.camera;
  const groupRects = useMemo(() => groupBounds(board.groups, board.notes), [board.groups, board.notes]);
  const connectionEndpoints = useMemo(() => [...groupRects, ...board.notes], [groupRects, board.notes]);
  const routed = useMemo(() => routeConnections(connectionEndpoints, [...board.connections, ...mentionConnections(board.notes)]), [connectionEndpoints, board.connections, board.notes]);
  const draftSource = connectionEndpoints.find(n => n.id === draft?.source);
  const draftPath = draft && draftSource ? draftConnection(draftSource, draft.point, connectionEndpoints.find(n => n.id === draft.target)).path : undefined;
  return <div ref={root} className={`board ${hand || space ? 'pan-mode' : ''} ${mode === 'connect' ? 'connect-mode' : ''} ${dragging ? 'dragging' : ''}`} tabIndex={locked ? -1 : 0} aria-label="Бесконечная доска" data-testid="board"
    style={{ backgroundSize: `${24 * cam.zoom}px ${24 * cam.zoom}px, ${GRID_SIZE * cam.zoom}px ${GRID_SIZE * cam.zoom}px`, backgroundPosition: `${cam.x}px ${cam.y}px`, '--micro-opacity': cam.zoom >= .65 ? '1' : '0' }}
    onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp}
    onDragOver={e => { if (!locked && e.dataTransfer?.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }}
    onDrop={e => { if (locked) return; e.preventDefault(); void addImages([...(e.dataTransfer?.files ?? [])], world({ x: e.clientX, y: e.clientY })); }}
    onDblClick={e => { if ((mode === 'select' || mode === 'group') && !e.composedPath().some(target => target instanceof Element && target.matches('[data-note], .floating, .connections, .group-label'))) add(local({ x: e.clientX, y: e.clientY })); }}>
    <input ref={imageInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" multiple hidden onChange={e => void addImages([...(e.currentTarget.files ?? [])])} />
    <div className={`world ${cameraFocusing ? 'camera-focusing' : ''}`} style={{ transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.zoom})` }}>
      {groupRects.map(group => <section key={group.id} data-group={group.id} className={`group-frame ${selectedGroup === group.id ? 'selected' : ''} ${draft?.target === group.id ? 'connection-target' : ''}`} style={{ left: group.x, top: group.y, width: group.width, height: group.height }}>
        <div className="group-label" onDblClick={e => { e.stopPropagation(); if (mode !== 'connect' && !hand) { editGroup(group.id); requestAnimationFrame(() => root.current?.querySelector<HTMLInputElement>(`[data-group="${group.id}"] input`)?.focus({ preventScroll: true })); } }}>
          {editingGroup === group.id ? <input aria-label="Название группы" maxLength={240} value={group.title} onInput={e => update({ ...current.current, groups: current.current.groups.map(g => g.id === group.id ? { ...g, title: e.currentTarget.value } : g) })} onBlur={() => editGroup(null)} onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') editGroup(null); }} /> : <span>{group.title || 'Группа'}</span>}
          {selectedGroup === group.id && <Button icon="close" label="Разгруппировать" onPointerDown={e => e.stopPropagation()} onDblClick={e => e.stopPropagation()} onClick={() => ungroup(group.id)} />}
        </div>
      </section>)}
      <Connections edges={routed} draft={draftPath} selected={selectedEdge} editing={editingEdge}
        toggleStyle={id => update({ ...current.current, connections: current.current.connections.map(edge => edge.id === id ? { ...edge, style: edge.style === 'dashed' ? 'solid' : 'dashed' } : edge) })}
        select={id => { selectEdge(id); select(null); setEditing(null); }} edit={editEdge} remove={removeEdge}
        change={(id, label) => update({ ...current.current, connections: current.current.connections.map(edge => edge.id === id ? { ...edge, label } : edge) })} />
      {board.notes.map(note => <article key={note.id} data-note={note.id} className={`note pigment-${note.color} ${note.pinned ? 'pinned-note' : ''} ${note.kind === 'image' ? 'image-note' : ''} ${note.sealed ? 'sealed-note' : ''} ${selectedIds.includes(note.id) ? 'multi-selected' : ''} ${selected === note.id ? 'selected' : ''} ${draft?.target === note.id ? 'connection-target' : ''} ${draft?.source === note.id ? 'connection-source' : ''}`} style={{ transform: `translate(${note.x}px, ${note.y}px)`, width: note.width, height: note.height }} onFocusIn={() => select(note.id)}>
        <div className="note-handle" aria-label="Заголовок заметки">
          {editing?.id === note.id && editing.field === 'title' ? <input className="note-title" aria-label="Название заметки" value={note.title} maxLength={240} readOnly={noteBusy === note.id} onInput={e => patch(note.id, { title: e.currentTarget.value })} onBlur={() => setEditing(null)} onKeyDown={e => { if (e.key === 'Enter' || e.key === 'Escape') { e.stopPropagation(); setEditing(null); } }} /> : <span className="note-title" onDblClick={e => { e.stopPropagation(); startEditing(note.id, 'title'); }}>{note.title || 'Заметка'}</span>}
          <span className="grip"><Icon name="grip" size={16} /></span>
        </div>
        {note.sealed ? <div className="sealed-cover">
          <div className="sealed-placeholder" aria-hidden="true"><i /><i /><i /><i /><i /></div>
          <Button className="unseal-button" icon={noteBusy === note.id ? undefined : 'lock'} label="Разблокировать заметку" disabled={Boolean(noteBusy) || clipboardWorking} onPointerDown={e => e.stopPropagation()} onDblClick={e => e.stopPropagation()} onClick={() => void onToggleLock(note.id)}>{noteBusy === note.id && <span className="spinner" />}</Button>
        </div> : <>
        {note.kind === 'image' ? <div className="note-image"><img src={note.image} alt={note.title} draggable={false} /></div> : <NoteBody note={note} notes={noteCatalog} editing={editing?.id === note.id && editing.field === 'text'} busy={noteBusy === note.id} change={text => patch(note.id, { text })} edit={() => startEditing(note.id, 'text')} done={() => setEditing(null)} follow={focusNote} />}
        {note.kind === 'text' && <div className="note-footer"><span>{note.text.length ? `${note.text.length.toLocaleString('ru')} зн.` : ''}</span></div>}
        </>}
        <div className="note-tools" aria-label="Параметры заметки">
          {note.kind === 'text' && !note.sealed && <div className="swatches">{colors.map(color => <button type="button" className={`swatch pigment-${color}`} aria-label={labels[color]} title={labels[color]} disabled={noteBusy === note.id} aria-pressed={note.color === color} onClick={() => patch(note.id, { color })}>{note.color === color && <Icon name="check" size={12} />}</button>)}</div>}
          {!note.sealed && <Button icon="lock" label="Заблокировать заметку" disabled={Boolean(noteBusy) || clipboardWorking} onClick={() => { setEditing(null); setLastDeleted(null); gesture.current = null; void onToggleLock(note.id); }} />}
          <Button icon={note.pinned ? 'unpin' : 'pin'} label={note.pinned ? 'Снять фиксацию заметки' : 'Зафиксировать заметку'} aria-pressed={Boolean(note.pinned)} className={note.pinned ? 'pin-active' : ''} disabled={noteBusy === note.id} onClick={() => { gesture.current = null; patch(note.id, { pinned: !note.pinned }); }} />
          <Button icon="trash" label="Удалить заметку" className="delete-note" disabled={noteBusy === note.id} onClick={() => remove(note.id)} />
        </div>
        {!note.pinned && (mode === 'select' || mode === 'group') && ['n', 'e', 's', 'w', 'ne', 'se', 'sw', 'nw'].map(edge => <span className={`resize-handle resize-${edge}`} data-resize={edge} aria-hidden="true" />)}
      </article>)}
    </div>
    {selectionRect && <div className="selection-rect" aria-hidden="true" style={{ left: selectionRect.x * cam.zoom + cam.x, top: selectionRect.y * cam.zoom + cam.y, width: selectionRect.width * cam.zoom, height: selectionRect.height * cam.zoom }} />}
    {!locked && <>
      <div className="board-bottom">
        <div className="toolbar floating" role="toolbar" aria-label="Инструменты доски">
          <Button icon="cursor" label="Выбирать и перемещать заметки" className={mode === 'select' ? 'active' : ''} aria-pressed={mode === 'select'} onClick={() => chooseMode('select')} />
          <Button icon="hand" label="Перемещать доску" className={hand ? 'active' : ''} aria-pressed={hand} onClick={() => chooseMode('hand')} />
          <Button icon="connect" label="Создавать связи" className={mode === 'connect' ? 'active' : ''} aria-pressed={mode === 'connect'} onClick={() => chooseMode('connect')} />
          <Button icon="group" label="Сгруппировать выделенные заметки (G)" className={mode === 'group' ? 'active' : ''} aria-pressed={mode === 'group'} disabled={selectedIds.length < 2} onClick={makeGroup} />
          <span className="tool-divider" />
          <Button icon="plus" label="Добавить заметку (N)" className="add-note" onClick={() => add()}><span>Заметка</span></Button>
          <Button icon="image" label="Добавить картинку" disabled={imageBusy} onClick={() => imageInput.current?.click()} />
          <Button icon="search" label="Поиск (Ctrl/⌘ F)" className={searchOpen ? 'active' : ''} aria-expanded={searchOpen} onClick={openSearch} />
          <span className="tool-divider" />
          <Button icon="minus" label="Уменьшить масштаб" onClick={() => zoomTo(cam.zoom / 1.2)} disabled={cam.zoom <= .15} />
          <button type="button" className="zoom-value" aria-label="Масштаб 100%" onClick={() => zoomTo(1)}>{Math.round(cam.zoom * 100)}%</button>
          <Button icon="plus" label="Увеличить масштаб" onClick={() => zoomTo(cam.zoom * 1.2)} disabled={cam.zoom >= 3} />
          <Button icon="fit" label="Показать все заметки (0)" onClick={fit} />
        </div>
        <div className="toolbar floating board-actions" role="toolbar" aria-label="Сохранение и доступ">{actions}</div>
      </div>
      {searchOpen && <SearchPopover query={searchQuery} count={searchMatches.length} index={Math.min(searchIndex, Math.max(0, searchMatches.length - 1))} change={value => { setSearchQuery(value); setSearchIndex(0); }} step={stepSearch} close={closeSearch} />}
      {lastDeleted && <UndoToast key={lastDeleted.note.id} dismiss={() => setLastDeleted(null)} undo={() => {
        if (current.current.notes.length >= 1000) { setNotice('На доске уже 1000 заметок.'); return; }
        const notes = [...current.current.notes, lastDeleted.note];
        let groups = current.current.groups;
        if (lastDeleted.group) {
          const previous = lastDeleted.group;
          groups = groups.some(g => g.id === previous.id) ? groups.map(g => g.id === previous.id ? { ...g, noteIds: [...g.noteIds, lastDeleted.note.id] } : g) : [...groups, { ...previous, noteIds: [lastDeleted.note.id] }];
        }
        update(cleanGroups({ ...current.current, notes, groups, connections: [...current.current.connections, ...lastDeleted.connections].slice(0, 4000) })); setLastDeleted(null);
      }} />}
      {notice && <div className="undo-toast floating" role="alert">{notice}<Button icon="close" label="Закрыть уведомление" onClick={() => setNotice('')} /></div>}
    </>}
  </div>;
}
