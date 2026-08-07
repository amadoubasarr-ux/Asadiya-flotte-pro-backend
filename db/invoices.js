// ============================================================
// Factures — accès aux données (Phase 5.2)
// ============================================================
// Une facture est liée à un paiement via payment_transactions.invoice_id
// (numéro de facture). Lorsqu'un paiement passe à SUCCESS, la facture
// correspondante devient PAID automatiquement (services/paymentSync.js).
//
// Statuts : PENDING | PAID | FAILED | CANCELLED | REFUNDED.
// L'écriture d'un paiement réussi est IDEMPOTENTE : une redélivrance du
// webhook SUCCESS conserve la même facture PAID (aucune double écriture).
// ============================================================
const { query } = require('./pool');
const { mapRow, mapRows } = require('./mappers');

const INVOICE_COLUMNS = `
    id, invoice_number, organization_id, subscription_id, amount, currency,
    status, provider, payment_transaction_id, issued_at, paid_at, created_at, updated_at
`;

/** Retrouve une facture par son numéro (invoice_id de la transaction). */
async function findByNumber(invoiceNumber) {
    const { rows } = await query(
        `SELECT ${INVOICE_COLUMNS} FROM invoices WHERE invoice_number = $1`,
        [invoiceNumber]
    );
    return mapRow(rows[0] || null);
}

/** Factures d'une organisation (la plus récente en premier). */
async function findByOrg(orgId, limit = 100) {
    const { rows } = await query(
        `SELECT ${INVOICE_COLUMNS} FROM invoices
         WHERE organization_id = $1
         ORDER BY id DESC
         LIMIT $2`,
        [orgId, limit]
    );
    return mapRows(rows);
}

/**
 * Marque une facture PAID (créée au besoin) après un paiement réussi.
 * Idempotent : si la facture est déjà PAID, l'opération est sans effet
 * (le paid_at d'origine et la transaction liée sont conservés).
 */
async function markPaidByNumber(invoiceNumber, { organizationId, subscriptionId, amount, currency, provider, paymentTransactionId }) {
    const { rows } = await query(
        `INSERT INTO invoices
            (invoice_number, organization_id, subscription_id, amount, currency,
             tax_amount, total_amount, status, provider, payment_transaction_id, paid_at)
         VALUES ($1, $2, $3, $4, $5, 0, $4, 'PAID', $6, $7, NOW())
         ON CONFLICT (invoice_number) DO UPDATE SET
             status = 'PAID',
             provider = COALESCE(excluded.provider, invoices.provider),
             payment_transaction_id = COALESCE(excluded.payment_transaction_id, invoices.payment_transaction_id),
             paid_at = COALESCE(invoices.paid_at, NOW()),
             updated_at = NOW()
         RETURNING ${INVOICE_COLUMNS}`,
        [
            invoiceNumber,
            organizationId,
            subscriptionId || null,
            amount,
            currency || 'XOF',
            provider || null,
            paymentTransactionId || null,
        ]
    );
    return mapRow(rows[0] || null);
}

module.exports = { findByNumber, findByOrg, markPaidByNumber };
