import { useEffect, useRef, useState } from 'preact/hooks';
import { Modal } from './Modal';
import { t } from './locale';

type View = { x: number; y: number; scale: number };
type Point = { x: number; y: number };
export function ImagePreview({ src, title, close }: { src?: string; title?: string; close: () => void }) {
  const canvas = useRef<HTMLDivElement>(null), image = useRef<HTMLImageElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, scale: 1 });
  const current = useRef(view), fittedScale = useRef(1);
  const points = useRef(new Map<number, Point>());
  const [dragging, setDragging] = useState(false);
  function move(next: View) { current.current = next; setView(next); }
  function fit() {
    const area = canvas.current, img = image.current;
    if (!area || !img?.naturalWidth) return;
    const scale = Math.min(1, area.clientWidth / img.naturalWidth, area.clientHeight / img.naturalHeight);
    fittedScale.current = scale;
    move({ scale, x: (area.clientWidth - img.naturalWidth * scale) / 2, y: (area.clientHeight - img.naturalHeight * scale) / 2 });
  }
  function local(x: number, y: number) {
    const rect = canvas.current!.getBoundingClientRect();
    return { x: x - rect.left, y: y - rect.top };
  }
  function zoom(factor: number, at: Point) {
    const old = current.current;
    const scale = Math.max(fittedScale.current / 10, Math.min(fittedScale.current * 20, old.scale * factor));
    move({ scale, x: at.x - (at.x - old.x) * scale / old.scale, y: at.y - (at.y - old.y) * scale / old.scale });
  }
  useEffect(() => {
    if (!src || !canvas.current) return;
    points.current.clear(); setDragging(false); fit();
    const area = canvas.current;
    const wheel = (event: WheelEvent) => {
      event.preventDefault(); event.stopPropagation();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? area.clientHeight : 1);
      zoom(Math.exp(-Math.max(-500, Math.min(500, delta)) * (event.ctrlKey ? .01 : .002)), local(event.clientX, event.clientY));
    };
    let previousScale = 1;
    const gestureStart = (event: Event) => { event.preventDefault(); previousScale = 1; };
    const gestureChange = (event: Event) => {
      event.preventDefault();
      const gesture = event as Event & { scale: number; clientX: number; clientY: number };
      if (gesture.scale > 0) {
        zoom(gesture.scale / previousScale, local(gesture.clientX, gesture.clientY)); previousScale = gesture.scale;
      }
    };
    area.addEventListener('wheel', wheel, { passive: false });
    area.addEventListener('gesturestart', gestureStart, { passive: false });
    area.addEventListener('gesturechange', gestureChange, { passive: false });
    const observer = new ResizeObserver(fit); observer.observe(area);
    return () => { observer.disconnect(); points.current.clear(); area.removeEventListener('wheel', wheel); area.removeEventListener('gesturestart', gestureStart); area.removeEventListener('gesturechange', gestureChange); };
  }, [src]);
  function pointerDown(event: PointerEvent) {
    if (event.button > 1) return;
    event.preventDefault(); event.stopPropagation();
    canvas.current!.setPointerCapture(event.pointerId);
    points.current.set(event.pointerId, local(event.clientX, event.clientY)); setDragging(true);
  }
  function pointerMove(event: PointerEvent) {
    event.stopPropagation();
    const before = [...points.current.values()], previous = points.current.get(event.pointerId);
    if (!previous) return;
    const next = local(event.clientX, event.clientY); points.current.set(event.pointerId, next);
    if (points.current.size === 2) {
      const after = [...points.current.values()];
      const middle = (pair: Point[]) => ({ x: (pair[0].x + pair[1].x) / 2, y: (pair[0].y + pair[1].y) / 2 });
      const distance = (pair: Point[]) => Math.hypot(pair[1].x - pair[0].x, pair[1].y - pair[0].y);
      const oldMid = middle(before), newMid = middle(after);
      zoom(distance(after) / Math.max(1, distance(before)), oldMid);
      move({ ...current.current, x: current.current.x + newMid.x - oldMid.x, y: current.current.y + newMid.y - oldMid.y });
    } else if (points.current.size === 1) move({ ...current.current, x: current.current.x + next.x - previous.x, y: current.current.y + next.y - previous.y });
  }
  function pointerUp(event: PointerEvent) {
    event.stopPropagation(); points.current.delete(event.pointerId);
    if (canvas.current?.hasPointerCapture(event.pointerId)) canvas.current.releasePointerCapture(event.pointerId);
    setDragging(points.current.size > 0);
  }
  return <Modal open={Boolean(src)} close={close} label={title || t('Заметка')} className="image-preview" hideHeading>
    <div ref={canvas} className={`image-preview-canvas ${dragging ? 'dragging' : ''}`}
      onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} onLostPointerCapture={pointerUp}
      onDblClick={event => { event.stopPropagation(); fit(); }}>
      {src && <img ref={image} src={src} alt={title ?? ''} draggable={false} onLoad={fit} style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }} />}
    </div>
  </Modal>;
}
