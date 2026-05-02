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

let me = null, hot = null, rows = [];
const dirty = new Map(); // rowIndex -> {id, oldValue, newValue}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

(async function init() {
  const { user } = await api('/api/me');
  if (!user) { $('#login').hidden = false; return; }
  if (!['admin', 'it-team'].includes(user.role)) { location.replace('/'); return; }
  me = user;
  $('#login').hidden = true;
  $('#topbar').hidden = false;
  $('#grid').hidden = false;
  $('#who').textContent = `${user.full_name || user.username} (${user.role})`;
  // it-team doesn't get the correction-grid link
  if (user.role !== 'admin') document.querySelector('[data-nav="grid"]').hidden = true;
  buildGrid();
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

function buildGrid() {
  hot = new Handsontable($('#grid'), {
    data: [], rowHeaders: true,
    colHeaders: ['Emp Code', 'Name', 'Department', 'DOJ'],
    columns: [
      { data: 'emp_code',   readOnly: true, width: 100 },
      { data: 'emp_name',   readOnly: true, width: 220 },
      { data: 'department', readOnly: true, width: 160 },
      { data: 'doj',        width: 130, placeholder: 'YYYY-MM-DD' },
    ],
    licenseKey: 'non-commercial-and-evaluation',
    height: '100%', width: '100%', stretchH: 'last',
    filters: true, dropdownMenu: true, columnSorting: true,
    contextMenu: ['copy', 'cut'], manualColumnResize: true,
    fillHandle: true, copyPaste: true,
    cells(row, col) {
      const r = rows[row]; if (!r) return {};
      const d = dirty.get(row);
      if (col === 3 && d) return { className: 'dirty' };
      if (col === 3 && !r.doj) return { className: 'anomaly' };
      return {};
    },
    beforeChange(changes, source) {
      if (source === 'loadData') return;
      for (const [, field, , newV] of changes) {
        if (field !== 'doj') return false;
        if (newV && !DATE_RE.test(String(newV).trim())) { toast(`Invalid date: ${newV}`); return false; }
      }
    },
    afterChange(changes, source) {
      if (source === 'loadData' || !changes) return;
      for (const [r, field, oldV, newV] of changes) {
        if (field !== 'doj' || oldV === newV) continue;
        if (!dirty.has(r)) dirty.set(r, { id: rows[r].id, oldValue: oldV });
        dirty.get(r).newValue = newV;
      }
      updateDirtyUI(); hot.render();
    },
  });
}

function updateDirtyUI() {
  $('#dirtyCount').textContent = dirty.size;
  $('#saveBtn').disabled = dirty.size === 0;
  $('#discardBtn').disabled = dirty.size === 0;
}

async function load() {
  if (dirty.size && !confirm('Discard unsaved changes?')) return;
  dirty.clear(); updateDirtyUI();
  const params = new URLSearchParams({ q: $('#empFilter').value });
  const data = await api('/api/employees?' + params);
  rows = data.rows;
  hot.loadData(rows);
  toast(`Loaded ${rows.length} employee(s)`);
}

$('#loadBtn').addEventListener('click', load);
$('#empFilter').addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });
$('#discardBtn').addEventListener('click', () => {
  if (!confirm('Discard all unsaved changes?')) return;
  dirty.clear(); hot.loadData(rows); updateDirtyUI();
});

$('#saveBtn').addEventListener('click', async () => {
  const edits = [...dirty.values()];
  if (!edits.length) return;
  if (!confirm(`Update DOJ for ${edits.length} employee(s)?`)) return;
  try {
    const r = await api('/api/employees/save-doj', { method: 'POST', body: JSON.stringify({ edits }) });
    toast(`Updated ${r.applied} (batch ${r.batchId.slice(0,8)})`);
    dirty.clear(); updateDirtyUI();
    await load();
  } catch (err) { toast('Save failed: ' + err.message, 6000); }
});

// ---------- audit ----------
$('#auditBtn').addEventListener('click', async () => {
  $('#auditModal').hidden = false;
  const { rows: logs } = await api('/api/employees/audit?limit=500');
  const canRollback = me.role === 'admin';
  const groups = {};
  for (const l of logs) (groups[l.batch_id] = groups[l.batch_id] || []).push(l);
  const html = Object.entries(groups).map(([batch, items]) => {
    const head = items[0];
    return `<details open><summary><b>${new Date(head.edited_at).toLocaleString()}</b> — ${head.edited_by_name} — ${items.length} change(s) ${head.rolled_back ? '<i>(rolled back)</i>' : ''} ${canRollback && !head.rolled_back ? `<button data-rb="${batch}">Rollback</button>` : ''}</summary>
      <table class="audit"><thead><tr><th>Emp</th><th>Field</th><th>Old</th><th>New</th></tr></thead>
      <tbody>${items.map(i => `<tr><td>${i.emp_code || i.emp_id}</td><td>${i.field}</td><td>${i.old_value ?? ''}</td><td>${i.new_value ?? ''}</td></tr>`).join('')}</tbody></table></details>`;
  }).join('') || '<p>No audit entries.</p>';
  $('#auditBody').innerHTML = html;
  $('#auditBody').querySelectorAll('button[data-rb]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Rollback this batch?')) return;
    try { const r = await api('/api/employees/audit/rollback', { method: 'POST', body: JSON.stringify({ batchId: b.dataset.rb }) });
      toast(`Reverted ${r.reverted} row(s)`); $('#auditBtn').click(); load();
    } catch (e) { toast(e.message, 5000); }
  }));
});
document.addEventListener('click', (e) => { if (e.target.matches('[data-close]')) $('#auditModal').hidden = true; });

window.addEventListener('beforeunload', (e) => { if (dirty.size) { e.preventDefault(); e.returnValue = ''; } });
