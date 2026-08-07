// ============================================================
// Tests Orange Money — Phase 5.3 (intégration réelle)
// ============================================================
// Vérifie l'intégration réelle du fournisseur 'orange_money' SANS appeler
// l'API Orange (pas de sandbox publique accessible) : un faux serveur HTTP
// local imite les endpoints documentés de l'API Orange Money Web Payment /
// M Payment (1.0) :
//   POST /oauth/v3/token                              (OAuth2 client_credentials)
//   POST /orange-money-webpay/dev/v1/webpayment       (initiation)
//   POST /orange-money-webpay/dev/v1/transactionstatus (état réel)
// Les webhooks sont signés réellement (HMAC-SHA256 Orange-Signature) sur le
// corps BRUT reçu et vérifient le notif_token retourné à l'initiation.
//
// Scénarios :
//   - création (PENDING + pay_token + payment_url + authentification)
//   - OAuth : token mis en cache / renouvelé avant expiration / régénéré sur 401
//   - polling (check) : paiement en cours puis succès côté Orange
//   - synchronisation SaaS : facture PAID + renouvellement d'abonnement
//   - webhooks signés : SUCCESS / FAILED / EXPIRED, refus (non signé, invalide,
//     ancien, notif_token erroné), double SUCCESS sans double effet SaaS
//   - annulation et remboursement non documentés (501 provider_operation_not_supported)
//   - timeout (504) et fournisseur indisponible (502)
//   - contrôle d'accès
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

const PORT = 4314;
const BASE = `http://localhost:${PORT}`;
const ROOT = path.join(__dirname, '..');

const ORANGE_CLIENT_ID = 'test-client-id-123456';
const ORANGE_CLIENT_SECRET = 'test-client-secret-123456';
const ORANGE_MERCHANT_ID = 'test-merchant-key-123456';
const ORANGE_WEBHOOK_SECRET = 'orange-webhook-test-secret-123456';

let child = null;
let fakeServer = null;
let fakePort = null;
let superToken = null;
let adminToken = null;
let beforeSub = null;
const createdOrgIds = [];

// État du « côté Orange ».
const payments = new Map();
let paymentCounter = 0;
let tokenRequests = 0;
let tokenTtl = 3600;
let authFailOnce = false;
let delayMs = 0;
let lastRequest = { auth: null, oauthBasic: null, body: null, method: null, path: null };

