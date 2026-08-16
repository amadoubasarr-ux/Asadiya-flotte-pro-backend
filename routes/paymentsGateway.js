// ============================================================
// API des paiements (Phase 5.1 + 5.2 + 5.3 + 5.4)
// ============================================================
// Endpoints :
//   POST /api/payments/create              — initier un paiement
//   GET  /api/payments/me                  — transactions de mon organisation
//   GET  /api/payments                     — toutes les transactions (SUPERADMIN)
//   GET  /api/payments/:id                 — détail + historique
//   GET  /api/payments/:id/check           — vérifier l'état réel au fournisseur
//   POST /api/payments/:id/cancel          — annuler un paiement
//   POST /api/payments/:id/refund          — rembourser un paiement réussi
//   POST /api/payments/webhook/:provider   — webhook fournisseur (public)
//
// Fournisseurs réels : 'wave' (Phase 5.2), 'orange_money' (Phase 5.3),
// 'stripe' (Phase 5.4). Le simulateur par défaut est 'mock' (aucun appel réseau).
// ============================================================
const express = require('express');
const crypto = require('crypto');
const { requireAuth } = require('../middleware/auth');
const payments = require('../db/payments');
const { subscriptions } = require('../db/subscriptions');
const {
    getGateway,
    isProviderEnabled,
    isProviderConfigured,
    isProviderNotImplemented,
    KNOWN_PROVIDERS,
} = require('../services/paymentGateway');
const { config } = require('../config');
const { settlePayment } = require('../services/paymentSync');
const { canTransition } = require('../services/paymentStateMachine');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const logger = require('../utils/logger');

const router = express.Router();

// Événements acceptés dans un webhook de simulation (statuts atteignables).
const WEBHOOK_EVENTS = ['PROCESSING', 'SUCCESS', 'FAILED', 'CANCELLED', 'EXPIRED', 'REFUNDED'];

/** Convertit une erreur "Provider not implemented" en 501 propre. */
function notImplemented(provider) {
    return new AppError(501, `Fournisseur de paiement "${provider}" non implémenté.`, {
        code: 'provider_not_implemented',
    });
}

/** Appelle une méthode du fournisseur en traduisant "not implemented" en 501. */
async function callProvider(gateway, method, params) {
    try {
        return await gateway[method](params);
    } catch (err) {
        if (isProviderNotImplemented(err)) throw notImplemented(gateway.name);
        throw err;
    }
}

/**
 * Amène une transaction vers un statut cible en respectant la machine à états.
 * Si la cible n'est pas directement atteignable (ex: PENDING -> SUCCESS, car
 * le chemin nominal exige PROCESSING), la transaction est d'abord amenée à
 * PROCESSING puis à la cible. Utilisé lors de la réconciliation avec l'état
 * réel du fournisseur (check / webhook), jamais pour les transitions simulées.
 */
async function reconcileTransition(current, to, { message, payload }) {
    if (current.status === to) {
        return payments.transition(current.id, to, { idempotent: true, message, payload });
    }
    if (canTransition(current.status, to)) {
        return payments.transition(current.id, to, { message, payload });
    }
    let step = current;
    if (step.status === 'CREATED') {
        step = await payments.transition(step.id, 'PENDING', {
            message: 'Synchronisation : initiation reconnue par le fournisseur.',
            payload: { providerChecked: true },
        });
    }
    if (step.status === 'PENDING') {
        step = await payments.transition(step.id, 'PROCESSING', {
            message: 'Synchronisation : paiement confirmé en traitement.',
            payload: { providerChecked: true },
        });
    }
    if (!canTransition(step.status, to)) {
        throw AppError.conflict(
            `Transition de statut invalide : ${step.status} → ${to}.`,
            { from: step.status, to }
        );
    }
    return payments.transition(step.id, to, { message, payload });
}

function parseId(raw) {
    const id = parseInt(raw, 10);
    if (!Number.isInteger(id) || id < 1) {
        throw AppError.badRequest('Identifiant de transaction invalide.');
    }
    return id;
}

/** Récupère une transaction et vérifie le droit d'accès (org ou SUPERADMIN). */
async function loadOwned(req) {
    const id = parseId(req.params.id);
    const txn = await payments.getById(id);
    if (!txn) throw AppError.notFound('Transaction de paiement introuvable.');
    if (req.user.role !== 'SUPERADMIN' && txn.organizationId !== req.user.organizationId) {
        throw AppError.notFound('Transaction de paiement introuvable.');
    }
    return txn;
}

