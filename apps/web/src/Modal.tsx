import { t } from './locale';
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Button } from './ui';

export function Modal({ open, close, closed, label, children, className = '' }: {
  open: boolean; close: () => void; closed?: () => void; label: string; children: ComponentChildren; className?: string;
}) {
  const element = useRef<HTMLDialogElement>(null);
  const [leaving, setLeaving] = useState(false);
  const [present, setPresent] = useState(open);
  const afterClose = useRef(closed); afterClose.current = closed;
  const outside = useRef(false);
  function isOutside(event: MouseEvent | PointerEvent) {
    const rect = element.current?.getBoundingClientRect();
    return Boolean(rect && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom));
  }
  useEffect(() => {
    if (open) { setPresent(true); setLeaving(false); if (!element.current?.open) element.current?.showModal(); return; }
    if (!element.current?.open) { setPresent(false); return; }
    for (const popover of element.current.querySelectorAll<HTMLElement>('[popover]')) if (popover.matches(':popover-open')) popover.hidePopover();
    setLeaving(true);
    const timer = setTimeout(() => { element.current?.close(); setLeaving(false); setPresent(false); afterClose.current?.(); }, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 100);
    return () => clearTimeout(timer);
  }, [open]);
  if (!open && !present) return null;
  return <dialog ref={element} className={`dialog key-dialog animated-dialog ${leaving ? 'dialog-leaving' : ''} ${className}`} aria-label={label}
    onCancel={event => { event.preventDefault(); close(); }}
    onPointerDown={event => { outside.current = event.target === event.currentTarget && isOutside(event); }}
    onClick={event => { if (outside.current && event.target === event.currentTarget && isOutside(event)) close(); outside.current = false; }}>
    <div className="dialog-heading"><h2>{label}</h2><Button icon="close" label={t("Закрыть модалку")} tooltip={false} onClick={close} /></div>
    {children}
  </dialog>;
}
