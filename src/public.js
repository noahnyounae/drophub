import express from 'express';
import fs from 'node:fs';
import { db } from './db.js';
import { config } from './config.js';
import {
  now, randomToken, checkPassword, clientIp, rateLimited, isHex64, cleanText, contentDisposition,
} from './util.js';
import {
  HttpError, createUpload, getUpload, discardUpload, receiveChunk, verifyAndStore, storedPath,
} from './uploads.js';

export const publicRouter = express.Router();
const json = express.json({ limit: '32kb' });

const findLink = (token) => db.prepare('SELECT * FROM links WHERE token = ?').get(String(token)) || null;
const isAvailable = (l) => l && l.status === 'active' && (!l.expires_at || l.expires_at > now());
const lockFree = (l) => !l.locked_at || l.locked_at < now() - config.lockTtlMs;

const GONE = { error: 'This link is no longer valid (already used, expired or revoked).' };

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

function checkPasswordOrThrow(req, link, password) {
  if (!link.pw_hash) return;
  const key = `pw:${link.id}:${clientIp(req)}`;
  if (rateLimited(key, 8, 10 * 60_000)) throw new HttpError(429, 'Too many attempts, please try again later');
  if (!checkPassword(password, link.pw_hash)) throw new HttpError(403, 'Incorrect password');
}

// Minimal public information about a link.
publicRouter.get('/:token', wrap((req, res) => {
  const link = findLink(req.params.token);
  if (!isAvailable(link)) return res.status(link ? 410 : 404).json(GONE);
  const out = {
    type: link.type,
    requiresPassword: !!link.pw_hash,
    chunkSize: config.chunkSize,
  };
  if (link.type === 'drop') {
    out.maxSize = Math.min(link.max_size || Infinity, config.maxUploadBytes);
    out.busy = !lockFree(link);
  } else if (!link.pw_hash) {
    const f = db.prepare("SELECT name, size, sha256 FROM files WHERE link_id = ? AND direction = 'out'").get(link.id);
    if (f) Object.assign(out, { name: f.name, size: f.size, sha256: f.sha256 });
  }
  res.json(out);
}));

// ---- Receiving (drop): a single upload per link ----
publicRouter.post('/:token/start', json, wrap((req, res) => {
  const link = findLink(req.params.token);
  if (!link || link.type !== 'drop' || !isAvailable(link)) throw new HttpError(link ? 410 : 404, GONE.error);
  const b = req.body || {};
  checkPasswordOrThrow(req, link, b.password);

  const name = cleanText(b.name, 255).replace(/[\\/]/g, '_');
  const size = Number(b.size);
  if (!name) throw new HttpError(400, 'Missing file name');
  if (!Number.isInteger(size) || size <= 0) throw new HttpError(400, 'Empty file or invalid size');
  const limit = Math.min(link.max_size || Infinity, config.maxUploadBytes);
  if (size > limit) throw new HttpError(413, 'File too large for this link', { maxSize: limit });
  if (!isHex64(b.sha256)) throw new HttpError(400, 'Invalid SHA-256 checksum');

  // Atomic reservation: one upload at a time, and only one in total.
  const t = now();
  const claim = db.prepare(
    `UPDATE links SET locked_at = ?
     WHERE id = ? AND status = 'active' AND used_at IS NULL
       AND (locked_at IS NULL OR locked_at < ?) AND (expires_at IS NULL OR expires_at > ?)`,
  ).run(t, link.id, t - config.lockTtlMs, t);
  if (claim.changes !== 1) throw new HttpError(409, 'An upload is already in progress on this link');

  for (const old of db.prepare('SELECT id FROM uploads WHERE link_id = ?').all(link.id)) discardUpload(old.id);
  const uploadId = createUpload({
    linkId: link.id, name, size, sha256: b.sha256,
    sender: cleanText(b.sender, 100), message: cleanText(b.message, 1000), ip: clientIp(req),
  });
  res.json({
    uploadId,
    chunkUrl: `/api/public/uploads/${uploadId}/chunk`,
    finishUrl: `/api/public/uploads/${uploadId}/finish`,
    chunkSize: config.chunkSize,
  });
}));

function loadDropUpload(id) {
  const up = getUpload(id);
  const link = up && db.prepare('SELECT * FROM links WHERE id = ?').get(up.link_id);
  if (!up || !link || link.type !== 'drop' || link.status !== 'active') throw new HttpError(404, 'Upload not found');
  return { up, link };
}

