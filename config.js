require('dotenv').config();

function parseIntEnv(name, fallback) {
    const value = parseInt(process.env[name], 10);
    return Number.isNaN(value) ? fallback : value;
}

// Secrets connus qui ne doivent JAMAIS être utilisés en production.
const WEAK_JWT_SECRETS = [
    'change-moi-en-production-asadiya-flotte-pro',
    'change-moi',
    'changeme',
    'secret',
    'password',
];

/**
 * Parse CORS_ORIGIN : une liste de valeurs séparées par des virgules
 * (ex: "https://flotte.example.com,https://admin.example.com").
 * Retourne un tableau d'origines normalisées (sans slash final, minuscules).
 */
function parseCorsOrigins(raw) {
    return String(raw || '*')
        .split(',')
        .map((o) => o.trim())
        .filter((o) => o !== '')
        .map((o) => (o === '*' ? '*' : o.replace(/\/+$/, '').toLowerCase()));
}

function normalizeCorsOrigins(list) {
    return list.map((o) => (o === '*' ? '*' : o.replace(/\/+$/, '').toLowerCase()));
}

const config = {
    nodeEnv: process.env.NODE_ENV || 'development',
    port: parseIntEnv('PORT', 4000),

    // PostgreSQL
    databaseUrl: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/asadiya_flotte',
    dbSsl: process.env.DB_SSL === 'true',
    dbConnectionTimeoutMs: parseIntEnv('DB_CONNECTION_TIMEOUT_MS', 10000),
    dbIdleTimeoutMs: parseIntEnv('DB_IDLE_TIMEOUT_MS', 30000),

    // Authentification
    jwtSecret: process.env.JWT_SECRET || '',
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
    bcryptRounds: parseIntEnv('BCRYPT_ROUNDS', 10),

    // HTTP
    jsonLimit: process.env.JSON_LIMIT || '15mb',
    corsOrigin: process.env.CORS_ORIGIN || '*',
    // Liste d'origines autorisées (CORS_ORIGIN peut contenir plusieurs valeurs
    // séparées par des virgules). En développement, '*' autorise tout.
    corsOrigins: normalizeCorsOrigins(parseCorsOrigins(process.env.CORS_ORIGIN || '*')),

    // Reverse proxy : nombre de sauts de proxy de confiance pour la lecture de
    // l'adresse IP réelle du client (requis derrière nginx/Caddy pour le rate limiting).
    trustProxy: process.env.TRUST_PROXY ? parseIntEnv('TRUST_PROXY', 0) : 0,

    // Protection anti-DoS et anti force brute (rate limiting, compteur par IP).
    // Fenêtre et nombre maximum de requêtes globales sur l'API.
    rateLimitWindowMs: parseIntEnv('RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000),
    rateLimitMax: parseIntEnv('RATE_LIMIT_MAX', 300),
    // Limite stricte sur la connexion / l'inscription (échecs uniquement).
    loginRateLimitWindowMs: parseIntEnv('LOGIN_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000),
    loginRateLimitMax: parseIntEnv('LOGIN_RATE_LIMIT_MAX', 20),

    // Revenu récurrent estimé (MRR) : prix mensuel par véhicule utilisé comme
    // fallback quand un client n'a pas encore d'abonnement explicite.
    platformPricePerVehicle: parseIntEnv('PLATFORM_PRICE_PER_VEHICLE', 5000),

    // Abonnements SaaS
    // Durée de la période d'essai accordée aux nouveaux clients (en jours).
    trialDays: parseIntEnv('TRIAL_DAYS', 14),

    // Paiement : architecture préparée pour les futurs intégrations.
    // Aucun paiement n'est encore traité : ces champs sont des placeholders.
    billing: {
        // provider: 'none' | 'wave' | 'orange_money' | 'stripe'
        provider: process.env.BILLING_PROVIDER || 'none',
        wave: {
            apiUrl: process.env.WAVE_API_URL || '',
            secret: process.env.WAVE_API_SECRET || '',
        },
        orangeMoney: {
            apiUrl: process.env.ORANGE_MONEY_API_URL || '',
            clientId: process.env.ORANGE_MONEY_CLIENT_ID || '',
            clientSecret: process.env.ORANGE_MONEY_CLIENT_SECRET || '',
        },
        stripe: {
            secretKey: process.env.STRIPE_SECRET_KEY || '',
            webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
            pricePrefix: process.env.STRIPE_PRICE_PREFIX || 'asadiya_',
        },
    },
};

/**
 * Vérifie que la configuration est sûre pour la production.
 * À appeler au démarrage, avant de lancer le serveur.
 * Refuse de démarrer si une valeur critique est absente, trop faible ou connue.
 */
function assertProductionConfig() {
    if (config.nodeEnv !== 'production') return;

    const failures = [];

    if (!config.jwtSecret || config.jwtSecret.length < 32) {
        failures.push('JWT_SECRET doit être défini (au moins 32 caractères aléatoires) en production.');
    } else if (WEAK_JWT_SECRETS.includes(config.jwtSecret)) {
        failures.push('JWT_SECRET est un secret de démonstration connu : remplacez-le par une chaîne aléatoire.');
    }

    // CORS : '*' (tout autoriser) est inacceptable en production.
    if (config.corsOrigins.includes('*')) {
        failures.push(
            'CORS_ORIGIN est défini sur "*" : indiquez la liste exacte des origines autorisées (ex: https://flotte.example.com).'
        );
    } else if (config.corsOrigins.length === 0) {
        failures.push('CORS_ORIGIN est vide : indiquez au moins une origine autorisée en production.');
    }

    // Base de données : pas de valeur par défaut locale en production.
    if (!process.env.DATABASE_URL) {
        failures.push('DATABASE_URL est obligatoire en production (pas de valeur par défaut).');
    }

    if (failures.length > 0) {
        throw new Error(
            'Configuration de production invalide :\n- ' + failures.join('\n- ')
        );
    }
}

module.exports = { config, assertProductionConfig };
