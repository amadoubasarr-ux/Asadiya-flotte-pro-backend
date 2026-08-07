// ============================================================
// Paiements — Transactions & Événements (Phase 5.1)
// ============================================================
// Accès aux données du module de paiement :
//   - payment_transactions : chaque tentative de paiement
//   - payment_events       : audit trail (un événement par changement
//                            de statut et pour chaque webhook reçu)
// Les transitions de statut sont contrôlées par la machine à états
// (services/paymentStateMachine.js) et sont ATOMIQUES avec l'écriture
// de l'événement d'audit correspondant.
// ============================================================
const { query, withTransaction } = require('./pool');
const { mapRow, mapRows } = require('./mappers');
const { canTransition } = require('../services/paymentStateMachine');
const AppError = require('../utils/AppError');

const TXN_COLUMNS = `
    id, organization_id, subscription_id, invoice_id, provider,
    transaction_reference, provider_reference, amount, currency, status,
    payment_method, initiated_at, completed_at, provider_response, metadata,
    created_at, updated_at
`;

const EVENT_COLUMNS = 'id, transaction_id, event, message, payload, created_at';

function eventPayload(value) {
    return JSON.stringify(value === undefined || value === null ? {} : value);
}

// ============================================================
// payment_transactions
// ============================================================

/**
 * Crée une transaction en statut CREATED et journalise l'événement CREATED.
 * Atomique.
 */
async function create(data) {
    return withTransaction(async (client) => {
        const { rows } = await client.query(
            `INSERT INTO payment_transactions
                (organization_id, subscription_id, invoice_id, provider,
                 transaction_reference, amount, currency, status, payment_method, metadata)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'CREATED', $8, $9::jsonb)
             RETURNING ${TXN_COLUMNS}`,
            [
                data.organizationId,
                data.subscriptionId || null,
                data.invoiceId || null,
                data.provider,
                data.transactionReference,
                data.amount,
                data.currency || 'XOF',
                data.paymentMethod || null,
                eventPayload(data.metadata),
            ]
        );
        const row = rows[0];

        await client.query(
            `INSERT INTO payment_events (transaction_id, event, message, payload)
             VALUES ($1, 'CREATED', $2, $3::jsonb)`,
            [
                row.id,
                'Transaction de paiement créée.',
                eventPayload({ amount: data.amount, currency: data.currency || 'XOF', provider: data.provider }),
            ]
        );
        return mapRow(row);
    });
}

/** Retrouve une transaction par son identifiant interne. */
async function getById(id) {
    const { rows } = await query(
        `SELECT ${TXN_COLUMNS} FROM payment_transactions WHERE id = $1`,
        [id]
    );
    return mapRow(rows[0] || null);
}

/** Retrouve une transaction par sa référence applicative (pay_...). */
async function findByReference(reference) {
    const { rows } = await query(
        `SELECT ${TXN_COLUMNS} FROM payment_transactions WHERE transaction_reference = $1`,
        [reference]
    );
    return mapRow(rows[0] || null);
}

/** Retrouve une transaction par la référence du fournisseur. */
async function findByProviderReference(reference) {
    const { rows } = await query(
        `SELECT ${TXN_COLUMNS} FROM payment_transactions WHERE provider_reference = $1`,
        [reference]
    );
    return mapRow(rows[0] || null);
}

/** Transactions d'une organisation (la plus récente en premier). */
async function findByOrg(orgId, limit = 50) {
    const { rows } = await query(
        `SELECT ${TXN_COLUMNS} FROM payment_transactions
         WHERE organization_id = $1
         ORDER BY id DESC
         LIMIT $2`,
        [orgId, limit]
    );
    return mapRows(rows);
}

/** Toutes les transactions (plateforme). */
async function findAll(limit = 100) {
    const { rows } = await query(
        `SELECT ${TXN_COLUMNS
            .split(',')
            .map((c) => `t.${c.trim()}`)
            .join(', ')}, o.name AS organization_name
         FROM payment_transactions t
         JOIN organizations o ON o.id = t.organization_id
         ORDER BY t.id DESC
         LIMIT $1`,
        [limit]
    );
    return mapRows(rows);
}

