const { pool } = require('./db/pool');
(async () => {
    const cols = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='subscriptions' ORDER BY ordinal_position");
    console.log('subs cols:', cols.rows.map(r => r.column_name).join(', '));
    const t = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name");
    console.log('tables:', t.rows.map(r => r.table_name).join(', '));
    const p = await pool.query('SELECT id, code, name, monthly_price, max_vehicles, max_users FROM plans ORDER BY id');
    console.log('plans:', JSON.stringify(p.rows, null, 0));
    await pool.end();
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
