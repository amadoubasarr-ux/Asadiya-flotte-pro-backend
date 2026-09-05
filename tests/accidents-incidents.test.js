// ============================================================
// Tests Accidents & Incidents — Permissions (Phase 8.4, N3)
// ============================================================
// Un conducteur peut SIGNALER (créer) un incident ou un accident, mais ne
// peut NI modifier NI supprimer : modification et suppression sont réservées
// aux rôles de gestion (ADMIN, MANAGER).
//
// Lancer avec :  npm test
// ============================================================
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = 4326;
const BASE = `http://localhost:${PORT}`;

let child = null;
let superToken = null;
let adminToken = null;
let adminOrgId = null;
let driverToken = null;
let vehicleId = null;
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

function unique(prefix) {
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

    const orgName = unique('Inc Org');
    const adminUsername = unique('inc_admin');
    const signup = await api('POST', '/api/auth/signup', {
        body: { name: orgName, adminName: 'Admin Incidents', adminUsername, adminPassword: 'secret123' },
    });
    assert.equal(signup.status, 201, `Signup échoué : ${JSON.stringify(signup.data)}`);
    adminOrgId = signup.data.organization.id;
    createdOrgIds.push(adminOrgId);
    adminToken = await login(adminUsername, 'secret123');

    // Un véhicule pour rattacher les signalements.
    const vehicle = await api('POST', '/api/vehicles', {
        token: adminToken,
        body: { plate: `INC-${Date.now()}`, brand: 'Toyota', model: 'Hilux' },
    });
    assert.equal(vehicle.status, 201, `Création véhicule échouée : ${JSON.stringify(vehicle.data)}`);
    vehicleId = vehicle.data.id;

    // Un conducteur de l'organisation.
    const username = unique('inc_drv');
    const u = await api('POST', '/api/users', {
        token: adminToken,
        body: { username, password: 'secret123', name: 'Chauffeur Incidents', role: 'DRIVER' },
    });
    assert.equal(u.status, 201, `Création utilisateur échouée : ${JSON.stringify(u.data)}`);
    driverToken = await login(username, 'secret123');
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
test('Le DRIVER peut signaler (créer) un incident et un accident', async () => {
    const incident = await api('POST', '/api/incidents', {
        token: driverToken,
        body: { vehicleId, title: 'Pneu crevé', priority: 'HIGH', date: '2026-09-01' },
    });
    assert.equal(incident.status, 201, `Incident DRIVER attendu 201 : ${JSON.stringify(incident.data)}`);
    assert.ok(incident.data.id);

    const accident = await api('POST', '/api/accidents', {
        token: driverToken,
        body: { vehicleId, date: '2026-09-01', location: 'Autoroute A1', report: 'Accrochage léger' },
    });
    assert.equal(accident.status, 201, `Accident DRIVER attendu 201 : ${JSON.stringify(accident.data)}`);
    assert.ok(accident.data.id);
});

// ============================================================
test('Le DRIVER ne peut NI modifier NI supprimer (correctif N3)', async () => {
    const incident = await api('POST', '/api/incidents', {
        token: driverToken,
        body: { vehicleId, title: 'Explosion vérifiée', date: '2026-09-02' },
    });
    assert.equal(incident.status, 201);
    const accident = await api('POST', '/api/accidents', {
        token: driverToken,
        body: { vehicleId, date: '2026-09-02', location: 'Zone industrielle' },
    });
    assert.equal(accident.status, 201);

    // Modification : refusée au DRIVER.
    const putIncident = await api('PUT', `/api/incidents/${incident.data.id}`, {
        token: driverToken,
        body: { title: 'Tentative de modification' },
    });
    assert.equal(putIncident.status, 403, 'Modification incident par DRIVER attendue 403');

    const putAccident = await api('PUT', `/api/accidents/${accident.data.id}`, {
        token: driverToken,
        body: { report: 'Tentative de modification' },
    });
    assert.equal(putAccident.status, 403, 'Modification accident par DRIVER attendue 403');

    // Suppression : refusée au DRIVER.
    const delIncident = await api('DELETE', `/api/incidents/${incident.data.id}`, { token: driverToken });
    assert.equal(delIncident.status, 403, 'Suppression incident par DRIVER attendue 403');

    const delAccident = await api('DELETE', `/api/accidents/${accident.data.id}`, { token: driverToken });
    assert.equal(delAccident.status, 403, 'Suppression accident par DRIVER attendue 403');
});

// ============================================================
test('ADMIN peut modifier et supprimer ses signalements', async () => {
    const incident = await api('POST', '/api/incidents', {
        token: adminToken,
        body: { vehicleId, title: 'Vitre fissurée', date: '2026-09-03' },
    });
    assert.equal(incident.status, 201);
    const accident = await api('POST', '/api/accidents', {
        token: adminToken,
        body: { vehicleId, date: '2026-09-03', location: 'Parking centre-ville' },
    });
    assert.equal(accident.status, 201);

    const put = await api('PUT', `/api/incidents/${incident.data.id}`, {
        token: adminToken,
        body: { status: 'RESOLVED' },
    });
    assert.equal(put.status, 200, `Modification incident ADMIN : ${JSON.stringify(put.data)}`);

    const del = await api('DELETE', `/api/incidents/${incident.data.id}`, { token: adminToken });
    assert.equal(del.status, 204, 'Suppression incident ADMIN attendue 204');
    if (del.data) { /* DELETE 204 sans corps */ }

    const delAccident = await api('DELETE', `/api/accidents/${accident.data.id}`, { token: adminToken });
    assert.equal(delAccident.status, 204, 'Suppression accident ADMIN attendue 204');
});