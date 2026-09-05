// ============================================================
// Tests de sécurité — Phase 4.1
// ============================================================
// Vérifie les protections ajoutées pour la préparation production :
//   - anti force brute sur la connexion (429 après N échecs)
//   - non-exposition des fichiers sensibles du projet (source, .env, données)
//   - en-têtes de sécurité HTTP (CSP, HSTS, Permissions-Policy, nosniff...)
//   - configuration de production stricte (secrets faibles / CORS ouvert refusés)
//   - restriction CORS en production (origine non autorisée -> pas d'en-tête ACAO)
//   - validation d'entrée (dates invalides refusées, dates vides acceptées)
//
// Lancer avec :  npm test
// ============================================================
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');

const PORT = 4325;
const BASE = `http://localhost:${PORT}`;
const ROOT = path.join(__dirname, '..');

// Limite volontairement basse pour le test d'anti force brute.
const LOGIN_LIMIT_MAX = 5;

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
            LOGIN_RATE_LIMIT_MAX: String(LOGIN_LIMIT_MAX),
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

// ============================================================
// Assertions de configuration de production (processus enfant isolé)
// ============================================================

function runConfigAssertion(envOverrides) {
    const code = `
        const { assertProductionConfig } = require('./config');
        try {
            assertProductionConfig();
            process.stdout.write('OK');
        } catch (e) {
            process.stdout.write('THREW:' + (e.message.split('\\n')[1] || ''));
        }
    `;
    const res = spawnSync(process.execPath, ['-e', code], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, NODE_ENV: 'production', ...envOverrides },
    });
    return (res.stdout || '') + (res.stderr || '');
}

const STRONG_SECRET = 'p4-super-secret-aleatoire-de-plus-de-32-caracteres-2026!';
const PROD_ORIGIN = 'https://flotte.example.com';

