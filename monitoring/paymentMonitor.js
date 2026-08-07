// ============================================================
// Asadiya Flotte PRO — Monitoring des paiements (Phase 6.2)
// ============================================================
// Module INDÉPENDANT de supervision des paiements (lecture seule).
// Il agrège les transactions de payment_transactions :
//   - comptage par statut (SUCCESS, FAILED, PENDING, REFUNDED, CANCELLED,
//     CREATED, PROCESSING, EXPIRED)
//   - ventilation par fournisseur (wave, orange_money, stripe, mock)
//   - taux de succès
//   - temps moyen de traitement (initiation -> état terminal)
//   - erreurs par fournisseur
//   - activité du jour
//
// Aucune modification d'écriture, aucun appel aux fournisseurs, aucun secret.
// Tolérant aux pannes : renvoie `null` si la base est indisponible.
// ============================================================
const { query } = require('../db/pool');

const TERMINAL_FAILURE = ['FAILED', 'EXPIRED'];

function num(v) {
    return parseInt(v, 10) || 0;
}

function round2(n) {
    return Math.round(n * 100) / 100;
}

function round4(n) {
    return Math.round(n * 10000) / 10000;
}

/** Nombre total de transactions de paiement. */
async function countTotal() {
    const { rows } = await query('SELECT COUNT(*) AS count FROM payment_transactions');
    return num(rows[0].count);
}

/** Répartition par statut (tous fournisseurs confondus). */
async function countByStatus() {
    const { rows } = await query(
        'SELECT status, COUNT(*) AS count FROM payment_transactions GROUP BY status'
    );
    const out = {};
    for (const r of rows) out[r.status] = num(r.count);
    return out;
}

/** Répartition par (fournisseur, statut) — liste brute de lignes. */
async function countByProviderStatus() {
    const { rows } = await query(
        'SELECT provider, status, COUNT(*) AS count FROM payment_transactions GROUP BY provider, status'
    );
    return rows.map((r) => ({ provider: r.provider, status: r.status, count: num(r.count) }));
}

/**
 * Temps moyen de traitement (ms) : écart entre initiated_at et
 * completed_at sur les transactions parvenues à un état terminal.
 */
async function avgProcessingTimeMs() {
    const { rows } = await query(
        `SELECT AVG(EXTRACT(EPOCH FROM (completed_at - initiated_at)) * 1000) AS avg_ms
         FROM payment_transactions
         WHERE initiated_at IS NOT NULL AND completed_at IS NOT NULL`
    );
    const value = rows[0] ? rows[0].avg_ms : null;
    return value === null || value === undefined ? 0 : round2(value);
}

/** Activité du jour : total, réussies, échouées (sur CURRENT_DATE). */
async function todayCounts() {
    const { rows } = await query(
        `SELECT
            COUNT(*) AS total,
            COUNT(*) FILTER (WHERE status = 'SUCCESS') AS succeeded,
            COUNT(*) FILTER (WHERE status IN ('FAILED', 'EXPIRED')) AS failed
         FROM payment_transactions
         WHERE created_at::date = CURRENT_DATE`
    );
    const r = rows[0];
    return {
        total: num(r.total),
        succeeded: num(r.succeeded),
        failed: num(r.failed),
    };
}

/** Construit la ventilation par fournisseur à partir de la liste brute. */
function buildByProvider(lines) {
    const out = {};
    for (const { provider, status, count } of lines) {
        if (!out[provider]) out[provider] = {};
        out[provider][status] = count;
        out[provider].total = (out[provider].total || 0) + count;
    }
    return out;
}

/** Compteurs d'erreurs par fournisseur (FAILED + EXPIRED). */
function buildErrorsPerProvider(lines) {
    const out = {};
    for (const { provider, status, count } of lines) {
        if (TERMINAL_FAILURE.includes(status)) {
            out[provider] = (out[provider] || 0) + count;
        }
    }
    return out;
}

/**
 * Instantané complet du monitoring des paiements (aucun secret).
 * @returns {Promise<object|null>} null si la base est indisponible.
 */
async function snapshot() {
    try {
        const [total, byStatus, lines, avgMs, today] = await Promise.all([
            countTotal(),
            countByStatus(),
            countByProviderStatus(),
            avgProcessingTimeMs(),
            todayCounts(),
        ]);

        // Taux de succès : SUCCESS / (SUCCESS + FAILED + CANCELLED + EXPIRED).
        // REFUNDED exclu du dénominateur (ces paiements ont réussi au départ).
        const s = num(byStatus.SUCCESS);
        const f = num(byStatus.FAILED);
        const c = num(byStatus.CANCELLED);
        const e = num(byStatus.EXPIRED);
        const terminal = s + f + c + e;
        const successRate = terminal > 0 ? s / terminal : 0;

        return {
            total,
            byStatus,
            byProvider: buildByProvider(lines),
            successRate: round4(successRate),
            avgProcessingTimeMs: avgMs,
            errorsPerProvider: buildErrorsPerProvider(lines),
            today,
        };
    } catch {
        return null;
    }
}

module.exports = { snapshot };
