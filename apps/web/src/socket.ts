import { ApiError } from './api';
import { ChunkReceiver, encodeFrames } from '@quiet/shared';

type Listener = (data: any) => void;
export class BoardSocket {
  private ws?: WebSocket;
  private stopped = false;
  private retry?: ReturnType<typeof setTimeout>;
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private listeners = new Map<string, Set<Listener>>();
  private ready: Promise<void>;
  private sending = Promise.resolve();
  private connected!: () => void;
  constructor() { this.ready = new Promise(resolve => { this.connected = resolve; }); this.connect(); }
  private connect() {
    if (this.stopped) return;
    const url = new URL('/socket', location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(url); this.ws = ws;
    const receiver = new ChunkReceiver();
    ws.onopen = () => { this.connected(); this.emit('connected', {}); };
    ws.onmessage = event => {
      let message;
      try { message = receiver.push(event.data); if (!message) return; } catch { ws.close(1008, 'Invalid transfer'); return; }
      if (message.id) {
        const pending = this.pending.get(message.id); if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(message.id);
        if (message.error) pending.reject(new ApiError(message.status ?? 500, message.error));
        else pending.resolve(message.result);
      } else if (message.event) this.emit(message.event, message.data);
    };
    ws.onclose = () => {
      receiver.clear();
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Соединение прервано.')); }
      this.pending.clear(); this.ready = new Promise(resolve => { this.connected = resolve; }); this.emit('disconnected', {});
      if (!this.stopped) this.retry = setTimeout(() => this.connect(), 1500);
    };
  }
  on(event: string, listener: Listener) {
    const listeners = this.listeners.get(event) ?? new Set(); listeners.add(listener); this.listeners.set(event, listeners);
    return () => { listeners.delete(listener); };
  }
  private emit(event: string, data: unknown) { for (const listener of this.listeners.get(event) ?? []) listener(data); }
  async request<T = any>(method: string, params: unknown = {}): Promise<T> {
    if (this.stopped) throw new Error('Соединение закрыто.');
    await Promise.race([this.ready, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('Нет связи с сервером.')), 20_000); this.ready.finally(() => clearTimeout(timer)); })]);
    if (this.stopped || this.ws?.readyState !== WebSocket.OPEN) throw new Error('Нет связи с сервером.');
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Сервер не ответил.')); }, 90_000);
      this.pending.set(id, { resolve, reject, timer });
      const ws = this.ws!;
      this.sending = this.sending.then(async () => {
        for (const frame of encodeFrames({ id, method, params })) {
          while (ws.bufferedAmount > 512 * 1024 && ws.readyState === WebSocket.OPEN) await new Promise(resolve => setTimeout(resolve, 10));
          if (ws.readyState !== WebSocket.OPEN || this.stopped) throw new Error('Соединение прервано.');
          ws.send(frame);
        }
      }).catch(error => { clearTimeout(timer); this.pending.delete(id); reject(error); });
    });
  }
  close() { this.stopped = true; clearTimeout(this.retry); this.ws?.close(); this.listeners.clear(); }
}
