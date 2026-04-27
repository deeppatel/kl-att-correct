// Usage: node scripts/reset-admin.js [newPassword]
// Resets (or creates) the 'admin' user with the given password. Default: admin123.
require('dotenv').config();
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');

(async () => {
  const pwd = process.argv[2] || 'admin123';
  const hash = bcrypt.hashSync(pwd, 10);
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST, port: +process.env.DB_PORT || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  });
  const [r] = await conn.query(
    `INSERT INTO att_users (username, password_hash, full_name, role, active)
     VALUES ('admin', ?, 'Administrator', 'admin', 1)
     ON DUPLICATE KEY UPDATE password_hash=VALUES(password_hash), active=1, role='admin'`,
    [hash]);
  console.log(`OK. admin password set to: ${pwd}`);
  await conn.end();
})().catch(e => { console.error(e); process.exit(1); });
