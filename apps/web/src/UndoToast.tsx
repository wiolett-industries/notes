import { t, countLabel } from './locale';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Button } from './ui';
import type { ComponentChildren } from 'preact';

export function AnimatedBanner({ show, className, children }: { show: boolean; className: string; children: ComponentChildren }) {
  const [present, setPresent] = useState(show);
  const previous = useRef(children);
  if (show) previous.current = children;
  useEffect(() => {
    if (show) { setPresent(true); return; }
    const timer = setTimeout(() => setPresent(false), 180);
    return () => clearTimeout(timer);
  }, [show]);
  if (!show && !present) return null;
  return <div className={`${className} animated-banner ${show ? '' : 'leaving'}`} role="alert">{show ? children : previous.current}</div>;
}

export function UndoToast({ undo, dismiss, count = 1, message }: { undo?: () => void; dismiss: () => void; count?: number; message?: string }) {
  const [leaving, setLeaving] = useState(false);
  const afterExit = useRef<(() => void) | null>(null);
  const dismissRef = useRef(dismiss); dismissRef.current = dismiss;
  useEffect(() => { const timer = setTimeout(() => setLeaving(true), 6000); return () => clearTimeout(timer); }, []);
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => (afterExit.current ?? dismissRef.current)(), 180);
    return () => clearTimeout(timer);
  }, [leaving]);
  return <div className={`undo-toast floating timed-toast ${leaving ? 'leaving' : ''}`} role="status">
    <span>{message ?? countLabel('deleted', count)}</span>{undo && <Button onClick={() => { afterExit.current = undo; setLeaving(true); }} disabled={leaving}>{t("Отменить")}</Button>}<Button icon="close" label={t("Закрыть уведомление")} onClick={() => setLeaving(true)} />
    <span className="toast-countdown" aria-hidden="true" />
  </div>;
}
