import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { db, filesDir, tmpDir, unlinkQuiet } from './db.js';
import { config } from './config.js';
import { now, randomToken } from './util.js';

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const tmpPath = (id) => path.join(tmpDir, `${id}.part`);
const inFlight = new Set();

export function createUpload({ linkId, name, size, sha256, sender = '', message = '', ip = '' }) {
  const id = randomToken(18);
  fs.writeFileSync(tmpPath(id), '');
  db.prepare(
    `INSERT INTO uploads (id, link_id, name, size, sha256, sender, message, ip, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(id, linkId, name, size, sha256, sender, message, ip, now());
  return id;
}

export const getUpload = (id) =>
  db.prepare('SELECT * FROM uploads WHERE id = ?').get(String(id)) || null;

export function discardUpload(id) {
  unlinkQuiet(tmpPath(id));
  db.prepare('DELETE FROM uploads WHERE id = ?').run(id);
}

// Receives one chunk at the expected offset. The raw body is streamed to disk.
export async function receiveChunk(upload, req) {
  const offset = Number(req.query.offset);
  if (!Number.isInteger(offset) || offset !== upload.received) {
    throw new HttpError(409, 'Unexpected offset', { received: upload.received });
  }
  const len = Number(req.headers['content-length']);
  if (!Number.isInteger(len) || len <= 0) throw new HttpError(411, 'Content-Length required');
  if (len > config.chunkSize) throw new HttpError(413, 'Chunk too large');
  if (offset + len > upload.size) throw new HttpError(400, 'Exceeds the declared size');
  if (inFlight.has(upload.id)) throw new HttpError(409, 'Chunk already in progress', { received: upload.received });

  inFlight.add(upload.id);
  const file = tmpPath(upload.id);
  try {
    fs.truncateSync(file, offset); // discard any leftovers from a previous partial attempt
    let bytes = 0;
    req.on('data', (c) => { bytes += c.length; });
    await pipeline(req, fs.createWriteStream(file, { flags: 'a' }));
    if (bytes !== len) throw new Error('incomplete body');
    db.prepare('UPDATE uploads SET received = ? WHERE id = ?').run(offset + len, upload.id);
    return offset + len;
  } catch (e) {
    try { fs.truncateSync(file, offset); } catch { /* ignore */ }
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, 'Upload interrupted', { received: offset });
  } finally {
    inFlight.delete(upload.id);
  }
}

// Checks completeness (size) and integrity (client-declared SHA-256), then moves the file into place.
export async function verifyAndStore(upload) {
  const file = tmpPath(upload.id);
  const stat = fs.statSync(file);
  if (stat.size !== upload.size || upload.received !== upload.size) {
    throw new HttpError(422, 'Incomplete file', { received: stat.size, expected: upload.size });
  }
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  const actual = hash.digest('hex');
  if (actual !== upload.sha256) {
    throw new HttpError(422, 'SHA-256 mismatch: file was corrupted during transfer');
  }
  const storedName = randomToken(24);
  fs.renameSync(file, path.join(filesDir, storedName));
  return { storedName, sha256: actual };
}

export function hashStoredFile(storedName) {
  const hash = crypto.createHash('sha256');
  return pipeline(fs.createReadStream(path.join(filesDir, storedName)), hash).then(() => hash.digest('hex'));
}

export const storedPath = (storedName) => path.join(filesDir, storedName);
