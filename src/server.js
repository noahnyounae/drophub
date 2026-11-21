import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { config } from './config.js';
import { db, tmpDir, unlinkQuiet } from './db.js';
import { adminRouter } from './admin.js';
import { publicRouter } from './public.js';
import { discardUpload } from './uploads.js';
import { now } from './util.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, '..', 'public');
const { version } = createRequire(import.meta.url)('../package.json');

export function createApp() {
  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'X-Robots-Tag': 'noindex, nofollow',
      'Content-Security-Policy':
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    });
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    next();
  });

  // Option: hide the admin interface from requests arriving through the Cloudflare tunnel.
  if (!config.adminViaTunnel) {
    app.use(['/admin', '/api/admin'], (req, res, next) => {
      if (req.headers['cf-ray'] || req.headers['cf-connecting-ip']) return res.status(404).end();
      next();
    });
  }

  app.use('/static', express.static(path.join(pub, 'static'), { maxAge: '1h' }));
  app.get('/status', (req, res) => res.sendFile(path.join(pub, 'status.html')));
  app.get('/terms', (req, res) => res.sendFile(path.join(pub, 'terms.html')));
  app.get('/api/status', (req, res) => {
    let database = true, storage = true;
    try { db.prepare('SELECT 1').get(); } catch { database = false; }
    try { fs.accessSync(tmpDir, fs.constants.W_OK); } catch { storage = false; }
    res.json({
      status: database && storage ? 'operational' : 'degraded',
      database, storage, version, uptimeSeconds: Math.floor(process.uptime()), time: now(),
    });
  });
  app.get('/healthz', (req, res) => res.type('text').send('ok'));
  app.get('/', (req, res) => res.redirect('/admin'));
  app.get('/admin', (req, res) => res.sendFile(path.join(pub, 'admin.html')));
  app.get(['/u/:token', '/g/:token'], (req, res) => res.sendFile(path.join(pub, 'link.html')));

  app.use('/api/admin', adminRouter);
  app.use('/api/public', publicRouter);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  return app;
}

// Periodic cleanup: expired sessions, abandoned uploads, unfinished sends.
export function cleanup() {
  const t = now();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(t);
  const stale = db.prepare('SELECT id, link_id FROM uploads WHERE created_at < ?').all(t - 24 * 3600_000);
  for (const u of stale) {
    discardUpload(u.id);
    db.prepare("DELETE FROM links WHERE id = ? AND status = 'pending'").run(u.link_id);
  }
  const known = new Set(db.prepare('SELECT id FROM uploads').all().map((u) => `${u.id}.part`));
  for (const f of fs.readdirSync(tmpDir)) if (!known.has(f)) unlinkQuiet(path.join(tmpDir, f));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!config.adminPassword || config.adminPassword.length < 8) {
    console.error('ADMIN_PASSWORD must be set (8 characters minimum).');
    process.exit(1);
  }
  cleanup();
  setInterval(cleanup, 3600_000).unref();
  createApp().listen(config.port, () => console.log(`DropHub listening on :${config.port}`));
}
