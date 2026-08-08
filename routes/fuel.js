const express = require('express');
const makeCrudRouter = require('./crudFactory');
const { fuelLogs, fuelBudgets } = require('../db/repositories');
const { validateFuelLog } = require('../utils/validators');
const fuelAnalytics = require('../db/fuelAnalytics');
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');

// ============================================================
// Routes carburant (Phase 7.3)
//  - GET    /stats            → KPI, comparaison, graphiques, anomalies, budget
//  - GET    /budgets          → liste des budgets mensuels
//  - POST   /budgets          → création / mise à jour d'un budget (ADMIN, MANAGER)
//  - PUT    /budgets/:id      → mise à jour d'un budget (ADMIN, MANAGER)
//  - DELETE /budgets/:id      → suppression d'un budget (ADMIN, MANAGER)
//  - CRUD standard /          → création, lecture, modification, suppression
//                              de pleins (ADMIN, MANAGER, DRIVER)
// ============================================================

const router = express.Router();

// L'organisation est imposée par le serveur : le SUPERADMIN (sans
// organizationId) n'accède pas aux données carburant d'une organisation.
function requireOrgUser(req, res, next) {
    if (!req.user || !req.user.organizationId) {
        return res.status(403).json({ error: 'Cette ressource nécessite un compte rattaché à une organisation.' });
    }
    next();
}

// ===== Statistiques (KPIs, comparaison, graphiques, anomalies, budget) =====
// Les routes /stats et /budgets sont déclarées AVANT le CRUD générique pour
// ne pas être capturées par le paramètre /:id.
router.get('/stats', requireAuth, requireOrgUser, asyncHandler(async (req, res) => {
    const stats = await fuelAnalytics.getFuelStats(req.user.organizationId, {
        period: req.query.period,
        from: req.query.from,
        to: req.query.to,
    });
    res.json(stats);
}));

// ===== Budgets mensuels =====
// Lecture : tous les comptes rattachés à une organisation (DRIVER inclus).
router.get('/budgets', requireAuth, requireOrgUser, asyncHandler(async (req, res) => {
    const budgets = await fuelBudgets.findAllByOrg(req.user.organizationId);
    res.json(budgets);
}));

// Écriture : réservée aux rôles de gestion (ADMIN, MANAGER). Le budget est
// une décision financière d'entreprise : le DRIVER (saisie des pleins) n'est
// pas autorisé à le modifier. Aucune permission n'est ajoutée sans
// justification : ces routes restreignent uniquement.
router.post('/budgets', requireAuth, requireOrgUser, requireRole('ADMIN', 'MANAGER'), asyncHandler(async (req, res) => {
    const body = req.body || {};
    const month = String(body.month || '').trim();
    const amount = parseFloat(body.amount);
    if (!/^\d{4}-\d{2}$/.test(month)) {
        throw AppError.badRequest('Le champ "month" doit être au format AAAA-MM.');
    }
    if (Number.isNaN(amount) || amount < 0) {
        throw AppError.badRequest('Le champ "amount" doit être un montant positif.');
    }
    const budget = await fuelBudgets.upsert(req.user.organizationId, `${month}-01`, Math.round(amount));
    res.status(201).json(budget);
}));

router.put('/budgets/:id', requireAuth, requireOrgUser, requireRole('ADMIN', 'MANAGER'), asyncHandler(async (req, res) => {
    const body = req.body || {};
    const existing = await fuelBudgets.findById(req.user.organizationId, req.params.id);
    if (!existing) throw AppError.notFound('Budget introuvable.');
    const amount = parseFloat(body.amount !== undefined ? body.amount : existing.amount);
    if (Number.isNaN(amount) || amount < 0) {
        throw AppError.badRequest('Le champ "amount" doit être un montant positif.');
    }
    const budget = await fuelBudgets.upsert(req.user.organizationId, existing.month, Math.round(amount));
    res.json(budget);
}));

router.delete('/budgets/:id', requireAuth, requireOrgUser, requireRole('ADMIN', 'MANAGER'), asyncHandler(async (req, res) => {
    const ok = await fuelBudgets.remove(req.user.organizationId, req.params.id);
    if (!ok) throw AppError.notFound('Budget introuvable.');
    res.status(204).end();
}));

// ===== CRUD standard des pleins (ADMIN, MANAGER, DRIVER) =====
router.use(makeCrudRouter(fuelLogs, {
    writeRoles: ['ADMIN', 'MANAGER', 'DRIVER'],
    deleteRoles: ['ADMIN', 'MANAGER', 'DRIVER'],
    validate: validateFuelLog,
}));

module.exports = router;
