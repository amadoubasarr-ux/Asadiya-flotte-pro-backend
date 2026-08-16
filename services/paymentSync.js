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
const { plans } = require('../db/subscriptions');
const subscriptionService = require('./subscriptions');
const logger = require('../utils/logger');

/**
 * Résout un plan par son ID ou code et retourne son prix mensuel.
 * @returns {{ monthlyPrice: number, planCode: string } | null}
 */
async function resolvePlanAmount(orgId, planRef) {
    try {
        const plan = await plans.findByCodeOrId(planRef);
        if (!plan) return null;
        return { monthlyPrice: Number(plan.monthlyPrice) || 0, planCode: plan.code };
    } catch {
        return null;
    }
}

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
            const existingInvoice = await invoices.findByNumber(txn.invoiceId);
            const invoiceAmount = existingInvoice ? Number(existingInvoice.amount) : txn.amount;
            if (existingInvoice && Number(txn.amount) < invoiceAmount) {
                logger.warn('payment.amount_mismatch', {
                    transactionId: txn.id,
                    transactionAmount: txn.amount,
                    invoiceAmount,
                    message: `Montant du paiement (${txn.amount}) inférieur au montant de la facture (${invoiceAmount}).`,
                });
            }
            settled.invoice = await invoices.markPaidByNumber(txn.invoiceId, {
                organizationId: txn.organizationId,
                subscriptionId: txn.subscriptionId || null,
                amount: invoiceAmount,
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
            const resolvedPlan = planRef ? await resolvePlanAmount(txn.organizationId, planRef) : null;
            if (resolvedPlan && Number(txn.amount) < resolvedPlan.monthlyPrice) {
                logger.warn('payment.amount_below_plan', {
                    transactionId: txn.id,
                    transactionAmount: txn.amount,
                    planMonthlyPrice: resolvedPlan.monthlyPrice,
                    planCode: resolvedPlan.planCode,
                    message: `Montant du paiement (${txn.amount}) inférieur au prix du plan "${resolvedPlan.planCode}" (${resolvedPlan.monthlyPrice}). Renouvellement refusé.`,
                });
                return settled;
            }
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
