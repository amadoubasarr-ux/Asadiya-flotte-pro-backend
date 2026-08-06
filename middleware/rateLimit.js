// ============================================================
// Rate Limiting (Phase 4.1 — Sécurité)
// ============================================================
// Protection anti force brute sur la connexion / l'inscription et
// limite globale anti-DoS sur toute l'API (compteur par adresse IP).
//
// Le proxy inverse doit être configuré via TRUST_PROXY en production
// pour que l'adresse IP réelle du client soit correctement lue.
// ============================================================
const { rateLimit } = require('express-rate-limit');
const { config } = require('../config');

const standardOptions = {
    standardHeaders: true, // RateLimit-* dans les en-têtes (RFC 6585)
    legacyHeaders: false,
    // L'application se trouve derrière un reverse proxy (nginx/Caddy) en
    // production : le nombre de sauts de confiance est lu depuis TRUST_PROXY.
    // false = pas de proxy, on utilise l'adresse de connexion directe.
    validate: { trustProxy: config.trustProxy ? true : false },
};

// Limite globale sur toutes les routes /api (anti-DoS / anti-abus).
const apiLimiter = rateLimit({
    ...standardOptions,
    windowMs: config.rateLimitWindowMs,
    max: config.rateLimitMax,
    message: {
        error: 'Trop de requêtes. Veuillez réessayer plus tard.',
        code: 'rate_limited',
    },
});

// Limite stricte sur la connexion / l'inscription : seules les tentatives
// ÉCHOUÉES sont comptabilisées (un mot de passe correct ne bloque jamais).
const loginLimiter = rateLimit({
    ...standardOptions,
    windowMs: config.loginRateLimitWindowMs,
    max: config.loginRateLimitMax,
    skipSuccessfulRequests: true,
    message: {
        error: 'Trop de tentatives de connexion. Compte temporairement bloqué. Réessayez plus tard.',
        code: 'login_rate_limited',
    },
});

module.exports = { apiLimiter, loginLimiter };
