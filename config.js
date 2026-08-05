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
