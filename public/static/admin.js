const app = $('#app');
const STATUS = { active: 'active', used: 'used', expired: 'expired', revoked: 'revoked' };
const EXPIRY = [['', 'Never'], ['1', '1 hour'], ['24', '24 hours'], ['168', '7 days'], ['720', '30 days']];
let tab = 'received';

const adminApi = (url, opts = {}) => api(url, { ...opts, admin: true });

async function init() {
  const me = await api('/api/admin/me');
  me.loggedIn ? renderDashboard() : renderLogin();
}

function renderLogin() {
  const user = h('input', { autocomplete: 'username', required: true });
  const pass = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const err = h('p', { class: 'err' });
  const form = h('form', { class: 'card narrow', onsubmit: async (e) => {
    e.preventDefault();
    try {
      await adminApi('/api/admin/login', { method: 'POST', body: { username: user.value, password: pass.value } });
      renderDashboard();
    } catch (x) { err.textContent = x.message; }
  } }, h('h1', { class: 'brand' }, h('img', { src: '/static/logo.svg', alt: '', width: '36', height: '36' }), 'DropHub'), h('label', {}, 'Username'), user,
    h('label', {}, 'Password'), pass, h('div', { class: 'row' }, h('button', { class: 'primary' }, 'Sign in')), err);
  app.replaceChildren(h('div', { class: 'narrow' }, form));
  user.focus();
}

function expirySelect() {
  return h('select', {}, EXPIRY.map(([v, l]) => h('option', { value: v }, l)));
}

function linkResult(box, link) {
  const field = h('input', { readonly: true, value: link.url });
  const copied = h('span', { class: 'muted' });
  box.replaceChildren(h('div', { class: 'result' }, h('div', { class: 'muted' }, 'Generated link:'), field,
    h('div', { class: 'row' }, h('button', { onclick: async () => {
      copied.textContent = (await copyText(link.url)) ? 'Copied ✓' : 'Copy failed, select the text manually';
    } }, 'Copy'), copied)));
  field.select();
}

function dropCard(refresh) {
  const label = h('input', { maxlength: '120', placeholder: 'E.g. Smith invoice' });
  const exp = expirySelect();
  const max = h('input', { type: 'number', min: '1', placeholder: 'Unlimited (server cap)' });
  const pw = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Optional' });
  const out = h('div', {});
  const err = h('p', { class: 'err' });
  const btn = h('button', { class: 'primary', onclick: async () => {
    err.textContent = '';
    try {
      const l = await adminApi('/api/admin/links/drop', { method: 'POST', body: {
        label: label.value, expiresInHours: exp.value, maxSizeMb: max.value, password: pw.value } });
      linkResult(out, l);
      pw.value = '';
      refresh();
    } catch (e) { err.textContent = e.message; }
  } }, 'Generate an upload link');
  return h('div', { class: 'card' }, h('h2', {}, '⬇ Receive a file'),
    h('label', {}, 'Label (for you)'), label,
    h('label', {}, 'Expiry'), exp,
    h('label', {}, 'Max size (MB)'), max,
    h('label', {}, 'Password'), pw,
    h('div', { class: 'row' }, btn), err, out);
}

function sendCard(refresh) {
  const file = h('input', { type: 'file' });
  const label = h('input', { maxlength: '120', placeholder: 'Defaults to the file name' });
  const exp = expirySelect();
  const pw = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Optional' });
  const bar = h('progress', { max: '1', value: '0', hidden: true });
  const status = h('p', { class: 'muted' });
  const out = h('div', {});
  const err = h('p', { class: 'err' });
  const btn = h('button', { class: 'primary', onclick: async () => {
    const f = file.files[0];
    if (!f) { err.textContent = 'Choose a file.'; return; }
    err.textContent = '';
    btn.disabled = true;
    bar.hidden = false;
    try {
      status.textContent = 'Computing SHA-256 checksum…';
      const sha256 = await hashFile(f, (p) => { bar.value = p; });
      bar.value = 0;
      status.textContent = 'Uploading…';
      const up = await adminApi('/api/admin/send/start', { method: 'POST', body: {
        name: f.name, size: f.size, sha256, label: label.value, expiresInHours: exp.value, password: pw.value } });
      const link = await uploadChunks(f, { ...up, admin: true, onProgress: (p) => { bar.value = p; } });
      linkResult(out, link);
      file.value = ''; pw.value = '';
      refresh();
    } catch (e) { err.textContent = e.message; }
    status.textContent = '';
    bar.hidden = true;
    btn.disabled = false;
  } }, 'Upload and generate link');
  return h('div', { class: 'card' }, h('h2', {}, '⬆ Send a file'),
    h('label', {}, 'File'), file,
    h('label', {}, 'Label (for you)'), label,
    h('label', {}, 'Expiry'), exp,
    h('label', {}, 'Password'), pw,
    h('div', { class: 'row' }, btn), bar, status, err, out);
}

