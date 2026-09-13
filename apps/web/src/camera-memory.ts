import type { BoardData } from '@quiet/shared';

type Camera = BoardData['camera'];
const pending = new Map<string, Camera>();
let timer: ReturnType<typeof setTimeout> | undefined;
const key = (account: string, board: string) => `notes:camera:${account}:${board}`;
function valid(value: unknown): value is Camera {
  if (!value || typeof value !== 'object') return false;
  const camera = value as Camera;
  return Number.isFinite(camera.x) && Math.abs(camera.x) <= 1e9 && Number.isFinite(camera.y) && Math.abs(camera.y) <= 1e9 && Number.isFinite(camera.zoom) && camera.zoom >= .15 && camera.zoom <= 3;
}
export function readCamera(account: string, board: string, fallback: Camera): Camera {
  try {
    const value = pending.get(key(account, board)) ?? JSON.parse(localStorage.getItem(key(account, board)) ?? 'null');
    return valid(value) ? { x: value.x, y: value.y, zoom: value.zoom } : fallback;
  } catch { return fallback; }
}
export function flushCameras() {
  clearTimeout(timer); timer = undefined;
  for (const [id, camera] of pending) { try { localStorage.setItem(id, JSON.stringify(camera)); } catch { /* Storage is optional. */ } }
  pending.clear();
}
export function rememberCamera(account: string, board: string, camera: Camera) {
  if (!valid(camera)) return;
  pending.set(key(account, board), { x: camera.x, y: camera.y, zoom: camera.zoom });
  timer ??= setTimeout(flushCameras, 150);
}
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushCameras);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushCameras(); });
}
