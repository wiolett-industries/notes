import { useEffect, useRef, useState } from 'preact/hooks';
import { BOARD_STORAGE_LIMIT, BOARD_LIMIT_MESSAGE, emptyBoard, type BoardData, type BoardEntry, type EntityVault, type NoteData } from '@quiet/shared';
import { Board } from './Board';
import { Button, Icon } from './ui';
import { BoardSocket } from './socket';
import { SharedSync } from './shared-sync';
import { decodeVault, entityId, prepareDelta } from './entities';
import { fromBase64, toBase64, decryptBoard } from './crypto';
import { identityFor, boardKey, boardSecret, wrapBoardKey, encryptValue, decryptValue, publicSnapshot, type SharingIdentity } from './sharing-crypto';
import { KeyDialog } from './KeyDialog';
import { unlockNote, authError, type Unlocked } from './passkey';
import { unlockWithKey } from './key-auth';
import { sealNote } from './note-lock';
import { Modal } from './Modal';
import { RoleDropdown } from './RoleDropdown';
import { participantColor } from './participant-color';

type NamedBoard = BoardEntry & { title: string; key: CryptoKey };
type Peer = { id: string; uid: string; role: string; color?: number; x: number; y: number; selection?: string[] };
type DragPosition = { id: string; x: number; y: number; width: number; height: number };
export function Workspace({ account, initialBoard, migrated, logout }: { account: Unlocked; initialBoard: BoardData; migrated: () => Promise<void>; logout: () => Promise<void> }) {
  const [entries, setEntries] = useState<NamedBoard[]>([]);
  const [selected, setSelected] = useState<NamedBoard | null>(null);
  const [board, setBoard] = useState<BoardData>(emptyBoard);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const [noteBusy, setNoteBusy] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [profile, setProfile] = useState(false), [copiedUid, setCopiedUid] = useState(false);
  const [deleting, setDeleting] = useState<NamedBoard | null>(null);
  const [limitReached, setLimitReached] = useState(false);
  function reportError(message: string) { if (message.includes('300 МБ')) { setLimitReached(true); setError(''); } else setError(message); }
  function usageBar(entry: NamedBoard) {
    const bytes = entry.usedBytes ?? 0;
    return <span className="board-storage" role="progressbar" aria-label="Занято на доске" aria-valuemin={0} aria-valuemax={300} aria-valuenow={Math.round(bytes / 1e6)} data-tooltip={`${(bytes / 1e6).toFixed(1)} / 300 МБ`}><span style={{ width: `${Math.min(100, bytes / BOARD_STORAGE_LIMIT * 100)}%` }} /></span>;
  }
  const [name, setName] = useState('');
  const renameTimer = useRef<ReturnType<typeof setTimeout>>();
  const renames = useRef(new Map<string, { entry: NamedBoard; title: string; due: number }>());
  const renaming = useRef<Promise<void> | null>(null);
  const [inviteUid, setInviteUid] = useState('');
  const [inviteRole, setInviteRole] = useState<'editor' | 'viewer'>('viewer');
  const [members, setMembers] = useState<{ uid: string; role: string; color: number }[]>([]);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [people, setPeople] = useState(1);
  const [dragPreviews, setDragPreviews] = useState<Record<string, DragPosition>>({});
  const dragAnimation = useRef(0), dragFrameTime = useRef(0);
  const smoothDrags = useRef<Record<string, DragPosition>>({}), dragTargets = useRef<Record<string, DragPosition>>({});
  const [unlocking, setUnlocking] = useState<NoteData | null>(null);
  const socket = useRef<BoardSocket | null>(null), identity = useRef<SharingIdentity | null>(null);
  const manager = useRef<SharedSync | null>(null), current = useRef<NamedBoard | null>(null);
  const selfId = useRef(''), generation = useRef(0), cursorTime = useRef(0), alive = useRef(true), working = useRef(false);
  const selectedNotes = useRef<string[]>([]);
  const ephemeral = useRef(new Map<string, { data: unknown; running: boolean; version: number }>());
  const lastCursor = useRef<{ x: number; y: number } | null>(null);
  const dragIds = useRef<string[]>([]), remoteDrags = useRef(new Map<string, { positions: DragPosition[]; at: number }>());
  const lastPackets = useRef(new Map<string, number>()), sequence = useRef(0);
  const switching = useRef<{ boardId: string; patches: any[] } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const own = entries.filter(item => item.ownerId === account.accountId), invited = entries.filter(item => item.ownerId !== account.accountId);
  async function list() {
    const list = await socket.current!.request<BoardEntry[]>('boards.list');
    const named: NamedBoard[] = [];
    for (const entry of list) {
      const key = await boardKey(entry, account.accountId, identity.current!);
      const title = await decryptValue<string>(key, entry.id, 'name', entry.name);
      if (typeof title !== 'string' || title.length > 120) throw new Error('Некорректное название доски.');
      named.push({ ...entry, key, title });
    }
    if (alive.current) {
      setEntries(named);
      const active = current.current, updated = active && named.find(entry => entry.id === active.id);
      if (updated) { current.current = updated; setSelected(updated); }
    }
    return named;
  }
  async function watch(entry: NamedBoard) {
    const result = await socket.current!.request<{ selfId: string }>('boards.watch', { boardId: entry.id });
    selfId.current = result.selfId;
  }
  async function select(entry: NamedBoard) {
    if (manager.current && !(await manager.current.flush())) throw new Error('Сначала сохраните текущие изменения.');
    const version = ++generation.current;
    switching.current = { boardId: entry.id, patches: [] };
    const opened = await socket.current!.request<{ vault: EntityVault; selfId: string; peers: Peer[] }>('boards.open', { boardId: entry.id });
    const vault = opened.vault;
    const decoded = await decodeVault(entry.key, vault);
    if (!alive.current || generation.current !== version) return;
    manager.current?.dispose(); current.current = entry; setSelected(entry); setBoard(decoded.board); setPeers([]); remoteDrags.current.clear(); cancelAnimationFrame(dragAnimation.current); dragAnimation.current = 0; smoothDrags.current = {}; dragTargets.current = {}; setDragPreviews({});
    try { sessionStorage.setItem(`notes:active-board:${account.accountId}`, entry.id); } catch { /* optional preference */ }
    manager.current = new SharedSync(socket.current!, entry.key, vault, decoded.board, decoded.index!, entry.role, value => { if (generation.current === version && alive.current) setBoard(value); }, message => { if (generation.current === version && alive.current) reportError(message); });
    selfId.current = opened.selfId; setPeople(new Set(opened.peers.map(peer => peer.uid)).size);
    for (const patch of switching.current?.patches ?? []) manager.current.receive(patch);
    switching.current = null; setMenu(false); setSharing(false);
  }
  async function create(title: string, source?: BoardData) {
    if (manager.current && !(await manager.current.flush())) throw new Error('Сначала сохраните изменения.');
    const id = source ? await entityId(account.accountId, 'first-board') : toBase64(crypto.getRandomValues(new Uint8Array(32)));
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    try {
      const key = await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
      const data = source ?? { ...emptyBoard(), lockKeys: initialBoard.lockKeys };
      const initial = (await prepareDelta(key, id, 0, data, null, true))!;
      await socket.current!.request('boards.create', { id, name: await encryptValue(key, id, 'name', title), wrappedKey: await wrapBoardKey(bytes, id, account.accountId, identity.current!.publicKey), snapshot: { format: 2, manifest: initial.patch.manifest, entities: initial.patch.upserts } });
      const all = await list(); const entry = all.find(item => item.id === id)!;
      await select(entry);
      if (source) await migrated();
    } finally { bytes.fill(0); }
  }
  function flushNames(immediate = false): Promise<void> {
    clearTimeout(renameTimer.current);
    if (immediate) for (const value of renames.current.values()) value.due = 0;
    if (renaming.current) return renaming.current;
    renaming.current = (async () => {
      while (renames.current.size) {
        const [id, value] = renames.current.entries().next().value!;
        const wait = value.due - performance.now();
        if (wait > 0) { renameTimer.current = setTimeout(() => void flushNames(), wait); return; }
        try {
          await socket.current!.request('boards.rename', { boardId: id, name: await encryptValue(value.entry.key, id, 'name', value.title) });
          if (renames.current.get(id) === value) renames.current.delete(id);
          if (!alive.current) return;
          setEntries(entries => entries.map(entry => entry.id === id ? { ...entry, title: value.title } : entry));
          if (current.current?.id === id) { current.current = { ...current.current, title: value.title }; setSelected(current.current); }
        } catch (error) { if (alive.current) reportError(authError(error)); return; }
      }
    })().finally(() => { renaming.current = null; });
    return renaming.current;
  }
  function editName(value: string) {
    setName(value); clearTimeout(renameTimer.current);
    if (!selected || selected.role !== 'owner') return;
    const title = value.trim();
    if (!title) { renames.current.delete(selected.id); return; }
    renames.current.set(selected.id, { entry: selected, title, due: performance.now() + 550 });
    renameTimer.current = setTimeout(() => void flushNames(), 550);
  }
  function closeShare() {
    setSharing(false);
    void flushNames(true);
  }
  useEffect(() => {
    alive.current = true; const ws = new BoardSocket(); socket.current = ws;
    const off = [
      ws.on('board.patch', data => { const target = switching.current; if (target && target.boardId === data.boardId) target.patches.push(data); if (Number.isFinite(data.usedBytes)) setEntries(entries => entries.map(entry => entry.id === data.boardId ? { ...entry, usedBytes: data.usedBytes } : entry)); }),
      ws.on('connected', () => { if (renames.current.size) void flushNames(); }),
      ws.on('boards.changed', () => { if (identity.current) void list().catch(err => setError(authError(err))); }),
      ws.on('board.access', async data => {
        if (!identity.current) return;
        try {
          const all = await list(), active = current.current;
          if (!active || active.id !== data.boardId) return;
          const entry = all.find(item => item.id === active.id);
          if (!entry) { manager.current?.dispose(); manager.current = null; current.current = null; setSelected(null); setBoard(emptyBoard()); setPeers([]); setMenu(true); setError('Доступ к доске отозван.'); return; }
          current.current = entry; setSelected(entry);
          if (manager.current) await manager.current.setRole(entry.role);
          await watch(entry);
        } catch (err) { setError(authError(err)); }
      }),
      ws.on('presence', data => {
        if (data.boardId !== current.current?.id) return;
        setPeople(new Set(data.peers.map((peer: Peer) => peer.uid)).size);
        setPeers(old => old.filter(peer => data.peers.some((p: Peer) => p.id === peer.id)));
        for (const id of remoteDrags.current.keys()) if (!data.peers.some((peer: Peer) => peer.id === id)) remoteDrags.current.delete(id);
        renderDrags();
        for (const peer of data.peers) if (peer.selection) void receiveSelection({ ...peer, boardId: data.boardId, envelope: peer.selection });
      }),
      ws.on('selection', data => { void receiveSelection(data); }),
      ws.on('drag', data => { void receiveDrag(data); }),
      ws.on('cursor', async data => {
        const active = current.current;
        if (!active || active.id !== data.boardId || data.id === selfId.current || data.uid === account.accountId) return;
        if (!data.envelope) { setPeers(old => old.map(peer => peer.id === data.id ? { ...peer, x: NaN, y: NaN } : peer)); return; }
        try {
          const point = await decryptValue<{ x: number; y: number; sequence: number; hidden?: boolean }>(active.key, active.id, 'cursor', data.envelope);
          if (current.current?.id !== active.id || !Number.isFinite(point.sequence) || point.sequence <= (lastPackets.current.get(`cursor:${data.id}`) ?? -1)) return;
          lastPackets.current.set(`cursor:${data.id}`, point.sequence);
          if (!point.hidden && (!Number.isFinite(point.x) || !Number.isFinite(point.y))) return;
          setPeers(old => [...old.filter(peer => peer.id !== data.id), { ...old.find(peer => peer.id === data.id), id: data.id, uid: data.uid, role: data.role, color: data.color, x: point.hidden ? NaN : point.x, y: point.hidden ? NaN : point.y }]);
        } catch { /* Ignore an invalid ephemeral cursor packet. */ }
      }),
    ];
    void (async () => {
      try {
        identity.current = await identityFor(ws, account);
        if (!alive.current) return;
        const all = await list();
        if (!identity.current.initialized && !all.some(entry => entry.ownerId === account.accountId)) await create('Моя доска', initialBoard);
        else if (all.length) {
          let saved: string | null = null; try { saved = sessionStorage.getItem(`notes:active-board:${account.accountId}`); } catch { /* optional preference */ }
          await select(all.find(entry => entry.id === saved) ?? all.find(entry => entry.ownerId === account.accountId) ?? all[0]);
        } else setMenu(true);
      } catch (err) { if (alive.current) setError(authError(err)); }
      finally { if (alive.current) setBusy(false); }
    })();
    function unload(event: BeforeUnloadEvent) { if (manager.current?.dirty || renames.current.size) { event.preventDefault(); event.returnValue = ''; } }
    window.addEventListener('beforeunload', unload);
    const stale = setInterval(() => { let changed = false; for (const [id, drag] of remoteDrags.current) if (Date.now() - drag.at > 2000) { remoteDrags.current.delete(id); changed = true; } if (changed) renderDrags(); }, 1000);
    return () => { alive.current = false; generation.current++; cancelAnimationFrame(dragAnimation.current); clearTimeout(renameTimer.current); manager.current?.dispose(); for (const fn of off) fn(); ws.close(); clearInterval(stale); window.removeEventListener('beforeunload', unload); };
  }, [account.accountId]);
  async function action(fn: () => Promise<void>) {
    if (working.current) return;
    working.current = true; setBusy(true); setError('');
    try { await fn(); } catch (err) { reportError(authError(err)); } finally { working.current = false; setBusy(false); }
  }
  function change(next: BoardData) { manager.current?.update(next); setBoard(manager.current?.board ?? next); }
  async function toggleLock(id: string) {
    if (current.current?.role !== 'owner' || noteBusy) return;
    const sync = manager.current!;
    setNoteBusy(id); setError('');
    try {
      if (!(await sync.flush())) throw new Error('Сначала сохраните изменения.');
      const note = sync.board.notes.find(item => item.id === id); if (!note) return;
      if (!sync.board.lockKeys) throw new Error('Ключи блокировки отсутствуют. Войдите заново.');
      if (note.sealed && account.authMethod === 'key') { setUnlocking(note); return; }
      const result = note.sealed ? await unlockNote(note, sync.board.lockKeys, account.accountId) : await sealNote(note, sync.board.lockKeys, account.accountId);
      if (manager.current !== sync) return;
      if (!note.sealed) sync.forgetNote(id, result);
      change({ ...sync.board, notes: sync.board.notes.map(n => n.id === id ? result : n) });
      await sync.flush();
    } catch (err) { setError(authError(err)); }
    finally { setNoteBusy(null); }
  }
  async function copy(value: string) { await navigator.clipboard.writeText(value); }
  async function share() {
    if (!selected || selected.role !== 'owner') return;
    setName(selected.title); setMembers(await socket.current!.request('boards.members', { boardId: selected.id })); setSharing(true);
  }
  async function invite(target = inviteUid.trim(), role = inviteRole) {
    if (!selected) return;
    const uid = target; const recipient = await socket.current!.request<{ publicKey: string }>('users.key', { uid });
    const bytes = await boardSecret(selected, account.accountId, identity.current!);
    try { await socket.current!.request('boards.invite', { boardId: selected.id, uid, role, wrappedKey: await wrapBoardKey(bytes, selected.id, uid, recipient.publicKey) }); }
    finally { bytes.fill(0); }
    setInviteUid(''); setMembers(await socket.current!.request('boards.members', { boardId: selected.id }));
  }
  async function publish() {
    if (!selected || !(await manager.current!.flush())) throw new Error('Сначала сохраните изменения.');
    const result = await socket.current!.request<{ token: string | null }>('boards.public', { boardId: selected.id, snapshot: selected.publicToken ? null : publicSnapshot(selected.title, manager.current!.board) });
    const next = { ...selected, publicToken: result.token }; current.current = next; setSelected(next); await list();
  }
  async function deleteBoard(entry: NamedBoard) {
    await socket.current!.request('boards.delete', { boardId: entry.id });
    if (manager.current && current.current?.id === entry.id) {
      // User explicitly confirmed deletion, including unsaved edits on this board.
      manager.current.dispose(); manager.current = null; current.current = null;
      setSelected(null); setBoard(emptyBoard()); setPeers([]); setPeople(1); setDragPreviews({});
    }
    setDeleting(null); setError('');
    const all = await list();
    if (!current.current && all.length) await select(all[0]);
    else if (!current.current) setMenu(true);
  }
  async function download() {
    const backup = await manager.current!.backup(); const url = URL.createObjectURL(new Blob([JSON.stringify(backup)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'notes-encrypted-backup.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function restore(file?: File) {
    if (!file || !selected || selected.role !== 'owner') return;
    if (file.size > 130_000_000) throw new Error('Слишком большой файл.');
    const data = JSON.parse(await file.text()); if (data.accountId !== selected.id) throw new Error('Копия относится к другой доске.');
    const restored = await decryptBoard(selected.key, selected.id, data.revision, data.envelope);
    if (confirm('Заменить содержимое доски этой копией?')) change(restored);
  }
  function cursor(point: { x: number; y: number } | null) {
    const active = current.current;
    if (!active) return;
    lastCursor.current = point;
    if (point && performance.now() - cursorTime.current < 16) return;
    cursorTime.current = performance.now();
    sendEphemeral('cursor', point ? { ...point, sequence: ++sequence.current } : { hidden: true, sequence: ++sequence.current });
  }
  function sendEphemeral(method: 'cursor' | 'drag', data: unknown) {
    const active = current.current; if (!active) return;
    let state = ephemeral.current.get(method);
    if (!state) { state = { data, running: false, version: 0 }; ephemeral.current.set(method, state); }
    state.data = data; state.version++;
    if (state.running) return;
    state.running = true;
    void (async () => {
      try {
        while (alive.current && current.current?.id === active.id) {
          const version = state!.version, payload = state!.data as any;
          const envelope = await encryptValue(active.key, active.id, method, payload);
          if (current.current?.id !== active.id) break;
          await socket.current!.request(method, { envelope, ...(method === 'drag' ? { ids: payload.ids } : {}) });
          if (state!.version === version) break;
        }
      } catch { /* Presence is disposable and never blocks editing. */ }
      finally { state!.running = false; }
    })();
  }
  function dragging(positions: DragPosition[] | null) {
    if (positions) dragIds.current = positions.map(position => position.id);
    sendEphemeral('drag', { ids: dragIds.current, positions: positions ?? [], ended: !positions, sequence: ++sequence.current });
    if (!positions) dragIds.current = [];
  }
  function renderDrags() {
    dragTargets.current = Object.fromEntries([...remoteDrags.current.values()].flatMap(drag => drag.positions.map(position => [position.id, position])));
    if (dragAnimation.current) return;
    const notes = new Map(manager.current?.board.notes.map(note => [note.id, note]));
    for (const [id, target] of Object.entries(dragTargets.current)) if (!smoothDrags.current[id]) smoothDrags.current[id] = { ...target, ...(notes.get(id) ? { x: notes.get(id)!.x, y: notes.get(id)!.y, width: notes.get(id)!.width, height: notes.get(id)!.height } : {}) };
    dragFrameTime.current = performance.now();
    function frame(now: number) {
      const alpha = 1 - Math.exp(-Math.min(64, now - dragFrameTime.current) / 35);
      dragFrameTime.current = now;
      const next: Record<string, DragPosition> = {};
      let moving = false;
      for (const [id, target] of Object.entries(dragTargets.current)) {
        const previous = smoothDrags.current[id] ?? target, value = { ...target };
        for (const key of ['x', 'y', 'width', 'height'] as const) {
          const delta = target[key] - previous[key];
          value[key] = Math.abs(delta) < .1 ? target[key] : previous[key] + delta * alpha;
          if (Math.abs(delta) >= .1) moving = true;
        }
        next[id] = value;
      }
      smoothDrags.current = next; setDragPreviews(next);
      dragAnimation.current = moving ? requestAnimationFrame(frame) : 0;
    }
    dragAnimation.current = requestAnimationFrame(frame);
  }
  async function receiveDrag(data: { boardId: string; id: string; uid: string; envelope: any; ids: string[] }) {
    const active = current.current;
    if (!active || active.id !== data.boardId || data.uid === account.accountId) return;
    try {
      const payload = await decryptValue<{ positions: DragPosition[]; ended: boolean; sequence: number }>(active.key, active.id, 'drag', data.envelope);
      if (current.current?.id !== active.id || !Number.isFinite(payload.sequence) || payload.sequence <= (lastPackets.current.get(`drag:${data.id}`) ?? -1)) return;
      lastPackets.current.set(`drag:${data.id}`, payload.sequence);
      if (payload.ended) {
        const previous = remoteDrags.current.get(data.id);
        if (previous) setTimeout(() => { if (remoteDrags.current.get(data.id) === previous) { remoteDrags.current.delete(data.id); renderDrags(); } }, 250);
        return;
      }
      if (!Array.isArray(payload.positions) || payload.positions.length > 10_000) return;
      const ids = new Set(data.ids), notes = new Map(manager.current!.board.notes.map(note => [note.id, note]));
      const positions = payload.positions.filter(position => ids.has(position.id) && notes.has(position.id) && !notes.get(position.id)!.pinned && [position.x, position.y, position.width, position.height].every(Number.isFinite) && Math.abs(position.x) <= 1e9 && Math.abs(position.y) <= 1e9 && position.width >= 160 && position.width <= 2048 && position.height >= 120 && position.height <= 2048);
      remoteDrags.current.set(data.id, { positions, at: Date.now() }); renderDrags();
    } catch { /* Ignore malformed transient geometry. */ }
  }
  async function receiveSelection(data: { boardId: string; id: string; uid: string; role: string; color?: number; envelope: any }) {
    const active = current.current;
    if (!active || active.id !== data.boardId || data.uid === account.accountId) return;
    try {
      const ids = data.envelope ? await decryptValue<unknown>(active.key, active.id, 'selection', data.envelope) : [];
      if (!Array.isArray(ids) || ids.length > 10_000 || ids.some(id => typeof id !== 'string') || current.current?.id !== active.id) return;
      setPeers(old => [...old.filter(peer => peer.id !== data.id), { x: NaN, y: NaN, ...old.find(peer => peer.id === data.id), id: data.id, uid: data.uid, role: data.role, color: data.color, selection: ids }]);
    } catch { /* Ignore invalid presence metadata. */ }
  }
  function selection(ids: string[]) {
    selectedNotes.current = ids;
    const active = current.current; if (!active) return;
    void (async () => { const envelope = ids.length ? await encryptValue(active.key, active.id, 'selection', ids) : null; if (current.current?.id === active.id) await socket.current!.request('selection', { envelope }); })().catch(() => {});
  }
  const publicUrl = selected?.publicToken ? `${location.origin}/#public=${selected.publicToken}` : '';
  return <>
    {selected && people > 1 && <div className="board-presence-count" title="Участников на доске" aria-label={`На доске ${people} участников`}><Icon name="user" size={16} /><span>{people}</span></div>}
    {selected ? <Board key={selected.id} board={board} onChange={change} onStorageLimit={() => setLimitReached(true)} role={selected.role} peers={peers} onCursor={cursor} onSelection={selection} onDrag={dragging} dragPreviews={dragPreviews} noteBusy={noteBusy} onToggleLock={toggleLock} clipboardKey={selected.key} accountId={selected.id} interactionBlocked={menu || sharing || profile || busy || Boolean(unlocking) || Boolean(deleting) || limitReached} actions={<>
      <Button className="board-picker" icon="boards" onClick={() => void action(async () => { await list(); setMenu(true); })} label="Выбрать доску"><span className="board-picker-label">{selected.title}</span></Button>
      <Button icon="user" label={`UID: ${account.accountId}`} onClick={() => { setCopiedUid(false); setProfile(true); }} />
      {selected.role === 'owner' && <Button icon="share" label="Доступ к доске" onClick={() => void action(share)} />}
      <Button icon="download" label="Скачать зашифрованную копию" onClick={() => void action(download)} />
      {selected.role === 'owner' && <Button icon="upload" label="Открыть зашифрованную копию" onClick={() => input.current?.click()} />}
      <Button icon="logout" label="Выйти" onClick={() => void action(async () => { if (!(await manager.current!.flush())) throw new Error('Сначала сохраните изменения.'); await logout(); })} />
    </>} /> : <div className="login-screen"><Button onClick={() => void action(async () => { await list(); setMenu(true); })} disabled={busy}>{busy ? <span className="spinner" /> : 'Открыть список досок'}</Button></div>}
    {error && <div className="workspace-error floating" role="alert">{error}<Button icon="retry" label="Повторить" onClick={() => void action(async () => { await flushNames(); if (manager.current) await manager.current.flush(); else { const all = await list(); if (all[0]) await select(all[0]); } })} /><Button icon="close" label="Закрыть" onClick={() => setError('')} /></div>}
    <input hidden ref={input} type="file" accept="application/json,.json" onChange={e => { const file = e.currentTarget.files?.[0]; e.currentTarget.value = ''; void action(() => restore(file)); }} />
    <Modal open={limitReached} close={() => setLimitReached(false)} label="Лимит доски достигнут"><p>{BOARD_LIMIT_MESSAGE}</p><p>Последние изменения пока не сохранены. Освободите место, чтобы продолжить сохранение.</p></Modal>
    <Modal open={menu} close={() => setMenu(false)} className="workspace-dialog" label="Доски">
      {error && <p className="key-error" role="alert">{error}</p>}
      <div className="board-section-heading"><h3>Мои доски <span>{own.length}/3</span></h3><Button icon="plus" label="Создать доску" disabled={busy || own.length >= 3} onClick={() => void action(() => create(`Доска ${own.length + 1}`))} /></div>
      <div className="board-list" role="list">{own.map(entry => <div role="listitem" className="owned-board-row" key={entry.id}><Button className={`board-list-item ${entry.id === selected?.id ? 'current-board' : ''}`} disabled={busy} onClick={() => void action(() => select(entry))} aria-current={entry.id === selected?.id ? 'true' : undefined}>
        <span className="board-miniature"><Icon name="boards" size={22} /></span><span className="board-entry-copy"><span className="board-list-name">{entry.title}</span><span className="board-entry-detail">{entry.publicToken ? 'Есть публичный снимок' : 'Личная доска'} · {((entry.usedBytes ?? 0) / 1e6).toFixed(1)} / 300 МБ</span></span><span className="board-entry-status"><Icon name={entry.id === selected?.id ? 'check' : 'next'} size={16} /></span>{usageBar(entry)}
      </Button><Button icon="trash" className="board-delete-action" label={`Удалить доску «${entry.title}»`} disabled={busy} onClick={() => { setError(''); setDeleting(entry); }} /></div>)}</div>
      {invited.length > 0 && <><div className="board-section-heading"><h3>Приглашённые <span>{invited.length}</span></h3></div><div className="board-list" role="list">{invited.map(entry => <div role="listitem" key={entry.id}><Button className={`board-list-item ${entry.id === selected?.id ? 'current-board' : ''}`} disabled={busy} onClick={() => void action(() => select(entry))} aria-current={entry.id === selected?.id ? 'true' : undefined}>
        <span className="board-miniature shared"><Icon name="share" size={22} /></span><span className="board-entry-copy"><span className="board-list-name">{entry.title}</span><span className="board-entry-detail">{entry.role === 'editor' ? 'Редактор' : 'Только просмотр'} · {((entry.usedBytes ?? 0) / 1e6).toFixed(1)} / 300 МБ</span></span><span className="board-entry-status"><Icon name={entry.id === selected?.id ? 'check' : 'next'} size={16} /></span>{usageBar(entry)}
      </Button></div>)}</div></>}
    </Modal>
    <Modal open={Boolean(deleting)} close={() => { if (!busy) setDeleting(null); }} label="Удалить доску?" className="workspace-dialog">
      <p>Доска «{deleting?.title}», её заметки, изображения и публичный снимок будут удалены. Участники потеряют доступ. Это действие нельзя отменить.</p>
      {error && <p className="key-error" role="alert">{error}</p>}
      <Button className="danger-button" disabled={busy || !deleting} onClick={() => { const entry = deleting; if (entry) void action(() => deleteBoard(entry)); }}>{busy ? 'Удаление…' : 'Удалить доску'}</Button>
    </Modal>
    <Modal open={profile} close={() => setProfile(false)} className="workspace-dialog" label="Ваш UID">
      <input aria-label="Ваш UID" readOnly value={account.accountId} onFocus={e => e.currentTarget.select()} />
      <Button onClick={() => void action(async () => { await copy(account.accountId); setCopiedUid(true); })}>{copiedUid ? 'Скопировано' : 'Скопировать UID'}</Button>
      {error && <p className="key-error" role="alert">{error}</p>}
    </Modal>
    <Modal open={sharing} close={() => void closeShare()} className="workspace-dialog" label="Доступ к доске">
      {error && <p className="key-error" role="alert">{error}</p>}
      <label>Название<input className="access-key-input" value={name} maxLength={120} onInput={e => editName(e.currentTarget.value)} /></label>
      <label>UID участника<input className="access-key-input" value={inviteUid} onInput={e => setInviteUid(e.currentTarget.value)} autoComplete="off" /></label>
      <RoleDropdown value={inviteRole} change={setInviteRole} disabled={busy} />
      <Button disabled={busy || !inviteUid.trim() || (members.length >= 10 && !members.some(member => member.uid === inviteUid.trim()))} onClick={() => void action(invite)}>Добавить участника</Button>
      <div className="member-list"><h3>Участники · {members.length}/10</h3>
      {members.map(member => <div className="member-row" key={member.uid}>
        <span className="member-avatar" style={{ color: participantColor(member.uid, member.color) }}><Icon name="user" size={18} /></span>
        <span className="member-identity" title={member.uid}><span>{member.uid === account.accountId ? 'Вы' : `${member.uid.slice(0, 8)}…${member.uid.slice(-4)}`}</span><small>{member.uid === account.accountId ? 'Владелец' : 'Приглашённый участник'}</small></span>
        {member.uid !== account.accountId && <><RoleDropdown compact value={member.role as 'editor' | 'viewer'} change={role => void action(() => invite(member.uid, role))} disabled={busy} /><Button icon="trash" label="Убрать доступ" disabled={busy} onClick={() => void action(async () => { await socket.current!.request('boards.removeMember', { boardId: selected!.id, uid: member.uid }); setMembers(await socket.current!.request('boards.members', { boardId: selected!.id })); })} /></>}
      </div>)}</div>
      <Button disabled={busy} onClick={() => void action(publish)}>{publicUrl ? 'Отключить публичный доступ' : 'Опубликовать снимок доски'}</Button>
      {publicUrl && <><input className="access-key-input" aria-label="Публичная ссылка" readOnly value={publicUrl} /><Button onClick={() => void action(() => copy(publicUrl))}>Скопировать ссылку</Button><p>Опубликован снимок. Новые изменения останутся приватными.</p></>}
    </Modal>
    {unlocking && <KeyDialog unlock submit={async value => {
      const sync = manager.current!; const result = await unlockWithKey(value, account.accountId, unlocking, sync.board.lockKeys!);
      change({ ...sync.board, notes: sync.board.notes.map(note => note.id === result.id ? result : note) }); await sync.flush();
    }} close={() => setUnlocking(null)} />}
  </>;
}
