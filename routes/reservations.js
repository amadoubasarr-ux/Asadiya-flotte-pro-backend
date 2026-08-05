const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { reservations } = require('../db/repositories');
const { validateReservation } = require('../utils/validators');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');

const router = express.Router();

function requireOrg(req, res, next) {
    if (!req.user.organizationId) {
        return res.status(403).json({ error: 'Cette ressource nécessite un compte rattaché à une organisation.' });
    }
    next();
}

// Un conducteur ne peut jamais forcer une validation : son statut reste PENDING.
// Seuls Admin & Gestionnaire peuvent demander/accepter directement un statut.
function enforceStatusRole(body, role) {
    if (!body.status) return body;
    if (role === 'ADMIN' || role === 'MANAGER') {
        if (!['PENDING', 'APPROVED', 'REJECTED'].includes(body.status)) {
            throw AppError.badRequest('Statut de réservation invalide.');
        }
        return body;
    }
    return { ...body, status: 'PENDING' };
}

router.get('/', requireAuth, requireOrg, asyncHandler(async (req, res) => {
    res.json(await reservations.findAllByOrg(req.user.organizationId));
}));

router.post('/', requireAuth, requireOrg, asyncHandler(async (req, res) => {
    let body = req.body || {};
    body = enforceStatusRole(body, req.user.role);
    body = validateReservation(body);
    const item = await reservations.create(req.user.organizationId, body);
    res.status(201).json(item);
}));

router.put('/:id', requireAuth, requireOrg, asyncHandler(async (req, res) => {
    let body = req.body || {};
    body = enforceStatusRole(body, req.user.role);
    body = validateReservation(body, { partial: true });
    const item = await reservations.update(req.user.organizationId, req.params.id, body);
    if (!item) throw AppError.notFound('Réservation introuvable.');
    res.json(item);
}));

// Validation d'une réservation : réservée aux Admin & Gestionnaire.
router.patch('/:id/approve', requireAuth, requireOrg, requireRole('ADMIN', 'MANAGER'), asyncHandler(async (req, res) => {
    const item = await reservations.approve(req.user.organizationId, req.params.id);
    if (!item) throw AppError.notFound('Réservation introuvable.');
    res.json(item);
}));

router.delete('/:id', requireAuth, requireOrg, asyncHandler(async (req, res) => {
    const ok = await reservations.remove(req.user.organizationId, req.params.id);
    if (!ok) throw AppError.notFound('Réservation introuvable.');
    res.status(204).end();
}));

module.exports = router;
