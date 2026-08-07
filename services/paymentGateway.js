// ============================================================
// Passerelle de paiement — interface unique (Phase 5.1)
// ============================================================
// Les fournisseurs (providers/) étendent la classe PaymentGateway et
// implémentent les 5 méthodes de l'interface.
//
// Aucun appel réseau n'est fait ici : en Phase 5.1 tout est simulé.
//   - 'mock' : simulateur local (aucune dépendance externe)
//   - 'wave' | 'orange_money' | 'stripe' : non implémentés pour l'instant
//     (chaque méthode lève `new Error('Provider not implemented')`).
//
// Les méthodes « pas encore implémentées » sont détectées par les routes
// via leur message exact et renvoient HTTP 501.
// ============================================================
const { config } = require('../config');
const AppError = require('../utils/AppError');

/** Message exact levé par tout fournisseur non implémenté (Phase 5.2+). */
const NOT_IMPLEMENTED_MESSAGE = 'Provider not implemented';

/** Vrai si l'erreur correspond à une méthode de fournisseur non implémentée. */
function isProviderNotImplemented(err) {
    return !!err && err.message === NOT_IMPLEMENTED_MESSAGE;
}

class PaymentGateway {
    /**
     * @param {string} name Identifiant du fournisseur ('mock', 'wave', ...).
     */
    constructor(name) {
        this.name = name || 'unknown';
    }

    /**
     * Initie un paiement auprès du fournisseur.
     * @returns {Promise<{providerReference: string, status: string}>}
     */
    async createPayment(/* { amount, currency, transactionReference, ... } */) {
        throw new Error(NOT_IMPLEMENTED_MESSAGE);
    }

    /**
     * Interroge le fournisseur sur l'état d'un paiement.
     * @returns {Promise<{status: string}>}
     */
    async checkPayment(/* { transactionReference, providerReference } */) {
        throw new Error(NOT_IMPLEMENTED_MESSAGE);
    }

    /**
     * Demande l'annulation d'un paiement non terminé.
     * @returns {Promise<{ok: boolean}>}
     */
    async cancelPayment(/* { transactionReference, providerReference } */) {
        throw new Error(NOT_IMPLEMENTED_MESSAGE);
    }

    /**
     * Demande le remboursement d'un paiement réussi.
     * @returns {Promise<{ok: boolean}>}
     */
    async refundPayment(/* { transactionReference, providerReference } */) {
        throw new Error(NOT_IMPLEMENTED_MESSAGE);
    }

    /**
     * Reçoit et valide un webhook envoyé par le fournisseur.
     * @returns {Promise<{ok: boolean}>}
     */
    async receiveWebhook(/* payload */) {
        throw new Error(NOT_IMPLEMENTED_MESSAGE);
    }
}

const KNOWN_PROVIDERS = ['mock', 'wave', 'orange_money', 'stripe'];

// Correspondance identifiant fournisseur <-> module d'implémentation.
const PROVIDER_MODULES = {
    mock: '../providers/mock',
    wave: '../providers/wave',
    orange_money: '../providers/orangeMoney',
    stripe: '../providers/stripe',
};

// Instances fournisseurs réutilisées (singletons par processus). Requis pour
// conserver l'état persistant d'un fournisseur entre les requêtes — ex: le
// cache du token OAuth d'Orange Money (jamais un token par paiement).
const PROVIDER_INSTANCES = new Map();

/**
 * Retourne l'instance du fournisseur demandé (ou celui de la configuration).
 * Les instances sont des singletons : leur état (cache OAuth, connexions)
 * persiste entre les requêtes HTTP.
 */
function getGateway(name) {
    const providerName = String(name || config.payment.provider || 'mock').toLowerCase();
    if (!KNOWN_PROVIDERS.includes(providerName)) {
        throw AppError.badRequest(`Fournisseur de paiement inconnu : "${providerName}".`);
    }
    if (!PROVIDER_INSTANCES.has(providerName)) {
        const Provider = require(PROVIDER_MODULES[providerName]);
        PROVIDER_INSTANCES.set(providerName, new Provider());
    }
    return PROVIDER_INSTANCES.get(providerName);
}

/**
 * Vrai si un fournisseur peut être utilisé (le simulateur 'mock' est
 * toujours disponible ; les fournisseurs réels sont activés par
 * WAVE_ENABLED / ORANGE_ENABLED / STRIPE_ENABLED).
 */
function isProviderEnabled(name) {
    if (name === 'mock') return true;
    const key = { wave: 'wave', orange_money: 'orangeMoney', stripe: 'stripe' }[name];
    return !!config.payment.enabled[key];
}

/**
 * Vrai si un fournisseur dispose des identifiants nécessaires pour appeler
 * son API. Wave (Phase 5.2) exige WAVE_API_URL + WAVE_API_KEY ; Orange Money
 * (Phase 5.3) exige ORANGE_API_URL + client OAuth2 + merchant_key ; Stripe
 * (Phase 5.4) exige STRIPE_API_URL + STRIPE_SECRET_KEY.
 */
function isProviderConfigured(name) {
    if (name === 'mock') return true;
    if (name === 'wave') {
        return !!config.payment.wave.apiUrl && !!config.payment.wave.apiKey;
    }
    if (name === 'orange_money') {
        return (
            !!config.payment.orangeMoney.apiUrl &&
            !!config.payment.orangeMoney.clientId &&
            !!config.payment.orangeMoney.clientSecret &&
            !!config.payment.orangeMoney.merchantId
        );
    }
    if (name === 'stripe') {
        return !!config.payment.stripe.apiUrl && !!config.payment.stripe.secretKey;
    }
    return true;
}

module.exports = {
    PaymentGateway,
    getGateway,
    isProviderEnabled,
    isProviderConfigured,
    isProviderNotImplemented,
    NOT_IMPLEMENTED_MESSAGE,
    KNOWN_PROVIDERS,
};
