require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');

const { config, assertProductionConfig } = require('./config');
const { migrate } = require('./db/migrate');
const { pool } = require('./db/pool');
const { subscriptions } = require('./db/subscriptions');
const { requireAuth } = require('./middleware/auth');
const { subscriptionGuard } = require('./middleware/subscriptionGuard');
const { apiLimiter, loginLimiter } = require('./middleware/rateLimit');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');

assertProductionConfig();

const app = express();

// Adresse IP réelle du client derrière un reverse proxy (nginx/Caddy).
// Requis pour que le rate limiting compte correctement par IP.
app.set('trust proxy', config.trustProxy);

// Ne jamais divulguer la technologie du serveur.
app.disable('x-powered-by');

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

// Permissions-Policy : aucune API navigateur sensible n'est nécessaire
// (helmet v8 n'inclut plus ce middleware, il est ajouté manuellement).
app.use((req, res, next) => {
    res.setHeader(
        'Permissions-Policy',
        'camera=(), microphone=(), geolocation=(), payment=(), usb=(), notifications=(), fullscreen=(self)'
    );
    next();
});

// CORS : en production, uniquement les origines listées dans CORS_ORIGIN.
// En développement, l'origine est réfléchie (tout est autorisé).
const isProduction = config.nodeEnv === 'production';
app.use(cors({
    origin: isProduction
        ? (origin, callback) => {
            // Requêtes sans en-tête Origin (curl, serveur-à-serveur) : autorisées.
            if (!origin) return callback(null, true);
            const allowed = config.corsOrigins.some((o) => o === origin);
            // Non autorisée : on laisse la requête passer SANS en-têtes CORS,
            // le navigateur bloquera alors la lecture de la réponse.
            callback(null, allowed);
        }
        : true,
}));

// Augmenté pour accepter les photos encodées en base64 dans les payloads JSON
app.use(express.json({ limit: config.jsonLimit }));

// ===== PROTECTION (Phase 4.1) =====
// Limite globale anti-DoS sur toute l'API (compteur par IP).
app.use('/api', apiLimiter);
// Protection anti force brute : échecs de connexion / d'inscription limités.
app.use('/api/auth/login', loginLimiter);
app.use('/api/auth/signup', loginLimiter);

// ===== ROUTES API =====
app.use('/api/auth', require('./routes/auth'));
// Ressources client : authentification puis contrôle d'abonnement.
// Les lectures restent autorisées ; les écritures sont bloquées si
// l'abonnement est EXPIRED / CANCELLED (voir middleware/subscriptionGuard).
app.use('/api/vehicles', requireAuth, subscriptionGuard, require('./routes/vehicles'));
app.use('/api/drivers', requireAuth, subscriptionGuard, require('./routes/drivers'));
app.use('/api/reservations', requireAuth, subscriptionGuard, require('./routes/reservations'));
app.use('/api/maintenances', requireAuth, subscriptionGuard, require('./routes/maintenances'));
app.use('/api/incidents', requireAuth, subscriptionGuard, require('./routes/incidents'));
app.use('/api/accidents', requireAuth, subscriptionGuard, require('./routes/accidents'));
app.use('/api/fuel-logs', requireAuth, subscriptionGuard, require('./routes/fuel'));
app.use('/api/users', requireAuth, subscriptionGuard, require('./routes/users'));
app.use('/api/organizations', require('./routes/organizations'));
app.use('/api/plans', require('./routes/plans'));
app.use('/api/subscriptions', require('./routes/subscriptions'));
app.use('/api/analytics', require('./routes/analytics'));

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
});

// Route API inconnue -> 404 JSON (plutôt qu'un fallback HTML)
app.use('/api', notFoundHandler);

// ===== SERT LE FRONTEND (fichiers statiques publics UNIQUEMENT) =====
// Seuls index.html et app.js sont exposés. Tout le reste du projet
// (config.js, db/, routes/, data/db.json, node_modules/, .env, logs, tests...)
// reste inaccessible depuis HTTP : évite la fuite du code source, des secrets
// et des données clients.
const PUBLIC_STATIC_FILES = new Set(['/index.html', '/app.js']);

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        return next();
    }
    if (PUBLIC_STATIC_FILES.has(req.path)) {
        return res.sendFile(path.join(__dirname, req.path.replace(/^\/+/, '')));
    }
    return next();
});

// Toute autre requête ne correspondant à aucune route -> 404 JSON propre
// (remplace le 500 renvoyé jusqu'ici pour les chemins inconnus).
app.use(notFoundHandler);

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
