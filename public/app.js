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
let editableMonths = [];
// dirty: Map<rowIndex, Map<field, {oldValue, newValue, id}>>
const dirty = new Map();

// ---------- draft persistence (localStorage) ----------
const DRAFT_INTERVAL_MS = 30_000;
const draftKey = () => `att-draft:${me?.id}:${$('#month').value}`;
function saveDraft(silent) {
  if (!me) return;
  const edits = [];
  for (const [r, fields] of dirty)
    for (const [field, v] of fields)
      edits.push({ id: v.id, field, oldValue: v.oldValue, newValue: v.newValue });
  const key = draftKey();
  if (!edits.length) { localStorage.removeItem(key); setDraftStatus(''); return; }
  localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), edits }));
  if (!silent) setDraftStatus(`Draft saved ${new Date().toLocaleTimeString()}`, true);
}
function clearDraft() { if (me) localStorage.removeItem(draftKey()); setDraftStatus(''); }
function loadDraft() {
  if (!me) return null;
  const raw = localStorage.getItem(draftKey());
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
function applyDraft(draft) {
  if (!draft?.edits?.length) return 0;
  const idIdx = new Map(rows.map((r, i) => [r.id, i]));
  let n = 0;
  for (const e of draft.edits) {
    const r = idIdx.get(e.id);
    if (r === undefined) continue;
    rows[r][e.field] = e.newValue;
    if (!dirty.has(r)) dirty.set(r, new Map());
    dirty.get(r).set(e.field, { oldValue: e.oldValue, newValue: e.newValue, id: e.id });
    n++;
  }
  return n;
}
function setDraftStatus(text, flash) {
  const el = $('#draftStatus');
  el.textContent = text;
  if (flash) { el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 600); }
}
setInterval(() => saveDraft(false), DRAFT_INTERVAL_MS);

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

// ---------- auth ----------
async function init() {
  const { user, editableMonths: em } = await api('/api/me');
  if (!user) { $('#login').hidden = false; return; }
  if (user.role === 'it-team') { location.replace('/add-attendance'); return; }
  me = user;
  editableMonths = em || [];
  $('#login').hidden = true;
  $('#topbar').hidden = false;
  $('#grid').hidden = false;
  $('#who').textContent = `${user.full_name || user.username} (${user.role})`;
  const now = new Date();
  $('#month').value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  buildGrid();
  load();
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ username: fd.get('username'), password: fd.get('password') }) });
    location.reload();
  } catch (err) { $('#loginErr').textContent = err.message; }
});
$('#logoutBtn').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }); location.reload(); });

// ---------- grid ----------
function isMonthEditable() {
  return editableMonths.includes($('#month').value);
}
function canEditNow() {
  return (me.role === 'editor' || me.role === 'admin') && isMonthEditable();
}
function applyEditableState() {
  if (!hot) return;
  const ro = !canEditNow();
  hot.updateSettings({
    columns: hot.getSettings().columns.map((c, i) => (i === 3 || i === 4 || i === 6) ? { ...c, readOnly: ro } : c),
  });
  const editable = !ro;
  $('#saveBtn').disabled = !editable || dirty.size === 0;
  $('#discardBtn').disabled = !editable || dirty.size === 0;
  setReadOnlyBanner(ro);
}
function setReadOnlyBanner(ro) {
  let el = $('#roBanner');
  if (!el) {
    el = document.createElement('span');
    el.id = 'roBanner';
    el.className = 'draft-status';
    el.style.color = '#b54708';
    $('#topbar').insertBefore(el, $('#draftStatus'));
  }
  el.textContent = ro ? 'Read-only — month outside editable window' : '';
}

function buildGrid() {
  const editable = me.role === 'editor' || me.role === 'admin';
  hot = new Handsontable($('#grid'), {
    data: [], rowHeaders: true,
    colHeaders: ['Emp Code', 'Name', 'Date', 'In Time', 'Out Time', 'Computed', 'Remarks'],
    columns: [
      { data: 'emp_code', readOnly: true, width: 90 },
      { data: 'emp_name', readOnly: true, width: 180 },
      { data: 'att_date', readOnly: true, width: 100 },
      { data: 'in_time', readOnly: !editable, width: 90 },
      { data: 'out_time', readOnly: !editable, width: 90 },
      { data: 'computed', readOnly: true, width: 90,
        renderer: (inst, td, r) => { td.innerText = computeHours(rows[r]); td.style.color = '#555'; } },
      { data: 'remarks', readOnly: !editable, width: 240 },
    ],
    licenseKey: 'non-commercial-and-evaluation',
    height: '100%', width: '100%', stretchH: 'last',
    filters: true, dropdownMenu: true, columnSorting: true,
    contextMenu: ['copy', 'cut'], manualColumnResize: true,
    fillHandle: true, copyPaste: true,
    cells(row, col) {
      const cp = {};
      const field = ['emp_code','emp_name','att_date','in_time','out_time','computed','remarks'][col];
      const d = dirty.get(row);
      if (d && d.has(field)) cp.className = 'dirty';
      // anomaly: missing in/out
      const r = rows[row];
      if (r && (field === 'in_time' || field === 'out_time') && !r[field]) cp.className = (cp.className || '') + ' anomaly';
      return cp;
    },
    beforeChange(changes, source) {
      if (source === 'loadData') return;
      for (const [r, field, oldV, newV] of changes) {
        if (field === 'remarks') {
          if (newV && String(newV).length > 255) { toast('Remark too long (max 255)'); return false; }
          continue;
        }
        if (field !== 'in_time' && field !== 'out_time') return false;
        if (newV && !TIME_RE.test(String(newV).trim())) { toast(`Invalid time: ${newV}`); return false; }
        const row = rows[r];
        const proj = { ...row, [field]: newV || null };
        if (proj.in_time && proj.out_time && normTime(proj.out_time) <= normTime(proj.in_time)) {
          toast(`Out Time must be > In Time`); return false;
        }
      }
    },
    afterChange(changes, source) {
      if (source === 'loadData' || !changes) return;
      for (const [r, field, oldV, newV] of changes) {
        if (oldV === newV) continue;
        if (!dirty.has(r)) dirty.set(r, new Map());
        const rd = dirty.get(r);
        if (!rd.has(field)) rd.set(field, { oldValue: oldV, id: rows[r].id });
        rd.get(field).newValue = newV;
      }
      updateDirtyUI();
      hot.render();
      saveDraft(true); // silent persist on every edit
    },
  });
}

