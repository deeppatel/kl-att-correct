// Idempotent: adds attendance_data.remarks if missing.
require('dotenv').config();
const mysql = require('mysql2/promise');
(async () => {
  const c = await mysql.createConnection({
    host: process.env.DB_HOST, port: +process.env.DB_PORT || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  });
  const [r] = await c.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
     WHERE table_schema = ? AND table_name = 'attendance_data' AND column_name = 'remarks'`,
    [process.env.DB_NAME]);
  if (r[0].n) console.log('remarks column already present — nothing to do');
  else {
    await c.query(`ALTER TABLE attendance_data ADD COLUMN remarks VARCHAR(255) NULL AFTER working_hrs`);
    console.log('added remarks VARCHAR(255) NULL');
  }
  await c.end();
})().catch(e => { console.error(e); process.exit(1); });
