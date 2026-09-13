import { MAX_TRANSFER_BYTES } from './limits.ts';
import type { EntityVault, Envelope } from './index.ts';
export type CachedRevision = { id: string; revision: number };
export type DeltaVault = Omit<EntityVault, 'entities'> & { delta: true; entities: (Omit<EntityVault['entities'][number], 'envelope'> & { envelope?: Envelope })[] };
export const CHUNK_CHARS = 64 * 1024;
const encoder = new TextEncoder();
export function* encodeFrames(value: unknown): Generator<string> {
  yield* encodeSerializedFrames(JSON.stringify(value));
}
/** Frame an already serialized logical message without serializing it again. */
export function* encodeSerializedFrames(json: string): Generator<string> {
  if (encoder.encode(json).byteLength > MAX_TRANSFER_BYTES) throw new Error('Слишком большой пакет.');
  if (json.length <= CHUNK_CHARS) { yield json; return; }
  const id = crypto.randomUUID(), total = Math.ceil(json.length / CHUNK_CHARS);
  for (let index = 0; index < total; index++) yield JSON.stringify({ chunk: { id, index, total, data: json.slice(index * CHUNK_CHARS, (index + 1) * CHUNK_CHARS) } });
}
export class ChunkReceiver {
  private tree = new TreeReceiver();
  private stream?: { id: string; total: number; parts: string[]; bytes: number; started: number };
  push(raw: string): any | null {
    if (raw.length > CHUNK_CHARS * 7) throw new Error('Слишком большой чанк.');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') throw new Error('Некорректный пакет.');
    if ('tree' in parsed) {
      if (this.stream) throw new Error('Нарушен порядок чанков.');
      return this.tree.push(parsed.tree);
    }
    if (this.tree.active) throw new Error('Нарушен порядок чанков.');
    if (!('chunk' in parsed)) { if (this.stream) throw new Error('Нарушен порядок чанков.'); return parsed; }
    const part = parsed.chunk;
    if (!part || typeof part.id !== 'string' || part.id.length > 64 || !Number.isSafeInteger(part.index) || !Number.isSafeInteger(part.total) || part.total < 1 || part.total > Math.ceil(MAX_TRANSFER_BYTES / CHUNK_CHARS) || typeof part.data !== 'string' || part.data.length > CHUNK_CHARS) throw new Error('Некорректный чанк.');
    if (!this.stream) {
      if (part.index !== 0) throw new Error('Пропущен чанк.');
      this.stream = { id: part.id, total: part.total, parts: [], bytes: 0, started: Date.now() };
    }
    const stream = this.stream;
    if (stream.id !== part.id || stream.total !== part.total || part.index !== stream.parts.length || Date.now() - stream.started > 60_000) { this.stream = undefined; throw new Error('Передача прервана.'); }
    stream.bytes += encoder.encode(part.data).byteLength;
    if (stream.bytes > MAX_TRANSFER_BYTES) { this.stream = undefined; throw new Error('Слишком большой пакет.'); }
    stream.parts.push(part.data);
    if (stream.parts.length < stream.total) return null;
    this.stream = undefined;
    const result = JSON.parse(stream.parts.join(''));
    if (!result || typeof result !== 'object' || 'chunk' in result) throw new Error('Некорректный пакет.');
    return result;
  }
  clear() { this.stream = undefined; this.tree.clear(); }
}

// Opt-in v2: bounded structural tokens, never a whole-message JSON string.
// Each message still occupies the delivery queue until its final frame. Legacy
// /socket peers keep the v1 chunk protocol; /socket?transfer=2 selects this one.
const STRING_PART = 8192;
const MAX_DEPTH = 64;
const MAX_NODES = 1_000_000;
const MAX_OPS = 1024;
type Op = ['o' | 'a' | 's' | 'e'] | ['k' | 'p', string] | ['v', string | number | boolean | null];

