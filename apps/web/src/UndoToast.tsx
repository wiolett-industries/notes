import { useEffect, useRef, useState } from 'preact/hooks';
import { Button } from './ui';

export function UndoToast({ undo, dismiss }: { undo: () => void; dismiss: () => void }) {
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
    <span>Заметка удалена</span><Button onClick={() => { afterExit.current = undo; setLeaving(true); }} disabled={leaving}>Отменить</Button><Button icon="close" label="Закрыть уведомление" onClick={() => setLeaving(true)} />
    <span className="toast-countdown" aria-hidden="true" />
  </div>;
}
