const express = require('express');
const bcrypt = require('bcryptjs');
const store = require('../data/store');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// Toutes ces routes sont réservées au SUPERADMIN (compte plateforme, non rattaché
// à une organisation) : c'est lui qui crée les nouveaux clients ("organisations").

router.get('/', requireAuth, requireRole('SUPERADMIN'), (req, res) => {
    const orgs = store.getAll('organizations');
    const users = store.getAll('users');
    const vehicles = store.getAll('vehicles');
    // Petit résumé utile (nombre d'utilisateurs / véhicules) par organisation
    const enriched = orgs.map(org => ({
        ...org,
        userCount: users.filter(u => u.organizationId === org.id).length,
        vehicleCount: vehicles.filter(v => v.organizationId === org.id).length
    }));
    res.json(enriched);
});

router.post('/', requireAuth, requireRole('SUPERADMIN'), (req, res) => {
    const { name, adminUsername, adminPassword, adminName } = req.body || {};
    if (!name || !adminUsername || !adminPassword || !adminName) {
        return res.status(400).json({ error: 'Nom de l\'organisation, et identifiant/mot de passe/nom du premier administrateur requis.' });
    }
    if (adminPassword.length < 6) {
        return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères.' });
    }
    const existingUser = store.getAll('users').find(u => u.username === adminUsername);
    if (existingUser) {
        return res.status(409).json({ error: 'Cet identifiant est déjà utilisé par un autre compte.' });
    }

    // 1. Créer l'organisation
    const org = store.create('organizations', { name, createdAt: new Date().toISOString() });

    // 2. Créer son premier compte Administrateur
    const admin = store.create('users', {
        username: adminUsername,
        passwordHash: bcrypt.hashSync(adminPassword, 10),
        name: adminName,
        role: 'ADMIN',
        title: 'Administrateur',
        organizationId: org.id
    });

    const { passwordHash, ...safeAdmin } = admin;
    res.status(201).json({ organization: org, admin: safeAdmin });
});

router.delete('/:id', requireAuth, requireRole('SUPERADMIN'), (req, res) => {
    const orgId = parseInt(req.params.id);
    // Supprime l'organisation ET toutes les données qui lui appartiennent (irréversible)
    const collections = ['users', 'vehicles', 'drivers', 'reservations', 'maintenances', 'incidents', 'accidents', 'fuelLogs'];
    collections.forEach(col => {
        const items = store.getAll(col).filter(i => i.organizationId === orgId);
        items.forEach(i => store.remove(col, i.id));
    });
    const ok = store.remove('organizations', orgId);
    if (!ok) return res.status(404).json({ error: 'Organisation introuvable.' });
    res.status(204).end();
});

// Liste des utilisateurs d'un client donné (pour que le superadmin puisse
// choisir à qui réinitialiser le mot de passe en cas de perte)
router.get('/:id/users', requireAuth, requireRole('SUPERADMIN'), (req, res) => {
    const orgId = parseInt(req.params.id);
    const org = store.getById('organizations', orgId);
    if (!org) return res.status(404).json({ error: 'Organisation introuvable.' });

    const users = store.getAll('users')
        .filter(u => u.organizationId === orgId)
        .map(({ passwordHash, ...safe }) => safe);
    res.json(users);
});

// Réinitialisation du mot de passe d'un utilisateur d'un client (dépannage,
// ex: le client a oublié son mot de passe et ne peut plus se connecter)
router.patch('/:id/users/:userId/reset-password', requireAuth, requireRole('SUPERADMIN'), (req, res) => {
    const orgId = parseInt(req.params.id);
    const userId = parseInt(req.params.userId);
    const { newPassword } = req.body || {};

    if (!newPassword || newPassword.length < 6) {
        return res.status(400).json({ error: 'Le nouveau mot de passe doit contenir au moins 6 caractères.' });
    }

    const user = store.getById('users', userId);
    if (!user || user.organizationId !== orgId) {
        return res.status(404).json({ error: 'Utilisateur introuvable pour ce client.' });
    }

    store.update('users', userId, { passwordHash: bcrypt.hashSync(newPassword, 10) });
    res.json({ success: true, username: user.username });
});

module.exports = router;
