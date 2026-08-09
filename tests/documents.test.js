// ============================================================
// Tests module documents (Phase Documentation — API Documents)
// ============================================================
// Tests d'intégration de bout en bout (serveur + PostgreSQL) :
//   - CRUD complet (création véhicule/conducteur, lecture, modification,
//     suppression)
//   - statut dérivé de la date d'expiration (OK / CRITICAL ≤ 7 j / SOON ≤ 30 j /
//     EXPIRED / UNKNOWN)
//   - filtres (vehicleId, driverId, documentType, status, recherche texte,
//     expiryFrom / expiryTo), tri et pagination
//   - permissions (ADMIN / MANAGER en écriture, DRIVER en lecture seule)
//   - isolation multi-tenant entre organisations
//   - validation (dates invalides, incohérences, absence de rattachement,
//     métadonnées de fichier)
//
// Lancer avec :  node --test tests/documents.test.js
// ============================================================
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

// Port dédié aux tests du module documents (évite toute collision avec les
// autres serveurs de test).
const PORT = 4321;
const BASE = `http://localhost:${PORT}`;

const DOCUMENT_STATUSES = ['OK', 'CRITICAL', 'SOON', 'EXPIRED', 'UNKNOWN'];

let serverChild = null;
let superToken = null;
let adminTokenA = null;
let adminTokenB = null;
let driverToken = null;
let vehicleAId = null;
let vehicleBId = null;
let driverAId = null;
let createdOrgIds = [];

let assuranceDocId = null;
let assuranceNumber = null;
let permisDocId = null;
let soonDocId = null;
let expiredDocId = null;
let unknownDocId = null;
let criticalDocId = null;

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

/** Date "AAAA-MM-JJ" à n jours d'aujourd'hui (négatif = passé). */
function dateInDays(n) {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
}

