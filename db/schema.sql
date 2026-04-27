-- ============================================================
-- att_correction — production migration
-- Safe to re-run. Touches only:
--   1. NEW table  : att_users         (login accounts)
--   2. NEW table  : att_audit_log     (per-cell change history)
--   3. ALTER      : attendance_data + remarks VARCHAR(255) NULL
-- The existing employees_dp table is read-only to this app.
-- ============================================================

-- 1. App login accounts.
CREATE TABLE IF NOT EXISTS att_users (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  username      VARCHAR(64)  NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  full_name     VARCHAR(128),
  role          ENUM('viewer','editor','admin') NOT NULL DEFAULT 'viewer',
  active        TINYINT(1)   NOT NULL DEFAULT 1,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
-- After running this script, create the first admin via:
--   node scripts/reset-admin.js <strong-password>

-- 2. Per-cell audit log. Every Save click writes one row per changed cell,
--    all sharing the same batch_id so admins can rollback the batch atomically.
CREATE TABLE IF NOT EXISTS att_audit_log (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  row_id         BIGINT       NOT NULL,           -- attendance_data.id
  field          VARCHAR(64)  NOT NULL,           -- in_time | out_time | remarks
  old_value      VARCHAR(64),
  new_value      VARCHAR(64),
  edited_by      INT          NOT NULL,           -- att_users.id
  edited_by_name VARCHAR(128),
  edited_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  batch_id       VARCHAR(40)  NOT NULL,
  rolled_back    TINYINT(1)   NOT NULL DEFAULT 0,
  INDEX idx_row       (row_id),
  INDEX idx_batch     (batch_id),
  INDEX idx_edited_at (edited_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 3. Add remarks to attendance_data, only if not already there.
--    (Avoids the MySQL <8.0.29 lack of "ALTER TABLE ... ADD COLUMN IF NOT EXISTS".)
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name   = 'attendance_data'
    AND column_name  = 'remarks'
);
SET @ddl := IF(@col_exists = 0,
  'ALTER TABLE attendance_data ADD COLUMN remarks VARCHAR(255) NULL AFTER working_hrs',
  'SELECT "remarks column already present"');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ============================================================
-- Required app DB-user grants (run as a privileged user once):
--
--   GRANT SELECT, UPDATE                         ON dp_sync.attendance_data TO 'att_app'@'%';
--   GRANT SELECT                                 ON dp_sync.employees_dp    TO 'att_app'@'%';
--   GRANT SELECT, INSERT, UPDATE, DELETE         ON dp_sync.att_users       TO 'att_app'@'%';
--   GRANT SELECT, INSERT, UPDATE                 ON dp_sync.att_audit_log   TO 'att_app'@'%';
--   FLUSH PRIVILEGES;
-- ============================================================
