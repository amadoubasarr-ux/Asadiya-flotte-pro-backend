// ============================================================
// Tests d'observabilité — Phase 6.2
// ============================================================
// Couvre :
//   - health checks : /api/health, /api/health/live, /api/health/ready,
//     /api/health/details (aucun secret exposé)
//   - métriques : /api/metrics (process, requêtes, erreurs, base de données,
//     business, monitoring des paiements)
//   - monitoring des paiements : comptage par statut, taux de succès,
//     erreurs par fournisseur, activité du jour
//   - contexte de requête : X-Request-Id, correlationId
//   - journalisation avancée (production) : requestId, correlationId, durée,
//     IP, userAgent, utilisateur, organisation — sans JWT ni mot de passe
//   - erreurs : comptage des 4xx/5xx dans les métriques
//   - requêtes lentes : détection + compteur
//
// Lancer avec :  npm test
// ============================================================
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = 4330;
const BASE = `http://localhost:${PORT}`;
const ROOT = path.join(__dirname, '..');

let child = null;
let superToken = null;
const createdOrgIds = [];

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnServer(port, extraEnv = {}) {
    const c = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(port),
            NODE_ENV: 'test',
            ...extraEnv,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    c.stdout.on('data', () => {});
    c.stderr.on('data', () => {});
    return c;
}

async function waitForServer(base, timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const res = await fetch(`${base}/api/health`);
            if (res.ok) return;
        } catch (e) { /* serveur pas encore prêt */ }
        await sleep(300);
    }
    throw new Error('Le serveur de test ne démarre pas.');
}