before(async () => {
    const rootDir = path.join(__dirname, '..');
    serverChild = spawn(process.execPath, ['server.js'], {
        cwd: rootDir,
        env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverChild.stdout.on('data', () => {});
    serverChild.stderr.on('data', () => {});
    await waitForServer();
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
});

test('Setup : deux organisations distinctes avec véhicules et conducteur', async () => {
    const mkOrg = async (label) => {
        const username = unique('doc_admin');
        const r = await api('POST', '/api/auth/signup', {
            body: { name: unique(label), adminName: 'Admin Documents', adminUsername: username, adminPassword: 'secret123' },
        });
        assert.equal(r.status, 201, `Signup échoué : ${JSON.stringify(r.data)}`);
        const token = await login(username, 'secret123');
        return { orgId: r.data.organization.id, token };
    };

    const a = await mkOrg('Doc Org A');
    const b = await mkOrg('Doc Org B');
    createdOrgIds.push(a.orgId, b.orgId);
    adminTokenA = a.token;
    adminTokenB = b.token;

    const vA = await api('POST', '/api/vehicles', { token: adminTokenA, body: { plate: unique('DOC-A'), brand: 'Toyota', model: 'Hilux', mileage: 10000, fuel: 'Gazole' } });
    assert.equal(vA.status, 201);
    vehicleAId = vA.data.id;

    const vB = await api('POST', '/api/vehicles', { token: adminTokenB, body: { plate: unique('DOC-B'), brand: 'Renault', model: 'Clio', mileage: 2000, fuel: 'Essence' } });
    assert.equal(vB.status, 201);
    vehicleBId = vB.data.id;

    const dA = await api('POST', '/api/drivers', { token: adminTokenA, body: { name: 'Conducteur Documents', phone: '771234567' } });
    assert.equal(dA.status, 201);
    driverAId = dA.data.id;
});

test('Création : document Assurance d\'un véhicule (avec métadonnées de fichier)', async () => {
    assuranceNumber = unique('ASS');
    const r = await api('POST', '/api/documents', {
        token: adminTokenA,
        body: {
            vehicleId: vehicleAId,
            documentType: 'Assurance',
            documentNumber: assuranceNumber,
            issueDate: '2026-01-15',
            expiryDate: dateInDays(400),
            notes: 'Assurance tous risques',
            fileName: 'assurance.pdf',
            filePath: '/documents/assurance.pdf',
            mimeType: 'application/pdf',
            fileSize: 204800,
        },
    });
    assert.equal(r.status, 201, `Création échouée : ${JSON.stringify(r.data)}`);
    assert.equal(r.data.documentType, 'Assurance');
    assert.equal(r.data.documentNumber, assuranceNumber);
    assert.equal(r.data.vehicleId, vehicleAId);
    assert.equal(r.data.driverId, null);
    assert.equal(r.data.issueDate, '2026-01-15');
    assert.equal(r.data.fileName, 'assurance.pdf');
    assert.equal(r.data.filePath, '/documents/assurance.pdf');
    assert.equal(r.data.mimeType, 'application/pdf');
    assert.equal(r.data.fileSize, 204800);
    assert.equal(r.data.status, 'OK');
    assert.ok(r.data.daysLeft > 30, 'échéance lointaine');
    assuranceDocId = r.data.id;
});

test('Création : document Permis d\'un conducteur', async () => {
    const r = await api('POST', '/api/documents', {
        token: adminTokenA,
        body: {
            driverId: driverAId,
            documentType: 'Permis',
            documentNumber: unique('PER'),
            expiryDate: dateInDays(400),
        },
    });
    assert.equal(r.status, 201, `Création échouée : ${JSON.stringify(r.data)}`);
    assert.equal(r.data.documentType, 'Permis');
    assert.equal(r.data.driverId, driverAId);
    assert.equal(r.data.vehicleId, null);
    assert.equal(r.data.status, 'OK');
    permisDocId = r.data.id;
});

test('Création : statuts dérivés SOON, EXPIRED et UNKNOWN', async () => {
    const soon = await api('POST', '/api/documents', { token: adminTokenA, body: { vehicleId: vehicleAId, documentType: 'Vignette', expiryDate: dateInDays(10) } });
    assert.equal(soon.status, 201);
    assert.equal(soon.data.status, 'SOON');
    assert.ok(soon.data.daysLeft > 7 && soon.data.daysLeft <= 30, `SOON attendu entre 8 et 30 j, reçu ${soon.data.daysLeft}`);
    soonDocId = soon.data.id;

    const expired = await api('POST', '/api/documents', { token: adminTokenA, body: { vehicleId: vehicleAId, documentType: 'Contrôle Technique', expiryDate: '2020-01-01' } });
    assert.equal(expired.status, 201);
    assert.equal(expired.data.status, 'EXPIRED');
    assert.ok(expired.data.daysLeft < 0);
    expiredDocId = expired.data.id;

    const unknown = await api('POST', '/api/documents', { token: adminTokenA, body: { vehicleId: vehicleAId, documentType: 'Autorisation' } });
    assert.equal(unknown.status, 201);
    assert.equal(unknown.data.status, 'UNKNOWN');
    assert.equal(unknown.data.daysLeft, null);
    unknownDocId = unknown.data.id;
});

test('Création : statut CRITICAL pour une échéance ≤ 7 jours', async () => {
    const critical = await api('POST', '/api/documents', { token: adminTokenA, body: { vehicleId: vehicleAId, documentType: 'Assurance', expiryDate: dateInDays(5) } });
    assert.equal(critical.status, 201, `Création échouée : ${JSON.stringify(critical.data)}`);
    assert.equal(critical.data.status, 'CRITICAL');
    assert.ok(critical.data.daysLeft >= 1 && critical.data.daysLeft <= 7, `CRITICAL attendu entre 1 et 7 j, reçu ${critical.data.daysLeft}`);
    criticalDocId = critical.data.id;

    // Une échéance au-delà de 7 jours reste SOON (jamais CRITICAL).
    const soon = await api('POST', '/api/documents', { token: adminTokenA, body: { vehicleId: vehicleAId, documentType: 'Vignette', expiryDate: dateInDays(20) } });
    assert.equal(soon.status, 201);
    assert.equal(soon.data.status, 'SOON');
    assert.ok(soon.data.daysLeft > 7);
});

test('Filtre : status CRITICAL isolé des autres statuts', async () => {
    const critical = await api('GET', '/api/documents?status=CRITICAL', { token: adminTokenA });
    assert.equal(critical.status, 200);
    assert.ok(critical.data.items.some((d) => d.id === criticalDocId), 'le document CRITICAL est filtré');
    assert.ok(critical.data.items.every((d) => d.status === 'CRITICAL'));

    const soon = await api('GET', '/api/documents?status=SOON', { token: adminTokenA });
    assert.ok(!soon.data.items.some((d) => d.id === criticalDocId), 'CRITICAL absent du filtre SOON');
    assert.ok(soon.data.items.some((d) => d.id === soonDocId), 'le document SOON reste dans le filtre SOON');

    const expired = await api('GET', '/api/documents?status=EXPIRED', { token: adminTokenA });
    assert.ok(!expired.data.items.some((d) => d.id === criticalDocId), 'CRITICAL absent du filtre EXPIRED');
});

test('Validation : rattachement véhicule OU conducteur obligatoire (et exclusif)', async () => {
    // Ni véhicule ni conducteur.
    const none = await api('POST', '/api/documents', { token: adminTokenA, body: { documentType: 'Assurance' } });
    assert.equal(none.status, 400);

    // Véhicule ET conducteur simultanément.
    const both = await api('POST', '/api/documents', { token: adminTokenA, body: { vehicleId: vehicleAId, driverId: driverAId, documentType: 'Assurance' } });
    assert.equal(both.status, 400);

    // Chaînes vides équivalent à une absence : sans rattachement réel.
    const empty = await api('POST', '/api/documents', { token: adminTokenA, body: { vehicleId: '', driverId: '', documentType: 'Assurance' } });
    assert.equal(empty.status, 400);
});

test('Validation : type, dates, longueurs et métadonnées refusés', async () => {
    const cases = [
        { vehicleId: vehicleAId, documentType: 'Fausse Assurance' },
        { vehicleId: vehicleAId, documentType: 'Assurance', expiryDate: '01/08/2026' },
        { vehicleId: vehicleAId, documentType: 'Assurance', issueDate: '2026-12-31', expiryDate: '2026-01-01' },
        { vehicleId: vehicleAId, documentType: 'Assurance', documentNumber: 'X'.repeat(101) },
        { vehicleId: vehicleAId, documentType: 'Assurance', notes: 'N'.repeat(4001) },
        { vehicleId: vehicleAId, documentType: 'Assurance', fileSize: -10 },
        { vehicleId: vehicleAId, documentType: 'Assurance', fileName: 'F'.repeat(256) },
        { vehicleId: vehicleAId, documentType: 'Assurance', mimeType: 'M'.repeat(101) },
    ];
    for (const body of cases) {
        const r = await api('POST', '/api/documents', { token: adminTokenA, body });
        assert.equal(r.status, 400, `Attendu 400 pour ${JSON.stringify(body)} : ${JSON.stringify(r.data)}`);
    }
});

test('Lecture : liste paginée avec statuts dérivés', async () => {
    const list = await api('GET', '/api/documents', { token: adminTokenA });
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.data.items), 'la liste expose un tableau items');
    assert.ok(list.data.total >= 5, `total : ${list.data.total}`);
    assert.equal(list.data.page, 1);
    assert.equal(typeof list.data.pageSize, 'number');
    assert.ok(list.data.items.length >= 1);
    const first = list.data.items[0];
    assert.ok(first.id);
    assert.ok(DOCUMENT_STATUSES.includes(first.status), `statut inattendu : ${first.status}`);
});

