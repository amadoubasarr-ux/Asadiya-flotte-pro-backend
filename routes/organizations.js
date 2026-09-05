const express = require('express');
const bcrypt = require('bcryptjs');
const { users, organizations } = require('../db/repositories');
const { plans } = require('../db/subscriptions');
const subscriptionService = require('../services/subscriptions');
const { requireAuth, requireRole } = require('../middleware/auth');
const { validateOrganization } = require('../utils/validators');
const { config } = require('../config');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');

const router = express.Router();

// Toutes ces routes sont réservées au SUPERADMIN (compte plateforme, non rattaché
// à une organisation) : c'est lui qui crée les nouveaux clients ("organisations").

router.get('/', requireAuth, requireRole('SUPERADMIN'), asyncHandler(async (req, res) => {
    res.json(await organizations.findAllWithCounts());
}));

router.post('/', requireAuth, requireRole('SUPERADMIN'), asyncHandler(async (req, res) => {
    const data = validateOrganization(req.body || {});

    const existingUser = await users.findByUsername(data.adminUsername);
    if (existingUser) {
        throw AppError.conflict('Cet identifiant est déjà utilisé par un autre compte.');
    }

    // Plan de départ (par défaut STARTER en période d'essai).
    let planId = null;
    if (req.body && req.body.planId !== undefined && req.body.planId !== null && req.body.planId !== '') {
        const plan = await plans.findByCodeOrId(req.body.planId);
        if (!plan) throw AppError.badRequest('Plan d\'abonnement introuvable.');
        planId = plan.id;
    }

    // Création atomique : l'organisation + son premier compte Administrateur
    // + son abonnement (plan + période d'essai configurable).
    const result = await organizations.createWithAdmin({
        name: data.name,
        adminName: data.adminName,
        adminUsername: data.adminUsername,
        adminPasswordHash: bcrypt.hashSync(data.adminPassword, config.bcryptRounds),
        planId,
    });
    res.status(201).json(result);
}));

// Supprime l'organisation ET toutes les données qui lui appartiennent (irréversible)
router.delete('/:id', requireAuth, requireRole('SUPERADMIN'), asyncHandler(async (req, res) => {
    const ok = await organizations.remove(parseInt(req.params.id, 10));
    if (!ok) throw AppError.notFound('Organisation introuvable.');
    res.status(204).end();
}));

// Liste des utilisateurs d'un client donné (pour que le superadmin puisse
// choisir à qui réinitialiser le mot de passe en cas de perte)
router.get('/:id/users', requireAuth, requireRole('SUPERADMIN'), asyncHandler(async (req, res) => {
    const orgId = parseInt(req.params.id, 10);
    const org = await organizations.findById(orgId);
    if (!org) throw AppError.notFound('Organisation introuvable.');
    res.json(await organizations.findUsersByOrg(orgId));
}));

// Réinitialisation du mot de passe d'un utilisateur d'un client (dépannage,
// ex: le client a oublié son mot de passe et ne peut plus se connecter)
router.patch('/:id/users/:userId/reset-password', requireAuth, requireRole('SUPERADMIN'), asyncHandler(async (req, res) => {
    const orgId = parseInt(req.params.id, 10);
    const userId = parseInt(req.params.userId, 10);
    const { newPassword } = req.body || {};

    if (!newPassword || String(newPassword).length < 6) {
        throw AppError.badRequest('Le nouveau mot de passe doit contenir au moins 6 caractères.');
    }

    const user = await users.findById(orgId, userId);
    if (!user) throw AppError.notFound('Utilisateur introuvable pour ce client.');

    await users.update(orgId, userId, { passwordHash: bcrypt.hashSync(String(newPassword), config.bcryptRounds) });
    res.json({ success: true, username: user.username });
}));

// ===== Abonnements SaaS (gestion par le SuperAdmin) =====

// L'abonnement courant d'un client (avec le plan, l'usage et les limites).
router.get('/:id/subscription', requireAuth, requireRole('SUPERADMIN'), asyncHandler(async (req, res) => {
    const orgId = parseInt(req.params.id, 10);
    const org = await organizations.findById(orgId);
    if (!org) throw AppError.notFound('Organisation introuvable.');
    res.json(await subscriptionService.getSubscriptionContext(orgId));
}));

// Historique des changements d'abonnement d'un client.
router.get('/:id/subscription/history', requireAuth, requireRole('SUPERADMIN'), asyncHandler(async (req, res) => {
    const orgId = parseInt(req.params.id, 10);
    const org = await organizations.findById(orgId);
    if (!org) throw AppError.notFound('Organisation introuvable.');
    res.json(await require('../db/subscriptions').history.findByOrg(orgId));
}));

// Mettre à jour l'abonnement d'un client (plan, statut, dates).
// Body : { planId | planCode, status, startDate, endDate, reason }
router.put('/:id/subscription', requireAuth, requireRole('SUPERADMIN'), asyncHandler(async (req, res) => {
    const orgId = parseInt(req.params.id, 10);
    const org = await organizations.findById(orgId);
    if (!org) throw AppError.notFound('Organisation introuvable.');

    const body = req.body || {};
    const planRef = body.planId !== undefined && body.planId !== null && body.planId !== ''
        ? body.planId
        : (body.planCode !== undefined && body.planCode !== '' ? body.planCode : null);
    if (!planRef) throw AppError.badRequest('Un plan est requis (planId ou planCode).');

    const sub = await subscriptionService.changePlan(orgId, {
        planId: planRef,
        status: body.status,
        startDate: body.startDate,
        endDate: body.endDate,
        changedBy: req.user.id,
        reason: body.reason,
    });
    res.json(sub);
}));

// Activer l'abonnement d'un client (fin de l'essai -> ACTIVE, durée = plan).
router.post('/:id/subscription/activate', requireAuth, requireRole('SUPERADMIN'), asyncHandler(async (req, res) => {
    const orgId = parseInt(req.params.id, 10);
    const org = await organizations.findById(orgId);
    if (!org) throw AppError.notFound('Organisation introuvable.');

    const body = req.body || {};
    const planRef = body.planId !== undefined && body.planId !== null && body.planId !== ''
        ? body.planId : undefined;

    const sub = await subscriptionService.activate(orgId, {
        planId: planRef,
        changedBy: req.user.id,
        reason: body.reason,
    });
    res.json(sub);
}));

// Renouvellement manuel de l'abonnement (préparé pour les futurs paiements).
router.post('/:id/subscription/renew', requireAuth, requireRole('SUPERADMIN'), asyncHandler(async (req, res) => {
    const orgId = parseInt(req.params.id, 10);
    const org = await organizations.findById(orgId);
    if (!org) throw AppError.notFound('Organisation introuvable.');

    const body = req.body || {};
    const planRef = body.planId !== undefined && body.planId !== null && body.planId !== ''
        ? body.planId : undefined;

    const sub = await subscriptionService.renew(orgId, {
        planId: planRef,
        changedBy: req.user.id,
        reason: body.reason,
    });
    res.json(sub);
}));

// Résilier l'abonnement d'un client.
router.post('/:id/subscription/cancel', requireAuth, requireRole('SUPERADMIN'), asyncHandler(async (req, res) => {
    const orgId = parseInt(req.params.id, 10);
    const org = await organizations.findById(orgId);
    if (!org) throw AppError.notFound('Organisation introuvable.');

    const sub = await subscriptionService.cancel(orgId, {
        changedBy: req.user.id,
        reason: (req.body || {}).reason,
    });
    res.json(sub);
}));

module.exports = router;
