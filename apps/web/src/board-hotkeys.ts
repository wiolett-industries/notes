/** Physical keys keep board shortcuts usable with Russian keyboard layouts. */
export function boardModeShortcut(event: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'isComposing'>, viewer: boolean): 'select' | 'hand' | 'connect' | null {
  if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return null;
  if (event.code === 'KeyV') return 'select';
  if (event.code === 'KeyH') return 'hand';
  if (event.code === 'KeyC' && !viewer) return 'connect';
  return null;
}