test('Lecture : détail d\'un document', async () => {
    const r = await api('GET', `/api/documents/${assuranceDocId}`, { token: adminTokenA });
    assert.equal(r.status, 200);
    assert.equal(r.data.id, assuranceDocId);
    assert.equal(r.data.documentNumber, assuranceNumber);
    assert.equal(r.data.documentType, 'Assurance');
    assert.equal(r.data.status, 'OK');
    assert.ok(r.data.daysLeft > 30);
});

test('Lecture : document inexistant ou d\'une autre organisation -> 404', async () => {
    const missing = await api('GET', '/api/documents/99999999', { token: adminTokenA });
    assert.equal(missing.status, 404);

    const cross = await api('GET', `/api/documents/${assuranceDocId}`, { token: adminTokenB });
    assert.equal(cross.status, 404);
});

test('Modification : PUT partiel sans perte des champs existants', async () => {
    const r = await api('PUT', `/api/documents/${permisDocId}`, {
        token: adminTokenA,
        body: { documentNumber: unique('PER-UPD'), notes: 'Permis renouvelé' },
    });
    assert.equal(r.status, 200, `Modification échouée : ${JSON.stringify(r.data)}`);
    assert.equal(r.data.notes, 'Permis renouvelé');
    assert.equal(r.data.documentType, 'Permis', 'champ non modifié conservé');
    assert.equal(r.data.driverId, driverAId, 'rattachement conservé');
});

