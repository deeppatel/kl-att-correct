// Lists tables in DB_NAME and, if a table arg is given, its columns + sample row.
require('dotenv').config();
const mysql = require('mysql2/promise');
(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST, port: +process.env.DB_PORT || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  });
  const target = process.argv[2];
  if (!target) {
    const [t] = await conn.query('SHOW TABLES');
    console.log('Tables in', process.env.DB_NAME);
    t.forEach(r => console.log(' -', Object.values(r)[0]));
  } else {
    const [cols] = await conn.query(`SHOW COLUMNS FROM \`${target}\``);
    console.log(`Columns in ${target}:`);
    cols.forEach(c => console.log(`  ${c.Field}\t${c.Type}\t${c.Null}\t${c.Key}`));
    const [sample] = await conn.query(`SELECT * FROM \`${target}\` LIMIT 1`);
    console.log('\nSample row:', sample[0] || '(empty)');
    const [count] = await conn.query(`SELECT COUNT(*) AS n FROM \`${target}\``);
    console.log('Row count:', count[0].n);
  }
  await conn.end();
})().catch(e => { console.error(e.message); process.exit(1); });
