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
const { createTtlCache } = require('../utils/ttlCache');
const { config } = require('../config');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const analytics = require('../db/analytics');

const router = express.Router();

// Cache TTL des vues analytics (Phase 6.3) : chaque vue recharge les 7 tables
// de l'organisation puis recalcule scores/classements. Le tableau de bord
// sollicite /overview à chaque chargement ; le cache évite ce travail répété
// pendant la fenêtre TTL (réponses JSON strictement identiques en forme).
// Les écritures (CRUD véhicules, relevés…) restent immédiates : sans
// invalidation wire-to-wire, la fraîcheur maximale est donc la TTL.
const analyticsCache = createTtlCache({ ttlMs: config.cacheTtlMs, maxEntries: 500 });

async function cachedJson(req, res, key, compute) {
    if (config.cacheEnabled) {
        const cached = analyticsCache.get(key);
        if (cached !== undefined) return res.json(cached);
        const value = await compute();
        analyticsCache.set(key, value);
        return res.json(value);
    }
    res.json(await compute());
}

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
    const key = `analytics:overview:${req.user.organizationId}:${period}`;
    await cachedJson(req, res, key, () => analytics.getOverview(req.user.organizationId, period));
}));

// Fiche analytique d'un véhicule (Risk Score, santé, finances, historique).
router.get('/vehicles/:id', requireAuth, requireOrgUser, asyncHandler(async (req, res) => {
    const vehicleId = parseInt(req.params.id, 10);
    if (Number.isNaN(vehicleId)) throw AppError.badRequest('Identifiant de véhicule invalide.');
    const key = `analytics:vehicle:${req.user.organizationId}:${vehicleId}`;
    await cachedJson(req, res, key, () => analytics.getVehicleAnalytics(req.user.organizationId, vehicleId));
}));

// Scores et classements des conducteurs.
router.get('/drivers', requireAuth, requireOrgUser, asyncHandler(async (req, res) => {
    const key = `analytics:drivers:${req.user.organizationId}`;
    await cachedJson(req, res, key, () => analytics.getDriverAnalytics(req.user.organizationId));
}));

// Statistiques globales de la plateforme (SuperAdmin uniquement).
router.get('/superadmin/stats', requireAuth, requireRole('SUPERADMIN'), asyncHandler(async (req, res) => {
    await cachedJson(req, res, 'analytics:superadmin:stats', () => analytics.getSuperAdminStats());
}));

module.exports = router;
