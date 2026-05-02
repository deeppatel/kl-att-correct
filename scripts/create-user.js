// Usage: node scripts/create-user.js <username> <password> <role> [full_name]
//   role: viewer | editor | admin | it-team
require('dotenv').config();
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');

(async () => {
  const [, , username, password, role, ...nameParts] = process.argv;
  const full_name = nameParts.join(' ') || null;
  const valid = ['viewer','editor','admin','it-team'];
  if (!username || !password || !valid.includes(role)) {
    console.error(`Usage: node scripts/create-user.js <username> <password> <role> [full_name]\n  role one of: ${valid.join(', ')}`);
    process.exit(2);
  }
  const hash = bcrypt.hashSync(password, 10);
  const c = await mysql.createConnection({
    host: process.env.DB_HOST, port: +process.env.DB_PORT || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  });
  await c.query(
    `INSERT INTO att_users (username, password_hash, full_name, role, active)
     VALUES (?, ?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE password_hash=VALUES(password_hash), full_name=VALUES(full_name), role=VALUES(role), active=1`,
    [username, hash, full_name, role]);
  console.log(`OK. user '${username}' set with role '${role}'`);
  await c.end();
})().catch(e => { console.error(e); process.exit(1); });
