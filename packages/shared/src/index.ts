import { z } from 'zod';
import { MAX_ENCRYPTED_BYTES } from './limits.ts';
export * from './limits.ts';

export const SESSION_SECONDS = 12 * 60 * 60;
export const GRID_SIZE = 8;
export const MAX_NOTE_TEXT_LENGTH = 1_000_000;
export const PRF_INPUT = 'quiet/board/passkey-prf/v1';
export const colors = ['sand', 'sage', 'rose', 'lavender', 'sky'] as const;
export const coordinate = z.number().finite().min(-1e9).max(1e9);
export const base64url = z.string().regex(/^[A-Za-z0-9_-]+$/);
export const envelopeSchema = z.object({
  version: z.literal(1), iv: base64url.length(16),
  ciphertext: base64url.min(22).refine(value => value.length <= MAX_ENCRYPTED_BYTES, 'Encrypted payload exceeds the configured limit.'),
}).strict();
export const noteContentSchema = z.object({
  title: z.string().max(240), text: z.string().max(MAX_NOTE_TEXT_LENGTH),
  image: z.string().max(4_000_000).regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/).optional(),
}).strict();
export const sealedNoteSchema = z.object({ wrappedKey: base64url.max(800), content: envelopeSchema, visibleTitle: z.boolean().optional(), bindingId: z.string().uuid().optional() }).strict();
export const lockKeysSchema = z.object({ publicKey: base64url.max(2000), privateKey: envelopeSchema }).strict();
export const noteSchema = z.object({
  textStyle: z.object({ level: z.number().int().min(0).max(3), bold: z.boolean(), italic: z.boolean(), underline: z.boolean(), align: z.enum(['left', 'center']).optional() }).strict().optional(),
  id: z.string().uuid(), x: coordinate, y: coordinate,
  text: z.string().max(MAX_NOTE_TEXT_LENGTH), color: z.enum(colors),
  title: z.string().max(240).default('Заметка'),
  kind: z.enum(['text', 'image']).default('text'),
  width: z.number().min(160).max(2048).default(272),
  height: z.number().min(16).max(1e9).default(248),
  pinned: z.boolean().default(false),
  mentions: z.array(z.string().uuid()).max(1000).default([]),
  image: z.string().max(4_000_000).regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/).optional(),
  sealed: sealedNoteSchema.optional(),
}).strict().refine(note => note.textStyle ? note.kind === 'text' : note.height >= 120 && note.height <= 2048, 'Invalid note dimensions')
  .refine(note => note.sealed ? note.text === '' && note.image === undefined : note.kind !== 'image' || Boolean(note.image), 'Invalid locked note or missing image');
