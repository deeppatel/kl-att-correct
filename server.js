require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const SKIPPED_LOG = path.join(__dirname, 'logs', 'skipped-creates.log');
fs.mkdirSync(path.dirname(SKIPPED_LOG), { recursive: true });
function logSkipped(entry) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n';
  fs.appendFile(SKIPPED_LOG, line, () => {});
}

const {
  PORT = 3000, SESSION_SECRET = 'dev-secret',
  DB_HOST, DB_PORT = 3306, DB_USER, DB_PASSWORD, DB_NAME,
} = process.env;

const pool = mysql.createPool({
  host: DB_HOST, port: +DB_PORT, user: DB_USER, password: DB_PASSWORD,
  database: DB_NAME, connectionLimit: 8, dateStrings: true,
});

// Schema is fixed to dp_sync.attendance_data.
const EDITABLE = new Set(['in_time', 'out_time', 'remarks']);

// Optional employee master. Auto-detected at boot, env can override.
//   EMP_TABLE     : e.g. employees_dp                     (empty/unset disables join)
//   EMP_JOIN_KIND : 'code' (join on emp_code) | 'id'      (default: 'code')
//   EMP_JOIN_COL  : column on EMP_TABLE used for join     (default: 'emp_code')
//   EMP_NAME_COLS : comma-separated cols, joined by space (e.g. "first_name,last_name")
//                   Falls back to EMP_NAME_COL if set.
//   EMP_DELETED_AT: soft-delete column on EMP_TABLE       (default: 'deleted_at' if present)
const empMaster = { table: null, joinKind: 'code', joinCol: 'emp_code', nameExpr: null, hasDeletedAt: false };

function buildNameExpr(cols, alias = 'e') {
  return `CONCAT_WS(' ', ${cols.map(c => `${alias}.\`${c}\``).join(', ')})`;
}

async function detectEmployeeMaster() {
  // Env override path
  if (process.env.EMP_TABLE) {
    const t = process.env.EMP_TABLE;
    const kind = (process.env.EMP_JOIN_KIND || 'code').toLowerCase();
    const joinCol = process.env.EMP_JOIN_COL || (kind === 'code' ? 'emp_code' : 'id');
    const nameCols = (process.env.EMP_NAME_COLS || process.env.EMP_NAME_COL || 'name').split(',').map(s => s.trim()).filter(Boolean);
    let hasDel = false;
    try {
      const [cols] = await pool.query(`SHOW COLUMNS FROM \`${t}\``);
      hasDel = cols.some(c => c.Field === (process.env.EMP_DELETED_AT || 'deleted_at'));
    } catch {}
    Object.assign(empMaster, { table: t, joinKind: kind, joinCol, nameExpr: buildNameExpr(nameCols), hasDeletedAt: hasDel });
    console.log(`employee master (env): ${t} on ${kind === 'code' ? 'emp_code' : 'emp_id'} -> .${joinCol}, name=${nameCols.join('+')}${hasDel ? ' (deleted_at filter)' : ''}`);
    return;
  }
  // Auto-detect path. Probes table names + column shape.
  const candidates = [
    { t: 'employees_dp',     join: 'emp_code', kind: 'code', nameCols: ['first_name','last_name'] },
    { t: 'employees',        join: 'id',       kind: 'id',   nameCols: ['name'] },
    { t: 'employee_master',  join: 'id',       kind: 'id',   nameCols: ['name'] },
    { t: 'emp_master',       join: 'id',       kind: 'id',   nameCols: ['name'] },
  ];
  for (const c of candidates) {
    try {
      const [cols] = await pool.query(`SHOW COLUMNS FROM \`${c.t}\``);
      const fields = new Set(cols.map(x => x.Field));
      if (!fields.has(c.join)) continue;
      const present = c.nameCols.filter(x => fields.has(x));
      if (!present.length) continue;
      Object.assign(empMaster, {
        table: c.t, joinKind: c.kind, joinCol: c.join,
        nameExpr: buildNameExpr(present), hasDeletedAt: fields.has('deleted_at'),
      });
      break;
    } catch { /* not found, try next */ }
  }
  if (empMaster.table)
    console.log(`employee master (auto): ${empMaster.table} on ${empMaster.joinKind === 'code' ? 'emp_code' : 'emp_id'} -> .${empMaster.joinCol}${empMaster.hasDeletedAt ? ' (deleted_at filter)' : ''}`);
  else
    console.log('employee master: none found — name column will be blank');
}

