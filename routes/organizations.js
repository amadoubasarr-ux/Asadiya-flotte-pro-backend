const express = require('express');
const bcrypt = require('bcryptjs');
const { users, organizations } = require('../db/repositories');
const { requireAuth, requireRole } = require('../middleware/auth');
const { validateOrganization } = require('../utils/validators');
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

    // Création atomique : l'organisation + son premier compte Administrateur.
    const result = await organizations.createWithAdmin({
        name: data.name,
        adminName: data.adminName,
        adminUsername: data.adminUsername,
        adminPasswordHash: bcrypt.hashSync(data.adminPassword, 10),
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

    await users.update(orgId, userId, { passwordHash: bcrypt.hashSync(String(newPassword), 10) });
    res.json({ success: true, username: user.username });
}));

module.exports = router;
