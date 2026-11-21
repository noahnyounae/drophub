const state = $('#state');
const details = $('#details');

function row(k, v) { return h('tr', {}, h('th', {}, k), h('td', {}, v)); }

function formatUptime(s) {
  const d = Math.floor(s / 86400), hr = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return [d && `${d}d`, (d || hr) && `${hr}h`, `${m}m`].filter(Boolean).join(' ');
}

async function refresh() {
  try {
    const s = await api('/api/status');
    const ok = s.status === 'operational';
    state.replaceChildren(h('span', { class: `dot ${ok ? 'up' : 'down'}` }), ok ? 'All systems operational' : 'Service degraded');
    details.replaceChildren(
      row('Database', s.database ? 'OK' : 'Unavailable'),
      row('Storage', s.storage ? 'OK' : 'Unavailable'),
      row('Version', s.version),
      row('Uptime', formatUptime(s.uptimeSeconds)),
      row('Checked', formatDate(s.time)));
  } catch {
    state.replaceChildren(h('span', { class: 'dot down' }), 'Service unreachable');
    details.replaceChildren();
  }
}

refresh();
setInterval(refresh, 30000);
