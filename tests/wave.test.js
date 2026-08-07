// ============================================================
// Tests Wave Money — Phase 5.2 (intégration réelle)
// ============================================================
// Vérifie l'intégration réelle du fournisseur 'wave' SANS appeler l'API
// Wave (pas de sandbox publique) : un faux serveur HTTP local imite les
// endpoints officiels de la Checkout API (docs.wave.com/checkout) :
//   POST /v1/checkout/sessions            (création)
//   GET  /v1/checkout/sessions/:id        (état)
//   POST /v1/checkout/sessions/:id/expire (annulation)
//   POST /v1/checkout/sessions/:id/refund (remboursement)
// Les webhooks sont signés réellement (HMAC-SHA256 Wave-Signature) sur le
// corps BRUT reçu.
//
// Scénarios :
//   - création (PENDING + référence fournisseur + URL de lancement)
//   - polling (check) : session ouverte puis succès côté Wave
//   - synchronisation SaaS : facture PAID + renouvellement d'abonnement
//   - webhooks signés : SUCCESS / FAILED / EXPIRED, événements ignorés,
//     signatures refusées (absente, invalide, expirée), double SUCCESS
//     sans double effet SaaS
//   - annulation (expire) et remboursement
//   - fournisseur indisponible (502)
//
// Lancer avec :  npm test
// ============================================================
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');

require('dotenv').config({ quiet: true });
const invoices = require('../db/invoices');

const PORT = 4313;
const BASE = `http://localhost:${PORT}`;
const ROOT = path.join(__dirname, '..');

const WAVE_WEBHOOK_SECRET = 'wave_sn_WHS_test-secret-123456789';
const WAVE_API_KEY = 'wave_sn_AKS_test-key-123456789';
const WAVE_REQUEST_SECRET = 'wave-request-signing-test-secret-123456';

let child = null;
let fakeServer = null;
let fakePort = null;
let superToken = null;
let adminToken = null;
let adminOrgId = null;
let beforeSub = null;
const createdOrgIds = [];

// État des sessions « côté Wave ».
const sessions = new Map();
let sessionCounter = 0;
let lastRequest = { auth: null, signature: null };

// ============================================================
// Faux serveur Wave (Checkout API) — hors ligne
// ============================================================
function send(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
}

function readBody(req) {
    return new Promise((resolve) => {
        let data = '';
        req.on('data', (c) => { data += c; });
        req.on('end', () => resolve(data));
    });
}

