import { GRID_SIZE, type ConnectionData, type NoteData, type GroupData, type BoardData } from '@quiet/shared';

export type Point = { x: number; y: number };
export type Rect = Point & { width: number; height: number };
export type Endpoint = Rect & { id: string };
type Side = 'left' | 'right' | 'top' | 'bottom';
type Port = Point & { side: Side };
export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
export const snap = (value: number) => Math.round(value / GRID_SIZE) * GRID_SIZE;
export const center = (note: Rect): Point => ({ x: note.x + note.width / 2, y: note.y + note.height / 2 });
const normal: Record<Side, Point> = { left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 } };
function sides(a: Rect, b: Rect): [Side, Side] {
  const ac = center(a), bc = center(b);
  if (Math.abs(bc.x - ac.x) / (a.width + b.width) >= Math.abs(bc.y - ac.y) / (a.height + b.height)) return bc.x >= ac.x ? ['right', 'left'] : ['left', 'right'];
  return bc.y >= ac.y ? ['bottom', 'top'] : ['top', 'bottom'];
}
function port(note: Rect, side: Side, fraction = .5): Port {
  if (side === 'left' || side === 'right') return { side, x: note.x + (side === 'right' ? note.width : 0), y: note.y + note.height * fraction };
  return { side, x: note.x + note.width * fraction, y: note.y + (side === 'bottom' ? note.height : 0) };
}
function curve(start: Port, end: Port) {
  const distance = clamp(Math.hypot(end.x - start.x, end.y - start.y) * .45, 40, 240);
  const a = { x: start.x + normal[start.side].x * distance, y: start.y + normal[start.side].y * distance };
  const b = { x: end.x + normal[end.side].x * distance, y: end.y + normal[end.side].y * distance };
  return {
    path: `M ${start.x} ${start.y} C ${a.x} ${a.y}, ${b.x} ${b.y}, ${end.x} ${end.y}`,
    label: { x: (start.x + 3 * a.x + 3 * b.x + end.x) / 8, y: (start.y + 3 * a.y + 3 * b.y + end.y) / 8 },
  };
}
// Incoming and outgoing arrows share the same side's slots. Sort by their
// opposite endpoint so a fan of arrows keeps its order as notes move.
export function prepareConnectionRouting(notes: Endpoint[], edges: (ConnectionData & { mention?: boolean })[]) {
  const byId = new Map(notes.map(note => [note.id, note]));
  const groups = new Map<string, { key: string; order: number }[]>();
  const entries = edges.flatMap(edge => {
    const source = byId.get(edge.source), target = byId.get(edge.target);
    if (!source || !target) return [];
    const [from, to] = sides(source, target);
    for (const [note, side, other, suffix] of [[source, from, target, 's'], [target, to, source, 't']] as const) {
      const groupKey = `${note.id}:${side}`;
      const group = groups.get(groupKey) ?? [];
      const p = center(other);
      group.push({ key: `${edge.id}:${suffix}`, order: side === 'left' || side === 'right' ? p.y : p.x });
      groups.set(groupKey, group);
    }
    return [{ edge, source, target, from, to }];
  });
  const slots = new Map<string, number>();
  for (const group of groups.values()) {
    group.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
    group.forEach((entry, index) => slots.set(entry.key, (index + 1) / (group.length + 1)));
  }
  return entries.map(({ edge, source, target, from, to }) => {
    const start = port(source, from, slots.get(`${edge.id}:s`)), end = port(target, to, slots.get(`${edge.id}:t`));
    // A cubic stays inside its control-point hull; handles extend at most 240
    // world pixels. The union also retains links crossing the viewport with
    // both endpoints offscreen.
    const bounds = { x: Math.min(source.x, target.x) - 240, y: Math.min(source.y, target.y) - 240,
      width: Math.max(source.x + source.width, target.x + target.width) - Math.min(source.x, target.x) + 480,
      height: Math.max(source.y + source.height, target.y + target.height) - Math.min(source.y, target.y) + 480 };
    return { edge, start, end, bounds };
  });
}
export function routePreparedConnections(entries: ReturnType<typeof prepareConnectionRouting>, viewport?: Rect, retained: ReadonlySet<string> = new Set()) {
  return entries.filter(entry => !viewport || retained.has(entry.edge.id) || intersects(entry.bounds, viewport))
    .map(({ edge, start, end }) => ({ ...edge, labelText: edge.label, ...curve(start, end) }));
}
export function routeConnections(notes: Endpoint[], edges: (ConnectionData & { mention?: boolean })[], viewport?: Rect) {
  return routePreparedConnections(prepareConnectionRouting(notes, edges), viewport);
}
export function draftConnection(source: Endpoint, point: Point, target?: Endpoint) {
  const destination = target ?? { ...source, x: point.x, y: point.y, width: 0, height: 0 };
  const [from, to] = sides(source, destination);
  return curve(port(source, from), port(destination, to));
}
export function magneticTarget(notes: Endpoint[], point: Point, source: string, zoom: number) {
  let best: Endpoint | undefined;
  let distance = 24 / zoom;
  for (const note of notes) {
    if (note.id === source) continue;
    const dx = Math.max(note.x - point.x, 0, point.x - note.x - note.width);
    const dy = Math.max(note.y - point.y, 0, point.y - note.y - note.height);
    const d = Math.hypot(dx, dy);
    if (d <= distance) { best = note; distance = d; }
  }
  return best;
}
export function groupBounds(groups: GroupData[], notes: NoteData[]) {
  const byId = new Map(notes.map(note => [note.id, note]));
  return groups.flatMap(group => {
    const members = group.noteIds.flatMap(id => byId.has(id) ? [byId.get(id)!] : []);
    if (!members.length) return [];
    const x = Math.min(...members.map(n => n.x)) - 24, y = Math.min(...members.map(n => n.y)) - 24;
    return [{ ...group, x, y, width: Math.max(...members.map(n => n.x + n.width)) + 24 - x, height: Math.max(...members.map(n => n.y + n.height)) + 24 - y }];
  });
}
export const contains = (rect: Rect, point: Point) => point.x >= rect.x && point.y >= rect.y && point.x <= rect.x + rect.width && point.y <= rect.y + rect.height;
export const intersects = (a: Rect, b: Rect) => a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y;
export function cleanGroups(board: BoardData): BoardData {
  const ids = new Set(board.notes.map(note => note.id));
  const groups = board.groups.map(group => ({ ...group, noteIds: group.noteIds.filter(id => ids.has(id)) })).filter(group => group.noteIds.length);
  const endpoints = new Set([...ids, ...groups.map(group => group.id)]);
  return { ...board, groups, connections: board.connections.filter(edge => endpoints.has(edge.source) && endpoints.has(edge.target)) };
}
