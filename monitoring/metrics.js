// ============================================================
// Asadiya Flotte PRO — Stockage en mémoire des métriques (Phase 6.2)
// ============================================================
// Compteurs légers et synchrones, alimentés par les middlewares
// (requestContext / logger.requestLogger) et par l'instrumentation SQL
// (db/pool.js). Aucune dépendance externe, aucune I/O : un appel ne peut
// jamais échouer à cause de la télémétrie.
//
// Aucune donnée confidentielle n'est conservée : uniquement des compteurs
// et des durées agrégées. Les listes « récentes » (requêtes/sql lents)
// sont bornées et ne contiennent ni corps, ni en-têtes, ni secrets.
// ============================================================
const os = require('os');

// Seuils configurables (défauts : 500 ms pour une requête, 1000 ms pour SQL).
const SLOW_REQUEST_THRESHOLD_MS = parseInt(process.env.SLOW_REQUEST_THRESHOLD_MS || '500', 10);
const SLOW_SQL_THRESHOLD_MS = parseInt(process.env.SLOW_SQL_THRESHOLD_MS || '1000', 10);
const RECENT_LIMIT = 20;

const state = {
    startedAt: Date.now(),
    requests: {
        total: 0,
        byStatus: {},       // { '200': n, '404': n, ... }
        byMethod: {},       // { GET: n, POST: n, ... }
        totalDurationMs: 0,
        slowCount: 0,
        recentSlow: [],     // borné, sans données sensibles
    },
    errors: {
        total: 0,
        byStatus: {},
    },
    sql: {
        total: 0,
        totalDurationMs: 0,
        slowCount: 0,
        recentSlow: [],
    },
};

function round2(n) {
    return Math.round(n * 100) / 100;
}

/** Borne une liste de « récents » pour éviter une croissance sans fin. */
function pushBounded(list, entry) {
    list.push(entry);
    if (list.length > RECENT_LIMIT) list.shift();
}

/**
 * Enregistre une requête HTTP terminée.
 * @param {{method: string, path: string, status: number, durationMs: number}} info
 */
function recordRequest({ method, status, durationMs, path: reqPath }) {
    const m = String(method || '').toUpperCase() || 'UNKNOWN';
    const s = status || 0;

    state.requests.total += 1;
    state.requests.byMethod[m] = (state.requests.byMethod[m] || 0) + 1;
    state.requests.byStatus[s] = (state.requests.byStatus[s] || 0) + 1;
    state.requests.totalDurationMs += durationMs || 0;

    if ((durationMs || 0) >= SLOW_REQUEST_THRESHOLD_MS) {
        state.requests.slowCount += 1;
        pushBounded(state.requests.recentSlow, {
            ts: new Date().toISOString(),
            method: m,
            path: String(reqPath || ''),
            status: s,
            durationMs: round2(durationMs),
        });
    }

    if (s >= 400) recordError(s);
}

/** Enregistre une erreur HTTP (4xx/5xx), ventilée par code de statut. */
function recordError(status) {
    const s = status || 0;
    state.errors.total += 1;
    state.errors.byStatus[s] = (state.errors.byStatus[s] || 0) + 1;
}

/** Enregistre la durée d'une requête SQL (db/pool.js). */
function recordSql(durationMs) {
    state.sql.total += 1;
    state.sql.totalDurationMs += durationMs || 0;
    if ((durationMs || 0) >= SLOW_SQL_THRESHOLD_MS) {
        state.sql.slowCount += 1;
        pushBounded(state.sql.recentSlow, {
            ts: new Date().toISOString(),
            durationMs: round2(durationMs),
        });
    }
}

/** État process courant (mémoire, CPU) — lecture seule. */
function processInfo() {
    const mem = process.memoryUsage();
    const cpu = process.cpuUsage();
    return {
        pid: process.pid,
        node: process.version,
        startedAt: new Date(state.startedAt).toISOString(),
        uptime: round2(process.uptime()),
        memory: {
            rss: mem.rss,
            heapUsed: mem.heapUsed,
            heapTotal: mem.heapTotal,
            external: mem.external,
            arrayBuffers: mem.arrayBuffers,
        },
        cpu: {
            userMs: round2(cpu.user / 1000),
            systemMs: round2(cpu.system / 1000),
            cores: os.cpus().length,
            loadavg: os.loadavg(),
        },
    };
}

/** Instantané JSON-sérialisable de tous les compteurs (aucun secret). */
function snapshot() {
    const r = state.requests;
    return {
        startedAt: new Date(state.startedAt).toISOString(),
        thresholds: {
            slowRequestMs: SLOW_REQUEST_THRESHOLD_MS,
            slowSqlMs: SLOW_SQL_THRESHOLD_MS,
        },
        requests: {
            total: r.total,
            byStatus: { ...r.byStatus },
            byMethod: { ...r.byMethod },
            avgDurationMs: r.total > 0 ? round2(r.totalDurationMs / r.total) : 0,
            slowCount: r.slowCount,
            recentSlow: r.recentSlow.map((e) => ({ ...e })),
        },
        errors: {
            total: state.errors.total,
            byStatus: { ...state.errors.byStatus },
        },
        sql: {
            total: state.sql.total,
            avgDurationMs: state.sql.total > 0 ? round2(state.sql.totalDurationMs / state.sql.total) : 0,
            slowCount: state.sql.slowCount,
            recentSlow: state.sql.recentSlow.map((e) => ({ ...e })),
        },
    };
}

module.exports = {
    recordRequest,
    recordError,
    recordSql,
    processInfo,
    snapshot,
    SLOW_REQUEST_THRESHOLD_MS,
    SLOW_SQL_THRESHOLD_MS,
};
