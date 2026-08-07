const pg = require('pg');
const { Pool } = require('pg');
const { config } = require('../config');
const logger = require('../utils/logger');
const metrics = require('../monitoring/metrics');

// Keep the original string of dates/times returned by PostgreSQL.
// Otherwise node-postgres converts them to JS Date objects then ISO-8601 UTC
// (e.g. "2026-08-01 10:00" would become "2026-08-01T10:00:00.000Z", shifting
// the displayed time depending on the timezone).
pg.types.setTypeParser(1082, (v) => v); // DATE
pg.types.setTypeParser(1114, (v) => v); // TIMESTAMP
pg.types.setTypeParser(1184, (v) => v); // TIMESTAMPTZ
pg.types.setTypeParser(1700, (v) => parseFloat(v)); // NUMERIC
pg.types.setTypeParser(20, (v) => parseInt(v, 10)); // BIGINT (COUNT...) -> number

const pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: config.dbSsl ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: config.dbConnectionTimeoutMs,
    idleTimeoutMillis: config.dbIdleTimeoutMs,
    max: 10,
});

// Prevent the process from crashing when an idle client receives an error (e.g. DB restarted)
pool.on('error', (err) => {
    logger.error('db.pool_idle_error', { message: err.message });
});

/**
 * Run a simple query on the pool.
 * Mesure la durée d'exécution (métriques de performance Phase 6.2) :
 * la télémétrie ne doit JAMAIS altérer le comportement de la requête.
 * @param {string} text  Parameterized SQL
 * @param {Array} params
 */
async function query(text, params) {
    const startedAt = process.hrtime.bigint();
    try {
        return await pool.query(text, params);
    } finally {
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        try {
            metrics.recordSql(durationMs);
        } catch (e) {
            logger.error('metrics.sql_record_failed', { message: String((e && e.message) || e) });
        }
    }
}

/**
 * Run a function inside a PostgreSQL transaction.
 * The function receives a `client` (to pass to queries); COMMIT/ROLLBACK are handled here.
 *
 * @param {(client) => Promise<any>} fn
 * @returns {Promise<any>} the result returned by `fn`
 */
async function withTransaction(fn) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        try {
            await client.query('ROLLBACK');
        } catch (rollbackErr) {
            logger.error('db.rollback_failed', { message: rollbackErr.message });
        }
        throw err;
    } finally {
        client.release();
    }
}

module.exports = { pool, query, withTransaction };
