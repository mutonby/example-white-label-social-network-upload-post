import Fastify from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import sensible from '@fastify/sensible';
import formbody from '@fastify/formbody';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { z } from 'zod';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import bcrypt from 'bcryptjs';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const pExecFile = promisify(execFile);

const server = Fastify({ logger: true });
await server.register(sensible);
await server.register(formbody);
await server.register(cors, { origin: true });
await server.register(multipart, { limits: { fileSize: 1024 * 1024 * 1024 } });

// After plugin registration
server.setNotFoundHandler((req, reply) => {
  server.log.warn({ notFound: true, method: req.method, url: req.url, headers: req.headers });
  reply.code(404).type('text/plain').send('Route not found');
});

const PORT = Number(process.env.PORT || 4000);
const UPLOAD_POST_API_BASE = process.env.UPLOAD_POST_API_BASE || 'https://api.upload-post.com';
const UPLOAD_POST_API_KEY = process.env.UPLOAD_POST_API_KEY || '';
const DATABASE_URL = process.env.DATABASE_URL || '';
const JWT_SECRET = process.env.JWT_SECRET || '';
// Anyone who knows the secret can sign a token for any user, so refuse to start
// with no secret, a short one, or the placeholder from env.sample.
if (JWT_SECRET.length < 32 || JWT_SECRET === 'change_me_super_secret') {
  throw new Error('JWT_SECRET must be set to a random string of at least 32 characters (e.g. `openssl rand -hex 32`)');
}

if (!DATABASE_URL) {
  throw new Error('Missing DATABASE_URL environment variable');
}

const pool = new Pool({ connectionString: DATABASE_URL });


await initializeDatabase();

// Update auth to Apikey per FFmpeg Editor doc
function authHeader() {
  if (!UPLOAD_POST_API_KEY) {
    throw new Error('Missing UPLOAD_POST_API_KEY');
  }
  return { Authorization: `Apikey ${UPLOAD_POST_API_KEY}` };
}

type DbUserRow = {
  id: number;
  username: string;
  password_hash: string;
  created_at: Date | string;
};

type ApiUser = {
  id: number;
  username: string;
  createdAt: string;
};

async function initializeDatabase(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

function mapUser(row: DbUserRow): ApiUser {
  const createdAt = row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString();
  return {
    id: row.id,
    username: row.username,
    createdAt
  };
}

async function findUserByUsername(username: string): Promise<DbUserRow | null> {
  const res = await pool.query<DbUserRow>('SELECT id, username, password_hash, created_at FROM users WHERE username = $1 LIMIT 1', [username]);
  return res.rows[0] || null;
}

async function findUserById(id: number): Promise<DbUserRow | null> {
  const res = await pool.query<DbUserRow>('SELECT id, username, password_hash, created_at FROM users WHERE id = $1 LIMIT 1', [id]);
  return res.rows[0] || null;
}

async function createUser(username: string, passwordHash: string): Promise<DbUserRow> {
  const res = await pool.query<DbUserRow>(
    'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username, password_hash, created_at',
    [username, passwordHash]
  );
  return res.rows[0];
}

function signUserToken(user: DbUserRow): string {
  return jwt.sign({ username: user.username }, JWT_SECRET, { expiresIn: '12h', subject: String(user.id) });
}

async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<DbUserRow> {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return reply.unauthorized('missing_token') as never;
  }
  const token = auth.slice('Bearer '.length).trim();
  let payload: JwtPayload;
  try {
    payload = jwt.verify(token, JWT_SECRET) as JwtPayload;
  } catch {
    return reply.unauthorized('invalid_token') as never;
  }
  const userIdRaw = payload.sub;
  const userId = typeof userIdRaw === 'string' ? Number.parseInt(userIdRaw, 10) : typeof userIdRaw === 'number' ? userIdRaw : NaN;
  if (!Number.isFinite(userId)) {
    return reply.unauthorized('invalid_token') as never;
  }
  const user = await findUserById(userId);
  if (!user) {
    return reply.unauthorized('invalid_token') as never;
  }
  return user;
}

function parsePlatforms(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map(String).map(p => p.trim()).filter(Boolean);
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map(String).map(p => p.trim()).filter(Boolean);
      }
    } catch {
      // fall through to comma split
    }
    return trimmed.split(/[,\s]+/).map(p => p.trim()).filter(Boolean);
  }
  return [];
}

// Fields the server sets itself: a caller must not add a second `user` (another profile).
const RESERVED_FIELDS = new Set(['user', 'platform', 'platform[]', 'video', 'title']);

function applyExtraFields(form: FormData, extra: Record<string, unknown> | undefined): void {
  if (!extra) return;
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined || value === null) continue;
    if (RESERVED_FIELDS.has(key.trim().toLowerCase())) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null) continue;
        form.append(key, String(item));
      }
      continue;
    }
    if (typeof value === 'object') {
      form.append(key, JSON.stringify(value));
      continue;
    }
    form.append(key, String(value));
  }
}

function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
    return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

