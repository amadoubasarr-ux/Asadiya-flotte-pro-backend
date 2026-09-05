// ============================================================
// Tests réservations — anti conflits de planning (Phase 8.4 / N4)
// ============================================================
// La détection de chevauchement et l'insertion sont dans une MÊME transaction,
// sérialisée par un verrou advisory (pg_advisory_xact_lock) par véhicule :
//   - deux réservations qui se chevauchent sur le même véhicule -> 409
//   - un déplacement par PUT vers un créneau occupé -> 409
//   - des créneaux distincts du même véhicule sont acceptés
// Cette suite régresse le chemin findConflict(...client) qui doit répondre
// 409 (et non planter) quand la vérification s'exécute avec le client de
// transaction.
// ============================================================
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = 4331;
const BASE = `http://localhost:${PORT}`;

let child = null;
let superToken = null;
let adminToken = null;
let vehicleId = null;
let driverId = null;
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

    const orgName = unique('Resa Org');
    const adminUsername = unique('resa_admin');
    const signup = await api('POST', '/api/auth/signup', {
        body: { name: orgName, adminName: 'Admin Resa', adminUsername, adminPassword: 'secret123' },
    });
    assert.equal(signup.status, 201, `Signup échoué : ${JSON.stringify(signup.data)}`);
    createdOrgIds.push(signup.data.organization.id);
    adminToken = await login(adminUsername, 'secret123');

    const v = await api('POST', '/api/vehicles', {
        token: adminToken,
        body: { plate: `RESA-${Date.now()}`, brand: 'Toyota', model: 'Hilux', mileage: 10 },
    });
    assert.equal(v.status, 201, `Création véhicule échouée : ${JSON.stringify(v.data)}`);
    vehicleId = v.data.id;

    const d = await api('POST', '/api/drivers', {
        token: adminToken,
        body: { name: 'Chauffeur Resa', email: 'resa@example.com' },
    });
    assert.equal(d.status, 201, `Création conducteur échouée : ${JSON.stringify(d.data)}`);
    driverId = d.data.id;
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
test('Chevauchement de créneaux : conflit 409 (création, correctif N4)', async () => {
    assert.ok(adminToken && vehicleId && driverId);
    const start = '2026-10-05T08:00:00';
    const end = '2026-10-05T10:00:00';

    const first = await api('POST', '/api/reservations', {
        token: adminToken,
        body: { vehicleId, driverId, start, end, purpose: 'Test N4 - créneau initial' },
    });
    assert.equal(first.status, 201, `Création réservation échouée : ${JSON.stringify(first.data)}`);

    // Créneau qui CHEVAUCHE le précédent (09:00-12:00) -> 409.
    const overlap = await api('POST', '/api/reservations', {
        token: adminToken,
        body: { vehicleId, driverId, start: '2026-10-05T09:00:00', end: '2026-10-05T12:00:00', purpose: 'chevauchement' },
    });
    assert.equal(overlap.status, 409, `Chevauchement attendu 409 : ${JSON.stringify(overlap.data)}`);

    // Créneau IDENTIQUE -> 409.
    const same = await api('POST', '/api/reservations', {
        token: adminToken,
        body: { vehicleId, driverId, start, end, purpose: 'double' },
    });
    assert.equal(same.status, 409, `Doublon attendu 409 : ${JSON.stringify(same.data)}`);

    // Créneau disjoint (14:00-16:00) -> autorisé.
    const disjoint = await api('POST', '/api/reservations', {
        token: adminToken,
        body: { vehicleId, driverId, start: '2026-10-05T14:00:00', end: '2026-10-05T16:00:00', purpose: 'disjoint' },
    });
    assert.equal(disjoint.status, 201, `Créneau disjoint refusé : ${JSON.stringify(disjoint.data)}`);
});

// ============================================================
test('Déplacement d\'une réservation vers un créneau occupé : 409 (correctif N4)', async () => {
    // Réservation A (source du déplacement), seul record du jour 1.
    const start = '2026-11-02T08:00:00';
    const end = '2026-11-02T09:00:00';
    const r = await api('POST', '/api/reservations', {
        token: adminToken,
        body: { vehicleId, driverId, start, end, purpose: 'Test N4 - déplacement' },
    });
    assert.equal(r.status, 201, `Création échouée : ${JSON.stringify(r.data)}`);

    // Une AUTRE réservation occupe le créneau 12:00-15:00 du jour suivant.
    const occupying = await api('POST', '/api/reservations', {
        token: adminToken,
        body: { vehicleId, driverId, start: '2026-11-03T12:00:00', end: '2026-11-03T15:00:00', purpose: 'occupe la cible' },
    });
    assert.equal(occupying.status, 201, `Création du créneau occupant échouée : ${JSON.stringify(occupying.data)}`);

    // On tente de déplacer A sur le créneau occupé -> 409.
    const move = await api('PUT', `/api/reservations/${r.data.id}`, {
        token: adminToken,
        body: { start: '2026-11-03T13:00:00', end: '2026-11-03T14:00:00' },
    });
    assert.equal(move.status, 409, `Déplacement vers créneau occupé attendu 409 : ${JSON.stringify(move.data)}`);

    // Déplacement vers un créneau libre -> accepté.
    const okMove = await api('PUT', `/api/reservations/${r.data.id}`, {
        token: adminToken,
        body: { start: '2026-11-04T09:00:00', end: '2026-11-04T10:00:00' },
    });
    assert.equal(okMove.status, 200, `Déplacement vers créneau libre refusé : ${JSON.stringify(okMove.data)}`);
});