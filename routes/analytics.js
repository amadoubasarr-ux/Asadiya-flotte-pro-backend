// ============================================================
// Analytics — Fleet Health Score, Risk Score, classements,
// prévisions et stats plateforme.
//
// /api/analytics/overview        → vue d'ensemble d'une organisation
// /api/analytics/vehicles/:id    → fiche analytique d'un véhicule (Risk Score)
// /api/analytics/drivers         → scores et classements des conducteurs
// /api/analytics/superadmin/stats→ statistiques globales plateforme
// ============================================================
const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const analytics = require('../db/analytics');

const router = express.Router();

// Les routes "organisation" exigent un compte rattaché à une organisation
// (le SUPERADMIN n'a pas d'organizationId et n'accède pas aux vues client).
function requireOrgUser(req, res, next) {
    if (!req.user || !req.user.organizationId) {
        return res.status(403).json({ error: 'Cette vue est réservée aux comptes client (organisation).' });
    }
    next();
}

// Vue d'ensemble : Fleet Health Score + KPIs + graphiques + prévisions + classements.
router.get('/overview', requireAuth, requireOrgUser, asyncHandler(async (req, res) => {
    const period = analytics.normalizePeriod(req.query.period);
    res.json(await analytics.getOverview(req.user.organizationId, period));
}));

// Fiche analytique d'un véhicule (Risk Score, santé, finances, historique).
router.get('/vehicles/:id', requireAuth, requireOrgUser, asyncHandler(async (req, res) => {
    const vehicleId = parseInt(req.params.id, 10);
    if (Number.isNaN(vehicleId)) throw AppError.badRequest('Identifiant de véhicule invalide.');
    res.json(await analytics.getVehicleAnalytics(req.user.organizationId, vehicleId));
}));

// Scores et classements des conducteurs.
router.get('/drivers', requireAuth, requireOrgUser, asyncHandler(async (req, res) => {
    res.json(await analytics.getDriverAnalytics(req.user.organizationId));
}));

// Statistiques globales de la plateforme (SuperAdmin uniquement).
router.get('/superadmin/stats', requireAuth, requireRole('SUPERADMIN'), asyncHandler(async (req, res) => {
    res.json(await analytics.getSuperAdminStats());
}));

module.exports = router;
