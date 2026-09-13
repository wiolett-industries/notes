import { t } from './locale';
import { useEffect, useState } from 'preact/hooks';
import { Button, Icon } from './ui';

type Props = { query: string; count: number; index: number; change: (query: string) => void; step: (direction: number) => void; close: () => void };
export function SearchPopover({ query, count, index, change, step, close }: Props) {
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(close, 180);
    return () => clearTimeout(timer);
  }, [leaving, close]);
  return <div className={`search-popover floating ${leaving ? 'leaving' : ''}`} role="search" onDblClick={e => e.stopPropagation()}>
    <Icon name="search" size={18} />
    <input autoFocus aria-label={t("Поиск по доске")} placeholder={t("Поиск")} value={query} onInput={e => change(e.currentTarget.value)} onKeyDown={e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setLeaving(true); }
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); step(e.shiftKey ? -1 : 1); }
    }} />
    <span className="search-count" role="status">{query.trim() ? count ? `${index + 1}/${count}` : t("Не найдено") : ''}</span>
    <Button icon="previous" label={t("Предыдущий результат")} disabled={!count} onClick={() => step(-1)} />
    <Button icon="next" label={t("Следующий результат")} disabled={!count} onClick={() => step(1)} />
    <Button icon="close" label={t("Закрыть поиск")} onClick={() => setLeaving(true)} />
  </div>;
}
