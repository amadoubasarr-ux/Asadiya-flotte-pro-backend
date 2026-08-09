// quiet: true — supprime les messages "injected env ..." de dotenv v17
// (le chargement du .env doit rester silencieux au démarrage).
require('dotenv').config({ quiet: true });

const path = require('path');

function parseIntEnv(name, fallback) {
    const value = parseInt(process.env[name], 10);
    return Number.isNaN(value) ? fallback : value;
}

function parseFloatEnv(name, fallback) {
    const value = parseFloat(process.env[name]);
    return Number.isNaN(value) ? fallback : value;
}

// Parse souple des booléens d'environnement (true/false, 1/0, yes/no, on/off).
function parseBoolEnv(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === null || raw === '') return fallback;
    const v = String(raw).trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(v)) return true;
    if (['false', '0', 'no', 'off'].includes(v)) return false;
    return fallback;
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
    dbSsl: parseBoolEnv('DB_SSL', false),
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

    // ===== Pièces jointes documents (Phase Documentation — Commit 5) =====
    // Répertoire racine de stockage des fichiers. Jamais exposé en statique :
    // l'accès passe toujours par l'API authentifiée (/api/documents/:id/file).
    // Volume Docker persistant « uploads » pour la sauvegarde / restauration VPS.
    uploadsDir: process.env.UPLOADS_DIR || path.join(__dirname, 'uploads'),
    // Taille maximale d'une pièce jointe (octets). Défaut : 10 MB.
    documentMaxFileSize: parseIntEnv('DOCUMENT_MAX_FILE_SIZE', 10 * 1024 * 1024),

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

    // Cache TTL en mémoire (Phase 6.3) : réduit les requêtes SQL et les calculs
    // lourds répétés (plans publics, vues analytics). Aucune dépendance externe.
    // Activé par défaut sauf en environnement de test (fraîcheur garantie pour
    // la suite de tests). CACHE_TTL_MS=0 ou CACHE_ENABLED=false le désactive.
    cacheEnabled: parseBoolEnv('CACHE_ENABLED', (process.env.NODE_ENV || 'development') !== 'test'),
    // Durée de vie par défaut des vues analytics (ms).
    cacheTtlMs: parseIntEnv('CACHE_TTL_MS', 30000),
    // Durée de vie des plans publics (ms) — données quasi statiques.
    plansCacheTtlMs: parseIntEnv('PLANS_CACHE_TTL_MS', 60000),

    // Revenu récurrent estimé (MRR) : prix mensuel par véhicule utilisé comme
    // fallback quand un client n'a pas encore d'abonnement explicite.
    platformPricePerVehicle: parseIntEnv('PLATFORM_PRICE_PER_VEHICLE', 5000),

    // Abonnements SaaS
    // Durée de la période d'essai accordée aux nouveaux clients (en jours).
    trialDays: parseIntEnv('TRIAL_DAYS', 14),

    // Détection des anomalies carburant (Phase 7.3).
    // Tous les seuils sont configurables par environnement ; les valeurs par
    // défaut sont documentées dans db/fuelAnalytics.js (DEFAULT_THRESHOLDS).
    fuel: {
        // Consommation (L/100km) jugée anormalement élevée, en facteur de la
        // consommation moyenne du parc et en valeur absolue (véhicule léger).
        highConsumptionFactor: parseFloatEnv('FUEL_HIGH_CONSUMPTION_FACTOR', 1.5),
        highConsumptionMin: parseFloatEnv('FUEL_HIGH_CONSUMPTION_L100KM', 15),
        // Écart kilométrique (km) entre deux pleins : au-delà => relevé incohérent.
        maxMileageGap: parseIntEnv('FUEL_MAX_MILEAGE_GAP', 5000),
        // Écart kilométrique minimal pour considérer une consommation exploitable.
        minMileageGap: parseIntEnv('FUEL_MIN_MILEAGE_GAP', 1),
        // Quantité (litres) hors des bornes "normales" d'un plein.
        maxLiters: parseFloatEnv('FUEL_MAX_LITERS', 120),
        minLiters: parseFloatEnv('FUEL_MIN_LITERS', 1),
        // Prix/litre jugé anormal (facteur du prix moyen de la période).
        abnormalPriceFactor: parseFloatEnv('FUEL_ABNORMAL_PRICE_FACTOR', 1.3),
        // Deux pleins rapprochés : écart horaire minimal.
        closeFillsHours: parseIntEnv('FUEL_CLOSE_FILLS_HOURS', 12),
        // Coût/km jugé anormal (facteur du coût/km moyen et valeur absolue FCFA/km).
        highCostPerKmFactor: parseFloatEnv('FUEL_HIGH_COST_KM_FACTOR', 1.5),
        maxCostPerKm: parseFloatEnv('FUEL_MAX_COST_KM', 120),
    },

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

    // Paiement (Phase 5.1 — architecture ; Phase 5.2 — Wave connecté).
    payment: {
        // Fournisseur actif : 'mock' (simulation locale, défaut sûr).
        // 'wave' est implémenté (Phase 5.2) ; 'orange_money' et 'stripe'
        // lèvent encore "Provider not implemented".
        provider: process.env.PAYMENT_PROVIDER || 'mock',
        // Délai maximal (ms) accordé à un paiement avant passage en EXPIRED.
        timeoutMs: parseIntEnv('PAYMENT_TIMEOUT', 120000),
        // Secret partagé vérifié sur les webhooks entrants (x-webhook-secret).
        // Requis en production dès qu'un fournisseur réel est activé.
        webhookSecret: process.env.PAYMENT_WEBHOOK_SECRET || '',
        // Activation des fournisseurs réels (désactivés par défaut).
        enabled: {
            wave: parseBoolEnv('WAVE_ENABLED', false),
            orangeMoney: parseBoolEnv('ORANGE_ENABLED', false),
            stripe: parseBoolEnv('STRIPE_ENABLED', false),
        },
        // Configuration Wave Money (Phase 5.2).
        wave: {
            // URL de base de l'API Wave (production : https://api.wave.com).
            apiUrl: process.env.WAVE_API_URL || 'https://api.wave.com',
            // Clé API (Authorization: Bearer wave_sn_...).
            apiKey: process.env.WAVE_API_KEY || '',
            // Secret de signature des requêtes (optionnel, si le request
            // signing est activé sur la clé API : wave_sn_AKS_...).
            apiSecret: process.env.WAVE_API_SECRET || '',
            // Secret de vérification des webhooks (fourni par Wave à
            // l'enregistrement de l'URL : wave_sn_WHS_...). Indispensable
            // pour valider les signatures HMAC-SHA256 (Wave-Signature).
            webhookSecret: process.env.WAVE_WEBHOOK_SECRET || '',
            // Délai maximal (ms) pour une requête HTTP vers l'API Wave.
            timeoutMs: parseIntEnv('WAVE_TIMEOUT', 30000),
            // URL de redirection (optionnel) après succès / échec côté Wave.
            successUrl: process.env.WAVE_SUCCESS_URL || '',
            errorUrl: process.env.WAVE_ERROR_URL || '',
        },
        // Configuration Stripe (Phase 5.4).
        stripe: {
            // URL de base de l'API Stripe. Laisser la valeur par défaut en
            // production ; utile uniquement pour les tests ou un proxy.
            apiUrl: process.env.STRIPE_API_URL || 'https://api.stripe.com',
            // Clé secrète (Authorization: Bearer sk_...). Jamais exposée au
            // navigateur, jamais journalisée.
            secretKey: process.env.STRIPE_SECRET_KEY || '',
            // Clé publique (pk_...) : conçue par Stripe pour être livrée au
            // navigateur (chargement de Stripe.js par le frontend).
            publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
            // Secret de vérification des signatures de webhooks (whsec_...).
            // Obligatoire dès que STRIPE_ENABLED=true : tout webhook sans
            // signature valide est refusé (401).
            webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
            // Version de l'API Stripe envoyée dans l'en-tête Stripe-Version.
            apiVersion: process.env.STRIPE_API_VERSION || '2024-06-20',
            // Délai maximal (ms) pour une requête HTTP vers l'API Stripe.
            timeoutMs: parseIntEnv('STRIPE_TIMEOUT', 30000),
        },
        // Configuration Orange Money (Phase 5.3).
        orangeMoney: {
            // URL de base de l'API Orange Money (production : https://api.orange.com).
            apiUrl: process.env.ORANGE_API_URL || 'https://api.orange.com',
            // Identifiants OAuth2 client_credentials (portail Orange Developer).
            clientId: process.env.ORANGE_CLIENT_ID || '',
            clientSecret: process.env.ORANGE_CLIENT_SECRET || '',
            // Identifiant marchand envoyé dans le corps de l'initiation (merchant_key).
            merchantId: process.env.ORANGE_MERCHANT_ID || '',
            // Secret de vérification des signatures HMAC-SHA256 des webhooks.
            webhookSecret: process.env.ORANGE_WEBHOOK_SECRET || '',
            // Chemins d'endpoints. Les valeurs par défaut reflètent la sandbox
            // « dev » documentée ; en production, le segment de chemin dépend du
            // pays (ex: /orange-money-webpay/sn/v1/webpayment pour le Sénégal).
            tokenPath: process.env.ORANGE_TOKEN_PATH || '/oauth/v3/token',
            webPaymentPath: process.env.ORANGE_WEBPAYMENT_PATH || '/orange-money-webpay/dev/v1/webpayment',
            transactionStatusPath: process.env.ORANGE_TRANSACTION_STATUS_PATH || '/orange-money-webpay/dev/v1/transactionstatus',
            // URL publique de réception des notifications Orange (notif_url) —
            // l'endpoint webhook de cette application.
            notifUrl: process.env.ORANGE_NOTIF_URL || '',
            // URL de redirection (optionnel) après succès / échec / annulation.
            successUrl: process.env.ORANGE_SUCCESS_URL || '',
            errorUrl: process.env.ORANGE_ERROR_URL || '',
            // Délai maximal (ms) pour une requête HTTP vers l'API Orange Money.
            timeoutMs: parseIntEnv('ORANGE_TIMEOUT', 30000),
        },
    },
};