export const connectionSchema = z.object({
  id: z.string().uuid(), source: z.string().uuid(), target: z.string().uuid(),
  label: z.string().max(500).default(''),
  style: z.enum(['solid', 'dashed']).default('solid'),
}).strict();
export const groupSchema = z.object({
  id: z.string().uuid(), title: z.string().max(240), noteIds: z.array(z.string().uuid()).min(1).max(1000),
}).strict();
export const boardSchema = z.object({
  version: z.literal(1),
  notes: z.array(noteSchema).max(10_000),
  connections: z.array(connectionSchema).max(40_000).default([]),
  groups: z.array(groupSchema).max(5000).default([]),
  lockKeys: lockKeysSchema.optional(),
  camera: z.object({ x: coordinate, y: coordinate, zoom: z.number().min(0.15).max(3) }).strict(),
}).strict().refine(board => {
  const ids = new Set(board.notes.map(note => note.id));
  const groupIds = new Set(board.groups.map(group => group.id));
  const members = board.groups.flatMap(group => group.noteIds);
  const endpoints = new Set([...ids, ...groupIds]);
  return ids.size === board.notes.length
    && groupIds.size === board.groups.length && endpoints.size === ids.size + groupIds.size
    && new Set(members).size === members.length && members.every(id => ids.has(id))
    && (!board.notes.some(note => note.sealed) || Boolean(board.lockKeys))
    && new Set(board.connections.map(edge => edge.id)).size === board.connections.length
    && board.connections.every(edge => edge.source !== edge.target && endpoints.has(edge.source) && endpoints.has(edge.target));
}, 'Invalid board references');
export const saveSchema = z.object({
  accountId: base64url.length(43),
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER - 1),
  envelope: envelopeSchema,
}).strict();
export const MAX_ENTITIES = 75003;
export const entityAccessSchema = z.object({
  address: z.string().regex(/^(?:meta|camera|lockKeys|(?:note-content|note-layout|note-image|group|connection):[0-9a-f-]{36})$/),
  pinned: z.boolean().optional(), sealed: z.boolean().optional(),
}).strict();
export const encryptedEntitySchema = z.object({
  id: base64url.length(43),
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER - 1),
  envelope: envelopeSchema,
  access: entityAccessSchema.optional(),
}).strict();
export const entityWriteSchema = encryptedEntitySchema.omit({ revision: true }).extend({ storage: z.literal('file').optional() });
export const manifestSchema = envelopeSchema.extend({ ciphertext: base64url.min(22).max(4096) });
export const deltaSchema = z.object({
  accountId: base64url.length(43),
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER - 1),
  mutationId: z.string().uuid(),
  migrate: z.boolean().default(false),
  manifest: manifestSchema,
  upserts: z.array(entityWriteSchema).max(MAX_ENTITIES),
  deletes: z.array(base64url.length(43)).max(MAX_ENTITIES),
}).strict().refine(patch => {
  const ids = [...patch.upserts.map(entity => entity.id), ...patch.deletes];
  return ids.length > 0 && new Set(ids).size === ids.length;
}, 'Duplicate or empty mutations');
export const initialEntitiesSchema = z.object({
  format: z.literal(2), manifest: manifestSchema, entities: z.array(entityWriteSchema).min(3).max(MAX_ENTITIES),
}).strict().refine(value => new Set(value.entities.map(e => e.id)).size === value.entities.length);
export const keyAuthSchema = z.object({ accountId: base64url.length(43), authToken: base64url.length(43) }).strict();
export const keyRegistrationSchema = keyAuthSchema.extend({ snapshot: initialEntitiesSchema });
export type BoardRole = 'owner' | 'editor' | 'viewer';
export type BoardEntry = { id: string; ownerId: string; role: BoardRole; name: Envelope; wrappedKey: string; publicToken?: string | null; usedBytes?: number; limitBytes?: number };
export type AccountIdentity = { publicKey: string; privateKey: Envelope; initialized?: boolean };
export const publicSnapshotSchema = z.object({ name: z.string().min(1).max(120), board: boardSchema, lockedIds: z.array(z.string().uuid()).max(10_000) }).strict().refine(value => !value.board.lockKeys && value.board.notes.every(note => !note.sealed), 'Public snapshots must not contain private keys or sealed payloads');
export type PublicSnapshot = z.infer<typeof publicSnapshotSchema>;
export type BoardData = z.infer<typeof boardSchema>;
export type NoteData = z.infer<typeof noteSchema>;
export type ConnectionData = z.infer<typeof connectionSchema>;
export type GroupData = z.infer<typeof groupSchema>;
export type LockKeys = z.infer<typeof lockKeysSchema>;
export type NoteContent = z.infer<typeof noteContentSchema>;
export type NoteColor = typeof colors[number];
export type Envelope = z.infer<typeof envelopeSchema>;
export type Snapshot = { revision: number; envelope: Envelope };
export type LegacyVault = Snapshot & { accountId: string; format?: 1 };
export type EncryptedEntity = z.infer<typeof encryptedEntitySchema>;
export type EntityWrite = z.infer<typeof entityWriteSchema>;
export type DeltaWrite = z.infer<typeof deltaSchema>;
export type InitialEntities = z.infer<typeof initialEntitiesSchema>;
export type EntityVault = { accountId: string; format: 2; revision: number; manifest: Envelope; entities: EncryptedEntity[] };
export type Vault = LegacyVault | EntityVault;
export const emptyBoard = (): BoardData => ({ version: 1, notes: [], connections: [], groups: [], camera: { x: 0, y: 0, zoom: 1 } });
export * from './transfer.ts';
