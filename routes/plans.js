const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { plans } = require('../db/subscriptions');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');

const router = express.Router();

// Les plans peuvent être consultés par tout utilisateur authentifié (le
// frontend client affiche le plan courant) ; la gestion est réservée au
// SUPERADMIN (console plateforme).

router.get('/', requireAuth, asyncHandler(async (req, res) => {
    // Un compte client ne voit que les plans actifs ; le SUPERADMIN voit tout.
    const list = req.user.role === 'SUPERADMIN' ? await plans.findAll() : await plans.findAllActive();
    res.json(list);
}));

router.get('/:id', requireAuth, asyncHandler(async (req, res) => {
    const plan = await plans.findById(parseInt(req.params.id, 10));
    if (!plan) throw AppError.notFound('Plan introuvable.');
    if (req.user.role !== 'SUPERADMIN' && !plan.active) {
        throw AppError.notFound('Plan introuvable.');
    }
    res.json(plan);
}));

// ===== Gestion réservée au SUPERADMIN =====

router.post('/', requireAuth, requireRole('SUPERADMIN'), asyncHandler(async (req, res) => {
    const body = req.body || {};
    const code = String(body.code || '').trim().toUpperCase();
    if (!code || !String(body.name || '').trim()) {
        throw AppError.badRequest('Le code et le nom du plan sont obligatoires.');
    }
    const existing = await plans.findByCode(code);
    if (existing) throw AppError.conflict('Un plan avec ce code existe déjà.');

    const plan = await plans.create({
        code,
        name: String(body.name).trim(),
        description: body.description !== undefined ? String(body.description) : null,
        monthlyPrice: Number.isFinite(parseFloat(body.monthlyPrice)) ? Math.max(0, parseFloat(body.monthlyPrice)) : 0,
        durationMonths: Number.isFinite(parseFloat(body.durationMonths)) ? Math.max(1, parseInt(body.durationMonths, 10)) : 1,
        maxVehicles: body.maxVehicles === null || body.maxVehicles === '' ? null : Math.max(1, parseInt(body.maxVehicles, 10) || 0),
        maxUsers: body.maxUsers === null || body.maxUsers === '' ? null : Math.max(1, parseInt(body.maxUsers, 10) || 0),
        features: Array.isArray(body.features) ? body.features : [],
        active: body.active !== false,
    });
    res.status(201).json(plan);
}));

router.put('/:id', requireAuth, requireRole('SUPERADMIN'), asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const existing = await plans.findById(id);
    if (!existing) throw AppError.notFound('Plan introuvable.');

    const body = req.body || {};
    const changes = {};
    if (body.code !== undefined) {
        const code = String(body.code).trim().toUpperCase();
        if (!code) throw AppError.badRequest('Le code du plan ne peut pas être vide.');
        const clash = await plans.findByCode(code);
        if (clash && clash.id !== id) throw AppError.conflict('Un plan avec ce code existe déjà.');
        changes.code = code;
    }
    if (body.name !== undefined) {
        if (!String(body.name).trim()) throw AppError.badRequest('Le nom du plan ne peut pas être vide.');
        changes.name = String(body.name).trim();
    }
    if (body.description !== undefined) changes.description = String(body.description);
    if (body.monthlyPrice !== undefined) changes.monthlyPrice = Math.max(0, parseFloat(body.monthlyPrice) || 0);
    if (body.durationMonths !== undefined) changes.durationMonths = Math.max(1, parseInt(body.durationMonths, 10) || 1);
    if (body.maxVehicles !== undefined) changes.maxVehicles = body.maxVehicles === null || body.maxVehicles === '' ? null : Math.max(1, parseInt(body.maxVehicles, 10) || 0);
    if (body.maxUsers !== undefined) changes.maxUsers = body.maxUsers === null || body.maxUsers === '' ? null : Math.max(1, parseInt(body.maxUsers, 10) || 0);
    if (body.features !== undefined) changes.features = Array.isArray(body.features) ? body.features : [];
    if (body.active !== undefined) changes.active = !!body.active;

    res.json(await plans.update(id, changes));
}));

router.delete('/:id', requireAuth, requireRole('SUPERADMIN'), asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const existing = await plans.findById(id);
    if (!existing) throw AppError.notFound('Plan introuvable.');
    if (await plans.isInUse(id)) {
        throw AppError.conflict('Ce plan est utilisé par des abonnements. Désactivez-le plutôt que de le supprimer.');
    }
    await plans.remove(id);
    res.status(204).end();
}));

module.exports = router;