// ---------- helpers ----------
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
function validateTime(v) {
  if (v === null || v === '' || v === undefined) return null;
  if (!TIME_RE.test(String(v).trim())) throw new Error(`Invalid time: ${v}`);
  const s = String(v).trim();
  return s.length === 5 ? s + ':00' : s;
}
// A row's date is editable iff it's in the current month, OR in the previous
// month AND today is between the 1st and 7th (inclusive).
function isDateEditable(yyyyMmDd, now = new Date()) {
  const [y, m] = yyyyMmDd.split('-').map(Number);
  const curY = now.getFullYear(), curM = now.getMonth() + 1;
  if (y === curY && m === curM) return true;
  const prev = new Date(curY, curM - 2, 1); // previous month's 1st
  if (y === prev.getFullYear() && m === prev.getMonth() + 1 && now.getDate() <= 7) return true;
  return false;
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user) return res.status(401).json({ error: 'auth required' });
    if (!roles.includes(req.session.user.role)) return res.status(403).json({ error: 'forbidden' });
    next();
  };
}

// ---------- app ----------
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(session({
  secret: SESSION_SECRET, resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 8 * 3600 * 1000 },
}));
// Page routes — must come before static so we control which HTML is served
// for the "directory-like" URLs. Static still serves CSS/JS/images normally.
app.get('/add-attendance', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'add-attendance.html')));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- auth ----------
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const [rows] = await pool.query(
      'SELECT id, username, password_hash, full_name, role, active FROM att_users WHERE username=? LIMIT 1',
      [username]);
    const u = rows[0];
    if (!u || !u.active || !bcrypt.compareSync(password || '', u.password_hash))
      return res.status(401).json({ error: 'Invalid credentials' });
    req.session.user = { id: u.id, username: u.username, full_name: u.full_name, role: u.role };
    res.json({ user: req.session.user });
  } catch (e) {
    console.error('login error:', e.message);
    res.status(500).json({ error: e.code === 'ER_NO_SUCH_TABLE' ? 'App tables missing — run db/schema.sql' : e.message });
  }
});

// Last-resort guard so one bad query never kills the server.
process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err));
process.on('uncaughtException', (err) => console.error('uncaughtException:', err));
app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/me', (req, res) => {
  const now = new Date();
  const ym = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  res.json({
    user: req.session.user || null,
    editableMonths: now.getDate() <= 7 ? [ym(prev), ym(now)] : [ym(now)],
  });
});