async function receivedTable() {
  const files = await adminApi('/api/admin/files');
  if (!files.length) return h('p', { class: 'muted' }, 'No files received yet.');
  const rows = files.map((f) => {
    const verify = h('span', { class: 'muted' });
    return h('tr', {},
      h('td', {}, formatDate(f.createdAt)),
      h('td', {}, h('div', {}, f.name), h('div', { class: 'muted' }, f.linkLabel)),
      h('td', {}, formatSize(f.size)),
      h('td', {}, h('div', {}, f.sender || '—'), f.message ? h('div', { class: 'muted' }, f.message) : null,
        h('div', { class: 'muted' }, f.ip)),
      h('td', {}, h('div', { class: 'mono', title: f.sha256 }, `${f.sha256.slice(0, 16)}… `, h('span', { class: 'ok' }, '✓')), verify),
      h('td', {}, h('div', { class: 'row' },
        h('a', { href: `/api/admin/files/${f.id}/download` }, h('button', {}, 'Download')),
        h('button', { onclick: async () => {
          verify.textContent = 'Verifying…';
          try {
            const r = await adminApi(`/api/admin/files/${f.id}/verify`);
            verify.textContent = r.ok ? 'Intact ✓' : 'CORRUPTED ✗';
            verify.className = r.ok ? 'ok' : 'err';
          } catch (e) { verify.textContent = e.message; }
        } }, 'Verify'),
        h('button', { class: 'danger', onclick: async () => {
          if (!confirm(`Delete “${f.name}”?`)) return;
          await adminApi(`/api/admin/files/${f.id}`, { method: 'DELETE' });
          renderDashboard();
        } }, 'Delete'))));
  });
  return h('div', { class: 'scroll' }, h('table', {},
    h('thead', {}, h('tr', {}, ['Date', 'File', 'Size', 'Sender', 'SHA-256', ''].map((t) => h('th', {}, t)))),
    h('tbody', {}, rows)));
}

async function linksTable() {
  const links = await adminApi('/api/admin/links');
  if (!links.length) return h('p', { class: 'muted' }, 'No links.');
  const rows = links.map((l) => h('tr', {},
    h('td', {}, l.type === 'drop' ? '⬇ Receive' : '⬆ Send'),
    h('td', {}, h('div', {}, l.label || '—'), l.file ? h('div', { class: 'muted' }, `${l.file.name} (${formatSize(l.file.size)})`) : null),
    h('td', {}, h('span', { class: `badge ${l.status}` }, STATUS[l.status] || l.status), l.hasPassword ? ' 🔒' : ''),
    h('td', {}, h('div', {}, `Created: ${formatDate(l.createdAt)}`),
      h('div', { class: 'muted' }, `Expires: ${l.expiresAt ? formatDate(l.expiresAt) : 'never'}`),
      l.usedAt ? h('div', { class: 'muted' }, `Used: ${formatDate(l.usedAt)}`) : null),
    h('td', {}, h('div', { class: 'row' },
      l.status === 'active' ? h('button', { onclick: async (e) => {
        e.target.textContent = (await copyText(l.url)) ? 'Copied ✓' : l.url;
      } }, 'Copy') : null,
      l.status === 'active' ? h('button', { onclick: async () => {
        await adminApi(`/api/admin/links/${l.id}/revoke`, { method: 'POST', body: {} });
        renderDashboard();
      } }, 'Revoke') : null,
      h('button', { class: 'danger', onclick: async () => {
        if (!confirm('Delete this link and its associated file?')) return;
        await adminApi(`/api/admin/links/${l.id}`, { method: 'DELETE' });
        renderDashboard();
      } }, 'Delete')))));
  return h('div', { class: 'scroll' }, h('table', {},
    h('thead', {}, h('tr', {}, ['Type', 'Label', 'Status', 'Dates', ''].map((t) => h('th', {}, t)))),
    h('tbody', {}, rows)));
}

async function renderDashboard() {
  const list = h('div', {});
  const refreshList = async () => {
    try { list.replaceChildren(tab === 'received' ? await receivedTable() : await linksTable()); }
    catch (e) { if (e.status === 401) return renderLogin(); list.replaceChildren(h('p', { class: 'err' }, e.message)); }
  };
  const tabBtn = (id, text) => h('button', { class: tab === id ? 'on' : '', onclick: () => { tab = id; renderDashboard(); } }, text);
  app.replaceChildren(
    h('div', { class: 'row spread' }, h('h1', { class: 'brand' }, h('img', { src: '/static/logo.svg', alt: '', width: '36', height: '36' }), 'DropHub'),
      h('button', { onclick: async () => { await adminApi('/api/admin/logout', { method: 'POST', body: {} }); renderLogin(); } }, 'Sign out')),
    h('div', { class: 'grid' }, dropCard(refreshList), sendCard(refreshList)),
    h('div', { class: 'card' }, h('div', { class: 'tabs' }, tabBtn('received', 'Received files'), tabBtn('links', 'Links'),
      h('button', { onclick: refreshList }, '↻')), list));
  refreshList();
}

init();
