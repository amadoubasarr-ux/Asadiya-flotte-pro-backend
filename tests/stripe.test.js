// ============================================================
// Tests Stripe — Phase 5.4 (intégration réelle)
// ============================================================
// Vérifie l'intégration réelle du fournisseur 'stripe' SANS appeler l'API
// Stripe : un faux serveur HTTP local imite l'API REST officielle Stripe :
//   POST /v1/payment_intents                   (création PaymentIntent)
//   GET  /v1/payment_intents/:id               (état réel)
//   POST /v1/payment_intents/:id/cancel        (annulation)
//   POST /v1/refunds                           (remboursement)
// Les corps des requêtes sont en application/x-www-form-urlencoded (format
// officiel) et les webhooks sont signés réellement (Stripe-Signature :
// HMAC-SHA256 de "<timestamp>.<corps brut>") avec STRIPE_WEBHOOK_SECRET.
//
// Scénarios :
//   - création PaymentIntent (PENDING + pi_... + client_secret + Bearer sk_...)
//   - polling (check) : paiement en cours puis succès côté Stripe
//   - synchronisation SaaS : facture PAID + renouvellement d'abonnement
//   - webhooks signés : payment_intent.succeeded / payment_failed / canceled,
//     charge.refunded, invoice.payment_succeeded / payment_failed, événements
//     inconnus ignorés, refus (non signé, invalide, ancien)
//   - webhook SUCCESS dupliqué sans double effet SaaS
//   - annulation et remboursement (historique conservé pour REFUNDED)
//   - contrôle d'accès
//   - timeout (504) et fournisseur indisponible (502) sans fuite de secrets
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

const PORT = 4315;
const BASE = `http://localhost:${PORT}`;
const ROOT = path.join(__dirname, '..');

const STRIPE_SECRET_KEY = 'sk_test_1234567890abcdef';
const STRIPE_PUBLISHABLE_KEY = 'pk_test_1234567890abcdef';
const STRIPE_WEBHOOK_SECRET = 'whsec_test_secret_1234567890';

let child = null;
let fakeServer = null;
let fakePort = null;
let superToken = null;
let adminToken = null;
let beforeSub = null;
const createdOrgIds = [];

// État du « côté Stripe ».
const intents = new Map();
let piCounter = 0;
let refundCounter = 0;
let delayMs = 0;
let lastRequest = { method: null, path: null, auth: null, form: null };

// ============================================================
// Faux serveur Stripe — hors ligne
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

/** Parse un corps application/x-www-form-urlencoded en objet simple. */
function parseForm(raw) {
    const out = {};
    for (const [k, v] of new URLSearchParams(raw || '')) out[k] = v;
    return out;
}

