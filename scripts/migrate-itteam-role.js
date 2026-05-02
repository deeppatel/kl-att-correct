// Idempotent: extends att_users.role enum to include 'it-team'.
require('dotenv').config();
const mysql = require('mysql2/promise');
(async () => {
  const c = await mysql.createConnection({
    host: process.env.DB_HOST, port: +process.env.DB_PORT || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  });
  const [r] = await c.query(
    `SELECT COLUMN_TYPE AS t FROM information_schema.columns
     WHERE table_schema = ? AND table_name = 'att_users' AND column_name = 'role'`,
    [process.env.DB_NAME]);
  const cur = r[0]?.t || '';
  if (cur.includes("'it-team'")) console.log('role enum already has it-team');
  else {
    await c.query(
      `ALTER TABLE att_users MODIFY COLUMN role
       ENUM('viewer','editor','admin','it-team') NOT NULL DEFAULT 'viewer'`);
    console.log('added it-team to role enum');
  }
  await c.end();
})().catch(e => { console.error(e); process.exit(1); });
