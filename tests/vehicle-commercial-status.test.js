// ============================================================
// Tests cycle de vie commercial des véhicules (Phase 7.7 - Commit 5)
// ============================================================
// Tests d'intégration de bout en bout (serveur + PostgreSQL) :
//   - défaut AVAILABLE à la création (colonne + migration idempotente)
//   - transitions autorisées : AVAILABLE -> FOR_SALE -> SOLD,
//     FOR_SALE -> AVAILABLE (200, machine à états côté serveur)
//   - transitions interdites -> 409 : AVAILABLE -> SOLD,
//     SOLD -> AVAILABLE, SOLD -> FOR_SALE
//   - validations : statut inconnu (400), SOLD sans saleId (400),
//     véhicule inexistant (404), véhicule d'une autre organisation (404)
//   - permissions : non authentifié (401), DRIVER (lecture seule -> 403),
//     SUPERADMIN (403), ADMIN/MANAGER (écriture OK)
//   - SOLD finalise la vente (COMPLETED) et synchronise le statut
//     opérationnel du véhicule (SOLD) sans rien supprimer : historique
//     comptable, acheteur, prix, dates, photos et données véhicule
//   - isolation multi-tenant : vente d'une autre organisation = 404
//   - idempotence : re-application d'un même statut -> 200
//
// Lancer avec :  node --test tests/vehicle-commercial-status.test.js
// ============================================================
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

// Port dédié (distinct du fichier photos pour exécution en parallèle).
const PORT = 4324;
const BASE = `http://localhost:${PORT}`;
const UPLOADS_DIR = path.join(os.tmpdir(), `asadiya-commercial-status-test-${PORT}`);

const JPG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(256, 0x42)]);

let serverChild = null;
let superToken = null;
let adminTokenA = null;
let adminTokenB = null;
let managerTokenA = null;
let driverTokenA = null;
let orgAId = null;
let createdOrgIds = [];

// Véhicules / ventes de l'organisation A.
let v1 = null;   // cycle complet AVAILABLE -> FOR_SALE -> SOLD
let v2 = null;   // cycle complet avec photos (conservées après vente)
let v3 = null;   // refus : AVAILABLE -> SOLD (400 puis 409)
let v4 = null;   // MANAGER autorisé
let v5 = null;   // tests d'invalidité / statut inconnu
let vB = null;   // véhicule de l'organisation B (isolation)
let s2 = null;   // vente de v2 (finalisée par SOLD, avec photo)
let s3 = null;   // vente de v3 (utilisée pour tenter AVAILABLE -> SOLD -> 409)
let sB = null;   // vente de l'organisation B
let photoS2 = null;

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

