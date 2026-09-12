import { useEffect, useRef, useState } from 'preact/hooks';
import { Button } from './ui';
import { authError } from './passkey';
import { generateAccessKey } from './key-auth';

export function KeyDialog({ unlock = false, submit, close }: {
  unlock?: boolean; submit: (key: string, create: boolean) => Promise<void>; close: () => void;
}) {
  const [value, setValue] = useState('');
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const working = useRef(false);
  useEffect(() => {
    dialog.current?.showModal();
    return () => { dialog.current?.close(); };
  }, []);
  async function send() {
    if (working.current || !value.trim()) return;
    working.current = true; setBusy(true); setError('');
    try { await submit(value, creating); setValue(''); close(); }
    catch (err) { setError(authError(err)); }
    finally { working.current = false; setBusy(false); }
  }
  function generate() {
    try { setValue(generateAccessKey()); setCreating(true); setCopied(false); setError(''); }
    catch (err) { setError(authError(err)); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(value); setCopied(true); }
    catch { setError('Не удалось скопировать. Выделите ключ и сохраните вручную.'); }
  }
  return <dialog ref={dialog} className="dialog key-dialog" aria-labelledby="key-dialog-title" onCancel={e => { e.preventDefault(); if (!working.current) close(); }}>
    <form onSubmit={e => { e.preventDefault(); void send(); }}>
      <h2 id="key-dialog-title">{unlock ? 'Разблокировать заметку' : creating ? 'Новый ключ' : 'Войти по ключу'}</h2>
      {creating && <p>Сохраните ключ: без него восстановить доступ к доске нельзя.</p>}
      {creating ? <textarea className="access-key-input" aria-label="Новый ключ доступа" value={value} readOnly spellcheck={false} rows={3} onFocus={e => e.currentTarget.select()} /> : <input className="access-key-input" aria-label="Ключ доступа" type="password" value={value} onInput={e => setValue(e.currentTarget.value)} placeholder="notes_…" autoComplete="off" autoCapitalize="off" spellcheck={false} autoFocus disabled={busy} />}
      {creating && <Button onClick={() => void copy()} disabled={busy}>{copied ? 'Скопировано' : 'Скопировать ключ'}</Button>}
      {error && <p className="key-error" role="alert">{error}</p>}
      <Button type="submit" className="primary" disabled={busy || !value.trim()} aria-busy={busy}>
        {busy ? <span className="spinner" aria-label="Загрузка" role="status" /> : unlock ? 'Разблокировать' : creating ? 'Ключ сохранён — открыть доску' : 'Войти'}
      </Button>
      {!unlock && !creating && <Button className="text-button" onClick={generate} disabled={busy}>Создать новый ключ</Button>}
      <Button className="text-button" onClick={close} disabled={busy}>Отмена</Button>
    </form>
  </dialog>;
}