/** Enregistre la référence retournée par le fournisseur après initiation. */
async function setProviderReference(id, providerReference) {
    const { rows } = await query(
        `UPDATE payment_transactions
         SET provider_reference = $2, initiated_at = COALESCE(initiated_at, NOW()), updated_at = NOW()
         WHERE id = $1
         RETURNING ${TXN_COLUMNS}`,
        [id, providerReference]
    );
    return mapRow(rows[0] || null);
}

/**
 * Applique une transition de statut (contrôlée par la machine à états) et
 * journalise l'événement d'audit correspondant. Atomique.
 *
 * @param {number} id
 * @param {string} to              Statut cible.
 * @param {object} [opts]
 * @param {string} [opts.message]  Message d'audit (par défaut automatique).
 * @param {object} [opts.payload]  Données contextuelles (webhook, utilisateur...).
 * @param {object} [opts.providerResponse] Réponse brute du fournisseur à stocker.
 * @param {boolean} [opts.idempotent] Si vrai, un webhook redélivré (même statut)
 *                                    est accepté et journalisé sans erreur.
 */
async function transition(id, to, { message, payload, providerResponse, idempotent = false } = {}) {
    return withTransaction(async (client) => {
        const { rows } = await client.query(
            'SELECT * FROM payment_transactions WHERE id = $1 FOR UPDATE',
            [id]
        );
        const txn = rows[0];
        if (!txn) throw AppError.notFound('Transaction de paiement introuvable.');

        const from = txn.status;

        // Webhook redélivré : aucun changement de statut, mais l'événement
        // est journalisé (traçabilité) et la réponse est 200.
        if (to === from && idempotent) {
            await client.query(
                `INSERT INTO payment_events (transaction_id, event, message, payload)
                 VALUES ($1, $2, $3, $4::jsonb)`,
                [id, to, message || `Webhook dupliqué : statut déjà ${to} (aucun changement).`, eventPayload(payload)]
            );
            const { rows: current } = await client.query(
                `SELECT ${TXN_COLUMNS} FROM payment_transactions WHERE id = $1`,
                [id]
            );
            return mapRow(current[0]);
        }

        if (!canTransition(from, to)) {
            throw AppError.conflict(
                `Transition de statut invalide : ${from} → ${to}.`,
                { from, to }
            );
        }

        const isTerminal = ['SUCCESS', 'FAILED', 'CANCELLED', 'EXPIRED', 'REFUNDED'].includes(to);
        const { rows: updated } = await client.query(
            `UPDATE payment_transactions
             SET status = $2,
                 provider_response = $3::jsonb,
                 completed_at = CASE WHEN $4 THEN COALESCE(completed_at, NOW()) ELSE completed_at END,
                 updated_at = NOW()
             WHERE id = $1
             RETURNING ${TXN_COLUMNS}`,
            [
                id,
                to,
                eventPayload(providerResponse !== undefined ? providerResponse : txn.provider_response),
                isTerminal,
            ]
        );
        const row = updated[0];

        await client.query(
            `INSERT INTO payment_events (transaction_id, event, message, payload)
             VALUES ($1, $2, $3, $4::jsonb)`,
            [id, to, message || `Statut passé à ${to}.`, eventPayload(payload)]
        );
        return mapRow(row);
    });
}

/** Nombre total de transactions (plateforme). */
async function count() {
    const { rows } = await query('SELECT COUNT(*) AS count FROM payment_transactions');
    return parseInt(rows[0].count, 10);
}

// ============================================================
// payment_events
// ============================================================

/** Historique des événements d'une transaction (le plus récent en premier). */
async function eventsByTransaction(transactionId, limit = 100) {
    const { rows } = await query(
        `SELECT ${EVENT_COLUMNS} FROM payment_events
         WHERE transaction_id = $1
         ORDER BY id DESC
         LIMIT $2`,
        [transactionId, limit]
    );
    return mapRows(rows);
}

/** Nombre total d'événements d'audit (plateforme). */
async function countEvents() {
    const { rows } = await query('SELECT COUNT(*) AS count FROM payment_events');
    return parseInt(rows[0].count, 10);
}

module.exports = {
    create,
    getById,
    findByReference,
    findByProviderReference,
    findByOrg,
    findAll,
    setProviderReference,
    transition,
    count,
    eventsByTransaction,
    countEvents,
};
