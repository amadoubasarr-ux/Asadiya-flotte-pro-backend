// ============================================================
// Fournisseur Orange Money (Phase 5.3 — intégration réelle)
// ============================================================
// Implémente l'interface services/paymentGateway.js pour l'API
// officielle Orange Money Web Payment / M Payment (1.0) :
//   https://developer.orange.com/apis/om-webpay
//
//   createPayment -> POST {apiUrl}{webPaymentPath}        (initiation)
//   checkPayment  -> POST {apiUrl}{transactionStatusPath} (état réel)
//   cancelPayment / refundPayment -> non documentés par l'API publique
//                                    (voir le rapport Phase 5.3)
//   receiveWebhook -> vérification de signature HMAC-SHA256
//                     (en-tête Orange-Signature) + vérification
//                     du notif_token (mécanisme officiel).
//
// Authentification OAuth2 (client_credentials) :
//   POST {apiUrl}{tokenPath}  avec Authorization: Basic base64(clientId:clientSecret)
//   -> access_token (TTL ~3600 s) MIS EN CACHE et renouvelé avant expiration
//      (jamais un token par paiement). Tous les appels API portent
//      Authorization: Bearer <access_token> ; un 401 invalide le cache,
//      régénère le token et réessaie une fois (comportement documenté).
//
// IMPORTANT — documentation officielle : le portail developer.orange.com
// n'expose publiquement que l'overview et les FAQ ; les spécifications
// techniques détaillées (payloads exacts, notification, chemins par pays)
// sont fournies aux marchands lors de l'onboarding. Pour respecter la
// contrainte « ne rien coder d'inventé », les chemins d'endpoints sont
// CONFIGURABLES (ORANGE_TOKEN_PATH / ORANGE_WEBPAYMENT_PATH /
// ORANGE_TRANSACTION_STATUS_PATH) et les valeurs par défaut reflètent les
// chemins documentés de la sandbox « dev » (le segment de chemin dépend du
// pays en production : /orange-money-webpay/sn/v1/..., /cm/v1/..., etc.).
//
// Aucun secret (client_secret, access_token, webhook_secret) n'est journalisé.
// ============================================================
const crypto = require('crypto');
const { PaymentGateway } = require('../services/paymentGateway');
const { config } = require('../config');
const AppError = require('../utils/AppError');
const logger = require('../utils/logger');

const ORANGE_DEFAULT_API_URL = 'https://api.orange.com';
// Marge de sécurité avant expiration du token OAuth (renouvellement préventif).
const ORANGE_TOKEN_REFRESH_MARGIN_SECONDS = 60;
// Fenêtres de validité de l'horodatage de signature (anti-rejeu).
const ORANGE_WEBHOOK_MAX_AGE_SECONDS = 5 * 60;      // 5 minutes dans le passé
const ORANGE_WEBHOOK_MAX_SKEW_SECONDS = 30;         // 30 secondes dans le futur

class OrangeMoneyProvider extends PaymentGateway {
    constructor() {
        super('orange_money');
        this.apiUrl = String(
            config.payment.orangeMoney.apiUrl || ORANGE_DEFAULT_API_URL
        ).replace(/\/+$/, '');
        this.clientId = config.payment.orangeMoney.clientId || '';
        this.clientSecret = config.payment.orangeMoney.clientSecret || '';
        this.merchantId = config.payment.orangeMoney.merchantId || '';
        this.webhookSecret = config.payment.orangeMoney.webhookSecret || '';
        this.tokenPath = config.payment.orangeMoney.tokenPath || '/oauth/v3/token';
        this.webPaymentPath =
            config.payment.orangeMoney.webPaymentPath ||
            '/orange-money-webpay/dev/v1/webpayment';
        this.transactionStatusPath =
            config.payment.orangeMoney.transactionStatusPath ||
            '/orange-money-webpay/dev/v1/transactionstatus';
        this.notifUrl = config.payment.orangeMoney.notifUrl || '';
        this.successUrl = config.payment.orangeMoney.successUrl || '';
        this.errorUrl = config.payment.orangeMoney.errorUrl || '';
        this.timeoutMs = config.payment.orangeMoney.timeoutMs || config.payment.timeoutMs || 30000;
        // Cache OAuth2 : un seul token conservé, renouvelé avant expiration.
        this._tokenCache = { accessToken: null, expiresAt: 0 };
    }

