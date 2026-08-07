// ============================================================
// Asadiya Flotte PRO — Sondes base de données (Phase 6.2)
// ============================================================
// Sondes LECTURE SEULE pour la supervision (health / metrics).
// Toutes les fonctions sont tolérantes aux pannes : en cas d'échec elles
// renvoient un objet `{ ok: false }` ou `null` — jamais d'exception — afin
// que les endpoints de supervision répondent même si PostgreSQL est tombé.
// Aucune donnée métier n'est renvoyée : uniquement des compteurs agrégés.
// ============================================================
const { query, pool } = require('../db/pool');

function num(v) {
    return parseInt(v, 10) || 0;
}

function round2(n) {
    return Math.round(n * 100) / 100;
}

/** Ping minimal : SELECT 1 + latence mesurée (ms). */
async function ping() {
    const startedAt = process.hrtime.bigint();
    try {
        await query('SELECT 1');
        const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        return { ok: true, latencyMs: round2(latencyMs) };
    } catch {
        return { ok: false, latencyMs: null };
    }
}

/** État du pool de connexions node-postgres. */
async function poolStats() {
    try {
        return {
            total: pool.totalCount,
            idle: pool.idleCount,
            waiting: pool.waitingCount,
        };
    } catch {
        return null;
    }
}

/** Nombre de connexions actives sur la base courante (pg_stat_activity). */
async function activeConnections() {
    try {
        const { rows } = await query(
            'SELECT COUNT(*) AS count FROM pg_stat_activity WHERE datname = current_database()'
        );
        return num(rows[0].count);
    } catch {
        return null;
    }
}

/**
 * Compteurs métier agrégés (aucune donnée nominative).
 * - organizations        : nombre total d'organisations
 * - activeSubscriptions  : abonnements ACTIVE + TRIAL (non échus / non résiliés)
 * - paymentsToday        : transactions de paiement créées aujourd'hui
 * - failedTransactions   : transactions en échec terminal (FAILED ou EXPIRED)
 */
async function businessCounts() {
    try {
        const [o, s, pt, ft] = await Promise.all([
            query('SELECT COUNT(*) AS count FROM organizations'),
            query(
                "SELECT COUNT(*) AS count FROM subscriptions WHERE status IN ('ACTIVE', 'TRIAL')"
            ),
            query(
                "SELECT COUNT(*) AS count FROM payment_transactions WHERE created_at::date = CURRENT_DATE"
            ),
            query(
                "SELECT COUNT(*) AS count FROM payment_transactions WHERE status IN ('FAILED', 'EXPIRED')"
            ),
        ]);
        return {
            organizations: num(o.rows[0].count),
            activeSubscriptions: num(s.rows[0].count),
            paymentsToday: num(pt.rows[0].count),
            failedTransactions: num(ft.rows[0].count),
        };
    } catch {
        return null;
    }
}

/** Statistiques agrégées base de données pour /api/metrics. */
async function databaseStats() {
    try {
        const pingResult = await ping();
        const poolS = await poolStats();
        const conns = await activeConnections();
        return {
            ok: pingResult.ok,
            latencyMs: pingResult.latencyMs,
            pool: poolS,
            activeConnections: conns,
        };
    } catch {
        return { ok: false, latencyMs: null, pool: null, activeConnections: null };
    }
}

module.exports = {
    ping,
    poolStats,
    activeConnections,
    businessCounts,
    databaseStats,
};
