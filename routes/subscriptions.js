const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { history } = require('../db/subscriptions');
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
