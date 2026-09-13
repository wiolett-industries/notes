import { t } from './locale';
import { Button } from './ui';
import { type routeConnections } from './geometry';

type Props = {
  edges: ReturnType<typeof routeConnections>; draft?: string;
  selected: string | null; editing: string | null;
  select: (id: string) => void; edit: (id: string | null) => void;
  change: (id: string, label: string) => void; remove: (id: string) => void;
  toggleStyle: (id: string) => void;
  readOnly?: boolean;
};
export function Connections({ edges, draft, selected, editing, select, edit, change, remove, toggleStyle, readOnly = false }: Props) {
  return <>
    <svg className="connections" width="1" height="1" aria-label={t("Связи между заметками")}>
      <defs><marker id="connection-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="12" markerHeight="12" markerUnits="userSpaceOnUse" orient="auto"><path d="M 0 0 L 10 5 L 0 10 Z" className="connection-arrowhead" /></marker><marker id="mention-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto"><path d="M 0 0 L 10 5 L 0 10 Z" className="mention-arrowhead" /></marker></defs>
      {edges.map(edge => <g key={edge.id} className={`connection ${edge.mention ? 'mention-connection' : ''} ${selected === edge.id ? 'selected' : ''}`}>
        {edge.mention && <title>{t("Упоминание — удаляется вместе с упоминанием в тексте")}</title>}
        <path className="connection-line" d={edge.path} stroke-dasharray={edge.mention ? '4 5' : edge.style === 'dashed' ? '8 6' : undefined} marker-end={edge.mention ? 'url(#mention-arrow)' : 'url(#connection-arrow)'} />
        <path className="connection-hit" d={edge.path} aria-label={edge.mention ? t("Связь упоминания") : edge.labelText || t("Связь")} onPointerDown={e => e.stopPropagation()} onClick={() => { if (!edge.mention) select(edge.id); }} onDblClick={e => { e.stopPropagation(); if (!edge.mention) { select(edge.id); edit(edge.id); } }} />
      </g>)}
      {draft && <path className="connection-line connection-draft" d={draft} marker-end="url(#connection-arrow)" />}
    </svg>
    {edges.filter(edge => !edge.mention && (edge.labelText || selected === edge.id || editing === edge.id)).map(edge => <div key={edge.id} className={`connection-label floating ${selected === edge.id ? 'selected' : ''}`} style={{ left: edge.label.x, top: edge.label.y }} onPointerDown={e => e.stopPropagation()} onDblClick={e => e.stopPropagation()}>
      {editing === edge.id ? <input aria-label={t("Подпись стрелки")} maxLength={500} value={edge.labelText} ref={el => { if (el && document.activeElement !== el) { el.focus({ preventScroll: true }); el.select(); } }} onInput={e => change(edge.id, e.currentTarget.value)} onBlur={() => edit(null)} onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') edit(null); }} /> :
        <button type="button" className="connection-text" onClick={() => select(edge.id)} onDblClick={e => { e.stopPropagation(); edit(edge.id); }}>{edge.labelText || t("Подпись")}</button>}
      {!readOnly && selected === edge.id && <><Button icon={edge.style === 'dashed' ? 'dashed' : 'minus'} label={edge.style === 'dashed' ? t("Сделать связь сплошной") : t("Сделать связь пунктирной")} aria-pressed={edge.style === 'dashed'} onClick={() => toggleStyle(edge.id)} /><Button icon="trash" label={t("Удалить связь")} onClick={() => remove(edge.id)} /></>}
    </div>)}
  </>;
}
