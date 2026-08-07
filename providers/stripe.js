// ============================================================
// Fournisseur Stripe (Phase 5.4 — intégration réelle)
// ============================================================
// Implémente l'interface services/paymentGateway.js pour l'API
// officielle Stripe (Payment Intents) : https://api.stripe.com
//
//   createPayment  -> POST /v1/payment_intents          (initiation)
//   checkPayment   -> GET  /v1/payment_intents/:id      (état réel)
//   cancelPayment  -> POST /v1/payment_intents/:id/cancel
//   refundPayment  -> POST /v1/refunds                  (remboursement)
//   receiveWebhook -> vérification officielle de la signature Stripe
//                     (Stripe-Signature) puis traduction de l'événement
//                     en statut applicatif.
//
// Authentification : Authorization: Bearer <STRIPE_SECRET_KEY>.
// Les corps des requêtes POST sont encodés application/x-www-form-urlencoded
// (format officiel des librairies Stripe). L'en-tête Stripe-Version est
// systématiquement envoyé (STRIPE_API_VERSION).
//
// Flux PaymentIntent :
//   1. createPayment crée un PaymentIntent (status "requires_payment_method")
//      et renvoie providerReference = pi_..., client_secret et statut PENDING.
//      Il n'existe PAS d'URL hébergée (paymentUrl = null) : le client finalise
//      le paiement côté navigateur via Stripe.js / client_secret (flux officiel).
//   2. Le client confirme le PaymentIntent ; Stripe notifie alors la plateforme
//      par webhook (payment_intent.succeeded / payment_intent.payment_failed /
//      payment_intent.canceled / charge.refunded, ou via les factures Stripe
//      invoice.payment_succeeded / invoice.payment_failed).
//   3. checkPayment interroge l'état réel du PaymentIntent.
//
// Statuts PaymentIntent (documentation officielle) :
//   requires_payment_method | requires_confirmation | requires_action |
//   processing | requires_capture | canceled | succeeded
//   -> traduits en PROCESSING | CANCELLED | SUCCESS | REFUNDED.
//   « EXPIRED » n'existe pas en tant que statut PaymentIntent : un paiement
//   jamais confirmé est automatiquement annulé par Stripe (status "canceled")
//   au-delà de sa durée de vie (24 h par défaut) — il arrive donc en CANCELLED.
//
// Montants : Stripe attend un entier dans l'unité la plus petite de la devise.
// XOF (et autres devises « zéro-décimale » documentées par Stripe) : montant
// passé tel quel ; toutes les autres devises : montant * 100 (centimes).
//
// Signature des webhooks (documentation officielle Stripe) :
//   en-tête : Stripe-Signature: t=<timestamp>,v1=<signature>[,v1=...]
//   payload signé : "<timestamp>.<corps brut>"
//   HMAC-SHA256 avec STRIPE_WEBHOOK_SECRET, tolérance 300 secondes.
//
// Aucun secret n'est journalisé : ni la Secret Key, ni la Publishable Key,
// ni le Webhook Secret, ni le client_secret (le client_secret est stocké
// dans provider_response pour être transmis au navigateur, jamais loggé).
// ============================================================
const crypto = require('crypto');
const { PaymentGateway } = require('../services/paymentGateway');
const { config } = require('../config');
const AppError = require('../utils/AppError');
const logger = require('../utils/logger');