function startFakeWaveServer() {
    return new Promise((resolve) => {
        const server = http.createServer(async (req, res) => {
            const url = new URL(req.url, 'http://x');
            const parts = url.pathname.split('/').filter(Boolean);
            const isCheckout =
                parts[0] === 'v1' && parts[1] === 'checkout' && parts[2] === 'sessions';

            // Endpoints de contrôle (réservés aux tests).
            if (parts[0] === '__wave_test') {
                if (parts[1] === '__last') return send(res, 200, lastRequest);
                if (parts[1] === '__down') {
                    send(res, 200, { ok: true });
                    setImmediate(() => {
                        if (server.closeAllConnections) server.closeAllConnections();
                        server.close();
                    });
                    return;
                }
                const s = sessions.get(parts[1]);
                if (!s) return send(res, 404, { error: { code: 'not_found' } });
                // GET /__wave_test/:id -> état courant de la session.
                if (req.method === 'GET') return send(res, 200, s);
                // POST /__wave_test/:id -> force l'état d'une session.
                const body = JSON.parse(await readBody(req) || '{}');
                if (body.checkout_status) s.checkout_status = body.checkout_status;
                if (body.payment_status) s.payment_status = body.payment_status;
                return send(res, 200, s);
            }

            if (!isCheckout) return send(res, 404, { error: { code: 'not_found' } });

            lastRequest.auth = req.headers.authorization || null;
            lastRequest.signature = req.headers['wave-signature'] || null;

            const id = parts[3];
            const action = parts[4];

            // POST /v1/checkout/sessions  -> création d'une session ouverte.
            if (req.method === 'POST' && !id) {
                await readBody(req);
                const session = {
                    id: `session_test_${++sessionCounter}`,
                    checkout_status: 'open',
                    when_created: new Date().toISOString(),
                    wave_launch_url: `https://wave.example/checkout/session_test_${sessionCounter}`,
                };
                sessions.set(session.id, session);
                return send(res, 200, session);
            }

            // POST /v1/checkout/sessions/:id/expire
            if (req.method === 'POST' && id && action === 'expire') {
                const s = sessions.get(id);
                if (!s) return send(res, 404, { error: { code: 'not_found' } });
                s.checkout_status = 'expired';
                return send(res, 200, { id, checkout_status: 'expired' });
            }

            // POST /v1/checkout/sessions/:id/refund
            if (req.method === 'POST' && id && action === 'refund') {
                const s = sessions.get(id);
                if (!s) return send(res, 404, { error: { code: 'not_found' } });
                s.refund_status = 'pending';
                return send(res, 200, { id, refund_status: 'pending' });
            }

            // GET /v1/checkout/sessions/:id
            if (req.method === 'GET' && id) {
                const s = sessions.get(id);
                if (!s) return send(res, 404, { error: { code: 'not_found' } });
                return send(res, 200, s);
            }

            return send(res, 404, { error: { code: 'not_found' } });
        });
        server.listen(0, '127.0.0.1', () => {
            fakePort = server.address().port;
            fakeServer = server;
            resolve(server);
        });
    });
}

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

async function api(method, p, { token, body, headers = {} } = {}) {
    const res = await fetch(BASE + p, {
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
    return { status: res.status, data };
}

/** Appelle les endpoints de contrôle du faux serveur Wave (port éphémère). */
async function fakeApi(method, p, { body } = {}) {
    const res = await fetch(`http://127.0.0.1:${fakePort}${p}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* pas de corps JSON */ }
    return { status: res.status, data };
}

async function login(username, password) {
    const r = await api('POST', '/api/auth/login', { body: { username, password } });
    assert.equal(r.status, 200, `Login ${username} échoué : ${JSON.stringify(r.data)}`);
    return r.data.token;
}

function uniqueName(prefix) {
    return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 100000)}`.slice(0, 60);
}

/** Crée une transaction wave (PENDING) via l'API. */
async function createWavePayment(body = {}) {
    const r = await api('POST', '/api/payments/create', {
        token: adminToken,
        body: { provider: 'wave', amount: 15000, currency: 'XOF', invoiceId: `INV-WAVE-${Date.now()}-${Math.floor(Math.random() * 10000)}`, ...body },
    });
    assert.equal(r.status, 201, `Création wave échouée : ${JSON.stringify(r.data)}`);
    return r.data;
}

/** Force l'état d'une session côté faux Wave. */
async function setSessionState(sessionId, state) {
    const r = await fakeApi('POST', `/__wave_test/${sessionId}`, { body: state });
    assert.equal(r.status, 200, `Impossible de piloter la session : ${JSON.stringify(r.data)}`);
}

/**
 * Envoie un webhook Wave réellement signé (Wave-Signature HMAC-SHA256 calculé
 * sur le corps BRUT : timestamp + rawBody).
 */
async function signedWebhook(payload, { secret = WAVE_WEBHOOK_SECRET, timestamp } = {}) {
    const rawBody = JSON.stringify(payload);
    const ts = timestamp !== undefined ? timestamp : Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', secret).update(`${ts}${rawBody}`).digest('hex');
    const res = await fetch(`${BASE}/api/payments/webhook/wave`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Wave-Signature': `t=${ts},v1=${sig}`,
        },
        body: rawBody,
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* pas de corps JSON */ }
    return { status: res.status, data };
}

function completedPayload(txn) {
    return {
        type: 'checkout.session.completed',
        data: {
            id: txn.providerReference,
            client_reference: txn.transactionReference,
            checkout_status: 'complete',
            payment_status: 'succeeded',
        },
    };
}

before(async () => {
    await startFakeWaveServer();

    child = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(PORT),
            NODE_ENV: 'test',
            WAVE_ENABLED: 'true',
            WAVE_API_URL: `http://127.0.0.1:${fakePort}`,
            WAVE_API_KEY: WAVE_API_KEY,
            WAVE_API_SECRET: WAVE_REQUEST_SECRET,
            WAVE_WEBHOOK_SECRET: WAVE_WEBHOOK_SECRET,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});

    await waitForServer();
    superToken = await login('superadmin', 'superadmin123');

    const orgName = uniqueName('Wave A');
    const adminUsername = uniqueName('wave_admin_a');
    const signup = await api('POST', '/api/auth/signup', {
        body: { name: orgName, adminName: 'Admin Wave A', adminUsername, adminPassword: 'secret123' },
    });
    assert.equal(signup.status, 201, `Signup échoué : ${JSON.stringify(signup.data)}`);
    adminOrgId = signup.data.organization.id;
    createdOrgIds.push(adminOrgId);
    adminToken = await login(adminUsername, 'secret123');

    const sub = await api('GET', '/api/subscriptions/me', { token: adminToken });
    assert.equal(sub.status, 200);
    beforeSub = sub.data.subscription;
});

