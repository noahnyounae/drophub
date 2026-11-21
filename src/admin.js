import express from 'express';
import fs from 'node:fs';
import { db, unlinkQuiet } from './db.js';
import { config } from './config.js';
import {
  now, randomToken, sha256hex, safeEqual, hashPassword, clientIp, baseUrl, rateLimited,
  isHex64, cleanText, contentDisposition,
} from './util.js';
import {
  HttpError, createUpload, getUpload, discardUpload, receiveChunk, verifyAndStore, storedPath, hashStoredFile,
} from './uploads.js';

export const adminRouter = express.Router();
const json = express.json({ limit: '32kb' });
const COOKIE = 'dh_session';

function wrap(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (e instanceof HttpError) return res.status(e.status).json({ error: e.message, ...e.extra });
      console.error(e);
      res.status(500).json({ error: 'Internal error' });
    }
  };
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

function isLoggedIn(req) {
  const c = readCookie(req, COOKIE);
  if (!c) return false;
  const s = db.prepare('SELECT expires_at FROM sessions WHERE id = ?').get(sha256hex(c));
  return !!s && s.expires_at > now();
}

// Anti-CSRF: SameSite=Strict cookie + mandatory custom header on write requests.
adminRouter.use((req, res, next) => {
  if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-requested-with'] !== 'drophub') {
    return res.status(403).json({ error: 'Request refused' });
  }
  next();
});

adminRouter.post('/login', json, wrap((req, res) => {
  const ip = clientIp(req);
  if (rateLimited(`login:${ip}`, 8, 15 * 60_000)) throw new HttpError(429, 'Too many attempts, please try again later');
  const { username, password } = req.body || {};
  const ok = safeEqual(username ?? '', config.adminUser) & safeEqual(password ?? '', config.adminPassword);
  if (!ok) throw new HttpError(401, 'Invalid credentials');
  const sid = randomToken(32);
  db.prepare('INSERT INTO sessions (id, expires_at) VALUES (?, ?)').run(sha256hex(sid), now() + config.sessionTtlMs);
  const secure = config.publicUrl.startsWith('https') || req.headers['x-forwarded-proto'] === 'https';
  res.set('Set-Cookie',
    `${COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(config.sessionTtlMs / 1000)}${secure ? '; Secure' : ''}`);
  res.json({ ok: true });
}));