    // ============================================================
    // Helpers internes
    // ============================================================

    isConfigured() {
        return !!this.apiUrl && !!this.clientId && !!this.clientSecret && !!this.merchantId;
    }

    _assertConfigured() {
        if (!this.isConfigured()) {
            throw new AppError(
                503,
                'Fournisseur Orange Money activé mais non configuré (ORANGE_API_URL / ORANGE_CLIENT_ID / ORANGE_CLIENT_SECRET / ORANGE_MERCHANT_ID requis).',
                { code: 'provider_not_configured' }
            );
        }
    }

    /**
     * Retourne un token OAuth valide, en renouvelant le cache s'il approche
     * de l'expiration. Ne JAMAIS solliciter un token par paiement : le token
     * est réutilisé tant qu'il reste valide (marge de sécurité incluse).
     */
    async _getAccessToken() {
        const now = Math.floor(Date.now() / 1000);
        if (
            this._tokenCache.accessToken &&
            this._tokenCache.expiresAt > now + ORANGE_TOKEN_REFRESH_MARGIN_SECONDS
        ) {
            return this._tokenCache.accessToken;
        }
        return this._fetchAccessToken();
    }

    /** Obtient un nouveau token OAuth (client_credentials) et le met en cache. */
    async _fetchAccessToken() {
        const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);

        let res;
        try {
            res = await fetch(this.apiUrl + this.tokenPath, {
                method: 'POST',
                headers: {
                    Authorization: `Basic ${basic}`,
                    Accept: 'application/json',
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: 'grant_type=client_credentials',
                signal: controller.signal,
            });
        } catch (err) {
            clearTimeout(timer);
            if (err && err.name === 'AbortError') {
                logger.error('orange.oauth_timeout', { path: this.tokenPath, timeoutMs: this.timeoutMs });
                throw new AppError(
                    504,
                    'Le fournisseur Orange Money a mis trop de temps à répondre.',
                    { code: 'provider_timeout' }
                );
            }
            logger.error('orange.oauth_unreachable', { path: this.tokenPath, message: err.message });
            throw new AppError(
                502,
                'Le fournisseur Orange Money est indisponible.',
                { code: 'provider_unavailable' }
            );
        }
        clearTimeout(timer);

        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }

        logger.info('orange.oauth_response', { status: res.status });

