const express = require('express');
const bcrypt = require('bcryptjs');
const { users } = require('../db/repositories');
const { requireAuth, requireRole } = require('../middleware/auth');
const { validateUser, VALID_ROLES } = require('../utils/validators');
const { config } = require('../config');
const { enforceUserLimit } = require('../services/subscriptions');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');

const router = express.Router();

function safeUser(u) {
    const { passwordHash, ...safe } = u;
    return safe;
}

function requireOrg(req, res, next) {
    if (!req.user.organizationId) {
        return res.status(403).json({ error: 'Cette ressource nécessite un compte rattaché à une organisation.' });
    }
    next();
}

function defaultTitle(role) {
    return role === 'ADMIN' ? 'Administrateur' : role === 'MANAGER' ? 'Gestionnaire de Flotte' : 'Conducteur';
}

// Liste des utilisateurs de MA organisation (tous les rôles connectés peuvent voir leurs collègues)
router.get('/', requireAuth, requireOrg, asyncHandler(async (req, res) => {
    const list = await users.findAllByOrg(req.user.organizationId);
    res.json(list.map(safeUser));
}));

// Créer un utilisateur dans MA organisation (Admin uniquement).
// Bloqué si le plan de l'organisation a atteint sa limite d'utilisateurs.
router.post('/', requireAuth, requireOrg, requireRole('ADMIN'), asyncHandler(async (req, res) => {
    const data = validateUser(req.body || {});
    await enforceUserLimit(req.user.organizationId);
    const existing = await users.findByUsername(data.username);
    if (existing) {
        throw AppError.conflict('Cet identifiant est déjà utilisé.');
    }
    const created = await users.create({
        username: data.username,
        passwordHash: bcrypt.hashSync(data.password, config.bcryptRounds),
        name: data.name,
        role: data.role,
        title: data.title || defaultTitle(data.role),
        organizationId: req.user.organizationId,
    });
    res.status(201).json(safeUser(created));
}));

// Modifier un utilisateur de MA organisation (Admin uniquement). Le mot de passe
// n'est changé que si un nouveau est explicitement fourni.
router.put('/:id', requireAuth, requireOrg, requireRole('ADMIN'), asyncHandler(async (req, res) => {
    const existing = await users.findById(req.user.organizationId, req.params.id);
    if (!existing) throw AppError.notFound('Utilisateur introuvable.');

    const data = validateUser(req.body || {}, { partial: true });

    if (data.username && data.username !== existing.username) {
        const clash = await users.findByUsername(data.username);
        if (clash) throw AppError.conflict('Cet identifiant est déjà utilisé.');
    }

    // Même garde que la suppression : l'organisation ne doit jamais perdre son
    // dernier administrateur (une rétrogradation par PUT contournerait le
    // contrôle appliqué sur DELETE).
    if (data.role && data.role !== existing.role && existing.role === 'ADMIN') {
        const adminCount = await users.countAdminsInOrg(req.user.organizationId);
        if (adminCount <= 1) {
            throw AppError.badRequest('Impossible de rétrograder le dernier administrateur de l\'organisation.');
        }
    }

    const changes = {
        username: data.username ?? existing.username,
        name: data.name ?? existing.name,
        role: data.role ?? existing.role,
        title: data.title ?? existing.title,
    };
    if (data.password) {
        changes.passwordHash = bcrypt.hashSync(data.password, config.bcryptRounds);
    }
    const updated = await users.update(req.user.organizationId, req.params.id, changes);
    res.json(safeUser(updated));
}));

// Supprimer un utilisateur de MA organisation (Admin uniquement, jamais soi-même,
// jamais le dernier administrateur restant)
router.delete('/:id', requireAuth, requireOrg, requireRole('ADMIN'), asyncHandler(async (req, res) => {
    const existing = await users.findById(req.user.organizationId, req.params.id);
    if (!existing) throw AppError.notFound('Utilisateur introuvable.');

    if (existing.id === req.user.id) {
        throw AppError.badRequest('Vous ne pouvez pas supprimer votre propre compte.');
    }
    if (existing.role === 'ADMIN') {
        const otherAdmins = await users.countAdminsInOrg(req.user.organizationId);
        if (otherAdmins <= 1) {
            throw AppError.badRequest('Impossible de supprimer le dernier administrateur de l\'organisation.');
        }
    }
    await users.remove(req.user.organizationId, req.params.id);
    res.status(204).end();
}));

module.exports = router;
