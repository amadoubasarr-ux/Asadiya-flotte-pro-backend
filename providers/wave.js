// ============================================================
// Fournisseur Wave Money (Phase 5.2 — intégration réelle)
// ============================================================
// Implémente l'interface services/paymentGateway.js pour l'API
// officielle Wave Business (Checkout API) : https://api.wave.com
//
//   createPayment  -> POST /v1/checkout/sessions      (session de paiement)
//   checkPayment   -> GET  /v1/checkout/sessions/:id  (état réel)
//   cancelPayment  -> POST /v1/checkout/sessions/:id/expire
//   refundPayment  -> POST /v1/checkout/sessions/:id/refund
//   receiveWebhook -> vérification HMAC-SHA256 de la signature Wave
//                     puis traduction de l'événement en statut applicatif.
//
// Authentification : Authorization: Bearer <WAVE_API_KEY>.
// Signature des requêtes (optionnelle, si le request signing est activé) :
//   Wave-Signature: t=<timestamp>,v1=<hmac_sha256(secret, timestamp+body)>
// Signature des webhooks (obligatoire pour accepter un webhook) :
//   Wave-Signature: t=<timestamp>,v1=<hmac_sha256(secret, timestamp+rawBody)>
//
// Aucun secret n'est journalisé. Toutes les réponses externes sont
// normalisées vers les statuts de la machine à états applicative.
// ============================================================
const crypto = require('crypto');
const { PaymentGateway } = require('../services/paymentGateway');
const { config } = require('../config');
const AppError = require('../utils/AppError');
const logger = require('../utils/logger');

const WAVE_DEFAULT_API_URL = 'https://api.wave.com';
// Fenêtres de validité de l'horodatage de signature (anti-rejeu).
const WAVE_WEBHOOK_MAX_AGE_SECONDS = 5 * 60;      // 5 minutes dans le passé
const WAVE_WEBHOOK_MAX_SKEW_SECONDS = 30;         // 30 secondes dans le futur

class WaveProvider extends PaymentGateway {
    constructor() {
        super('wave');
        this.apiUrl = String(config.payment.wave.apiUrl || WAVE_DEFAULT_API_URL).replace(/\/+$/, '');
        this.apiKey = config.payment.wave.apiKey || '';
        this.signingSecret = config.payment.wave.apiSecret || '';
        this.webhookSecret = config.payment.wave.webhookSecret || '';
        this.timeoutMs = config.payment.wave.timeoutMs || config.payment.timeoutMs || 30000;
    }

    // ============================================================
    // Helpers internes
    // ============================================================

    isConfigured() {
        return !!this.apiUrl && !!this.apiKey;
    }

    _assertConfigured() {
        if (!this.isConfigured()) {
            throw new AppError(
                503,
                'Fournisseur Wave activé mais non configuré (WAVE_API_URL / WAVE_API_KEY requis).',
                { code: 'provider_not_configured' }
            );
        }
    }

    /** Signature optionnelle des requêtes sortantes (Wave-Signature). */
    _signRequestBody(body, timestamp) {
        if (!this.signingSecret) return null;
        const payload = String(timestamp) + (body || '');
        return crypto.createHmac('sha256', this.signingSecret).update(payload).digest('hex');
    }

    /**
     * Appel HTTP vers l'API Wave. Gère timeout, indisponibilité et erreurs
     * API en AppError propres (aucun détail interne, aucun secret).
     */
    async _request(method, path, { body } = {}) {
        this._assertConfigured();
        const url = this.apiUrl + path;
        const headers = {
            Authorization: `Bearer ${this.apiKey}`,
            Accept: 'application/json',
        };
        let bodyStr = null;
        if (body !== undefined) {
            bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
            headers['Content-Type'] = 'application/json';
        }

        const timestamp = Math.floor(Date.now() / 1000);
        const signature = this._signRequestBody(bodyStr, timestamp);
        if (signature) headers['Wave-Signature'] = `t=${timestamp},v1=${signature}`;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);

