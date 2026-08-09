require('dotenv').config({ quiet: true });
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
const { requestContext } = require('./middleware/requestContext');
const monitoringRouter = require('./routes/monitoring');
const { startPerformanceReporter } = require('./monitoring/performance');
const documentFiles = require('./services/documentFiles');
const logger = require('./utils/logger');

assertProductionConfig();

const app = express();

// ===== Erreurs fatales du processus =====
// Une exception non interceptée ou une promesse non gérée laisse le
// processus dans un état inconnu : on journalise puis on quitte (fail fast),
// pour que l'orchestrateur (Docker, systemd) redémarre un processus sain.
process.on('uncaughtException', (err) => {
    logger.error('process.uncaught_exception', {
        message: err && err.message ? err.message : String(err),
        stack: err && err.stack ? err.stack : undefined,
    });
    process.exit(1);
});
process.on('unhandledRejection', (reason) => {
    logger.error('process.unhandled_rejection', {
        message: reason && reason.message ? reason.message : String(reason),
    });
    process.exit(1);
});

// Adresse IP réelle du client derrière un reverse proxy (nginx/Caddy).
// Requis pour que le rate limiting compte correctement par IP.
app.set('trust proxy', config.trustProxy);

// Ne jamais divulguer la technologie du serveur.
app.disable('x-powered-by');

// ===== En-têtes de sécurité (Helmet, Phase 4.3) =====
// HSTS : HTTPS obligatoire pendant 2 ans, y compris les sous-domaines.
//   ⚠️ À activer uniquement quand le TLS est effectivement en place derrière
//   le reverse proxy ; « preload » nécessite une soumission au registre HSTS.
// X-Frame-Options DENY (cohérent avec frame-ancestors 'none' : aucun iframe).
// Cross-Origin-Embedder-Policy désactivé : requis pour que le Play CDN de
//   Tailwind et les autres CDN continuent de se charger côté navigateur.
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
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    hsts: { maxAge: 63072000, includeSubDomains: true, preload: true },
    referrerPolicy: { policy: 'no-referrer' },
    xFrameOptions: { action: 'DENY' },
    hidePoweredBy: true,
    noSniff: true,
    dnsPrefetchControl: { allow: false },
    ieNoOpen: true,
    originAgentCluster: true,
    permittedCrossDomainPolicies: { permittedPolicies: 'none' },
    xssFilter: true,
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

// Contexte de requête (Phase 6.2) : requestId / correlationId attribués à
// CHAQUE requête (y compris statiques), exposés via l'en-tête X-Request-Id.
// Doit être enregistré avant la journalisation des requêtes.
app.use(requestContext);

// Journal d'accès HTTP : une ligne structurée par requête (méthode, statut,
// durée, IP, requestId, correlationId, utilisateur, organisation).
app.use(logger.requestLogger);

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
app.use(express.json({
    limit: config.jsonLimit,
    // Capture le corps BRUT (Buffer) : requis pour vérifier la signature
    // HMAC-SHA256 des webhooks Wave (calculée sur la chaîne exacte reçue).
    verify(req, res, buf) {
        req.rawBody = buf;
    },
}));

// ===== PROTECTION (Phase 4.1) =====
// Limite globale anti-DoS sur toute l'API (compteur par IP).
app.use('/api', apiLimiter);
// Protection anti force brute : échecs de connexion / d'inscription limités.
app.use('/api/auth/login', loginLimiter);
app.use('/api/auth/signup', loginLimiter);

// ===== ROUTES API =====
app.use('/api/auth', require('./routes/auth'));
// Ressource client : authentification puis contrôle d'abonnement.
// Les lectures restent autorisées ; les écritures sont bloquées si
// l'abonnement est EXPIRED / CANCELLED (voir middleware/subscriptionGuard).
app.use('/api/vehicles', requireAuth, subscriptionGuard, require('./routes/vehicles'));
app.use('/api/drivers', requireAuth, subscriptionGuard, require('./routes/drivers'));
app.use('/api/reservations', requireAuth, subscriptionGuard, require('./routes/reservations'));
app.use('/api/maintenances', requireAuth, subscriptionGuard, require('./routes/maintenances'));
app.use('/api/incidents', requireAuth, subscriptionGuard, require('./routes/incidents'));
app.use('/api/accidents', requireAuth, subscriptionGuard, require('./routes/accidents'));
app.use('/api/fuel-logs', requireAuth, subscriptionGuard, require('./routes/fuel'));
app.use('/api/documents', requireAuth, subscriptionGuard, require('./routes/documents'));
app.use('/api/users', requireAuth, subscriptionGuard, require('./routes/users'));
app.use('/api/organizations', require('./routes/organizations'));
app.use('/api/plans', require('./routes/plans'));
app.use('/api/subscriptions', require('./routes/subscriptions'));
app.use('/api/analytics', require('./routes/analytics'));
// Paiements (Phase 5.1) : simulation locale, aucun appel externe. Les
// webhooks fournisseurs sont publics ; le reste exige une authentification.
app.use('/api/payments', require('./routes/paymentsGateway'));

// Supervision (Phase 6.2) : health checks avancés + métriques JSON.
// /api/health (léger), /api/health/live, /api/health/ready,
// /api/health/details et /api/metrics — aucune donnée confidentielle.
app.use('/api', monitoringRouter);

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
        if (count > 0) logger.info('subscriptions.marked_expired', { count });
    } catch (err) {
        logger.error('subscriptions.expiry_check_failed', { message: err.message });
    }
}

async function start() {
    try {
        // Répertoire de stockage des pièces jointes (uploads) : créé au
        // démarrage, requis avant toute écriture de fichier.
        documentFiles.ensureBaseDir();

        // Crée automatiquement les tables au démarrage (idempotent)
        await migrate();
        logger.info('db.migrated');

        // Contrôle des abonnements expirés au démarrage puis périodiquement.
        await refreshExpiredSubscriptions();
        setInterval(refreshExpiredSubscriptions, EXPIRY_CHECK_INTERVAL_MS);

        // Rapport de performance périodique (Phase 6.2). Actif par défaut en
        // production (15 min), configurable via PERF_REPORT_INTERVAL_MS (0 = off).
        const perfIntervalRaw = process.env.PERF_REPORT_INTERVAL_MS;
        const perfIntervalMs = perfIntervalRaw
            ? parseInt(perfIntervalRaw, 10) || 0
            : config.nodeEnv === 'production'
                ? 15 * 60 * 1000
                : 0;
        startPerformanceReporter({ intervalMs: perfIntervalMs });

        const server = app.listen(config.port, () => {
            logger.info('server.started', {
                port: config.port,
                env: config.nodeEnv,
                url: `http://localhost:${config.port}`,
            });
        });

        const shutdown = (signal) => {
            logger.info('server.shutdown', { signal });
            server.close(async () => {
                await pool.end().catch(() => {});
                process.exit(0);
            });
        };
        process.on('SIGINT', () => shutdown('SIGINT'));
        process.on('SIGTERM', () => shutdown('SIGTERM'));
    } catch (err) {
        logger.error('server.startup_failed', {
            message: err.message,
            hint: 'Vérifiez DATABASE_URL et la disponibilité de PostgreSQL.',
        });
        process.exit(1);
    }
}

start();
