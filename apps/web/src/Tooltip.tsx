import { useEffect } from 'preact/hooks';

export function Tooltip() {
  useEffect(() => {
    let target: HTMLElement | null = null, tip: HTMLDivElement | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let described: string | null = null;
    function hide() {
      clearTimeout(timer);
      if (target && tip) {
        if (described === null) target.removeAttribute('aria-describedby');
        else target.setAttribute('aria-describedby', described);
      }
      tip?.remove(); tip = null; target = null; described = null;
    }
    function show() {
      if (!target?.isConnected || !target.dataset.tooltip) return;
      tip = document.createElement('div'); tip.id = 'notes-tooltip'; tip.className = 'custom-tooltip'; tip.setAttribute('role', 'tooltip'); tip.textContent = target.dataset.tooltip;
      tip.setAttribute('popover', 'manual');
      (target.closest('dialog[open]') ?? document.body).append(tip);
      if (typeof tip.showPopover === 'function') tip.showPopover();
      const anchor = target.getBoundingClientRect(), rect = tip.getBoundingClientRect();
      const left = Math.max(8, Math.min(innerWidth - rect.width - 8, anchor.left + (anchor.width - rect.width) / 2));
      const top = anchor.top >= rect.height + 16 ? anchor.top - rect.height - 8 : Math.min(innerHeight - rect.height - 8, anchor.bottom + 8);
      tip.style.left = `${left}px`; tip.style.top = `${Math.max(8, top)}px`;
      described = target.getAttribute('aria-describedby'); target.setAttribute('aria-describedby', [described, tip.id].filter(Boolean).join(' '));
    }
    function enter(event: Event) {
      if (event instanceof PointerEvent && event.pointerType === 'touch') return;
      const next = (event.target as Element | null)?.closest<HTMLElement>('[data-tooltip]');
      if (!next || next === target) return;
      hide(); target = next; timer = setTimeout(show, 400);
    }
    function leave(event: Event) {
      const related = (event as FocusEvent | PointerEvent).relatedTarget;
      if (target && related instanceof Node && target.contains(related)) return;
      hide();
    }
    function key(event: KeyboardEvent) { if (event.key === 'Escape') hide(); }
    document.addEventListener('pointerover', enter, true); document.addEventListener('focusin', enter, true);
    document.addEventListener('pointerout', leave, true); document.addEventListener('focusout', leave, true);
    document.addEventListener('pointerdown', hide, true); document.addEventListener('scroll', hide, true);
    document.addEventListener('keydown', key, true); window.addEventListener('resize', hide);
    return () => {
      hide(); document.removeEventListener('pointerover', enter, true); document.removeEventListener('focusin', enter, true);
      document.removeEventListener('pointerout', leave, true); document.removeEventListener('focusout', leave, true);
      document.removeEventListener('pointerdown', hide, true); document.removeEventListener('scroll', hide, true);
      document.removeEventListener('keydown', key, true); window.removeEventListener('resize', hide);
    };
  }, []);
  return null;
}