before(async () => {
    child = spawnServer(PORT);
    await waitForServer(BASE);
    const r = await api('POST', '/api/auth/login', { body: { username: 'superadmin', password: 'superadmin123' } });
    assert.equal(r.status, 200, 'Login superadmin échoué');
    superToken = r.data.token;
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
test('Configuration production : secret faible / CORS ouvert refusés au démarrage', async () => {
    // 1. JWT_SECRET placeholder connu -> refusé.
    assert.match(runConfigAssertion({
        JWT_SECRET: 'change-moi-en-production-asadiya-flotte-pro',
        CORS_ORIGIN: PROD_ORIGIN,
        DATABASE_URL: 'postgres://x',
    }), /THREW:/, 'Le secret placeholder doit être refusé en production.');

    // 2. CORS ouvert à toutes les origines -> refusé.
    assert.match(runConfigAssertion({
        JWT_SECRET: STRONG_SECRET,
        CORS_ORIGIN: '*',
        DATABASE_URL: 'postgres://x',
    }), /THREW:/, 'CORS_ORIGIN=* doit être refusé en production.');

    // 3. Configuration valide -> acceptée.
    assert.match(runConfigAssertion({
        JWT_SECRET: STRONG_SECRET,
        CORS_ORIGIN: PROD_ORIGIN,
        DATABASE_URL: 'postgres://x',
    }), /OK/, 'Une configuration valide doit être acceptée.');

    // 4. PORT invalide -> refusé (validation stricte des variables critiques).
    assert.match(runConfigAssertion({
        JWT_SECRET: STRONG_SECRET,
        CORS_ORIGIN: PROD_ORIGIN,
        DATABASE_URL: 'postgres://x',
        PORT: 'not-a-port',
    }), /THREW:/, 'PORT invalide doit être refusé en production.');

    // 5. JSON_LIMIT invalide -> refusé.
    assert.match(runConfigAssertion({
        JWT_SECRET: STRONG_SECRET,
        CORS_ORIGIN: PROD_ORIGIN,
        DATABASE_URL: 'postgres://x',
        JSON_LIMIT: 'huge',
    }), /THREW:/, 'JSON_LIMIT invalide doit être refusé en production.');
});

// ============================================================
test('Fichiers sensibles du projet non exposés (aucune fuite de source/données)', async () => {
    const publicOk = [
        '/', '/index.html', '/app.js',
    ];
    for (const p of publicOk) {
        const r = await api('GET', p);
        assert.equal(r.status, 200, `${p} doit être servi`);
    }

    const blocked = [
        '/config.js', '/server.js', '/package.json', '/package-lock.json',
        '/db/migrate.js', '/db/repositories.js', '/db/pool.js',
        '/routes/auth.js', '/middleware/auth.js', '/utils/validators.js',
        '/services/subscriptions.js', '/tests/api.test.js',
        '/data/db.json', '/.env', '/.env.example', '/.gitignore',
        '/node_modules/express/package.json', '/_tmp_server_err.log',
        '/backup_old_json/db.json', '/index.html/../config.js',
    ];
    for (const p of blocked) {
        const r = await api('GET', p);
        assert.equal(r.status, 404, `${p} ne doit PAS être servi (reçu ${r.status})`);
    }
});

// ============================================================
test('En-têtes de sécurité HTTP présents et corrects', async () => {
    const r = await api('GET', '/api/health');
    assert.equal(r.status, 200);

    // Helmet : no-sniff, HSTS, Referrer-Policy, CSP (avec frame-ancestors 'none'),
    // X-Frame-Options DENY (cohérent avec frame-ancestors 'none').
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(r.headers.get('strict-transport-security'), 'HSTS manquant');
    assert.match(r.headers.get('strict-transport-security'), /max-age=\d+; includeSubDomains/, 'HSTS : max-age + includeSubDomains');
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    const csp = r.headers.get('content-security-policy') || '';
    assert.ok(csp.includes("default-src 'self'"), 'CSP : default-src manquant');
    assert.ok(csp.includes("frame-ancestors 'none'"), 'CSP : frame-ancestors manquant');

    // Permissions-Policy ajouté manuellement (helmet v8 ne le fournit plus).
    assert.ok(r.headers.get('permissions-policy'), 'Permissions-Policy manquant');
    assert.ok(r.headers.get('permissions-policy').includes('camera=()'));

    // Aucune divulgation de la technologie serveur.
    assert.equal(r.headers.get('x-powered-by'), null, 'X-Powered-By ne doit pas être exposé');
});

// ============================================================
test('Limite de taille JSON : corps trop volumineux -> 413 (payload_too_large)', async () => {
    const port = 4323;
    const child413 = spawnServer(port, { JSON_LIMIT: '1kb' });
    try {
        await waitForServer(`http://localhost:${port}`);
        const r = await api('POST', '/api/auth/login', {
            base: `http://localhost:${port}`,
            body: { photo: 'x'.repeat(8192) },
        });
        assert.equal(r.status, 413, `Corps trop volumineux attendu 413 (reçu ${r.status})`);
        assert.equal(r.data.code, 'payload_too_large');
    } finally {
        child413.kill();
        await sleep(500);
    }
});

// ============================================================
test('Journalisation production : sortie JSON structurée (démarrage + requêtes)', async () => {
    const port = 4324;
    const logs = [];
    const prodChild = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(port),
            NODE_ENV: 'production',
            JWT_SECRET: STRONG_SECRET,
            CORS_ORIGIN: PROD_ORIGIN,
            DATABASE_URL: process.env.DATABASE_URL || 'postgres://postgres:amadou@localhost:5432/asadiya_flotte',
            LOG_LEVEL: 'info',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    prodChild.stdout.on('data', (d) => logs.push(d.toString()));
    prodChild.stderr.on('data', (d) => logs.push(d.toString()));
    try {
        await waitForServer(`http://localhost:${port}`);

        // La sortie passe par un pipe : on attend que la requête de health
        // soit réellement journalisée avant d'asserter.
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
            if (logs.join('').includes('"msg":"http.request"')) break;
            await sleep(100);
        }

        const out = logs.join('');
        assert.match(out, /"level":"info"/, 'Les logs doivent être des lignes JSON en production');
        assert.match(out, /"msg":"server\.started"/, 'Le log de démarrage doit être présent');
        assert.match(out, /"msg":"http\.request"/, 'Les requêtes HTTP doivent être journalisées');
    } finally {
        prodChild.kill();
        await sleep(500);
    }
});

// ============================================================
test('Chemins inconnus : réponse 404 propre (et non 500)', async () => {
    for (const p of ['/inconnu', '/foo/bar', '/api/routes/inconnue', '/%2e%2e/server.js']) {
        const r = await api('GET', p);
        assert.equal(r.status, 404, `${p} doit renvoyer 404 (reçu ${r.status})`);
    }
});

// ============================================================
test('CORS restreint en production : origine non autorisée sans en-tête ACAO', async () => {
    // Port dédié (4321 peut être occupé par le serveur de développement).
    const prodPort = 4322;
    const prodBase = `http://localhost:${prodPort}`;
    const prodChild = spawnServer(prodPort, {
        NODE_ENV: 'production',
        JWT_SECRET: STRONG_SECRET,
        CORS_ORIGIN: PROD_ORIGIN,
        DATABASE_URL: process.env.DATABASE_URL || 'postgres://postgres:amadou@localhost:5432/asadiya_flotte',
    });
    try {
        await waitForServer(prodBase);

        const allowed = await api('GET', '/api/health', { base: prodBase, headers: { Origin: PROD_ORIGIN } });
        assert.equal(allowed.status, 200);
        assert.equal(allowed.headers.get('access-control-allow-origin'), PROD_ORIGIN);

        const denied = await api('GET', '/api/health', { base: prodBase, headers: { Origin: 'https://evil.example.com' } });
        assert.equal(denied.status, 200);
        assert.equal(denied.headers.get('access-control-allow-origin'), null,
            'L\'origine non autorisée ne doit recevoir aucun en-tête CORS.');
    } finally {
        prodChild.kill();
        await sleep(500);
    }
});

// ============================================================
test('Validation d\'entrée : dates invalides refusées, dates vides acceptées', async () => {
    const orgName = uniqueName('Sec Org');
    const adminUsername = uniqueName('sec_admin');
    const signup = await api('POST', '/api/auth/signup', {
        body: { name: orgName, adminName: 'Sec Admin', adminUsername, adminPassword: 'secret123' },
    });
    assert.equal(signup.status, 201, `Signup échoué : ${JSON.stringify(signup.data)}`);
    createdOrgIds.push(signup.data.organization.id);

    const login = await api('POST', '/api/auth/login', { body: { username: adminUsername, password: 'secret123' } });
    assert.equal(login.status, 200);
    const token = login.data.token;

    // Date invalide -> 400 avec message clair (avant même la couche base de données).
    const badDate = await api('POST', '/api/vehicles', {
        token,
        body: { plate: 'SEC-1', brand: 'Toyota', model: 'Hilux', insuranceExpiry: 'not-a-date' },
    });
    assert.equal(badDate.status, 400, `Date invalide refusée : ${JSON.stringify(badDate.data)}`);
    assert.ok((badDate.data.error || '').includes('insuranceExpiry'));

    // Date vide ('' envoyée par le frontend) -> acceptée, stockée comme NULL.
    const emptyDate = await api('POST', '/api/vehicles', {
        token,
        body: { plate: 'SEC-2', brand: 'Toyota', model: 'Hilux', insuranceExpiry: '' },
    });
    assert.equal(emptyDate.status, 201, `Date vide acceptée : ${JSON.stringify(emptyDate.data)}`);
    assert.equal(emptyDate.data.insuranceExpiry, null);

    // Date valide -> acceptée.
    const okDate = await api('POST', '/api/vehicles', {
        token,
        body: { plate: 'SEC-3', brand: 'Toyota', model: 'Hilux', insuranceExpiry: '2026-12-15' },
    });
    assert.equal(okDate.status, 201, `Date valide acceptée : ${JSON.stringify(okDate.data)}`);
    assert.equal(okDate.data.insuranceExpiry, '2026-12-15');
});

// ============================================================
test('Anti force brute : la connexion est bloquée après N échecs', async () => {
    // Les tentatives ÉCHOUÉES sont comptées ; à la 6e requête (dont une avec le
    // bon mot de passe) le compte est temporairement bloqué -> 429.
    for (let i = 0; i < LOGIN_LIMIT_MAX; i++) {
        const r = await api('POST', '/api/auth/login', { body: { username: 'superadmin', password: 'wrong-' + i } });
        assert.equal(r.status, 401, `Tentative ${i + 1} doit échouer avec 401`);
    }

    // Même le bon mot de passe est refusé une fois la limite atteinte.
    const blocked = await api('POST', '/api/auth/login', { body: { username: 'superadmin', password: 'superadmin123' } });
    assert.equal(blocked.status, 429, 'La limite de tentatives doit renvoyer 429');
    assert.equal(blocked.data.code, 'login_rate_limited');

    // L'en-tête standard de rate limiting est présent.
    assert.ok(blocked.headers.get('ratelimit-limit'), 'En-tête RateLimit manquant');
});
