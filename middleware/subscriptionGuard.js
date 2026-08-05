// ============================================================
// Middleware Abonnement (Phase 3.5)
// ============================================================
// Bloque les actions d'écriture (création / modification / suppression)
// lorsque l'abonnement de l'organisation n'est pas en règle.
//
// Règles :
//   - Les lectures (GET/HEAD/OPTIONS) sont TOUJOURS autorisées : consultation
//     limitée de ses données même abonnement expiré.
//   - Le SUPERADMIN (plateforme) n'est jamais bloqué.
//   - Les comptes non rattachés à une organisation laissent passer (le 403
//     est géré par requireOrg dans les routeurs).
//   - Une écriture est refusée si le statut effectif de l'abonnement n'est pas
//     TRIAL / ACTIVE / PAST_DUE (donc EXPIRED ou CANCELLED).
//   - Le renouvellement est volontairement hors du périmètre de ce middleware :
//     les routes /api/subscriptions/me/renew et /api/organizations/*/subscription/*
//     restent accessibles.
//
// Expose req.subscription = contexte d'abonnement (plan, statut, usage, limites).
// ============================================================
const AppError = require('../utils/AppError');
const subscriptionService = require('../services/subscriptions');

const READ_METHODS = ['GET', 'HEAD', 'OPTIONS'];

// Statuts qui autorisent les écritures.
const WRITE_ALLOWED_STATUSES = ['TRIAL', 'ACTIVE', 'PAST_DUE'];

function subscriptionGuard(req, res, next) {
    // Consultation limitée : les lectures passent toujours.
    if (READ_METHODS.includes(req.method)) {
        return next();
    }

    // L'utilisateur n'est pas encore authentifié : le routeur s'en chargera (401).
    if (!req.user) {
        return next();
    }

    // Accès SuperAdmin (console plateforme) jamais bloqué.
    if (req.user.role === 'SUPERADMIN') {
        return next();
    }

    // Compte sans organisation : géré par requireOrg dans les routeurs (403).
    if (!req.user.organizationId) {
        return next();
    }

    subscriptionService
        .getSubscriptionContext(req.user.organizationId)
        .then((ctx) => {
            req.subscription = ctx;
            const status = ctx && ctx.subscription ? ctx.subscription.status : null;

            if (!ctx || !ctx.subscription) {
                throw new AppError(403,
                    'Aucun abonnement actif pour votre compte. Contactez l\'équipe Asadiya.',
                    { code: 'subscription_inactive', details: ctx || null }
                );
            }
            if (!WRITE_ALLOWED_STATUSES.includes(status)) {
                throw new AppError(403,
                    `Votre abonnement est ${ctx.statusLabel || status.toLowerCase()}. ` +
                    'Renouvelez-le pour continuer à modifier vos données.',
                    { code: 'subscription_inactive', details: ctx }
                );
            }
            next();
        })
        .catch(next);
}

module.exports = { subscriptionGuard, WRITE_ALLOWED_STATUSES };
