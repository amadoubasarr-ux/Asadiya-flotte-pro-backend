const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { history, subscriptions } = require('../db/subscriptions');
const subscriptionService = require('../services/subscriptions');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');

const router = express.Router();

function requireOrg(req, res, next) {
    if (!req.user.organizationId) {
        return res.status(403).json({ error: 'Cette ressource nécessite un compte rattaché à une organisation.' });
    }
    next();
}

// ===== Côté organisation (compte client) =====

// Contexte d'abonnement du compte connecté : plan, statut, dates, usage, limites, alerte.
router.get('/me', requireAuth, requireOrg, asyncHandler(async (req, res) => {
    res.json(await subscriptionService.getSubscriptionContext(req.user.organizationId));
}));

// Historique de l'abonnement de mon organisation.
router.get('/me/history', requireAuth, requireOrg, asyncHandler(async (req, res) => {
    res.json(await history.findByOrg(req.user.organizationId));
}));

// Renouvellement demandé par le client lui-même (accessible même si
// l'abonnement est EXPIRED — c'est le point de sortie du blocage).
// Réservé aux administrateurs : un simple conducteur ne doit pas pouvoir
// prolonger l'abonnement de l'organisation (réservé aux futurs paiements).
// Le planId éventuellement fourni par le client est IGNORÉ : le renouvellement
// réapplique toujours le plan courant (le changement de plan est une opération
// de plateforme, réservée au SUPERADMIN). Aucune extension d'un abonnement
// encore actif sans paiement : le renouvellement n'est possible que lorsque
// l'abonnement est effectivement expiré.
router.post('/me/renew', requireAuth, requireOrg, requireRole('ADMIN'), asyncHandler(async (req, res) => {
    const body = req.body || {};
    const current = await subscriptions.getByOrg(req.user.organizationId);
    const effective = subscriptionService.computeEffectiveStatus(current);
    if (effective !== 'EXPIRED') {
        throw AppError.conflict(
            `Renouvellement refusé : l'abonnement n'est pas expiré (statut effectif : ${effective}).`,
            { status: effective }
        );
    }
    const sub = await subscriptionService.renew(req.user.organizationId, {
        changedBy: req.user.id,
        reason: body.reason || 'Renouvellement demandé par le client.',
    });
    res.json(sub);
}));

// ===== Côté plateforme (SUPERADMIN) =====

// Liste des abonnements courants de toutes les organisations.
router.get('/', requireAuth, requireRole('SUPERADMIN'), asyncHandler(async (req, res) => {
    res.json(await require('../db/subscriptions').subscriptions.findAllCurrent());
}));

// Historique global des changements d'abonnement (audit trail plateforme).
router.get('/history', requireAuth, requireRole('SUPERADMIN'), asyncHandler(async (req, res) => {
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
    res.json(await history.findAll(limit));
}));

// Historique d'une organisation précise.
router.get('/:orgId/history', requireAuth, requireRole('SUPERADMIN'), asyncHandler(async (req, res) => {
    const orgId = parseInt(req.params.orgId, 10);
    if (Number.isNaN(orgId)) throw AppError.badRequest('Identifiant d\'organisation invalide.');
    res.json(await history.findByOrg(orgId));
}));

module.exports = router;
