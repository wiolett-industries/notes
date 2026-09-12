import { randomBytes, createHash } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse, type WebAuthnCredential, type RegistrationResponseJSON, type AuthenticationResponseJSON } from '@simplewebauthn/server';
import { envelopeSchema, saveSchema, deltaSchema, initialEntitiesSchema, MAX_ENCRYPTED_BYTES } from '@quiet/shared';
import { StorageLimitError, type Store, type Ceremony } from './store.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const SESSION_SECONDS = 12 * 60 * 60;
const CEREMONY_SECONDS = 5 * 60;
const credentialId = z.string().regex(/^[A-Za-z0-9_-]+$/).min(1).max(2048);
const encoded = z.string().regex(/^[A-Za-z0-9_-]+$/).min(1).max(100_000);
// Explicit allowlist: PRF results and other client extension data must never enter the protocol.
const registrationSchema = z.object({
  id: credentialId, rawId: credentialId, type: z.literal('public-key'),
  response: z.object({ clientDataJSON: encoded, attestationObject: encoded, transports: z.array(z.string().max(32)).max(12).optional() }).strict(),
  clientExtensionResults: z.object({}).strict(),
}).strict();
const authenticationSchema = z.object({
  id: credentialId, rawId: credentialId, type: z.literal('public-key'),
  response: z.object({ clientDataJSON: encoded, authenticatorData: encoded, signature: encoded, userHandle: encoded }).strict(),
  clientExtensionResults: z.object({}).strict(),
}).strict();
type Config = { origin: string; rpID: string; clientAddress?: (c: Context) => string; now?: () => number };

