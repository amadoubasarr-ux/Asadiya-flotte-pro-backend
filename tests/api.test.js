// ============================================================
// Tests API — Phase 3.5 SaaS abonnements
// ============================================================
// Lance le serveur sur un port dédié (avec la DATABASE_URL du projet),
// puis exécute des scénarios de bout en bout :
//   - création d'organisation + abonnement (TRIAL 14 jours)
//   - consultation du contexte d'abonnement
//   - dépassement de la limite de véhicules du plan
//   - changement de plan par le SuperAdmin
//   - expiration d'abonnement + blocage des écritures
//   - renouvellement après expiration
//
// Les organisations créées par les tests sont supprimées à la fin (cleanup).
//
// Lancer avec :  npm test
// ============================================================
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = 4310;
const BASE = `http://localhost:${PORT}`;

let child = null;
let superToken = null;
let adminToken = null;
let adminOrgId = null;
let adminUsername = null;
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

async function api(method, p, { token, body } = {}) {
    const res = await fetch(BASE + p, {
        method,
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* pas de corps JSON */ }
    return { status: res.status, data };
}

async function login(username, password) {
    const r = await api('POST', '/api/auth/login', { body: { username, password } });
    assert.equal(r.status, 200, `Login ${username} échoué : ${JSON.stringify(r.data)}`);
    assert.ok(r.data.token, 'Le login doit renvoyer un token');
    return r.data.token;
}

function uniqueOrgName(prefix) {
    return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
}

function uniqueUsername(prefix) {
    return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 100000)}`.slice(0, 60);
}

before(async () => {
    const rootDir = path.join(__dirname, '..');
    child = spawn(process.execPath, ['server.js'], {
        cwd: rootDir,
        env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});

    await waitForServer();
    superToken = await login('superadmin', 'superadmin123');
});

after(async () => {
    // Nettoyage : suppression des organisations créées par les tests.
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
test('GET /api/plans/public est accessible sans authentification', async () => {
    const r = await api('GET', '/api/plans/public');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data), 'Doit renvoyer un tableau de plans');
    assert.ok(r.data.length >= 3, 'Au moins 3 plans (Starter, Pro, Enterprise)');
    const codes = r.data.map((p) => p.code);
    assert.ok(codes.includes('STARTER') && codes.includes('PRO') && codes.includes('ENTERPRISE'));
});

// ============================================================
test('Création d\'une organisation + abonnement TRIAL 14 jours (tunnel d\'inscription)', async () => {
    const orgName = uniqueOrgName('SaaS Test');
    adminUsername = uniqueUsername('saas_admin');

    const r = await api('POST', '/api/auth/signup', {
        body: {
            name: orgName,
            adminName: 'Admin Test Phase 3.5',
            adminUsername,
            adminPassword: 'secret123',
        },
    });
    assert.equal(r.status, 201, `Signup échoué : ${JSON.stringify(r.data)}`);
    assert.ok(r.data.organization && r.data.organization.id, 'Organisation créée');
    assert.ok(r.data.subscription, 'Abonnement créé');
    assert.equal(r.data.subscription.status, 'TRIAL');
    assert.equal(r.data.subscription.plan, 'STARTER', 'Plan par défaut = STARTER');

    adminOrgId = r.data.organization.id;
    createdOrgIds.push(adminOrgId);

    // Durée de l'essai : endDate - startDate ≈ TRIAL_DAYS (14).
    const start = new Date(r.data.subscription.startDate);
    const end = new Date(r.data.subscription.endDate);
    const days = Math.round((end - start) / 86400000);
    assert.equal(days, 14, `Essai de 14 jours, reçu ${days}`);

    // Première connexion : le nouvel admin se connecte.
    adminToken = await login(adminUsername, 'secret123');
    assert.ok(adminToken);
});

// ============================================================
test('Contexte d\'abonnement exposé au client (plan, usage, jours restants)', async () => {
    assert.ok(adminToken, 'adminToken requis (dépend du test précédent)');
    const r = await api('GET', '/api/subscriptions/me', { token: adminToken });
    assert.equal(r.status, 200);
    assert.equal(r.data.exists, true);
    assert.equal(r.data.subscription.planCode, 'STARTER');
    assert.equal(r.data.subscription.status, 'TRIAL');
    assert.equal(r.data.daysLeft, 14);
    assert.equal(r.data.limits.vehicles, 10, 'Starter : 10 véhicules max');
    assert.equal(r.data.limits.users, 5, 'Starter : 5 utilisateurs max');
    assert.equal(r.data.usage.vehicles, 0);
    assert.equal(r.data.usage.users, 1, 'L\'admin compte comme 1 utilisateur');
});

// ============================================================
test('Dépassement de la limite de véhicules du plan (Starter = 10)', async () => {
    assert.ok(adminToken);
    const plate = (i) => `TEST-${Date.now()}-${i}`;

    // 10 véhicules : autorisés.
    for (let i = 1; i <= 10; i++) {
        const r = await api('POST', '/api/vehicles', {
            token: adminToken,
            body: { plate: plate(i), brand: 'Toyota', model: 'Hilux' },
        });
        assert.equal(r.status, 201, `Véhicule #${i} refusé : ${JSON.stringify(r.data)}`);
    }

    // Le 11e doit être bloqué avec une erreur conflict vehicle_limit.
    const blocked = await api('POST', '/api/vehicles', {
        token: adminToken,
        body: { plate: plate(11), brand: 'Toyota', model: 'Hilux' },
    });
    assert.equal(blocked.status, 409, `11e véhicule devrait être refusé : ${JSON.stringify(blocked.data)}`);
    assert.equal(blocked.data.conflict && blocked.data.conflict.kind, 'vehicle_limit');
});

