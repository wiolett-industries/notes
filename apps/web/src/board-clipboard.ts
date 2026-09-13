import { z } from 'zod';
import { boardSchema, emptyBoard, envelopeSchema, MAX_BOARD_BYTES, MAX_ENCRYPTED_BYTES, type BoardData } from '@quiet/shared';
import { encryptBoard, decryptBoard } from './crypto';
import { clamp, snap } from './geometry';
import { remapMentions, mentionIds } from './markdown';

export const CLIPBOARD_PREFIX = 'notes-clipboard-v1:';
const packetSchema = z.object({ accountId: z.string(), envelope: envelopeSchema }).strict();
export function copySelection(board: BoardData, selected: string[]): BoardData {
  const ids = new Set(selected);
  const groups = board.groups.filter(group => group.noteIds.every(id => ids.has(id)));
  const endpoints = new Set([...ids, ...groups.map(group => group.id)]);
  return boardSchema.parse({ ...emptyBoard(), lockKeys: board.lockKeys,
    notes: board.notes.filter(note => ids.has(note.id)), groups,
    connections: board.connections.filter(edge => endpoints.has(edge.source) && endpoints.has(edge.target)),
  });
}
// The system clipboard receives ciphertext, not plaintext notes or image data.
export function writeSelection(key: CryptoKey, accountId: string, board: BoardData): Promise<void> {
  const content = encryptBoard(key, accountId, 1, board).then(envelope => CLIPBOARD_PREFIX + JSON.stringify({ accountId, envelope }));
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    return navigator.clipboard.write([new ClipboardItem({ 'text/plain': content.then(text => new Blob([text], { type: 'text/plain' })) })]);
  }
  return content.then(text => navigator.clipboard.writeText(text));
}
export async function readSelection(key: CryptoKey, accountId: string, text: string) {
  if (!text.startsWith(CLIPBOARD_PREFIX) || text.length > MAX_ENCRYPTED_BYTES + 100_000) throw new Error('Некорректные данные в буфере обмена.');
  const packet = packetSchema.parse(JSON.parse(text.slice(CLIPBOARD_PREFIX.length)));
  if (packet.accountId !== accountId) throw new Error('Заметки скопированы из другой доски.');
  return decryptBoard(key, accountId, 1, packet.envelope);
}
export function pasteSelection(board: BoardData, source: BoardData, offset: { x: number; y: number }) {
  if (!source.notes.length) return { board, ids: [] };
  if (source.notes.some(note => note.sealed) && source.lockKeys?.publicKey !== board.lockKeys?.publicKey) throw new Error('Ключи заблокированных заметок не совпадают с ключами доски.');
  const ids = new Map([...source.notes, ...source.groups].map(item => [item.id, crypto.randomUUID()]));
  const notes = source.notes.map(note => ({ ...note, id: ids.get(note.id)!,
    ...(!note.sealed ? { text: remapMentions(note.text, ids), mentions: mentionIds(remapMentions(note.text, ids)) } : {}),
    x: clamp(snap(note.x + offset.x), -1e9, 1e9), y: clamp(snap(note.y + offset.y), -1e9, 1e9),
    ...(note.sealed ? { sealed: { ...note.sealed, bindingId: note.sealed.bindingId ?? note.id } } : {}),
  }));
  const groups = source.groups.map(group => ({ ...group, id: ids.get(group.id)!, noteIds: group.noteIds.map(id => ids.get(id)!) }));
  const connections = source.connections.map(edge => ({ ...edge, id: crypto.randomUUID(), source: ids.get(edge.source)!, target: ids.get(edge.target)! }));
  if (board.notes.length + notes.length > 10000 || board.groups.length + groups.length > 5000 || board.connections.length + connections.length > 40000) throw new Error('Недостаточно места на доске для вставки.');
  const next = boardSchema.parse({ ...board, notes: [...board.notes, ...notes], groups: [...board.groups, ...groups], connections: [...board.connections, ...connections] });
  if (new TextEncoder().encode(JSON.stringify(next)).byteLength > MAX_BOARD_BYTES) throw new Error('Вставка превысит размер доски (300 МБ).');
  return { board: next, ids: notes.map(note => note.id) };
}