// ---------- data ----------
app.get('/api/attendance', requireRole('viewer','editor','admin'), async (req, res) => {
  try {
    const { month, employee, limit = 5000, offset = 0 } = req.query;
    const attSide = empMaster.joinKind === 'code' ? 'a.emp_code' : 'a.emp_id';
    const join = empMaster.table
      ? `LEFT JOIN \`${empMaster.table}\` e ON e.\`${empMaster.joinCol}\` = ${attSide}${empMaster.hasDeletedAt ? ' AND e.deleted_at IS NULL' : ''}`
      : '';
    const nameSel = empMaster.table ? `${empMaster.nameExpr} AS emp_name` : `NULL AS emp_name`;

    const where = ['a.deleted_at IS NULL']; const params = [];
    if (month && /^\d{4}-\d{2}$/.test(month)) {
      where.push("DATE_FORMAT(a.`date`, '%Y-%m') = ?"); params.push(month);
    }
    if (employee) {
      if (empMaster.table) {
        where.push(`(a.emp_code LIKE ? OR ${empMaster.nameExpr} LIKE ?)`);
        params.push(`%${employee}%`, `%${employee}%`);
      } else {
        where.push('a.emp_code LIKE ?'); params.push(`%${employee}%`);
      }
    }
    const sql = `SELECT a.id, a.emp_id, a.emp_code, ${nameSel},
      DATE_FORMAT(a.\`date\`, '%Y-%m-%d') AS att_date,
      TIME_FORMAT(a.in_time, '%H:%i:%s') AS in_time,
      TIME_FORMAT(a.out_time, '%H:%i:%s') AS out_time,
      TIME_FORMAT(a.working_hrs, '%H:%i') AS working_hrs,
      a.remarks
      FROM attendance_data a ${join}
      WHERE ${where.join(' AND ')}
      ORDER BY a.\`date\` ASC, a.emp_code ASC LIMIT ? OFFSET ?`;
    params.push(+limit, +offset);
    const [rows] = await pool.query(sql, params);
    res.json({ rows, empMaster: !!empMaster.table });
  } catch (e) { console.error('attendance fetch:', e.message); res.status(500).json({ error: e.message }); }
});

