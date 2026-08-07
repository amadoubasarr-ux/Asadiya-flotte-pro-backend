// ============================================================
// Synchronisation SaaS après paiement réussi (Phase 5.2)
// ============================================================
// Appelé automatiquement quand une transaction de paiement passe à SUCCESS
// (via webhook ou vérification périodique). Met à jour :
//   - payment_transactions / payment_events : faits par db/payments.transition
//   - invoices  : la facture liée (invoice_id) devient PAID
//   - subscriptions : renouvellement automatique de l'abonnement
//
// FAILED / CANCELLED / EXPIRED ne déclenchent JAMAIS cette synchronisation
// (la machine à états ne permet pas de sortir de ces états terminaux vers
// SUCCESS, et le webhook dupliqué SUCCESS est ignoré par l'idempotence).
//
// Aucun secret n'est journalisé ici.
// ============================================================
const invoices = require('../db/invoices');
const subscriptionService = require('./subscriptions');
const logger = require('../utils/logger');

/**
 * Applique les effets métier d'un paiement réussi.
 * Les erreurs d'un effet (ex: abonnement introuvable) sont journalisées mais
 * ne font pas échouer le traitement du paiement lui-même.
 *
 * @param {object} txn Transaction au statut SUCCESS (issue de db/payments).
 * @returns {Promise<{ invoice: object|null, subscription: object|null }>}
 */
async function settlePayment(txn) {
    const settled = { invoice: null, subscription: null };

    // 1) Facture liée -> PAID (créée au besoin, idempotente).
    if (txn.invoiceId) {
        try {
            settled.invoice = await invoices.markPaidByNumber(txn.invoiceId, {
                organizationId: txn.organizationId,
                subscriptionId: txn.subscriptionId || null,
                amount: txn.amount,
                currency: txn.currency,
                provider: txn.provider,
                paymentTransactionId: txn.id,
            });
            logger.info('payment.invoice_paid', {
                transactionId: txn.id,
                invoiceId: txn.invoiceId,
                invoiceStatus: settled.invoice && settled.invoice.status,
            });
        } catch (err) {
            logger.error('payment.invoice_paid_failed', {
                transactionId: txn.id,
                invoiceId: txn.invoiceId,
                message: err.message,
            });
        }
    }

    // 2) Abonnement de l'organisation -> renouvellement automatique.
    // Un paiement d'abonnement concerne toujours l'abonnement courant de
    // l'organisation (renew le retrouve via organizationId), que la
    // transaction référence explicitement un subscription_id ou non.
    if (txn.subscriptionId || txn.organizationId) {
        try {
            const planRef = (txn.metadata && (txn.metadata.planId || txn.metadata.planCode)) || undefined;
            settled.subscription = await subscriptionService.renew(txn.organizationId, {
                planId: planRef,
                changedBy: null,
                reason: `Renouvellement automatique après paiement réussi (transaction ${txn.transactionReference}).`,
            });
            logger.info('payment.subscription_renewed', {
                transactionId: txn.id,
                organizationId: txn.organizationId,
                subscriptionId: settled.subscription && settled.subscription.id,
                endDate: settled.subscription && settled.subscription.endDate,
            });
        } catch (err) {
            logger.error('payment.subscription_renew_failed', {
                transactionId: txn.id,
                organizationId: txn.organizationId,
                message: err.message,
            });
        }
    }

    return settled;
}

module.exports = { settlePayment };