        let res;
        try {
            res = await fetch(url, { method, headers, body: bodyStr, signal: controller.signal });
        } catch (err) {
            clearTimeout(timer);
            if (err && err.name === 'AbortError') {
                logger.error('wave.api_timeout', { method, path, timeoutMs: this.timeoutMs });
                throw new AppError(
                    504,
                    'Le fournisseur Wave a mis trop de temps à répondre.',
                    { code: 'provider_timeout' }
                );
            }
            logger.error('wave.api_unreachable', { method, path, message: err.message });
            throw new AppError(
                502,
                'Le fournisseur Wave est indisponible.',
                { code: 'provider_unavailable' }
            );
        }
        clearTimeout(timer);

        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }

        logger.info('wave.api_response', { method, path, status: res.status });

        if (!res.ok) {
            const errorCode = data && data.error && data.error.code;
            logger.error('wave.api_error', { method, path, status: res.status, errorCode });
            throw new AppError(
                502,
                'Le fournisseur Wave a renvoyé une erreur.',
                {
                    code: 'provider_api_error',
                    details: { providerStatus: res.status, errorCode: errorCode || null },
                }
            );
        }
        return data;
    }

    // ============================================================
    // Mapping des réponses Wave vers les statuts applicatifs
    // ============================================================

    /**
     * Traduit un objet Checkout Session Wave en statut de la machine à états.
     *   checkout_status : open | complete | expired
     *   payment_status  : processing | cancelled | succeeded
     */
    _mapSession(session) {
        if (!session || typeof session !== 'object') {
            return { status: 'FAILED', message: 'Session Wave introuvable.', session: null };
        }
        const checkout = session.checkout_status;
        const payment = session.payment_status;

        if (checkout === 'expired') {
            return { status: 'EXPIRED', message: 'Session Wave expirée.', session };
        }
        if (checkout === 'complete' && payment === 'succeeded') {
            return { status: 'SUCCESS', message: 'Paiement Wave réussi.', session };
        }
        if (payment === 'succeeded') {
            return { status: 'SUCCESS', message: 'Paiement Wave réussi.', session };
        }
        if (payment === 'cancelled') {
            return { status: 'FAILED', message: 'Paiement Wave annulé ou échoué.', session };
        }
        if (checkout === 'complete') {
            return { status: 'PROCESSING', message: 'Paiement Wave en cours de finalisation.', session };
        }
        return { status: 'PROCESSING', message: 'Paiement Wave en cours de traitement.', session };
    }

    /** Traduit un événement de webhook Wave en statut applicatif. */
    _mapWebhookEvent(eventType, data) {
        switch (eventType) {
            case 'checkout.session.completed':
                if (data.payment_status === 'succeeded' || data.checkout_status === 'complete') {
                    return { status: 'SUCCESS', ignored: false, message: 'Webhook Wave : paiement réussi.' };
                }
                return { status: 'FAILED', ignored: false, message: 'Webhook Wave : session complétée sans paiement réussi.' };
            case 'checkout.session.payment_failed':
                return { status: 'FAILED', ignored: false, message: 'Webhook Wave : paiement échoué.' };
            case 'checkout.session.expired':
                return { status: 'EXPIRED', ignored: false, message: 'Webhook Wave : session expirée.' };
            case 'test.test_event':
                return { status: null, ignored: true, message: 'Webhook Wave : événement de test ignoré.' };
            default:
                // Événements non gérés (ex: merchant.payment_received, b2b.*)
                // : ignorés proprement (réponse 200, aucun traitement).
                return { status: null, ignored: true, message: `Webhook Wave : événement "${eventType}" ignoré.` };
        }
    }

    /**
     * Vérifie la signature HMAC-SHA256 d'un webhook Wave.
     *   en-tête : Wave-Signature: t=<timestamp>,v1=<signature>[,v1=<signature>...]
     *   payload : timestamp + corps brut (raw body, non parsé)
     * Rejette : en-tête absent/malformé, signature invalide, horodatage hors
     * fenêtre (anti-rejeu) et tout webhook non vérifiable (secret non défini).
     */
    _verifyWebhookSignature(signatureHeader, rawBody) {
        if (!this.webhookSecret) {
            throw AppError.unauthorized(
                'Signature webhook Wave non vérifiable (WAVE_WEBHOOK_SECRET non configuré).'
            );
        }
        if (!signatureHeader) {
            throw AppError.unauthorized('En-tête de signature Wave manquant.');
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
            throw AppError.unauthorized('Format de signature Wave invalide.');
        }

        const ts = parseInt(timestamp, 10);
        if (!Number.isInteger(ts)) {
            throw AppError.unauthorized('Horodatage de signature Wave invalide.');
        }

        // Anti-rejeu : refuser les webhooks trop anciens ou trop dans le futur.
        const now = Math.floor(Date.now() / 1000);
        if (now - ts > WAVE_WEBHOOK_MAX_AGE_SECONDS || ts - now > WAVE_WEBHOOK_MAX_SKEW_SECONDS) {
            throw AppError.unauthorized('Signature Wave expirée (rejeu potentiel).');
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
            throw AppError.unauthorized('Signature webhook Wave invalide.');
        }
    }

    // ============================================================
    // Interface PaymentGateway
    // ============================================================

    /**
     * Crée une session de paiement Wave (hosted checkout).
     * @returns {Promise<{providerReference, status, amount, currency, waveLaunchUrl, session}>}
     */
    async createPayment({ amount, currency, transactionReference, successUrl, errorUrl, payerMobile } = {}) {
        this._assertConfigured();

        const body = {
            amount: String(Math.round(Number(amount) || 0)),
            currency: String(currency || 'XOF').toUpperCase(),
            client_reference: transactionReference,
        };
        const success = successUrl || config.payment.wave.successUrl;
        const error = errorUrl || config.payment.wave.errorUrl;
        if (success) body.success_url = success;
        if (error) body.error_url = error;
        if (payerMobile) body.restrict_payer_mobile = payerMobile;

        logger.info('wave.api_create', { amount: body.amount, currency: body.currency });

        const session = await this._request('POST', '/v1/checkout/sessions', { body });
        if (!session || !session.id) {
            throw new AppError(
                502,
                'Réponse Wave invalide : identifiant de session absent.',
                { code: 'provider_invalid_response' }
            );
        }

        return {
            providerReference: session.id,
            status: 'PENDING',
            amount: body.amount,
            currency: body.currency,
            initiatedAt: session.when_created || new Date().toISOString(),
            waveLaunchUrl: session.wave_launch_url || null,
            session,
        };
    }

    /**
     * Interroge Wave sur l'état réel de la session.
     * @returns {Promise<{status, message, session}>} statut normalisé
     * (PROCESSING | SUCCESS | FAILED | EXPIRED).
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
        logger.info('wave.api_check', { providerReference });
        const session = await this._request(
            'GET',
            `/v1/checkout/sessions/${encodeURIComponent(providerReference)}`
        );
        return this._mapSession(session);
    }

    /** Annule (expire) une session Wave encore ouverte. */
    async cancelPayment({ providerReference } = {}) {
        this._assertConfigured();
        if (!providerReference) {
            throw new AppError(
                400,
                'Référence fournisseur absente : annulation impossible.',
                { code: 'provider_reference_missing' }
            );
        }
        logger.info('wave.api_cancel', { providerReference });
        await this._request(
            'POST',
            `/v1/checkout/sessions/${encodeURIComponent(providerReference)}/expire`
        );
        return { ok: true, message: 'Session Wave expirée (annulation acceptée).' };
    }

    /** Rembourse un paiement Wave réussi. */
    async refundPayment({ providerReference } = {}) {
        this._assertConfigured();
        if (!providerReference) {
            throw new AppError(
                400,
                'Référence fournisseur absente : remboursement impossible.',
                { code: 'provider_reference_missing' }
            );
        }
        logger.info('wave.api_refund', { providerReference });
        await this._request(
            'POST',
            `/v1/checkout/sessions/${encodeURIComponent(providerReference)}/refund`
        );
        return { ok: true, message: 'Paiement Wave remboursé.' };
    }

    /**
     * Valide et normalise un webhook Wave.
     * La signature est vérifiée sur le corps BRUT (rawBody) — jamais sur le
     * corps parsé — pour rester conforme au calcul Wave.
     *
     * @param {object} [opts]
     * @param {object} [opts.body]     Corps JSON déjà parsé par Express.
     * @param {Buffer|string} [opts.rawBody] Corps brut reçu (req.rawBody).
     * @param {object} [opts.headers]  En-têtes HTTP (req.headers).
     * @returns {Promise<{ok, status, ignored, transactionReference, providerReference, payload}>}
     */
    async receiveWebhook({ body, rawBody, headers } = {}) {
        const headerName = headers && (headers['wave-signature'] || headers['x-wave-signature']);
        const raw = typeof rawBody === 'string' ? rawBody : rawBody ? rawBody.toString('utf8') : '';
        this._verifyWebhookSignature(headerName, raw);

        const payload = body || {};
        const data = payload.data || {};
        const eventType = payload.type || '';
        const mapped = this._mapWebhookEvent(eventType, data);

        logger.info('wave.webhook_received', { event: eventType, status: mapped.status || 'ignored' });

        return {
            ok: true,
            status: mapped.status,
            ignored: mapped.ignored,
            transactionReference: data.client_reference || null,
            providerReference: data.id || null,
            payload: { eventType, data },
            message: mapped.message,
        };
    }
}

module.exports = WaveProvider;