function normTime(s) { s = String(s).trim(); return s.length === 5 ? s + ':00' : s; }
function computeHours(r) {
  if (!r || !r.in_time || !r.out_time) return '';
  const [h1,m1] = normTime(r.in_time).split(':').map(Number);
  const [h2,m2] = normTime(r.out_time).split(':').map(Number);
  const mins = (h2*60+m2) - (h1*60+m1);
  if (mins <= 0) return '';
  return (mins/60).toFixed(2);
}

function updateDirtyUI() {
  let n = 0; for (const m of dirty.values()) n += m.size;
  $('#dirtyCount').textContent = n;
  $('#saveBtn').disabled = n === 0;
  $('#discardBtn').disabled = n === 0;
}

// ---------- load / save ----------
async function load() {
  if (dirty.size && !confirm('Discard unsaved changes?')) return;
  dirty.clear(); updateDirtyUI();
  const params = new URLSearchParams({ month: $('#month').value, employee: $('#empFilter').value });
  const data = await api('/api/attendance?' + params);
  rows = data.rows;
  const draft = loadDraft();
  let restored = 0;
  if (draft && confirm(`A draft from ${new Date(draft.savedAt).toLocaleString()} has ${draft.edits.length} unsaved edit(s). Restore?`)) {
    restored = applyDraft(draft);
  } else if (draft) {
    clearDraft();
  }
  hot.loadData(rows);
  updateDirtyUI();
  applyEditableState();
  hot.render();
  toast(`Loaded ${rows.length} rows${restored ? `, restored ${restored} draft edit(s)` : ''}${canEditNow() ? '' : ' (read-only)'}`);
}

$('#month').addEventListener('change', applyEditableState);

$('#loadBtn').addEventListener('click', load);
$('#discardBtn').addEventListener('click', () => {
  if (!confirm('Discard all unsaved changes (and the draft)?')) return;
  dirty.clear(); clearDraft(); hot.loadData(rows); updateDirtyUI();
});

$('#saveBtn').addEventListener('click', async () => {
  const edits = [];
  for (const [r, fields] of dirty) {
    for (const [field, v] of fields) {
      edits.push({ id: v.id, field, oldValue: v.oldValue, newValue: v.newValue });
    }
  }
  if (!edits.length) return;
  if (!confirm(`Commit ${edits.length} change(s) to the database?`)) return;
  try {
    const r = await api('/api/attendance/save', { method: 'POST', body: JSON.stringify({ edits }) });
    toast(`Saved ${r.applied} change(s). Batch: ${r.batchId.slice(0,8)}`);
    dirty.clear(); clearDraft(); updateDirtyUI();
    await load();
  } catch (e) { toast('Save failed: ' + e.message, 5000); }
});

// ---------- audit ----------
$('#auditBtn').addEventListener('click', async () => {
  $('#auditModal').hidden = false;
  const { rows: logs } = await api('/api/audit?limit=500&month=' + encodeURIComponent($('#month').value));
  const canRollback = me.role === 'admin';
  const groups = {};
  for (const l of logs) (groups[l.batch_id] = groups[l.batch_id] || []).push(l);
  const html = Object.entries(groups).map(([batch, items]) => {
    const head = items[0];
    return `<details open><summary><b>${new Date(head.edited_at).toLocaleString()}</b> — ${head.edited_by_name} — ${items.length} change(s) ${head.rolled_back ? '<i>(rolled back)</i>' : ''} ${canRollback && !head.rolled_back ? `<button data-rb="${batch}">Rollback</button>` : ''}</summary>
      <table class="audit"><thead><tr><th>Row</th><th>Field</th><th>Old</th><th>New</th></tr></thead>
      <tbody>${items.map(i => `<tr><td>${i.row_id}</td><td>${i.field}</td><td>${i.old_value ?? ''}</td><td>${i.new_value ?? ''}</td></tr>`).join('')}</tbody></table></details>`;
  }).join('') || '<p>No audit entries.</p>';
  $('#auditBody').innerHTML = html;
  $('#auditBody').querySelectorAll('button[data-rb]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Rollback this batch?')) return;
    try { const r = await api('/api/audit/rollback', { method: 'POST', body: JSON.stringify({ batchId: b.dataset.rb }) });
      toast(`Reverted ${r.reverted} row(s)`); $('#auditBtn').click(); load();
    } catch (e) { toast(e.message, 5000); }
  }));
});
document.addEventListener('click', (e) => { if (e.target.matches('[data-close]')) $('#auditModal').hidden = true; });

window.addEventListener('beforeunload', (e) => { if (dirty.size) { e.preventDefault(); e.returnValue = ''; } });

init();