export function createApp(store: Store, config: Config) {
  const origin = new URL(config.origin);
  if (origin.origin !== config.origin || origin.hostname !== config.rpID) throw new Error('ORIGIN must be an exact origin and RP_ID must match its hostname.');
  if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && origin.hostname === 'localhost')) throw new Error('HTTPS required except on localhost.');
  const secure = origin.protocol === 'https:';
  const sessionName = secure ? '__Host-quiet-session' : 'quiet-session';
  const ceremonyName = secure ? '__Host-quiet-ceremony' : 'quiet-ceremony';
  const cookie = { httpOnly: true, sameSite: 'Strict' as const, secure, path: '/' };
  const now = config.now ?? Date.now;
  const app = new Hono();
  const rates = new Map<string, { count: number; until: number }>();
  let lastCleanup = 0;
  app.use('*', async (c, next) => {
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Frame-Options', 'DENY');
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (secure) c.header('Strict-Transport-Security', 'max-age=31536000');
    c.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    await next();
  });
  app.use('/api/*', bodyLimit({ maxSize: MAX_ENCRYPTED_BYTES + 200_000, onError: c => c.json({ error: 'Слишком большая доска.' }, 413) }));
  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (!['GET', 'HEAD'].includes(c.req.method)) {
      if (c.req.header('Origin') !== config.origin) throw new HTTPException(403, { message: 'Недопустимый источник запроса.' });
      if (!c.req.header('Content-Type')?.startsWith('application/json')) throw new HTTPException(415, { message: 'Ожидается JSON.' });
    }
    const time = now();
    if (time - lastCleanup > 60_000) {
      store.cleanup(time);
      for (const [key, value] of rates) if (value.until <= time) rates.delete(key);
      lastCleanup = time;
    }
    const auth = c.req.path.startsWith('/api/auth/');
    const address = config.clientAddress?.(c) ?? 'local';
    const key = `${auth ? 'auth' : 'api'}:${address}`;
    let rate = rates.get(key);
    if (!rate || rate.until <= time) {
      if (rates.size >= 10_000) throw new HTTPException(429, { message: 'Сервер занят. Попробуйте позже.' });
      rate = { count: 0, until: time + 60_000 }; rates.set(key, rate);
    }
    if (++rate.count > (auth ? 30 : 300)) {
      c.header('Retry-After', String(Math.ceil((rate.until - time) / 1000)));
      throw new HTTPException(429, { message: 'Слишком много запросов. Подождите минуту.' });
    }
    await next();
  });
  function setCeremony(c: Context, payload: Ceremony) {
    const old = getCookie(c, ceremonyName);
    if (old) store.takeCeremony(hash(old), now());
    const value = token();
    store.putCeremony(hash(value), payload, now() + CEREMONY_SECONDS * 1000);
    setCookie(c, ceremonyName, value, { ...cookie, maxAge: CEREMONY_SECONDS });
  }
  function takeCeremony(c: Context, kind: Ceremony['kind']) {
    const value = getCookie(c, ceremonyName);
    deleteCookie(c, ceremonyName, cookie);
    const ceremony = value ? store.takeCeremony(hash(value), now()) : undefined;
    if (!ceremony || ceremony.kind !== kind) throw new HTTPException(400, { message: 'Запрос истёк. Начните вход заново.' });
    return ceremony;
  }
  function setSession(c: Context, id: string) {
    const previous = getCookie(c, sessionName);
    if (previous) store.deleteSession(hash(previous));
    const value = token();
    store.putSession(hash(value), id, now() + SESSION_SECONDS * 1000);
    setCookie(c, sessionName, value, { ...cookie, maxAge: SESSION_SECONDS });
  }
  function account(c: Context) {
    const value = getCookie(c, sessionName);
    const result = value ? store.accountBySession(hash(value), now()) : undefined;
    if (!result) throw new HTTPException(401, { message: 'Сессия истекла. Сохраните локальную копию и войдите снова.' });
    return result;
  }
  async function verifyAssertion(response: AuthenticationResponseJSON, ceremony: Ceremony, credential: WebAuthnCredential, accountId: string) {
    if (response.id !== response.rawId || response.id !== credential.id || response.response.userHandle !== accountId) throw new HTTPException(400, { message: 'Не удалось подтвердить passkey.' });
    const result = await verifyAuthenticationResponse({ response, expectedChallenge: ceremony.challenge, expectedOrigin: config.origin, expectedRPID: config.rpID, credential, requireUserVerification: true });
    if (!result.verified) throw new HTTPException(400, { message: 'Не удалось подтвердить passkey.' });
    return result.authenticationInfo.newCounter;
  }
  app.get('/api/health', c => c.json({ ok: true }));
  app.post('/api/auth/register/options', async c => {
    const accountId = token();
    const options = await generateRegistrationOptions({ rpName: 'notes', rpID: config.rpID, userID: Buffer.from(accountId, 'base64url'), userName: `notes · ${accountId.slice(0, 8)}`, userDisplayName: 'notes', attestationType: 'none', authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, supportedAlgorithmIDs: [-7, -257], extensions: { credProps: true } });
    setCeremony(c, { kind: 'register', challenge: options.challenge, accountId });
    return c.json({ options });
  });
  app.post('/api/auth/register/verify', async c => {
    const ceremony = takeCeremony(c, 'register');
    const response = registrationSchema.parse(await c.req.json()) as RegistrationResponseJSON;
    if (response.id !== response.rawId) throw new HTTPException(400);
    const result = await verifyRegistrationResponse({ response, expectedChallenge: ceremony.challenge, expectedOrigin: config.origin, expectedRPID: config.rpID, requireUserVerification: true, supportedAlgorithmIDs: [-7, -257] });
    if (!result.verified) throw new HTTPException(400);
    const credential = result.registrationInfo.credential;
    const options = await generateAuthenticationOptions({ rpID: config.rpID, userVerification: 'required', allowCredentials: [{ id: credential.id, transports: credential.transports }] });
    setCeremony(c, { kind: 'activate', accountId: ceremony.accountId!, challenge: options.challenge, credential: { ...credential, publicKey: Buffer.from(credential.publicKey).toString('base64url') } });
    return c.json({ options, accountId: ceremony.accountId });
  });
  app.post('/api/auth/register/finish', async c => {
    const ceremony = takeCeremony(c, 'activate');
    const body = z.union([
      z.object({ credential: authenticationSchema, snapshot: initialEntitiesSchema }).strict(),
      z.object({ credential: authenticationSchema, envelope: envelopeSchema }).strict(),
    ]).parse(await c.req.json());
    const saved = ceremony.credential!;
    const credential: WebAuthnCredential = { ...saved, publicKey: new Uint8Array(Buffer.from(saved.publicKey, 'base64url')) };
    credential.counter = await verifyAssertion(body.credential as AuthenticationResponseJSON, ceremony, credential, ceremony.accountId!);
    if ('snapshot' in body) store.createEntityAccount(ceremony.accountId!, credential, body.snapshot);
    else store.createAccount(ceremony.accountId!, credential, body.envelope);
    setSession(c, ceremony.accountId!);
    return c.json(store.readVault(ceremony.accountId!));
  });
  app.post('/api/auth/login/options', async c => {
    const options = await generateAuthenticationOptions({ rpID: config.rpID, userVerification: 'required' });
    setCeremony(c, { kind: 'login', challenge: options.challenge });
    return c.json({ options });
  });
  app.post('/api/auth/login/verify', async c => {
    const ceremony = takeCeremony(c, 'login');
    const response = authenticationSchema.parse(await c.req.json()) as AuthenticationResponseJSON;
    const saved = store.accountByCredential(response.id);
    if (!saved) return c.json({ error: 'Создание доски не завершено.', code: 'PASSKEY_NOT_REGISTERED' }, 404);
    const counter = await verifyAssertion(response, ceremony, { id: saved.credential_id, publicKey: new Uint8Array(saved.public_key), counter: saved.counter, transports: JSON.parse(saved.transports) }, saved.id);
    if (!store.advanceCounter(saved.id, saved.counter, counter)) throw new HTTPException(409, { message: 'Повторите вход.' });
    setSession(c, saved.id);
    return c.json(store.readVault(saved.id));
  });
  app.post('/api/auth/unlock/options', async c => {
    const saved = account(c);
    const body = z.object({ accountId: z.string() }).strict().parse(await c.req.json());
    if (body.accountId !== saved.id) throw new HTTPException(409, { message: 'В другой вкладке открыта другая доска.' });
    const options = await generateAuthenticationOptions({ rpID: config.rpID, userVerification: 'required', allowCredentials: [{ id: saved.credential_id, transports: JSON.parse(saved.transports) }] });
    setCeremony(c, { kind: 'unlock', accountId: saved.id, challenge: options.challenge });
    return c.json({ options });
  });
  app.post('/api/auth/unlock/verify', async c => {
    const saved = account(c), ceremony = takeCeremony(c, 'unlock');
    const body = z.object({ accountId: z.string(), credential: authenticationSchema }).strict().parse(await c.req.json());
    if (body.accountId !== saved.id || ceremony.accountId !== saved.id) throw new HTTPException(403);
    const counter = await verifyAssertion(body.credential as AuthenticationResponseJSON, ceremony, { id: saved.credential_id, publicKey: new Uint8Array(saved.public_key), counter: saved.counter, transports: JSON.parse(saved.transports) }, saved.id);
    if (!store.advanceCounter(saved.id, saved.counter, counter)) throw new HTTPException(409, { message: 'Повторите подтверждение passkey.' });
    return c.json({ ok: true });
  });
  app.post('/api/logout', c => {
    const value = getCookie(c, sessionName);
    if (value) store.deleteSession(hash(value));
    deleteCookie(c, sessionName, cookie);
    return c.json({ ok: true });
  });
  app.get('/api/board', c => {
    const saved = account(c);
    return c.json(store.readVault(saved.id));
  });
  app.patch('/api/board', async c => {
    const saved = account(c);
    const body = deltaSchema.parse(await c.req.json());
    if (body.accountId !== saved.id) throw new HTTPException(409, { message: 'В другой вкладке открыта другая доска. Ваша версия осталась здесь.' });
    const result = store.patch(saved.id, body, hash(JSON.stringify(body)));
    if (!result) throw new HTTPException(409, { message: 'Доска изменена в другой вкладке. Ваша версия осталась здесь.' });
    return c.json(result);
  });
  app.put('/api/board', async c => {
    const saved = account(c);
    const body = saveSchema.parse(await c.req.json());
    if (body.accountId !== saved.id) throw new HTTPException(409, { message: 'В другой вкладке открыта другая доска. Ваша версия осталась здесь.' });
    if (!store.save(saved.id, body.revision, body.envelope)) throw new HTTPException(409, { message: 'Доска изменена в другой вкладке. Ваша версия осталась здесь.' });
    return c.json({ revision: body.revision + 1 });
  });
  app.notFound(c => c.json({ error: 'Не найдено.' }, 404));
  app.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ error: error.message || 'Запрос отклонён.' }, error.status);
    if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ error: 'Некорректный формат данных.' }, 400);
    if (error instanceof StorageLimitError) return c.json({ error: error.message }, 413);
    // Never log credentials, challenge responses, snapshots or request bodies.
    return c.json({ error: 'Не удалось выполнить запрос. Повторите попытку.' }, 400);
  });
  return app;
}
