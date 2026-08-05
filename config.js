require('dotenv').config();

function parseIntEnv(name, fallback) {
    const value = parseInt(process.env[name], 10);
    return Number.isNaN(value) ? fallback : value;
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
 */
function assertProductionConfig() {
    if (config.nodeEnv === 'production') {
        if (!config.jwtSecret || config.jwtSecret.length < 32) {
            throw new Error(
                'JWT_SECRET doit être défini (au moins 32 caractères aléatoires) en production.'
            );
        }
        if (config.corsOrigin === '*') {
            console.warn(
                '[config] CORS est ouvert à toutes les origines : définissez CORS_ORIGIN en production.'
            );
        }
    }
}

module.exports = { config, assertProductionConfig };
