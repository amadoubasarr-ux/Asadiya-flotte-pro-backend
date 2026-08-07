// ============================================================
// Asadiya Flotte PRO — Endpoints de supervision (Phase 6.2)
// ============================================================
// GET /api/health            — état de base (léger)
// GET /api/health/live       — liveness (processus vivant)
// GET /api/health/ready      — readiness (PostgreSQL + providers)
// GET /api/health/details    — vue complète (aucun secret)
// GET /api/metrics           — métriques agrégées (aucune donnée confidentielle)
//
// Tous ces endpoints sont PUBLICS (aucune donnée confidentielle n'est
// exposée). Recommandation : restreindre l'accès au réseau de supervision
// via le reverse proxy (voir deploy/monitoring.md).
// ============================================================
const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const {
    healthBasic,
    healthLiveness,
    healthReadiness,
    healthDetails,
} = require('../monitoring/health');
const { buildMetrics } = require('../monitoring/metricsService');

const router = express.Router();

// État de base : rapide et synchrone (utilisé par le HEALTHCHECK Docker).
router.get('/health', (req, res) => {
    res.json(healthBasic());
});

// Liveness : le processus répond.
router.get('/health/live', (req, res) => {
    res.json(healthLiveness());
});

// Readiness : PostgreSQL joignable + état des fournisseurs.
router.get('/health/ready', asyncHandler(async (req, res) => {
    const result = await healthReadiness();
    res.status(result.status === 'ok' ? 200 : 503).json(result);
}));

// Détails complets (aucun secret).
router.get('/health/details', asyncHandler(async (req, res) => {
    res.json(await healthDetails());
}));

// Métriques agrégées.
router.get('/metrics', asyncHandler(async (req, res) => {
    res.json(await buildMetrics());
}));

module.exports = router;
