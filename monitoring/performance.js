// ============================================================
// Asadiya Flotte PRO — Performance (Phase 6.2)
// ============================================================
// - Mesure des durées de requêtes HTTP et SQL (alimentées par
//   middleware/requestContext + db/pool.js via monitoring/metrics.js).
// - Détection des requêtes lentes (> 500 ms par défaut) : compteur + liste
//   bornée + log d'avertissement.
// - Rapport automatique périodique (journalisé, léger, aucun secret).
// ============================================================
const metrics = require('./metrics');
const logger = require('../utils/logger');

/**
 * Génère un rapport de performance structuré (sans I/O bloquante).
 * Combinaison des compteurs en mémoire et de l'état du processus.
 */
function generateReport() {
    const m = metrics.snapshot();
    const p = metrics.processInfo();
    return {
        generatedAt: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development',
        uptime: p.uptime,
        process: p,
        requests: m.requests,
        errors: m.errors,
        sql: m.sql,
    };
}

/**
 * Démarre le rapport périodique automatique.
 * @param {{intervalMs: number}} opts intervalle (ms) ; <= 0 = désactivé.
 * @returns {() => void} fonction d'arrêt (clearInterval).
 */
function startPerformanceReporter({ intervalMs = 0 } = {}) {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
        return () => {};
    }
    const timer = setInterval(async () => {
        try {
            const report = generateReport();
            logger.info('perf.report', report);
        } catch (err) {
            logger.error('perf.report_failed', {
                message: err && err.message ? err.message : String(err),
            });
        }
    }, intervalMs);
    // Ne maintient pas le processus en vie à lui seul (démarrage serveur).
    timer.unref();
    return () => clearInterval(timer);
}

module.exports = { generateReport, startPerformanceReporter };