after(async () => {
    if (superToken) {
        for (const id of createdOrgIds.reverse()) {
            try {
                await api('DELETE', `/api/organizations/${id}`, { token: superToken });
            } catch (e) { /* meilleur effort */ }
        }
    }
    if (fakeServer) {
        try { fakeServer.close(); } catch (e) { /* déjà fermé */ }
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
test('Création wave : PENDING + référence fournisseur + URL de lancement + authentification Bearer', async () => {
    const txn = await createWavePayment();

    assert.equal(txn.status, 'PENDING', 'Après initiation wave, le statut doit être PENDING');
    assert.equal(txn.provider, 'wave');
    assert.match(txn.providerReference, /^session_test_/, 'La référence doit être l\'id de session Wave');
    assert.ok(txn.initiatedAt, 'initiatedAt renseigné après initiation');

    const last = await fakeApi('GET', '/__wave_test/__last');
    assert.equal(last.data.auth, `Bearer ${WAVE_API_KEY}`, 'La requête doit être authentifiée en Bearer');
    assert.match(last.data.signature || '', /^t=\d+,v1=[0-9a-f]{64}$/, 'La requête sortante doit être signée (request signing)');
});

// ============================================================
test('Polling : session encore ouverte -> aucun changement de statut (PENDING)', async () => {
    const txn = await createWavePayment();

    const check = await api('GET', `/api/payments/${txn.id}/check`, { token: adminToken });
    assert.equal(check.status, 200);
    assert.equal(check.data.status, 'PENDING', 'Session ouverte : le statut local reste PENDING');
    assert.equal(check.data.actualStatus, 'PROCESSING', 'La session ouverte correspond à PROCESSING côté provider');
    assert.equal(check.data.providerChecked, true);
});

// ============================================================
test('Polling après succès côté Wave : SUCCESS + facture PAID + abonnement renouvelé', async () => {
    const txn = await createWavePayment();
    await setSessionState(txn.providerReference, { checkout_status: 'complete', payment_status: 'succeeded' });

    const check = await api('GET', `/api/payments/${txn.id}/check`, { token: adminToken });
    assert.equal(check.status, 200);
    assert.equal(check.data.status, 'SUCCESS', 'Le succès observé côté Wave doit faire passer la transaction à SUCCESS');
    assert.ok(check.data.completedAt, 'completedAt renseigné');

    // Synchronisation SaaS : la facture liée (invoice_id) est PAID.
    const invoice = await invoices.findByNumber(txn.invoiceId);
    assert.ok(invoice, 'La facture liée doit exister');
    assert.equal(invoice.status, 'PAID', 'Une facture liée à un paiement réussi doit être PAID');
    assert.equal(invoice.organizationId, adminOrgId);

    // Abonnement : renouvellement automatique (TRIAL -> ACTIVE, date prolongée).
    const sub = await api('GET', '/api/subscriptions/me', { token: adminToken });
    assert.equal(sub.data.subscription.status, 'ACTIVE', 'L\'abonnement doit être renouvelé (ACTIVE)');
    assert.ok(
        new Date(sub.data.subscription.endDate) > new Date(beforeSub.endDate),
        'La date de fin doit être prolongée après le paiement réussi'
    );
});

// ============================================================
test('Webhook signé SUCCESS depuis PENDING : réconciliation PENDING -> PROCESSING -> SUCCESS + idempotence', async () => {
    const txn = await createWavePayment();

    const hook = await signedWebhook(completedPayload(txn));
    assert.equal(hook.status, 200, `Webhook signé accepté : ${JSON.stringify(hook.data)}`);
    assert.equal(hook.data.status, 'SUCCESS');

    // La machine à états a été réconciliée via PROCESSING (chemin nominal).
    const detail = await api('GET', `/api/payments/${txn.id}`, { token: adminToken });
    const names = (detail.data.events || []).map((e) => e.event);
    assert.ok(names.includes('PROCESSING'), 'PENDING -> SUCCESS doit passer par PROCESSING');
    assert.ok(names.includes('SUCCESS'));

    const invoice = await invoices.findByNumber(txn.invoiceId);
    assert.equal(invoice.status, 'PAID', 'Le webhook SUCCESS doit marquer la facture PAID');

    // Webhook SUCCESS dupliqué : accusé réception sans changement ni double effet SaaS.
    const subBefore = await api('GET', '/api/subscriptions/me', { token: adminToken });
    const dup = await signedWebhook(completedPayload(txn));
    assert.equal(dup.status, 200);
    assert.equal(dup.data.status, 'SUCCESS');
    const subAfter = await api('GET', '/api/subscriptions/me', { token: adminToken });
    assert.equal(
        subAfter.data.subscription.endDate,
        subBefore.data.subscription.endDate,
        'Un webhook SUCCESS dupliqué ne doit pas renouveler une seconde fois'
    );
});

// ============================================================
test('Webhooks non signés ou invalides : refusés (401)', async () => {
    const txn = await createWavePayment();

    // En-tête de signature absent.
    const noHeader = await api('POST', '/api/payments/webhook/wave', { body: completedPayload(txn) });
    assert.equal(noHeader.status, 401, 'Webhook sans en-tête Wave-Signature -> 401');

    // Signature invalide (mauvais secret).
    const bad = await signedWebhook(completedPayload(txn), { secret: 'wrong-secret' });
    assert.equal(bad.status, 401, 'Webhook avec mauvaise signature -> 401');

    // Horodatage expiré (anti-rejeu) : signature valide mais ancienne.
    const stale = await signedWebhook(completedPayload(txn), { timestamp: Math.floor(Date.now() / 1000) - 400 });
    assert.equal(stale.status, 401, 'Webhook trop ancien -> 401');
});

// ============================================================
test('Webhook FAILED (payment_failed) et EXPIRED : états terminaux corrects', async () => {
    const failed = await createWavePayment();
    const hookFailed = await signedWebhook({
        type: 'checkout.session.payment_failed',
        data: { id: failed.providerReference, client_reference: failed.transactionReference },
    });
    assert.equal(hookFailed.status, 200);
    assert.equal(hookFailed.data.status, 'FAILED', 'payment_failed -> FAILED');

    const expired = await createWavePayment();
    const hookExpired = await signedWebhook({
        type: 'checkout.session.expired',
        data: { id: expired.providerReference, client_reference: expired.transactionReference },
    });
    assert.equal(hookExpired.status, 200);
    assert.equal(hookExpired.data.status, 'EXPIRED', 'checkout.session.expired -> EXPIRED');
});

// ============================================================
test('Webhook : événements ignorés (test, inconnus) -> accusé réception 200 sans traitement', async () => {
    const txn = await createWavePayment();

    const testEvent = await signedWebhook({
        type: 'test.test_event',
        data: { id: txn.providerReference, client_reference: txn.transactionReference },
    });
    assert.equal(testEvent.status, 200);
    assert.equal(testEvent.data.ignored, true, 'test.test_event doit être ignoré');

    const unknown = await signedWebhook({
        type: 'merchant.payment_received',
        data: { id: txn.providerReference, client_reference: txn.transactionReference },
    });
    assert.equal(unknown.status, 200);
    assert.equal(unknown.data.ignored, true, 'Événement inconnu doit être ignoré');

    // La transaction n'a pas bougé.
    const detail = await api('GET', `/api/payments/${txn.id}`, { token: adminToken });
    assert.equal(detail.data.status, 'PENDING');
});

// ============================================================
test('Annulation : expire la session côté Wave puis CANCELLED', async () => {
    const txn = await createWavePayment();

    const cancel = await api('POST', `/api/payments/${txn.id}/cancel`, { token: adminToken });
    assert.equal(cancel.status, 200);
    assert.equal(cancel.data.status, 'CANCELLED');

    // Le faux Wave a bien reçu la demande d'expiration.
    const state = await fakeApi('GET', `/__wave_test/${txn.providerReference}`);
    assert.equal(state.status, 200);
    assert.equal(state.data.checkout_status, 'expired', 'La session Wave doit être expirée');

    // Re-annulation refusée (état terminal).
    const again = await api('POST', `/api/payments/${txn.id}/cancel`, { token: adminToken });
    assert.equal(again.status, 409, 'CANCELLED -> CANCELLED doit être refusé');
});

// ============================================================
test('Remboursement : succès côté Wave puis REFUNDED', async () => {
    const txn = await createWavePayment();
    await setSessionState(txn.providerReference, { checkout_status: 'complete', payment_status: 'succeeded' });
    const check = await api('GET', `/api/payments/${txn.id}/check`, { token: adminToken });
    assert.equal(check.data.status, 'SUCCESS');

    const refund = await api('POST', `/api/payments/${txn.id}/refund`, { token: adminToken });
    assert.equal(refund.status, 200);
    assert.equal(refund.data.status, 'REFUNDED');
});

// ============================================================
test('Contrôle d\'accès : check d\'une transaction d\'une autre organisation -> 404', async () => {
    const orgNameB = uniqueName('Wave B');
    const adminUsernameB = uniqueName('wave_admin_b');
    const signupB = await api('POST', '/api/auth/signup', {
        body: { name: orgNameB, adminName: 'Admin Wave B', adminUsername: adminUsernameB, adminPassword: 'secret123' },
    });
    assert.equal(signupB.status, 201);
    createdOrgIds.push(signupB.data.organization.id);
    const otherToken = await login(adminUsernameB, 'secret123');

    const txn = await createWavePayment();
    const other = await api('GET', `/api/payments/${txn.id}/check`, { token: otherToken });
    assert.equal(other.status, 404, 'Une autre organisation ne doit pas consulter la transaction');
});

// ============================================================
test('Fournisseur Wave indisponible : 502 provider_unavailable (aucun secret divulgué)', async () => {
    // Coupe le faux Wave : tout nouvel appel réseau échoue proprement.
    await fakeApi('POST', '/__wave_test/__down', { body: {} });

    const r = await api('POST', '/api/payments/create', {
        token: adminToken,
        body: { provider: 'wave', amount: 1000, invoiceId: `INV-WAVE-DOWN-${Date.now()}` },
    });
    assert.equal(r.status, 502, 'Fournisseur injoignable -> 502');
    assert.equal(r.data.code, 'provider_unavailable');
    assert.ok(!JSON.stringify(r.data).includes(WAVE_API_KEY), 'Aucun secret ne doit fuiter dans la réponse');
});