        if (!res.ok) {
            // Token révoqué/refusé : le cache doit être purgé.
            this._tokenCache = { accessToken: null, expiresAt: 0 };
            throw new AppError(
                502,
                'Le fournisseur Orange Money a refusé l\'authentification.',
                {
                    code: 'provider_api_error',
                    details: { providerStatus: res.status },
                }
            );
        }
        if (!data || !data.access_token) {
            throw new AppError(
                502,
                'Réponse OAuth Orange Money invalide : access_token absent.',
                { code: 'provider_invalid_response' }
            );
        }
        const expiresIn = parseInt(data.expires_in, 10) || 3600;
        this._tokenCache = {
            accessToken: data.access_token,
            expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
        };
        return data.access_token;
    }

    /**
     * Appel HTTP authentifié vers l'API Orange Money. Gère timeout,
     * indisponibilité, erreurs API et renouvellement automatique du token
     * en cas de 401 (token expiré) — une seule tentative de relance.
     */
    async _apiRequest(method, path, { body } = {}) {
        this._assertConfigured();
        const token = await this._getAccessToken();
        return this._apiRequestWithToken(method, path, { body, token, retried: false });
    }

    async _apiRequestWithToken(method, path, { body, token, retried }) {
        const url = this.apiUrl + path;
        const headers = {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
        };
        let bodyStr = null;
        if (body !== undefined) {
            bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
            headers['Content-Type'] = 'application/json';
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);

        let res;
        try {
            res = await fetch(url, { method, headers, body: bodyStr, signal: controller.signal });
        } catch (err) {
            clearTimeout(timer);
            if (err && err.name === 'AbortError') {
                logger.error('orange.api_timeout', { method, path, timeoutMs: this.timeoutMs });
                throw new AppError(
                    504,
                    'Le fournisseur Orange Money a mis trop de temps à répondre.',
                    { code: 'provider_timeout' }
                );
            }
            logger.error('orange.api_unreachable', { method, path, message: err.message });
            throw new AppError(
                502,
                'Le fournisseur Orange Money est indisponible.',
                { code: 'provider_unavailable' }
            );
        }
        clearTimeout(timer);

        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }

        logger.info('orange.api_response', { method, path, status: res.status });

        // Token expiré ou refusé (401) : invalider le cache, régénérer un
        // token frais et réessayer une fois (comportement documenté : un 401
        // signifie « regénérez l'access_token »).
        if (res.status === 401 && !retried) {
            this._tokenCache = { accessToken: null, expiresAt: 0 };
            const freshToken = await this._fetchAccessToken();
            return this._apiRequestWithToken(method, path, { body, token: freshToken, retried: true });
        }
        if (!res.ok) {
            logger.error('orange.api_error', { method, path, status: res.status });
            throw new AppError(
                502,
                'Le fournisseur Orange Money a renvoyé une erreur.',
                {
                    code: 'provider_api_error',
                    details: { providerStatus: res.status },
                }
            );
        }
        return data;
    }

    // ============================================================
    // Mapping des réponses Orange Money vers les statuts applicatifs
    // ============================================================

    /**
     * Traduit un statut Orange Money en statut de la machine à états.
     * Statuts documentés : INITIATED | PENDING | SUCCESS | FAILED | EXPIRED.
     */
    _mapTransactionStatus(data) {
        if (!data || typeof data !== 'object') {
            return { status: 'FAILED', message: 'Statut Orange Money introuvable.', session: null };
        }
        const status = String(data.status || '').toUpperCase();
        switch (status) {
            case 'SUCCESS':
                return { status: 'SUCCESS', message: 'Paiement Orange Money réussi.', session: data };
            case 'FAILED':
                return { status: 'FAILED', message: 'Paiement Orange Money refusé.', session: data };
            case 'EXPIRED':
                return { status: 'EXPIRED', message: 'Paiement Orange Money expiré.', session: data };
            case 'INITIATED':
            case 'PENDING':
            default:
                return { status: 'PROCESSING', message: 'Paiement Orange Money en cours de traitement.', session: data };
        }
    }

    /** Traduit un événement de notification (webhook) en statut applicatif. */
    _mapWebhookStatus(payload) {
        const status = String(payload.status || payload.event || '').toUpperCase();
        switch (status) {
            case 'SUCCESS':
                return { status: 'SUCCESS', ignored: false, message: 'Webhook Orange Money : paiement réussi.' };
            case 'FAILED':
                return { status: 'FAILED', ignored: false, message: 'Webhook Orange Money : paiement refusé.' };
            case 'EXPIRED':
                return { status: 'EXPIRED', ignored: false, message: 'Webhook Orange Money : paiement expiré.' };
            case 'INITIATED':
            case 'PENDING':
            case 'PROCESSING':
                return { status: 'PROCESSING', ignored: false, message: 'Webhook Orange Money : paiement en cours.' };
            default:
                return { status: null, ignored: true, message: `Webhook Orange Money : événement "${status}" ignoré.` };
        }
    }

    /**
     * Vérifie la signature HMAC-SHA256 d'un webhook Orange Money.
     *   en-tête : Orange-Signature: t=<timestamp>,v1=<signature>
     *   payload : timestamp + corps brut (raw body, non parsé)
     * Rejette : en-tête absent/malformé, signature invalide, horodatage hors
     * fenêtre (anti-rejeu) et tout webhook non vérifiable (secret non défini).
     */
    _verifyWebhookSignature(signatureHeader, rawBody) {
        if (!this.webhookSecret) {
            throw AppError.unauthorized(
                'Signature webhook Orange Money non vérifiable (ORANGE_WEBHOOK_SECRET non configuré).'
            );
        }
        if (!signatureHeader) {
            throw AppError.unauthorized('En-tête de signature Orange Money manquant.');
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
            throw AppError.unauthorized('Format de signature Orange Money invalide.');
        }

        const ts = parseInt(timestamp, 10);
        if (!Number.isInteger(ts)) {
            throw AppError.unauthorized('Horodatage de signature Orange Money invalide.');
        }

        // Anti-rejeu : refuser les webhooks trop anciens ou trop dans le futur.
        const now = Math.floor(Date.now() / 1000);
        if (now - ts > ORANGE_WEBHOOK_MAX_AGE_SECONDS || ts - now > ORANGE_WEBHOOK_MAX_SKEW_SECONDS) {
            throw AppError.unauthorized('Signature Orange Money expirée (rejeu potentiel).');
        }

        const expected = crypto
            .createHmac('sha256', this.webhookSecret)
            .update(String(ts) + rawBody)
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
            throw AppError.unauthorized('Signature webhook Orange Money invalide.');
        }
    }

    // ============================================================
    // Interface PaymentGateway
    // ============================================================

    /**
     * Initie un paiement Orange Money (hosted payment page).
     * @returns {Promise<{providerReference, status, amount, currency, paymentUrl, notifToken, session}>}
     */
    async createPayment({ amount, currency, transactionReference, successUrl, errorUrl } = {}) {
        this._assertConfigured();

        const body = {
            merchant_key: this.merchantId,
            currency: String(currency || 'XOF').toUpperCase(),
            amount: String(Math.round(Number(amount) || 0)),
            order_id: transactionReference,
        };
        const returnUrl = successUrl || this.successUrl;
        const cancelUrl = errorUrl || this.errorUrl;
        if (returnUrl) body.return_url = returnUrl;
        if (cancelUrl) body.cancel_url = cancelUrl;
        // URL de notification serveur-à-serveur (notif_url) — obligatoire pour
        // recevoir les webhooks de statut.
        if (this.notifUrl) body.notif_url = this.notifUrl;

        logger.info('orange.api_create', { amount: body.amount, currency: body.currency });

        const data = await this._apiRequest('POST', this.webPaymentPath, { body });
        if (!data || !data.pay_token) {
            throw new AppError(
                502,
                'Réponse Orange Money invalide : pay_token absent.',
                { code: 'provider_invalid_response' }
            );
        }

        return {
            providerReference: data.pay_token,
            status: 'PENDING',
            amount: body.amount,
            currency: body.currency,
            initiatedAt: new Date().toISOString(),
            paymentUrl: data.payment_url || null,
            // Jetons retournés par Orange : notif_token sert à authentifier la
            // notification de statut (vérifié dans receiveWebhook).
            notifToken: data.notif_token || null,
            session: data,
        };
    }

    /**
     * Interroge Orange Money sur l'état réel d'un paiement.
     * @returns {Promise<{status, message, session}>} statut normalisé
     * (PROCESSING | SUCCESS | FAILED | EXPIRED).
     */
    async checkPayment({ providerReference, transactionReference } = {}) {
        this._assertConfigured();
        if (!providerReference) {
            throw new AppError(
                400,
                'Référence fournisseur absente : vérification impossible.',
                { code: 'provider_reference_missing' }
            );
        }
        logger.info('orange.api_check', { providerReference });
        const body = { pay_token: providerReference };
        if (transactionReference) body.order_id = transactionReference;
        const data = await this._apiRequest('POST', this.transactionStatusPath, { body });
        return this._mapTransactionStatus(data);
    }

    /**
     * Annulation : l'API publique Orange Money Web Payment ne documente pas
     * d'opération d'annulation à distance (un paiement non complété finit en
     * EXPIRED). Refus propre plutôt qu'un appel inventé.
     */
    async cancelPayment() {
        throw new AppError(
            501,
            'L\'API publique Orange Money Web Payment ne documente pas d\'opération d\'annulation (les paiements non complétés expirent).',
            { code: 'provider_operation_not_supported' }
        );
    }

    /**
     * Remboursement : non documenté par l'API publique Orange Money Web
     * Payment (à confirmer auprès de l'opérateur local). Refus propre plutôt
     * qu'un appel inventé.
     */
    async refundPayment() {
        throw new AppError(
            501,
            'L\'API publique Orange Money Web Payment ne documente pas d\'opération de remboursement (à confirmer auprès de l\'opérateur local).',
            { code: 'provider_operation_not_supported' }
        );
    }

    /**
     * Valide et normalise un webhook Orange Money.
     * Vérification en deux couches :
     *   1. Signature HMAC-SHA256 (Orange-Signature) calculée sur le corps BRUT.
     *   2. notif_token : le jeton reçu doit correspondre à celui retourné à
     *      l'initiation (stocké dans provider_response) — mécanisme officiel
     *      de la notification Orange Money.
     *
     * @param {object} [opts]
     * @param {object} [opts.body]     Corps JSON déjà parsé par Express.
     * @param {Buffer|string} [opts.rawBody] Corps brut reçu (req.rawBody).
     * @param {object} [opts.headers]  En-têtes HTTP (req.headers).
     * @returns {Promise<{ok, status, ignored, transactionReference, providerReference, payload}>}
     */
    async receiveWebhook({ body, rawBody, headers } = {}) {
        const headerName = headers && (headers['orange-signature'] || headers['x-orange-signature']);
        const raw = typeof rawBody === 'string' ? rawBody : rawBody ? rawBody.toString('utf8') : '';
        this._verifyWebhookSignature(headerName, raw);

        const payload = body || {};
        const mapped = this._mapWebhookStatus(payload);

        if (!mapped.ignored) {
            // Vérification du notif_token (mécanisme officiel) : le jeton reçu
            // doit correspondre à celui retourné à l'initiation. Un écart est
            // un rejet net (401), même si la signature HMAC est valide.
            const txn = await this._findTransaction(payload);
            const storedNotif = txn && txn.providerResponse && txn.providerResponse.notifToken;
            if (storedNotif && payload.notif_token && payload.notif_token !== storedNotif) {
                throw AppError.unauthorized('notif_token Orange Money invalide.');
            }
        }

        logger.info('orange.webhook_received', { status: mapped.status || 'ignored' });

        return {
            ok: true,
            status: mapped.status,
            ignored: mapped.ignored,
            transactionReference: payload.order_id || null,
            providerReference: payload.pay_token || null,
            payload,
            message: mapped.message,
        };
    }

    /** Retrouve la transaction associée à une notification Orange Money. */
    async _findTransaction(payload) {
        const payments = require('../db/payments');
        if (payload.pay_token) {
            const txn = await payments.findByProviderReference(payload.pay_token);
            if (txn) return txn;
        }
        if (payload.order_id) {
            const txn = await payments.findByReference(payload.order_id);
            if (txn) return txn;
        }
        if (payload.txnid) {
            const txn = await payments.findByProviderReference(payload.txnid);
            if (txn) return txn;
        }
        return null;
    }
}

module.exports = OrangeMoneyProvider;