/**
 * Vérifie que la configuration est sûre pour la production.
 * À appeler au démarrage, avant de lancer le serveur.
 * Refuse de démarrer si une valeur critique est absente, trop faible ou connue,
 * avec un message d'erreur explicite pour chaque variable fautive.
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

    // Port HTTP.
    if (process.env.PORT !== undefined && !/^\d+$/.test(String(process.env.PORT).trim())) {
        failures.push(`PORT="${process.env.PORT}" n'est pas un numéro de port valide.`);
    } else if (config.port < 1 || config.port > 65535) {
        failures.push(`PORT=${config.port} est hors de la plage autorisée (1-65535).`);
    }

    // Durée des jetons JWT (jsonwebtoken : "7d", "24h", "3600", "900s", ...).
    if (!/^\d+(\.\d+)?\s*(ms|s|m|h|d|w|y)?$/i.test(String(config.jwtExpiresIn).trim())) {
        failures.push(`JWT_EXPIRES_IN="${process.env.JWT_EXPIRES_IN}" est invalide (ex: "7d", "24h", "3600").`);
    }

    // Coût bcrypt.
    const rounds = parseInt(config.bcryptRounds, 10);
    if (Number.isNaN(rounds) || rounds < 4 || rounds > 20) {
        failures.push(`BCRYPT_ROUNDS="${process.env.BCRYPT_ROUNDS}" doit être un entier entre 4 et 20.`);
    }

    // Taille maximale des corps JSON (body-parser).
    if (!/^\d+(\.\d+)?\s*(b|kb|mb|gb)?$/i.test(String(config.jsonLimit).trim())) {
        failures.push(`JSON_LIMIT="${process.env.JSON_LIMIT}" est invalide (ex: "15mb", "1048576").`);
    }

    // Taille maximale d'une pièce jointe document (octets, > 0).
    if (!Number.isInteger(config.documentMaxFileSize) || config.documentMaxFileSize < 1) {
        failures.push(`DOCUMENT_MAX_FILE_SIZE="${process.env.DOCUMENT_MAX_FILE_SIZE}" doit être un entier positif (octets).`);
    }

    // Durée de la période d'essai.
    const trialDays = parseInt(config.trialDays, 10);
    if (Number.isNaN(trialDays) || trialDays < 1) {
        failures.push(`TRIAL_DAYS="${process.env.TRIAL_DAYS}" doit être un entier positif.`);
    }

    // Reverse proxy : 0..10 sauts de confiance.
    if (config.trustProxy < 0 || config.trustProxy > 10) {
        failures.push(`TRUST_PROXY=${config.trustProxy} est hors de la plage autorisée (0-10).`);
    }

    // Fenêtres et limites de rate limiting (anti-DoS / anti force brute).
    const integerChecks = [
        ['RATE_LIMIT_WINDOW_MS', config.rateLimitWindowMs],
        ['RATE_LIMIT_MAX', config.rateLimitMax],
        ['LOGIN_RATE_LIMIT_WINDOW_MS', config.loginRateLimitWindowMs],
        ['LOGIN_RATE_LIMIT_MAX', config.loginRateLimitMax],
        ['DB_CONNECTION_TIMEOUT_MS', config.dbConnectionTimeoutMs],
        ['DB_IDLE_TIMEOUT_MS', config.dbIdleTimeoutMs],
    ];
    for (const [name, value] of integerChecks) {
        if (!Number.isInteger(value) || value < 1) {
            failures.push(`${name}="${process.env[name]}" doit être un entier positif.`);
        }
    }

    // Cache TTL (Phase 6.3) : entiers >= 0 (0 = cache désactivé).
    const cacheChecks = [
        ['CACHE_TTL_MS', config.cacheTtlMs],
        ['PLANS_CACHE_TTL_MS', config.plansCacheTtlMs],
    ];
    for (const [name, value] of cacheChecks) {
        if (!Number.isInteger(value) || value < 0) {
            failures.push(`${name}="${process.env[name]}" doit être un entier >= 0 (0 = désactivé).`);
        }
    }

    // Fournisseur de facturation : uniquement les fournisseurs préparés.
    const BILLING_PROVIDERS = ['none', 'wave', 'orange_money', 'stripe'];
    if (process.env.BILLING_PROVIDER && !BILLING_PROVIDERS.includes(config.billing.provider)) {
        failures.push(`BILLING_PROVIDER="${process.env.BILLING_PROVIDER}" est inconnu (attendu : ${BILLING_PROVIDERS.join(', ')}).`);
    }

    // Paiements (Phase 5.1).
    const PAYMENT_PROVIDERS = ['mock', 'wave', 'orange_money', 'stripe'];
    if (process.env.PAYMENT_PROVIDER && !PAYMENT_PROVIDERS.includes(config.payment.provider)) {
        failures.push(`PAYMENT_PROVIDER="${process.env.PAYMENT_PROVIDER}" est inconnu (attendu : ${PAYMENT_PROVIDERS.join(', ')}).`);
    }
    if (process.env.PAYMENT_TIMEOUT !== undefined && !/^\d+$/.test(String(process.env.PAYMENT_TIMEOUT).trim())) {
        failures.push(`PAYMENT_TIMEOUT="${process.env.PAYMENT_TIMEOUT}" doit être un entier positif (ms).`);
    } else if (config.payment.timeoutMs < 1000) {
        failures.push(`PAYMENT_TIMEOUT=${config.payment.timeoutMs} doit être au moins 1000 (ms).`);
    }
    // Un fournisseur réel exige un secret de webhook solide en production.
    if (config.payment.provider !== 'mock' && String(config.payment.webhookSecret).length < 16) {
        failures.push('PAYMENT_WEBHOOK_SECRET doit contenir au moins 16 caractères en production quand un fournisseur réel (wave, orange_money, stripe) est activé.');
    }

    // Wave (Phase 5.2) : identifiants obligatoires quand le fournisseur est activé.
    if (config.payment.enabled.wave) {
        if (!process.env.WAVE_API_URL) {
            failures.push('WAVE_API_URL est obligatoire en production quand WAVE_ENABLED=true (ex: https://api.wave.com).');
        }
        if (!process.env.WAVE_API_KEY) {
            failures.push('WAVE_API_KEY est obligatoire en production quand WAVE_ENABLED=true.');
        }
        if (!process.env.WAVE_API_SECRET) {
            failures.push('WAVE_API_SECRET est obligatoire en production quand WAVE_ENABLED=true (secret de signature des requêtes).');
        }
        if (String(config.payment.wave.webhookSecret).length < 16) {
            failures.push('WAVE_WEBHOOK_SECRET doit contenir au moins 16 caractères en production quand WAVE_ENABLED=true (vérification des signatures de webhook).');
        }
    }

    // Orange Money (Phase 5.3) : identifiants obligatoires quand le fournisseur est activé.
    if (config.payment.enabled.orangeMoney) {
        if (!process.env.ORANGE_API_URL) {
            failures.push('ORANGE_API_URL est obligatoire en production quand ORANGE_ENABLED=true (ex: https://api.orange.com).');
        }
        if (!process.env.ORANGE_CLIENT_ID) {
            failures.push('ORANGE_CLIENT_ID est obligatoire en production quand ORANGE_ENABLED=true.');
        }
        if (!process.env.ORANGE_CLIENT_SECRET) {
            failures.push('ORANGE_CLIENT_SECRET est obligatoire en production quand ORANGE_ENABLED=true.');
        }
        if (!process.env.ORANGE_MERCHANT_ID) {
            failures.push('ORANGE_MERCHANT_ID est obligatoire en production quand ORANGE_ENABLED=true (merchant_key).');
        }
        if (String(config.payment.orangeMoney.webhookSecret).length < 16) {
            failures.push('ORANGE_WEBHOOK_SECRET doit contenir au moins 16 caractères en production quand ORANGE_ENABLED=true (vérification des signatures de webhook).');
        }
        if (!process.env.ORANGE_NOTIF_URL) {
            failures.push('ORANGE_NOTIF_URL est obligatoire en production quand ORANGE_ENABLED=true (URL publique de réception des notifications Orange Money).');
        }
    }

    // Stripe (Phase 5.4) : identifiants obligatoires quand le fournisseur est activé.
    if (config.payment.enabled.stripe) {
        if (!process.env.STRIPE_SECRET_KEY) {
            failures.push('STRIPE_SECRET_KEY est obligatoire en production quand STRIPE_ENABLED=true (clé secrète, jamais exposée au navigateur).');
        }
        if (!process.env.STRIPE_PUBLISHABLE_KEY) {
            failures.push('STRIPE_PUBLISHABLE_KEY est obligatoire en production quand STRIPE_ENABLED=true (clé publique livrée au navigateur via Stripe.js).');
        }
        if (String(config.payment.stripe.webhookSecret).length < 16) {
            failures.push('STRIPE_WEBHOOK_SECRET doit contenir au moins 16 caractères en production quand STRIPE_ENABLED=true (vérification des signatures de webhook).');
        }
    }

    if (failures.length > 0) {
        throw new Error(
            'Configuration de production invalide :\n- ' + failures.join('\n- ')
        );
    }
}

module.exports = { config, assertProductionConfig };