publicRouter.put('/uploads/:id/chunk', wrap(async (req, res) => {
  const { up, link } = loadDropUpload(req.params.id);
  const received = await receiveChunk(up, req);
  db.prepare('UPDATE links SET locked_at = ? WHERE id = ?').run(now(), link.id); // heartbeat
  res.json({ received });
}));

publicRouter.post('/uploads/:id/finish', wrap(async (req, res) => {
  const { up, link } = loadDropUpload(req.params.id);
  let stored;
  try {
    stored = await verifyAndStore(up);
  } catch (e) {
    if (e instanceof HttpError && e.status === 422) {
      // Integrity failure: release the link so the sender can try again.
      discardUpload(up.id);
      db.prepare('UPDATE links SET locked_at = NULL WHERE id = ?').run(link.id);
    }
    throw e;
  }
  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO files (link_id, direction, name, stored_name, size, sha256, verified, sender, message, ip, created_at)
       VALUES (?, 'in', ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    ).run(link.id, up.name, stored.storedName, up.size, stored.sha256, up.sender, up.message, up.ip, now());
    db.prepare("UPDATE links SET status = 'used', used_at = ?, used_ip = ?, locked_at = NULL WHERE id = ?")
      .run(now(), up.ip, link.id);
    db.prepare('DELETE FROM uploads WHERE id = ?').run(up.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.json({ ok: true, name: up.name, size: up.size, sha256: stored.sha256 });
}));

// ---- Sending (download by the outside party): one-time ticket, then stream ----
const tickets = new Map(); // ticket -> { linkId, exp }
setInterval(() => {
  for (const [k, v] of tickets) if (v.exp < Date.now()) tickets.delete(k);
}, 60_000).unref();

publicRouter.post('/:token/ticket', json, wrap((req, res) => {
  const link = findLink(req.params.token);
  if (!link || link.type !== 'send' || !isAvailable(link)) throw new HttpError(link ? 410 : 404, GONE.error);
  checkPasswordOrThrow(req, link, (req.body || {}).password);
  const f = db.prepare("SELECT name, size, sha256 FROM files WHERE link_id = ? AND direction = 'out'").get(link.id);
  if (!f) throw new HttpError(410, GONE.error);
  const ticket = randomToken(24);
  tickets.set(ticket, { linkId: link.id, exp: Date.now() + 60_000 });
  res.json({ url: `/api/public/${link.token}/file?ticket=${ticket}`, name: f.name, size: f.size, sha256: f.sha256 });
}));

publicRouter.get('/:token/file', wrap((req, res) => {
  const link = findLink(req.params.token);
  const tk = tickets.get(String(req.query.ticket || ''));
  if (!link || !tk || tk.linkId !== link.id || tk.exp < Date.now()) throw new HttpError(403, 'Invalid or expired ticket');
  tickets.delete(String(req.query.ticket));
  if (link.type !== 'send') throw new HttpError(404, GONE.error);

  const t = now();
  const claim = db.prepare(
    `UPDATE links SET locked_at = ?
     WHERE id = ? AND status = 'active' AND used_at IS NULL
       AND (locked_at IS NULL OR locked_at < ?) AND (expires_at IS NULL OR expires_at > ?)`,
  ).run(t, link.id, t - config.lockTtlMs, t);
  if (claim.changes !== 1) throw new HttpError(410, GONE.error);

  const f = db.prepare("SELECT * FROM files WHERE link_id = ? AND direction = 'out'").get(link.id);
  const release = () => db.prepare('UPDATE links SET locked_at = NULL WHERE id = ?').run(link.id);
  if (!f || !fs.existsSync(storedPath(f.stored_name))) {
    release();
    throw new HttpError(410, GONE.error);
  }
  res.set({
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(f.size),
    'Content-Disposition': contentDisposition(f.name),
    'X-Content-SHA256': f.sha256,
    'Accept-Ranges': 'none',
  });
  // The link is only consumed if the stream was fully written; otherwise it is released.
  res.on('close', () => {
    if (res.writableFinished) {
      db.prepare("UPDATE links SET status = 'used', used_at = ?, used_ip = ?, locked_at = NULL WHERE id = ?")
        .run(now(), clientIp(req), link.id);
    } else {
      release();
    }
  });
  fs.createReadStream(storedPath(f.stored_name)).on('error', () => res.destroy()).pipe(res);
}));