async function api(method, p, { token, body, headers } = {}) {
    const res = await fetch(BASE + p, {
        method,
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(headers || {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* pas de corps JSON */ }
    return { status: res.status, data };
}

async function patchCommercial(token, vehicleId, status, saleId) {
    const body = { status };
    if (saleId != null) body.saleId = saleId;
    return api('PATCH', `/api/vehicles/${vehicleId}/commercial-status`, { token, body });
}

async function uploadPhoto(token, saleId) {
    const fd = new FormData();
    fd.append('file', new Blob([JPG_BYTES], { type: 'image/jpeg' }), 'vehicule-vendu.jpg');
    const res = await fetch(`${BASE}/api/vehicle-sales/${saleId}/photos`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
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

function startServer() {
    serverChild = spawn(process.execPath, ['server.js'], {
        cwd: path.join(__dirname, '..'),
        env: {
            ...process.env,
            PORT: String(PORT),
            NODE_ENV: 'test',
            UPLOADS_DIR,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverChild.stdout.on('data', () => {});
    serverChild.stderr.on('data', () => {});
    return waitForServer();
}

before(async () => {
    fs.rmSync(UPLOADS_DIR, { recursive: true, force: true });
    await startServer();
    superToken = await login('superadmin', 'superadmin123');
});

after(async () => {
    if (superToken) {
        for (const id of createdOrgIds.reverse()) {
            try {
                await api('DELETE', `/api/organizations/${id}`, { token: superToken });
            } catch (e) { /* meilleur effort */ }
        }
    }
    if (serverChild) {
        serverChild.kill();
        await Promise.race([
            new Promise((resolve) => serverChild.once('exit', resolve)),
            sleep(3000),
        ]);
    }
    fs.rmSync(UPLOADS_DIR, { recursive: true, force: true });
});

test('Setup : organisations A/B, ADMIN/MANAGER/DRIVER, colonne par défaut AVAILABLE', async () => {
    const mkOrg = async (label) => {
        const username = unique('com_admin');
        const r = await api('POST', '/api/auth/signup', {
            body: { name: unique(label), adminName: 'Admin Cycle', adminUsername: username, adminPassword: 'secret123' },
        });
        assert.equal(r.status, 201, `Signup échoué : ${JSON.stringify(r.data)}`);
        const token = await login(username, 'secret123');
        return { orgId: r.data.organization.id, token };
    };

    const a = await mkOrg('Cycle Org A');
    const b = await mkOrg('Cycle Org B');
    createdOrgIds.push(a.orgId, b.orgId);
    adminTokenA = a.token;
    adminTokenB = b.token;
    orgAId = a.orgId;

    const mkVehicle = async (token, plate) => {
        const r = await api('POST', '/api/vehicles', {
            token,
            body: { plate: unique(plate), brand: 'Toyota', model: 'Corolla', mileage: 45000, fuel: 'Essence' },
        });
        assert.equal(r.status, 201, `Création véhicule échouée : ${JSON.stringify(r.data)}`);
        return r.data;
    };
    const mkSale = async (token, vehicleId, buyerName) => {
        const r = await api('POST', '/api/vehicle-sales', {
            token,
            body: { vehicleId, buyerName, saleDate: '2026-08-01', price: 5000000 },
        });
        assert.equal(r.status, 201, `Création vente échouée : ${JSON.stringify(r.data)}`);
        return r.data;
    };

    v1 = await mkVehicle(adminTokenA, 'CV-A1');
    v2 = await mkVehicle(adminTokenA, 'CV-A2');
    v3 = await mkVehicle(adminTokenA, 'CV-A3');
    v4 = await mkVehicle(adminTokenA, 'CV-A4');
    v5 = await mkVehicle(adminTokenA, 'CV-A5');
    vB = await mkVehicle(adminTokenB, 'CV-B1');

    // La colonne commercial_status existe dès la création (défaut AVAILABLE).
    for (const v of [v1, v2, v3, v4, v5]) {
        assert.equal(v.commercialStatus, 'AVAILABLE', 'commercialStatus par défaut = AVAILABLE');
    }
    assert.equal(vB.commercialStatus, 'AVAILABLE');

    // Une vente crée une réservation opérationnelle SANS toucher au statut
    // commercial (la mise en vente reste un acte explicite).
    await mkSale(adminTokenA, v1.id, 'Client Cycle A');
    s2 = await mkSale(adminTokenA, v2.id, 'Client Cycle B');
    s3 = await mkSale(adminTokenA, v3.id, 'Client Cycle C');
    sB = await mkSale(adminTokenB, vB.id, 'Client Cycle B2');
    const v1Check = await api('GET', `/api/vehicles/${v1.id}`, { token: adminTokenA });
    assert.equal(v1Check.data.status, 'RESERVED', 'statut opérationnel RESERVED après création de la vente');
    assert.equal(v1Check.data.commercialStatus, 'AVAILABLE', 'commercialStatus inchangé par la création de la vente');

    // MANAGER dans l'organisation A.
    const m = await api('POST', '/api/users', {
        token: adminTokenA,
        body: { username: unique('com_mgr'), password: 'secret123', name: 'Gérant Cycle', role: 'MANAGER' },
    });
    assert.equal(m.status, 201);
    managerTokenA = await login(m.data.username, 'secret123');

    // DRIVER dans l'organisation A (lecture seule).
    const d = await api('POST', '/api/users', {
        token: adminTokenA,
        body: { username: unique('com_drv'), password: 'secret123', name: 'Chauffeur Cycle', role: 'DRIVER' },
    });
    assert.equal(d.status, 201);
    driverTokenA = await login(d.data.username, 'secret123');
});

test('Migration idempotente : migrate() deux fois sans erreur', async () => {
    const { migrate } = require('../db/migrate');
    await migrate();
    await migrate();
    assert.ok(true, 'la migration de la colonne commercial_status est idempotente');
});

test('AVAILABLE -> FOR_SALE (ADMIN) : 200, commercialStatus = FOR_SALE', async () => {
    const r = await patchCommercial(adminTokenA, v1.id, 'FOR_SALE');
    assert.equal(r.status, 200, `PATCH FOR_SALE échoué : ${JSON.stringify(r.data)}`);
    assert.equal(r.data.commercialStatus, 'FOR_SALE');
    assert.equal(r.data.status, 'RESERVED', 'le statut opérationnel (réservation) est préservé');
});

test('FOR_SALE -> FOR_SALE (idempotent) : 200 sans erreur', async () => {
    const r = await patchCommercial(adminTokenA, v1.id, 'FOR_SALE');
    assert.equal(r.status, 200, `Re-PATCH FOR_SALE échoué : ${JSON.stringify(r.data)}`);
    assert.equal(r.data.commercialStatus, 'FOR_SALE');
});

test('FOR_SALE -> AVAILABLE (ADMIN) : 200, retour à Disponible', async () => {
    const r = await patchCommercial(adminTokenA, v1.id, 'AVAILABLE');
    assert.equal(r.status, 200, `PATCH AVAILABLE échoué : ${JSON.stringify(r.data)}`);
    assert.equal(r.data.commercialStatus, 'AVAILABLE');
});

test('AVAILABLE -> FOR_SALE (MANAGER) : 200, gestionnaire autorisé', async () => {
    const r = await patchCommercial(managerTokenA, v4.id, 'FOR_SALE');
    assert.equal(r.status, 200, `PATCH MANAGER échoué : ${JSON.stringify(r.data)}`);
    assert.equal(r.data.commercialStatus, 'FOR_SALE');
});

test('FOR_SALE -> SOLD (ADMIN) : 200, vente finalisée (COMPLETED) + véhicule opérationnel SOLD', async () => {
    // Photo ajoutée AVANT la vente : doit être conservée.
    const up = await uploadPhoto(adminTokenA, s2.id);
    assert.equal(up.status, 201, `Upload photo échoué : ${JSON.stringify(up.data)}`);
    photoS2 = up.data;

    const toSale = await patchCommercial(adminTokenA, v2.id, 'FOR_SALE');
    assert.equal(toSale.status, 200);

    const r = await patchCommercial(adminTokenA, v2.id, 'SOLD', s2.id);
    assert.equal(r.status, 200, `PATCH SOLD échoué : ${JSON.stringify(r.data)}`);
    assert.equal(r.data.commercialStatus, 'SOLD');
    assert.equal(r.data.status, 'SOLD', 'statut opérationnel synchronisé à SOLD');

    const saleCheck = await api('GET', `/api/vehicle-sales/${s2.id}`, { token: adminTokenA });
    assert.equal(saleCheck.status, 200);
    assert.equal(saleCheck.data.status, 'COMPLETED', 'la vente est finalisée par SOLD');
    assert.equal(saleCheck.data.buyerName, 'Client Cycle B', 'l\'acheteur est conservé');
    assert.equal(saleCheck.data.price, 5000000, 'le prix est conservé');
    assert.equal(saleCheck.data.saleDate, '2026-08-01', 'la date de vente est conservée');
    assert.equal(saleCheck.data.vehicleId, v2.id, 'le véhicule lié est conservé');
});

test('SOLD : photos et données véhicule conservées (aucune suppression)', async () => {
    const photos = await api('GET', `/api/vehicle-sales/${s2.id}/photos`, { token: adminTokenA });
    assert.equal(photos.status, 200);
    assert.equal(photos.data.total, 1, 'la photo reste après la vente');
    assert.equal(photos.data.items[0].id, photoS2.id);

    const dl = await fetch(`${BASE}/api/vehicle-sales/${s2.id}/photos/${photoS2.id}`, {
        headers: { Authorization: `Bearer ${adminTokenA}` },
    });
    assert.equal(dl.status, 200, 'la photo reste téléchargeable après la vente');

    const v2Check = await api('GET', `/api/vehicles/${v2.id}`, { token: adminTokenA });
    assert.equal(v2Check.status, 200);
    assert.equal(v2Check.data.brand, 'Toyota');
    assert.equal(v2Check.data.model, 'Corolla');
    assert.ok(v2Check.data.plate, 'la plaque est conservée');
    assert.equal(v2Check.data.mileage, 45000, 'le kilométrage est conservé');
    assert.equal(v2Check.data.commercialStatus, 'SOLD');
});

test('SOLD -> SOLD (idempotent) : 200 sans erreur', async () => {
    const r = await patchCommercial(adminTokenA, v2.id, 'SOLD', s2.id);
    assert.equal(r.status, 200, `Re-PATCH SOLD échoué : ${JSON.stringify(r.data)}`);
    assert.equal(r.data.commercialStatus, 'SOLD');
});

test('AVAILABLE -> SOLD sans saleId : 400 (la vente concernée est exigée)', async () => {
    const r = await patchCommercial(adminTokenA, v3.id, 'SOLD');
    assert.equal(r.status, 400, `Réponse attendue 400, obtenu ${r.status} : ${JSON.stringify(r.data)}`);
});

test('AVAILABLE -> SOLD avec saleId : 409 (transition interdite)', async () => {
    const r = await patchCommercial(adminTokenA, v3.id, 'SOLD', s3.id);
    assert.equal(r.status, 409, `Réponse attendue 409, obtenu ${r.status} : ${JSON.stringify(r.data)}`);
});

test('SOLD -> AVAILABLE : 409 (transition interdite)', async () => {
    const r = await patchCommercial(adminTokenA, v2.id, 'AVAILABLE');
    assert.equal(r.status, 409, `Réponse attendue 409, obtenu ${r.status} : ${JSON.stringify(r.data)}`);
});

test('SOLD -> FOR_SALE : 409 (transition interdite)', async () => {
    const r = await patchCommercial(adminTokenA, v2.id, 'FOR_SALE');
    assert.equal(r.status, 409, `Réponse attendue 409, obtenu ${r.status} : ${JSON.stringify(r.data)}`);
});

test('Statut inconnu : 400', async () => {
    const r = await patchCommercial(adminTokenA, v5.id, 'BROKEN');
    assert.equal(r.status, 400, `Réponse attendue 400, obtenu ${r.status} : ${JSON.stringify(r.data)}`);
});

test('Véhicule inexistant : 404', async () => {
    const r = await patchCommercial(adminTokenA, 99999999, 'FOR_SALE');
    assert.equal(r.status, 404, `Réponse attendue 404, obtenu ${r.status} : ${JSON.stringify(r.data)}`);
});

test('Isolation : véhicule d\'une autre organisation -> 404', async () => {
    const r = await patchCommercial(adminTokenA, vB.id, 'FOR_SALE');
    assert.equal(r.status, 404, `Réponse attendue 404, obtenu ${r.status} : ${JSON.stringify(r.data)}`);
});

test('Isolation : vente d\'une autre organisation -> 404 (invisible)', async () => {
    const r = await patchCommercial(adminTokenA, v4.id, 'SOLD', sB.id);
    assert.equal(r.status, 404, `Réponse attendue 404, obtenu ${r.status} : ${JSON.stringify(r.data)}`);
});

test('Isolation : la vente d\'un autre véhicule ne peut pas marquer VENDU', async () => {
    const r = await patchCommercial(adminTokenA, v4.id, 'SOLD', s2.id);
    assert.equal(r.status, 400, `Réponse attendue 400, obtenu ${r.status} : ${JSON.stringify(r.data)}`);
});

test('Non authentifié : 401', async () => {
    const r = await patchCommercial(null, v5.id, 'FOR_SALE');
    assert.equal(r.status, 401, `Réponse attendue 401, obtenu ${r.status} : ${JSON.stringify(r.data)}`);
});

test('DRIVER (lecture seule) : 403', async () => {
    const r = await patchCommercial(driverTokenA, v5.id, 'FOR_SALE');
    assert.equal(r.status, 403, `Réponse attendue 403, obtenu ${r.status} : ${JSON.stringify(r.data)}`);
});

test('SUPERADMIN : 403 (hors organisation, pas de gestion flotte)', async () => {
    const r = await patchCommercial(superToken, v5.id, 'FOR_SALE');
    assert.equal(r.status, 403, `Réponse attendue 403, obtenu ${r.status} : ${JSON.stringify(r.data)}`);
});

test('Vérification finale : l\'organisation A n\'a rien modifié chez l\'organisation B', async () => {
    const vBCheck = await api('GET', `/api/vehicles/${vB.id}`, { token: adminTokenB });
    assert.equal(vBCheck.status, 200);
    assert.equal(vBCheck.data.commercialStatus, 'AVAILABLE', 'statut commercial de B inchangé');
    const sBCheck = await api('GET', `/api/vehicle-sales/${sB.id}`, { token: adminTokenB });
    assert.equal(sBCheck.data.status, 'DRAFT', 'la vente de B n\'a pas été finalisée');
    assert.ok(orgAId, 'organisation A référencée');
});

// ============================================================
test('Le CRUD ne peut pas quitter RESERVED/SOLD manuellement (correctif N6)', async () => {
    // v1 est opérationnellement RESERVED (réservation créée par le cycle de vente).
    const v1Check = await api('GET', `/api/vehicles/${v1.id}`, { token: adminTokenA });
    assert.equal(v1Check.data.status, 'RESERVED');

    const leaveReserved = await api('PUT', `/api/vehicles/${v1.id}`, {
        token: adminTokenA,
        body: { status: 'AVAILABLE' },
    });
    assert.equal(
        leaveReserved.status,
        409,
        `Sortie manuelle de RESERVED attendue 409 : ${JSON.stringify(leaveReserved.data)}`
    );

    // v2 est SOLD : impossible de le remettre en circulation via le CRUD.
    const v2Check = await api('GET', `/api/vehicles/${v2.id}`, { token: adminTokenA });
    assert.equal(v2Check.data.status, 'SOLD');
    const leaveSold = await api('PUT', `/api/vehicles/${v2.id}`, {
        token: adminTokenA,
        body: { status: 'AVAILABLE' },
    });
    assert.equal(
        leaveSold.status,
        409,
        `Sortie manuelle de SOLD attendue 409 : ${JSON.stringify(leaveSold.data)}`
    );

    // Contrôle : un véhicule disponible reste modifiable (statut non fourni).
    const ok = await api('PUT', `/api/vehicles/${v4.id}`, {
        token: adminTokenA,
        body: { mileage: 46001 },
    });
    assert.equal(ok.status, 200, `Modification d'un véhicule disponible : ${JSON.stringify(ok.data)}`);
    assert.equal(ok.data.mileage, 46001);
});