// Fetch a user-supplied media URL: http(s) only, and every hop (redirects
// included) must resolve to public addresses, so the API can't be pointed at
// its own network (database, metadata endpoints, localhost services).
async function fetchPublicUrl(rawUrl: string): Promise<Response> {
  let current = new URL(rawUrl);
  for (let hop = 0; hop < 5; hop++) {
    if (current.protocol !== 'https:' && current.protocol !== 'http:') {
      throw Object.assign(new Error('fileUrl must be http(s)'), { status: 400 });
    }
    const host = current.hostname.replace(/^\[|\]$/g, '');
    const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
    if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) {
      throw Object.assign(new Error('fileUrl must point to a public host'), { status: 400 });
    }
    const res = await fetch(current, { redirect: 'manual' });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location')!, current);
      continue;
    }
    return res;
  }
  throw Object.assign(new Error('fileUrl redirected too many times'), { status: 400 });
}

async function ensureUploadPostProfile(username: string, mustCreate = false): Promise<any> {
  const profileUrl = joinUrl(UPLOAD_POST_API_BASE, `/api/uploadposts/users/${encodeURIComponent(username)}`);
  const existing = await fetch(profileUrl, { headers: { ...authHeader() } });
  // A new account must get a NEW profile: reusing one that already exists in the
  // operator's Upload-Post account would hand its connected socials to a stranger.
  if (mustCreate && existing.ok) {
    const err: any = new Error('upload_post_profile_exists');
    err.status = 409;
    err.body = 'username_taken';
    throw err;
  }
  if (existing.status === 404) {
    const createRes = await fetch(joinUrl(UPLOAD_POST_API_BASE, '/api/uploadposts/users'), {
      method: 'POST',
      headers: { ...authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ username })
    });
    if (!createRes.ok) {
      const txt = await createRes.text();
      const err: any = new Error('upload_post_create_profile_failed');
      err.status = createRes.status;
      err.body = txt;
      throw err;
    }
    return await createRes.json().catch(() => ({}));
  }
  if (!existing.ok) {
    const txt = await existing.text();
    const err: any = new Error('upload_post_get_profile_failed');
    err.status = existing.status;
    err.body = txt;
    throw err;
  }
  return await existing.json().catch(() => ({}));
}

async function fetchUploadPostProfile(username: string): Promise<any> {
  const profileUrl = joinUrl(UPLOAD_POST_API_BASE, `/api/uploadposts/users/${encodeURIComponent(username)}`);
  const res = await fetch(profileUrl, { headers: { ...authHeader() } });
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    const txt = await res.text();
    const err: any = new Error('upload_post_get_profile_failed');
    err.status = res.status;
    err.body = txt;
    throw err;
  }
  return await res.json().catch(() => ({}));
}

async function generateUploadPostLink(username: string, payload: Record<string, unknown>): Promise<any> {
  const res = await fetch(joinUrl(UPLOAD_POST_API_BASE, '/api/uploadposts/users/generate-jwt'), {
    method: 'POST',
    headers: { ...authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, ...payload })
  });
  if (!res.ok) {
    const txt = await res.text();
    const err: any = new Error('upload_post_generate_jwt_failed');
    err.status = res.status;
    err.body = txt;
    throw err;
  }
  return await res.json().catch(() => ({}));
}

async function uploadPostGet(path: string, params: Record<string, string | undefined>): Promise<any> {
  const url = new URL(joinUrl(UPLOAD_POST_API_BASE, path));
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  const res = await fetch(url.toString(), { headers: { ...authHeader() } });
  if (!res.ok) {
    const txt = await res.text();
    const err: any = new Error('upload_post_get_failed');
    err.status = res.status;
    err.body = txt;
    throw err;
  }
  return await res.json().catch(() => ({}));
}

async function buildUploadVideoFormFromJson(username: string, data: {
  fileUrl: string;
  platforms: string[];
  title: string;
  description?: string;
  scheduleDate?: string;
  asyncUpload?: boolean;
  extraFields?: Record<string, unknown>;
}): Promise<FormData> {
  const form = new FormData();
  form.append('user', username);
  for (const platform of data.platforms) {
    form.append('platform[]', platform);
  }
  form.append('title', data.title);
  if (data.description) form.append('description', data.description);
  if (data.scheduleDate) form.append('scheduled_date', data.scheduleDate);
  if (typeof data.asyncUpload === 'boolean') form.append('async_upload', data.asyncUpload ? 'true' : 'false');

  const inputRes = await fetchPublicUrl(data.fileUrl);
  if (!inputRes.ok) {
    throw new Error('Could not download fileUrl for upload');
  }
  const buf = await inputRes.arrayBuffer();
  form.append('video', new Blob([buf]), 'upload.mp4');
  applyExtraFields(form, data.extraFields);
  return form;
}

function pickFieldValue(fields: Record<string, any>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (!key) continue;
    const raw = fields[key];
    if (raw === undefined) continue;
    if (raw && typeof raw === 'object' && 'value' in raw) {
      return (raw as any).value;
    }
    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (item && typeof item === 'object' && 'value' in item) {
          return (item as any).value;
        }
        if (item !== undefined) {
          if (typeof item === 'string') {
            return item;
          }
          return item;
        }
      }
      continue;
    }
    if (typeof raw === 'string') {
      return raw;
    }
    return raw;
  }
  return undefined;
}