const STRIPE_DEFAULT_API_URL = 'https://api.stripe.com';
// Tolérance officielle de l'horodatage de signature Stripe (anti-rejeu).
const STRIPE_WEBHOOK_MAX_AGE_SECONDS = 300;         // 5 minutes dans le passé
const STRIPE_WEBHOOK_MAX_SKEW_SECONDS = 30;         // 30 secondes dans le futur
// Devises « zéro-décimale » officiellement documentées par Stripe (le montant
// est passé tel quel, sans facteur 100).
const STRIPE_ZERO_DECIMAL_CURRENCIES = new Set([
    'BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW',
    'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

class StripeProvider extends PaymentGateway {
    constructor() {
        super('stripe');
        this.apiUrl = String(
            config.payment.stripe.apiUrl || STRIPE_DEFAULT_API_URL
        ).replace(/\/+$/, '');
        this.secretKey = config.payment.stripe.secretKey || '';
        this.publishableKey = config.payment.stripe.publishableKey || '';
        this.webhookSecret = config.payment.stripe.webhookSecret || '';
        this.apiVersion = config.payment.stripe.apiVersion || '2024-06-20';
        this.timeoutMs = config.payment.stripe.timeoutMs || config.payment.timeoutMs || 30000;
    }

    // ============================================================
    // Helpers internes
    // ============================================================

    isConfigured() {
        return !!this.apiUrl && !!this.secretKey;
    }

    _assertConfigured() {
        if (!this.isConfigured()) {
            throw new AppError(
                503,
                'Fournisseur Stripe activé mais non configuré (STRIPE_API_URL / STRIPE_SECRET_KEY requis).',
                { code: 'provider_not_configured' }
            );
        }
    }

    /**
     * Convertit un montant en unité la plus petite de la devise (exigence
     * Stripe). Les devises zéro-décimale documentées (dont XOF) passent le
     * montant tel quel ; les autres reçoivent le montant * 100 (centimes).
     */
    _toMinorUnits(amount, currency) {
        const n = Number(amount);
        if (!Number.isFinite(n) || n < 0) return null;
        const cur = String(currency || 'XOF').toUpperCase();
        return STRIPE_ZERO_DECIMAL_CURRENCIES.has(cur) ? Math.round(n) : Math.round(n * 100);
    }

    /** Encodage application/x-www-form-urlencoded (formats imbriqués inclus). */
    _formEncode(obj, prefix) {
        const parts = [];
        for (const key of Object.keys(obj)) {
            const value = obj[key];
            if (value === null || value === undefined) continue;
            const name = prefix ? `${prefix}[${key}]` : key;
            if (typeof value === 'object' && !Array.isArray(value)) {
                parts.push(this._formEncode(value, name));
            } else {
                parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
            }
        }
        return parts.join('&');
    }

    /**
     * Appel HTTP vers l'API Stripe. Gère timeout, indisponibilité et erreurs
     * API en AppError propres (aucun détail interne, aucun secret).
     */
    async _request(method, path, { form } = {}) {
        this._assertConfigured();
        const url = this.apiUrl + path;
        const headers = {
            Authorization: `Bearer ${this.secretKey}`,
            Accept: 'application/json',
            'Stripe-Version': this.apiVersion,
        };
        let bodyStr = null;
        if (form !== undefined) {
            bodyStr = this._formEncode(form);
            headers['Content-Type'] = 'application/x-www-form-urlencoded';
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);

        let res;
        try {
            res = await fetch(url, { method, headers, body: bodyStr, signal: controller.signal });
        } catch (err) {
            clearTimeout(timer);
            if (err && err.name === 'AbortError') {
                logger.error('stripe.api_timeout', { method, path, timeoutMs: this.timeoutMs });
                throw new AppError(
                    504,
                    'Le fournisseur Stripe a mis trop de temps à répondre.',
                    { code: 'provider_timeout' }
                );
            }
            logger.error('stripe.api_unreachable', { method, path, message: err.message });
            throw new AppError(
                502,
                'Le fournisseur Stripe est indisponible.',
                { code: 'provider_unavailable' }
            );
        }
        clearTimeout(timer);

        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }

        logger.info('stripe.api_response', { method, path, status: res.status });

        if (!res.ok) {
            // Ne journalise jamais la clé secrète ni le message complet de
            // l'API (il peut contenir des identifiants internes) : seul le
            // code d'erreur Stripe est conservé pour le diagnostic.
            const errorCode = data && data.error && data.error.code;
            const errorType = data && data.error && data.error.type;
            logger.error('stripe.api_error', { method, path, status: res.status, errorCode, errorType });
            throw new AppError(
                502,
                'Le fournisseur Stripe a renvoyé une erreur.',
                {
                    code: 'provider_api_error',
                    details: { providerStatus: res.status, errorCode: errorCode || null },
                }
            );
        }
        return data;
    }

    // ============================================================
    // Mapping des réponses Stripe vers les statuts applicatifs
    // ============================================================

    /**
     * Traduit un PaymentIntent Stripe en statut de la machine à états.
     * Un intent réussi mais déjà remboursé (amount_refunded > 0) -> REFUNDED.
     */
    _mapIntentStatus(intent) {
        if (!intent || typeof intent !== 'object') {
            return { status: 'FAILED', message: 'PaymentIntent Stripe introuvable.', session: null };
        }
        const status = String(intent.status || '');
        switch (status) {
            case 'succeeded': {
                const refunded = Number(intent.amount_refunded || 0) > 0;
                return refunded
                    ? { status: 'REFUNDED', message: 'Paiement Stripe remboursé.', session: intent }
                    : { status: 'SUCCESS', message: 'Paiement Stripe réussi.', session: intent };
            }
            case 'canceled':
                return { status: 'CANCELLED', message: 'PaymentIntent Stripe annulé.', session: intent };
            case 'requires_payment_method':
            case 'requires_confirmation':
            case 'requires_action':
            case 'processing':
            case 'requires_capture':
            default:
                return { status: 'PROCESSING', message: 'Paiement Stripe en cours de traitement.', session: intent };
        }
    }

    /** Traduit un événement de webhook Stripe en statut applicatif. */
    _mapWebhookEvent(eventType, object) {
        switch (eventType) {
            case 'payment_intent.succeeded':
            case 'invoice.payment_succeeded':
                return { status: 'SUCCESS', ignored: false, message: 'Webhook Stripe : paiement réussi.' };
            case 'payment_intent.payment_failed':
            case 'invoice.payment_failed':
                return { status: 'FAILED', ignored: false, message: 'Webhook Stripe : paiement échoué.' };
            case 'payment_intent.canceled':
                return { status: 'CANCELLED', ignored: false, message: 'Webhook Stripe : PaymentIntent annulé.' };
            case 'charge.refunded':
                return { status: 'REFUNDED', ignored: false, message: 'Webhook Stripe : charge remboursée.' };
            default:
                // Événements non gérés (charge.succeeded, payment_intent.processing,
                // customer.*, ...) : ignorés proprement (réponse 200, aucun traitement).
                return { status: null, ignored: true, message: `Webhook Stripe : événement "${eventType}" ignoré.` };
        }
    }

    /**
     * Extrait les références applicatives et fournisseur d'un objet de webhook
     * Stripe. Les objets Charge / Invoice portent le champ `payment_intent` ;
     * les objets PaymentIntent sont identifiés par leur id (pi_...).
     * La référence applicative (pay_...) est récupérée depuis les metadata.
     */
    _extractRefs(object) {
        let providerReference = null;
        let transactionReference = null;
        if (object && typeof object === 'object') {
            if (object.payment_intent) providerReference = object.payment_intent;
            else if (String(object.id || '').startsWith('pi_')) providerReference = object.id;
            const meta = object.metadata || {};
            if (meta.transaction_reference) transactionReference = meta.transaction_reference;
        }
        return { providerReference, transactionReference };
    }

    /**
     * Vérifie la signature HMAC-SHA256 d'un webhook Stripe (algorithme officiel).
     *   en-tête : Stripe-Signature: t=<timestamp>,v1=<signature>[,v1=...]
     *   payload signé : "<timestamp>.<corps brut>"
     * Rejette : en-tête absent/malformé, signature invalide, horodatage hors
     * tolérance (anti-rejeu) et tout webhook non vérifiable (secret non défini).
     */
    _verifyWebhookSignature(signatureHeader, rawBody) {
        if (!this.webhookSecret) {
            throw AppError.unauthorized(
                'Signature webhook Stripe non vérifiable (STRIPE_WEBHOOK_SECRET non configuré).'
            );
        }
        if (!signatureHeader) {
            throw AppError.unauthorized('En-tête de signature Stripe manquant.');
        }

        const parts = String(signatureHeader).split(',');
        let timestamp = null;
        const signatures = [];
        for (const part of parts) {
            const idx = part.indexOf('=');
            if (idx < 0) continue;
            const key = part.slice(0, idx).trim();
            const value = part.slice(idx + 1).trim();
            if (key === 't') timestamp = value;
            else if (key === 'v1') signatures.push(value);
        }
        if (timestamp === null || signatures.length === 0) {
            throw AppError.unauthorized('Format de signature Stripe invalide.');
        }

        const ts = parseInt(timestamp, 10);
        if (!Number.isInteger(ts)) {
            throw AppError.unauthorized('Horodatage de signature Stripe invalide.');
        }

        // Anti-rejeu : refuser les webhooks trop anciens ou trop dans le futur.
        const now = Math.floor(Date.now() / 1000);
        if (now - ts > STRIPE_WEBHOOK_MAX_AGE_SECONDS || ts - now > STRIPE_WEBHOOK_MAX_SKEW_SECONDS) {
            throw AppError.unauthorized('Signature Stripe expirée (rejeu potentiel).');
        }

        const signedPayload = `${ts}.${rawBody}`;
        const expected = crypto
            .createHmac('sha256', this.webhookSecret)
            .update(signedPayload)
            .digest('hex');
        const valid = signatures.some((sig) => {
            try {
                const a = Buffer.from(expected, 'hex');
                const b = Buffer.from(sig, 'hex');
                return a.length === b.length && crypto.timingSafeEqual(a, b);
            } catch (e) {
                return false;
            }
        });
        if (!valid) {
            throw AppError.unauthorized('Signature webhook Stripe invalide.');
        }
    }

    // ============================================================
    // Interface PaymentGateway
    // ============================================================

    /**
     * Crée un PaymentIntent Stripe.
     * @returns {Promise<{providerReference, status, amount, currency, clientSecret, paymentUrl, session}>}
     *   paymentUrl est toujours null : Payment Intents n'expose pas d'URL
     *   hébergée — le client finalise via Stripe.js avec le client_secret.
     */
    async createPayment({ amount, currency, transactionReference } = {}) {
        this._assertConfigured();

        const minorUnits = this._toMinorUnits(amount, currency);
        if (minorUnits === null) {
            throw new AppError(
                400,
                'Montant invalide pour Stripe (entier positif requis).',
                { code: 'invalid_amount' }
            );
        }
        const currencyCode = String(currency || 'XOF').toLowerCase();

        const form = {
            amount: minorUnits,
            currency: currencyCode,
            // Moyens de paiement automatiques (cartes, ...) : paramètre officiel
            // recommandé (équivalent de payment_method_types, sans liste figée).
            automatic_payment_methods: { enabled: 'true' },
            // Référence applicative conservée dans les metadata pour retrouver
            // la transaction lors des webhooks (payment_intent.*, invoice.*).
            metadata: { transaction_reference: transactionReference },
        };

        logger.info('stripe.payment_intent_create', { amount: minorUnits, currency: currencyCode });

        const intent = await this._request('POST', '/v1/payment_intents', { form });
        if (!intent || !intent.id || !intent.client_secret) {
            throw new AppError(
                502,
                'Réponse Stripe invalide : PaymentIntent incomplet (id / client_secret absents).',
                { code: 'provider_invalid_response' }
            );
        }

        return {
            providerReference: intent.id,
            status: 'PENDING',
            amount: minorUnits,
            currency: currencyCode,
            initiatedAt: intent.created
                ? new Date(intent.created * 1000).toISOString()
                : new Date().toISOString(),
            // Le client_secret est conçu par Stripe pour être transmis au
            // navigateur (Stripe.js confirmPayment) : il est retourné ici et
            // stocké dans provider_response, mais JAMAIS journalisé.
            clientSecret: intent.client_secret,
            paymentUrl: null,
            session: intent,
        };
    }

    /**
     * Interroge Stripe sur l'état réel d'un PaymentIntent.
     * @returns {Promise<{status, message, session}>} statut normalisé
     * (PROCESSING | SUCCESS | FAILED | CANCELLED | REFUNDED).
     */
    async checkPayment({ providerReference } = {}) {
        this._assertConfigured();
        if (!providerReference) {
            throw new AppError(
                400,
                'Référence fournisseur absente : vérification impossible.',
                { code: 'provider_reference_missing' }
            );
        }
        logger.info('stripe.payment_intent_check', { providerReference });
        const intent = await this._request(
            'GET',
            `/v1/payment_intents/${encodeURIComponent(providerReference)}`
        );
        return this._mapIntentStatus(intent);
    }

    /** Annule un PaymentIntent Stripe non confirmé (status requires_*). */
    async cancelPayment({ providerReference } = {}) {
        this._assertConfigured();
        if (!providerReference) {
            throw new AppError(
                400,
                'Référence fournisseur absente : annulation impossible.',
                { code: 'provider_reference_missing' }
            );
        }
        logger.info('stripe.payment_intent_cancel', { providerReference });
        await this._request(
            'POST',
            `/v1/payment_intents/${encodeURIComponent(providerReference)}/cancel`
        );
        return { ok: true, message: 'PaymentIntent Stripe annulé (annulation acceptée).' };
    }

    /** Rembourse un paiement Stripe réussi via /v1/refunds. */
    async refundPayment({ providerReference } = {}) {
        this._assertConfigured();
        if (!providerReference) {
            throw new AppError(
                400,
                'Référence fournisseur absente : remboursement impossible.',
                { code: 'provider_reference_missing' }
            );
        }
        logger.info('stripe.refund_create', { providerReference });
        const refund = await this._request('POST', '/v1/refunds', {
            form: { payment_intent: providerReference },
        });
        return {
            ok: true,
            message: 'Remboursement Stripe demandé.',
            refundStatus: (refund && refund.status) || null,
            session: refund,
        };
    }

    /**
     * Valide et normalise un webhook Stripe.
     * La signature est vérifiée sur le corps BRUT (rawBody) — jamais sur le
     * corps parsé — pour rester conforme au calcul officiel Stripe
     * (HMAC-SHA256 de "<timestamp>.<rawBody>").
     *
     * @param {object} [opts]
     * @param {object} [opts.body]     Corps JSON déjà parsé par Express.
     * @param {Buffer|string} [opts.rawBody] Corps brut reçu (req.rawBody).
     * @param {object} [opts.headers]  En-têtes HTTP (req.headers).
     * @returns {Promise<{ok, status, ignored, transactionReference, providerReference, payload}>}
     */
    async receiveWebhook({ body, rawBody, headers } = {}) {
        const headerName = headers && (headers['stripe-signature'] || headers['x-stripe-signature']);
        const raw = typeof rawBody === 'string' ? rawBody : rawBody ? rawBody.toString('utf8') : '';
        this._verifyWebhookSignature(headerName, raw);

        const payload = body || {};
        const object = payload.data && payload.data.object ? payload.data.object : {};
        const eventType = payload.type || '';
        const mapped = this._mapWebhookEvent(eventType, object);
        const refs = this._extractRefs(object);

        logger.info('stripe.webhook_received', { event: eventType, status: mapped.status || 'ignored' });

        // L'objet est conservé dans le payload d'audit APRÈS suppression du
        // client_secret éventuel (secret destiné au navigateur, jamais en base).
        const storedObject = { ...object };
        delete storedObject.client_secret;

        return {
            ok: true,
            status: mapped.status,
            ignored: mapped.ignored,
            transactionReference: refs.transactionReference,
            providerReference: refs.providerReference,
            payload: { eventId: payload.id || null, eventType, object: storedObject },
            message: mapped.message,
        };
    }
}

module.exports = StripeProvider;
