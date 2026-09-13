import { t, localizeError } from './locale';
import { useEffect, useState } from 'preact/hooks';
import { publicSnapshotSchema, type BoardData } from '@quiet/shared';
import { Board } from './Board';
import { Button } from './ui';
import { BoardSocket } from './socket';
import { readCamera, rememberCamera, flushCameras } from './camera-memory';

export function PublicBoard({ token }: { token: string }) {
  const [board, setBoard] = useState<BoardData | null>(null), [title, setTitle] = useState(''), [error, setError] = useState('');
  const [key, setKey] = useState<CryptoKey | null>(null);
  useEffect(() => {
    const socket = new BoardSocket(); let active = true;
    void (async () => {
      try {
        const data = publicSnapshotSchema.parse(await socket.request('public.get', { token }));
        if (!active) return;
        const dummy = { version: 1 as const, iv: 'A'.repeat(16), ciphertext: 'A'.repeat(22) };
        setBoard({ ...data.board, camera: readCamera('public', token, data.board.camera), notes: data.board.notes.map(note => data.lockedIds.includes(note.id) ? { ...note, sealed: { wrappedKey: 'AA', content: dummy, visibleTitle: true } } : note) });
        setTitle(data.name); document.title = `${data.name} · Notes`;
        setKey(await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']));
      } catch (err) { if (active) setError(err instanceof Error ? localizeError(err) : t("Доска недоступна.")); }
      finally { socket.close(); }
    })();
    return () => { flushCameras(); active = false; socket.close(); document.title = 'Notes'; };
  }, [token]);
  return <main>{board && key ? <Board board={board} onChange={next => { rememberCamera('public', token, next.camera); setBoard({ ...board, camera: next.camera }); }} role="viewer" publicView onToggleLock={async () => {}} clipboardKey={key} accountId={token} actions={<span className="public-board-title">{title}</span>} /> : <div className="login-screen">{error ? <p className="public-error" role="alert">{error}</p> : <Button disabled aria-label={t("Загрузка доски")}><span className="spinner" /></Button>}</div>}</main>;
}
