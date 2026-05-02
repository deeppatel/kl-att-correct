// Idempotent: creates emp_audit_log if missing.
require('dotenv').config();
const mysql = require('mysql2/promise');
(async () => {
  const c = await mysql.createConnection({
    host: process.env.DB_HOST, port: +process.env.DB_PORT || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  });
  await c.query(`
    CREATE TABLE IF NOT EXISTS emp_audit_log (
      id             BIGINT AUTO_INCREMENT PRIMARY KEY,
      emp_id         BIGINT       NOT NULL,
      emp_code       VARCHAR(20),
      field          VARCHAR(64)  NOT NULL,
      old_value      VARCHAR(64),
      new_value      VARCHAR(64),
      edited_by      INT          NOT NULL,
      edited_by_name VARCHAR(128),
      edited_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      batch_id       VARCHAR(40)  NOT NULL,
      rolled_back    TINYINT(1)   NOT NULL DEFAULT 0,
      INDEX idx_emp       (emp_id),
      INDEX idx_batch     (batch_id),
      INDEX idx_edited_at (edited_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  console.log('emp_audit_log ready');
  await c.end();
})().catch(e => { console.error(e); process.exit(1); });
