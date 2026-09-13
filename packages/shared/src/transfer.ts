import { MAX_TRANSFER_BYTES } from './limits.ts';
export const CHUNK_CHARS = 64 * 1024;
const encoder = new TextEncoder();
export function* encodeFrames(value: unknown): Generator<string> {
  const json = JSON.stringify(value);
  if (encoder.encode(json).byteLength > MAX_TRANSFER_BYTES) throw new Error('Слишком большой пакет.');
  if (json.length <= CHUNK_CHARS) { yield json; return; }
  const id = crypto.randomUUID(), total = Math.ceil(json.length / CHUNK_CHARS);
  for (let index = 0; index < total; index++) yield JSON.stringify({ chunk: { id, index, total, data: json.slice(index * CHUNK_CHARS, (index + 1) * CHUNK_CHARS) } });
}
export class ChunkReceiver {
  private stream?: { id: string; total: number; parts: string[]; bytes: number; started: number };
  push(raw: string): any | null {
    if (raw.length > CHUNK_CHARS * 7) throw new Error('Слишком большой чанк.');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') throw new Error('Некорректный пакет.');
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
  clear() { this.stream = undefined; }
}
