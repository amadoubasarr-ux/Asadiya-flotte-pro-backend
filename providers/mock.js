// ============================================================
// Fournisseur simulé « mock » (Phase 5.1)
// ============================================================
// Simule un fournisseur de paiement localement : AUCUN appel réseau.
//   - createPayment  -> retourne une référence fournisseur + statut PENDING
//   - checkPayment   -> état simulé
//   - cancelPayment  -> annulation acceptée
//   - refundPayment  -> remboursement accepté
//   - receiveWebhook -> stocke le payload (l'état est géré par la route)
// ============================================================
const crypto = require('crypto');
const { PaymentGateway } = require('../services/paymentGateway');

class MockProvider extends PaymentGateway {
    constructor() {
        super('mock');
    }

    randomReference(prefix) {
        return `${prefix}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    }

    /** Simule l'initiation : une transaction PENDING avec une référence fournisseur. */
    async createPayment({ amount, currency }) {
        return {
            providerReference: this.randomReference('mock_pay'),
            status: 'PENDING',
            amount,
            currency,
            initiatedAt: new Date().toISOString(),
        };
    }

    /** Interrogation simulée : le paiement est encore en cours de traitement. */
    async checkPayment() {
        return { status: 'PENDING', message: 'Paiement en cours de traitement (simulation).' };
    }

    /** Annulation simulée : toujours acceptée. */
    async cancelPayment() {
        return { ok: true, message: 'Annulation acceptée par le simulateur.' };
    }

    /** Remboursement simulé : toujours accepté. */
    async refundPayment() {
        return { ok: true, message: 'Remboursement accepté par le simulateur.' };
    }

    /** Webhook simulé : renvoie le payload pour traçabilité. */
    async receiveWebhook(payload) {
        return { ok: true, payload };
    }
}

module.exports = MockProvider;
