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
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const nameCache = new Map(); // emp_code -> name | null (null = looked up, doesn't exist)

(async function init() {
  const { user } = await api('/api/me');
  if (!user) { $('#login').hidden = false; return; }
  if (!['admin', 'it-team'].includes(user.role)) { location.replace('/'); return; }
  me = user;
  $('#login').hidden = true;
  $('#topbar').hidden = false;
  $('#grid').hidden = false;
  $('#who').textContent = `${user.full_name || user.username} (${user.role})`;
  // it-team can't reach the correction grid — hide the link
  if (user.role !== 'admin') document.querySelector('[data-nav="grid"]').hidden = true;
  buildGrid();
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

function blankRow() { return { emp_code: '', emp_name: '', att_date: '', in_time: '', out_time: '', remarks: '' }; }
function isFilled(r) { return r && (r.emp_code || r.att_date || r.in_time || r.out_time || r.remarks); }

function buildGrid() {
  rows = Array.from({ length: 10 }, blankRow);
  hot = new Handsontable($('#grid'), {
    data: rows, rowHeaders: true,
    colHeaders: ['Emp Code *', 'Name', 'Date *', 'In Time', 'Out Time', 'Remarks'],
    columns: [
      { data: 'emp_code', width: 110 },
      { data: 'emp_name', readOnly: true, width: 200 },
      { data: 'att_date', width: 120, placeholder: 'YYYY-MM-DD' },
      { data: 'in_time', width: 100, placeholder: 'HH:MM' },
      { data: 'out_time', width: 100, placeholder: 'HH:MM' },
      { data: 'remarks', width: 280 },
    ],
    licenseKey: 'non-commercial-and-evaluation',
    height: '100%', width: '100%', stretchH: 'last',
    contextMenu: ['row_above','row_below','remove_row','copy','cut','---------','clear_column'],
    manualColumnResize: true, copyPaste: true, fillHandle: true,
    minSpareRows: 1,
    afterChange(changes, source) {
      if (source === 'loadData' || !changes) return;
      updateFilledCount();
      // resolve names for any emp_code that changed
      const codes = new Set();
      for (const [r, field] of changes) if (field === 'emp_code') {
        const code = (rows[r].emp_code || '').trim();
        if (code) codes.add(code);
        else rows[r].emp_name = '';
      }
      for (const code of codes) resolveName(code).then(() => hot.render());
    },
    cells(row, col) {
      const r = rows[row];
      if (!r) return {};
      const field = ['emp_code','emp_name','att_date','in_time','out_time','remarks'][col];
      let cls = '';
      // bad-cell styling: required fields missing on a partially-filled row
      if (isFilled(r)) {
        if (field === 'emp_code' && !r.emp_code) cls = 'anomaly';
        if (field === 'emp_code' && r.emp_code && nameCache.get(r.emp_code) === null) cls = 'anomaly';
        if (field === 'att_date' && !r.att_date) cls = 'anomaly';
        if (field === 'att_date' && r.att_date && !DATE_RE.test(r.att_date)) cls = 'anomaly';
        if ((field === 'in_time' || field === 'out_time') && r[field] && !TIME_RE.test(r[field])) cls = 'anomaly';
      }
      return cls ? { className: cls } : {};
    },
  });
  updateFilledCount();
}

async function resolveName(code) {
  if (nameCache.has(code)) {
    propagateName(code);
    return;
  }
  try {
    const { row } = await api('/api/employees/by-code?code=' + encodeURIComponent(code));
    nameCache.set(code, row ? row.name : null);
  } catch { nameCache.set(code, null); }
  propagateName(code);
}
function propagateName(code) {
  const name = nameCache.get(code);
  for (const r of rows) if (r.emp_code === code) r.emp_name = name || '';
}

function updateFilledCount() {
  const n = rows.filter(isFilled).length;
  $('#filledCount').textContent = n;
  $('#saveBtn').disabled = n === 0;
}

$('#addRowsBtn').addEventListener('click', () => {
  for (let i = 0; i < 10; i++) rows.push(blankRow());
  hot.loadData(rows); updateFilledCount();
});
$('#clearBtn').addEventListener('click', () => {
  rows = rows.filter(isFilled);
  while (rows.length < 10) rows.push(blankRow());
  hot.loadData(rows); updateFilledCount();
});

$('#saveBtn').addEventListener('click', async () => {
  const items = rows.filter(isFilled).map(r => ({
    emp_code: (r.emp_code || '').trim(),
    att_date: (r.att_date || '').trim(),
    in_time:  (r.in_time  || '').trim() || null,
    out_time: (r.out_time || '').trim() || null,
    remarks:  (r.remarks  || '').trim() || null,
  }));
  if (!items.length) return;
  // Client-side pre-flight: emp_code + date are mandatory on every filled row.
  for (let i = 0; i < items.length; i++) {
    if (!items[i].emp_code) return toast(`Row ${i + 1}: Emp Code is required`, 4000);
    if (!items[i].att_date) return toast(`Row ${i + 1}: Date is required`, 4000);
    if (!DATE_RE.test(items[i].att_date)) return toast(`Row ${i + 1}: Date must be YYYY-MM-DD`, 4000);
    if (items[i].in_time  && !TIME_RE.test(items[i].in_time))  return toast(`Row ${i + 1}: bad In Time`, 4000);
    if (items[i].out_time && !TIME_RE.test(items[i].out_time)) return toast(`Row ${i + 1}: bad Out Time`, 4000);
  }
  if (!confirm(`Save ${items.length} record(s) to the database?`)) return;
  try {
    const r = await api('/api/attendance/create-batch', { method: 'POST', body: JSON.stringify({ items }) });
    const skipped = r.skipped || [];
    toast(`Created ${r.created} · Updated ${r.updated} · Skipped ${skipped.length}`, 5000);
    if (skipped.length) {
      const lines = skipped.map(s => `Row ${s.row}: ${s.emp_code} on ${s.att_date} — ${s.reason}`).join('\n');
      alert(`Cannot update the following — DOJ is in a different month than the attendance date:\n\n${lines}\n\n(Logged to logs/skipped-creates.log)`);
    }
    // Keep the skipped rows visible so the user can edit/delete them; drop only saved ones.
    const skippedKeys = new Set(skipped.map(s => `${s.emp_code}|${s.att_date}`));
    rows = rows.filter(x => !isFilled(x) || skippedKeys.has(`${(x.emp_code||'').trim()}|${(x.att_date||'').trim()}`));
    while (rows.length < 10) rows.push(blankRow());
    hot.loadData(rows); updateFilledCount();
  } catch (err) { toast('Save failed: ' + err.message, 6000); }
});

window.addEventListener('beforeunload', (e) => {
  if (rows.some(isFilled)) { e.preventDefault(); e.returnValue = ''; }
});
