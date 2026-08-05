const { pool } = require('./db/pool');
const { SCHEMA } = require('./db/migrate');
(async () => {
    try {
        await pool.query(SCHEMA);
        console.log('SCHEMA OK');
    } catch (e) {
        console.error('SCHEMA FAILED:', e.message);
    }
    const t = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name");
    console.log('tables:', t.rows.map(r => r.table_name).join(', '));
    await pool.end();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