// ============================================================
test('Changement de plan par le SuperAdmin (STARTER -> PRO)', async () => {
    assert.ok(adminOrgId && superToken);
    const r = await api('PUT', `/api/organizations/${adminOrgId}/subscription`, {
        token: superToken,
        body: { planCode: 'PRO', status: 'ACTIVE', reason: 'Test Phase 3.5' },
    });
    assert.equal(r.status, 200, `Changement de plan échoué : ${JSON.stringify(r.data)}`);
    assert.equal(r.data.plan, 'PRO');

    const me = await api('GET', '/api/subscriptions/me', { token: adminToken });
    assert.equal(me.status, 200);
    assert.equal(me.data.subscription.planCode, 'PRO');
    assert.equal(me.data.subscription.status, 'ACTIVE');
    assert.equal(me.data.limits.vehicles, 50, 'Pro : 50 véhicules max');
});

// ============================================================
test('Expiration d\'abonnement : consultation autorisée, écritures bloquées', async () => {
    assert.ok(adminOrgId && superToken);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    // Le SuperAdmin force une date de fin dépassée.
    const upd = await api('PUT', `/api/organizations/${adminOrgId}/subscription`, {
        token: superToken,
        body: { planCode: 'PRO', status: 'ACTIVE', endDate: yesterday, reason: 'Forcer l\'expiration (test)' },
    });
    assert.equal(upd.status, 200);

    // Statut effectif : EXPIRED.
    const me = await api('GET', '/api/subscriptions/me', { token: adminToken });
    assert.equal(me.data.subscription.status, 'EXPIRED', 'Le statut effectif doit être EXPIRED');

    // Lecture toujours autorisée.
    const list = await api('GET', '/api/vehicles', { token: adminToken });
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.data) && list.data.length === 10, 'Consultation limitée autorisée');

    // Écriture bloquée (403 code subscription_inactive).
    const write = await api('POST', '/api/vehicles', {
        token: adminToken,
        body: { plate: `BLOCK-${Date.now()}`, brand: 'Toyota', model: 'Hilux' },
    });
    assert.equal(write.status, 403, `Écriture attendue bloquée : ${JSON.stringify(write.data)}`);
    assert.equal(write.data.code, 'subscription_inactive');
});

// ============================================================
test('Renouvellement autorisé même après expiration (point de sortie)', async () => {
    assert.ok(adminToken);
    const renew = await api('POST', '/api/subscriptions/me/renew', {
        token: adminToken,
        body: { reason: 'Renouvellement (test)' },
    });
    assert.equal(renew.status, 200, `Renouvellement échoué : ${JSON.stringify(renew.data)}`);
    assert.equal(renew.data.status, 'ACTIVE');

    // Date de fin de nouveau dans le futur.
    const me = await api('GET', '/api/subscriptions/me', { token: adminToken });
    assert.equal(me.data.subscription.status, 'ACTIVE');
    const end = new Date(me.data.subscription.endDate);
    assert.ok(end.getTime() > Date.now(), 'Nouvelle date de fin dans le futur');

    // Les écritures redeviennent possibles (plan PRO : 50 véhicules, on en a 10).
    const write = await api('POST', '/api/vehicles', {
        token: adminToken,
        body: { plate: `AFTER-RENEW-${Date.now()}`, brand: 'Toyota', model: 'Hilux' },
    });
    assert.equal(write.status, 201, `Écriture après renouvellement : ${JSON.stringify(write.data)}`);
});
