const express = require('express');
const store = require('../data/store');
const { requireAuth, requireRole } = require('../middleware/auth');

/**
 * Crée un routeur CRUD standard pour une collection.
 * @param {string} collection - nom de la collection dans db.json
 * @param {object} options
 *   - writeRoles: rôles autorisés à créer/modifier (défaut: tous les rôles connectés)
 *   - deleteRoles: rôles autorisés à supprimer (défaut: identique à writeRoles)
 *   - beforeCreate(body, req) -> peut lever une erreur { status, message } ou modifier body
 *   - beforeUpdate(id, body, req) -> idem, pour la modification
 */
function makeCrudRouter(collection, options = {}) {
    const router = express.Router();
    const writeRoles = options.writeRoles || ['ADMIN', 'MANAGER', 'DRIVER'];
    const deleteRoles = options.deleteRoles || writeRoles;

    router.get('/', requireAuth, (req, res) => {
        res.json(store.getAll(collection));
    });

    router.get('/:id', requireAuth, (req, res) => {
        const item = store.getById(collection, req.params.id);
        if (!item) return res.status(404).json({ error: 'Introuvable.' });
        res.json(item);
    });

    router.post('/', requireAuth, requireRole(...writeRoles), (req, res) => {
        try {
            let body = req.body || {};
            if (options.beforeCreate) {
                body = options.beforeCreate(body, req) || body;
            }
            const item = store.create(collection, body);
            res.status(201).json(item);
        } catch (e) {
            res.status(e.status || 400).json({ error: e.message || 'Erreur lors de la création.', conflict: e.conflict });
        }
    });

    router.put('/:id', requireAuth, requireRole(...writeRoles), (req, res) => {
        try {
            let body = req.body || {};
            if (options.beforeUpdate) {
                body = options.beforeUpdate(req.params.id, body, req) || body;
            }
            const item = store.update(collection, req.params.id, body);
            if (!item) return res.status(404).json({ error: 'Introuvable.' });
            res.json(item);
        } catch (e) {
            res.status(e.status || 400).json({ error: e.message || 'Erreur lors de la modification.', conflict: e.conflict });
        }
    });

    router.delete('/:id', requireAuth, requireRole(...deleteRoles), (req, res) => {
        const ok = store.remove(collection, req.params.id);
        if (!ok) return res.status(404).json({ error: 'Introuvable.' });
        res.status(204).end();
    });

    return router;
}

module.exports = makeCrudRouter;
