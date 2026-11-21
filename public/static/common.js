// Shared helpers: DOM, API, file hashing, chunked upload.
const $ = (sel, root = document) => root.querySelector(sel);

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

function formatSize(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i && n < 10 ? 1 : 0)} ${u[i]}`;
}

const formatDate = (ms) => (ms ? new Date(ms).toLocaleString('en-GB') : '—');

async function api(url, { method = 'GET', body, admin = false } = {}) {
  const headers = {};
  if (admin) headers['X-Requested-With'] = 'drophub';
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Error ${res.status}`), { status: res.status, data });
  return data;
}

async function hashFile(file, onProgress) {
  const sha = new Sha256();
  const step = 8 * 1024 * 1024;
  for (let o = 0; o < file.size; o += step) {
    sha.update(new Uint8Array(await file.slice(o, o + step).arrayBuffer()));
    onProgress?.(Math.min(1, (o + step) / file.size));
  }
  return sha.hex();
}

function putChunk(url, blob, onProgress, admin) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    if (admin) xhr.setRequestHeader('X-Requested-With', 'drophub');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded);
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status === 200) resolve(data);
      else reject(Object.assign(new Error(data.error || `Error ${xhr.status}`), { status: xhr.status, data }));
    };
    xhr.onerror = () => reject(Object.assign(new Error('Network unavailable'), { status: 0 }));
    xhr.send(blob);
  });
}

// Uploads the file in chunks (resuming after failures), then asks the server for final validation.
async function uploadChunks(file, { chunkUrl, finishUrl, chunkSize, admin = false, onProgress }) {
  let offset = 0;
  let failures = 0;
  while (offset < file.size) {
    const end = Math.min(file.size, offset + chunkSize);
    try {
      const r = await putChunk(chunkUrl + `?offset=${offset}`, file.slice(offset, end),
        (loaded) => onProgress?.((offset + loaded) / file.size), admin);
      offset = r.received;
      failures = 0;
    } catch (e) {
      if (e.status === 409 && Number.isInteger(e.data?.received)) { offset = e.data.received; continue; }
      if (e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) throw e;
      if (++failures > 4) throw e;
      await new Promise((r) => setTimeout(r, 1000 * failures));
    }
  }
  onProgress?.(1);
  return api(finishUrl, { method: 'POST', body: {}, admin });
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}