// ============================================================
// Création d'un paiement (initiation auprès du fournisseur)
// ============================================================
router.post('/create', requireAuth, asyncHandler(async (req, res) => {
    const body = req.body || {};

    const provider = String(body.provider || config.payment.provider || 'mock').toLowerCase();
    if (!KNOWN_PROVIDERS.includes(provider)) {
        throw AppError.badRequest(`Fournisseur de paiement inconnu : "${provider}".`);
    }
    if (!isProviderEnabled(provider)) {
        throw AppError.forbidden(`Fournisseur de paiement "${provider}" désactivé.`);
    }
    if (!isProviderConfigured(provider)) {
        throw AppError.serviceUnavailable(
            `Fournisseur "${provider}" activé mais non configuré (identifiants API manquants).`,
            { code: 'provider_not_configured' }
        );
    }

    // Organisation payante : celle du compte client, ou explicitement fournie
    // par le SUPERADMIN (facturation plateforme).
    let organizationId;
    if (req.user.role === 'SUPERADMIN') {
        organizationId = parseInt(body.organizationId, 10);
        if (!Number.isInteger(organizationId) || organizationId < 1) {
            throw AppError.badRequest('organizationId est obligatoire pour une transaction SUPERADMIN.');
        }
    } else {
        organizationId = req.user.organizationId;
        if (!organizationId) {
            throw AppError.forbidden('Cette opération nécessite un compte rattaché à une organisation.');
        }
    }

    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
        throw AppError.badRequest('Montant invalide : un nombre positif est requis.');
    }
    const currency = String(body.currency || 'XOF').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
        throw AppError.badRequest('Devise invalide (code ISO 4217 attendu, ex: XOF, EUR).');
    }

    // Abonnement optionnel : s'il est fourni, il doit appartenir à l'organisation.
    let subscriptionId = null;
    if (body.subscriptionId !== undefined && body.subscriptionId !== null && body.subscriptionId !== '') {
        subscriptionId = parseInt(body.subscriptionId, 10);
        const sub = await subscriptions.getById(subscriptionId);
        if (!sub || sub.organizationId !== organizationId) {
            throw AppError.badRequest('Abonnement invalide pour cette organisation.');
        }
    }

    const transactionReference = `pay_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const invoiceId = body.invoiceId || `INV-${Date.now()}`;

    const txn = await payments.create({
        organizationId,
        subscriptionId,
        invoiceId,
        provider,
        transactionReference,
        amount,
        currency,
        paymentMethod: body.paymentMethod || null,
        metadata: body.metadata || { planCode: body.planCode || null },
    });
    logger.info('payment.created', { id: txn.id, provider, amount, currency });

    // Initiation simulée (mock) : la transaction passe CREATED -> PENDING.
    // Pour les fournisseurs réels (non implémentés) : la transaction reste
    // CREATED (audit) et la réponse est HTTP 501.
    const gateway = getGateway(provider);
    let result;
    try {
        result = await gateway.createPayment({
            amount,
            currency,
            transactionReference,
            successUrl: body.successUrl || null,
            errorUrl: body.errorUrl || null,
            payerMobile: body.payerMobile || null,
        });
    } catch (err) {
        if (isProviderNotImplemented(err)) {
            const stale = await payments.getById(txn.id);
            stale.events = await payments.eventsByTransaction(txn.id);
            return res.status(501).json({
                error: `Fournisseur de paiement "${provider}" non implémenté.`,
                code: 'provider_not_implemented',
                transaction: stale,
            });
        }
        throw err;
    }

    if (result && result.providerReference) {
        await payments.setProviderReference(txn.id, result.providerReference);
    }
    const updated = await payments.transition(txn.id, 'PENDING', {
        message: `Paiement initié auprès du fournisseur "${provider}".`,
        payload: result || {},
        // Réponse brute du fournisseur conservée (ex: notif_token Orange Money)
        // : requise pour la vérification des notifications de statut.
        providerResponse: result || {},
    });
    updated.events = await payments.eventsByTransaction(txn.id);
    res.status(201).json(updated);
}));

// ============================================================
// Liste des transactions (organisation connectée)
// ============================================================
router.get('/me', requireAuth, asyncHandler(async (req, res) => {
    if (!req.user.organizationId) {
        throw AppError.forbidden('Cette opération nécessite un compte rattaché à une organisation.');
    }
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    res.json(await payments.findByOrg(req.user.organizationId, limit));
}));

// ============================================================
// Liste des transactions (SUPERADMIN — plateforme)
// ============================================================
router.get('/', requireAuth, asyncHandler(async (req, res) => {
    if (req.user.role !== 'SUPERADMIN') {
        throw AppError.forbidden('Action réservée au SUPERADMIN.');
    }
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
    res.json(await payments.findAll(limit));
}));

// ============================================================
// Détail d'une transaction + historique (audit)
// ============================================================
router.get('/:id', requireAuth, asyncHandler(async (req, res) => {
    const txn = await loadOwned(req);
    txn.events = await payments.eventsByTransaction(txn.id);
    res.json(txn);
}));

// ============================================================
// Vérification de l'état réel auprès du fournisseur (polling)
// ============================================================
router.get('/:id/check', requireAuth, asyncHandler(async (req, res) => {
    const txn = await loadOwned(req);
    const gateway = getGateway(txn.provider);

    // L'état réel est sans objet pour les états terminaux : réponse immédiate.
    if (['SUCCESS', 'FAILED', 'CANCELLED', 'EXPIRED', 'REFUNDED'].includes(txn.status)) {
        return res.json({ ...txn, actualStatus: txn.status, providerChecked: false });
    }

    const actual = await callProvider(gateway, 'checkPayment', {
        transactionReference: txn.transactionReference,
        providerReference: txn.providerReference,
    });

    // Synchronise la machine à états locale si le fournisseur renvoie un
    // statut atteignable. Un succès directement observé depuis PENDING (le
    // checkout hébergé a pu se terminer avant tout webhook PROCESSING) est
    // réconcilié via PROCESSING par reconcileTransition().
    let updated = txn;
    const wasSuccess = txn.status === 'SUCCESS';
    if (actual && actual.status && actual.status !== 'PROCESSING') {
        updated = await reconcileTransition(txn, actual.status, {
            message: `Vérification fournisseur : ${actual.message || actual.status}.`,
            payload: { providerChecked: true, session: actual.session || null },
        });
        updated.events = await payments.eventsByTransaction(txn.id);
        if (updated.status === 'SUCCESS' && !wasSuccess) {
            await settlePayment(updated);
        }
    } else {
        updated.events = await payments.eventsByTransaction(txn.id);
    }
    res.json({ ...updated, actualStatus: (actual && actual.status) || txn.status, providerChecked: true });
}));

// ============================================================
// Annulation d'un paiement non terminé
// ============================================================
router.post('/:id/cancel', requireAuth, asyncHandler(async (req, res) => {
    const txn = await loadOwned(req);

    if (!canTransition(txn.status, 'CANCELLED')) {
        throw AppError.conflict(
            `Transition de statut invalide : ${txn.status} → CANCELLED.`,
            { from: txn.status, to: 'CANCELLED' }
        );
    }

    const gateway = getGateway(txn.provider);
    await callProvider(gateway, 'cancelPayment', {
        transactionReference: txn.transactionReference,
        providerReference: txn.providerReference,
    });

    const updated = await payments.transition(txn.id, 'CANCELLED', {
        message: `Paiement annulé (fournisseur "${txn.provider}").`,
        payload: { requestedBy: req.user.id },
    });
    logger.info('payment.cancelled', { id: txn.id });
    updated.events = await payments.eventsByTransaction(txn.id);
    res.json(updated);
}));

// ============================================================
// Remboursement d'un paiement réussi
// ============================================================
router.post('/:id/refund', requireAuth, asyncHandler(async (req, res) => {
    const txn = await loadOwned(req);

    if (!canTransition(txn.status, 'REFUNDED')) {
        throw AppError.conflict(
            `Transition de statut invalide : ${txn.status} → REFUNDED.`,
            { from: txn.status, to: 'REFUNDED' }
        );
    }

    const gateway = getGateway(txn.provider);
    await callProvider(gateway, 'refundPayment', {
        transactionReference: txn.transactionReference,
        providerReference: txn.providerReference,
    });

    const updated = await payments.transition(txn.id, 'REFUNDED', {
        message: `Remboursement effectué (fournisseur "${txn.provider}").`,
        payload: { requestedBy: req.user.id },
    });
    logger.info('payment.refunded', { id: txn.id });
    updated.events = await payments.eventsByTransaction(txn.id);
    res.json(updated);
}));

// ============================================================
// Webhook fournisseur (endpoint PUBLIC : appelé par le fournisseur)
// ============================================================
router.post('/webhook/:provider', asyncHandler(async (req, res) => {
    const provider = String(req.params.provider).toLowerCase();
    if (!KNOWN_PROVIDERS.includes(provider)) {
        throw AppError.badRequest(`Fournisseur de paiement inconnu : "${provider}".`);
    }

    const gateway = getGateway(provider);

    // Fournisseurs réels : vérification de signature + traduction de
    // l'événement en statut applicatif, puis synchronisation SaaS.
    if (provider !== 'mock') {
        const result = await callProvider(gateway, 'receiveWebhook', {
            body: req.body || {},
            rawBody: req.rawBody,
            headers: req.headers,
        });

        // Événements ignorés (test, non gérés) : accusé de réception 200.
        if (result.ignored || !result.status) {
            return res.json(result);
        }

        const txn = result.transactionReference
            ? await payments.findByReference(result.transactionReference)
            : result.providerReference
                ? await payments.findByProviderReference(result.providerReference)
                : null;
        if (!txn) {
            throw AppError.notFound('Aucune transaction de paiement correspondant au webhook.');
        }
        if (txn.provider !== provider) {
            throw AppError.badRequest(`La transaction appartient au fournisseur "${txn.provider}", pas à "${provider}".`);
        }

        // Garde anti-boucle : un événement en conflit avec un état terminal
        // est accusé réception (200) mais ne modifie plus la transaction.
        // Une redélivrance du même statut (idempotence) ET les transitions
        // terminales valides (ex: charge.refunded sur SUCCESS -> REFUNDED)
        // restent possibles ; le reste de la machine à états contrôle les
        // changements.
        const terminal = ['SUCCESS', 'FAILED', 'CANCELLED', 'EXPIRED', 'REFUNDED'];
        if (
            terminal.includes(txn.status) &&
            result.status !== txn.status &&
            !canTransition(txn.status, result.status)
        ) {
            logger.info('payment.webhook_ignored', {
                id: txn.id,
                event: result.status,
                currentStatus: txn.status,
            });
            return res.json({ ok: true, ignored: true, message: 'Événement sans effet sur une transaction terminale.' });
        }

        // transition() est idempotent : une redélivrance du même événement
        // (webhook dupliqué) est acceptée et journalisée, sans ré-effet SaaS.
        const wasSuccess = txn.status === 'SUCCESS';
        const updated = await reconcileTransition(txn, result.status, {
            message: `Webhook reçu du fournisseur "${provider}" : ${result.message || result.status}.`,
            payload: result.payload || result,
        });
        updated.events = await payments.eventsByTransaction(txn.id);
        logger.info('payment.webhook', { id: txn.id, event: result.status });

        // Succès confirmé par le fournisseur -> synchronisation SaaS UNIQUEMENT
        // si ce webhook a réellement fait passer la transaction à SUCCESS
        // (un webhook dupliqué SUCCESS ne déclenche pas de double effet).
        if (updated.status === 'SUCCESS' && !wasSuccess) {
            await settlePayment(updated);
        }
        return res.json(updated);
    }

    // Le simulateur 'mock' accepte les webhooks pour piloter la machine à états.
    // Si PAYMENT_WEBHOOK_SECRET est configuré, il est exigé (x-webhook-secret).
    if (config.payment.webhookSecret) {
        const provided = req.get('x-webhook-secret') || '';
        if (provided !== config.payment.webhookSecret) {
            throw AppError.unauthorized('Signature webhook invalide.');
        }
    }

    const body = req.body || {};
    const event = String(body.event || '').toUpperCase();
    if (!WEBHOOK_EVENTS.includes(event)) {
        throw AppError.badRequest(`Événement webhook invalide : "${event}".`);
    }

    const txn = body.transactionReference
        ? await payments.findByReference(body.transactionReference)
        : body.providerReference
            ? await payments.findByProviderReference(body.providerReference)
            : null;
    if (!txn) {
        throw AppError.notFound('Aucune transaction de paiement correspondant au webhook.');
    }
    if (txn.provider !== provider) {
        throw AppError.badRequest(`La transaction appartient au fournisseur "${txn.provider}", pas à "${provider}".`);
    }

    const updated = await payments.transition(txn.id, event, {
        // idempotent : une redélivrance (même statut) est acceptée et journalisée.
        idempotent: true,
        message: `Webhook reçu du fournisseur "${provider}".`,
        payload: body.payload || body,
    });
    logger.info('payment.webhook', { id: txn.id, event });
    updated.events = await payments.eventsByTransaction(txn.id);

    // Succès confirmé par le simulateur -> même synchronisation SaaS, mais
    // UNIQUEMENT si ce webhook a réellement fait passer à SUCCESS (jamais de
    // double renouvellement sur un webhook dupliqué).
    if (updated.status === 'SUCCESS' && txn.status !== 'SUCCESS') {
        await settlePayment(updated);
    }
    res.json(updated);
}));

module.exports = router;
