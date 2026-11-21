import path from 'node:path';

const env = process.env;
const MB = 1024 * 1024;

export const config = {
  port: Number(env.PORT) || 3000,
  dataDir: path.resolve(env.DATA_DIR || './data'),
  publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
  adminUser: env.ADMIN_USER || 'admin',
  adminPassword: env.ADMIN_PASSWORD || '',
  maxUploadBytes: (Number(env.MAX_UPLOAD_MB) || 2048) * MB,
  // Cloudflare (free plan) limits a request body to 100 MB, so uploads are sent in chunks.
  chunkSize: (Number(env.CHUNK_MB) || 25) * MB,
  sessionTtlMs: (Number(env.SESSION_TTL_HOURS) || 12) * 3600 * 1000,
  // Inactivity after which an interrupted drop releases the link.
  lockTtlMs: (Number(env.LOCK_TTL_MINUTES) || 10) * 60 * 1000,
  adminViaTunnel: env.ADMIN_VIA_TUNNEL !== 'false',
};
