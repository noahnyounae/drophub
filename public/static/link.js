const app = $('#app');
const token = location.pathname.split('/')[2];
const base = `/api/public/${encodeURIComponent(token)}`;

const brand = h('p', { class: 'brand' }, h('img', { src: '/static/logo.svg', alt: '', width: '28', height: '28' }), 'DropHub');
function show(...nodes) { app.replaceChildren(brand, ...nodes); }
const gone = (msg) => show(h('div', { class: 'card' }, h('h1', {}, 'Link unavailable'),
  h('p', {}, msg || 'This link is no longer valid (already used, expired or revoked).')));

async function main() {
  let info;
  try { info = await api(base); } catch (e) { return gone(e.message); }
  const wantDrop = location.pathname.startsWith('/u/');
  if ((info.type === 'drop') !== wantDrop) return gone();
  info.type === 'drop' ? renderDrop(info) : renderSend(info);
}

function renderDrop(info) {
  let file = null;
  const input = h('input', { type: 'file', hidden: true });
  const zone = h('div', { class: 'drop', tabindex: '0' }, 'Drag a file here or click to choose');
  const sender = h('input', { maxlength: '100', placeholder: 'Your name (optional)' });
  const message = h('textarea', { maxlength: '1000', placeholder: 'Message (optional)' });
  const password = h('input', { type: 'password', autocomplete: 'off' });
  const bar = h('progress', { max: '1', value: '0', hidden: true });
  const status = h('p', { class: 'muted' });
  const error = h('p', { class: 'err' });
  const send = h('button', { class: 'primary', disabled: true }, 'Send');

  const pick = (f) => {
    if (!f) return;
    if (f.size === 0) { error.textContent = 'This file is empty.'; return; }
    if (f.size > info.maxSize) { error.textContent = `File too large (max ${formatSize(info.maxSize)}).`; return; }
    error.textContent = '';
    file = f;
    zone.textContent = `${f.name} — ${formatSize(f.size)}`;
    send.disabled = false;
  };
  zone.onclick = () => input.click();
  input.onchange = () => pick(input.files[0]);
  zone.ondragover = (e) => { e.preventDefault(); zone.classList.add('over'); };
  zone.ondragleave = () => zone.classList.remove('over');
  zone.ondrop = (e) => { e.preventDefault(); zone.classList.remove('over'); pick(e.dataTransfer.files[0]); };

  send.onclick = async () => {
    error.textContent = '';
    send.disabled = true;
    bar.hidden = false;
    try {
      status.textContent = 'Computing SHA-256 checksum…';
      const sha256 = await hashFile(file, (p) => { bar.value = p; });
      bar.value = 0;
      status.textContent = 'Uploading…';
      const up = await api(`${base}/start`, { method: 'POST', body: {
        name: file.name, size: file.size, sha256,
        sender: sender.value, message: message.value, password: password.value,
      } });
      status.textContent = 'Uploading…';
      const done = await uploadChunks(file, { ...up, onProgress: (p) => { bar.value = p; } });
      show(h('div', { class: 'card' }, h('h1', { class: 'ok' }, 'File received ✓'),
        h('p', {}, `“${done.name}” (${formatSize(done.size)}) was transferred and verified by the server.`),
        h('p', { class: 'muted' }, 'SHA-256 checksum (transfer receipt):'),
        h('p', { class: 'mono' }, done.sha256),
        h('p', { class: 'muted' }, 'This link is now closed: no further uploads are possible.')));
    } catch (e) {
      error.textContent = e.message;
      status.textContent = '';
      bar.hidden = true;
      send.disabled = false;
    }
  };

  show(h('div', { class: 'card' },
    h('h1', {}, 'Upload a file'),
    h('p', { class: 'muted' }, `Only one file can be uploaded with this link (max ${formatSize(info.maxSize)}).`),
    info.busy ? h('p', { class: 'err' }, 'An upload may already be in progress on this link.') : null,
    zone, input,
    h('label', {}, 'Name'), sender,
    h('label', {}, 'Message'), message,
    info.requiresPassword ? [h('label', {}, 'Link password'), password] : null,
    h('div', { class: 'row' }, send),
    bar, status, error));
}

function renderSend(info) {
  const password = h('input', { type: 'password', autocomplete: 'off' });
  const error = h('p', { class: 'err' });
  const btn = h('button', { class: 'primary' }, 'Download');
  btn.onclick = async () => {
    error.textContent = '';
    btn.disabled = true;
    try {
      const t = await api(`${base}/ticket`, { method: 'POST', body: { password: password.value } });
      location.href = t.url;
      show(h('div', { class: 'card' }, h('h1', {}, 'Download started'),
        h('p', {}, `${t.name} (${formatSize(t.size)})`),
        h('p', { class: 'muted' }, 'This link is single-use: it will stop working once the file has been retrieved.'),
        h('p', { class: 'muted' }, 'SHA-256 checksum to verify the file:'),
        h('p', { class: 'mono' }, t.sha256),
        h('p', { class: 'mono muted' }, `sha256sum "${t.name}"`)));
    } catch (e) {
      error.textContent = e.message;
      btn.disabled = false;
    }
  };
  show(h('div', { class: 'card' },
    h('h1', {}, 'File to download'),
    info.name ? h('p', {}, `${info.name} — ${formatSize(info.size)}`) : null,
    info.sha256 ? [h('p', { class: 'muted' }, 'SHA-256:'), h('p', { class: 'mono' }, info.sha256)] : null,
    h('p', { class: 'muted' }, 'Single-use link.'),
    info.requiresPassword ? [h('label', {}, 'Password'), password] : null,
    h('div', { class: 'row' }, btn), error));
}

main();
