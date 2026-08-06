const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { users, organizations } = require('../db/repositories');
const { plans } = require('../db/subscriptions');
const { validateOrganization } = require('../utils/validators');
const subscriptionService = require('../services/subscriptions');
const { requireAuth, JWT_SECRET } = require('../middleware/auth');
const { config } = require('../config');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');

const router = express.Router();

async function safeUser(u) {
    const { id, username, name, role, title, organizationId } = u;
    let organizationName = null;
    let subscription = null;
    if (organizationId) {
        const org = await organizations.findById(organizationId);
        organizationName = org ? org.name : null;
        // Contexte d'abonnement (plan, statut, usage, limites) pour le frontend.
        subscription = await subscriptionService.getSubscriptionContext(organizationId).catch(() => null);
    }
    return { id, username, name, role, title, organizationId, organizationName, subscription };
}

router.post('/login', asyncHandler(async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
        throw AppError.badRequest('Identifiant et mot de passe requis.');
    }
    const user = await users.findByUsername(username);
    if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
        throw AppError.unauthorized('Identifiants incorrects.');
    }
    const payload = await safeUser(user);
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: config.jwtExpiresIn });
    res.json({ token, user: payload });
}));

router.get('/me', requireAuth, asyncHandler(async (req, res) => {
    const user = await users.findById(req.user.organizationId, req.user.id);
    if (!user) throw AppError.notFound('Utilisateur introuvable.');
    res.json({ user: await safeUser(user) });
}));

// ============================================================
// Inscription libre (tunnel SaaS) — PAS de paiement pour l'instant.
// Crée atomiquement : organisation + premier administrateur
// + abonnement TRIAL (14 jours, plan STARTER par défaut).
// ============================================================
router.post('/signup', asyncHandler(async (req, res) => {
    const data = validateOrganization(req.body || {});

    const existing = await users.findByUsername(data.adminUsername);
    if (existing) {
        throw AppError.conflict('Cet identifiant est déjà utilisé par un autre compte.');
    }

    // Plan de départ (par défaut STARTER, période d'essai).
    let planId = null;
    if (req.body && req.body.planId !== undefined && req.body.planId !== null && req.body.planId !== '') {
        const plan = await plans.findByCodeOrId(req.body.planId);
        if (!plan) throw AppError.badRequest('Plan d\'abonnement introuvable.');
        planId = plan.id;
    }

    const result = await organizations.createWithAdmin({
        name: data.name,
        adminName: data.adminName,
        adminUsername: data.adminUsername,
        adminPasswordHash: bcrypt.hashSync(data.adminPassword, 10),
        planId,
    });

    res.status(201).json({
        success: true,
        organization: result.organization,
        admin: result.admin,
        subscription: result.subscription,
    });
}));

module.exports = router;
