import { t } from './locale';
import { useRef, useState } from 'preact/hooks';
import { Button } from './ui';
import { authError } from './passkey';
import { generateAccessKey } from './key-auth';
import { Modal } from './Modal';

export function KeyDialog({ unlock = false, submit, close }: {
  unlock?: boolean; submit: (key: string, create: boolean) => Promise<void>; close: () => void;
}) {
  const [value, setValue] = useState('');
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [visible, setVisible] = useState(true);
  const working = useRef(false);
  async function send() {
    if (working.current || !value.trim()) return;
    working.current = true; setBusy(true); setError('');
    try { await submit(value, creating); setValue(''); setVisible(false); }
    catch (err) { setError(authError(err)); }
    finally { working.current = false; setBusy(false); }
  }
  function generate() {
    try { setValue(generateAccessKey()); setCreating(true); setCopied(false); setError(''); }
    catch (err) { setError(authError(err)); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(value); setCopied(true); }
    catch { setError(t("Не удалось скопировать. Выделите ключ и сохраните вручную.")); }
  }
  return <Modal open={visible} close={() => { if (!working.current) setVisible(false); }} closed={close} label={unlock ? t("Разблокировать заметку") : creating ? t("Новый ключ") : t("Войти по ключу")}>
    <form onSubmit={e => { e.preventDefault(); void send(); }}>
      {creating && <p>{t("Сохраните ключ: без него восстановить доступ к доске нельзя.")}</p>}
      {creating ? <textarea className="access-key-input" aria-label={t("Новый ключ доступа")} value={value} readOnly spellcheck={false} rows={3} onFocus={e => e.currentTarget.select()} /> : <input className="access-key-input" aria-label={t("Ключ доступа")} type="password" value={value} onInput={e => setValue(e.currentTarget.value)} placeholder="notes_…" autoComplete="off" autoCapitalize="off" spellcheck={false} autoFocus disabled={busy} />}
      {creating && <Button onClick={() => void copy()} disabled={busy}>{copied ? t("Скопировано") : t("Скопировать ключ")}</Button>}
      {error && <p className="key-error" role="alert">{error}</p>}
      <Button type="submit" className="primary" disabled={busy || !value.trim()} aria-busy={busy}>
        {busy ? <span className="spinner" aria-label={t("Загрузка")} role="status" /> : unlock ? t("Разблокировать") : creating ? t("Ключ сохранён — открыть доску") : t("Войти")}
      </Button>
      {!unlock && !creating && <Button className="text-button" onClick={generate} disabled={busy}>{t("Создать новый ключ")}</Button>}
    </form>
  </Modal>;
}
