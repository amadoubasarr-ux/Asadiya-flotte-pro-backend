// ============================================================
// Tests des paiements — Phase 5.1 (architecture, simulation locale)
// ============================================================
// Vérifie :
//   - création d'une transaction (fournisseur simulé 'mock')
//   - historique / audit (payment_events)
//   - machine à états (transitions valides ET refusées)
//   - annulation et remboursement
//   - fournisseur non implémenté (501) / désactivé (403) / inconnu (400)
//   - webhooks (succès, dupliqué, secret, événement invalide, transaction inconnue)
//   - contrôle d'accès (org propriétaire, SUPERADMIN, autre org)
//
// Lancer avec :  npm test
// ============================================================
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = 4311;
const BASE = `http://localhost:${PORT}`;
const ROOT = path.join(__dirname, '..');

let child = null;
let superToken = null;
let adminToken = null;
let adminOrgId = null;
let otherOrgId = null;
let otherAdminToken = null;
const createdOrgIds = [];

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const res = await fetch(`${BASE}/api/health`);
            if (res.ok) return;
        } catch (e) { /* serveur pas encore prêt */ }
        await sleep(300);
    }
    throw new Error('Le serveur de test ne démarre pas.');
}

async function api(method, p, { token, body, headers = {}, base = BASE } = {}) {
    const res = await fetch(base + p, {
        method,
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* pas de corps JSON */ }
    return { status: res.status, data, headers: res.headers };
}

async function login(username, password) {
    const r = await api('POST', '/api/auth/login', { body: { username, password } });
    assert.equal(r.status, 200, `Login ${username} échoué : ${JSON.stringify(r.data)}`);
    assert.ok(r.data.token, 'Le login doit renvoyer un token');
    return r.data.token;
}

function uniqueName(prefix) {
    return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 100000)}`.slice(0, 60);
}

function eventNames(txn) {
    return (txn.events || []).map((e) => e.event);
}

async function createPayment(token, body) {
    const r = await api('POST', '/api/payments/create', { token, body });
    assert.equal(r.status, 201, `Création de paiement échouée : ${JSON.stringify(r.data)}`);
    assert.ok(r.data.id, 'La transaction doit avoir un id');
    assert.equal(r.data.status, 'PENDING', 'Après initiation (mock), le statut doit être PENDING');
    assert.equal(r.data.provider, 'mock');
    assert.ok(r.data.providerReference, 'La référence fournisseur doit être renseignée');
    return r.data;
}

async function webhook(transactionReference, event, extra = {}) {
    return api('POST', '/api/payments/webhook/mock', {
        body: { transactionReference, event, ...extra },
    });
}

before(async () => {
    child = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(PORT),
            NODE_ENV: 'test',
            // Wave et Orange Money activés : les deux sont implémentés et
            // testent le refus 503 quand les identifiants sont absents.
            // Stripe reste désactivé (403 provider désactivé).
            WAVE_ENABLED: 'true',
            ORANGE_ENABLED: 'true',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});

    await waitForServer();
    superToken = await login('superadmin', 'superadmin123');

    // Organisation A (propriétaire des transactions de test).
    const orgNameA = uniqueName('Paiement A');
    const adminUsername = uniqueName('pay_admin_a');
    const signupA = await api('POST', '/api/auth/signup', {
        body: { name: orgNameA, adminName: 'Admin Paiement A', adminUsername, adminPassword: 'secret123' },
    });
    assert.equal(signupA.status, 201, `Signup A échoué : ${JSON.stringify(signupA.data)}`);
    adminOrgId = signupA.data.organization.id;
    createdOrgIds.push(adminOrgId);
    adminToken = await login(adminUsername, 'secret123');

    // Organisation B (pour le contrôle d'accès).
    const orgNameB = uniqueName('Paiement B');
    const adminUsernameB = uniqueName('pay_admin_b');
    const signupB = await api('POST', '/api/auth/signup', {
        body: { name: orgNameB, adminName: 'Admin Paiement B', adminUsername: adminUsernameB, adminPassword: 'secret123' },
    });
    assert.equal(signupB.status, 201, `Signup B échoué : ${JSON.stringify(signupB.data)}`);
    otherOrgId = signupB.data.organization.id;
    createdOrgIds.push(otherOrgId);
    otherAdminToken = await login(adminUsernameB, 'secret123');
});

after(async () => {
    if (superToken) {
        for (const id of createdOrgIds.reverse()) {
            try {
                await api('DELETE', `/api/organizations/${id}`, { token: superToken });
            } catch (e) { /* meilleur effort */ }
        }
    }
    if (child) {
        child.kill();
        await Promise.race([
            new Promise((resolve) => child.once('exit', resolve)),
            sleep(3000),
        ]);
    }
});

// ============================================================
test('Création d\'une transaction : statut PENDING + références applicatives et fournisseur', async () => {
    const txn = await createPayment(adminToken, {
        amount: 15000,
        currency: 'XOF',
        paymentMethod: 'MOBILE_MONEY',
        metadata: { planCode: 'STARTER' },
    });

    assert.match(txn.transactionReference, /^pay_/, 'Référence applicative attendue (pay_...)');
    assert.match(txn.providerReference, /^mock_pay_/, 'Référence fournisseur simulée attendue (mock_pay_...)');
    assert.equal(Number(txn.amount), 15000);
    assert.equal(txn.currency, 'XOF');
    assert.equal(txn.paymentMethod, 'MOBILE_MONEY');
    assert.equal(txn.organizationId, adminOrgId);
    assert.equal(txn.metadata.planCode, 'STARTER');
    assert.ok(txn.initiatedAt, 'initiatedAt doit être renseigné après initiation');
    assert.equal(txn.completedAt, null, 'Pas encore complété');
});

// ============================================================
test('Historique (audit) : la création et l\'initiation écrivent dans payment_events', async () => {
    const txn = await createPayment(adminToken, { amount: 3000 });

    const r = await api('GET', `/api/payments/${txn.id}`, { token: adminToken });
    assert.equal(r.status, 200);
    const names = eventNames(r.data);
    assert.ok(names.includes('CREATED'), 'Événement CREATED attendu');
    assert.ok(names.includes('PENDING'), 'Événement PENDING attendu');
    assert.ok(names.length >= 2, 'Au moins 2 événements d\'audit');

    // Le plus récent d'abord (PENDING vient après CREATED).
    assert.equal(names[0], 'PENDING');
    const created = r.data.events.find((e) => e.event === 'CREATED');
    assert.ok(created.message && created.message.includes('créée'));
});

// ============================================================
test('Machine à états : PROCESSING puis SUCCESS via webhook simulé', async () => {
    const txn = await createPayment(adminToken, { amount: 45000 });

    const processing = await webhook(txn.transactionReference, 'PROCESSING');
    assert.equal(processing.status, 200);
    assert.equal(processing.data.status, 'PROCESSING');

    const success = await webhook(txn.transactionReference, 'SUCCESS');
    assert.equal(success.status, 200);
    assert.equal(success.data.status, 'SUCCESS');
    assert.ok(success.data.completedAt, 'completedAt renseigné pour un état terminal');

    const r = await api('GET', `/api/payments/${txn.id}`, { token: adminToken });
    const names = eventNames(r.data);
    assert.ok(names.includes('PROCESSING'));
    assert.ok(names.includes('SUCCESS'));
});

// ============================================================
test('Machine à états : les transitions invalides sont REFUSÉES', async () => {
    const txn = await createPayment(adminToken, { amount: 1000 });

    // PENDING -> SUCCESS n'est pas autorisé (il faut passer par PROCESSING).
    const skip = await webhook(txn.transactionReference, 'SUCCESS');
    assert.equal(skip.status, 409, 'PENDING -> SUCCESS doit être refusé');
    assert.ok(skip.data.conflict, 'Le conflit doit décrire la transition');

    // PENDING -> FAILED n'est pas autorisé non plus.
    const failed = await webhook(txn.transactionReference, 'FAILED');
    assert.equal(failed.status, 409, 'PENDING -> FAILED doit être refusé');

    // Le statut reste PENDING (aucune corruption).
    const r = await api('GET', `/api/payments/${txn.id}`, { token: adminToken });
    assert.equal(r.data.status, 'PENDING');
});

// ============================================================
test('Annulation : paiement PENDING -> CANCELLED ; re-annulation refusée ; remboursement impossible', async () => {
    const txn = await createPayment(adminToken, { amount: 7500 });

    const cancel = await api('POST', `/api/payments/${txn.id}/cancel`, { token: adminToken });
    assert.equal(cancel.status, 200);
    assert.equal(cancel.data.status, 'CANCELLED');
    assert.ok(eventNames(cancel.data).includes('CANCELLED'));

    // Re-annulation : CANCELLED -> CANCELLED invalide.
    const again = await api('POST', `/api/payments/${txn.id}/cancel`, { token: adminToken });
    assert.equal(again.status, 409, 'CANCELLED -> CANCELLED doit être refusé');

    // Remboursement d'une transaction annulée : CANCELLED -> REFUNDED invalide.
    const refund = await api('POST', `/api/payments/${txn.id}/refund`, { token: adminToken });
    assert.equal(refund.status, 409, 'CANCELLED -> REFUNDED doit être refusé');
});

// ============================================================
test('Remboursement : SUCCESS -> REFUNDED (cycle complet)', async () => {
    const txn = await createPayment(adminToken, { amount: 20000 });
    await webhook(txn.transactionReference, 'PROCESSING');
    await webhook(txn.transactionReference, 'SUCCESS');

    const refund = await api('POST', `/api/payments/${txn.id}/refund`, { token: adminToken });
    assert.equal(refund.status, 200);
    assert.equal(refund.data.status, 'REFUNDED');
    assert.ok(eventNames(refund.data).includes('REFUNDED'));
    assert.ok(refund.data.completedAt, 'completedAt renseigné');
});

// ============================================================
test('Webhook dupliqué : redélivrance du même statut acceptée et journalisée (idempotent)', async () => {
    const txn = await createPayment(adminToken, { amount: 500 });
    await webhook(txn.transactionReference, 'PROCESSING');
    await webhook(txn.transactionReference, 'SUCCESS');

    // Redélivrance du SUCCESS : pas d'erreur, événement journalisé.
    const dup = await webhook(txn.transactionReference, 'SUCCESS');
    assert.equal(dup.status, 200);
    assert.equal(dup.data.status, 'SUCCESS');

    const r = await api('GET', `/api/payments/${txn.id}`, { token: adminToken });
    const successEvents = r.data.events.filter((e) => e.event === 'SUCCESS');
    assert.ok(successEvents.length >= 2, 'Le webhook dupliqué doit être journalisé');
});

// ============================================================
test('Fournisseurs wave et orange_money : implémentés mais non configurés -> 503', async () => {
    // Wave (Phase 5.2) est implémenté mais les identifiants API ne sont pas
    // fournis par le harnais de test : la création est refusée avant tout
    // appel réseau (503 provider_not_configured, aucune transaction créée).
    const r = await api('POST', '/api/payments/create', {
        token: adminToken,
        body: { amount: 5000, provider: 'wave' },
    });
    assert.equal(r.status, 503, 'Wave activé sans WAVE_API_KEY doit renvoyer 503');
    assert.equal(r.data.code, 'provider_not_configured');

    // orange_money (Phase 5.3) : implémenté mais les identifiants API
    // (client OAuth2 + merchant_key) ne sont pas fournis -> 503, avant tout
    // appel réseau (aucune transaction créée).
    const r2 = await api('POST', '/api/payments/create', {
        token: adminToken,
        body: { amount: 5000, provider: 'orange_money' },
    });
    assert.equal(r2.status, 503, 'orange_money activé sans identifiants doit renvoyer 503');
    assert.equal(r2.data.code, 'provider_not_configured');
});

// ============================================================
test('Fournisseur désactivé : stripe -> 403 ; fournisseur inconnu -> 400', async () => {
    const disabled = await api('POST', '/api/payments/create', {
        token: adminToken,
        body: { amount: 5000, provider: 'stripe' },
    });
    assert.equal(disabled.status, 403, 'STRIPE_ENABLED=false -> provider désactivé');

    const unknown = await api('POST', '/api/payments/create', {
        token: adminToken,
        body: { amount: 5000, provider: 'paypal' },
    });
    assert.equal(unknown.status, 400, 'Fournisseur inconnu -> 400');
});

// ============================================================
test('Webhook : événement invalide -> 400 ; transaction inconnue -> 404 ; provider réel -> exigences de signature', async () => {
    const badEvent = await api('POST', '/api/payments/webhook/mock', {
        body: { transactionReference: 'pay_x', event: 'BOGUS' },
    });
    assert.equal(badEvent.status, 400, 'Événement webhook inconnu -> 400');

    const missing = await webhook('pay_inexistante', 'SUCCESS');
    assert.equal(missing.status, 404, 'Transaction inconnue -> 404');

    // Webhook wave sans signature (WAVE_WEBHOOK_SECRET non configuré) : refusé (401).
    const waveNoSignature = await api('POST', '/api/payments/webhook/wave', { body: {} });
    assert.equal(waveNoSignature.status, 401, 'Webhook wave sans signature -> 401');

    // orange_money : webhook sans signature (ORANGE_WEBHOOK_SECRET non
    // configuré dans ce harnais) : refusé (401).
    const orangeWebhook = await api('POST', '/api/payments/webhook/orange_money', { body: {} });
    assert.equal(orangeWebhook.status, 401, 'Webhook orange_money sans signature -> 401');
});

// ============================================================
test('Contrôle d\'accès : une autre organisation et un compte non authentifié sont refusés', async () => {
    const txn = await createPayment(adminToken, { amount: 9999 });

    // Organisation B ne voit pas la transaction de l'organisation A (404, pas de fuite).
    const other = await api('GET', `/api/payments/${txn.id}`, { token: otherAdminToken });
    assert.equal(other.status, 404, 'Une autre organisation ne doit pas voir la transaction');

    // Sans token : 401.
    const anon = await api('GET', `/api/payments/${txn.id}`);
    assert.equal(anon.status, 401);

    // SUPERADMIN : voit tout, liste tout, crée pour une organisation.
    const detail = await api('GET', `/api/payments/${txn.id}`, { token: superToken });
    assert.equal(detail.status, 200);
    assert.equal(detail.data.organizationId, adminOrgId);

    const list = await api('GET', '/api/payments', { token: superToken });
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.data) && list.data.length >= 1);

    const mine = await api('GET', '/api/payments/me', { token: adminToken });
    assert.equal(mine.status, 200);
    assert.ok(Array.isArray(mine.data) && mine.data.length >= 1);

    // Création par le SUPERADMIN pour une organisation précise.
    const saCreate = await api('POST', '/api/payments/create', {
        token: superToken,
        body: { amount: 8000, organizationId: adminOrgId },
    });
    assert.equal(saCreate.status, 201);
    assert.equal(saCreate.data.organizationId, adminOrgId);
});

// ============================================================
test('Webhook protégé par secret : x-webhook-secret obligatoire quand configuré', async () => {
    const secretPort = 4312;
    const secretChild = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(secretPort),
            NODE_ENV: 'test',
            PAYMENT_WEBHOOK_SECRET: 'un-secret-de-test-long-et-solide-2026',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    secretChild.stdout.on('data', () => {});
    secretChild.stderr.on('data', () => {});
    try {
        const secretBase = `http://localhost:${secretPort}`;
        const start = Date.now();
        while (Date.now() - start < 30000) {
            try {
                const h = await fetch(`${secretBase}/api/health`);
                if (h.ok) break;
            } catch (e) { /* pas encore prêt */ }
            await sleep(300);
        }

        // Sans secret : 401.
        const noSecret = await api('POST', '/api/payments/webhook/mock', {
            base: secretBase,
            body: { transactionReference: 'pay_x', event: 'SUCCESS' },
        });
        assert.equal(noSecret.status, 401, 'Webhook sans secret -> 401');

        // Avec le mauvais secret : 401.
        const wrongSecret = await api('POST', '/api/payments/webhook/mock', {
            base: secretBase,
            headers: { 'x-webhook-secret': 'mauvais-secret' },
            body: { transactionReference: 'pay_x', event: 'SUCCESS' },
        });
        assert.equal(wrongSecret.status, 401, 'Webhook avec mauvais secret -> 401');

        // Avec le bon secret : le webhook est accepté (transaction inexistante -> 404).
        const goodSecret = await api('POST', '/api/payments/webhook/mock', {
            base: secretBase,
            headers: { 'x-webhook-secret': 'un-secret-de-test-long-et-solide-2026' },
            body: { transactionReference: 'pay_x', event: 'SUCCESS' },
        });
        assert.equal(goodSecret.status, 404, 'Secret valide : le webhook passe la vérification (404 = transaction inconnue)');
    } finally {
        secretChild.kill();
        await sleep(500);
    }
});
