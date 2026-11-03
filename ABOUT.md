# About this project

## Why it exists

Every month, the HR team used to:

1. Export a "punch summary" from the biometric/attendance database into Excel.
2. Manually fix wrong or missing **In Time** / **Out Time** entries, add remarks.
3. Compare the corrected sheet against the original, line by line.
4. Push the corrections back into the database.

The round-trip was slow, error-prone, and left no audit trail — a mis-entered time
could silently propagate to payroll with nothing recording who changed what, when,
or why.

This tool replaces that workflow with a web app that edits `attendance_data`
**directly on the live database**, in an interface that feels like Excel but
behaves like a controlled system of record.

## What it does

### For HR (correction grid)

- Loads a month of attendance in an Excel-style spreadsheet (Handsontable).
- Edit In Time, Out Time, and Remarks inline. Everything else is read-only.
- Validates on the fly: time format, Out > In, and the editable-window rule
  (current month always; previous month only during days 1–7 for payroll
  cut-off).
- Highlights edited cells and missing-punch anomalies.
- Auto-saves a draft to the browser every 30 s — a refresh or crash doesn't
  lose work.
- **Save Changes** commits the whole batch in a single DB transaction and
  recomputes `duration` from the new times.

### For IT Ops (add + employee master)

- **Add Attendance** page: paste or type dozens of new rows at once. Looks up
  the employee from `employees_dp` by `emp_code`, auto-fills the name, and
  inserts into `attendance_data`.
  - If a row already exists for that `(emp_code, date)`:
    - Existing row has **both in_time and out_time NULL** (biometric sync
      skeleton) → update it (audited).
    - Existing row has data **and** the employee's DOJ is in the **same month**
      as the attendance → update it (audited).
    - Otherwise → skipped, reason returned to the user and appended to
      `logs/skipped-creates.log`. Protects HR corrections from accidental
      overwrites.
- **Update DOJ** page: edit the DOJ column of `employees_dp` directly in a
  spreadsheet view. Audited in a separate table so attendance and
  employee-master changes stay in their own histories.

### For everyone (reports & audit)

- Every cell change writes a row to `att_audit_log` (attendance) or
  `emp_audit_log` (employee master), grouped by a per-save `batch_id`.
- **Audit modal** on each editing page lists batches with who/when/old/new.
  Admins can **Rollback** a whole batch in one click.
- **Changes Report** page: tabular report of every attendance edit — emp code,
  name, date, old/new In/Out, old/new duration, who changed it, when. Filter
  by month or employee, export to CSV.

## How roles map to pages

| Role      | `/` Correction grid     | `/add-attendance`       | `/update-doj`     | `/changes-report` |
| --------- | ----------------------- | ----------------------- | ----------------- | ----------------- |
| `viewer`  | read-only               | —                       | —                 | ✓ (read)          |
| `editor`  | edit + save             | —                       | —                 | ✓ (read)          |
| `admin`   | full + **rollback**     | full                    | full + rollback   | ✓                 |
| `it-team` | —                       | full                    | full              | ✓                 |

Login auto-redirects a user to the first page they can access.

## Data flow

```
Browser (Handsontable)
    │  JSON over fetch (session cookie)
    ▼
Express server (server.js)   ← .env (DB creds, PORT)
    │  mysql2/promise
    ▼
MySQL (dp_sync)
    ├─ attendance_data        ← source of truth, edited in place
    ├─ employees_dp           ← employee master, joined by emp_code
    ├─ att_users              ← app-owned: login accounts
    ├─ att_audit_log          ← app-owned: attendance change history
    └─ emp_audit_log          ← app-owned: employee-master change history
```

- The app writes nothing to `attendance_data` or `employees_dp` outside of
  the explicit save endpoints — all mutations go through audited paths.
- Every save runs inside a single MySQL transaction. One bad row aborts the
  whole batch; nothing is partially written.
- The source table keeps its primary key stable (`attendance_data.id`), so
  downstream payroll references never break.

## Design principles

- **Feel like Excel** — keyboard nav, copy-paste from spreadsheets, inline
  edit, column filters, fill handle.
- **Enforce rules server-side** — editable window, role gates, duplicate
  handling, and format validation all run on the backend. The UI is a
  convenience layer; a tampered client can't bypass them.
- **Every write is auditable** — nothing is updated without a corresponding
  audit entry, and admins can roll back any batch.
- **Minimal footprint** — Node.js + Express + static HTML + Handsontable. No
  build step, no framework runtime, no bundler. Designed to run on a single
  LAN PC and connect to the remote production MySQL.

## Where to go next

- [`README.md`](README.md) — install, run, user management, firewall, roles.
- [`db/schema.sql`](db/schema.sql) — the complete, idempotent production
  migration for the app-owned tables plus the single `remarks` column
  added to `attendance_data`.
- [`server.js`](server.js) — single-file backend, every endpoint in one
  place.
- [`public/`](public/) — one HTML + JS file per page; shared `styles.css`.
