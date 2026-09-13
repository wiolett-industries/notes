import { t } from './locale';
import { useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Button, Icon } from './ui';

const choices = [{ value: 'viewer', label: t("Viewer — только просмотр") }, { value: 'editor', label: t("Редактор") }] as const;
export function RoleDropdown({ value, change, disabled, compact = false }: { value: 'viewer' | 'editor'; change: (value: 'viewer' | 'editor') => void; disabled?: boolean; compact?: boolean }) {
  const id = useId();
  const [open, setOpen] = useState(false), [active, setActive] = useState(value === 'viewer' ? 0 : 1);
  const wrapper = useRef<HTMLDivElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = popup.current, button = wrapper.current?.querySelector('button');
    if (!open || !element || !button) return;
    element.setAttribute('popover', 'manual');
    Object.assign(element.style, { position: 'fixed', inset: 'auto', margin: '0', width: `${Math.min(innerWidth - 16, Math.max(button.getBoundingClientRect().width, compact ? 156 : 240))}px`, maxHeight: `${innerHeight - 16}px`, overflowY: 'auto' });
    if (typeof element.showPopover === 'function') element.showPopover();
    const anchor = button.getBoundingClientRect(), rect = element.getBoundingClientRect();
    element.style.left = `${Math.max(8, Math.min(innerWidth - rect.width - 8, compact ? anchor.right - rect.width : anchor.left))}px`;
    element.style.top = `${Math.max(8, anchor.bottom + rect.height + 14 <= innerHeight ? anchor.bottom + 6 : anchor.top - rect.height - 6)}px`;
    const outside = (event: Event) => { if (!element.contains(event.target as Node) && !button.contains(event.target as Node)) setOpen(false); };
    const scroll = (event: Event) => { if (!element.contains(event.target as Node)) setOpen(false); };
    const resize = () => setOpen(false);
    const toggle = (event: Event) => { if ((event as ToggleEvent).newState === 'closed') setOpen(false); };
    document.addEventListener('pointerdown', outside, true); document.addEventListener('scroll', scroll, true); window.addEventListener('resize', resize); element.addEventListener('toggle', toggle);
    return () => {
      document.removeEventListener('pointerdown', outside, true); document.removeEventListener('scroll', scroll, true); window.removeEventListener('resize', resize); element.removeEventListener('toggle', toggle);
      if (element.matches(':popover-open')) element.hidePopover();
    };
  }, [open, compact]);
  function choose(index: number) { change(choices[index].value); setActive(index); setOpen(false); wrapper.current?.querySelector('button')?.focus(); }
  return <div ref={wrapper} className="role-dropdown" onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false); }}>
    <Button className="role-dropdown-trigger" label={t("Роль участника")} disabled={disabled} aria-haspopup="listbox" aria-expanded={open} aria-controls={`${id}-options`}
      onClick={() => { setActive(value === 'viewer' ? 0 : 1); setOpen(!open); }}
      onKeyDown={e => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (!open) { setOpen(true); setActive(value === 'viewer' ? 0 : 1); } else setActive(index => (index + 1) % choices.length); }
        if (open && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); choose(active); }
        if (open && (e.key === 'Home' || e.key === 'End')) { e.preventDefault(); setActive(e.key === 'Home' ? 0 : choices.length - 1); }
      }} aria-activedescendant={open ? `${id}-${choices[active].value}` : undefined}>
      {compact ? value === 'viewer' ? t('Просмотр') : t("Редактор") : choices.find(item => item.value === value)!.label}<span className={`dropdown-chevron ${open ? 'open' : ''}`}><Icon name="next" size={16} /></span>
    </Button>
    {open && <div ref={popup} className="role-dropdown-options" id={`${id}-options`} role="listbox" aria-label={t("Роль участника")}>
      {choices.map((choice, index) => <Button key={choice.value} id={`${id}-${choice.value}`} role="option" aria-selected={choice.value === value} className={active === index ? 'dropdown-active' : ''} onPointerDown={e => e.preventDefault()} onMouseEnter={() => setActive(index)} onClick={() => choose(index)}><span className="role-option-label">{compact ? choice.value === 'viewer' ? t('Просмотр') : t("Редактор") : choice.label}</span><span className="role-option-check">{choice.value === value && <Icon name="check" size={16} />}</span></Button>)}
    </div>}
  </div>;
}
