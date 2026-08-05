const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { users, organizations } = require('../db/repositories');
const subscriptionService = require('../services/subscriptions');
const { requireAuth, JWT_SECRET } = require('../middleware/auth');
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
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: payload });
}));

router.get('/me', requireAuth, asyncHandler(async (req, res) => {
    const user = await users.findById(req.user.organizationId, req.user.id);
    if (!user) throw AppError.notFound('Utilisateur introuvable.');
    res.json({ user: await safeUser(user) });
}));

module.exports = router;
