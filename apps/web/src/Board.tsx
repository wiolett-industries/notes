import { boardModeShortcut } from './board-hotkeys';
import { t, quotaMessage, localizeError, countLabel, isStorageLimit } from './locale';
import { useEffect, useId, useMemo, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { colors, GRID_SIZE, MAX_BOARD_BYTES, type BoardData, type NoteData, type NoteColor, type ConnectionData, type GroupData } from '@quiet/shared';
import { Button, Icon } from './ui';
import { Connections } from './Connections';
import { clamp, snap, center, prepareConnectionRouting, routePreparedConnections, draftConnection, magneticTarget, groupBounds, cleanGroups, contains, intersects, type Point, type Rect, type Endpoint } from './geometry';
import { readImage } from './images';
import { isTextFile, readTextFile } from './text-files';
import { UndoToast } from './UndoToast';
import { Modal } from './Modal';
import { SearchPopover } from './SearchPopover';
import { CLIPBOARD_PREFIX, copySelection, writeSelection, readSelection, pasteSelection } from './board-clipboard';
import { NoteBody } from './NoteBody';
import { mentionConnections, mentionIds } from './markdown';
import './board-cursors.css';
import { participantColor as peerColor } from './participant-color';
import { alignmentGuides, type GuideLine } from './geometry';

const labels: Record<NoteColor, string> = { sand: t("Песочный"), sage: t("Шалфей"), rose: t("Розовый"), lavender: t("Лавандовый"), sky: t("Голубой") };
type DragPosition = { id: string; x: number; y: number; width: number; height: number };
type Props = { board: BoardData; onChange: (board: BoardData) => void; onStorageLimit?: () => void; onImportBatch?: () => Promise<boolean>; locked?: boolean; noteBusy?: string | null; onToggleLock: (id: string) => Promise<void>; actions?: ComponentChildren; clipboardKey: CryptoKey; accountId: string; interactionBlocked?: boolean; role?: 'owner' | 'editor' | 'viewer'; publicView?: boolean; peers?: { id: string; uid: string; role: string; color?: number; x: number; y: number; selection?: string[] }[]; onCursor?: (point: Point | null) => void; onSelection?: (ids: string[]) => void; onDrag?: (positions: DragPosition[] | null) => void; dragPreviews?: Record<string, Omit<DragPosition, 'id'>> };
type Gesture = { axis?: 'x' | 'y'; kind: 'pan' | 'note' | 'resize' | 'connect' | 'selection' | 'group'; pointer: number; start: Point; camera: BoardData['camera']; note?: NoteData; edge?: string; moved?: NoteData[]; bounds?: ReturnType<typeof groupBounds>; selection?: string[]; group?: string; speedSample?: Point & { time: number }; fastSamples?: number; fastDistance?: number; detached?: Map<string, string> };
type Draft = { source: string; point: Point; target?: string };
export function Board({ board: incoming, onChange, onStorageLimit, onImportBatch, locked = false, noteBusy = null, onToggleLock, actions, clipboardKey, accountId, interactionBlocked = false, role = 'owner', publicView = false, peers = [], onCursor, onSelection, onDrag, dragPreviews }: Props) {
  const board = incoming;
  const root = useRef<HTMLDivElement>(null);
  const current = useRef(board); current.current = board;
  const access = useRef(role); access.current = role;
  const indexCache = useRef<{ notes: NoteData[]; groups: GroupData[]; byId: Map<string, NoteData>; protectedMembers: Set<string> } | null>(null);
  function noteIndex() {
    const { notes, groups } = current.current;
    if (indexCache.current?.notes === notes && indexCache.current.groups === groups) return indexCache.current;
    const byId = new Map(notes.map(note => [note.id, note]));
    const protectedMembers = new Set<string>();
    for (const group of groups) if (group.noteIds.some(id => { const note = byId.get(id); return note?.sealed || note?.pinned; })) {
      for (const id of group.noteIds) protectedMembers.add(id);
    }
    return indexCache.current = { notes, groups, byId, protectedMembers };
  }
  const writable = role !== 'viewer';
  function canWrite() { return access.current !== 'viewer'; }
  function canEdit(note: NoteData) { return access.current === 'owner' || (access.current === 'editor' && !note.sealed && !note.pinned); }
  function canMove(note: NoteData) { return access.current !== 'viewer' && !note.pinned; }
  function canGroup(ids: string[]) {
    if (access.current === 'owner') return true;
    if (access.current === 'viewer') return false;
    const { byId, protectedMembers } = noteIndex();
    return ids.every(id => { const note = byId.get(id); return note && canEdit(note) && !protectedMembers.has(id); });
  }
  const catalogCache = useRef<{ id: string; title: string }[]>([]);
  const noteCatalog = useMemo(() => {
    const previous = catalogCache.current;
    if (previous.length === board.notes.length && board.notes.every((note, index) => note.id === previous[index].id && note.title === previous[index].title)) return previous;
    return catalogCache.current = board.notes.map(({ id, title }) => ({ id, title }));
  }, [board.notes]);
  const mentionCatalog = useMemo(() => [...noteCatalog, ...board.groups.map(group => ({ id: group.id, title: group.title, group: true }))], [noteCatalog, board.groups]);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [selected, select] = useState<string | null>(null);
  const [mode, setMode] = useState<'select' | 'hand' | 'connect' | 'group'>(publicView ? 'hand' : 'select');
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
  const [previewId, setPreviewId] = useState<string | null>(null);
  const previewNote = board.notes.find(note => note.id === previewId && !note.sealed);
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
  const [axis, setAxis] = useState<'x' | 'y' | null>(null);
  const guideId = useId();
  const [notice, setNotice] = useState('');
  useEffect(() => { if (isStorageLimit(notice) && onStorageLimit) { onStorageLimit(); setNotice(''); } }, [notice]);
  const [lastDeleted, setLastDeleted] = useState<{ id: string; notes: NoteData[]; connections: ConnectionData[]; groups: GroupData[] } | null>(null);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture | null>(null);
  const pinch = useRef<{ distance: number; midpoint: Point; camera: BoardData['camera'] } | null>(null);
  const dragCallback = useRef(onDrag); dragCallback.current = onDrag;
  const dragFrame = useRef<number | null>(null);
  const pendingDrag = useRef<DragPosition[] | null>(null);
  function endDragPreview() {
    if (dragFrame.current !== null) cancelAnimationFrame(dragFrame.current);
    dragFrame.current = null; pendingDrag.current = null;
    dragCallback.current?.(null);
  }
  function previewDrag(ids: string[]) {
    if (!canWrite() || !dragCallback.current) return;
    const { byId } = noteIndex();
    pendingDrag.current = ids.flatMap(id => {
      const note = byId.get(id);
      return note && canMove(note) ? [{ id, x: note.x, y: note.y, width: note.width, height: note.height }] : [];
    });
    if (dragFrame.current !== null) return;
    dragFrame.current = requestAnimationFrame(() => {
      dragFrame.current = null;
      if (canWrite() && pendingDrag.current?.length) dragCallback.current?.(pendingDrag.current);
      pendingDrag.current = null;
    });
  }
  function update(next: BoardData) {
    const previous = current.current;
    if (access.current === 'viewer') return;
    if (access.current === 'editor') {
      const originals = noteIndex().byId;
      const notes = next.notes.flatMap(note => {
        const original = originals.get(note.id);
        if (!original) return note.sealed || note.pinned ? [] : [note];
        if (original.pinned) return [original];
        if (original.sealed) return [{ ...original, x: note.x, y: note.y, width: note.width, height: note.height }];
        return [{ ...note, pinned: original.pinned, sealed: original.sealed }];
      });
      const remainingIds = new Set(notes.map(note => note.id));
      for (const note of previous.notes) if (!canEdit(note) && !remainingIds.has(note.id)) notes.push(note);
      const protectedIds = new Set(previous.notes.filter(note => !canEdit(note)).map(note => note.id));
      const protectedGroups = previous.groups.filter(group => group.noteIds.some(id => protectedIds.has(id)));
      const protectedGroupIds = new Set(protectedGroups.map(group => group.id));
      const reservedIds = new Set([...protectedIds, ...protectedGroups.flatMap(group => group.noteIds)]);
      const groups = next.groups.filter(group => !protectedGroupIds.has(group.id)).map(group => ({ ...group, noteIds: group.noteIds.filter(id => !reservedIds.has(id)) }));
      next = cleanGroups({ ...next, lockKeys: previous.lockKeys, notes, groups: [...groups, ...protectedGroups] });
    }
    current.current = next; onChange(next);
  }
  function camera(value: BoardData['camera']) {
    // Camera changes stay local and never pass through data-mutation guards.
    const next = { ...current.current, camera: { x: clamp(value.x, -1e9, 1e9), y: clamp(value.y, -1e9, 1e9), zoom: clamp(value.zoom, .15, 3) } };
    current.current = next; onChange(next);
  }
  function local(point: Point) {
    const rect = root.current!.getBoundingClientRect(); return { x: point.x - rect.left, y: point.y - rect.top };
  }
  function world(point: Point) {
    const p = local(point), cam = current.current.camera;
    return { x: (p.x - cam.x) / cam.zoom, y: (p.y - cam.y) / cam.zoom };
  }
  function setConnection(value: Draft | null) { draftRef.current = value; setDraft(value); }
  function chooseMode(value: typeof mode) { if (publicView && value !== 'hand') return; if (access.current === 'viewer' && (value === 'connect' || value === 'group')) return; setMode(value); setConnection(null); setEditing(null); editEdge(null); editGroup(null); }
  function clearSelection() {
    select(null); selectEdge(null); selectGroup(null); setSelectedIds([]); setSelectionRect(null);
    setConnection(null); setEditing(null); editEdge(null); editGroup(null);
  }
  function selectedNotes() {
    const ids = selectedIds.length ? selectedIds : selected ? [selected] : current.current.groups.find(g => g.id === selectedGroup)?.noteIds ?? [];
    const { byId } = noteIndex();
    return ids.filter(id => byId.has(id));
  }
  const selectionCallback = useRef(onSelection); selectionCallback.current = onSelection;
  const selectionSignature = useMemo(() => JSON.stringify([...new Set(selectedNotes())].sort()), [selected, selectedIds, selectedGroup, board.notes, board.groups]);
  useEffect(() => { selectionCallback.current?.(JSON.parse(selectionSignature) as string[]); }, [selectionSignature]);
  const remoteSelections = useMemo(() => {
    const byNote = new Map<string, Set<string>>();
    for (const peer of peers) for (const id of peer.selection ?? []) {
      let users = byNote.get(id);
      if (!users) { users = new Set(); byNote.set(id, users); }
      users.add(peer.uid);
    }
    return new Map([...byNote].map(([id, users]) => {
      const uids = [...users].sort();
      return [id, { uids, color: peerColor(uids[0], peers.find(peer => peer.uid === uids[0])?.color), label: `${uids[0].slice(0, 8)}${uids.length > 1 ? ` +${uids.length - 1}` : ''}` }];
    }));
  }, [peers]);
  function openSearch() {
    setSearchOpen(true); setEditing(null); editEdge(null); editGroup(null); setConnection(null);
    requestAnimationFrame(() => { const input = root.current?.querySelector<HTMLInputElement>('.search-popover input'); input?.focus({ preventScroll: true }); input?.select(); });
  }
  function closeSearch() { setSearchOpen(false); root.current?.focus({ preventScroll: true }); }
  function focusNote(id: string) {
    const note = current.current.notes.find(n => n.id === id) ?? groupBounds(current.current.groups, current.current.notes).find(group => group.id === id);
    const rect = root.current?.getBoundingClientRect();
    if (!note || !rect) return;
    const zoom = clamp(Math.min((rect.width - 96) / note.width, (rect.height - 240) / note.height, 1.2), .15, 3);
    clearSelection(); if (!publicView) { if ('noteIds' in note) selectGroup(id); else select(id); }
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
    if (cut && access.current === 'viewer') return;
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
        const unchanged = new Set(current.current.notes.filter(note => canEdit(note) && copied.get(note.id) === JSON.stringify(note)).map(note => note.id));
        update(cleanGroups({ ...current.current, notes: current.current.notes.filter(note => !unchanged.has(note.id)) }));
        clearSelection(); setLastDeleted(null);
        if (unchanged.size !== ids.length) setNotice(t("Изменённые во время копирования заметки оставлены на доске."));
      }
    } catch { if (alive.current) setNotice(cut ? t("Не удалось записать заметки в буфер обмена. Вырезание отменено.") : t("Не удалось записать заметки в буфер обмена.")); }
    finally { clipboardBusy.current = false; if (alive.current) setClipboardWorking(false); }
  }
  async function pasteNotes(text: string) {
    if (access.current === 'viewer') return;
    if (clipboardBusy.current || noteBusy || interactionBlocked) return;
    clipboardBusy.current = true; setClipboardWorking(true);
    try {
      const copied = await readSelection(clipboardKey, accountId, text);
      if (!canWrite()) return;
      if (access.current === 'editor' && copied.notes.some(note => note.sealed || note.pinned)) { setNotice(t("Нельзя вставить защищённые заметки.")); return; }
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
    } catch (error) { if (alive.current) setNotice(error instanceof Error ? localizeError(error) : t("Не удалось вставить заметки.")); }
    finally { clipboardBusy.current = false; if (alive.current) setClipboardWorking(false); }
  }
  function endpoints(): Endpoint[] { return [...groupBounds(current.current.groups, current.current.notes), ...current.current.notes]; }
  function connectionTarget(e: PointerEvent, source: string) {
    const element = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-note], [data-group]');
    const id = element?.dataset.note ?? element?.dataset.group;
    const parent = current.current.groups.find(group => group.noteIds.includes(source))?.id;
    if (id === source || (parent && id === parent)) return undefined;
    const targets = endpoints().filter(endpoint => endpoint.id !== parent), point = world({ x: e.clientX, y: e.clientY });
    const direct = targets.find(endpoint => endpoint.id === id);
    if (direct) return direct;
    const anchor = targets.find(endpoint => endpoint.id === source);
    if (anchor && contains(anchor, point)) return undefined;
    return magneticTarget(targets, point, source, current.current.camera.zoom);
  }
  function makeGroup() {
    const ids = selectedIds.filter(id => noteIndex().byId.has(id));
    if (ids.length > 1000) return;
    if (!canGroup(ids)) return;
    if (ids.length < 2) return;
    if (current.current.groups.length >= 500) { setNotice(t("На доске уже 500 групп.")); return; }
    const group = { id: crypto.randomUUID(), title: t("Группа"), noteIds: ids };
    const groupedIds = new Set(ids);
    const groups = current.current.groups.map(g => ({ ...g, noteIds: g.noteIds.filter(id => !groupedIds.has(id)) }));
    update(cleanGroups({ ...current.current, groups: [...groups, group] }));
    selectGroup(group.id); setSelectedIds([]); select(null); chooseMode('group');
  }
  function ungroup(id: string) {
    if (!canGroup(current.current.groups.find(group => group.id === id)?.noteIds ?? [])) return;
    update(cleanGroups({ ...current.current, groups: current.current.groups.filter(g => g.id !== id) }));
    selectGroup(null); editGroup(null);
  }
  function assignGroups(ids: string[], bounds: ReturnType<typeof groupBounds>, detached?: Map<string, string>) {
    if (access.current === 'viewer') return;
    const { byId } = noteIndex();
    const assigned = new Set<string>();
    const additions = new Map<string, string[]>();
    const eligibleBounds = bounds.filter(rect => canGroup(rect.noteIds) && current.current.groups.some(group => group.id === rect.id));
    for (const id of ids) {
      const note = byId.get(id);
      if (!note || !canGroup([id])) continue;
      if (detached && current.current.groups.some(group => group.noteIds.includes(id))) continue;
      const point = center(note);
      let target: typeof bounds[number] | undefined;
      for (const rect of eligibleBounds) if (rect.id !== detached?.get(id) && contains(rect, point) && (!target || rect.width * rect.height < target.width * target.height)) target = rect;
      if (detached && !target) continue;
      assigned.add(id);
      if (target) { const members = additions.get(target.id) ?? []; members.push(id); additions.set(target.id, members); }
    }
    if (!assigned.size) return false;
    const groups = current.current.groups.map(group => group.noteIds.some(id => assigned.has(id)) || additions.has(group.id) ? { ...group, noteIds: [...group.noteIds.filter(id => !assigned.has(id)), ...(additions.get(group.id) ?? [])] } : group);
    update(cleanGroups({ ...current.current, groups }));
    return true;
  }
  function startEditing(id: string, field: 'title' | 'text') {
    if (hand || mode === 'connect' || locked || noteBusy === id) return;
    const note = current.current.notes.find(n => n.id === id);
    if (!note || !canEdit(note) || note.kind === 'image' || (note.sealed && field === 'text')) return;
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
  function add(point?: Point, textOnly = false) {
    if (locked || access.current === 'viewer') return;
    if (current.current.notes.length >= 10000) { setNotice(t("На доске уже 10000 заметок. Удалите ненужные, чтобы добавить новую.")); return; }
    const rect = root.current!.getBoundingClientRect();
    const p = point ?? { x: rect.width / 2, y: rect.height / 2 };
    const cam = current.current.camera;
    const note: NoteData = { id: crypto.randomUUID(), title: t("Заметка"), kind: 'text', width: 272, height: 248, text: '', pinned: false, mentions: [], color: colors[current.current.notes.length % colors.length], x: clamp(snap((p.x - cam.x) / cam.zoom - 136), -1e9, 1e9), y: clamp(snap((p.y - cam.y) / cam.zoom - 100), -1e9, 1e9) };
    if (textOnly) { note.textStyle = { level: 0, bold: false, italic: false, underline: false }; note.text = t('Текст'); note.height = 120; }
    const bounds = groupBounds(current.current.groups, current.current.notes);
    update({ ...current.current, notes: [...current.current.notes, note] }); assignGroups([note.id], bounds); select(note.id); setSelectedIds([]); chooseMode('select');
  }
  function patch(id: string, patch: Partial<NoteData>) {
    if (access.current === 'viewer') return;
    update({ ...current.current, notes: current.current.notes.map(n => {
      if (n.id !== id) return n;
      const next = { ...n, ...patch, ...(n.sealed && patch.title !== undefined ? { sealed: { ...n.sealed, visibleTitle: true } } : {}) };
      if (n.pinned) { next.x = n.x; next.y = n.y; next.width = n.width; next.height = n.height; }
      if (patch.text !== undefined && !n.sealed) next.mentions = mentionIds(patch.text).filter(target => target !== id);
      return next;
    }) });
  }
  function remove(ids: string | string[]) {
    const selected = new Set(typeof ids === 'string' ? [ids] : ids);
    const notes = current.current.notes.filter(note => selected.has(note.id) && canEdit(note) && noteBusy !== note.id);
    if (!notes.length) return;
    const removed = new Set(notes.map(note => note.id));
    const groups = current.current.groups.filter(group => group.noteIds.some(id => removed.has(id)));
    const endpoints = new Set([...removed, ...groups.filter(group => group.noteIds.every(id => removed.has(id))).map(group => group.id)]);
    setLastDeleted({ id: crypto.randomUUID(), notes, groups, connections: current.current.connections.filter(edge => endpoints.has(edge.source) || endpoints.has(edge.target)) });
    update(cleanGroups({ ...current.current, notes: current.current.notes.filter(note => !removed.has(note.id)) })); clearSelection();
  }
  function removeEdge(id: string) { if (access.current === 'viewer' || id.startsWith('mention:')) return; update({ ...current.current, connections: current.current.connections.filter(edge => edge.id !== id) }); selectEdge(null); editEdge(null); }
  function connect(source: string, target: string) {
    if (access.current === 'viewer') return;
    if (source === target) return;
    if (current.current.groups.some(group => group.id === target && group.noteIds.includes(source))) return;
    const edges = current.current.connections;
    const existing = edges.find(edge => edge.source === source && edge.target === target);
    if (existing) { selectEdge(existing.id); setConnection(null); return; }
    if (edges.length >= 40000) { setNotice(t("На доске уже 40000 связей.")); setConnection(null); return; }
    const edge: ConnectionData = { id: crypto.randomUUID(), source, target, label: '', style: 'solid' };
    update({ ...current.current, connections: [...edges, edge] }); selectEdge(edge.id); select(null); setConnection(null);
  }
  async function addImages(files: File[], point?: Point) {
    if (locked || imageBusy || access.current === 'viewer') return;
    setImageBusy(true);
    let pending: NoteData[] = [];
    const failures: string[] = [];
    async function commitBatch() {
      if (!pending.length) return true;
      if (!alive.current || !canWrite()) return false;
      const batch = pending; pending = [];
      const bounds = groupBounds(current.current.groups, current.current.notes);
      update({ ...current.current, notes: [...current.current.notes, ...batch] });
      assignGroups(batch.map(item => item.id), bounds);
      select(batch.at(-1)!.id); setSelectedIds([]); chooseMode('select');
      return onImportBatch ? onImportBatch() : true;
    }
    try {
      const encoder = new TextEncoder();
      let bytes = encoder.encode(JSON.stringify({ ...current.current, notes: [] })).byteLength;
      for (const note of current.current.notes) bytes += encoder.encode(JSON.stringify(note)).byteLength + 1;
      for (const [index, file] of files.entries()) {
        await new Promise(resolve => setTimeout(resolve, 0));
        let text: string | null, decoded: Awaited<ReturnType<typeof readImage>> | null;
        try {
          text = isTextFile(file) ? await readTextFile(file) : null;
          decoded = text === null ? await readImage(file) : null;
        } catch (error) {
          failures.push(`${file.name}: ${error instanceof Error ? localizeError(error) : t('Не удалось добавить картинку.')}`);
          continue;
        }
        if (!alive.current || !canWrite()) return;
        if (current.current.notes.length + pending.length >= 10000) throw new Error(t("На доске уже 10000 заметок."));
        const rect = root.current!.getBoundingClientRect(), cam = current.current.camera;
        const p = point ?? { x: (rect.width / 2 - cam.x) / cam.zoom, y: (rect.height / 2 - cam.y) / cam.zoom };
        const width = decoded ? clamp(snap(decoded.ratio >= 1 ? 320 : 240), 160, 2048) : 320;
        const height = decoded ? clamp(snap(width / decoded.ratio + 40), 120, 640) : 320;
        const note: NoteData = { id: crypto.randomUUID(), kind: decoded ? 'image' : 'text', title: file.name.slice(0, 240), text: text ?? '', pinned: false, mentions: [], color: 'sky', width, height, ...(decoded ? { image: decoded.image } : {}), x: clamp(snap(p.x - width / 2 + index * 24), -1e9, 1e9), y: clamp(snap(p.y - height / 2 + index * 24), -1e9, 1e9) };
        bytes += new TextEncoder().encode(JSON.stringify(note)).byteLength + 1;
        if (bytes > MAX_BOARD_BYTES) throw new Error(quotaMessage(MAX_BOARD_BYTES));
        pending.push(note);
        if (pending.length >= 4 || index === files.length - 1) {
          if (!(await commitBatch())) return;
        }
      }
      await commitBatch();
      if (alive.current && failures.length) setNotice(failures.slice(0, 3).join('\n'));
    } catch (error) {
      await commitBatch();
      if (alive.current) setNotice(error instanceof Error ? localizeError(error) : t("Не удалось добавить картинку."));
    }
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
    let owner: HTMLElement | null = null, lastWheel = -Infinity;
    function wheel(e: WheelEvent) {
      const target = e.target as HTMLElement;
      if (locked || target.closest('input, .floating, .note-tools, dialog')) return;
      const now = performance.now();
      if (e.ctrlKey || e.metaKey) {
        lastWheel = -Infinity; owner = null; e.preventDefault();
        zoomTo(current.current.camera.zoom * Math.exp(-e.deltaY * .008), local({ x: e.clientX, y: e.clientY }));
        return;
      }
      // A wheel burst belongs to its starting surface, including inertial events.
      if (now - lastWheel > 220) {
        const candidates = [target.closest<HTMLElement>('.note-content pre, .note-content table'), target.closest<HTMLElement>('.note-content, .note textarea')];
        owner = candidates.find(element => element && (element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth)) ?? null;
      }
      lastWheel = now;
      e.preventDefault();
      const factor = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
      if (owner) {
        if (owner.isConnected) { owner.scrollLeft += e.deltaX * factor; owner.scrollTop += e.deltaY * factor; }
      } else {
        const old = current.current.camera;
        camera({ ...old, x: old.x - e.deltaX * factor, y: old.y - e.deltaY * factor });
      }
    }
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [locked]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; clearTimeout(focusTimer.current); endDragPreview(); }; }, []);
  useEffect(() => {
    const element = root.current!;
    const measure = () => {
      const { width, height } = element.getBoundingClientRect();
      setViewportSize(previous => previous.width === width && previous.height === height ? previous : { width, height });
    };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    clearSelection(); setMode(publicView ? 'hand' : 'select'); setLastDeleted(null);
    endDragPreview();
    gesture.current = null; pinch.current = null; pointers.current.clear(); setDragging(false);
    for (const [id, element] of captures.current) if (element.hasPointerCapture(id)) element.releasePointerCapture(id);
    captures.current.clear();
  }, [role, publicView]);
  useEffect(() => {
    function paste(e: ClipboardEvent) {
      if (locked || access.current === 'viewer' || interactionBlocked || (e.target as HTMLElement).closest('input, textarea, [contenteditable]')) return;
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
  }, [locked, imageBusy, interactionBlocked, selected, selectedIds, selectedGroup, noteBusy, role]);
  useEffect(() => {
    const editing = (e: KeyboardEvent) => (e.target as HTMLElement).closest('textarea, input, select, [contenteditable]');
    function down(e: KeyboardEvent) {
      if (locked || interactionBlocked || previewId) return;
      const command = e.ctrlKey || e.metaKey;
      if (command && e.code === 'KeyF') { e.preventDefault(); openSearch(); return; }
      if (editing(e)) return;
      if (command) {
        if (e.code === 'KeyA') { e.preventDefault(); clearSelection(); if (!publicView) setSelectedIds(current.current.notes.map(note => note.id)); return; }
        if (e.code === 'KeyD') { e.preventDefault(); clearSelection(); root.current?.focus({ preventScroll: true }); return; }
        if (e.code === 'KeyC' || e.code === 'KeyX') { e.preventDefault(); if (!e.repeat) void copyNotes(e.code === 'KeyX'); return; }
        // Ctrl/Cmd+V goes through the native paste event so clipboard and image
        // access do not require a second permission prompt.
        if (e.code === 'Space') {
          e.preventDefault(); setSpace(false);
          if (!e.repeat) { const modes: (typeof mode)[] = publicView ? ['hand'] : access.current === 'viewer' ? ['select', 'hand'] : ['select', 'hand', 'connect']; chooseMode(modes[(modes.indexOf(mode) + 1) % modes.length]); }
          return;
        }
        return;
      }
      const shortcut = boardModeShortcut(e, access.current === 'viewer');
      if (shortcut) { e.preventDefault(); if (!e.repeat) chooseMode(shortcut); return; }
      if (e.code === 'Space') { e.preventDefault(); setSpace(true); }
      if (e.key === 'Escape') { clearSelection(); setSearchOpen(false); }
      if (e.code === 'KeyN' && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); add(); }
      if (e.code === 'KeyG' && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); makeGroup(); }
      if ((e.key === 'Delete' || e.key === 'Backspace') && (selectedNotes().length || selectedEdge)) { e.preventDefault(); if (selectedEdge) removeEdge(selectedEdge); else remove(selectedNotes()); }
      if (e.key === '0' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); fit(); }
    }
    function up(e: KeyboardEvent) {
      if (e.code === 'Space') setSpace(false);
      if (e.key === 'Shift' && !e.shiftKey) { if (gesture.current) delete gesture.current.axis; setAxis(null); }
    }
    function blur() { setSpace(false); setAxis(null); pointers.current.clear(); gesture.current = null; pinch.current = null; setDragging(false); endDragPreview(); }
    window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', blur);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', blur); };
  }, [locked, selected, selectedEdge, selectedIds, selectedGroup, noteBusy, mode, interactionBlocked, role, publicView, previewId]);
  function pointerDown(e: PointerEvent) {
    if (locked || interactionBlocked || e.button > 1) return;
    const target = e.target as HTMLElement;
    if (target.closest('.floating, .note-tools, dialog')) return;
    clearTimeout(focusTimer.current); setCameraFocusing(false);
    const noteEl = target.closest<HTMLElement>('[data-note]');
    const groupEl = target.closest<HTMLElement>('[data-group]');
    const pan = hand || space || e.button === 1;
    if (noteBusy && (noteEl?.dataset.note === noteBusy || (groupEl && current.current.groups.find(g => g.id === groupEl.dataset.group)?.noteIds.includes(noteBusy)))) return;
    if (!pan && target.closest('input, textarea')) return;
    e.preventDefault();
    root.current!.focus({ preventScroll: true });
    // Pan/selection must survive culling. Note targets stay mounted while
    // selected/dragged and retain native click/dblclick dispatch for editing.
    const capture = pan || e.shiftKey || (!noteEl && !groupEl) ? root.current! : target;
    capture.setPointerCapture(e.pointerId); captures.current.set(e.pointerId, capture);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!publicView && e.shiftKey && e.button === 0) {
      gesture.current = { kind: 'selection', pointer: e.pointerId, start: { x: e.clientX, y: e.clientY }, camera: { ...current.current.camera }, selection: selectedNotes() };
      const point = world({ x: e.clientX, y: e.clientY });
      setSelectionRect({ ...point, width: 0, height: 0 }); select(null); selectGroup(null); setEditing(null); editGroup(null); selectEdge(null); setConnection(null); return;
    }
    if (pointers.current.size === 2) {
      endDragPreview();
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
    if (access.current === 'viewer' && kind !== 'pan') { gesture.current = null; setConnection(null); return; }
    if (((kind === 'note' || kind === 'resize') && note?.pinned) || (kind === 'group' && group?.noteIds.some(id => noteIndex().byId.get(id)?.pinned))) {
      gesture.current = null; setConnection(null); return;
    }
    if (kind === 'connect' && endpoint) {
      const source = endpoints().find(n => n.id === draftRef.current?.source) ?? endpoint;
      setConnection({ source: source.id, point: world({ x: e.clientX, y: e.clientY }), target: source.id === endpoint.id ? undefined : endpoint.id });
    } else setConnection(null);
    const ids = group?.noteIds ?? (note && selectedIds.includes(note.id) ? selectedIds : note ? [note.id] : []);
    const movedIds = new Set(ids);
    if (!note || !selectedIds.includes(note.id)) setSelectedIds([]);
    gesture.current = { kind, pointer: e.pointerId, start: { x: e.clientX, y: e.clientY }, camera: { ...current.current.camera }, note, edge, group: group?.id, moved: current.current.notes.filter(n => movedIds.has(n.id) && n.id !== noteBusy && !n.pinned), bounds: groupBounds(current.current.groups, current.current.notes) };
    if (kind === 'note') { gesture.current.speedSample = { x: e.clientX, y: e.clientY, time: e.timeStamp }; gesture.current.detached = new Map(); }
  }
  function pointerMove(e: PointerEvent) {
    const target = document.elementFromPoint(e.clientX, e.clientY);
    const overBoard = target && root.current?.contains(target) && !target.closest('.floating, .note-tools');
    onCursor?.(overBoard ? world({ x: e.clientX, y: e.clientY }) : null);
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
    if (access.current === 'viewer' && g.kind !== 'pan' && g.kind !== 'selection') return;
    let dx = e.clientX - g.start.x, dy = e.clientY - g.start.y;
    if (g.kind === 'note' || g.kind === 'group') {
      if (e.shiftKey) {
        g.axis ??= Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
        setAxis(g.axis);
        if (g.axis === 'x') dy = 0; else dx = 0;
      } else { delete g.axis; setAxis(null); }
    }
    if (g.kind === 'selection') {
      if (Math.hypot(e.clientX - g.start.x, e.clientY - g.start.y) < 3) return;
      const a = world(g.start), b = world({ x: e.clientX, y: e.clientY });
      const rect = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
      setSelectionRect(rect);
      setSelectedIds([...new Set([...(g.selection ?? []), ...current.current.notes.filter(note => intersects(rect, note)).map(note => note.id)])]);
      return;
    }
    if (g.kind === 'connect' || Math.hypot(dx, dy) < 3) return;
    setDragging(true);
    if (g.kind === 'resize' && g.note && g.edge) {
      const active = current.current.notes.find(n => n.id === g.note!.id);
      if (!active || !canMove(active)) return;
      const note = g.note;
      const right = snap(note.x + note.width), bottom = snap(note.y + note.height);
      let x = snap(note.x), y = snap(note.y), width = snap(note.width), height = note.textStyle ? active.height : snap(note.height);
      if (g.edge.includes('e')) width = clamp(snap(note.width + dx / g.camera.zoom), 160, 2048);
      if (!note.textStyle && g.edge.includes('s')) height = clamp(snap(note.height + dy / g.camera.zoom), 120, 2048);
      if (g.edge.includes('w')) { x = clamp(snap(note.x + dx / g.camera.zoom), right - 2048, right - 160); width = right - x; }
      if (!note.textStyle && g.edge.includes('n')) { y = clamp(snap(note.y + dy / g.camera.zoom), bottom - 2048, bottom - 120); height = bottom - y; }
      patch(note.id, { x: clamp(x, -1e9, 1e9), y: clamp(y, -1e9, 1e9), width, height });
      previewDrag([note.id]);
    } else if ((g.kind === 'note' || g.kind === 'group') && g.moved?.length) {
      if (g.kind === 'note' && g.speedSample) {
        const elapsed = e.timeStamp - g.speedSample.time;
        if (elapsed >= 24) {
          const distance = Math.hypot(e.clientX - g.speedSample.x, e.clientY - g.speedSample.y);
          // Screen-space speed makes the gesture consistent at every board zoom.
          const fast = elapsed <= 80 && distance / elapsed >= 2;
          g.fastSamples = fast ? (g.fastSamples ?? 0) + 1 : 0;
          g.fastDistance = fast ? (g.fastDistance ?? 0) + distance : 0;
          if (g.fastSamples >= 3 && g.fastDistance >= 120) {
            const movedIds = new Set(g.moved.map(note => note.id));
            const groups = current.current.groups.map(group => ({ ...group, noteIds: group.noteIds.filter(id => {
              if (!movedIds.has(id) || !canGroup(group.noteIds)) return true;
              g.detached!.set(id, group.id); return false;
            }) }));
            update(cleanGroups({ ...current.current, groups }));
            g.fastSamples = 0; g.fastDistance = 0;
          }
          g.speedSample = { x: e.clientX, y: e.clientY, time: e.timeStamp };
        }
      }
      const moved = new Map(g.moved.map(note => [note.id, note]));
      update({ ...current.current, notes: current.current.notes.map(note => {
        const original = moved.get(note.id);
        return original && canMove(note) ? { ...note, x: clamp(snap(original.x + dx / g.camera.zoom), -1e9, 1e9), y: clamp(snap(original.y + dy / g.camera.zoom), -1e9, 1e9) } : note;
      }) });
      if (g.kind === 'note' && g.bounds && assignGroups(g.moved.map(note => note.id), g.bounds, g.detached)) {
        g.fastSamples = 0; g.fastDistance = 0;
        g.speedSample = { x: e.clientX, y: e.clientY, time: e.timeStamp };
      }
      previewDrag(g.moved.map(note => note.id));
    }
    else camera({ ...g.camera, x: g.camera.x + dx, y: g.camera.y + dy });
  }
  function pointerUp(e: PointerEvent) {
    setAxis(null);
    endDragPreview();
    if (gesture.current?.kind === 'connect' && draftRef.current && e.type !== 'pointercancel') {
      const value = draftRef.current;
      const target = connectionTarget(e, value.source);
      if (target) connect(value.source, target.id);
    }
    const g = gesture.current;
    if (g?.kind === 'note' && g.moved && g.bounds && e.type !== 'pointercancel' && Math.hypot(e.clientX - g.start.x, e.clientY - g.start.y) >= 3) assignGroups(g.moved.map(n => n.id), g.bounds, g.detached);
    if (g?.kind === 'selection' && Math.hypot(e.clientX - g.start.x, e.clientY - g.start.y) < 3) {
      const point = world({ x: e.clientX, y: e.clientY });
      const note = [...current.current.notes].reverse().find(n => contains(n, point));
      if (note) { const ids = g.selection ?? []; setSelectedIds(ids.includes(note.id) ? ids.filter(id => id !== note.id) : [...ids, note.id]); }
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
  const viewport = useMemo<Rect>(() => ({ x: (-cam.x - 300) / cam.zoom, y: (-cam.y - 300) / cam.zoom,
    width: ((viewportSize.width || 1024) + 600) / cam.zoom, height: ((viewportSize.height || 768) + 600) / cam.zoom }), [cam.x, cam.y, cam.zoom, viewportSize]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  // Only the pointer's anchor must survive culling, even when a drag moves
  // thousands of selected notes. Offscreen selection never forces mounting.
  const retainedNotes = new Set([selected, editing?.id, noteBusy, draft?.source, draft?.target, gesture.current?.note?.id]);
  const visualNotes = useMemo(() => {
    if (!dragPreviews || !Object.keys(dragPreviews).length) return board.notes;
    return board.notes.map(note => {
      const preview = dragPreviews[note.id];
      return preview ? { ...note, x: preview.x, y: preview.y, width: preview.width, height: preview.height } : note;
    });
  }, [board.notes, dragPreviews]);
  const visibleNotes = visualNotes.filter(note => retainedNotes.has(note.id) || intersects(note, viewport));
  const groupRects = useMemo(() => groupBounds(board.groups, visualNotes), [board.groups, visualNotes]);
  const moving = gesture.current;
  const guideTarget = dragging && (moving?.kind === 'note' || moving?.kind === 'group')
    ? moving.group ? groupRects.find(group => group.id === moving.group) : visualNotes.find(note => note.id === moving.note?.id) : undefined;
  const guides: (GuideLine & { axisEnd?: 'start' | 'end' })[] = guideTarget ? alignmentGuides(guideTarget, visualNotes, new Set(moving?.moved?.map(note => note.id)), cam.zoom) : [];
  if (guideTarget && axis) {
    const extension = 300 / cam.zoom, middle = center(guideTarget);
    if (axis === 'x') guides.unshift(
      { x1: guideTarget.x - extension, y1: middle.y, x2: guideTarget.x, y2: middle.y, axisEnd: 'start' },
      { x1: guideTarget.x + guideTarget.width, y1: middle.y, x2: guideTarget.x + guideTarget.width + extension, y2: middle.y, axisEnd: 'end' });
    else guides.unshift(
      { x1: middle.x, y1: guideTarget.y - extension, x2: middle.x, y2: guideTarget.y, axisEnd: 'start' },
      { x1: middle.x, y1: guideTarget.y + guideTarget.height, x2: middle.x, y2: guideTarget.y + guideTarget.height + extension, axisEnd: 'end' });
  }
  const visibleGroups = groupRects.filter(group => group.id === selectedGroup || group.id === editingGroup || group.id === gesture.current?.group || intersects(group, viewport));
  const connectionEndpoints = useMemo(() => [...groupRects, ...visualNotes], [groupRects, visualNotes]);
  const allConnections = useMemo(() => [...board.connections, ...mentionConnections(board.notes, board.groups)], [board.connections, board.notes, board.groups]);
  const preparedRoutes = useMemo(() => prepareConnectionRouting(connectionEndpoints, allConnections), [connectionEndpoints, allConnections]);
  const routed = useMemo(() => routePreparedConnections(preparedRoutes, viewport, new Set([selectedEdge, editingEdge].filter((id): id is string => Boolean(id)))), [preparedRoutes, viewport, selectedEdge, editingEdge]);
  const draftSource = connectionEndpoints.find(n => n.id === draft?.source);
  const draftPath = draft && draftSource ? draftConnection(draftSource, draft.point, connectionEndpoints.find(n => n.id === draft.target)).path : undefined;
  return <div ref={root} className={`board ${hand || space ? 'pan-mode' : ''} ${mode === 'connect' ? 'connect-mode' : ''} ${dragging ? 'dragging' : ''}`} tabIndex={locked ? -1 : 0} aria-label={t("Бесконечная доска")} data-testid="board"
    style={{ backgroundSize: `${24 * cam.zoom}px ${24 * cam.zoom}px, ${GRID_SIZE * cam.zoom}px ${GRID_SIZE * cam.zoom}px`, backgroundPosition: `${cam.x}px ${cam.y}px`, '--micro-opacity': cam.zoom >= .65 ? '1' : '0' }}
    onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} onPointerLeave={() => onCursor?.(null)}
    onDragOver={e => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = !locked && writable ? 'copy' : 'none'; } }}
    onDrop={e => { e.preventDefault(); if (locked || !writable) return; void addImages([...(e.dataTransfer?.files ?? [])], world({ x: e.clientX, y: e.clientY })); }}
    onDblClick={e => { const target = document.elementFromPoint(e.clientX, e.clientY); if (target?.closest('dialog, .floating, .note-tools')) return; const imageNote = target?.closest('.note-image')?.closest<HTMLElement>('[data-note]'); if (imageNote && mode !== 'connect') { setPreviewId(imageNote.dataset.note!); return; } if ((mode === 'select' || mode === 'group') && !e.composedPath().some(target => target instanceof Element && target.matches('[data-note], .floating, .connections, .group-label'))) add(local({ x: e.clientX, y: e.clientY })); }}>
    <input ref={imageInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" multiple hidden onChange={e => void addImages([...(e.currentTarget.files ?? [])])} />
    <div className={`world ${cameraFocusing ? 'camera-focusing' : ''}`} style={{ transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.zoom})` }}>
      {guides.length > 0 && <svg className="drag-guides" width="1" height="1" aria-hidden="true">
        {guides.flatMap(line => {
          if (!guideTarget) return [line];
          const { x, y, width, height } = guideTarget;
          if (line.y1 === line.y2 && line.y1 >= y && line.y1 <= y + height) return [
            ...(line.x1 < x ? [{ ...line, x2: Math.min(line.x2, x) }] : []),
            ...(line.x2 > x + width ? [{ ...line, x1: Math.max(line.x1, x + width) }] : []),
          ];
          if (line.x1 === line.x2 && line.x1 >= x && line.x1 <= x + width) return [
            ...(line.y1 < y ? [{ ...line, y2: Math.min(line.y2, y) }] : []),
            ...(line.y2 > y + height ? [{ ...line, y1: Math.max(line.y1, y + height) }] : []),
          ];
          return [line];
        }).map((line, index) => {
          const { axisEnd, ...points } = line;
          const id = `${guideId}-${index}`, fade = Math.min(.45, 100 / cam.zoom / Math.hypot(line.x2 - line.x1, line.y2 - line.y1));
          const color = axisEnd ? 'var(--paper-outline, var(--accent))' : 'var(--accent)';
          const pigment = guideTarget && 'color' in guideTarget ? `pigment-${guideTarget.color}` : '';
          return <g key={index} className={pigment} data-axis-guide={axisEnd}><defs><linearGradient id={id} gradientUnits="userSpaceOnUse" {...points}>
            <stop offset="0" stop-color={color} stop-opacity={axisEnd === 'end' ? 1 : 0} /><stop offset={fade} stop-color={color} />
            <stop offset={1 - fade} stop-color={color} /><stop offset="1" stop-color={color} stop-opacity={axisEnd === 'start' ? 1 : 0} />
          </linearGradient></defs><line {...points} stroke={`url(#${id})`} stroke-width="1" stroke-dasharray="5 5" vector-effect="non-scaling-stroke" /></g>;
        })}
      </svg>}
      {visibleGroups.map(group => <section key={group.id} data-group={group.id} className={`group-frame ${selectedGroup === group.id ? 'selected' : ''} ${draft?.target === group.id ? 'connection-target' : ''}`} style={{ left: group.x, top: group.y, width: group.width, height: group.height }}>
        {mode === 'connect' && ['top', 'right', 'bottom', 'left'].map(side => <span className={`group-border group-border-${side}`} aria-hidden="true" />)}
        <div className="group-label" onDblClick={e => { e.stopPropagation(); if (canGroup(group.noteIds) && mode !== 'connect' && !hand) { editGroup(group.id); requestAnimationFrame(() => root.current?.querySelector<HTMLInputElement>(`[data-group="${group.id}"] input`)?.focus({ preventScroll: true })); } }}>
          {editingGroup === group.id && canGroup(group.noteIds) ? <input aria-label={t("Название группы")} maxLength={240} value={group.title} onInput={e => update({ ...current.current, groups: current.current.groups.map(g => g.id === group.id ? { ...g, title: e.currentTarget.value } : g) })} onBlur={() => editGroup(null)} onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') editGroup(null); }} /> : <span>{group.title || t("Группа")}</span>}
          {selectedGroup === group.id && canGroup(group.noteIds) && <Button icon="close" label={t("Разгруппировать")} onPointerDown={e => e.stopPropagation()} onDblClick={e => e.stopPropagation()} onClick={() => ungroup(group.id)} />}
        </div>
      </section>)}
      <Connections edges={routed} draft={writable ? draftPath : undefined} selected={selectedEdge} editing={writable ? editingEdge : null} readOnly={!writable}
        toggleStyle={id => update({ ...current.current, connections: current.current.connections.map(edge => edge.id === id ? { ...edge, style: edge.style === 'dashed' ? 'solid' : 'dashed' } : edge) })}
        select={id => { selectEdge(id); select(null); setEditing(null); }} edit={id => { if (access.current !== 'viewer') editEdge(id); }} remove={removeEdge}
        change={(id, label) => update({ ...current.current, connections: current.current.connections.map(edge => edge.id === id ? { ...edge, label } : edge) })} />
      {visibleNotes.map(note => <article key={note.id} data-note={note.id} className={`note pigment-${note.color} ${remoteSelections.has(note.id) ? 'remote-selected' : ''} ${note.textStyle ? 'text-only-note' : ''} ${note.pinned ? 'pinned-note' : ''} ${note.kind === 'image' ? 'image-note' : ''} ${note.sealed ? 'sealed-note' : ''} ${selectedSet.has(note.id) ? 'multi-selected' : ''} ${selected === note.id ? 'selected' : ''} ${draft?.target === note.id ? 'connection-target' : ''} ${draft?.source === note.id ? 'connection-source' : ''}`} style={{ transform: `translate(${note.x}px, ${note.y}px)`, width: note.width, height: note.height, '--peer-color': remoteSelections.get(note.id)?.color, '--text-size': `${[16, 36, 28, 22][note.textStyle?.level ?? 0]}px`, '--text-weight': note.textStyle?.bold ? 700 : 400, '--text-style': note.textStyle?.italic ? 'italic' : 'normal', '--text-align': note.textStyle?.align ?? 'left', '--text-decoration': note.textStyle?.underline ? 'underline' : 'none' }} onFocusIn={() => { if (!publicView) select(note.id); }}>
        {!note.textStyle && <div className="note-handle" aria-label={t("Заголовок заметки")}>
          {canEdit(note) && editing?.id === note.id && editing.field === 'title' ? <input className="note-title" aria-label={t("Название заметки")} value={note.title} maxLength={240} readOnly={noteBusy === note.id} onInput={e => patch(note.id, { title: e.currentTarget.value })} onBlur={() => setEditing(null)} onKeyDown={e => { if (e.key === 'Enter' || e.key === 'Escape') { e.stopPropagation(); setEditing(null); } }} /> : <span className="note-title" onDblClick={e => { e.stopPropagation(); startEditing(note.id, 'title'); }}>{note.title || t("Заметка")}</span>}
          {note.kind === 'image' && note.image && !note.sealed && <Button className="note-download" icon="download" label={t("Скачать изображение")} onPointerDown={e => e.stopPropagation()} onDblClick={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); const link = document.createElement('a'); link.href = note.image!; const extension = /^data:image\/(png|jpeg|webp|gif|avif);/.exec(note.image!)?.[1] ?? 'webp'; link.download = `${(note.title || 'image').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\.(png|jpe?g|webp|gif|avif)$/i, '')}.${extension === 'jpeg' ? 'jpg' : extension}`; document.body.append(link); link.click(); link.remove(); }} />}
          <span className="grip"><Icon name="grip" size={16} /></span>
        </div>}
        {note.sealed ? <div className="sealed-cover">
          <div className="sealed-placeholder" aria-hidden="true"><i /><i /><i /><i /><i /></div>
          <Button className="unseal-button" icon={noteBusy === note.id ? undefined : 'lock'} label={t("Разблокировать заметку")} disabled={role !== 'owner' || Boolean(noteBusy) || clipboardWorking} onPointerDown={e => e.stopPropagation()} onDblClick={e => e.stopPropagation()} onClick={() => { if (access.current === 'owner') void onToggleLock(note.id); }}>{noteBusy === note.id && <span className="spinner" />}</Button>
        </div> : <>
        {note.kind === 'image' ? <div className="note-image" onDblClick={event => { event.stopPropagation(); if (mode !== 'connect' && !note.sealed) setPreviewId(note.id); }}><img src={note.image} alt={note.title} draggable={false} /></div> : <NoteBody note={note} notes={mentionCatalog} editable={canEdit(note)} editing={canEdit(note) && editing?.id === note.id && editing.field === 'text'} busy={noteBusy === note.id} change={text => patch(note.id, { text })} edit={() => startEditing(note.id, 'text')} done={() => setEditing(null)} follow={focusNote} resize={height => { if (note.textStyle && !note.pinned && !note.sealed && canEdit(note) && note.height !== height) patch(note.id, { height }); }} />}
        {note.kind === 'text' && !note.textStyle && <div className="note-footer"><span>{note.text.length ? countLabel('characters', note.text.length) : ''}</span></div>}
        </>}
        <div className="note-tools" aria-label={t("Параметры заметки")}>
          {note.textStyle && !note.sealed && <>
            {[0, 1, 2, 3].map(level => <Button disabled={!canEdit(note)} aria-pressed={note.textStyle!.level === level} className={note.textStyle!.level === level ? 'pin-active' : ''} label={level ? `H${level}` : t('Обычный текст')} onClick={() => patch(note.id, { textStyle: { ...note.textStyle!, level } })}>{level ? `H${level}` : t('Обычный')}</Button>)}
            <Button icon="align-center" label={t("Текст по центру")} disabled={!canEdit(note)} aria-pressed={note.textStyle.align === 'center'} className={note.textStyle.align === 'center' ? 'pin-active' : ''} onClick={() => patch(note.id, { textStyle: { ...note.textStyle!, align: note.textStyle!.align === 'center' ? 'left' : 'center' } })} />
            {(['bold', 'italic', 'underline'] as const).map(style => <Button icon={style} label={t(style === 'bold' ? 'Жирный' : style === 'italic' ? 'Курсив' : 'Подчёркнутый')} disabled={!canEdit(note)} aria-pressed={note.textStyle![style]} className={note.textStyle![style] ? 'pin-active' : ''} onClick={() => patch(note.id, { textStyle: { ...note.textStyle!, [style]: !note.textStyle![style] } })} />)}
          </>}
          {note.kind === 'text' && !note.textStyle && !note.sealed && <div className="swatches">{colors.map(color => <button type="button" className={`swatch pigment-${color}`} aria-label={labels[color]} data-tooltip={labels[color]} disabled={!canEdit(note) || noteBusy === note.id} aria-pressed={note.color === color} onClick={() => patch(note.id, { color })}>{note.color === color && <Icon name="check" size={12} />}</button>)}</div>}
          {!note.sealed && !note.textStyle && <Button icon="lock" label={t("Заблокировать заметку")} disabled={role !== 'owner' || Boolean(noteBusy) || clipboardWorking} onClick={() => { if (access.current !== 'owner') return; setEditing(null); setLastDeleted(null); gesture.current = null; void onToggleLock(note.id); }} />}
          <Button icon={note.pinned ? 'unpin' : 'pin'} label={note.pinned ? t("Снять фиксацию заметки") : t("Зафиксировать заметку")} aria-pressed={Boolean(note.pinned)} className={note.pinned ? 'pin-active' : ''} disabled={role !== 'owner' || noteBusy === note.id} onClick={() => { if (access.current !== 'owner') return; gesture.current = null; patch(note.id, { pinned: !note.pinned }); }} />
          <Button icon="trash" label={t("Удалить заметку")} className="delete-note" disabled={!canEdit(note) || noteBusy === note.id} onClick={() => remove(note.id)} />
        </div>
        {canMove(note) && (mode === 'select' || mode === 'group') && (note.textStyle ? ['e', 'w'] : ['n', 'e', 's', 'w', 'ne', 'se', 'sw', 'nw']).map(edge => <span className={`resize-handle resize-${edge}`} data-resize={edge} aria-hidden="true" />)}
      </article>)}
      {visibleNotes.map(note => {
        const remote = remoteSelections.get(note.id);
        return remote && <span key={note.id} className="board-remote-selection-label" aria-label={t('Выбрали: {users}', { users: remote.uids.map(uid => uid.slice(0, 8)).join(', ') })} style={{ left: note.x, top: note.y, '--peer-color': remote.color }}>{remote.label}</span>;
      })}
    </div>
    {peers.length > 0 && <div className="board-peer-cursors" aria-hidden="true">
      {peers.filter(peer => Number.isFinite(peer.x) && Number.isFinite(peer.y)).map(peer => <div key={peer.id} className="board-peer-cursor" style={{ transform: `translate(${peer.x * cam.zoom + cam.x}px, ${peer.y * cam.zoom + cam.y}px)`, '--peer-color': peerColor(peer.uid, peer.color) }}>
        <Icon name="cursor" size={20} /><span>{peer.uid.length > 10 ? `${peer.uid.slice(0, 8)}…` : peer.uid} · {peer.role}</span>
      </div>)}
    </div>}
    {selectionRect && <div className="selection-rect" aria-hidden="true" style={{ left: selectionRect.x * cam.zoom + cam.x, top: selectionRect.y * cam.zoom + cam.y, width: selectionRect.width * cam.zoom, height: selectionRect.height * cam.zoom }} />}
    {!locked && <>
      <div className="board-bottom">
        <div className="toolbar floating" role="toolbar" aria-label={t("Инструменты доски")}>
          <Button icon="cursor" label={t("Выбирать и перемещать заметки (V)")} className={mode === 'select' ? 'active' : ''} aria-pressed={mode === 'select'} disabled={publicView} onClick={() => chooseMode('select')} />
          <Button icon="hand" label={t("Перемещать доску (H)")} className={hand ? 'active' : ''} aria-pressed={hand} onClick={() => chooseMode('hand')} />
          <Button icon="connect" label={t("Создавать связи (C)")} className={mode === 'connect' ? 'active' : ''} aria-pressed={mode === 'connect'} disabled={!writable} onClick={() => chooseMode('connect')} />
          <Button icon="group" label={t("Сгруппировать выделенные заметки (G)")} className={mode === 'group' ? 'active' : ''} aria-pressed={mode === 'group'} disabled={selectedIds.length < 2 || selectedIds.length > 1000 || !canGroup(selectedIds)} onClick={makeGroup} />
          <span className="tool-divider" />
          <Button icon="plus" label={t("Добавить заметку (N)")} className="add-note" disabled={!writable} onClick={() => add()}><span>{t("Заметка")}</span></Button>
          <Button icon="text" label={t("Добавить текст")} disabled={!writable} onClick={() => add(undefined, true)} />
          <Button icon="image" label={t("Добавить картинку")} disabled={!writable || imageBusy} onClick={() => imageInput.current?.click()} />
          <Button icon="search" label={t("Поиск (Ctrl/⌘ F)")} className={searchOpen ? 'active' : ''} aria-expanded={searchOpen} onClick={openSearch} />
          <span className="tool-divider" />
          <Button icon="minus" label={t("Уменьшить масштаб")} onClick={() => zoomTo(cam.zoom / 1.2)} disabled={cam.zoom <= .15} />
          <button type="button" className="zoom-value" aria-label={t("Масштаб 100%")} onClick={() => zoomTo(1)}>{Math.round(cam.zoom * 100)}%</button>
          <Button icon="plus" label={t("Увеличить масштаб")} onClick={() => zoomTo(cam.zoom * 1.2)} disabled={cam.zoom >= 3} />
          <Button icon="fit" label={t("Показать все заметки (0)")} onClick={fit} />
        </div>
        <div className="toolbar floating board-actions" role="toolbar" aria-label={t("Сохранение и доступ")}>{actions}</div>
      </div>
      {searchOpen && <SearchPopover query={searchQuery} count={searchMatches.length} index={Math.min(searchIndex, Math.max(0, searchMatches.length - 1))} change={value => { setSearchQuery(value); setSearchIndex(0); }} step={stepSearch} close={closeSearch} />}
      {lastDeleted && lastDeleted.notes.some(canEdit) && <UndoToast key={lastDeleted.id} count={lastDeleted.notes.length} dismiss={() => setLastDeleted(null)} undo={() => {
        const existing = new Set(current.current.notes.map(note => note.id));
        const restored = lastDeleted.notes.filter(note => canEdit(note) && !existing.has(note.id));
        if (current.current.notes.length + restored.length > 10000) { setNotice(t("На доске уже 10000 заметок.")); return; }
        const notes = [...current.current.notes, ...restored], restoredIds = new Set(restored.map(note => note.id));
        let groups = current.current.groups;
        for (const previous of lastDeleted.groups) {
          const ids = previous.noteIds.filter(id => restoredIds.has(id));
          if (!ids.length) continue;
          groups = groups.some(g => g.id === previous.id) ? groups.map(g => g.id === previous.id ? { ...g, noteIds: [...new Set([...g.noteIds, ...ids])] } : g) : [...groups, { ...previous, noteIds: ids }];
        }
        const edges = new Map(current.current.connections.map(edge => [edge.id, edge]));
        for (const edge of lastDeleted.connections) if (!edges.has(edge.id)) edges.set(edge.id, edge);
        update(cleanGroups({ ...current.current, notes, groups, connections: [...edges.values()].slice(0, 40000) })); setLastDeleted(null);
      }} />}
      {notice && <UndoToast key={notice} message={notice} dismiss={() => setNotice('')} />}
      <Modal open={Boolean(previewNote?.image)} close={() => setPreviewId(null)} label={previewNote?.title || t('Заметка')} className="image-preview">
        {previewNote?.image && <img src={previewNote.image} alt={previewNote.title} onClick={() => setPreviewId(null)} />}
      </Modal>
    </>}
  </div>;
}