// Create a new attendance row. Resolves emp_id from employees_dp.emp_code,
// enforces the editable window, and writes audit entries for each non-null field.
app.post('/api/attendance/create', requireRole('admin','it-team'), async (req, res) => {
  const { emp_code, att_date, in_time, out_time, remarks } = req.body || {};
  const conn = await pool.getConnection();
  try {
    if (!emp_code) throw new Error('emp_code required');
    if (!att_date || !/^\d{4}-\d{2}-\d{2}$/.test(att_date)) throw new Error('att_date must be YYYY-MM-DD');
    if (!isDateEditable(att_date)) throw new Error(`Date ${att_date} is outside the editable window`);
    const inT  = validateTime(in_time);
    const outT = validateTime(out_time);
    if (inT && outT && outT <= inT) throw new Error('Out Time must be greater than In Time');
    const note = remarks ? String(remarks).trim().slice(0, 255) : null;

    await conn.beginTransaction();

    // Resolve emp_id from employees_dp.emp_code (must exist and not soft-deleted).
    const [emps] = await conn.query(
      `SELECT id FROM employees_dp WHERE emp_code = ? AND deleted_at IS NULL LIMIT 1`,
      [emp_code]);
    if (!emps[0]) throw new Error(`emp_code ${emp_code} not found in employees master`);
    const emp_id = emps[0].id;

    // Reject duplicates (same employee + date already exists, not soft-deleted).
    const [dup] = await conn.query(
      `SELECT id FROM attendance_data WHERE emp_code = ? AND \`date\` = ? AND deleted_at IS NULL LIMIT 1`,
      [emp_code, att_date]);
    if (dup[0]) throw new Error(`A record for ${emp_code} on ${att_date} already exists (id ${dup[0].id})`);

    const inDt  = inT  ? `${att_date} ${inT}`  : null;
    const outDt = outT ? `${att_date} ${outT}` : null;

    const [r] = await conn.query(
      `INSERT INTO attendance_data (emp_id, emp_code, \`date\`, in_time, out_time, remarks)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [emp_id, emp_code, att_date, inDt, outDt, note]);
    const rowId = r.insertId;

    const user = req.session.user;
    const batchId = crypto.randomUUID();
    const audit = (field, val) => conn.query(
      `INSERT INTO att_audit_log (row_id, field, old_value, new_value, edited_by, edited_by_name, batch_id)
       VALUES (?, ?, NULL, ?, ?, ?, ?)`,
      [rowId, field, val, user.id, user.full_name || user.username, batchId]);
    if (inT)  await audit('in_time',  inT);
    if (outT) await audit('out_time', outT);
    if (note) await audit('remarks',  note);

    await conn.commit();
    res.json({ ok: true, id: rowId, batchId });
  } catch (err) {
    await conn.rollback();
    res.status(400).json({ error: err.message });
  } finally { conn.release(); }
});

// Batch save: [{id, field, oldValue, newValue}, ...]
app.post('/api/attendance/save', requireRole('editor','admin'), async (req, res) => {
  const edits = Array.isArray(req.body?.edits) ? req.body.edits : [];
  if (!edits.length) return res.json({ ok: true, applied: 0 });
  const user = req.session.user;
  const batchId = crypto.randomUUID();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    let applied = 0;
    for (const e of edits) {
      const field = String(e.field || '');
      if (!EDITABLE.has(field)) throw new Error(`Field not editable: ${field}`);
      const [[cur]] = await conn.query(
        `SELECT DATE_FORMAT(\`date\`,'%Y-%m-%d') AS d,
                TIME_FORMAT(in_time,'%H:%i:%s')  AS in_time,
                TIME_FORMAT(out_time,'%H:%i:%s') AS out_time
         FROM attendance_data WHERE id=? FOR UPDATE`, [e.id]);
      if (!cur) throw new Error(`Row ${e.id} not found`);
      if (!isDateEditable(cur.d))
        throw new Error(`Row ${e.id} (${cur.d}) is outside the editable window`);

      let writeVal, logVal;
      if (field === 'remarks') {
        const txt = (e.newValue ?? '').toString().trim();
        if (txt.length > 255) throw new Error(`Remark too long (max 255) on row ${e.id}`);
        writeVal = txt || null;
        logVal = writeVal;
      } else {
        const newTime = validateTime(e.newValue);
        const projected = { ...cur, [field]: newTime };
        if (projected.in_time && projected.out_time && projected.out_time <= projected.in_time)
          throw new Error(`Out Time must be greater than In Time (row ${e.id})`);
        writeVal = newTime ? `${cur.d} ${newTime}` : null;
        logVal = newTime;
      }

      const [r] = await conn.query(
        `UPDATE attendance_data SET \`${field}\`=? WHERE id=?`, [writeVal, e.id]);
      if (r.affectedRows) {
        applied++;
        await conn.query(
          `INSERT INTO att_audit_log (row_id, field, old_value, new_value, edited_by, edited_by_name, batch_id)
           VALUES (?,?,?,?,?,?,?)`,
          [e.id, field, e.oldValue ?? null, logVal, user.id, user.full_name || user.username, batchId]);
      }
    }
    await conn.commit();
    res.json({ ok: true, applied, batchId });
  } catch (err) {
    await conn.rollback();
    res.status(400).json({ error: err.message });
  } finally { conn.release(); }
});

