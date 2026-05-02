# Attendance Correction

Lightweight web tool for editing the live `attendance_data` table directly, plus a multi-row "Add Record" page for the IT team. Replaces the monthly Excel export / reimport workflow.

Stack: Node.js + Express + MySQL + Handsontable (no build step). Designed to run on a single LAN PC and connect to a remote MySQL server.

---

## 1. First-time setup

### Install Node deps

```bash
npm install
```

### Configure

```bash
cp .env.example .env
```

Edit `.env`:

```
PORT=49223
SESSION_SECRET=<long random string — change this>
DB_HOST=<prod-mysql-host>
DB_PORT=3306
DB_USER=att_app
DB_PASSWORD=<password>
DB_NAME=dp_sync
```

### Apply DB migration

```bash
mysql -h <DB_HOST> -u <admin_user> -p <DB_NAME> < db/schema.sql
```

Idempotent — safe to re-run. It creates `att_users`, `att_audit_log`, adds `attendance_data.remarks`, and ensures the role enum has `it-team`.

### Create the first admin

```bash
node scripts/reset-admin.js 'StrongAdminPw#2026'
```

---

## 2. Start the server

### Manual

```bash
npm start
```

Or double-click `dp_start.bat` on Windows.

### As a Windows service (recommended for production)

Use [nssm](https://nssm.cc/) so it restarts on crash and starts on boot:

```
nssm install att_correction "C:\Program Files\nodejs\node.exe" "C:\DEEP_NEW\P\katlax\att_correction\server.js"
nssm set    att_correction AppDirectory "C:\DEEP_NEW\P\katlax\att_correction"
nssm start  att_correction
```

---

## 3. Open in the browser

| URL                          | Who        | What                                                     |
| ---------------------------- | ---------- | -------------------------------------------------------- |
| `http://<host>:49223/`                | viewer / editor / admin | Excel-like correction grid for `attendance_data`        |
| `http://<host>:49223/add-attendance` | admin / it-team         | Multi-row Add Record grid (insert / update missing rows) |

After login the app auto-redirects users to whichever page they have access to.

### LAN access

Find this PC's IP:
```powershell
ipconfig | findstr IPv4
```

Open the firewall port once (admin PowerShell):
```powershell
New-NetFirewallRule -DisplayName "att_correction 49223" -Direction Inbound -Protocol TCP -LocalPort 49223 -Action Allow -Profile Private,Domain
```

The active network must be set to **Private** (Settings → Network → profile = Private), otherwise the rule won't apply.

Other PCs then hit `http://<lan-ip>:49223`.

---

## 4. Manage users

```bash
# Create or overwrite any user (idempotent on username)
node scripts/create-user.js <username> <password> <role> [full_name]

# Reset just the admin
node scripts/reset-admin.js 'NewAdminPw'
```

### Roles

| Role      | Correction grid (`/`) | Add Record (`/add-attendance`) | Audit / Rollback     |
| --------- | --------------------- | ------------------------------ | -------------------- |
| `viewer`  | read-only             | —                              | view audit only      |
| `editor`  | edit + save           | —                              | view audit only      |
| `admin`   | full                  | full                           | view + **rollback**  |
| `it-team` | —                     | full                           | —                    |

### Examples

```bash
node scripts/create-user.js admin   'StrongAdminPw#2026'  admin   "Administrator"
node scripts/create-user.js itops   'ItPw!2025'           it-team "IT Operations"
node scripts/create-user.js hr1     'HrPw@2025'           editor  "HR Maker"
node scripts/create-user.js audit1  'AuditPw#2025'        viewer  "Auditor"
```

---

## 5. How it works

### Editable window

- The **current month** is always editable.
- The **previous month** is editable only on days **1–7** of the current month (so corrections can finish for payroll cut-off).
- Other months are read-only — gated both client-side (UI banner, locked columns) and server-side (rejected at `/api/attendance/save`).

### Save flow (correction grid)

- Edits are auto-drafted to `localStorage` every 30s — survives reload, prompted to restore on next Load.
- **Save Changes** opens a confirm dialog, then commits the whole batch in a single MySQL transaction. Each cell change inserts one row in `att_audit_log` sharing a common `batch_id`.
- **Discard** wipes both the in-memory edits and the saved draft.

### Add Record flow (`/add-attendance`)

- Multi-row Excel-like grid; paste from Excel works.
- `emp_code` is required; **Name** auto-fills from `employees_dp` once a valid code is entered.
- For each filled row, server checks for an existing `(emp_code, date)` row:
  - **No existing row** → INSERT.
  - **Existing row + employee `doj` is in the same `YYYY-MM`** → UPDATE in_time/out_time/remarks (audited per field).
  - **Existing row + DOJ in a different month or NULL** → skip; reason returned in the response and appended to `logs/skipped-creates.log`.

### Audit & rollback

Audit modal shows entries grouped by `batch_id`, filtered to the selected month. Admins see a **Rollback** button per batch — one click reverts every cell in that batch to its `old_value` and marks the entries `rolled_back=1`.

---

## 6. Database changes this app introduces

Tables created (only these — `attendance_data` and `employees_dp` keep all their original columns):

- `att_users` — login accounts
- `att_audit_log` — per-cell change history with batch IDs

Single `attendance_data` schema change:
- `remarks VARCHAR(255) NULL` (added if missing)

See [`db/schema.sql`](db/schema.sql) for the exact migration.

### Required DB grants

```sql
GRANT SELECT, INSERT, UPDATE       ON dp_sync.attendance_data TO 'att_app'@'%';
GRANT SELECT                       ON dp_sync.employees_dp    TO 'att_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON dp_sync.att_users     TO 'att_app'@'%';
GRANT SELECT, INSERT, UPDATE       ON dp_sync.att_audit_log   TO 'att_app'@'%';
FLUSH PRIVILEGES;
```

---

## 7. Layout

```
att_correction/
├── server.js                      Express + MySQL backend
├── public/
│   ├── index.html / app.js        Correction grid (admin/editor/viewer)
│   ├── add-attendance.html / .js  Add Record grid (admin/it-team)
│   └── styles.css
├── db/schema.sql                  Idempotent production migration
├── scripts/
│   ├── reset-admin.js             Reset/create the admin user
│   ├── create-user.js             Create or overwrite any user
│   ├── inspect-db.js              Show tables / columns of the configured DB
│   ├── migrate-remarks.js         (Already in schema.sql) standalone
│   └── migrate-itteam-role.js     (Already in schema.sql) standalone
├── logs/                          skipped-creates.log written here (gitignored)
├── .env.example
└── dp_start.bat                   Windows launcher
```

---

## 8. Troubleshooting

| Symptom                                         | Fix                                                                                          |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `EADDRINUSE` on port 49223                      | Another process holds it. `Get-NetTCPConnection -LocalPort 49223` to find PID, stop it.      |
| `Invalid credentials` right after a fresh DB    | Run `node scripts/reset-admin.js <pw>` — the schema doesn't seed a default admin.            |
| `Table 'dp_sync.att_users' doesn't exist`       | Apply `db/schema.sql`.                                                                       |
| Can't reach from another LAN PC                 | Firewall: see §3. Also confirm network profile is Private, not Public.                       |
| Browser shows stale UI after a code change      | Hard-refresh: **Ctrl + F5**.                                                                 |
| `Row N is outside the editable window`          | The month is read-only by design (see §5 → Editable window). Wait or use admin override.    |