function* tokens(value: any, depth = 0): Generator<Op> {
  if (depth > MAX_DEPTH) throw new Error('Transfer nesting limit.');
  if (value && typeof value.toJSON === 'function') value = value.toJSON();
  if (typeof value === 'string' && value.length > STRING_PART) {
    yield ['s'];
    for (let offset = 0; offset < value.length;) {
      let end = Math.min(offset + STRING_PART, value.length);
      // Do not split a surrogate pair; byte accounting then matches JSON UTF-8.
      const last = value.charCodeAt(end - 1);
      if (end < value.length && last >= 0xd800 && last <= 0xdbff) end--;
      yield ['p', value.slice(offset, end)]; offset = end;
    }
    yield ['e'];
  } else if (Array.isArray(value)) {
    yield ['a'];
    for (const item of value) yield* tokens(item, depth + 1);
    yield ['e'];
  } else if (value && typeof value === 'object') {
    yield ['o'];
    for (const key of Object.keys(value)) {
      if (key.length > STRING_PART) throw new Error('Transfer key limit.');
      const item = value[key];
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue;
      yield ['k', key]; yield* tokens(item, depth + 1);
    }
    yield ['e'];
  } else {
    if (typeof value === 'bigint') throw new Error('Invalid JSON value.');
    yield ['v', typeof value === 'number' && !Number.isFinite(value) ? null : value ?? null];
  }
}

/** Canonical JSON.stringify-compatible pieces for hashing without a giant copy. */
export function* jsonPieces(value: unknown): Generator<string> {
  const stack: { kind: 'o' | 'a' | 's'; count: number }[] = [];
  const prefix = () => {
    const parent = stack.at(-1);
    return parent?.kind === 'a' && parent.count++ ? ',' : '';
  };
  for (const op of tokens(value)) {
    if (op[0] === 'k') { const parent = stack.at(-1)!; yield (parent.count++ ? ',' : '') + JSON.stringify(op[1]) + ':'; }
    else if (op[0] === 'p') yield JSON.stringify(op[1]).slice(1, -1);
    else if (op[0] === 'v') yield prefix() + JSON.stringify(op[1]);
    else if (op[0] === 'e') { const parent = stack.pop()!; yield parent.kind === 's' ? '"' : parent.kind === 'o' ? '}' : ']'; }
    else { yield prefix() + (op[0] === 's' ? '"' : op[0] === 'o' ? '{' : '['); stack.push({ kind: op[0], count: 0 }); }
  }
}

/** Conservative queue accounting without walking or copying large strings. */
export function transferReservation(value: unknown): number {
  let bytes = 0, nodes = 0;
  const visit = (item: any, depth: number): void => {
    if (++nodes > 4096 || depth > MAX_DEPTH) { bytes = MAX_TRANSFER_BYTES; return; }
    if (typeof item === 'string') { bytes += item.length * 6 + 2; return; }
    if (!item || typeof item !== 'object') { bytes += 32; return; }
    if (typeof item.toJSON === 'function') { bytes = MAX_TRANSFER_BYTES; return; }
    bytes += 2;
    for (const key in item) {
      if (!Object.hasOwn(item, key)) continue;
      bytes += key.length * 6 + 4;
      visit(item[key], depth + 1);
      if (bytes >= 8 * 1024 * 1024 || nodes > 4096) { bytes = MAX_TRANSFER_BYTES; return; }
    }
  };
  visit(value, 0);
  return Math.min(bytes, MAX_TRANSFER_BYTES);
}

export function* encodeTreeFrames(value: unknown): Generator<string> {
  const id = crypto.randomUUID();
  let index = 0, pieces: string[] = [], length = 0;
  // The same accounting as the receiver rejects oversized logical messages,
  // without constructing a second object graph or encoding a giant string.
  const accounting = new TreeReceiver(false);
  for (const op of tokens(value)) {
    accounting.accept(op);
    const part = JSON.stringify(op);
    if (pieces.length && (length + part.length > CHUNK_CHARS || pieces.length >= MAX_OPS)) {
      yield `{"tree":{"id":"${id}","index":${index++},"done":false,"ops":[${pieces.join(',')}]}}`;
      pieces = []; length = 0;
    }
    pieces.push(part); length += part.length + 1;
  }
  accounting.finish();
  yield `{"tree":{"id":"${id}","index":${index},"done":true,"ops":[${pieces.join(',')}]}}`;
}

