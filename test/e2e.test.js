import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'drophub-'));
process.env.ADMIN_USER = 'boss';
process.env.ADMIN_PASSWORD = 'correct horse battery';
process.env.CHUNK_MB = '1';

const { createApp } = await import('../src/server.js');
const server = createApp().listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

let cookie = '';
const H = { 'X-Requested-With': 'drophub' };
async function call(url, { method = 'GET', body, headers = {}, raw, auth = false } = {}) {
  const h = { ...headers };
  if (auth) Object.assign(h, H, { cookie });
  if (body !== undefined && !raw) h['Content-Type'] = 'application/json';
  const res = await fetch(base + url, { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const buf = Buffer.from(await res.arrayBuffer());
  let data = null;
  try { data = JSON.parse(buf.toString()); } catch { /* binary */ }
  return { status: res.status, data, buf, headers: res.headers };
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// Uploads a file in 1 MB chunks; `tamper` alters the data after the checksum was computed.
async function upload(startUrl, startBody, data, { admin = false, tamper = false } = {}) {
  const start = await call(startUrl, { method: 'POST', body: startBody, auth: admin });
  if (start.status !== 200) return { start };
  const payload = tamper ? Buffer.concat([Buffer.from([data[0] ^ 1]), data.subarray(1)]) : data;
  const cs = start.data.chunkSize;
  for (let o = 0; o < payload.length; o += cs) {
    const r = await call(`${start.data.chunkUrl}?offset=${o}`, { method: 'PUT', raw: payload.subarray(o, o + cs), auth: admin,
      headers: { 'Content-Type': 'application/octet-stream' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  const finish = await call(start.data.finishUrl, { method: 'POST', body: {}, auth: admin });
  return { start, finish };
}

test('admin login', async () => {
  assert.equal((await call('/api/admin/links', { auth: true })).status, 401);
  assert.equal((await call('/api/admin/login', { method: 'POST', body: { username: 'boss', password: 'x' }, headers: H })).status, 401);
  assert.equal((await call('/api/admin/login', { method: 'POST', body: { username: 'boss', password: 'correct horse battery' } })).status, 403); // without the anti-CSRF header
  const ok = await fetch(base + '/api/admin/login', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'boss', password: 'correct horse battery' }) });
  assert.equal(ok.status, 200);
  cookie = ok.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('/api/admin/links', { auth: true })).status, 200);
});

test('drop: one file per link, 3 MB in several chunks, checksum verified', async () => {
  const link = (await call('/api/admin/links/drop', { method: 'POST', body: { label: 'test' }, auth: true })).data;
  const token = link.url.split('/').pop();
  assert.match(link.url, /\/u\//);
  const data = crypto.randomBytes(3 * 1024 * 1024 + 123);
  const meta = { name: 'rapport.pdf', size: data.length, sha256: sha(data), sender: 'Alice', message: 'hello' };

  const { finish } = await upload(`/api/public/${token}/start`, meta, data);
  assert.equal(finish.status, 200, JSON.stringify(finish.data));
  assert.equal(finish.data.sha256, sha(data));

  // Second upload refused
  assert.equal((await call(`/api/public/${token}/start`, { method: 'POST', body: meta })).status, 410);
  assert.equal((await call(`/api/public/${token}`)).status, 410);

  const files = (await call('/api/admin/files', { auth: true })).data;
  assert.equal(files.length, 1);
  assert.equal(files[0].sender, 'Alice');
  const dl = await call(`/api/admin/files/${files[0].id}/download`, { auth: true });
  assert.equal(sha(dl.buf), sha(data));
  assert.equal((await call(`/api/admin/files/${files[0].id}/verify`, { auth: true })).data.ok, true);
});

test('corrupted drop: rejected, link reusable', async () => {
  const link = (await call('/api/admin/links/drop', { method: 'POST', body: {}, auth: true })).data;
  const token = link.url.split('/').pop();
  const data = crypto.randomBytes(200_000);
  const meta = { name: 'a.bin', size: data.length, sha256: sha(data) };
  const bad = await upload(`/api/public/${token}/start`, meta, data, { tamper: true });
  assert.equal(bad.finish.status, 422);
  const good = await upload(`/api/public/${token}/start`, meta, data);
  assert.equal(good.finish.status, 200);
});

test('drop: concurrency, incomplete file, password, max size, expiry', async () => {
  const mk = async (body) => (await call('/api/admin/links/drop', { method: 'POST', body, auth: true })).data.url.split('/').pop();
  const data = crypto.randomBytes(5000);
  const meta = { name: 'a.bin', size: data.length, sha256: sha(data) };

  const t1 = await mk({});
  assert.equal((await call(`/api/public/${t1}/start`, { method: 'POST', body: meta })).status, 200);
  assert.equal((await call(`/api/public/${t1}/start`, { method: 'POST', body: meta })).status, 409); // already in progress

  const start = (await call(`/api/public/${await mk({})}/start`, { method: 'POST', body: meta })).data;
  assert.equal((await call(start.finishUrl, { method: 'POST', body: {} })).status, 422); // incomplete

  const tp = await mk({ password: 'secret' });
  assert.equal((await call(`/api/public/${tp}`)).data.requiresPassword, true);
  assert.equal((await call(`/api/public/${tp}/start`, { method: 'POST', body: { ...meta, password: 'nope' } })).status, 403);
  assert.equal((await call(`/api/public/${tp}/start`, { method: 'POST', body: { ...meta, password: 'secret' } })).status, 200);

  const ts = await mk({ maxSizeMb: 0.001 });
  assert.equal((await call(`/api/public/${ts}/start`, { method: 'POST', body: meta })).status, 413);

  const te = await mk({ expiresInHours: 0.00001 });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await call(`/api/public/${te}`)).status, 410);
});

test('send: single-use download link with password', async () => {
  const data = crypto.randomBytes(1_500_000);
  const { finish } = await upload('/api/admin/send/start',
    { name: 'contrat.pdf', size: data.length, sha256: sha(data), password: 'pw123' }, data, { admin: true });
  assert.equal(finish.status, 200, JSON.stringify(finish.data));
  const token = finish.data.url.split('/').pop();
  assert.match(finish.data.url, /\/g\//);

  const info = (await call(`/api/public/${token}`)).data;
  assert.equal(info.requiresPassword, true);
  assert.equal(info.name, undefined); // name hidden until the password is provided
  assert.equal((await call(`/api/public/${token}/ticket`, { method: 'POST', body: { password: 'bad' } })).status, 403);

  const t = (await call(`/api/public/${token}/ticket`, { method: 'POST', body: { password: 'pw123' } })).data;
  assert.equal(t.sha256, sha(data));
  const file = await call(t.url);
  assert.equal(file.status, 200);
  assert.equal(sha(file.buf), sha(data));
  assert.equal(file.headers.get('x-content-sha256'), sha(data));

  await new Promise((r) => setTimeout(r, 100)); // let the 'close' event mark the link as used
  assert.equal((await call(`/api/public/${token}`)).status, 410);
  assert.equal((await call(t.url)).status, 403); // ticket already consumed
  assert.equal((await call(`/api/public/${token}/ticket`, { method: 'POST', body: { password: 'pw123' } })).status, 410);
});

test('corrupted send: link deleted', async () => {
  const data = crypto.randomBytes(10_000);
  const { finish } = await upload('/api/admin/send/start', { name: 'x.bin', size: data.length, sha256: sha(data) }, data,
    { admin: true, tamper: true });
  assert.equal(finish.status, 422);
});

test('pages and unknown tokens', async () => {
  assert.equal((await call('/api/public/unknown')).status, 404);
  assert.equal((await fetch(base + '/u/unknown')).status, 200); // the page loads, the API says "invalid"
  assert.equal((await call('/static/sha256.js')).status, 200);
  assert.equal((await fetch(base + '/terms')).status, 200);
  assert.equal((await fetch(base + '/status')).status, 200);
  const st = (await call('/api/status')).data;
  assert.equal(st.status, 'operational');
  assert.equal(st.version, '1.0.0');
});
