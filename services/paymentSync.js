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
const { withTransaction } = require('../db/pool');
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
 *
 * Garanties :
 *  - Aucun effet si le montant payé est inférieur au montant attendu (facture
 *    existante ou prix du plan) : la transaction peut être SUCCESS mais la
 *    facture reste PENDING et l'abonnement n'est PAS renouvelé.
 *  - Les effets (facture PAID + renouvellement) sont ATOMIQUES : exécutés
 *    dans une seule transaction PostgreSQL, ils réussissent ou échouent
 *    ensemble (aucune facture PAID sans renouvellement, ni l'inverse).
 *  - Idempotent du côté de la facture (ON CONFLICT) et du renouvellement
 *    (un webhook SUCCESS dupliqué ne redéclenche pas settlePayment : la
 *    machine à états ne passe à SUCCESS qu'une fois).
 *
 * @param {object} txn Transaction au statut SUCCESS (issue de db/payments).
 * @returns {Promise<{ invoice: object|null, subscription: object|null }>}
 */
async function settlePayment(txn) {
    const settled = { invoice: null, subscription: null };
    if (!txn || (!txn.invoiceId && !txn.subscriptionId && !txn.organizationId)) {
        return settled;
    }

    // 1) Montants attendus (lectures préalables, hors transaction).
    let invoiceAmount = null;
    if (txn.invoiceId) {
        const existing = await invoices.findByNumber(txn.invoiceId);
        invoiceAmount = existing ? Number(existing.amount) : (Number(txn.amount) || 0);
    }
    let resolvedPlan = null;
    if (txn.subscriptionId || txn.organizationId) {
        const planRef = (txn.metadata && (txn.metadata.planId || txn.metadata.planCode)) || undefined;
        resolvedPlan = planRef ? await resolvePlanAmount(txn.organizationId, planRef) : null;
    }

    // 2) Gardes anti sous-paiement AVANT tout effet : un montant insuffisant
    // ne crée NI facture PAID NI renouvellement (le tout est journalisé).
    const paid = Number(txn.amount);
    if (invoiceAmount != null && paid < invoiceAmount) {
        logger.warn('payment.amount_mismatch', {
            transactionId: txn.id,
            transactionAmount: txn.amount,
            invoiceAmount,
            message: `Montant du paiement (${txn.amount}) inférieur au montant de la facture (${invoiceAmount}). Aucun effet appliqué.`,
        });
        return settled;
    }
    if (resolvedPlan && paid < resolvedPlan.monthlyPrice) {
        logger.warn('payment.amount_below_plan', {
            transactionId: txn.id,
            transactionAmount: txn.amount,
            planMonthlyPrice: resolvedPlan.monthlyPrice,
            planCode: resolvedPlan.planCode,
            message: `Montant du paiement (${txn.amount}) inférieur au prix du plan "${resolvedPlan.planCode}" (${resolvedPlan.monthlyPrice}). Aucun effet appliqué.`,
        });
        return settled;
    }

    // 3) Effets métier ATOMIQUES : facture PAID + renouvellement dans la même
    // transaction. En cas d'échec d'un des effets, tout est annulé et
    // journalisé ; le webhook fournisseur reste accusé d'ordre (200).
    try {
        await withTransaction(async (client) => {
            if (txn.invoiceId) {
                settled.invoice = await invoices.markPaidByNumber(txn.invoiceId, {
                    organizationId: txn.organizationId,
                    subscriptionId: txn.subscriptionId || null,
                    amount: invoiceAmount != null ? invoiceAmount : paid,
                    currency: txn.currency,
                    provider: txn.provider,
                    paymentTransactionId: txn.id,
                }, client);
                logger.info('payment.invoice_paid', {
                    transactionId: txn.id,
                    invoiceId: txn.invoiceId,
                    invoiceStatus: settled.invoice && settled.invoice.status,
                });
            }
            if (txn.subscriptionId || txn.organizationId) {
                settled.subscription = await subscriptionService.renewOnClient(client, txn.organizationId, {
                    planId: resolvedPlan ? resolvedPlan.planCode : undefined,
                    changedBy: null,
                    reason: `Renouvellement automatique après paiement réussi (transaction ${txn.transactionReference}).`,
                });
                logger.info('payment.subscription_renewed', {
                    transactionId: txn.id,
                    organizationId: txn.organizationId,
                    subscriptionId: settled.subscription && settled.subscription.id,
                    endDate: settled.subscription && settled.subscription.endDate,
                });
            }
        });
    } catch (err) {
        logger.error('payment.settle_failed', {
            transactionId: txn.id,
            invoiceId: txn.invoiceId || null,
            organizationId: txn.organizationId || null,
            message: err.message,
        });
    }

    return settled;
}

module.exports = { settlePayment };