type Container = { kind: 'o' | 'a'; value: any; count: number; key?: string; keys?: Set<string> } | { kind: 's'; parts: string[] };
class TreeReceiver {
  private id?: string;
  private index = 0;
  private started = 0;
  private bytes = 0;
  private nodes = 0;
  private stack: Container[] = [];
  private root: any;
  private roots = 0;
  constructor(private materialize = true) {}
  get active() { return this.id !== undefined; }
  clear() { this.id = undefined; this.index = 0; this.started = 0; this.bytes = 0; this.nodes = 0; this.stack = []; this.root = undefined; this.roots = 0; }
  private addBytes(bytes: number) {
    this.bytes += bytes;
    if (this.bytes > MAX_TRANSFER_BYTES) throw new Error('Слишком большой пакет.');
  }
  private attach(value: any) {
    if (++this.nodes > MAX_NODES) throw new Error('Transfer node limit.');
    const parent = this.stack.at(-1);
    if (!parent) {
      if (this.roots++) throw new Error('Multiple transfer roots.');
      this.root = value; return;
    }
    if (parent.kind === 's') throw new Error('Invalid string token.');
    if (parent.kind === 'o') {
      if (parent.key === undefined) throw new Error('Missing transfer key.');
      if (this.materialize) Object.defineProperty(parent.value, parent.key, { value, enumerable: true, configurable: true, writable: true });
      parent.key = undefined;
    } else if (this.materialize) parent.value.push(value);
    if (parent.count++) this.addBytes(1); // comma
  }
  accept(raw: unknown) {
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 2) throw new Error('Invalid transfer token.');
    const [op, value] = raw;
    const top = this.stack.at(-1);
    if (op === 'k' || op === 'p') {
      if (raw.length !== 2 || typeof value !== 'string' || value.length > STRING_PART) throw new Error('Invalid transfer string.');
      if (op === 'k') {
        if (top?.kind !== 'o' || top.key !== undefined || top.keys!.has(value)) throw new Error('Invalid transfer key.');
        top.key = value; top.keys!.add(value);
        this.addBytes(encoder.encode(JSON.stringify(value)).byteLength + 1);
      } else {
        if (top?.kind !== 's' || !value.length) throw new Error('Invalid transfer string part.');
        this.addBytes(encoder.encode(JSON.stringify(value)).byteLength - 2);
        if (this.materialize) top.parts.push(value);
      }
    } else if (op === 'v') {
      if (raw.length !== 2 || !(value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value.length <= STRING_PART))) throw new Error('Invalid transfer value.');
      this.addBytes(encoder.encode(JSON.stringify(value)).byteLength);
      this.attach(value);
    } else if (op === 'o' || op === 'a' || op === 's') {
      if (raw.length !== 1 || this.stack.length >= MAX_DEPTH) throw new Error('Transfer nesting limit.');
      this.addBytes(op === 's' ? 2 : 1);
      if (op === 's') this.stack.push({ kind: 's', parts: [] });
      else {
        const container: Container = { kind: op, value: op === 'a' ? [] : {}, count: 0, ...(op === 'o' ? { keys: new Set<string>() } : {}) };
        this.attach(container.value); this.stack.push(container);
      }
    } else if (op === 'e') {
      if (raw.length !== 1 || !top || (top.kind === 'o' && top.key !== undefined)) throw new Error('Invalid transfer end.');
      this.stack.pop();
      if (top.kind === 's') this.attach(this.materialize ? top.parts.join('') : '');
      else this.addBytes(1);
    } else throw new Error('Unknown transfer token.');
  }
  finish() {
    if (this.stack.length || this.roots !== 1 || !this.root || typeof this.root !== 'object') throw new Error('Incomplete transfer.');
    return this.root;
  }
  push(frame: any): any | null {
    try {
      if (!frame || typeof frame.id !== 'string' || frame.id.length > 64 || !Number.isSafeInteger(frame.index) || typeof frame.done !== 'boolean' || !Array.isArray(frame.ops) || !frame.ops.length || frame.ops.length > MAX_OPS) throw new Error('Invalid tree frame.');
      if (!this.active) { this.id = frame.id; this.started = Date.now(); }
      if (this.id !== frame.id || frame.index !== this.index++ || Date.now() - this.started > 60_000) throw new Error('Transfer sequence error.');
      for (const op of frame.ops) this.accept(op);
      if (!frame.done) return null;
      const result = this.finish(); this.clear(); return result;
    } catch (error) { this.clear(); throw error; }
  }
}
