require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');

const { config, assertProductionConfig } = require('./config');
const { migrate } = require('./db/migrate');
const { pool } = require('./db/pool');
const { subscriptions } = require('./db/subscriptions');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');

assertProductionConfig();

const app = express();

// En-têtes de sécurité (HSTS, X-Content-Type-Options, CSP, ...)
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            'default-src': ["'self'"],
            // 'unsafe-eval' est requis par Alpine.js (évalue ses expressions avec new Function)
            // et par le Play CDN de Tailwind (compilation JIT côté navigateur).
            // Les scripts inline sont interdits : le code applicatif vit dans app.js.
            'script-src': [
                "'self'",
                "'unsafe-eval'",
                'https://cdn.tailwindcss.com',
                'https://cdn.jsdelivr.net',
                'https://cdnjs.cloudflare.com',
            ],
            // 'unsafe-inline' en style uniquement : <style> inline du HTML,
            // attributs :style d'Alpine et CSS généré par Tailwind au runtime.
            'style-src': [
                "'self'",
                "'unsafe-inline'",
                'https://cdnjs.cloudflare.com',
                'https://fonts.googleapis.com',
            ],
            'font-src': [
                "'self'",
                'https://cdnjs.cloudflare.com',
                'https://fonts.gstatic.com',
                'data:',
            ],
            'img-src': ["'self'", 'data:', 'blob:'],
            'connect-src': ["'self'", 'https://cdn.tailwindcss.com'],
            'object-src': ["'none'"],
            'base-uri': ["'self'"],
            'form-action': ["'self'"],
            'frame-ancestors': ["'none'"],
            // Désactivé : le frontend est servi en http (développement local).
            // Sinon le navigateur forcerait /api/... vers https et casserait l'API.
            'upgrade-insecure-requests': null,
        },
    },
}));

// CORS : origine restreinte en production, ouvert en développement.
app.use(cors({
    origin: config.nodeEnv === 'production' ? config.corsOrigin : true,
}));

// Augmenté pour accepter les photos encodées en base64 dans les payloads JSON
app.use(express.json({ limit: config.jsonLimit }));

// ===== ROUTES API =====
app.use('/api/auth', require('./routes/auth'));
app.use('/api/vehicles', require('./routes/vehicles'));
app.use('/api/drivers', require('./routes/drivers'));
app.use('/api/reservations', require('./routes/reservations'));
app.use('/api/maintenances', require('./routes/maintenances'));
app.use('/api/incidents', require('./routes/incidents'));
app.use('/api/accidents', require('./routes/accidents'));
app.use('/api/fuel-logs', require('./routes/fuel'));
app.use('/api/organizations', require('./routes/organizations'));
app.use('/api/users', require('./routes/users'));
app.use('/api/plans', require('./routes/plans'));
app.use('/api/subscriptions', require('./routes/subscriptions'));
app.use('/api/analytics', require('./routes/analytics'));

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
});

// Route API inconnue -> 404 JSON (plutôt qu'un fallback HTML)
app.use('/api', notFoundHandler);

// ===== SERT LE FRONTEND (fichier statique index.html) =====
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Gestion d'erreurs centralisée (AppError, erreurs PostgreSQL, JSON invalide)
app.use(errorHandler);

// Bascule périodique des abonnements échus en EXPIRED (toutes les 6 heures).
const EXPIRY_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
async function refreshExpiredSubscriptions() {
    try {
        const count = await subscriptions.markExpired();
        if (count > 0) console.log(`[abonnements] ${count} abonnement(s) passé(s) en EXPIRED.`);
    } catch (err) {
        console.error('[abonnements] Erreur lors du contrôle des expirations:', err.message);
    }
}

async function start() {
    try {
        // Crée automatiquement les tables au démarrage (idempotent)
        await migrate();
        console.log('[db] Schéma PostgreSQL prêt.');

        // Contrôle des abonnements expirés au démarrage puis périodiquement.
        await refreshExpiredSubscriptions();
        setInterval(refreshExpiredSubscriptions, EXPIRY_CHECK_INTERVAL_MS);

        const server = app.listen(config.port, () => {
            console.log(`✅ Asadiya Flotte PRO — API démarrée sur http://localhost:${config.port}`);
        });

        const shutdown = (signal) => {
            console.log(`\n[server] ${signal} reçu, arrêt propre...`);
            server.close(async () => {
                await pool.end().catch(() => {});
                process.exit(0);
            });
        };
        process.on('SIGINT', () => shutdown('SIGINT'));
        process.on('SIGTERM', () => shutdown('SIGTERM'));
    } catch (err) {
        console.error('[db] Impossible de se connecter à PostgreSQL. Vérifiez DATABASE_URL.');
        console.error(err.message);
        process.exit(1);
    }
}

start();
