import crypto from 'node:crypto';
import { config } from './config.js';

export const now = () => Date.now();
export const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');
export const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 32);
  return `${salt.toString('hex')}:${key.toString('hex')}`;
}

export function checkPassword(pw, stored) {
  const [saltHex, keyHex] = String(stored).split(':');
  if (!saltHex || !keyHex) return false;
  const key = crypto.scryptSync(String(pw ?? ''), Buffer.from(saltHex, 'hex'), 32);
  const expected = Buffer.from(keyHex, 'hex');
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

export function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function clientIp(req) {
  return req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '';
}

export function baseUrl(req) {
  if (config.publicUrl) return config.publicUrl;
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol).split(',')[0];
  return `${proto}://${req.headers.host}`;
}

// In-memory rate limiter: at most `max` attempts per window.
const buckets = new Map();
export function rateLimited(key, max, windowMs) {
  const t = Date.now();
  const arr = (buckets.get(key) || []).filter((x) => t - x < windowMs);
  arr.push(t);
  buckets.set(key, arr);
  return arr.length > max;
}
setInterval(() => {
  const t = Date.now();
  for (const [k, v] of buckets) if (!v.some((x) => t - x < 3600_000)) buckets.delete(k);
}, 600_000).unref();

export const isHex64 = (s) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);

export function cleanText(s, max) {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

export function contentDisposition(name) {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