test('Modification : le statut est recalculé après changement de la date d\'expiration', async () => {
    const created = await api('POST', '/api/documents', { token: adminTokenA, body: { vehicleId: vehicleAId, documentType: 'Vignette', expiryDate: dateInDays(400) } });
    assert.equal(created.data.status, 'OK');

    const r = await api('PUT', `/api/documents/${created.data.id}`, {
        token: adminTokenA,
        body: { expiryDate: dateInDays(-5) },
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.status, 'EXPIRED');
    assert.ok(r.data.daysLeft < 0);
});

test('Filtre : vehicleId', async () => {
    const r = await api('GET', `/api/documents?vehicleId=${vehicleAId}`, { token: adminTokenA });
    assert.equal(r.status, 200);
    assert.ok(r.data.items.length >= 1);
    assert.ok(r.data.items.every((d) => d.vehicleId === vehicleAId));
});

test('Filtre : driverId', async () => {
    const r = await api('GET', `/api/documents?driverId=${driverAId}`, { token: adminTokenA });
    assert.equal(r.status, 200);
    assert.ok(r.data.items.length >= 1);
    assert.ok(r.data.items.every((d) => d.driverId === driverAId));
});

test('Filtre : documentType', async () => {
    const r = await api('GET', `/api/documents?documentType=${encodeURIComponent('Assurance')}`, { token: adminTokenA });
    assert.equal(r.status, 200);
    assert.ok(r.data.items.length >= 1);
    assert.ok(r.data.items.every((d) => d.documentType === 'Assurance'));
});

test('Filtre : status', async () => {
    const expired = await api('GET', '/api/documents?status=EXPIRED', { token: adminTokenA });
    assert.equal(expired.status, 200);
    assert.ok(expired.data.items.some((d) => d.id === expiredDocId));
    assert.ok(!expired.data.items.some((d) => d.id === soonDocId));
    assert.ok(!expired.data.items.some((d) => d.id === unknownDocId));

    const soon = await api('GET', '/api/documents?status=SOON', { token: adminTokenA });
    assert.ok(soon.data.items.some((d) => d.id === soonDocId));

    const unknown = await api('GET', '/api/documents?status=UNKNOWN', { token: adminTokenA });
    assert.ok(unknown.data.items.some((d) => d.id === unknownDocId));

    const ok = await api('GET', '/api/documents?status=OK', { token: adminTokenA });
    assert.ok(ok.data.items.some((d) => d.id === assuranceDocId));
});

test('Filtre : recherche texte (numéro de document)', async () => {
    const marker = `SEARCH-${Date.now()}`;
    const created = await api('POST', '/api/documents', { token: adminTokenA, body: { vehicleId: vehicleAId, documentType: 'Autre', documentNumber: marker, notes: 'document spécial pour la recherche' } });
    assert.equal(created.status, 201);

    const r = await api('GET', `/api/documents?search=${encodeURIComponent(marker)}`, { token: adminTokenA });
    assert.equal(r.status, 200);
    assert.ok(r.data.items.length >= 1);
    assert.ok(r.data.items.some((d) => d.id === created.data.id));
});

test('Filtre : plage d\'expiration expiryFrom / expiryTo', async () => {
    const inside = await api('POST', '/api/documents', { token: adminTokenA, body: { vehicleId: vehicleAId, documentType: 'Autorisation', expiryDate: '2024-06-15' } });
    assert.equal(inside.status, 201);

    const r = await api('GET', '/api/documents?expiryFrom=2024-01-01&expiryTo=2024-12-31', { token: adminTokenA });
    assert.equal(r.status, 200);
    assert.ok(r.data.items.some((d) => d.id === inside.data.id));
    assert.ok(!r.data.items.some((d) => d.id === expiredDocId), 'hors de la plage (2020-01-01)');
    assert.ok(!r.data.items.some((d) => d.id === unknownDocId), 'sans date d\'expiration exclu');
});

test('Tri par échéance et pagination', async () => {
    const e5 = await api('POST', '/api/documents', { token: adminTokenA, body: { vehicleId: vehicleAId, documentType: 'Vignette', expiryDate: dateInDays(5) } });
    const e100 = await api('POST', '/api/documents', { token: adminTokenA, body: { vehicleId: vehicleAId, documentType: 'Vignette', expiryDate: dateInDays(100) } });
    assert.equal(e5.status, 201);
    assert.equal(e100.status, 201);

    const sorted = await api('GET', `/api/documents?vehicleId=${vehicleAId}&sort=expiry`, { token: adminTokenA });
    assert.equal(sorted.status, 200);
    const dates = sorted.data.items
        .filter((d) => d.expiryDate !== null)
        .map((d) => d.expiryDate);
    const copy = [...dates].sort();
    assert.deepEqual(dates, copy, 'dates d\'expiration triées par ordre croissant');
    assert.ok(sorted.data.items.some((d) => d.id === e5.data.id));
    assert.ok(sorted.data.items.some((d) => d.id === e100.data.id));

    const paged = await api('GET', '/api/documents?page=1&pageSize=2', { token: adminTokenA });
    assert.equal(paged.status, 200);
    assert.equal(paged.data.page, 1);
    assert.equal(paged.data.pageSize, 2);
    assert.equal(paged.data.items.length, 2);
    assert.ok(paged.data.total >= 2);
});

test('Isolation multi-tenant : aucune fuite entre organisations', async () => {
    // Org B ne voit pas les documents de org A (même filtré par vehicleId de A).
    const listB = await api('GET', `/api/documents?vehicleId=${vehicleAId}`, { token: adminTokenB });
    assert.equal(listB.status, 200);
    assert.equal(listB.data.total, 0, 'org B ne voit pas les documents de org A');

    // Rattacher un document à un véhicule d'une autre organisation : refusé.
    const crossPost = await api('POST', '/api/documents', { token: adminTokenB, body: { vehicleId: vehicleAId, documentType: 'Assurance' } });
    assert.equal(crossPost.status, 404);

    // Suppression croisée refusée.
    const crossDel = await api('DELETE', `/api/documents/${assuranceDocId}`, { token: adminTokenB });
    assert.equal(crossDel.status, 404);

    // Le document existe toujours pour A.
    const still = await api('GET', `/api/documents/${assuranceDocId}`, { token: adminTokenA });
    assert.equal(still.status, 200);

    // Org B peut créer sur son propre véhicule, et A ne le voit pas.
    const ownB = await api('POST', '/api/documents', { token: adminTokenB, body: { vehicleId: vehicleBId, documentType: 'Assurance', documentNumber: unique('ASS-B') } });
    assert.equal(ownB.status, 201);
    const listA = await api('GET', `/api/documents?vehicleId=${vehicleBId}`, { token: adminTokenA });
    assert.equal(listA.data.total, 0);
});

test('Permissions : DRIVER en lecture seule', async () => {
    const username = unique('doc_driver');
    const u = await api('POST', '/api/users', {
        token: adminTokenA,
        body: { username, password: 'secret123', name: 'Chauffeur Docs', role: 'DRIVER' },
    });
    assert.equal(u.status, 201, `Création utilisateur échouée : ${JSON.stringify(u.data)}`);
    driverToken = await login(username, 'secret123');

    const list = await api('GET', '/api/documents', { token: driverToken });
    assert.equal(list.status, 200, 'le DRIVER peut lire les documents');

    const post = await api('POST', '/api/documents', { token: driverToken, body: { vehicleId: vehicleAId, documentType: 'Assurance' } });
    assert.equal(post.status, 403);

    const put = await api('PUT', `/api/documents/${assuranceDocId}`, { token: driverToken, body: { notes: 'non autorisé' } });
    assert.equal(put.status, 403);

    const del = await api('DELETE', `/api/documents/${assuranceDocId}`, { token: driverToken });
    assert.equal(del.status, 403);
});

test('Permissions : SUPERADMIN (sans organisation) -> 403', async () => {
    const r = await api('GET', '/api/documents', { token: superToken });
    assert.equal(r.status, 403);
});

test('Filtres invalides : 400 propre', async () => {
    const badStatus = await api('GET', '/api/documents?status=INVALID', { token: adminTokenA });
    assert.equal(badStatus.status, 400);

    const badId = await api('GET', '/api/documents?vehicleId=abc', { token: adminTokenA });
    assert.equal(badId.status, 400);

    const badDate = await api('GET', '/api/documents?expiryFrom=2026/08/01', { token: adminTokenA });
    assert.equal(badDate.status, 400);
});

test('Suppression : 204 puis introuvable', async () => {
    const del = await api('DELETE', `/api/documents/${soonDocId}`, { token: adminTokenA });
    assert.equal(del.status, 204);

    const gone = await api('GET', `/api/documents/${soonDocId}`, { token: adminTokenA });
    assert.equal(gone.status, 404);

    const again = await api('DELETE', `/api/documents/${soonDocId}`, { token: adminTokenA });
    assert.equal(again.status, 404);
});