// Audit log + rollback
// Batch create — one transaction, all-or-nothing. Skips rows with no emp_code.
app.post('/api/attendance/create-batch', requireRole('admin','it-team'), async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.json({ ok: true, created: 0 });
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const user = req.session.user;
    const batchId = crypto.randomUUID();
    let created = 0, updated = 0;
    const skipped = []; // {row, emp_code, att_date, reason}
    const skippedLogEntries = []; // file-flushed only after commit succeeds
    for (let idx = 0; idx < items.length; idx++) {
      const it = items[idx] || {};
      if (!it.emp_code) throw new Error(`Row ${idx + 1}: emp_code is required`);
      if (!it.att_date || !/^\d{4}-\d{2}-\d{2}$/.test(it.att_date))
        throw new Error(`Row ${idx + 1}: date must be YYYY-MM-DD`);
      if (!isDateEditable(it.att_date))
        throw new Error(`Row ${idx + 1}: date ${it.att_date} is outside the editable window`);
      const inT  = validateTime(it.in_time);
      const outT = validateTime(it.out_time);
      if (inT && outT && outT <= inT)
        throw new Error(`Row ${idx + 1}: Out Time must be greater than In Time`);
      const note = it.remarks ? String(it.remarks).trim().slice(0, 255) : null;

      const [emps] = await conn.query(
        `SELECT id, DATE_FORMAT(doj, '%Y-%m') AS doj_ym
         FROM employees_dp WHERE emp_code = ? AND deleted_at IS NULL LIMIT 1`,
        [it.emp_code]);
      if (!emps[0]) throw new Error(`Row ${idx + 1}: emp_code ${it.emp_code} not in employees master`);
      const emp_id = emps[0].id;
      const dojYm  = emps[0].doj_ym; // 'YYYY-MM' or null

      const inDt  = inT  ? `${it.att_date} ${inT}`  : null;
      const outDt = outT ? `${it.att_date} ${outT}` : null;
      const audit = (rowId, field, oldV, newV) => conn.query(
        `INSERT INTO att_audit_log (row_id, field, old_value, new_value, edited_by, edited_by_name, batch_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [rowId, field, oldV, newV, user.id, user.full_name || user.username, batchId]);

      // Duplicate check on (emp_code, date).
      const [dup] = await conn.query(
        `SELECT id,
                TIME_FORMAT(in_time,'%H:%i:%s')  AS in_time,
                TIME_FORMAT(out_time,'%H:%i:%s') AS out_time,
                remarks
         FROM attendance_data WHERE emp_code = ? AND \`date\` = ? AND deleted_at IS NULL LIMIT 1`,
        [it.emp_code, it.att_date]);

      if (dup[0]) {
        const attYm = it.att_date.slice(0, 7);
        if (dojYm && dojYm === attYm) {
          // Same DOJ month → overwrite the existing row's editable fields with audit.
          const cur = dup[0];
          const rowId = cur.id;
          if (inT  !== null && inT  !== cur.in_time)  { await conn.query(`UPDATE attendance_data SET in_time=?  WHERE id=?`, [inDt,  rowId]); await audit(rowId, 'in_time',  cur.in_time,  inT);  }
          if (outT !== null && outT !== cur.out_time) { await conn.query(`UPDATE attendance_data SET out_time=? WHERE id=?`, [outDt, rowId]); await audit(rowId, 'out_time', cur.out_time, outT); }
          if (note !== null && note !== cur.remarks)  { await conn.query(`UPDATE attendance_data SET remarks=?  WHERE id=?`, [note,  rowId]); await audit(rowId, 'remarks',  cur.remarks,  note); }
          updated++;
        } else {
          const reason = dojYm
            ? `existing row id ${dup[0].id}; DOJ ${dojYm} differs from attendance month ${attYm}`
            : `existing row id ${dup[0].id}; employee has no DOJ on file`;
          skipped.push({ row: idx + 1, emp_code: it.emp_code, att_date: it.att_date, reason });
          skippedLogEntries.push({ user: user.username, emp_code: it.emp_code, att_date: it.att_date, doj_ym: dojYm, existing_id: dup[0].id, reason });
        }
        continue;
      }

      // Fresh insert.
      const [r] = await conn.query(
        `INSERT INTO attendance_data (emp_id, emp_code, \`date\`, in_time, out_time, remarks)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [emp_id, it.emp_code, it.att_date, inDt, outDt, note]);
      const rowId = r.insertId;
      if (inT)  await audit(rowId, 'in_time',  null, inT);
      if (outT) await audit(rowId, 'out_time', null, outT);
      if (note) await audit(rowId, 'remarks',  null, note);
      created++;
    }
    await conn.commit();
    skippedLogEntries.forEach(logSkipped);
    res.json({ ok: true, created, updated, skipped, batchId });
  } catch (err) {
    await conn.rollback();
    res.status(400).json({ error: err.message });
  } finally { conn.release(); }
});

// Resolve emp_code → name (or 404). Used by the add-attendance grid for inline name display.
app.get('/api/employees/by-code', requireRole('admin','it-team'), async (req, res) => {
  try {
    const code = (req.query.code || '').trim();
    if (!code) return res.json({ rows: [] });
    const [rows] = await pool.query(
      `SELECT emp_code, CONCAT_WS(' ', first_name, last_name) AS name
       FROM employees_dp WHERE emp_code = ? AND deleted_at IS NULL LIMIT 1`, [code]);
    res.json({ row: rows[0] || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Lightweight employee lookup for the Add Record dialog. Searches emp_code or name.
app.get('/api/employees/search', requireRole('admin','it-team'), async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ rows: [] });
    const [rows] = await pool.query(
      `SELECT emp_code, CONCAT_WS(' ', first_name, last_name) AS name
       FROM employees_dp
       WHERE deleted_at IS NULL AND (emp_code LIKE ? OR first_name LIKE ? OR last_name LIKE ?)
       ORDER BY emp_code LIMIT 20`,
      [`%${q}%`, `%${q}%`, `%${q}%`]);
    res.json({ rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/audit', requireRole('viewer','editor','admin'), async (req, res) => {
  const { limit = 500, month } = req.query;
  const where = []; const params = [];
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    where.push("DATE_FORMAT(a.`date`, '%Y-%m') = ?"); params.push(month);
  }
  const sql = `SELECT l.*, a.\`date\` AS row_date, a.emp_code
    FROM att_audit_log l
    LEFT JOIN attendance_data a ON a.id = l.row_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY l.edited_at DESC LIMIT ?`;
  params.push(+limit);
  const [rows] = await pool.query(sql, params);
  res.json({ rows });
});
app.post('/api/audit/rollback', requireRole('admin'), async (req, res) => {
  const { batchId } = req.body || {};
  if (!batchId) return res.status(400).json({ error: 'batchId required' });
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [logs] = await conn.query(
      `SELECT * FROM att_audit_log WHERE batch_id=? AND rolled_back=0 ORDER BY id DESC`, [batchId]);
    for (const l of logs) {
      let restored = l.old_value;
      if (l.field === 'in_time' || l.field === 'out_time') {
        const [[row]] = await conn.query(
          `SELECT DATE_FORMAT(\`date\`,'%Y-%m-%d') AS d FROM attendance_data WHERE id=?`, [l.row_id]);
        restored = (row && l.old_value) ? `${row.d} ${l.old_value}` : null;
      }
      await conn.query(`UPDATE attendance_data SET \`${l.field}\`=? WHERE id=?`, [restored, l.row_id]);
      await conn.query(`UPDATE att_audit_log SET rolled_back=1 WHERE id=?`, [l.id]);
    }
    await conn.commit();
    res.json({ ok: true, reverted: logs.length });
  } catch (err) { await conn.rollback(); res.status(500).json({ error: err.message }); }
  finally { conn.release(); }
});

// User management (admin)
app.get('/api/users', requireRole('admin'), async (req, res) => {
  const [rows] = await pool.query(
    'SELECT id, username, full_name, role, active, created_at FROM att_users ORDER BY id');
  res.json({ rows });
});
app.post('/api/users', requireRole('admin'), async (req, res) => {
  const { username, password, full_name, role } = req.body || {};
  if (!username || !password || !['viewer','editor','admin'].includes(role))
    return res.status(400).json({ error: 'username, password, role required' });
  const hash = bcrypt.hashSync(password, 10);
  await pool.query(
    'INSERT INTO att_users (username, password_hash, full_name, role) VALUES (?,?,?,?)',
    [username, hash, full_name || null, role]);
  res.json({ ok: true });
});

(async () => {
  await detectEmployeeMaster();
  app.listen(PORT, () => console.log(`att_correction listening on http://localhost:${PORT}`));
})();
