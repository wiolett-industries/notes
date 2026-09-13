import { t } from './locale';
import { ApiError } from './api';
import { ChunkReceiver, encodeTreeFrames, type EntityVault, type DeltaVault } from '@quiet/shared';
import { CiphertextCacheMiss, EncryptedBoardCache } from './encrypted-cache';

type Listener = (data: any) => void;
export class BoardSocket {
  private ws?: WebSocket;
  private stopped = false;
  private retry?: ReturnType<typeof setTimeout>;
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; method: string }>();
  private cache = new EncryptedBoardCache();
  private listeners = new Map<string, Set<Listener>>();
  private ready: Promise<void>;
  private sending = Promise.resolve();
  private connected!: () => void;
  constructor() { this.ready = new Promise(resolve => { this.connected = resolve; }); this.connect(); }
  private connect() {
    if (this.stopped) return;
    const url = new URL('/socket?transfer=2', location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(url); this.ws = ws;
    const receiver = new ChunkReceiver();
    let receiving = Promise.resolve();
    ws.onopen = () => { this.connected(); this.emit('connected', {}); };
    ws.onmessage = event => {
      let message;
      try { message = receiver.push(event.data); if (!message) return; } catch { ws.close(1008, 'Invalid transfer'); return; }
      // Reassembly consumes one bounded frame synchronously. Cache hydration is
      // ordered with later events, so patches cannot overtake an open snapshot.
      receiving = receiving.then(async () => {
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
      if (message.id) {
        const pending = this.pending.get(message.id); if (!pending) return;
        try {
          if (message.error) throw new ApiError(message.status ?? 500, message.error);
          if (pending.method === 'boards.get' || pending.method === 'boards.open') {
            const vault = (pending.method === 'boards.open' ? message.result.vault : message.result) as EntityVault | DeltaVault;
            const full = 'delta' in vault ? await this.cache.hydrate(vault) : vault;
            if (pending.method === 'boards.open') message.result.vault = full;
            else message.result = full;
            this.cache.save(full);
          }
          if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) throw new Error(t("Соединение прервано."));
          pending.resolve(message.result);
        } catch (error) { pending.reject(error as Error); }
        finally { clearTimeout(pending.timer); this.pending.delete(message.id); }
      } else if (message.event) {
        if (message.event === 'board.access' && message.data?.boardId) void this.cache.clear(message.data.boardId);
        this.emit(message.event, message.data);
      }
      }).catch(() => ws.close(1008, 'Invalid response'));
    };
    ws.onclose = () => {
      receiver.clear();
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(t("Соединение прервано."))); }
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
    try { return await this.rpc<T>(method, params, true); }
    catch (error) {
      // Eviction, another tab or an interrupted cache write can invalidate hints.
      // Retry once with all envelopes; callers still receive the usual full vault.
      if (!(error instanceof CiphertextCacheMiss)) throw error;
      return this.rpc<T>(method, params, false);
    }
  }
  private async rpc<T>(method: string, params: unknown, cached: boolean): Promise<T> {
    if (this.stopped) throw new Error(t("Соединение закрыто."));
    if ((method === 'boards.get' || method === 'boards.open') && params && typeof params === 'object' && 'boardId' in params && typeof params.boardId === 'string') {
      params = { ...params, known: cached ? await this.cache.hints(params.boardId) : [] };
    }
    await Promise.race([this.ready, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error(t("Нет связи с сервером."))), 20_000); this.ready.finally(() => clearTimeout(timer)); })]);
    if (this.stopped || this.ws?.readyState !== WebSocket.OPEN) throw new Error(t("Нет связи с сервером."));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(t("Сервер не ответил."))); }, 90_000);
      this.pending.set(id, { resolve, reject, timer, method });
      const ws = this.ws!;
      this.sending = this.sending.then(async () => {
        let turn = performance.now();
        for (const frame of encodeTreeFrames({ id, method, params })) {
          while (ws.bufferedAmount > 512 * 1024 && ws.readyState === WebSocket.OPEN) await new Promise(resolve => setTimeout(resolve, 10));
          if (ws.readyState !== WebSocket.OPEN || this.stopped) throw new Error(t("Соединение прервано."));
          ws.send(frame);
          if (performance.now() - turn >= 4) { await new Promise(resolve => setTimeout(resolve, 0)); turn = performance.now(); }
        }
      }).catch(error => { clearTimeout(timer); this.pending.delete(id); reject(error); });
    });
  }
  close() { this.stopped = true; clearTimeout(this.retry); this.ws?.close(); this.listeners.clear(); }
}
