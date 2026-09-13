import { createHash, randomUUID } from 'node:crypto';
import type { Server as HTTPServer, IncomingMessage } from 'node:http';
import type { Server as HTTPSServer } from 'node:https';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { MAX_TRANSFER_BYTES, MAX_ENTITIES, ChunkReceiver, encodeSerializedFrames, encodeTreeFrames, transferReservation, base64url, envelopeSchema, type BoardRole, type Envelope } from '@quiet/shared';
import { CollaborationError } from './collaboration-store.js';
import type { Store } from './store.js';

const idSchema = base64url.length(43);
const boardParams = z.object({ boardId: idSchema });
const loadParams = boardParams.extend({ known: z.array(z.object({ id: idSchema, revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict()).max(MAX_ENTITIES).optional() }).strict();
const requestSchema = z.object({ id: z.string().min(1).max(128), method: z.string().min(1).max(64), params: z.unknown() }).strict();
const MAX_FRAME_BYTES = 512 * 1024;
const MAX_PENDING_BYTES = 8 * 1024 * 1024;
type Delivery = { frames: Iterator<string> | null; bytes: number; allowed: () => boolean; started: boolean };
type Client = { ws: WebSocket; tree: boolean; id: string; hash: string | null; uid: string | null; boardId: string | null; role: BoardRole | null; selection: Envelope | null; alive: boolean; count: number; realtimeCount: number; bytes: number; until: number; receiver: ChunkReceiver; receivingSince: number | null; receiveTimeout: ReturnType<typeof setTimeout> | null; queue: Delivery[]; pendingBytes: number; active: Delivery | null };

/** Attach to an existing HTTP(S) server. Returns an idempotent, synchronous close function. */
export function attachCollaboration(server: HTTPServer | HTTPSServer, store: Store, origin: string): () => void {
  const parsedOrigin = new URL(origin);
  if (parsedOrigin.origin !== origin) throw new Error('ORIGIN must be an exact origin.');
  const cookieName = parsedOrigin.protocol === 'https:' ? '__Host-quiet-session' : 'quiet-session';
  const collaboration = store.collaboration;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false });
  const clients = new Set<Client>();
  const upgrades = new Map<string, { count: number; until: number }>();
  let closed = false;
  function session(client: Client) {
    if (!client.hash) return undefined;
    const account = store.accountBySession(client.hash, Date.now());
    return account && account.id === client.uid ? account : undefined;
  }
  function pump(client: Client) {
    if (client.ws.readyState !== WebSocket.OPEN) return;
    if (!client.active) {
      client.active = client.queue.shift() ?? null;
      if (!client.active) return;
      client.pendingBytes -= queuedBytes(client.active.bytes);
    }
    const delivery = client.active;
    if (!delivery.frames) return; // Reserved response is still loading its snapshot.
    // Check again between frames: a revoked member must not finish a queued snapshot.
    if (!delivery.allowed()) {
      if (delivery.started) { client.ws.terminate(); return; }
      client.active = null; pump(client); return;
    }
    let frame: IteratorResult<string>;
    try { frame = delivery.frames.next(); }
    catch { client.ws.close(1009, 'Transfer too large'); return; }
    if (frame.done) { client.active = null; pump(client); return; }
    delivery.started = true;
    if (client.ws.bufferedAmount > MAX_PENDING_BYTES) { client.ws.terminate(); return; }
    client.ws.send(frame.value, error => {
      if (error) { client.ws.terminate(); return; }
      setImmediate(() => pump(client));
    });
  }
  function queuedBytes(bytes: number) { return bytes > MAX_PENDING_BYTES ? 0 : bytes; }
  function rawSend(client: Client, payload: unknown, boardId?: string, watched = false, authenticated = true) {
    if (client.ws.readyState !== WebSocket.OPEN) return;
    const loading = payload instanceof Promise;
    const json = loading || client.tree ? null : JSON.stringify(payload);
    const bytes = loading ? MAX_TRANSFER_BYTES : client.tree ? transferReservation(payload) : Buffer.byteLength(json!);
    if (bytes > MAX_TRANSFER_BYTES) { client.ws.close(1009, 'Transfer too large'); return; }
    // Reserve at most one large snapshot, even while a preceding control frame
    // is in flight. Incremental traffic behind it has a separate bounded budget.
    const hasSnapshot = (client.active?.bytes ?? 0) > MAX_PENDING_BYTES || client.queue.some(delivery => delivery.bytes > MAX_PENDING_BYTES);
    if ((bytes > MAX_PENDING_BYTES && hasSnapshot) || client.pendingBytes + queuedBytes(bytes) > MAX_PENDING_BYTES) { client.ws.terminate(); return; }
    const allowed = () => {
      if (authenticated && !session(client)) return false;
      // A failed asynchronous RPC contains no board state. Return its error even
      // if membership disappeared during the read, just like synchronous errors.
      if (payload && typeof payload === 'object' && 'error' in payload) return true;
      if (boardId) {
        if (!client.uid || (watched && client.boardId !== boardId)) return false;
        try { collaboration.role(client.uid, boardId); } catch { return false; }
      }
      // List responses may wait behind another transfer. Re-check every listed membership.
      const result = (payload as { result?: unknown }).result;
      if (Array.isArray(result)) for (const item of result) {
        if (item && typeof item === 'object' && 'ownerId' in item && 'id' in item) {
          try { if (collaboration.role(client.uid!, item.id) !== item.role) return false; } catch { return false; }
        }
      }
      return true;
    };
    const delivery: Delivery = { frames: loading ? null : client.tree ? encodeTreeFrames(payload) : encodeSerializedFrames(json!), bytes, allowed, started: false };
    client.queue.push(delivery);
    client.pendingBytes += queuedBytes(bytes);
    if (!client.active) pump(client);
    if (loading) void (payload as Promise<unknown>).then(value => {
      if (client.ws.readyState !== WebSocket.OPEN) return;
      payload = value;
      const serialized = client.tree ? null : JSON.stringify(value);
      const actualBytes = client.tree ? transferReservation(value) : Buffer.byteLength(serialized!);
      if (actualBytes > MAX_TRANSFER_BYTES) { client.ws.close(1009, 'Transfer too large'); return; }
      if (client.active !== delivery) {
        client.pendingBytes += queuedBytes(actualBytes) - queuedBytes(delivery.bytes);
        if (client.pendingBytes > MAX_PENDING_BYTES) { client.ws.terminate(); return; }
      }
      delivery.bytes = actualBytes;
      delivery.frames = client.tree ? encodeTreeFrames(value) : encodeSerializedFrames(serialized!);
      if (client.active === delivery) pump(client);
    }).catch(() => { client.ws.terminate(); });
  }
  function sendAuthenticated(client: Client, payload: unknown, boardId?: string) {
    if (!session(client)) { client.ws.close(1008, 'Session expired'); return; }
    rawSend(client, payload, boardId);
  }
  function watchRole(client: Client): BoardRole | null {
    if (!client.boardId) return null;
    const boardId = client.boardId;
    if (!session(client)) {
      client.boardId = null; client.role = null; client.selection = null;
      client.ws.close(1008, 'Session expired');
      return null;
    }
    try { client.role = collaboration.role(client.uid!, boardId); return client.role; }
    catch {
      client.boardId = null; client.role = null; client.selection = null;
      sendAuthenticated(client, { event: 'board.access', data: { boardId, error: 'Нет доступа к доске.', status: 403 } });
      return null;
    }
  }
  function peers(boardId: string) {
    const result: { id: string; uid: string; role: BoardRole; color: number; selection: Envelope | null }[] = [];
    for (const client of clients) {
      if (client.ws.readyState !== WebSocket.OPEN || client.boardId !== boardId) continue;
      const role = watchRole(client);
      if (role) result.push({ id: client.id, uid: client.uid!, role, color: collaboration.color(client.uid!, boardId), selection: client.selection });
    }
    return result;
  }
  function broadcast(boardId: string, event: string, data: unknown) {
    for (const client of clients) {
      if (client.boardId === boardId && watchRole(client)) rawSend(client, { event, data }, boardId, true);
    }
  }
  function presence(boardId: string) {
    const authorized = peers(boardId);
    broadcast(boardId, 'presence', { boardId, peers: authorized });
  }
  function unwatch(client: Client) {
    const previous = client.boardId;
    client.boardId = null; client.role = null; client.selection = null;
    if (previous) presence(previous);
  }
  const unsubscribe = collaboration.onChange(change => {
    if (change.event === 'board.patch') {
      broadcast(change.boardId, change.event, change.data);
      return;
    }
    for (const client of clients) {
      if (!client.uid || !change.uids.includes(client.uid) || !session(client)) continue;
      if (change.event === 'board.access') {
        // Revocations send one control error, then drop the subscription before more bytes can be sent.
        if (client.boardId === change.boardId && !watchRole(client)) continue;
        try { collaboration.role(client.uid, change.boardId); }
        catch { sendAuthenticated(client, { event: 'board.access', data: { boardId: change.boardId, error: 'Нет доступа к доске.', status: 403 } }); continue; }
        sendAuthenticated(client, { event: change.event, data: { boardId: change.boardId } });
      } else {
        // A list invalidation contains no board data, including when membership was removed.
        try { collaboration.role(client.uid, change.boardId); } catch { /* still invalidate a revoked list entry */ }
        sendAuthenticated(client, { event: change.event, data: {} });
      }
    }
    if (change.event === 'board.access') presence(change.boardId);
  });
  function dispatch(client: Client, method: string, params: unknown): unknown {
    if (method === 'public.get') {
      const value = z.object({ token: idSchema }).strict().parse(params);
      return collaboration.publicGet(value.token);
    }
    if (!session(client)) throw new CollaborationError(401, 'Сессия истекла. Войдите снова.');
    // Revalidate even for RPCs unrelated to the current subscription.
    if (client.boardId) {
      const previous = client.boardId;
      if (!watchRole(client)) presence(previous);
    }
    const uid = client.uid!;
    switch (method) {
      case 'identity.get': z.object({}).strict().parse(params); return collaboration.identity(uid);
      case 'identity.put': return collaboration.putIdentity(uid, params as Parameters<typeof collaboration.putIdentity>[1]);
      case 'users.key': return collaboration.userKey(z.object({ uid: idSchema }).strict().parse(params).uid);
      case 'boards.list': z.object({}).strict().parse(params); return collaboration.list(uid);
      case 'boards.create': return collaboration.create(uid, params as Parameters<typeof collaboration.create>[1]);
      case 'boards.get': {
        const { boardId, known } = loadParams.parse(params);
        const cancelled = () => client.ws.readyState !== WebSocket.OPEN || !session(client);
        return known && client.tree ? collaboration.getCached(uid, boardId, known, cancelled) : collaboration.get(uid, boardId, cancelled);
      }
      case 'boards.open':
      case 'boards.watch': {
        const { boardId, known } = (method === 'boards.open' ? loadParams : boardParams.strict()).parse(params) as z.infer<typeof loadParams>;
        const role = collaboration.role(uid, boardId);
        if (client.boardId !== boardId) unwatch(client);
        client.boardId = boardId; client.role = role;
        presence(boardId);
        // Capture metadata now; the response reserves its queue position before
        // asynchronous file reads yield, so later patches stay behind the snapshot.
        const cancelled = () => client.ws.readyState !== WebSocket.OPEN || !session(client);
        const vault = method === 'boards.open' ? (known && client.tree ? collaboration.getCached(uid, boardId, known, cancelled) : collaboration.get(uid, boardId, cancelled)) : undefined;
        const watched = { role, peers: peers(boardId), selfId: client.id };
        return vault ? vault.then(value => ({ ...watched, vault: value })) : watched;
      }
      case 'boards.unwatch': z.object({}).strict().parse(params); unwatch(client); return { ok: true };
      case 'boards.patch': {
        const value = boardParams.extend({ patch: z.unknown() }).strict().parse(params);
        return collaboration.patch(uid, value.boardId, value.patch as Parameters<typeof collaboration.patch>[2]);
      }
      case 'boards.delete': return collaboration.delete(uid, boardParams.strict().parse(params).boardId);
      case 'boards.rename': {
        const value = boardParams.extend({ name: envelopeSchema, expectedKey: base64url.length(512) }).strict().parse(params);
        return collaboration.rename(uid, value.boardId, value.name, value.expectedKey);
      }
      case 'boards.invite': {
        const value = boardParams.extend({ uid: idSchema, role: z.enum(['editor', 'viewer']), wrappedKey: base64url.length(512), proof: envelopeSchema, revision: z.number().int().min(1), expectedKey: base64url.length(512) }).strict().parse(params);
        return collaboration.invite(uid, value.boardId, value.uid, value.role, value.wrappedKey, value.proof, value.revision, value.expectedKey);
      }
      case 'boards.members': return collaboration.members(uid, boardParams.strict().parse(params).boardId);
      case 'boards.removeMember': {
        throw new CollaborationError(409, 'Для удаления участника обновите приложение.');
      }
      case 'boards.rotate': {
        const value = boardParams.extend({ rotation: z.unknown() }).strict().parse(params);
        return collaboration.rotate(uid, value.boardId, value.rotation);
      }
      case 'boards.public': {
        const value = boardParams.extend({ snapshot: z.unknown() }).strict().parse(params);
        return collaboration.public(uid, value.boardId, value.snapshot as Parameters<typeof collaboration.public>[2]);
      }
      case 'drag': {
        const value = z.object({ ids: z.array(z.string().uuid()).max(10_000), envelope: envelopeSchema.extend({ ciphertext: base64url.min(22).max(2_000_000) }).nullable() }).strict().parse(params);
        const role = watchRole(client);
        if (!role || !client.boardId) throw new CollaborationError(403, 'Сначала подпишитесь на доступную доску.');
        collaboration.canDrag(uid, client.boardId, value.ids);
        broadcast(client.boardId, 'drag', { boardId: client.boardId, id: client.id, uid, role, envelope: value.envelope, ids: value.ids });
        return { ok: true };
      }
      case 'selection': {
        const value = z.object({ envelope: envelopeSchema.extend({ ciphertext: base64url.min(22).max(1_000_000) }).nullable() }).strict().parse(params);
        const role = watchRole(client);
        if (!role || !client.boardId) throw new CollaborationError(403, 'Сначала подпишитесь на доступную доску.');
        client.selection = value.envelope;
        broadcast(client.boardId, 'selection', { boardId: client.boardId, id: client.id, uid, role, color: collaboration.color(uid, client.boardId), envelope: value.envelope });
        return { ok: true };
      }
      case 'cursor': {
        const value = z.object({ envelope: envelopeSchema.extend({ ciphertext: base64url.min(22).max(4096) }).nullable() }).strict().parse(params);
        const role = watchRole(client);
        if (!role || !client.boardId) throw new CollaborationError(403, 'Сначала подпишитесь на доступную доску.');
        broadcast(client.boardId, 'cursor', { boardId: client.boardId, id: client.id, uid, role, color: collaboration.color(uid, client.boardId), envelope: value.envelope });
        return { ok: true };
      }
      default: throw new CollaborationError(404, 'Неизвестный метод.');
    }
  }
  wss.on('connection', (ws, request) => {
    const hash = sessionHash(request);
    const account = hash ? store.accountBySession(hash, Date.now()) : undefined;
    const client: Client = { ws, tree: request.url === '/socket?transfer=2', id: randomUUID(), hash: account ? hash : null, uid: account?.id ?? null, boardId: null, role: null, selection: null, alive: true, count: 0, realtimeCount: 0, bytes: 0, until: Date.now() + 1000, receiver: new ChunkReceiver(), receivingSince: null, receiveTimeout: null, queue: [], pendingBytes: 0, active: null };
    clients.add(client);
    ws.on('error', () => ws.terminate());
    ws.on('pong', () => { client.alive = true; });
    ws.on('close', () => { clients.delete(client); if (client.receiveTimeout) clearTimeout(client.receiveTimeout); client.receiver.clear(); client.queue = []; client.active = null; unwatch(client); });
    ws.on('message', (data, binary) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      let id = '';
      let method = '';
      try {
        const now = Date.now();
        if (client.until <= now) { client.count = 0; client.realtimeCount = 0; client.bytes = 0; client.until = now + 1000; }
        const length = Array.isArray(data) ? data.reduce((total, buffer) => total + buffer.length, 0) : data.byteLength;
        client.bytes += length;
        if (client.bytes > MAX_TRANSFER_BYTES * 2) { ws.close(1008, 'Rate limit exceeded'); return; }
        if (binary) { ws.close(1003, 'Text JSON required'); return; }
        let input: unknown;
        try { input = client.receiver.push(data.toString()); }
        catch { client.receiver.clear(); ws.close(1008, 'Invalid chunk stream'); return; }
        if (input === null) {
          if (client.receivingSince === null) {
            client.receivingSince = now;
            client.receiveTimeout = setTimeout(() => { client.receiver.clear(); ws.terminate(); }, 60_000);
            client.receiveTimeout.unref();
          }
          return;
        }
        if (client.receiveTimeout) clearTimeout(client.receiveTimeout);
        client.receiveTimeout = null; client.receivingSince = null;
        // Count assembled logical messages, not individual transfer frames.
        const realtime = input && typeof input === 'object' && 'method' in input && (input.method === 'cursor' || input.method === 'drag');
        if (realtime ? ++client.realtimeCount > 150 : ++client.count > 60) { ws.close(1008, 'Rate limit exceeded'); return; }
        if (input && typeof input === 'object' && 'id' in input && typeof input.id === 'string' && input.id.length <= 128) id = input.id;
        const request = requestSchema.parse(input);
        id = request.id; method = request.method;
        const result = dispatch(client, request.method, request.params);
        const payload = result instanceof Promise
          ? result.then(value => ({ id, result: value }), error => ({ id, ...rpcError(error) }))
          : { id, result };
        if (method === 'public.get') rawSend(client, payload, undefined, false, false);
        else {
          const scope = request.params as { boardId?: string } | undefined;
          const boardId = method.startsWith('boards.') && typeof scope?.boardId === 'string' ? scope.boardId : undefined;
          sendAuthenticated(client, payload, method === 'boards.removeMember' || method === 'boards.delete' ? undefined : boardId);
        }
      } catch (error) {
        const { status, error: message } = rpcError(error);
        // Errors contain no board state and may be returned to unauthenticated clients.
        rawSend(client, { id, error: message, status }, undefined, false, false);
        if (status === 401 && client.uid) { unwatch(client); ws.close(1008, 'Session expired'); }
      }
    });
  });
  function rpcError(error: unknown) {
    const status = error instanceof CollaborationError ? error.status : error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 500;
    return { status, error: error instanceof CollaborationError ? error.message : status === 400 ? 'Некорректный формат данных.' : 'Не удалось выполнить запрос.' };
  }
  function sessionHash(request: IncomingMessage): string | null {
    const values = (request.headers.cookie ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${cookieName}=`));
    if (values.length !== 1) return null;
    const value = values[0]!.slice(cookieName.length + 1);
    if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
    return createHash('sha256').update(value).digest('hex');
  }
  function upgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    if (request.url !== '/socket' && request.url !== '/socket?transfer=2') return;
    const reject = (status: number, message: string) => { socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
    if (closed || request.headers.origin !== origin) { reject(403, 'Forbidden'); return; }
    const now = Date.now(), address = request.socket.remoteAddress ?? 'unknown';
    for (const [key, rate] of upgrades) if (rate.until <= now) upgrades.delete(key);
    let rate = upgrades.get(address);
    if (!rate) {
      if (upgrades.size >= 10_000) { reject(503, 'Service Unavailable'); return; }
      rate = { count: 0, until: now + 60_000 }; upgrades.set(address, rate);
    }
    if (++rate.count > 60 || clients.size >= 1000) { reject(429, 'Too Many Requests'); return; }
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
  }
  server.on('upgrade', upgrade);
  const heartbeat = setInterval(() => {
    const boards = new Set<string>();
    for (const client of clients) {
      if (client.boardId) boards.add(client.boardId);
      if (!client.alive || (client.uid && !session(client)) || (client.receivingSince !== null && Date.now() - client.receivingSince >= 60_000)) { client.ws.terminate(); continue; }
      if (client.boardId) watchRole(client);
      client.alive = false;
      if (client.ws.readyState === WebSocket.OPEN) client.ws.ping();
    }
    for (const boardId of boards) presence(boardId);
  }, 15_000);
  heartbeat.unref();
  return () => {
    if (closed) return;
    closed = true; clearInterval(heartbeat); unsubscribe(); server.off('upgrade', upgrade);
    for (const client of clients) client.ws.terminate();
    clients.clear(); upgrades.clear(); wss.close();
  };
}