adminRouter.post('/logout', wrap((req, res) => {
  const c = readCookie(req, COOKIE);
  if (c) db.prepare('DELETE FROM sessions WHERE id = ?').run(sha256hex(c));
  res.set('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
  res.json({ ok: true });
}));

adminRouter.get('/me', (req, res) => res.json({ loggedIn: isLoggedIn(req) }));

// Everything below requires a session.
adminRouter.use((req, res, next) => {
  if (!isLoggedIn(req)) return res.status(401).json({ error: 'Not signed in' });
  next();
});

function expiryFrom(hours) {
  const h = Number(hours);
  return Number.isFinite(h) && h > 0 ? now() + h * 3600_000 : null;
}

function presentLink(req, l) {
  const file = db.prepare('SELECT id, name, size, sha256 FROM files WHERE link_id = ?').get(l.id);
  const expired = l.status === 'active' && l.expires_at && l.expires_at <= now();
  return {
    id: l.id, type: l.type, label: l.label,
    status: expired ? 'expired' : l.status,
    createdAt: l.created_at, expiresAt: l.expires_at, maxSize: l.max_size,
    hasPassword: !!l.pw_hash, usedAt: l.used_at, usedIp: l.used_ip,
    url: `${baseUrl(req)}/${l.type === 'drop' ? 'u' : 'g'}/${l.token}`,
    file: file || null,
  };
}

function insertLink({ type, label, expiresInHours, maxSizeMb, password, status }) {
  const token = randomToken(24);
  const maxSize = Number(maxSizeMb) > 0 ? Math.floor(Number(maxSizeMb) * 1024 * 1024) : null;
  const pw = cleanText(password, 200) ? hashPassword(String(password)) : null;
  const r = db.prepare(
    `INSERT INTO links (token, type, label, status, created_at, expires_at, max_size, pw_hash)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(token, type, cleanText(label, 120), status, now(), expiryFrom(expiresInHours), maxSize, pw);
  return db.prepare('SELECT * FROM links WHERE id = ?').get(r.lastInsertRowid);
}

adminRouter.get('/links', (req, res) => {
  const rows = db.prepare('SELECT * FROM links WHERE status != ? ORDER BY id DESC').all('pending');
  res.json(rows.map((l) => presentLink(req, l)));
});

adminRouter.post('/links/drop', json, wrap((req, res) => {
  const l = insertLink({ ...req.body, type: 'drop', status: 'active' });
  res.json(presentLink(req, l));
}));

adminRouter.post('/links/:id/revoke', wrap((req, res) => {
  db.prepare("UPDATE links SET status = 'revoked' WHERE id = ? AND status IN ('active','pending')").run(req.params.id);
  res.json({ ok: true });
}));

function deleteLink(id) {
  const files = db.prepare('SELECT stored_name FROM files WHERE link_id = ?').all(id);
  for (const up of db.prepare('SELECT id FROM uploads WHERE link_id = ?').all(id)) discardUpload(up.id);
  db.prepare('DELETE FROM links WHERE id = ?').run(id); // cascades to files
  for (const f of files) unlinkQuiet(storedPath(f.stored_name));
}

adminRouter.delete('/links/:id', wrap((req, res) => {
  deleteLink(req.params.id);
  res.json({ ok: true });
}));

// ---- Sending: the admin uploads a file, which creates a download link ----
adminRouter.post('/send/start', json, wrap((req, res) => {
  const b = req.body || {};
  const name = cleanText(b.name, 255).replace(/[\\/]/g, '_');
  const size = Number(b.size);
  if (!name) throw new HttpError(400, 'Missing file name');
  if (!Number.isInteger(size) || size <= 0) throw new HttpError(400, 'Empty file or invalid size');
  if (size > config.maxUploadBytes) throw new HttpError(413, 'File too large');
  if (!isHex64(b.sha256)) throw new HttpError(400, 'Invalid SHA-256 checksum');
  const link = insertLink({ ...b, type: 'send', status: 'pending', label: b.label || name });
  const uploadId = createUpload({ linkId: link.id, name, size, sha256: b.sha256, ip: clientIp(req) });
  res.json({
    uploadId,
    chunkUrl: `/api/admin/send/${uploadId}/chunk`,
    finishUrl: `/api/admin/send/${uploadId}/finish`,
    chunkSize: config.chunkSize,
  });
}));

function loadSendUpload(id) {
  const up = getUpload(id);
  const link = up && db.prepare('SELECT * FROM links WHERE id = ?').get(up.link_id);
  if (!up || !link || link.type !== 'send' || link.status !== 'pending') throw new HttpError(404, 'Upload not found');
  return { up, link };
}

adminRouter.put('/send/:id/chunk', wrap(async (req, res) => {
  const { up } = loadSendUpload(req.params.id);
  res.json({ received: await receiveChunk(up, req) });
}));

adminRouter.post('/send/:id/finish', wrap(async (req, res) => {
  const { up, link } = loadSendUpload(req.params.id);
  let stored;
  try {
    stored = await verifyAndStore(up);
  } catch (e) {
    if (e instanceof HttpError && e.status === 422) deleteLink(link.id);
    throw e;
  }
  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO files (link_id, direction, name, stored_name, size, sha256, verified, ip, created_at)
       VALUES (?, 'out', ?, ?, ?, ?, 1, ?, ?)`,
    ).run(link.id, up.name, stored.storedName, up.size, stored.sha256, up.ip, now());
    db.prepare("UPDATE links SET status = 'active' WHERE id = ?").run(link.id);
    db.prepare('DELETE FROM uploads WHERE id = ?').run(up.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.json(presentLink(req, db.prepare('SELECT * FROM links WHERE id = ?').get(link.id)));
}));

// ---- Received files ----
adminRouter.get('/files', (req, res) => {
  const rows = db.prepare(
    `SELECT f.id, f.name, f.size, f.sha256, f.verified, f.sender, f.message, f.ip, f.created_at AS createdAt,
            l.label AS linkLabel
     FROM files f JOIN links l ON l.id = f.link_id
     WHERE f.direction = 'in' ORDER BY f.id DESC`,
  ).all();
  res.json(rows);
});

const getFile = (id) => db.prepare('SELECT * FROM files WHERE id = ?').get(id) || null;

adminRouter.get('/files/:id/download', wrap((req, res) => {
  const f = getFile(req.params.id);
  if (!f || !fs.existsSync(storedPath(f.stored_name))) throw new HttpError(404, 'File not found');
  res.set({
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(f.size),
    'Content-Disposition': contentDisposition(f.name),
    'X-Content-SHA256': f.sha256,
  });
  fs.createReadStream(storedPath(f.stored_name)).on('error', () => res.destroy()).pipe(res);
}));

// Recomputes the checksum of the stored file (detects on-disk corruption).
adminRouter.get('/files/:id/verify', wrap(async (req, res) => {
  const f = getFile(req.params.id);
  if (!f || !fs.existsSync(storedPath(f.stored_name))) throw new HttpError(404, 'File not found');
  const actual = await hashStoredFile(f.stored_name);
  res.json({ ok: actual === f.sha256, expected: f.sha256, actual });
}));

adminRouter.delete('/files/:id', wrap((req, res) => {
  const f = getFile(req.params.id);
  if (f) {
    db.prepare('DELETE FROM files WHERE id = ?').run(f.id);
    unlinkQuiet(storedPath(f.stored_name));
    if (f.direction === 'out') {
      db.prepare("UPDATE links SET status = 'revoked' WHERE id = ?").run(f.link_id);
    }
  }
  res.json({ ok: true });
}));
