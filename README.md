# Attendance Correction

Lightweight Excel-like web tool for editing the monthly punch summary directly in the live database. Stack: Node.js + Express + MySQL + Handsontable. No build step. Designed to run on a single LAN PC and connect to a remote MySQL server.

## 1. Install

```bash
npm install
cp .env.example .env   # then edit credentials & column names
```

## 2. Set up DB tables

Run `db/schema.sql` against your MySQL database. It creates:

- `att_users` — login accounts (viewer/editor/admin)
- `att_audit_log` — every cell edit, grouped per Save batch (used for rollback)

A default admin is seeded: **admin / admin123**. Change it immediately by adding a new admin via `POST /api/users` (see below) and disabling the seed.

## 3. Map your real punch table

The app reads/writes one source table whose name and columns are declared in `.env`:

```
SRC_TABLE=attendance_punch_summary
COL_ID=id              # primary key
COL_EMP_ID=employee_id
COL_EMP_NAME=employee_name
COL_DATE=att_date
COL_IN=in_time         # editable
COL_OUT=out_time       # editable
COL_STATUS=status
```

Only `in_time` and `out_time` are editable. All other columns are read-only by design.

## 4. Run

```bash
npm start          # http://localhost:3000
```

Bind on all interfaces for LAN access — Node listens on `0.0.0.0` by default. Open `http://<this-pc-ip>:3000` from any PC on the network.

To run as a Windows service, use [nssm](https://nssm.cc/) or `pm2-windows-service`.

## Features

- Excel-like grid (Handsontable): keyboard nav, copy/paste from Excel, fill handle, sort, column-menu filter
- Month / employee / status filters
- Inline editing with time-format and `out > in` validation
- Edited cells highlighted yellow; missing punches highlighted red
- Batch save in a single transaction; full audit log per Save click
- Admin one-click rollback per batch
- Roles: viewer (read), editor (edit/save), admin (rollback + user mgmt)

## API quick reference

| Method | Path | Role |
|---|---|---|
| POST | `/api/login` `{username,password}` | — |
| POST | `/api/logout` | any |
| GET  | `/api/attendance?month=YYYY-MM&employee=&status=` | viewer+ |
| POST | `/api/attendance/save` `{edits:[{id,field,oldValue,newValue}]}` | editor+ |
| GET  | `/api/audit?limit=200` | viewer+ |
| POST | `/api/audit/rollback` `{batchId}` | admin |
| GET/POST | `/api/users` | admin |

## Performance notes

- Default page size is 5000 rows, returned in one shot — Handsontable virtual-scrolls these comfortably.
- For >20k rows raise `limit`/`offset` into pagination on the client, or filter by employee.
- `att_audit_log` is indexed on `row_id`, `batch_id`, `edited_at`.

## Security notes

- Sessions are HTTP-only cookies; set a long random `SESSION_SECRET` in `.env`.
- Put the app behind HTTPS (e.g. Caddy or IIS reverse proxy) if traffic leaves the LAN.
- The DB user only needs `SELECT, UPDATE` on the punch table and full rights on `att_users` / `att_audit_log`.

## Roadmap (optional)

- Export to Excel (`/api/attendance.xlsx`) — easy add via `exceljs`.
- Auto-suggest common in/out times per employee from rolling 30-day median.
- Postgres support — swap `mysql2` for `pg` and adjust the two `DATE_FORMAT` calls.