function startFakeStripeServer() {
    return new Promise((resolve) => {
        const server = http.createServer(async (req, res) => {
            // Une réponse vers une socket déjà fermée (timeout côté client) ne
            // doit pas faire planter le faux serveur.
            res.on('error', () => {});

            const url = new URL(req.url, 'http://x');
            const parts = url.pathname.split('/').filter(Boolean);

            // ---- Endpoints de contrôle (réservés aux tests) ----
            if (parts[0] === '__stripe_test') {
                if (parts[1] === '__last') return send(res, 200, lastRequest);
                if (parts[1] === '__counts') {
                    return send(res, 200, { paymentIntents: piCounter, refunds: refundCounter });
                }
                if (parts[1] === '__set_state') {
                    const body = JSON.parse((await readBody(req)) || '{}');
                    const rec = intents.get(body.id);
                    if (!rec) return send(res, 404, { error: { code: 'resource_missing', message: 'no such payment_intent' } });
                    rec.status = String(body.status || '').toUpperCase().toLowerCase();
                    if (body.amount_refunded !== undefined) rec.amount_refunded = parseInt(body.amount_refunded, 10);
                    return send(res, 200, rec);
                }
                if (parts[1] === '__state') {
                    const rec = intents.get(parts[2]);
                    if (!rec) return send(res, 404, { error: { code: 'resource_missing', message: 'no such payment_intent' } });
                    return send(res, 200, rec);
                }
                if (parts[1] === '__delay') {
                    const body = JSON.parse((await readBody(req)) || '{}');
                    delayMs = parseInt(body.ms, 10) || 0;
                    return send(res, 200, { ok: true, delayMs });
                }
                if (parts[1] === '__down') {
                    send(res, 200, { ok: true });
                    setImmediate(() => {
                        if (server.closeAllConnections) server.closeAllConnections();
                        server.close();
                    });
                    return;
                }
                return send(res, 404, { error: { code: 'control_endpoint_inconnu' } });
            }

            // ---- /v1/... (API REST officielle Stripe) ----
            if (parts[0] !== 'v1') return send(res, 404, { error: { code: 'url_not_found' } });

            lastRequest.auth = req.headers.authorization || null;
            lastRequest.method = req.method;
            lastRequest.path = url.pathname;
            const raw = await readBody(req);
            lastRequest.form = raw ? parseForm(raw) : {};

            const isIntentList = parts[1] === 'payment_intents' && parts.length === 2;
            const isIntent = parts[1] === 'payment_intents' && parts.length === 3;
            const isIntentCancel = parts[1] === 'payment_intents' && parts.length === 4 && parts[3] === 'cancel';
            const isRefunds = parts[1] === 'refunds' && parts.length === 2;

            // POST /v1/payment_intents -> création PaymentIntent.
            if (req.method === 'POST' && isIntentList) {
                if (delayMs) await sleep(delayMs);
                const id = `pi_test_${++piCounter}`;
                const record = {
                    id,
                    object: 'payment_intent',
                    status: 'requires_payment_method',
                    amount: parseInt(lastRequest.form.amount || '0', 10),
                    currency: lastRequest.form.currency || 'xof',
                    created: Math.floor(Date.now() / 1000),
                    client_secret: `${id}_secret_${crypto.randomBytes(8).toString('hex')}`,
                    metadata: {
                        transaction_reference: lastRequest.form['metadata[transaction_reference]'] || null,
                    },
                    automatic_payment_methods: {
                        enabled: lastRequest.form['automatic_payment_methods[enabled]'] === 'true',
                    },
                    latest_charge: null,
                    amount_refunded: 0,
                };
                intents.set(id, record);
                return send(res, 200, record);
            }

            // GET /v1/payment_intents/:id -> état réel.
            if (req.method === 'GET' && isIntent) {
                const rec = intents.get(parts[2]);
                if (!rec) return send(res, 404, { error: { code: 'resource_missing', message: "No such payment_intent" } });
                return send(res, 200, rec);
            }

            // POST /v1/payment_intents/:id/cancel -> annulation.
            if (req.method === 'POST' && isIntentCancel) {
                const rec = intents.get(parts[2]);
                if (!rec) return send(res, 404, { error: { code: 'resource_missing', message: "No such payment_intent" } });
                if (!['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(rec.status)) {
                    return send(res, 400, {
                        error: { code: 'payment_intent_cannot_be_cancelled', type: 'invalid_request_error', message: 'cannot cancel' },
                    });
                }
                rec.status = 'canceled';
                return send(res, 200, rec);
            }

            // POST /v1/refunds -> remboursement d'un payment_intent réussi.
            if (req.method === 'POST' && isRefunds) {
                const piId = lastRequest.form.payment_intent || null;
                const rec = piId ? intents.get(piId) : null;
                if (!rec) return send(res, 404, { error: { code: 'resource_missing', message: 'no such payment_intent' } });
                if (rec.status !== 'succeeded') {
                    return send(res, 400, {
                        error: { code: 'invalid_request_error', type: 'invalid_request_error', message: 'charge not refundable' },
                    });
                }
                rec.amount_refunded = rec.amount;
                const refund = {
                    id: `re_test_${++refundCounter}`,
                    object: 'refund',
                    status: 'succeeded',
                    payment_intent: piId,
                    charge: `ch_test_${piCounter}`,
                    amount: rec.amount,
                    currency: rec.currency,
                };
                return send(res, 200, refund);
            }

            return send(res, 404, { error: { code: 'url_not_found' } });
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

/** Appelle les endpoints de contrôle du faux serveur Stripe (port éphémère). */
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

/** Crée une transaction stripe (PENDING) via l'API. */
async function createStripePayment(body = {}) {
    const r = await api('POST', '/api/payments/create', {
        token: adminToken,
        body: {
            provider: 'stripe',
            amount: 15000,
            currency: 'XOF',
            invoiceId: `INV-STRIPE-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
            ...body,
        },
    });
    assert.equal(r.status, 201, `Création stripe échouée : ${JSON.stringify(r.data)}`);
    return r.data;
}

/** Force l'état d'un PaymentIntent côté faux Stripe. */
async function setIntentState(piId, status, { amount_refunded } = {}) {
    const r = await fakeApi('POST', '/__stripe_test/__set_state', {
        body: { id: piId, status, ...(amount_refunded !== undefined ? { amount_refunded } : {}) },
    });
    assert.equal(r.status, 200, `Impossible de piloter le PaymentIntent : ${JSON.stringify(r.data)}`);
}

/**
 * Construit un événement webhook Stripe (format officiel) et l'envoie avec une
 * signature réellement calculée (Stripe-Signature : HMAC-SHA256 de
 * "<timestamp>.<corps brut>").
 */
async function signedStripeWebhook(type, object, { secret = STRIPE_WEBHOOK_SECRET, timestamp, eventId } = {}) {
    const payload = {
        id: eventId || `evt_test_${Date.now()}_${Math.floor(Math.random() * 1000000)}`,
        object: 'event',
        type,
        created: Math.floor(Date.now() / 1000),
        livemode: false,
        pending_webhooks: 0,
        api_version: '2024-06-20',
        data: { object },
    };
    const rawBody = JSON.stringify(payload);
    const ts = timestamp !== undefined ? timestamp : Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
    const res = await fetch(`${BASE}/api/payments/webhook/stripe`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Stripe-Signature': `t=${ts},v1=${sig}`,
        },
        body: rawBody,
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* pas de corps JSON */ }
    return { status: res.status, data };
}

function intentObject(txn) {
    return {
        id: txn.providerReference,
        object: 'payment_intent',
        status: 'succeeded',
        amount: txn.amount,
        currency: txn.currency.toLowerCase(),
        metadata: { transaction_reference: txn.transactionReference },
        amount_refunded: 0,
    };
}

function chargeObject(txn) {
    return {
        id: 'ch_test_1',
        object: 'charge',
        payment_intent: txn.providerReference,
        status: 'succeeded',
        refunded: true,
        amount: txn.amount,
        amount_refunded: txn.amount,
        currency: txn.currency.toLowerCase(),
        metadata: { transaction_reference: txn.transactionReference },
    };
}

function invoiceObject(txn) {
    return {
        id: 'in_test_1',
        object: 'invoice',
        payment_intent: txn.providerReference,
        status: 'paid',
        metadata: { transaction_reference: txn.transactionReference },
    };
}

before(async () => {
    await startFakeStripeServer();

    child = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(PORT),
            NODE_ENV: 'test',
            STRIPE_ENABLED: 'true',
            STRIPE_API_URL: `http://127.0.0.1:${fakePort}`,
            STRIPE_SECRET_KEY: STRIPE_SECRET_KEY,
            STRIPE_PUBLISHABLE_KEY: STRIPE_PUBLISHABLE_KEY,
            STRIPE_WEBHOOK_SECRET: STRIPE_WEBHOOK_SECRET,
            // Délai court : utilisé par le scénario de timeout (504).
            STRIPE_TIMEOUT: '400',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});

    await waitForServer();
    superToken = await login('superadmin', 'superadmin123');

    const orgName = uniqueName('Stripe A');
    const adminUsername = uniqueName('stripe_admin_a');
    const signup = await api('POST', '/api/auth/signup', {
        body: { name: orgName, adminName: 'Admin Stripe A', adminUsername, adminPassword: 'secret123' },
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
test('Création stripe : PENDING + PaymentIntent + client_secret + authentification Bearer (aucun secret divulgué)', async () => {
    const txn = await createStripePayment({ amount: 15000 });

    assert.equal(txn.status, 'PENDING', 'Après initiation stripe, le statut doit être PENDING');
    assert.equal(txn.provider, 'stripe');
    assert.match(txn.providerReference, /^pi_test_\d+$/, 'La référence doit être l\'identifiant du PaymentIntent');
    assert.ok(txn.providerResponse.clientSecret, 'client_secret présent (finalisation par Stripe.js)');
    assert.match(txn.providerResponse.clientSecret, /^pi_test_\d+_secret_/, 'Format officiel du client_secret');
    assert.equal(txn.providerResponse.paymentUrl, null, 'Payment Intents : pas d\'URL hébergée');

    const last = await fakeApi('GET', '/__stripe_test/__last');
    assert.equal(last.data.path, '/v1/payment_intents');
    assert.equal(last.data.method, 'POST');
    assert.equal(last.data.auth, `Bearer ${STRIPE_SECRET_KEY}`, 'Authentification Bearer avec la Secret Key');
    assert.equal(last.data.form.amount, '15000', 'Montant en unité de base pour XOF (devise zéro-décimale)');
    assert.equal(last.data.form.currency, 'xof');
    assert.equal(last.data.form['automatic_payment_methods[enabled]'], 'true');
    assert.equal(last.data.form['metadata[transaction_reference]'], txn.transactionReference);

    // La clé secrète Stripe ne doit jamais fuiter dans les réponses.
    assert.ok(!JSON.stringify(txn).includes(STRIPE_SECRET_KEY), 'La Secret Key ne doit pas fuiter dans la réponse de création');

    // Deuxième paiement : aucun secret exposé, un nouveau PaymentIntent créé.
    await createStripePayment({ amount: 2000 });
    const counts = await fakeApi('GET', '/__stripe_test/__counts');
    assert.equal(counts.data.paymentIntents, 2, 'Un PaymentIntent est créé par paiement');
    const last2 = await fakeApi('GET', '/__stripe_test/__last');
    assert.equal(last2.data.path, '/v1/payment_intents');
    assert.equal(last2.data.form.amount, '2000');
});

// ============================================================
test('Polling : paiement en cours côté Stripe -> aucun changement de statut (PENDING)', async () => {
    const txn = await createStripePayment({ amount: 6000 });
    await setIntentState(txn.providerReference, 'requires_payment_method');

    const check = await api('GET', `/api/payments/${txn.id}/check`, { token: adminToken });
    assert.equal(check.status, 200);
    assert.equal(check.data.status, 'PENDING', 'Le statut local reste PENDING');
    assert.equal(check.data.actualStatus, 'PROCESSING', 'Un PaymentIntent non finalisé correspond à PROCESSING côté provider');
    assert.equal(check.data.providerChecked, true);

    const last = await fakeApi('GET', '/__stripe_test/__last');
    assert.match(last.data.path, /^\/v1\/payment_intents\/pi_test_\d+$/, 'check interroge GET /v1/payment_intents/:id');
});

// ============================================================
test('Polling après succès côté Stripe : SUCCESS + facture PAID + abonnement renouvelé', async () => {
    const txn = await createStripePayment({ amount: 12000 });
    await setIntentState(txn.providerReference, 'succeeded');

    const check = await api('GET', `/api/payments/${txn.id}/check`, { token: adminToken });
    assert.equal(check.status, 200);
    assert.equal(check.data.status, 'SUCCESS', 'Le succès observé côté Stripe doit faire passer la transaction à SUCCESS');
    assert.ok(check.data.completedAt, 'completedAt renseigné');

    const invoice = await invoices.findByNumber(txn.invoiceId);
    assert.ok(invoice, 'La facture liée doit exister');
    assert.equal(invoice.status, 'PAID', 'Une facture liée à un paiement réussi doit être PAID');

    const sub = await api('GET', '/api/subscriptions/me', { token: adminToken });
    assert.equal(sub.data.subscription.status, 'ACTIVE', 'L\'abonnement doit être renouvelé (ACTIVE)');
    assert.ok(
        new Date(sub.data.subscription.endDate) > new Date(beforeSub.endDate),
        'La date de fin doit être prolongée après le paiement réussi'
    );
});

// ============================================================
test('Webhook signé payment_intent.succeeded : réconciliation PENDING -> PROCESSING -> SUCCESS + synchronisation SaaS', async () => {
    const txn = await createStripePayment({ amount: 18000 });

    const hook = await signedStripeWebhook('payment_intent.succeeded', intentObject(txn));
    assert.equal(hook.status, 200, `Webhook signé accepté : ${JSON.stringify(hook.data)}`);
    assert.equal(hook.data.status, 'SUCCESS');

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
test('Webhooks non signés, invalides ou anciens : refusés (401) ; événement inconnu : ignoré (200)', async () => {
    const txn = await createStripePayment({ amount: 7000 });

    // En-tête de signature absent.
    const noHeader = await api('POST', '/api/payments/webhook/stripe', {
        body: { id: 'evt_test_x', object: 'event', type: 'payment_intent.succeeded', data: { object: intentObject(txn) } },
    });
    assert.equal(noHeader.status, 401, 'Webhook sans en-tête Stripe-Signature -> 401');

    // Signature invalide (mauvais secret).
    const bad = await signedStripeWebhook('payment_intent.succeeded', intentObject(txn), { secret: 'wrong-secret' });
    assert.equal(bad.status, 401, 'Webhook avec mauvaise signature -> 401');

    // Horodatage expiré (anti-rejeu) : signature valide mais ancienne.
    const stale = await signedStripeWebhook('payment_intent.succeeded', intentObject(txn), {
        timestamp: Math.floor(Date.now() / 1000) - 400,
    });
    assert.equal(stale.status, 401, 'Webhook trop ancien -> 401');

    // Événement non géré (signature valide) : accusé réception 200, ignoré,
    // la transaction reste inchangée.
    const txn2 = await createStripePayment({ amount: 3500 });
    const unknown = await signedStripeWebhook('customer.subscription.updated', {
        id: 'sub_test_1',
        object: 'subscription',
        status: 'active',
    });
    assert.equal(unknown.status, 200);
    assert.equal(unknown.data.ignored, true, 'Événement non géré -> ignoré');

    const detail = await api('GET', `/api/payments/${txn2.id}`, { token: adminToken });
    assert.equal(detail.data.status, 'PENDING', 'La transaction ne doit pas être modifiée par un événement ignoré');
});

// ============================================================
test('Webhook payment_intent.payment_failed : FAILED sans renouvellement', async () => {
    const txn = await createStripePayment({ amount: 2500 });
    const subBefore = await api('GET', '/api/subscriptions/me', { token: adminToken });

    const hook = await signedStripeWebhook('payment_intent.payment_failed', {
        ...intentObject(txn),
        status: 'requires_payment_method',
        last_payment_error: { code: 'card_declined', decline_code: 'insufficient_funds' },
    });
    assert.equal(hook.status, 200);
    assert.equal(hook.data.status, 'FAILED', 'Webhook payment_failed -> FAILED');

    const subAfter = await api('GET', '/api/subscriptions/me', { token: adminToken });
    assert.equal(
        subAfter.data.subscription.endDate,
        subBefore.data.subscription.endDate,
        'Un paiement refusé ne doit jamais renouveler l\'abonnement'
    );
});

// ============================================================
test('Webhook payment_intent.canceled : CANCELLED', async () => {
    const txn = await createStripePayment({ amount: 2500 });

    const hook = await signedStripeWebhook('payment_intent.canceled', {
        ...intentObject(txn),
        status: 'canceled',
        cancelation_reason: 'abandoned',
    });
    assert.equal(hook.status, 200);
    assert.equal(hook.data.status, 'CANCELLED', 'Webhook payment_intent.canceled -> CANCELLED');
});

// ============================================================
test('Webhook charge.refunded : REFUNDED en conservant l\'historique complet', async () => {
    const txn = await createStripePayment({ amount: 8000 });
    await signedStripeWebhook('payment_intent.succeeded', intentObject(txn));
    const subAfterSuccess = await api('GET', '/api/subscriptions/me', { token: adminToken });
    const invoiceAfterSuccess = await invoices.findByNumber(txn.invoiceId);

    const hook = await signedStripeWebhook('charge.refunded', chargeObject(txn));
    assert.equal(hook.status, 200);
    assert.equal(hook.data.status, 'REFUNDED', 'Webhook charge.refunded -> REFUNDED');

    const detail = await api('GET', `/api/payments/${txn.id}`, { token: adminToken });
    const names = (detail.data.events || []).map((e) => e.event);
    assert.ok(names.includes('SUCCESS'), 'L\'historique conserve le SUCCESS d\'origine');
    assert.ok(names.includes('REFUNDED'), 'L\'historique conserve le REFUNDED');

    const invoice = await invoices.findByNumber(txn.invoiceId);
    assert.equal(invoice.status, 'PAID', 'La facture reste PAID après remboursement (historique)');

    const sub = await api('GET', '/api/subscriptions/me', { token: adminToken });
    assert.equal(
        sub.data.subscription.endDate,
        subAfterSuccess.data.subscription.endDate,
        'Un remboursement ne modifie pas l\'abonnement renouvelé (historique conservé)'
    );
    assert.equal(invoice.status, invoiceAfterSuccess.status);
});

// ============================================================
test('Webhooks invoice.payment_succeeded / invoice.payment_failed : mapping correct', async () => {
    const ok = await createStripePayment({ amount: 5000 });
    const hookOk = await signedStripeWebhook('invoice.payment_succeeded', invoiceObject(ok));
    assert.equal(hookOk.status, 200);
    assert.equal(hookOk.data.status, 'SUCCESS', 'invoice.payment_succeeded -> SUCCESS');

    const failed = await createStripePayment({ amount: 5000 });
    const subBefore = await api('GET', '/api/subscriptions/me', { token: adminToken });
    const hookFailed = await signedStripeWebhook('invoice.payment_failed', {
        ...invoiceObject(failed),
        status: 'open',
    });
    assert.equal(hookFailed.status, 200);
    assert.equal(hookFailed.data.status, 'FAILED', 'invoice.payment_failed -> FAILED');

    const subAfter = await api('GET', '/api/subscriptions/me', { token: adminToken });
    assert.equal(subAfter.data.subscription.endDate, subBefore.data.subscription.endDate);
});

// ============================================================
test('Webhook SUCCESS dupliqué : accusé réception sans double effet SaaS', async () => {
    const txn = await createStripePayment({ amount: 9500 });

    const hook = await signedStripeWebhook('payment_intent.succeeded', intentObject(txn));
    assert.equal(hook.status, 200);
    assert.equal(hook.data.status, 'SUCCESS');

    const subBefore = await api('GET', '/api/subscriptions/me', { token: adminToken });
    const dup = await signedStripeWebhook('payment_intent.succeeded', intentObject(txn));
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
test('Annulation : cancel du PaymentIntent côté Stripe puis CANCELLED', async () => {
    const txn = await createStripePayment({ amount: 4000 });

    const cancel = await api('POST', `/api/payments/${txn.id}/cancel`, { token: adminToken });
    assert.equal(cancel.status, 200, `Annulation échouée : ${JSON.stringify(cancel.data)}`);
    assert.equal(cancel.data.status, 'CANCELLED');

    const last = await fakeApi('GET', '/__stripe_test/__last');
    assert.match(last.data.path, /^\/v1\/payment_intents\/pi_test_\d+\/cancel$/, 'POST /v1/payment_intents/:id/cancel');
    const state = await fakeApi('GET', `/__stripe_test/__state/${txn.providerReference}`);
    assert.equal(state.data.status, 'canceled', 'Le PaymentIntent doit être annulé côté Stripe');
});

// ============================================================
test('Remboursement : refund côté Stripe puis REFUNDED (historique conservé)', async () => {
    const txn = await createStripePayment({ amount: 6000 });
    await setIntentState(txn.providerReference, 'succeeded');
    const check = await api('GET', `/api/payments/${txn.id}/check`, { token: adminToken });
    assert.equal(check.data.status, 'SUCCESS');

    const refund = await api('POST', `/api/payments/${txn.id}/refund`, { token: adminToken });
    assert.equal(refund.status, 200, `Remboursement échoué : ${JSON.stringify(refund.data)}`);
    assert.equal(refund.data.status, 'REFUNDED');

    const last = await fakeApi('GET', '/__stripe_test/__last');
    assert.equal(last.data.path, '/v1/refunds', 'POST /v1/refunds');
    assert.equal(last.data.form.payment_intent, txn.providerReference);

    const detail = await api('GET', `/api/payments/${txn.id}`, { token: adminToken });
    const names = (detail.data.events || []).map((e) => e.event);
    assert.ok(names.includes('SUCCESS') && names.includes('REFUNDED'), 'Historique complet SUCCESS -> REFUNDED');

    const invoice = await invoices.findByNumber(txn.invoiceId);
    assert.equal(invoice.status, 'PAID', 'La facture conserve son statut PAID (historique)');
});

// ============================================================
test('Contrôle d\'accès : check d\'une transaction d\'une autre organisation -> 404', async () => {
    const orgNameB = uniqueName('Stripe B');
    const adminUsernameB = uniqueName('stripe_admin_b');
    const signupB = await api('POST', '/api/auth/signup', {
        body: { name: orgNameB, adminName: 'Admin Stripe B', adminUsername: adminUsernameB, adminPassword: 'secret123' },
    });
    assert.equal(signupB.status, 201);
    createdOrgIds.push(signupB.data.organization.id);
    const otherToken = await login(adminUsernameB, 'secret123');

    const txn = await createStripePayment({ amount: 1000 });
    const other = await api('GET', `/api/payments/${txn.id}/check`, { token: otherToken });
    assert.equal(other.status, 404, 'Une autre organisation ne doit pas consulter la transaction');
});

// ============================================================
test('Timeout : l\'API Stripe ne répond pas -> 504 provider_timeout', async () => {
    await fakeApi('POST', '/__stripe_test/__delay', { body: { ms: 2000 } });
    try {
        const r = await api('POST', '/api/payments/create', {
            token: adminToken,
            body: { provider: 'stripe', amount: 1000, invoiceId: `INV-STRIPE-TIMEOUT-${Date.now()}` },
        });
        assert.equal(r.status, 504, 'Réponse trop lente -> 504');
        assert.equal(r.data.code, 'provider_timeout');
    } finally {
        await fakeApi('POST', '/__stripe_test/__delay', { body: { ms: 0 } });
        // Laisse la réponse différée du faux Stripe se terminer avant la suite.
        await sleep(2200);
    }
});

// ============================================================
test('Fournisseur Stripe indisponible : 502 provider_unavailable (aucun secret divulgué)', async () => {
    // Coupe le faux Stripe : tout nouvel appel réseau échoue proprement.
    await fakeApi('POST', '/__stripe_test/__down', { body: {} });

    const r = await api('POST', '/api/payments/create', {
        token: adminToken,
        body: { provider: 'stripe', amount: 1000, invoiceId: `INV-STRIPE-DOWN-${Date.now()}` },
    });
    assert.equal(r.status, 502, 'Fournisseur injoignable -> 502');
    assert.equal(r.data.code, 'provider_unavailable');
    assert.ok(!JSON.stringify(r.data).includes(STRIPE_SECRET_KEY), 'La Secret Key ne doit pas fuiter dans la réponse');
    assert.ok(!JSON.stringify(r.data).includes('pi_test_'), 'Aucun identifiant de PaymentIntent ne doit fuiter dans la réponse d\'erreur');
});
