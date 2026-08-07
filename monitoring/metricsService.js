// ============================================================
// Asadiya Flotte PRO — Payload /api/metrics (Phase 6.2)
// ============================================================
// Construit la réponse JSON agrégée de GET /api/metrics :
//   - process   : mémoire, CPU, uptime, version Node
//   - requests  : nombre de requêtes, statuts, méthodes, durée moyenne, lentes
//   - errors    : erreurs HTTP (4xx/5xx)
//   - database  : disponibilité, pool, connexions actives, latence
//   - sql       : compteur SQL, durée moyenne, requêtes lentes
//   - business  : organisations, abonnements actifs, paiements du jour, échecs
//   - payments  : monitoring des paiements (statuts, fournisseurs, taux)
//
// Aucune donnée confidentielle. Tolérant aux pannes : si PostgreSQL est
// indisponible, les sections base de données renvoient `ok:false`/null et
// les métriques de processus restent disponibles.
// ============================================================
const metrics = require('./metrics');
const dbProbe = require('./dbProbe');
const paymentMonitor = require('./paymentMonitor');

/** Instantané complet de GET /api/metrics. */
async function buildMetrics() {
    const processInfo = metrics.processInfo();
    const m = metrics.snapshot();

    const [database, business, payments] = await Promise.all([
        dbProbe.databaseStats(),
        dbProbe.businessCounts(),
        paymentMonitor.snapshot(),
    ]);

    return {
        generatedAt: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development',
        process: processInfo,
        requests: m.requests,
        errors: m.errors,
        database,
        sql: m.sql,
        business,
        payments,
    };
}

module.exports = { buildMetrics };