async function api(method, p, { token, body, base = BASE, headers = {} } = {}) {
    const res = await fetch(base + p, {
        method,
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* pas de corps JSON */ }
    return { status: res.status, data, headers: res.headers };
}

function uniqueName(prefix) {
    return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
}

before(async () => {
    child = spawnServer(PORT);
    await waitForServer(BASE);
    const r = await api('POST', '/api/auth/login', { body: { username: 'superadmin', password: 'superadmin123' } });
    assert.equal(r.status, 200, 'Login superadmin échoué');
    superToken = r.data.token;

    // Une organisation garantit les compteurs agrégés (organizations >= 1,
    // activeSubscriptions >= 1) indépendamment des autres fichiers de tests.
    const orgName = uniqueName('Monitored Org');
    const adminUsername = uniqueName('monitored_admin');
    const signup = await api('POST', '/api/auth/signup', {
        body: { name: orgName, adminName: 'Monitored Admin', adminUsername, adminPassword: 'secret123' },
    });
    assert.equal(signup.status, 201, `Signup échoué : ${JSON.stringify(signup.data)}`);
    createdOrgIds.push(signup.data.organization.id);
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
test('Health de base : /api/health répond ok avec version, environnement et uptime', async () => {
    const r = await api('GET', '/api/health');
    assert.equal(r.status, 200);
    assert.equal(r.data.status, 'ok', 'Contrat Docker HEALTHCHECK : status=ok');
    assert.ok(r.data.time, 'time manquant');
    assert.equal(typeof r.data.uptime, 'number');
    assert.ok(r.data.uptime >= 0);
    assert.ok(r.data.version, 'version manquante');
    assert.equal(r.data.environment, 'test');
    // Contexte de requête exposé au client.
    assert.ok(r.headers.get('x-request-id'), 'X-Request-Id manquant');
});

test('Health liveness : /api/health/live répond ok', async () => {
    const r = await api('GET', '/api/health/live');
    assert.equal(r.status, 200);
    assert.equal(r.data.status, 'ok');
    assert.equal(r.data.environment, 'test');
});

test('Health readiness : /api/health/ready vérifie PostgreSQL et les providers', async () => {
    const r = await api('GET', '/api/health/ready');
    assert.equal(r.status, 200, `Ready doit être 200 quand la base est saine (reçu ${r.status})`);
    assert.equal(r.data.status, 'ok');
    assert.ok(r.data.checks, 'checks manquant');
    assert.equal(r.data.checks.database.ok, true, 'PostgreSQL doit être joignable');
    assert.equal(typeof r.data.checks.database.latencyMs, 'number');

    const providers = r.data.checks.providers;
    assert.ok(providers, 'providers manquant');
    // mock : toujours activé et configuré ; providers réels désactivés par défaut.
    assert.equal(providers.mock.enabled, true);
    assert.equal(providers.mock.configured, true);
    for (const name of ['wave', 'orange_money', 'stripe']) {
        assert.equal(providers[name].enabled, false, `${name} doit être désactivé par défaut`);
        assert.equal(typeof providers[name].configured, 'boolean');
    }
    // Aucun secret dans la réponse.
    assert.ok(!JSON.stringify(r.data).includes('postgres://'), 'DATABASE_URL ne doit pas fuiter');
});

test('Health details : vue complète (mémoire, disque, DB, business, providers, responseTime)', async () => {
    const r = await api('GET', '/api/health/details');
    assert.equal(r.status, 200);
    assert.equal(r.data.status, 'ok');
    assert.ok(r.data.version);
    assert.equal(typeof r.data.uptime, 'number');
    assert.ok(r.data.node, 'version Node manquante');

    // Mémoire / CPU / OS.
    assert.ok(r.data.memory && r.data.memory.rss > 0, 'mémoire manquante');
    assert.ok(r.data.cpu && r.data.cpu.cores >= 1);
    assert.ok(r.data.os && r.data.os.platform);

    // Espace disque (booléen selon disponibilité du système).
    assert.equal(typeof r.data.disk.available, 'boolean');
    if (r.data.disk.available) {
        assert.ok(r.data.disk.totalBytes > 0);
        assert.equal(typeof r.data.disk.usedPercent, 'number');
    }

    // Base de données.
    assert.equal(r.data.database.ok, true);
    assert.equal(typeof r.data.database.latencyMs, 'number');

    // Compteurs métier agrégés.
    assert.ok(r.data.business, 'business manquant');
    assert.ok(r.data.business.organizations >= 1, 'au moins l\'organisation par défaut');
    assert.equal(typeof r.data.business.paymentsToday, 'number');

    // Paiements (agrégats, aucun secret).
    assert.ok(r.data.payments, 'payments manquant');
    assert.equal(typeof r.data.payments.successRate, 'number');
    assert.equal(typeof r.data.payments.avgProcessingTimeMs, 'number');

    // Providers : état seulement (activé / configuré).
    assert.ok(r.data.providers.mock);

    // Requêtes traitées par ce process.
    assert.ok(r.data.requests.total >= 1, 'au moins la requête courante de santé');

    // Temps de réponse mesuré.
    assert.ok(r.data.responseTimeMs >= 0);

    // AUCUN secret ne doit être exposé.
    const json = JSON.stringify(r.data);
    assert.ok(!json.includes('postgres://'), 'URL de base de données interdite');
    assert.ok(!json.includes('password'), 'mot de passe interdit');
    assert.ok(!json.includes('jwt'), 'jeton JWT interdit');
});

test('Métriques : /api/metrics expose process, requêtes, erreurs, DB, business et paiements', async () => {
    const r = await api('GET', '/api/metrics');
    assert.equal(r.status, 200);
    assert.equal(r.data.environment, 'test');

    // Process.
    assert.ok(r.data.process.memory.rss > 0);
    assert.ok(r.data.process.cpu.cores >= 1);
    assert.ok(r.data.process.uptime >= 0);
    assert.ok(r.data.process.node);

    // Requêtes.
    assert.equal(typeof r.data.requests.total, 'number');
    assert.ok(r.data.requests.total >= 1, 'des requêtes ont déjà été traitées');
    assert.ok(r.data.requests.byMethod.GET >= 1);
    assert.equal(typeof r.data.requests.avgDurationMs, 'number');
    assert.ok(Array.isArray(r.data.requests.recentSlow));

    // Erreurs.
    assert.equal(typeof r.data.errors.total, 'number');
    assert.ok(r.data.errors.byStatus);

    // Base de données + SQL.
    assert.equal(r.data.database.ok, true);
    assert.equal(typeof r.data.database.activeConnections, 'number');
    assert.ok(r.data.sql.total >= 1, 'des requêtes SQL ont déjà été exécutées');
    assert.equal(typeof r.data.sql.avgDurationMs, 'number');

    // Business (agrégats).
    assert.ok(r.data.business.organizations >= 1);
    assert.equal(typeof r.data.business.activeSubscriptions, 'number');
    assert.equal(typeof r.data.business.paymentsToday, 'number');

    // Paiements (agrégats).
    assert.ok(r.data.payments, 'payments manquant');
    assert.ok(r.data.payments.byStatus);
    assert.ok(r.data.payments.byProvider);
    assert.ok(r.data.payments.successRate >= 0 && r.data.payments.successRate <= 1);
    assert.equal(typeof r.data.payments.errorsPerProvider, 'object');
    assert.equal(typeof r.data.payments.today.total, 'number');

    // Aucune donnée confidentielle.
    const json = JSON.stringify(r.data);
    assert.ok(!json.includes('postgres://'), 'URL de base de données interdite');
    assert.ok(!json.includes('password'), 'mot de passe interdit');
    assert.ok(!json.includes('transaction_reference'), 'référence de transaction interdite');
});

test('Monitoring des paiements : comptage SUCCESS/FAILED, taux de succès et erreurs par provider', async () => {
    // Crée une organisation + admin.
    const orgName = uniqueName('Mon Org');
    const adminUsername = uniqueName('mon_admin');
    const signup = await api('POST', '/api/auth/signup', {
        body: { name: orgName, adminName: 'Mon Admin', adminUsername, adminPassword: 'secret123' },
    });
    assert.equal(signup.status, 201, `Signup échoué : ${JSON.stringify(signup.data)}`);
    createdOrgIds.push(signup.data.organization.id);

    const login = await api('POST', '/api/auth/login', { body: { username: adminUsername, password: 'secret123' } });
    assert.equal(login.status, 200);
    const token = login.data.token;

    // Paiement mock réussi : create -> PENDING, PROCESSING, webhook -> SUCCESS.
    const pay1 = await api('POST', '/api/payments/create', {
        token,
        body: { provider: 'mock', amount: 5000, currency: 'XOF' },
    });
    assert.equal(pay1.status, 201, `Création paiement échouée : ${JSON.stringify(pay1.data)}`);
    assert.equal(pay1.data.status, 'PENDING');
    const ref1 = pay1.data.transactionReference;

    const proc1 = await api('POST', '/api/payments/webhook/mock', {
        body: { transactionReference: ref1, event: 'PROCESSING' },
    });
    assert.equal(proc1.status, 200, `Webhook PROCESSING échoué : ${JSON.stringify(proc1.data)}`);
    assert.equal(proc1.data.status, 'PROCESSING');

    const webhook1 = await api('POST', '/api/payments/webhook/mock', {
        body: { transactionReference: ref1, event: 'SUCCESS' },
    });
    assert.equal(webhook1.status, 200, `Webhook SUCCESS échoué : ${JSON.stringify(webhook1.data)}`);
    assert.equal(webhook1.data.status, 'SUCCESS');

    // Paiement mock échoué : create -> PENDING, PROCESSING, webhook -> FAILED.
    const pay2 = await api('POST', '/api/payments/create', {
        token,
        body: { provider: 'mock', amount: 3000, currency: 'XOF' },
    });
    assert.equal(pay2.status, 201);
    const ref2 = pay2.data.transactionReference;

    const proc2 = await api('POST', '/api/payments/webhook/mock', {
        body: { transactionReference: ref2, event: 'PROCESSING' },
    });
    assert.equal(proc2.status, 200);

    const webhook2 = await api('POST', '/api/payments/webhook/mock', {
        body: { transactionReference: ref2, event: 'FAILED' },
    });
    assert.equal(webhook2.status, 200);
    assert.equal(webhook2.data.status, 'FAILED');

    // Les agrégats de monitoring reflètent ces transitions (>= car la base
    // est partagée avec d'éventuelles autres exécutions concurrentes).
    const metrics = await api('GET', '/api/metrics');
    assert.equal(metrics.status, 200);
    const p = metrics.data.payments;

    assert.ok(p.byStatus.SUCCESS >= 1, 'au moins 1 paiement SUCCESS compté');
    assert.ok(p.byStatus.FAILED >= 1, 'au moins 1 paiement FAILED compté');
    assert.ok(p.byProvider.mock.SUCCESS >= 1, 'SUCCESS ventilé sur mock');
    assert.ok(p.byProvider.mock.FAILED >= 1, 'FAILED ventilé sur mock');
    assert.ok(p.successRate > 0 && p.successRate <= 1, 'taux de succès dans ]0,1]');
    assert.ok(p.errorsPerProvider.mock >= 1, 'erreurs comptées pour le provider mock');
    assert.ok(p.today.total >= 2, 'au moins 2 paiements aujourd\'hui');
});

test('Erreurs HTTP : comptées dans /api/metrics', async () => {
    // Route inconnue -> 404 (comptée comme erreur 4xx).
    const notFound = await api('GET', '/api/routes/inexistante');
    assert.equal(notFound.status, 404);

    const metrics = await api('GET', '/api/metrics');
    assert.equal(metrics.status, 200);
    assert.ok(metrics.data.errors.total >= 1, 'au moins 1 erreur HTTP comptée');
    assert.ok(metrics.data.errors.byStatus[404] >= 1, 'statut 404 compté');
});

test('Contexte de requête : X-Request-Id unique sur chaque réponse', async () => {
    const a = await api('GET', '/api/health');
    const b = await api('GET', '/api/health');
    const idA = a.headers.get('x-request-id');
    const idB = b.headers.get('x-request-id');
    assert.ok(idA && idB, 'X-Request-Id manquant');
    assert.notEqual(idA, idB, 'X-Request-Id doit être unique par requête');
});

// ============================================================
// Journalisation avancée en production (contexte de requête)
// ============================================================
const STRONG_SECRET = 'p6-super-secret-aleatoire-plus-de-32-caracteres-2026!!';
const PROD_ORIGIN = 'https://flotte.example.com';
const PROD_DB = process.env.DATABASE_URL || 'postgres://postgres:amadou@localhost:5432/asadiya_flotte';

test('Journalisation production : requestId, correlationId, durée, IP, userAgent, user — sans JWT ni mot de passe', async () => {
    const port = 4331;
    const logs = [];
    const prodChild = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(port),
            NODE_ENV: 'production',
            JWT_SECRET: STRONG_SECRET,
            CORS_ORIGIN: PROD_ORIGIN,
            DATABASE_URL: PROD_DB,
            LOG_LEVEL: 'info',
            PERF_REPORT_INTERVAL_MS: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    prodChild.stdout.on('data', (d) => logs.push(d.toString()));
    prodChild.stderr.on('data', (d) => logs.push(d.toString()));
    try {
        await waitForServer(`http://localhost:${port}`);

        // Connexion (le mot de passe ne doit jamais apparaître dans les logs).
        const login = await api('POST', '/api/auth/login', {
            base: `http://localhost:${port}`,
            body: { username: 'superadmin', password: 'superadmin123' },
        });
        assert.equal(login.status, 200);

        // Organisation + admin pour une requête authentifiée rattachée à une
        // organisation (userId + organizationId dans les logs).
        const orgName = uniqueName('Prod Log Org');
        const adminUsername = uniqueName('prodlog_admin');
        const adminPassword = uniqueName('pw_') + 'Ab9!';
        const signup = await api('POST', '/api/auth/signup', {
            base: `http://localhost:${port}`,
            body: { name: orgName, adminName: 'Prod Log Admin', adminUsername, adminPassword },
        });
        assert.equal(signup.status, 201, `Signup échoué : ${JSON.stringify(signup.data)}`);

        const adminLogin = await api('POST', '/api/auth/login', {
            base: `http://localhost:${port}`,
            body: { username: adminUsername, password: adminPassword },
        });
        assert.equal(adminLogin.status, 200);
        const token = adminLogin.data.token;

        // Requête authentifiée avec correlationId propagé par le client.
        const CORR = `corr-test-${Date.now()}`;
        const vehicles = await api('GET', '/api/vehicles', {
            base: `http://localhost:${port}`,
            token,
            headers: { 'X-Correlation-Id': CORR, 'User-Agent': 'monitoring-test-agent' },
        });
        assert.equal(vehicles.status, 200, `GET /api/vehicles échoué : ${JSON.stringify(vehicles.data)}`);

        // Attendre que la ligne de log de la requête corrélée soit réellement écrite.
        const deadline = Date.now() + 4000;
        while (Date.now() < deadline) {
            if (logs.join('').includes(CORR)) break;
            await sleep(100);
        }

        const out = logs.join('');
        // Contexte de requête présent sur la ligne http.request.
        assert.match(out, /"requestId":"[0-9a-f-]{36}"/, 'requestId manquant');
        assert.ok(out.includes(`"correlationId":"${CORR}"`), 'correlationId non propagé dans les logs');
        assert.match(out, /"durationMs":\d/, 'durée de requête manquante');
        assert.match(out, /"ip":"/, 'IP manquante');
        assert.ok(out.includes('"agent":"monitoring-test-agent"'), 'userAgent manquant');
        assert.match(out, /"userId":\d+/, 'utilisateur authentifié non journalisé');
        assert.match(out, /"organizationId":\d+/, 'organisation non journalisée');

        // Aucune donnée sensible dans les logs.
        assert.ok(!out.includes(token), 'Le JWT ne doit jamais être journalisé');
        assert.ok(!out.includes('superadmin123'), 'Le mot de passe superadmin ne doit jamais être journalisé');
        assert.ok(!out.includes(adminPassword), 'Le mot de passe admin ne doit jamais être journalisé');
    } finally {
        prodChild.kill();
        await sleep(500);
    }
});

test('Requêtes lentes : détection (> seuil), log d\'avertissement et compteur', async () => {
    const port = 4332;
    const logs = [];
    const slowChild = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(port),
            NODE_ENV: 'test',
            SLOW_REQUEST_THRESHOLD_MS: '0', // toute requête est « lente »
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    slowChild.stdout.on('data', (d) => logs.push(d.toString()));
    slowChild.stderr.on('data', (d) => logs.push(d.toString()));
    try {
        await waitForServer(`http://localhost:${port}`);

        const r = await api('GET', '/api/health', { base: `http://localhost:${port}` });
        assert.equal(r.status, 200);

        const metrics = await api('GET', '/api/metrics', { base: `http://localhost:${port}` });
        assert.equal(metrics.status, 200);
        assert.ok(metrics.data.requests.slowCount >= 1, 'requêtes lentes comptées');

        // L'avertissement http.request.slow est émis.
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
            if (logs.join('').includes('http.request.slow')) break;
            await sleep(100);
        }
        assert.ok(logs.join('').includes('http.request.slow'), 'log http.request.slow manquant');
    } finally {
        slowChild.kill();
        await sleep(500);
    }
});