function joinUrl(base: string, path: string): string {
  if (!path) return base;
  if (path.startsWith('http://') || path.startsWith('https://')) return path;
  return `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}

// Every /api route spends the operator's Upload-Post key or server CPU: all of
// them need a logged-in user except register/login.
const PUBLIC_API_ROUTES = new Set(['/api/auth/register', '/api/auth/login']);
server.addHook('preHandler', async (req, reply) => {
  const path = req.url.split('?')[0];
  if (req.method === 'OPTIONS' || !path.startsWith('/api/') || PUBLIC_API_ROUTES.has(path)) return;
  await requireAuth(req, reply);
  if (reply.sent) return reply;
});

server.get('/health', async () => ({ ok: true }));
server.get('/favicon.ico', async (req, reply) => { reply.code(204); return reply.send(); });
server.get('/api/local/silence-cutter', async (req, reply) => { reply.code(405); return { error: 'Use POST multipart with file' }; });
server.get('/routes', async () => {
  return { routes: (server as any).printRoutes?.() || 'printRoutes not available' };
});

server.post('/api/auth/register', async (req, reply) => {
  const bodySchema = z.object({
    username: z.string().min(3).max(64),
    password: z.string().min(6).max(128)
  });
  const { username, password } = bodySchema.parse(req.body);
  const normalized = normalizeUsername(username);
  if (!normalized) {
    return reply.badRequest('username_required');
  }
  const existing = await findUserByUsername(normalized);
  if (existing) {
    return reply.conflict('username_taken');
  }
  const passwordHash = await bcrypt.hash(password, 10);
  let user: DbUserRow;
  try {
    user = await createUser(normalized, passwordHash);
  } catch (err: any) {
    if (err?.code === '23505') {
      return reply.conflict('username_taken');
    }
    server.log.error({ tag: 'register', err });
    return reply.internalServerError('register_failed');
  }
  try {
    await ensureUploadPostProfile(user.username, true);
  } catch (err: any) {
    server.log.error({ tag: 'register', step: 'ensureUploadPostProfile', err });
    // Don't leave a local account without its own profile behind.
    await pool.query('DELETE FROM users WHERE id = $1', [user.id]).catch(() => undefined);
    return reply.code(err?.status || 502).send({ error: 'upload_post_profile_failed', details: err?.body || err?.message || 'unknown_error' });
  }
  const token = signUserToken(user);
  reply.code(201);
  return { token, user: mapUser(user) };
});

server.post('/api/auth/login', async (req, reply) => {
  const bodySchema = z.object({
    username: z.string().min(1),
    password: z.string().min(1)
  });
  const { username, password } = bodySchema.parse(req.body);
  const normalized = normalizeUsername(username);
  const user = await findUserByUsername(normalized);
  if (!user) {
    return reply.unauthorized('invalid_credentials');
  }
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    return reply.unauthorized('invalid_credentials');
  }
  const token = signUserToken(user);
  return { token, user: mapUser(user) };
});

server.get('/api/auth/me', async (req, reply) => {
  const user = await requireAuth(req, reply);
  return { user: mapUser(user) };
});

server.get('/api/social/profile', async (req, reply) => {
  const user = await requireAuth(req, reply);
  try {
    let profile = await fetchUploadPostProfile(user.username);
    if (!profile) {
      profile = await ensureUploadPostProfile(user.username);
    }
    return { profile };
  } catch (err: any) {
    server.log.error({ tag: 'social-profile', err });
    return reply.code(err?.status || 502).send({ error: 'upload_post_profile_fetch_failed', details: err?.body || err?.message || 'unknown_error' });
  }
});

server.post('/api/social/connect-url', async (req, reply) => {
  const user = await requireAuth(req, reply);
  const bodySchema = z.object({
    redirectUrl: z.string().url().optional(),
    logoImage: z.string().url().optional(),
    redirectButtonText: z.string().optional(),
    connectTitle: z.string().optional(),
    connectDescription: z.string().optional(),
    platforms: z.array(z.string()).optional()
  });
  const parsed = bodySchema.parse(req.body);
  const payload: Record<string, unknown> = {};
  if (parsed.redirectUrl) payload.redirect_url = parsed.redirectUrl;
  if (parsed.logoImage) payload.logo_image = parsed.logoImage;
  if (parsed.redirectButtonText) payload.redirect_button_text = parsed.redirectButtonText;
  if (parsed.connectTitle) payload.connect_title = parsed.connectTitle;
  if (parsed.connectDescription) payload.connect_description = parsed.connectDescription;
  if (parsed.platforms?.length) payload.platforms = parsed.platforms;
  try {
    const res = await generateUploadPostLink(user.username, payload);
    return res;
  } catch (err: any) {
    server.log.error({ tag: 'social-connect-url', err });
    return reply.code(err?.status || 502).send({ error: 'upload_post_connect_url_failed', details: err?.body || err?.message || 'unknown_error' });
  }
});

server.get('/api/social/facebook/pages', async (req, reply) => {
  const user = await requireAuth(req, reply);
  try {
    return await uploadPostGet('/api/uploadposts/facebook/pages', { profile: user.username });
  } catch (err: any) {
    server.log.error({ tag: 'social-facebook-pages', err });
    return reply.code(err?.status || 502).send({ error: 'upload_post_facebook_pages_failed', details: err?.body || err?.message || 'unknown_error' });
  }
});

server.get('/api/social/linkedin/pages', async (req, reply) => {
  const user = await requireAuth(req, reply);
  try {
    return await uploadPostGet('/api/uploadposts/linkedin/pages', { profile: user.username });
  } catch (err: any) {
    server.log.error({ tag: 'social-linkedin-pages', err });
    return reply.code(err?.status || 502).send({ error: 'upload_post_linkedin_pages_failed', details: err?.body || err?.message || 'unknown_error' });
  }
});

server.get('/api/social/pinterest/boards', async (req, reply) => {
  const user = await requireAuth(req, reply);
  try {
    return await uploadPostGet('/api/uploadposts/pinterest/boards', { profile: user.username });
  } catch (err: any) {
    server.log.error({ tag: 'social-pinterest-boards', err });
    return reply.code(err?.status || 502).send({ error: 'upload_post_pinterest_boards_failed', details: err?.body || err?.message || 'unknown_error' });
  }
});

server.post('/api/social/upload-video', async (req, reply) => {
  const user = await requireAuth(req, reply);
  server.log.info({ tag: 'upload-video', step: 'start', contentType: req.headers['content-type'] });
  try {
    const isMultipart = (req as any).isMultipart?.();
    let form: FormData;
    let uploadContext: Record<string, unknown> | null = null;
    if (isMultipart) {
      const parts = (req as any).parts();
      const fieldsRaw: Record<string, any> = {};
      let fileBuffer: Buffer | null = null;
      let filename = 'video.mp4';
      for await (const part of parts as any) {
        if (part.file) {
          const chunks: Buffer[] = [];
          for await (const chunk of part.file) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          fileBuffer = Buffer.concat(chunks);
          filename = part.filename || filename;
        } else if (part.type === 'field') {
          const current = fieldsRaw[part.fieldname];
          if (current === undefined) {
            fieldsRaw[part.fieldname] = part.value;
          } else if (Array.isArray(current)) {
            current.push(part.value);
          } else {
            fieldsRaw[part.fieldname] = [current, part.value];
          }
        }
      }
      if (!fileBuffer) {
        return reply.badRequest('file is required');
      }
      const platforms = parsePlatforms(pickFieldValue(fieldsRaw, 'platforms', 'platform', 'platforms[]', 'platform[]'));
      if (!platforms.length) {
        return reply.badRequest('platforms_required');
      }
      const titleRaw = pickFieldValue(fieldsRaw, 'title');
      const title = typeof titleRaw === 'string' ? titleRaw.trim() : '';
      if (!title) {
        return reply.badRequest('title_required');
      }
      const descriptionRaw = pickFieldValue(fieldsRaw, 'description');
      const scheduleRaw = pickFieldValue(fieldsRaw, 'scheduleDate', 'scheduled_date');
      const asyncRaw = pickFieldValue(fieldsRaw, 'asyncUpload', 'async_upload');
      let extraFields: Record<string, unknown> | undefined;
      const extraRaw = pickFieldValue(fieldsRaw, 'extraFields', 'extra_fields');
      if (extraRaw) {
        try {
          extraFields = typeof extraRaw === 'string' ? JSON.parse(extraRaw) : extraRaw;
        } catch {
          server.log.warn({ tag: 'upload-video', step: 'parse-extra', raw: extraRaw });
        }
      }
      form = new FormData();
      form.append('user', user.username);
      for (const platform of platforms) form.append('platform[]', platform);
      form.append('title', title);
      if (descriptionRaw) form.append('description', String(descriptionRaw));
      if (scheduleRaw) form.append('scheduled_date', String(scheduleRaw));
      if (asyncRaw !== undefined) form.append('async_upload', String(asyncRaw));
      applyExtraFields(form, extraFields);
      const arrayBuffer = Uint8Array.from(fileBuffer).buffer;
      form.append('video', new Blob([arrayBuffer]), filename);
      uploadContext = {
        mode: 'multipart',
        platforms,
        title,
        schedule: scheduleRaw ? String(scheduleRaw) : undefined,
        asyncRaw,
        extraKeys: extraFields ? Object.keys(extraFields) : [],
        fileSize: fileBuffer.byteLength,
        filename
      };
    } else {
      const bodySchema = z.object({
        fileUrl: z.string().url(),
        platforms: z.union([z.array(z.string()), z.string()]),
        title: z.string().min(1),
        description: z.string().optional(),
        scheduleDate: z.string().optional(),
        scheduled_date: z.string().optional(),
        asyncUpload: z.boolean().optional(),
        async_upload: z.boolean().optional(),
        extraFields: z.record(z.any()).optional(),
        extra_fields: z.record(z.any()).optional()
      });
      const parsed = bodySchema.parse(req.body);
      const platforms = parsePlatforms(parsed.platforms);
      if (!platforms.length) {
        return reply.badRequest('platforms_required');
      }
      const scheduleDate = parsed.scheduleDate || parsed.scheduled_date;
      const asyncUpload = typeof parsed.asyncUpload === 'boolean' ? parsed.asyncUpload : parsed.async_upload;
      form = await buildUploadVideoFormFromJson(user.username, {
        fileUrl: parsed.fileUrl,
        platforms,
        title: parsed.title,
        description: parsed.description,
        scheduleDate: scheduleDate,
        asyncUpload,
        extraFields: (parsed.extraFields || parsed.extra_fields) ?? undefined
      });
      uploadContext = {
        mode: 'json',
        platforms,
        title: parsed.title,
        schedule: scheduleDate,
        asyncUpload,
        extraKeys: Object.keys((parsed.extraFields || parsed.extra_fields) ?? {}),
        fileUrl: parsed.fileUrl
      };
    }
    server.log.info({ tag: 'upload-video', step: 'ready_to_upload', context: uploadContext });
    const uploadUrl = joinUrl(UPLOAD_POST_API_BASE, '/api/upload');
    server.log.info({ tag: 'upload-video', step: 'upload_post_request', uploadUrl, mode: isMultipart ? 'multipart' : 'json' });
    const res = await fetch(uploadUrl, { method: 'POST', headers: { ...authHeader() }, body: form as any });
    const text = await res.text();
    const preview = text.length > 500 ? `${text.slice(0, 500)}...` : text;
    server.log.info({ tag: 'upload-video', step: 'upload_post_response', status: res.status, preview });
    reply.code(res.status);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch (err: any) {
    if (err?.status) {
      reply.code(err.status);
      return err.body || { error: err.message || 'upload_video_failed' };
    }
    server.log.error({ tag: 'social-upload-video', err });
    return reply.code(500).send({ error: 'upload_video_failed', details: err?.message || 'unknown_error' });
  }
});

// Proxy to Upload-Post Analytics: GET /api/analytics/:profileUsername?platforms=
server.get('/api/analytics/:profileUsername', async (req, reply) => {
  const paramsSchema = z.object({ profileUsername: z.string().min(1) });
  const querySchema = z.object({ platforms: z.string().min(1) });
  const user = await requireAuth(req, reply);
  if (reply.sent) return reply;
  const { profileUsername } = paramsSchema.parse(req.params);
  const { platforms } = querySchema.parse(req.query);
  // The operator key can read every profile: only the caller's own is allowed.
  if (profileUsername.toLowerCase() !== user.username.toLowerCase()) {
    return reply.forbidden('not_your_profile');
  }
  const url = `${UPLOAD_POST_API_BASE}/api/analytics/${encodeURIComponent(profileUsername)}?platforms=${encodeURIComponent(platforms)}`;
  const res = await fetch(url, { headers: { ...authHeader() } });
  const body = await res.text();
  reply.code(res.status);
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
});

// Generic upload-post ffmpeg-editor job via URL or multipart file
server.post('/api/ffmpeg/jobs', async (req, reply) => {
  const isMultipart = (req as any).isMultipart?.();
  if (isMultipart) {
    const mp = await (req as any).file();
    if (!mp) return reply.badRequest('file is required');
    const fields = mp.fields as Record<string, any>;
    const fullCommand = String(fields.fullCommand?.value || fields.full_command?.value || '');
    const outputExtension = String(fields.outputExtension?.value || fields.output_extension?.value || 'mp4');
    if (!fullCommand.startsWith('ffmpeg ')) return reply.badRequest('fullCommand must start with ffmpeg');
    const buf = await mp.toBuffer();
    const form = new FormData();
    form.append('file', new Blob([buf]), mp.filename || 'input');
    form.append('full_command', fullCommand);
    form.append('output_extension', outputExtension);
    const res = await fetch(`${UPLOAD_POST_API_BASE}/api/ffmpeg-editor`, { method: 'POST', headers: { ...authHeader() }, body: form as any });
    reply.code(res.status);
    return reply.send(await res.arrayBuffer());
  } else {
    const bodySchema = z.object({
      fileUrl: z.string().url(),
      fullCommand: z.string().startsWith('ffmpeg ').min(10),
      outputExtension: z.string().min(2)
    });
    const { fileUrl, fullCommand, outputExtension } = bodySchema.parse(req.body);

    const form = new FormData();
    const inputRes = await fetchPublicUrl(fileUrl);
    if (!inputRes.ok) {
      return reply.badRequest('Could not fetch input fileUrl');
    }
    const arrayBuf = await inputRes.arrayBuffer();
    const blob = new Blob([arrayBuf]);
    form.append('file', blob, 'input');
    form.append('full_command', fullCommand);
    form.append('output_extension', outputExtension);

    const res = await fetch(`${UPLOAD_POST_API_BASE}/api/ffmpeg-editor`, {
      method: 'POST', headers: { ...authHeader() }, body: form as any
    });
    const body = await res.text();
    reply.code(res.status);
    try { return JSON.parse(body); } catch { return body; }
  }
});

// Replace remote silence-cutter with local ffmpeg processing
server.post('/api/ffmpeg/jobs/silence-cutter', async (req, reply) => {
  const isMultipart = (req as any).isMultipart?.();
  const defaultSilenceDb = -45;
  const defaultMinSilenceSec = 0.4;

  try {
    if (isMultipart) {
      const mp = await (req as any).file(); if (!mp) return reply.badRequest('file is required');
      const fields = mp.fields as Record<string, any>;
      const silenceDb = Number(fields.silenceDb?.value ?? defaultSilenceDb);
      const minSilenceSec = Number(fields.minSilenceSec?.value ?? defaultMinSilenceSec);
      const outBuf = await cutSilences(await mp.toBuffer(), mp.filename || 'input', silenceDb, minSilenceSec);
      reply.header('Content-Type', 'video/mp4');
      reply.header('Content-Disposition', 'attachment; filename="output.mp4"');
      return reply.send(outBuf);
    } else {
      const bodySchema = z.object({ fileUrl: z.string().url(), silenceDb: z.number().default(defaultSilenceDb), minSilenceSec: z.number().default(defaultMinSilenceSec) });
      const { fileUrl, silenceDb, minSilenceSec } = bodySchema.parse(req.body);
      const res = await fetchPublicUrl(fileUrl); if (!res.ok) return reply.badRequest('Could not fetch input fileUrl');
      const buf = new Uint8Array(await res.arrayBuffer());
      const outBuf = await cutSilences(buf, 'input', silenceDb, minSilenceSec);
      reply.header('Content-Type', 'video/mp4');
      reply.header('Content-Disposition', 'attachment; filename="output.mp4"');
      return reply.send(outBuf);
    }
  } catch (e: any) {
    const status = e?.status || 500;
    reply.code(status);
    return e?.body || { error: e?.message || 'unexpected_error' };
  }
});

// Silence cutter (local, true video+audio cuts) via multipart file (kept for backward-compat)
server.post('/api/local/silence-cutter', async (req, reply) => {
  const mp = await (req as any).file();
  if (!mp) return reply.badRequest('file is required');
  const fields = mp.fields as Record<string, any>;
  const silenceDb = Number(fields.silenceDb?.value ?? -45);
  const minSilenceSec = Number(fields.minSilenceSec?.value ?? 0.4);
  const outBuf = await cutSilences(await mp.toBuffer(), mp.filename || 'input', silenceDb, minSilenceSec);
  reply.header('Content-Type', 'video/mp4');
  reply.header('Content-Disposition', 'attachment; filename="output.mp4"');
  return reply.send(outBuf);
});

function toNodeBuffer(input: Buffer | Uint8Array | ArrayBuffer): Buffer {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input);
  return Buffer.from(new Uint8Array(input));
}

async function cutSilences(inputBuffer: Buffer | Uint8Array | ArrayBuffer, filename: string, silenceDb: number, minSilenceSec: number): Promise<Buffer> {
  const inputPath = join(tmpdir(), `in_${Date.now()}_${filename}`);
  const outDir = join(tmpdir(), `out_${Date.now()}`);
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(inputPath, toNodeBuffer(inputBuffer));

  const { stdout: durStdout } = await pExecFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nokey=1:noprint_wrappers=1', inputPath]);
  const totalDuration = Math.max(0, parseFloat((durStdout || '0').trim()) || 0);

  const detect = await pExecFile('ffmpeg', ['-i', inputPath, '-af', `silencedetect=noise=${silenceDb}dB:d=${minSilenceSec}`, '-f', 'null', '-']);
  const log = (detect.stderr || '').toString();
  const starts = [...log.matchAll(/silence_start:\s*([0-9.]+)/g)].map(m => parseFloat(m[1]));
  const ends = [...log.matchAll(/silence_end:\s*([0-9.]+)/g)].map(m => parseFloat(m[1]));

  const intervals: Array<[number, number]> = [];
  let cursor = 0;
  for (let i = 0; i < Math.max(starts.length, ends.length); i++) {
    const s = starts[i] ?? totalDuration;
    const e = ends[i] ?? totalDuration;
    if (s > cursor) intervals.push([cursor, Math.min(s, totalDuration)]);
    cursor = Math.min(e, totalDuration);
  }
  if (cursor < totalDuration) intervals.push([cursor, totalDuration]);

  const filtered = intervals.filter(([a, b]) => b - a > 0.15);
  if (filtered.length === 0) {
    return await fs.readFile(inputPath);
  }

  const parts: string[] = [];
  let idx = 0;
  for (const [a, b] of filtered) {
    const part = join(outDir, `part_${idx++}.mp4`);
    const duration = (b - a).toFixed(3);
    await pExecFile('ffmpeg', ['-ss', a.toFixed(3), '-t', duration, '-i', inputPath, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-b:a', '160k', part]);
    parts.push(part);
  }

  const listPath = join(outDir, 'list.txt');
  await fs.writeFile(listPath, parts.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
  const outputPath = join(outDir, 'output.mp4');
  await pExecFile('ffmpeg', ['-f', 'concat', '-safe', '0', '-i', listPath, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-b:a', '160k', outputPath]);
  return await fs.readFile(outputPath);
}

async function submitUploadPostJob(fd: FormData): Promise<{ jobId: string; statusUrl: string }> {
  const submitUrl = joinUrl(UPLOAD_POST_API_BASE, '/api/uploadposts/ffmpeg/jobs/upload');
  const res = await fetch(submitUrl, { method: 'POST', headers: { ...authHeader() }, body: fd as any });
  if (res.status !== 200) {
    const txt = await res.text();
    const err: any = new Error('upload_post_submit_failed');
    err.status = res.status;
    err.body = txt;
    throw err;
  }
  const json = await res.json().catch(() => ({} as any));
  const jobId = String(json.job_id || json.jobId || json.id || '');
  if (!jobId) {
    const err: any = new Error('upload_post_missing_job_id');
    err.status = 502; err.body = JSON.stringify(json);
    throw err;
  }
  const statusUrl = joinUrl(UPLOAD_POST_API_BASE, `/api/uploadposts/ffmpeg/jobs/${jobId}`);
  return { jobId, statusUrl };
}

async function pollUploadPostJob(statusUrl: string, timeoutMs = 120_000, intervalMs = 2_000): Promise<{ status: 'FINISHED'|'ERROR'|'QUEUED'|'PROCESSING'; resultUrl?: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus: any = 'QUEUED'; let resultUrl: string | undefined;
  while (Date.now() < deadline) {
    const res = await fetch(statusUrl, { headers: { ...authHeader() } });
    if (!res.ok) {
      const txt = await res.text();
      const err: any = new Error('upload_post_status_failed');
      err.status = res.status; err.body = txt; throw err;
    }
    const json = await res.json().catch(() => ({} as any));
    lastStatus = (json.status || '').toUpperCase();
    resultUrl = json.result_url || json.output_url || json.download_url || resultUrl;
    if (lastStatus === 'FINISHED' || lastStatus === 'ERROR') return { status: lastStatus, resultUrl } as any;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return { status: lastStatus, resultUrl } as any;
}

async function downloadUploadPostResultFrom(statusUrl: string, resultUrl?: string): Promise<{ buffer: Buffer; contentType: string; contentDisposition: string }> {
  const url = resultUrl ? joinUrl(UPLOAD_POST_API_BASE, resultUrl) : joinUrl(statusUrl, 'result');
  const res = await fetch(url, { headers: { ...authHeader() } });
  if (!res.ok) {
    const txt = await res.text();
    const err: any = new Error('upload_post_download_failed');
    err.status = res.status; err.body = txt; throw err;
  }
  const arr = await res.arrayBuffer();
  return {
    buffer: Buffer.from(new Uint8Array(arr)),
    contentType: res.headers.get('content-type') || 'application/octet-stream',
    contentDisposition: res.headers.get('content-disposition') || 'attachment; filename="output.mp4"'
  };
}

async function formFromUrlAndCmd(fileUrl: string, fullCommand: string, outputExtension: string): Promise<FormData> {
  const inputRes = await fetchPublicUrl(fileUrl);
  if (!inputRes.ok) {
    throw new Error('Could not fetch input fileUrl');
  }
  const arrayBuf = await inputRes.arrayBuffer();
  const blob = new Blob([arrayBuf]);
  const fd = new FormData();
  fd.append('file', blob, 'input');
  fd.append('full_command', fullCommand);
  fd.append('output_extension', outputExtension);
  return fd;
}

// Auto-916 and Text overlay via URL or multipart (forward to Upload-Post)
server.post('/api/ffmpeg/jobs/auto-916', async (req, reply) => {
  const isMultipart = (req as any).isMultipart?.();
  try {
    let fd: FormData;
    if (isMultipart) {
      const mp = await (req as any).file(); if (!mp) return reply.badRequest('file is required');
      const fields = mp.fields as Record<string, any>;
      const blur = Number(fields.blur?.value ?? 20);
      const format = String(fields.format?.value ?? '9:16') as '9:16'|'1:1';
      const [W,H] = format === '9:16' ? [1080,1920] : [1080,1080];
      const cmd = `ffmpeg -y -i {input} -filter_complex "[0:v]scale=iw:ih,setsar=1,split=2[fg][bg];[bg]scale=${W}:${H},boxblur=luma_radius=${blur}:luma_power=1:chroma_radius=${blur}[bg2];[fg]scale=${W}:-1:force_original_aspect_ratio=decrease[fg2];[bg2][fg2]overlay=(W-w)/2:(H-h)/2:shortest=1[v]" -map "[v]" -map 0:a? -c:v libx264 -preset veryfast -crf 23 -c:a aac -b:a 160k {output}`;
      fd = new FormData(); fd.append('file', new Blob([await mp.toBuffer()]), mp.filename || 'input'); fd.append('full_command', cmd); fd.append('output_extension', 'mp4');
    } else {
      const bodySchema = z.object({ fileUrl: z.string().url(), blur: z.number().default(20), format: z.enum(['9:16','1:1']).default('9:16') });
      const { fileUrl, blur, format } = bodySchema.parse(req.body);
      const [W,H] = format === '9:16' ? [1080,1920] : [1080,1080];
      const cmd = `ffmpeg -y -i {input} -filter_complex "[0:v]scale=iw:ih,setsar=1,split=2[fg][bg];[bg]scale=${W}:${H},boxblur=luma_radius=${blur}:luma_power=1:chroma_radius=${blur}[bg2];[fg]scale=${W}:-1:force_original_aspect_ratio=decrease[fg2];[bg2][fg2]overlay=(W-w)/2:(H-h)/2:shortest=1[v]" -map "[v]" -map 0:a? -c:v libx264 -preset veryfast -crf 23 -c:a aac -b:a 160k {output}`;
      fd = await formFromUrlAndCmd(fileUrl, cmd, 'mp4');
    }

    const { jobId, statusUrl } = await submitUploadPostJob(fd);
    const { status, resultUrl } = await pollUploadPostJob(statusUrl);
    if (status !== 'FINISHED') { reply.code(502); return { error: 'processing_failed_or_timeout', status, jobId, statusUrl }; }
    const { buffer, contentType, contentDisposition } = await downloadUploadPostResultFrom(statusUrl, resultUrl);
    reply.header('Content-Type', contentType);
    reply.header('Content-Disposition', contentDisposition);
    return reply.send(buffer);
  } catch (e: any) {
    const status = e?.status || 500;
    reply.code(status);
    return e?.body || { error: e?.message || 'unexpected_error' };
  }
});

// Update text-overlay to validate text and normalize colors
server.post('/api/ffmpeg/jobs/text-overlay', async (req, reply) => {
  const isMultipart = (req as any).isMultipart?.();
  server.log.info({ tag: 'text-overlay', step: 'start', isMultipart });
  try {
    if (!isMultipart) {
      reply.code(400);
      return { error: 'multipart_required', message: 'Upload a file using multipart/form-data' };
    }

    // Robust parse: collect file and fields via parts()
    const fields: Record<string, any> = {};
    let fileBuffer: Buffer | null = null;
    let filename = 'input';
    const parts = (req as any).parts();
    for await (const part of parts as any) {
      if (part.file) {
        const chunks: Buffer[] = [];
        for await (const chunk of part.file) chunks.push(chunk as Buffer);
        fileBuffer = Buffer.concat(chunks);
        filename = part.filename || filename;
      } else if (part.type === 'field') {
        fields[part.fieldname] = part.value;
      }
    }
    if (!fileBuffer) return reply.badRequest('file is required');

    server.log.info({ tag: 'text-overlay', step: 'multipart_fields', keys: Object.keys(fields || {}) });

    const rawText = fields.text;
    const text = typeof rawText === 'string' ? rawText : '';
    if (!text) return reply.badRequest('text is required');
    const position = String(fields.position || 'bc');
    const fontSize = Number(fields.fontSize ?? 48);
    const color = normalizeFfmpegColor(String(fields.color || 'white'));
    const bgColor = fields.bgColor ? normalizeFfmpegColor(String(fields.bgColor)) : '';

    const inputPath = join(tmpdir(), `txt_in_${Date.now()}_${filename}`);
    const outputPath = join(tmpdir(), `txt_out_${Date.now()}.mp4`);
    await fs.writeFile(inputPath, fileBuffer);

    // Probe video dimensions to scale font size similarly to 360x640 preview
    const probe = await pExecFile('ffprobe', [
      '-v','error','-select_streams','v:0','-show_entries','stream=width,height','-of','csv=s=x:p=0', inputPath
    ]);
    const dims = String(probe.stdout || '').trim();
    let videoW = 0, videoH = 0;
    const m = dims.match(/^(\d+)x(\d+)$/);
    if (m) { videoW = parseInt(m[1], 10); videoH = parseInt(m[2], 10); }
    const scaleRefH = 640; // preview height in the web UI
    const scaledFontSize = Math.max(12, Math.round(fontSize * (videoH > 0 ? (videoH / scaleRefH) : 1)));

    const { x, y } = positionToXY(position);
    const fontPath = '/usr/share/fonts/ttf-dejavu/DejaVuSans.ttf';
    const drawCore = `fontfile='${fontPath}':text='${escapeText(text)}':x=${x}:y=${y}:fontsize=${scaledFontSize}:fontcolor=${color}:box=0`;
    const draw = bgColor
      ? `drawbox=x=${x}-20:y=${y}-10:w=text_w+40:h=text_h+20:color=${bgColor}:t=fill,drawtext=${drawCore}`
      : `drawtext=${drawCore}`;

    const args = ['-y', '-i', inputPath, '-vf', draw, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'copy', outputPath];
    server.log.info({ tag: 'text-overlay', step: 'ffmpeg_exec', args });
    await pExecFile('ffmpeg', args);

    const buffer = await fs.readFile(outputPath);
    reply.header('Content-Type', 'video/mp4');
    reply.header('Content-Disposition', 'attachment; filename="output.mp4"');
    return reply.send(buffer);
  } catch (e: any) {
    const status = e?.status || 500;
    server.log.error({ tag: 'text-overlay', step: 'error', status, body: e?.body, message: e?.message });
    reply.code(status);
    return e?.body || { error: e?.message || 'unexpected_error' };
  }
});

// Helper: map position preset to drawtext coordinates
function positionToXY(pos: string): { x: string; y: string } {
  const map: Record<string, { x: string; y: string }> = {
    tl: { x: '20', y: '20' },
    tc: { x: '(w-text_w)/2', y: '20' },
    tr: { x: 'w-text_w-20', y: '20' },
    ml: { x: '20', y: '(h-text_h)/2' },
    mc: { x: '(w-text_w)/2', y: '(h-text_h)/2' },
    mr: { x: 'w-text_w-20', y: '(h-text_h)/2' },
    bl: { x: '20', y: 'h-text_h-20' },
    bc: { x: '(w-text_w)/2', y: 'h-text_h-20' },
    br: { x: 'w-text_w-20', y: 'h-text_h-20' }
  };
  return map[pos] || map.bc;
}

// Helper: escape text for ffmpeg drawtext
function escapeText(t: string): string {
  return t.replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function normalizeFfmpegColor(input: string): string {
  if (!input) return 'white';
  if (input.startsWith('#') && (input.length === 7 || input.length === 4)) {
    // convert #RRGGBB or #RGB to 0xRRGGBB
    const hex = input.length === 4
      ? `#${input[1]}${input[1]}${input[2]}${input[2]}${input[3]}${input[3]}`
      : input;
    return `0x${hex.slice(1)}`;
  }
  return input; // named colors or 0xRRGGBB already
}

// Start server
server.listen({ port: PORT, host: '0.0.0.0' })
  .then(() => {
    server.log.info(`API listening on ${PORT}`)
  })
  .catch((err) => {
    server.log.error(err)
    process.exit(1)
  })