// ============================================================
// Faux serveur Orange Money — hors ligne
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

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function startFakeOrangeServer() {
    return new Promise((resolve) => {
        const server = http.createServer(async (req, res) => {
            // Une réponse vers une socket déjà fermée (timeout côté client) ne
            // doit pas faire planter le faux serveur.
            res.on('error', () => {});

            const url = new URL(req.url, 'http://x');
            const parts = url.pathname.split('/').filter(Boolean);

            // ---- Endpoints de contrôle (réservés aux tests) ----
            if (parts[0] === '__orange_test') {
                if (parts[1] === '__last') return send(res, 200, lastRequest);
                if (parts[1] === '__token_count') return send(res, 200, { count: tokenRequests });
                if (parts[1] === '__set_token_ttl') {
                    const body = JSON.parse((await readBody(req)) || '{}');
                    tokenTtl = parseInt(body.seconds, 10) || 3600;
                    return send(res, 200, { ok: true, tokenTtl });
                }
                if (parts[1] === '__auth_fail_once') {
                    authFailOnce = true;
                    return send(res, 200, { ok: true });
                }
                if (parts[1] === '__set_state') {
                    const body = JSON.parse((await readBody(req)) || '{}');
                    const rec = payments.get(body.pay_token);
                    if (!rec) return send(res, 404, { error: 'payment not found' });
                    rec.status = String(body.status || '').toUpperCase();
                    return send(res, 200, rec);
                }
                if (parts[1] === '__delay') {
                    const body = JSON.parse((await readBody(req)) || '{}');
                    delayMs = parseInt(body.ms, 10) || 0;
                    return send(res, 200, { ok: true, delayMs });
                }
                if (parts[1] === '__state') {
                    const rec = payments.get(parts[2]);
                    if (!rec) return send(res, 404, { error: 'payment not found' });
                    return send(res, 200, rec);
                }
                if (parts[1] === '__down') {
                    send(res, 200, { ok: true });
                    setImmediate(() => {
                        if (server.closeAllConnections) server.closeAllConnections();
                        server.close();
                    });
                    return;
                }
                return send(res, 404, { error: 'control endpoint inconnu' });
            }

            // ---- POST /oauth/v3/token (OAuth2 client_credentials) ----
            if (
                req.method === 'POST' &&
                parts[0] === 'oauth' && parts[1] === 'v3' && parts[2] === 'token'
            ) {
                tokenRequests += 1;
                lastRequest.method = req.method;
                lastRequest.path = url.pathname;
                lastRequest.oauthBasic = req.headers.authorization || null;
                await readBody(req);
                return send(res, 200, {
                    token_type: 'Bearer',
                    access_token: `om_access_test_${tokenRequests}`,
                    expires_in: tokenTtl,
                });
            }

            // ---- Endpoints métier (sandbox « dev » documentée) ----
            const isWebpay =
                parts[0] === 'orange-money-webpay' && parts[1] === 'dev' && parts[2] === 'v1';
            if (!isWebpay) return send(res, 404, { error: { code: 'not_found' } });

            lastRequest.auth = req.headers.authorization || null;
            lastRequest.method = req.method;
            lastRequest.path = url.pathname;
            const raw = await readBody(req);
            lastRequest.body = raw ? JSON.parse(raw) : {};

            // POST /orange-money-webpay/dev/v1/webpayment -> initiation.
            if (parts[3] === 'webpayment' && req.method === 'POST') {
                if (delayMs) await sleep(delayMs);
                if (authFailOnce) {
                    authFailOnce = false;
                    return send(res, 401, { error: 'Invalid or expired access token' });
                }
                const record = {
                    pay_token: `paytoken_test_${++paymentCounter}`,
                    payment_url: `https://orange.example/pay/paytoken_test_${paymentCounter}`,
                    notif_token: `notif_test_${paymentCounter}`,
                    status: 'INITIATED',
                    txnid: `omtxn_test_${paymentCounter}`,
                };
                payments.set(record.pay_token, record);
                return send(res, 201, { status: 201, message: 'OK', ...record });
            }

            // POST /orange-money-webpay/dev/v1/transactionstatus -> état réel.
            if (parts[3] === 'transactionstatus' && req.method === 'POST') {
                if (delayMs) await sleep(delayMs);
                const rec = payments.get(lastRequest.body.pay_token);
                if (!rec) return send(res, 404, { error: 'transaction not found' });
                return send(res, 200, {
                    status: rec.status,
                    pay_token: rec.pay_token,
                    txnid: rec.txnid,
                    transaction_id: rec.txnid,
                });
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

/** Appelle les endpoints de contrôle du faux serveur Orange (port éphémère). */
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

/** Crée une transaction orange_money (PENDING) via l'API. */
async function createOrangePayment(body = {}) {
    const r = await api('POST', '/api/payments/create', {
        token: adminToken,
        body: {
            provider: 'orange_money',
            amount: 15000,
            currency: 'XOF',
            invoiceId: `INV-ORANGE-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
            ...body,
        },
    });
    assert.equal(r.status, 201, `Création orange_money échouée : ${JSON.stringify(r.data)}`);
    return r.data;
}

/** Force l'état d'un paiement côté faux Orange. */
async function setPaymentState(payToken, status) {
    const r = await fakeApi('POST', '/__orange_test/__set_state', { body: { pay_token: payToken, status } });
    assert.equal(r.status, 200, `Impossible de piloter le paiement : ${JSON.stringify(r.data)}`);
}

/**
 * Envoie un webhook Orange réellement signé (Orange-Signature HMAC-SHA256
 * calculé sur le corps BRUT : timestamp + rawBody).
 */
async function signedOrangeWebhook(payload, { secret = ORANGE_WEBHOOK_SECRET, timestamp } = {}) {
    const rawBody = JSON.stringify(payload);
    const ts = timestamp !== undefined ? timestamp : Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', secret).update(`${ts}${rawBody}`).digest('hex');
    const res = await fetch(`${BASE}/api/payments/webhook/orange_money`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Orange-Signature': `t=${ts},v1=${sig}`,
        },
        body: rawBody,
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* pas de corps JSON */ }
    return { status: res.status, data };
}

function completedPayload(txn) {
    return {
        status: 'SUCCESS',
        pay_token: txn.providerReference,
        order_id: txn.transactionReference,
        notif_token: txn.providerResponse.notifToken,
        txnid: `omtxn_${txn.providerReference}`,
        amount: String(txn.amount),
    };
}

before(async () => {
    await startFakeOrangeServer();

    child = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(PORT),
            NODE_ENV: 'test',
            ORANGE_ENABLED: 'true',
            ORANGE_API_URL: `http://127.0.0.1:${fakePort}`,
            ORANGE_CLIENT_ID: ORANGE_CLIENT_ID,
            ORANGE_CLIENT_SECRET: ORANGE_CLIENT_SECRET,
            ORANGE_MERCHANT_ID: ORANGE_MERCHANT_ID,
            ORANGE_WEBHOOK_SECRET: ORANGE_WEBHOOK_SECRET,
            ORANGE_NOTIF_URL: `http://localhost:${PORT}/api/payments/webhook/orange_money`,
            // Délai court : utilisé par le scénario de timeout (504).
            ORANGE_TIMEOUT: '400',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});

    await waitForServer();
    superToken = await login('superadmin', 'superadmin123');

    const orgName = uniqueName('Orange A');
    const adminUsername = uniqueName('orange_admin_a');
    const signup = await api('POST', '/api/auth/signup', {
        body: { name: orgName, adminName: 'Admin Orange A', adminUsername, adminPassword: 'secret123' },
    });
    assert.equal(signup.status, 201, `Signup échoué : ${JSON.stringify(signup.data)}`);
    createdOrgIds.push(signup.data.organization.id);
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
test('Création orange_money : PENDING + pay_token + payment_url + authentification + token OAuth mis en cache', async () => {
    const txn = await createOrangePayment({ amount: 15000 });

    assert.equal(txn.status, 'PENDING', 'Après initiation orange_money, le statut doit être PENDING');
    assert.equal(txn.provider, 'orange_money');
    assert.match(txn.providerReference, /^paytoken_test_/, 'La référence doit être le pay_token Orange');
    assert.ok(txn.providerResponse.paymentUrl, 'payment_url présent (hosted payment)');
    assert.ok(txn.providerResponse.notifToken, 'notif_token stocké pour la vérification des webhooks');

    const last = await fakeApi('GET', '/__orange_test/__last');
    assert.equal(last.data.path, '/orange-money-webpay/dev/v1/webpayment');
    assert.match(last.data.auth, /^Bearer om_access_test_\d+$/, 'Authentification Bearer sur l\'initiation');
    assert.equal(last.data.body.merchant_key, ORANGE_MERCHANT_ID);
    assert.equal(last.data.body.currency, 'XOF');
    assert.equal(last.data.body.amount, '15000');
    assert.match(last.data.body.order_id, /^pay_/, 'order_id = référence applicative');
    assert.equal(last.data.body.notif_url, `http://localhost:${PORT}/api/payments/webhook/orange_money`);

    // Deuxième paiement : le token OAuth est réutilisé (cache), aucun nouvel appel.
    await createOrangePayment({ amount: 2000 });
    const count = await fakeApi('GET', '/__orange_test/__token_count');
    assert.equal(count.data.count, 1, 'Le token OAuth doit être mis en cache et réutilisé');

    const oauth = await fakeApi('GET', '/__orange_test/__last');
    assert.equal(oauth.data.path, '/orange-money-webpay/dev/v1/webpayment');
    assert.equal(oauth.data.body.amount, '2000');
});

// ============================================================
test('OAuth : 401 sur l\'initiation -> token régénéré et relance automatique', async () => {
    await fakeApi('POST', '/__orange_test/__auth_fail_once', { body: {} });
    const before = await fakeApi('GET', '/__orange_test/__token_count');

    const txn = await createOrangePayment({ amount: 4000 });

    const after = await fakeApi('GET', '/__orange_test/__token_count');
    assert.ok(after.data.count > before.data.count, 'Le 401 doit déclencher la régénération du token');
    assert.equal(txn.status, 'PENDING', 'La relance avec le nouveau token doit aboutir');
});

// ============================================================
test('OAuth : token expiré -> renouvelé automatiquement avant expiration', async () => {
    // 1) Invalide le cache actuel via un 401 (token révoqué côté Orange).
    await fakeApi('POST', '/__orange_test/__auth_fail_once', { body: {} });
    // 2) Le token régénéré sera très court (1 s) : il expire quasi immédiatement
    //    (marge de sécurité incluse) et le paiement suivant doit en régénérer
    //    un (jamais un token par paiement).
    await fakeApi('POST', '/__orange_test/__set_token_ttl', { body: { seconds: 1 } });

    await createOrangePayment({ amount: 3000 });   // régénération (expires_in=1), retry OK

    const before = await fakeApi('GET', '/__orange_test/__token_count');
    await createOrangePayment({ amount: 3000 });   // cache expiré -> nouvelle régénération
    const after = await fakeApi('GET', '/__orange_test/__token_count');
    assert.equal(after.data.count, before.data.count + 1, 'Le token expiré doit être renouvelé');

    // Repart sur une durée de vie longue pour les tests suivants.
    await fakeApi('POST', '/__orange_test/__set_token_ttl', { body: { seconds: 3600 } });
});

// ============================================================
test('Polling : paiement en cours côté Orange -> aucun changement de statut (PENDING)', async () => {
    const txn = await createOrangePayment({ amount: 6000 });
    await setPaymentState(txn.providerReference, 'PENDING');

    const check = await api('GET', `/api/payments/${txn.id}/check`, { token: adminToken });
    assert.equal(check.status, 200);
    assert.equal(check.data.status, 'PENDING', 'Le statut local reste PENDING');
    assert.equal(check.data.actualStatus, 'PROCESSING', 'Un paiement en cours correspond à PROCESSING côté provider');
    assert.equal(check.data.providerChecked, true);
});

// ============================================================
test('Polling après succès côté Orange : SUCCESS + facture PAID + abonnement renouvelé', async () => {
    const txn = await createOrangePayment({ amount: 12000 });
    await setPaymentState(txn.providerReference, 'SUCCESS');

    const check = await api('GET', `/api/payments/${txn.id}/check`, { token: adminToken });
    assert.equal(check.status, 200);
    assert.equal(check.data.status, 'SUCCESS', 'Le succès observé côté Orange doit faire passer la transaction à SUCCESS');
    assert.ok(check.data.completedAt, 'completedAt renseigné');

    // Synchronisation SaaS : la facture liée (invoice_id) est PAID.
    const invoice = await invoices.findByNumber(txn.invoiceId);
    assert.ok(invoice, 'La facture liée doit exister');
    assert.equal(invoice.status, 'PAID', 'Une facture liée à un paiement réussi doit être PAID');

    // Abonnement : renouvellement automatique (TRIAL -> ACTIVE, date prolongée).
    const sub = await api('GET', '/api/subscriptions/me', { token: adminToken });
    assert.equal(sub.data.subscription.status, 'ACTIVE', 'L\'abonnement doit être renouvelé (ACTIVE)');
    assert.ok(
        new Date(sub.data.subscription.endDate) > new Date(beforeSub.endDate),
        'La date de fin doit être prolongée après le paiement réussi'
    );
});

// ============================================================
test('Webhook signé SUCCESS depuis PENDING : réconciliation PENDING -> PROCESSING -> SUCCESS + synchronisation SaaS', async () => {
    const txn = await createOrangePayment({ amount: 18000 });

    const hook = await signedOrangeWebhook(completedPayload(txn));
    assert.equal(hook.status, 200, `Webhook signé accepté : ${JSON.stringify(hook.data)}`);
    assert.equal(hook.data.status, 'SUCCESS');

    // La machine à états a été réconciliée via PROCESSING (chemin nominal).
    const detail = await api('GET', `/api/payments/${txn.id}`, { token: adminToken });
    const names = (detail.data.events || []).map((e) => e.event);
    assert.ok(names.includes('PROCESSING'), 'PENDING -> SUCCESS doit passer par PROCESSING');
    assert.ok(names.includes('SUCCESS'));

    const invoice = await invoices.findByNumber(txn.invoiceId);
    assert.equal(invoice.status, 'PAID', 'Le webhook SUCCESS doit marquer la facture PAID');

    const sub = await api('GET', '/api/subscriptions/me', { token: adminToken });
    assert.equal(sub.data.subscription.status, 'ACTIVE', 'Le webhook SUCCESS doit renouveler l\'abonnement');
});

// ============================================================
test('Webhooks non signés, invalides ou notif_token erroné : refusés (401)', async () => {
    const txn = await createOrangePayment({ amount: 7000 });

    // En-tête de signature absent.
    const noHeader = await api('POST', '/api/payments/webhook/orange_money', { body: completedPayload(txn) });
    assert.equal(noHeader.status, 401, 'Webhook sans en-tête Orange-Signature -> 401');

    // Signature invalide (mauvais secret).
    const bad = await signedOrangeWebhook(completedPayload(txn), { secret: 'wrong-secret' });
    assert.equal(bad.status, 401, 'Webhook avec mauvaise signature -> 401');

    // Horodatage expiré (anti-rejeu) : signature valide mais ancienne.
    const stale = await signedOrangeWebhook(completedPayload(txn), { timestamp: Math.floor(Date.now() / 1000) - 400 });
    assert.equal(stale.status, 401, 'Webhook trop ancien -> 401');

    // Signature valide mais notif_token erroné : refusé (mécanisme officiel).
    const wrongNotif = await signedOrangeWebhook({
        ...completedPayload(txn),
        notif_token: 'notif_wrong',
    });
    assert.equal(wrongNotif.status, 401, 'Signature valide mais notif_token erroné -> 401');
});

// ============================================================
test('Webhook FAILED et EXPIRED : états terminaux corrects', async () => {
    const failed = await createOrangePayment({ amount: 2500 });
    const hookFailed = await signedOrangeWebhook({
        status: 'FAILED',
        pay_token: failed.providerReference,
        order_id: failed.transactionReference,
        notif_token: failed.providerResponse.notifToken,
    });
    assert.equal(hookFailed.status, 200);
    assert.equal(hookFailed.data.status, 'FAILED', 'Webhook FAILED -> FAILED');

    const expired = await createOrangePayment({ amount: 2500 });
    const hookExpired = await signedOrangeWebhook({
        status: 'EXPIRED',
        pay_token: expired.providerReference,
        order_id: expired.transactionReference,
        notif_token: expired.providerResponse.notifToken,
    });
    assert.equal(hookExpired.status, 200);
    assert.equal(hookExpired.data.status, 'EXPIRED', 'Webhook EXPIRED -> EXPIRED');
});

// ============================================================
test('Webhook SUCCESS dupliqué : accusé réception sans double effet SaaS', async () => {
    const txn = await createOrangePayment({ amount: 9500 });

    const hook = await signedOrangeWebhook(completedPayload(txn));
    assert.equal(hook.status, 200);
    assert.equal(hook.data.status, 'SUCCESS');

    const subBefore = await api('GET', '/api/subscriptions/me', { token: adminToken });
    const dup = await signedOrangeWebhook(completedPayload(txn));
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
test('Annulation et remboursement non documentés par l\'API publique : 501 provider_operation_not_supported', async () => {
    const txn = await createOrangePayment({ amount: 4000 });
    const cancel = await api('POST', `/api/payments/${txn.id}/cancel`, { token: adminToken });
    assert.equal(cancel.status, 501, 'Annulation non documentée -> 501');
    assert.equal(cancel.data.code, 'provider_operation_not_supported');

    const txn2 = await createOrangePayment({ amount: 4000 });
    await setPaymentState(txn2.providerReference, 'SUCCESS');
    const check = await api('GET', `/api/payments/${txn2.id}/check`, { token: adminToken });
    assert.equal(check.data.status, 'SUCCESS');
    const refund = await api('POST', `/api/payments/${txn2.id}/refund`, { token: adminToken });
    assert.equal(refund.status, 501, 'Remboursement non documenté -> 501');
    assert.equal(refund.data.code, 'provider_operation_not_supported');
});

// ============================================================
test('Contrôle d\'accès : check d\'une transaction d\'une autre organisation -> 404', async () => {
    const orgNameB = uniqueName('Orange B');
    const adminUsernameB = uniqueName('orange_admin_b');
    const signupB = await api('POST', '/api/auth/signup', {
        body: { name: orgNameB, adminName: 'Admin Orange B', adminUsername: adminUsernameB, adminPassword: 'secret123' },
    });
    assert.equal(signupB.status, 201);
    createdOrgIds.push(signupB.data.organization.id);
    const otherToken = await login(adminUsernameB, 'secret123');

    const txn = await createOrangePayment({ amount: 1000 });
    const other = await api('GET', `/api/payments/${txn.id}/check`, { token: otherToken });
    assert.equal(other.status, 404, 'Une autre organisation ne doit pas consulter la transaction');
});

// ============================================================
test('Timeout : l\'API Orange Money ne répond pas -> 504 provider_timeout', async () => {
    await fakeApi('POST', '/__orange_test/__delay', { body: { ms: 2000 } });
    try {
        const r = await api('POST', '/api/payments/create', {
            token: adminToken,
            body: { provider: 'orange_money', amount: 1000, invoiceId: `INV-ORANGE-TIMEOUT-${Date.now()}` },
        });
        assert.equal(r.status, 504, 'Réponse trop lente -> 504');
        assert.equal(r.data.code, 'provider_timeout');
    } finally {
        await fakeApi('POST', '/__orange_test/__delay', { body: { ms: 0 } });
        // Laisse la réponse différée du faux Orange se terminer avant la suite.
        await sleep(2200);
    }
});

// ============================================================
test('Fournisseur Orange Money indisponible : 502 provider_unavailable (aucun secret divulgué)', async () => {
    // Coupe le faux Orange : tout nouvel appel réseau échoue proprement.
    await fakeApi('POST', '/__orange_test/__down', { body: {} });

    const r = await api('POST', '/api/payments/create', {
        token: adminToken,
        body: { provider: 'orange_money', amount: 1000, invoiceId: `INV-ORANGE-DOWN-${Date.now()}` },
    });
    assert.equal(r.status, 502, 'Fournisseur injoignable -> 502');
    assert.equal(r.data.code, 'provider_unavailable');
    assert.ok(!JSON.stringify(r.data).includes(ORANGE_CLIENT_SECRET), 'Aucun secret ne doit fuiter dans la réponse');
    assert.ok(!JSON.stringify(r.data).includes('om_access_test_'), 'Aucun token OAuth ne doit fuiter dans la réponse');
});
