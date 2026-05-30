const $ = (s) => document.querySelector(s);
const api = async (url, opts = {}) => {
  const r = await fetch(url, { headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', ...opts });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
};
const toast = (msg, ms = 2500) => {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), ms);
};

let me = null, rowsCache = [];

(async function init() {
  const { user } = await api('/api/me');
  if (!user) { $('#login').hidden = false; return; }
  me = user;
  $('#login').hidden = true;
  $('#topbar').hidden = false;
  $('#reportWrap').hidden = false;
  $('#who').textContent = `${user.full_name || user.username} (${user.role})`;
  // it-team doesn't have the correction grid
  if (user.role !== 'admin') document.querySelector('[data-nav="grid"]')?.toggleAttribute('hidden', true);
  // editor/viewer only see the correction-grid nav link
  if (user.role === 'editor' || user.role === 'viewer') {
    document.querySelector('[data-nav="add"]')?.toggleAttribute('hidden', true);
    document.querySelector('[data-nav="doj"]')?.toggleAttribute('hidden', true);
  }
  const now = new Date();
  $('#month').value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  load();
})();

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ username: fd.get('username'), password: fd.get('password') }) });
    location.reload();
  } catch (err) { $('#loginErr').textContent = err.message; }
});
$('#logoutBtn').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }); location.reload(); });

async function load() {
  const params = new URLSearchParams({ month: $('#month').value, employee: $('#empFilter').value });
  const data = await api('/api/changes-report?' + params);
  rowsCache = data.rows;
  render();
  toast(`Loaded ${rowsCache.length} change(s)`);
}
$('#loadBtn').addEventListener('click', load);
$('#empFilter').addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });

function diff(a, b) { return a === b ? '' : ' delta'; }
function render() {
  const tbody = $('#report tbody');
  tbody.innerHTML = rowsCache.map(r => `
    <tr class="${r.rolled_back ? 'rb' : ''}">
      <td>${r.emp_code}</td>
      <td>${r.emp_name || ''}</td>
      <td>${r.att_date}</td>
      <td>${r.old_in  || ''}</td>
      <td>${r.old_out || ''}</td>
      <td>${r.old_duration || ''}</td>
      <td class="${diff(r.old_in,  r.new_in)}" >${r.new_in  || ''}</td>
      <td class="${diff(r.old_out, r.new_out)}">${r.new_out || ''}</td>
      <td class="${diff(r.old_duration, r.new_duration)}">${r.new_duration || ''}</td>
      <td>${r.changed_by || ''}</td>
      <td>${new Date(r.changed_at).toLocaleString()}</td>
    </tr>`).join('') || '<tr><td colspan="11" style="text-align:center;color:#999;padding:24px;">No changes for this filter.</td></tr>';
}

$('#csvBtn').addEventListener('click', () => {
  if (!rowsCache.length) return toast('Nothing to export');
  const hdr = ['emp_code','emp_name','date','old_in','old_out','old_duration','new_in','new_out','new_duration','changed_by','changed_at'];
  const esc = v => v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v;
  const csv = [hdr.join(',')]
    .concat(rowsCache.map(r => [r.emp_code, r.emp_name, r.att_date, r.old_in, r.old_out, r.old_duration, r.new_in, r.new_out, r.new_duration, r.changed_by, r.changed_at].map(esc).join(',')))
    .join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `changes-${$('#month').value}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
});
