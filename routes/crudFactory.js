const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');

/**
 * Crée un routeur CRUD standard pour un repository PostgreSQL, cloisonné par
 * organisation (multi-tenant) : chaque utilisateur ne voit et ne modifie que
 * les données de sa propre organisation (req.user.organizationId).
 *
 * @param {object} repo - repository (findAllByOrg, findById, create, update, remove)
 * @param {object} options
 *   - writeRoles: rôles autorisés à créer/modifier (défaut: tous les rôles connectés)
 *   - deleteRoles: rôles autorisés à supprimer (défaut: identique à writeRoles)
 *   - validate(body, { partial }) -> valide et nettoie le corps (utils/validators)
 *   - beforeCreate(body, req) -> modifie le corps avant validation
 *   - beforeUpdate(id, body, req) -> idem, pour la modification
 */
function makeCrudRouter(repo, options = {}) {
    const router = express.Router();
    const writeRoles = options.writeRoles || ['ADMIN', 'MANAGER', 'DRIVER'];
    const deleteRoles = options.deleteRoles || writeRoles;
    const validate = options.validate || ((body) => body);

    // Un SUPERADMIN n'appartient à aucune organisation : ces routes "métier"
    // lui sont fermées — il gère uniquement /api/organizations et /api/users.
    function requireOrg(req, res, next) {
        if (!req.user.organizationId) {
            return res.status(403).json({ error: 'Cette ressource nécessite un compte rattaché à une organisation.' });
        }
        next();
    }

    router.get('/', requireAuth, requireOrg, asyncHandler(async (req, res) => {
        const items = await repo.findAllByOrg(req.user.organizationId);
        res.json(items);
    }));

    router.get('/:id', requireAuth, requireOrg, asyncHandler(async (req, res) => {
        const item = await repo.findById(req.user.organizationId, req.params.id);
        if (!item) throw AppError.notFound('Introuvable.');
        res.json(item);
    }));

    router.post('/', requireAuth, requireOrg, requireRole(...writeRoles), asyncHandler(async (req, res) => {
        let body = req.body || {};
        if (options.beforeCreate) body = options.beforeCreate(body, req) || body;
        // L'organisation est toujours imposée par le serveur (jamais par le client)
        body = validate(body);
        const item = await repo.create(req.user.organizationId, body);
        res.status(201).json(item);
    }));

    router.put('/:id', requireAuth, requireOrg, requireRole(...writeRoles), asyncHandler(async (req, res) => {
        let body = req.body || {};
        if (options.beforeUpdate) body = options.beforeUpdate(req.params.id, body, req) || body;
        body = validate(body, { partial: true });
        const item = await repo.update(req.user.organizationId, req.params.id, body);
        if (!item) throw AppError.notFound('Introuvable.');
        res.json(item);
    }));

    router.delete('/:id', requireAuth, requireOrg, requireRole(...deleteRoles), asyncHandler(async (req, res) => {
        const ok = await repo.remove(req.user.organizationId, req.params.id);
        if (!ok) throw AppError.notFound('Introuvable.');
        res.status(204).end();
    }));

    return router;
}

module.exports = makeCrudRouter;
