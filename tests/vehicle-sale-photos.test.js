// ============================================================
// Tests photos de vente de véhicules (Phase 7.7 - Commit 4)
// ============================================================
// Tests d'intégration de bout en bout (serveur + PostgreSQL + disque) :
//   - upload des 3 formats autorisés (JPG, PNG, WEBP)
//   - première photo automatiquement « principale », sort_order séquentiel
//   - rejets de sécurité : > 5 MB (413), extension interdite (400),
//     MIME incohérent (400), contenu non conforme (400), nom dangereux
//   - la clé de stockage interne (storage_key) n'est JAMAIS exposée
//   - permissions : non authentifié (401), DRIVER (lecture OK, écriture 403),
//     SUPERADMIN (403), ADMIN/MANAGER (écriture OK)
//   - isolation multi-tenant : l'organisation A ne peut NI lire NI modifier
//     les photos de l'organisation B (404)
//   - appartenance photo -> vente : photo d'une autre vente = 404
//   - téléchargement valide (contenu + type MIME + en-têtes)
//   - photo principale : changement, unicité, promotion après suppression
//   - réordonnancement (validations incluses)
//   - suppression de la vente -> nettoyage des fichiers physiques
//   - agrégats (photoCount, primaryPhotoId) dans la liste des ventes
//   - persistance après redémarrage du serveur (stockage sur disque)
//   - audit frontend : la clé de stockage et les secrets ne fuient pas
//
// Lancer avec :  node --test tests/vehicle-sale-photos.test.js
// ============================================================
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

// Port dédié + répertoire d'upload isolé (nettoyé en fin de suite).
const PORT = 4323;
const BASE = `http://localhost:${PORT}`;
const UPLOADS_DIR = path.join(os.tmpdir(), `asadiya-sale-photos-test-${PORT}`);

// Fichiers « fake » valides au niveau des « magic bytes ».
const JPG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(256, 0x42)]);
const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(256, 0x43)]);
const WEBP_BYTES = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4, 0), Buffer.from('WEBP'), Buffer.alloc(128, 0x44)]);

let serverChild = null;
let superToken = null;
let adminTokenA = null;
let adminTokenB = null;
let managerTokenA = null;
let driverTokenA = null;
let orgAId = null;
let orgBId = null;
let createdOrgIds = [];

let saleA1 = null;     // vente « photo » dans l'organisation A
let saleB1 = null;     // vente de l'organisation B (photos isolées)
let saleC = null;      // vente destinée au test de nettoyage à la suppression
let p1 = null;         // JPG  (ADMIN, 1ère -> principale)
let p2 = null;         // PNG  (MANAGER)
let p3 = null;         // WEBP (ADMIN)
let p7 = null;         // photo ajoutée juste avant le redémarrage
let c1 = null;         // photo de saleC
let c2 = null;         // photo de saleC

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
    return { status: res.status, data, headers: res.headers };
}

/** POST multipart d'une photo sur /api/vehicle-sales/:saleId/photos. */
async function uploadPhoto(token, saleId, { name, mime, buffer }) {
    const fd = new FormData();
    fd.append('file', new Blob([buffer], { type: mime }), name);
    const res = await fetch(`${BASE}/api/vehicle-sales/${saleId}/photos`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* pas de corps JSON */ }
    return { status: res.status, data };
}

/** GET d'une photo (téléchargement). */
async function downloadPhoto(token, saleId, photoId) {
    const res = await fetch(`${BASE}/api/vehicle-sales/${saleId}/photos/${photoId}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const buffer = Buffer.from(await res.arrayBuffer());
    return {
        status: res.status,
        buffer,
        contentType: res.headers.get('content-type'),
        contentLength: res.headers.get('content-length'),
        disposition: res.headers.get('content-disposition'),
        nosniff: res.headers.get('x-content-type-options'),
        cache: res.headers.get('cache-control'),
    };
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

/** Répertoire disque des photos d'une vente. */
function saleDir(orgId, saleId) {
    return path.join(UPLOADS_DIR, 'vehicle-sales', String(orgId), String(saleId));
}

/** Liste des fichiers présents dans le répertoire d'une vente. */
function saleFiles(orgId, saleId) {
    const dir = saleDir(orgId, saleId);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir);
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

test('Setup : organisations A/B, véhicules, ventes, ADMIN/MANAGER/DRIVER', async () => {
    const mkOrg = async (label) => {
        const username = unique('photo_admin');
        const r = await api('POST', '/api/auth/signup', {
            body: { name: unique(label), adminName: 'Admin Photos', adminUsername: username, adminPassword: 'secret123' },
        });
        assert.equal(r.status, 201, `Signup échoué : ${JSON.stringify(r.data)}`);
        const token = await login(username, 'secret123');
        return { orgId: r.data.organization.id, token };
    };

    const a = await mkOrg('Photo Org A');
    const b = await mkOrg('Photo Org B');
    createdOrgIds.push(a.orgId, b.orgId);
    adminTokenA = a.token;
    adminTokenB = b.token;
    orgAId = a.orgId;
    orgBId = b.orgId;

    const vA1 = await api('POST', '/api/vehicles', { token: adminTokenA, body: { plate: unique('PH-A1'), brand: 'Toyota', model: 'Corolla', mileage: 45000, fuel: 'Essence' } });
    assert.equal(vA1.status, 201);
    const vA2 = await api('POST', '/api/vehicles', { token: adminTokenA, body: { plate: unique('PH-A2'), brand: 'Renault', model: 'Clio', mileage: 20000, fuel: 'Essence' } });
    assert.equal(vA2.status, 201);
    const vB1 = await api('POST', '/api/vehicles', { token: adminTokenB, body: { plate: unique('PH-B1'), brand: 'Ford', model: 'Focus', mileage: 5000, fuel: 'Essence' } });
    assert.equal(vB1.status, 201);

    const mkSale = async (token, vehicleId, buyerName) => {
        const r = await api('POST', '/api/vehicle-sales', {
            token,
            body: { vehicleId, buyerName, saleDate: '2026-08-01', price: 5000000 },
        });
        assert.equal(r.status, 201, `Création vente échouée : ${JSON.stringify(r.data)}`);
        return r.data;
    };
    saleA1 = await mkSale(adminTokenA, vA1.data.id, 'Client Photos A');
    saleC = await mkSale(adminTokenA, vA2.data.id, 'Client Nettoyage');
    saleB1 = await mkSale(adminTokenB, vB1.data.id, 'Client Photos B');

    // MANAGER dans l'organisation A.
    const m = await api('POST', '/api/users', {
        token: adminTokenA,
        body: { username: unique('photo_mgr'), password: 'secret123', name: 'Gérant Photos', role: 'MANAGER' },
    });
    assert.equal(m.status, 201);
    managerTokenA = await login(m.data.username, 'secret123');

    // DRIVER dans l'organisation A.
    const d = await api('POST', '/api/users', {
        token: adminTokenA,
        body: { username: unique('photo_drv'), password: 'secret123', name: 'Chauffeur Photos', role: 'DRIVER' },
    });
    assert.equal(d.status, 201);
    driverTokenA = await login(d.data.username, 'secret123');

    // Agrégats initialement vides (aucune photo).
    const list = await api('GET', '/api/vehicle-sales?pageSize=200', { token: adminTokenA });
    assert.equal(list.status, 200);
    const a1 = list.data.items.find((s) => s.id === saleA1.id);
    const c = list.data.items.find((s) => s.id === saleC.id);
    assert.equal(a1.photoCount, 0);
    assert.equal(a1.primaryPhotoId, null);
    assert.equal(c.photoCount, 0);
    assert.equal(c.primaryPhotoId, null);
});

test('Upload JPG valide (ADMIN) : 201, principale + sort_order 1, sans storageKey', async () => {
    const r = await uploadPhoto(adminTokenA, saleA1.id, {
        name: 'corolla-face.jpg',
        mime: 'image/jpeg',
        buffer: JPG_BYTES,
    });
    assert.equal(r.status, 201, `Upload échoué : ${JSON.stringify(r.data)}`);
    p1 = r.data;
    assert.equal(p1.originalName, 'corolla-face.jpg');
    assert.equal(p1.mimeType, 'image/jpeg');
    assert.equal(p1.sizeBytes, JPG_BYTES.length);
    assert.equal(p1.isPrimary, true, 'la première photo devient principale');
    assert.equal(p1.sortOrder, 1);
    assert.ok(p1.id > 0);
    assert.equal(p1.vehicleSaleId, saleA1.id);
    assert.ok(p1.createdAt);
    assert.equal('storageKey' in p1, false, 'la clé de stockage interne ne doit pas être exposée');
    assert.ok(!JSON.stringify(p1).includes('storageKey'), 'aucune fuite de storageKey dans la réponse');
});

test('Upload PNG valide (MANAGER) : 201, non principale, sort_order 2', async () => {
    const r = await uploadPhoto(managerTokenA, saleA1.id, {
        name: 'corolla-arriere.png',
        mime: 'image/png',
        buffer: PNG_BYTES,
    });
    assert.equal(r.status, 201, `Upload MANAGER échoué : ${JSON.stringify(r.data)}`);
    p2 = r.data;
    assert.equal(p2.mimeType, 'image/png');
    assert.equal(p2.isPrimary, false);
    assert.equal(p2.sortOrder, 2);
});

test('Upload WEBP valide (ADMIN) : 201, sort_order 3', async () => {
    const r = await uploadPhoto(adminTokenA, saleA1.id, {
        name: 'corolla-interieur.webp',
        mime: 'image/webp',
        buffer: WEBP_BYTES,
    });
    assert.equal(r.status, 201, `Upload WEBP échoué : ${JSON.stringify(r.data)}`);
    p3 = r.data;
    assert.equal(p3.mimeType, 'image/webp');
    assert.equal(p3.isPrimary, false);
    assert.equal(p3.sortOrder, 3);
});

test('Liste des photos : ordre, champs publics, aucune fuite de storageKey', async () => {
    const r = await api('GET', `/api/vehicle-sales/${saleA1.id}/photos`, { token: adminTokenA });
    assert.equal(r.status, 200);
    assert.equal(r.data.total, 3);
    assert.deepEqual(r.data.items.map((p) => p.id), [p1.id, p2.id, p3.id], 'ordre = sort_order');
    assert.deepEqual(r.data.items.map((p) => p.sortOrder), [1, 2, 3]);
    const text = JSON.stringify(r.data);
    assert.ok(!text.includes('storageKey'), 'aucune fuite de storageKey dans la liste');
    assert.ok(!text.includes('storage_key'), 'aucune fuite de storage_key dans la liste');
    for (const p of r.data.items) {
        assert.ok(p.id && p.originalName && p.mimeType && p.sizeBytes != null && 'isPrimary' in p && p.sortOrder && p.createdAt);
    }
});

test('Téléchargement valide : contenu, MIME, longueur, en-têtes de sécurité', async () => {
    const r = await downloadPhoto(adminTokenA, saleA1.id, p1.id);
    assert.equal(r.status, 200);
    assert.equal(r.contentType, 'image/jpeg');
    assert.equal(Number(r.contentLength), JPG_BYTES.length);
    assert.deepEqual(r.buffer, JPG_BYTES, 'le contenu téléchargé est identique à l\'original');
    assert.ok(r.disposition && r.disposition.includes('inline'), 'affichage inline (pas de téléchargement forcé)');
    assert.equal(r.nosniff, 'nosniff');
    assert.equal(r.cache, 'private, no-store');
});

test('Photo principale : changement + unicité', async () => {
    const r = await api('PUT', `/api/vehicle-sales/${saleA1.id}/photos/${p2.id}/primary`, { token: adminTokenA });
    assert.equal(r.status, 200, `setPrimary échoué : ${JSON.stringify(r.data)}`);
    assert.equal(r.data.id, p2.id);
    assert.equal(r.data.isPrimary, true);

    const list = await api('GET', `/api/vehicle-sales/${saleA1.id}/photos`, { token: adminTokenA });
    assert.equal(list.data.items.filter((p) => p.isPrimary).length, 1, 'une seule photo principale par vente');
    assert.equal(list.data.items.find((p) => p.id === p2.id).isPrimary, true);
    assert.equal(list.data.items.find((p) => p.id === p1.id).isPrimary, false);
    assert.equal(list.data.items.find((p) => p.id === p3.id).isPrimary, false);
});

test('Photo principale : transfert vers une autre photo', async () => {
    const r = await api('PUT', `/api/vehicle-sales/${saleA1.id}/photos/${p3.id}/primary`, { token: adminTokenA });
    assert.equal(r.status, 200);
    assert.equal(r.data.isPrimary, true);

    const list = await api('GET', `/api/vehicle-sales/${saleA1.id}/photos`, { token: adminTokenA });
    assert.equal(list.data.items.find((p) => p.id === p3.id).isPrimary, true);
    assert.equal(list.data.items.find((p) => p.id === p2.id).isPrimary, false);
});

test('Réordonnancement : la liste fournie devient l\'ordre', async () => {
    const r = await api('PUT', `/api/vehicle-sales/${saleA1.id}/photos`, {
        token: adminTokenA,
        body: { photoIds: [p3.id, p1.id, p2.id] },
    });
    assert.equal(r.status, 200, `Reorder échoué : ${JSON.stringify(r.data)}`);
    assert.deepEqual(r.data.items.map((p) => p.id), [p3.id, p1.id, p2.id]);
    assert.deepEqual(r.data.items.map((p) => p.sortOrder), [1, 2, 3]);
    assert.ok(!JSON.stringify(r.data).includes('storageKey'));
});

test('Réordonnancement : entrées invalides refusées', async () => {
    // Liste vide -> 400.
    let r = await api('PUT', `/api/vehicle-sales/${saleA1.id}/photos`, { token: adminTokenA, body: { photoIds: [] } });
    assert.equal(r.status, 400);

    // Liste partielle -> 400.
    r = await api('PUT', `/api/vehicle-sales/${saleA1.id}/photos`, { token: adminTokenA, body: { photoIds: [p3.id] } });
    assert.equal(r.status, 400);

    // Identifiant étranger (photo d'une autre vente) -> 400.
    r = await api('PUT', `/api/vehicle-sales/${saleA1.id}/photos`, { token: adminTokenA, body: { photoIds: [p3.id, p1.id, 999999] } });
    assert.equal(r.status, 400);

    // Identifiant non numérique -> 400.
    r = await api('PUT', `/api/vehicle-sales/${saleA1.id}/photos`, { token: adminTokenA, body: { photoIds: ['abc', p1.id, p2.id] } });
    assert.equal(r.status, 400);

    // Vente inexistante -> 404.
    r = await api('PUT', `/api/vehicle-sales/999999/photos`, { token: adminTokenA, body: { photoIds: [p1.id] } });
    assert.equal(r.status, 404);

    // Paramètres malformés -> 400.
    r = await api('GET', '/api/vehicle-sales/abc/photos', { token: adminTokenA });
    assert.equal(r.status, 400);
    r = await api('GET', `/api/vehicle-sales/${saleA1.id}/photos/abc`, { token: adminTokenA });
    assert.equal(r.status, 400);
});

test('Upload : aucun fichier -> 400', async () => {
    const fd = new FormData();
    const res = await fetch(`${BASE}/api/vehicle-sales/${saleA1.id}/photos`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminTokenA}` },
        body: fd,
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* pas de corps JSON */ }
    assert.equal(res.status, 400, `Attendu 400, reçu ${res.status}`);
});

test('Upload : fichier > 5 MB -> 413', async () => {
    const big = Buffer.concat([JPG_BYTES, Buffer.alloc(5 * 1024 * 1024, 0x61)]);
    const r = await uploadPhoto(adminTokenA, saleA1.id, {
        name: 'tres-grosse-photo.jpg',
        mime: 'image/jpeg',
        buffer: big,
    });
    assert.equal(r.status, 413, `Attendu 413, reçu ${r.status} : ${JSON.stringify(r.data)}`);
});

test('Upload : extension interdite -> 400', async () => {
    const r = await uploadPhoto(adminTokenA, saleA1.id, {
        name: 'malware.txt',
        mime: 'text/plain',
        buffer: Buffer.from('pas une image'),
    });
    assert.equal(r.status, 400, `Attendu 400, reçu ${r.status} : ${JSON.stringify(r.data)}`);
});

test('Upload : MIME incohérent avec l\'extension -> 400', async () => {
    const r = await uploadPhoto(adminTokenA, saleA1.id, {
        name: 'surprise.png',
        mime: 'image/jpeg',
        buffer: JPG_BYTES,
    });
    assert.equal(r.status, 400, `Attendu 400, reçu ${r.status} : ${JSON.stringify(r.data)}`);
});

test('Upload : contenu non conforme aux « magic bytes » -> 400', async () => {
    const r = await uploadPhoto(adminTokenA, saleA1.id, {
        name: 'photo.jpg',
        mime: 'image/jpeg',
        buffer: PNG_BYTES,
    });
    assert.equal(r.status, 400, `Attendu 400, reçu ${r.status} : ${JSON.stringify(r.data)}`);
});

test('Upload : nom de fichier dangereux -> neutralisé ou refusé', async () => {
    // Traversée de chemin : busboy réduit le nom à son basename AVANT le
    // serveur, donc le fichier ne peut jamais sortir du dossier d'upload.
    const r = await uploadPhoto(adminTokenA, saleA1.id, {
        name: '../../etc/passwd.jpg',
        mime: 'image/jpeg',
        buffer: JPG_BYTES,
    });
    assert.equal(r.status, 201, `Attendu 201 (nom neutralisé), reçu ${r.status} : ${JSON.stringify(r.data)}`);
    assert.equal(r.data.originalName, 'passwd.jpg');
    const deletedNow = r.data; // on la supprime aussitôt pour ne pas perturber la suite
    const del = await api('DELETE', `/api/vehicle-sales/${saleA1.id}/photos/${deletedNow.id}`, { token: adminTokenA });
    assert.equal(del.status, 200);

    // Nom contenant ".." sans séparateur -> refusé.
    const r2 = await uploadPhoto(adminTokenA, saleA1.id, {
        name: '..jpg',
        mime: 'image/jpeg',
        buffer: JPG_BYTES,
    });
    assert.equal(r2.status, 400, `Attendu 400, reçu ${r2.status} : ${JSON.stringify(r2.data)}`);
});

test('Non authentifié -> 401 (liste, upload, téléchargement)', async () => {
    let r = await api('GET', `/api/vehicle-sales/${saleA1.id}/photos`);
    assert.equal(r.status, 401);

    const fd = new FormData();
    fd.append('file', new Blob([JPG_BYTES], { type: 'image/jpeg' }), 'anon.jpg');
    const res = await fetch(`${BASE}/api/vehicle-sales/${saleA1.id}/photos`, { method: 'POST', body: fd });
    assert.equal(res.status, 401);

    const down = await downloadPhoto(null, saleA1.id, p1.id);
    assert.equal(down.status, 401);
});

test('DRIVER : lecture autorisée, écriture refusée (403)', async () => {
    let r = await api('GET', `/api/vehicle-sales/${saleA1.id}/photos`, { token: driverTokenA });
    assert.equal(r.status, 200);

    const down = await downloadPhoto(driverTokenA, saleA1.id, p1.id);
    assert.equal(down.status, 200, 'le DRIVER peut visualiser les photos de son organisation');

    r = await uploadPhoto(driverTokenA, saleA1.id, { name: 'chauffeur.jpg', mime: 'image/jpeg', buffer: JPG_BYTES });
    assert.equal(r.status, 403);

    r = await api('DELETE', `/api/vehicle-sales/${saleA1.id}/photos/${p1.id}`, { token: driverTokenA });
    assert.equal(r.status, 403);

    r = await api('PUT', `/api/vehicle-sales/${saleA1.id}/photos/${p1.id}/primary`, { token: driverTokenA });
    assert.equal(r.status, 403);

    r = await api('PUT', `/api/vehicle-sales/${saleA1.id}/photos`, { token: driverTokenA, body: { photoIds: [p1.id, p2.id, p3.id] } });
    assert.equal(r.status, 403);
});

test('SUPERADMIN : accès refusé (403)', async () => {
    const r = await api('GET', `/api/vehicle-sales/${saleA1.id}/photos`, { token: superToken });
    assert.equal(r.status, 403);
});

test('Organisation B : préparation de photos (upload par admin B)', async () => {
    const r = await uploadPhoto(adminTokenB, saleB1.id, {
        name: 'focus-B.jpg',
        mime: 'image/jpeg',
        buffer: JPG_BYTES,
    });
    assert.equal(r.status, 201, `Upload B échoué : ${JSON.stringify(r.data)}`);
    assert.equal(r.data.isPrimary, true);
});

test('Isolation multi-tenant : A ne peut pas lire les photos de B (404)', async () => {
    let r = await api('GET', `/api/vehicle-sales/${saleB1.id}/photos`, { token: adminTokenA });
    assert.equal(r.status, 404, `Attendu 404, reçu ${r.status}`);

    const down = await downloadPhoto(adminTokenA, saleB1.id, 1);
    assert.equal(down.status, 404);

    // B, en revanche, lit bien ses propres photos.
    const own = await api('GET', `/api/vehicle-sales/${saleB1.id}/photos`, { token: adminTokenB });
    assert.equal(own.status, 200);
    assert.equal(own.data.total, 1);
});

test('Isolation multi-tenant : A ne peut pas écrire/modifier les photos de B (404)', async () => {
    let r = await api('DELETE', `/api/vehicle-sales/${saleB1.id}/photos/1`, { token: adminTokenA });
    assert.equal(r.status, 404);

    r = await api('PUT', `/api/vehicle-sales/${saleB1.id}/photos/1/primary`, { token: adminTokenA });
    assert.equal(r.status, 404);

    r = await api('PUT', `/api/vehicle-sales/${saleB1.id}/photos`, { token: adminTokenA, body: { photoIds: [1] } });
    assert.equal(r.status, 404);

    r = await uploadPhoto(adminTokenA, saleB1.id, { name: 'intrusion.jpg', mime: 'image/jpeg', buffer: JPG_BYTES });
    assert.equal(r.status, 404, `Attendu 404, reçu ${r.status}`);

    const still = await api('GET', `/api/vehicle-sales/${saleB1.id}/photos`, { token: adminTokenB });
    assert.equal(still.data.total, 1, 'les photos de B sont intactes');
});

test('Appartenance photo -> vente : photo d\'une autre vente = 404', async () => {
    // Upload d'une photo sur saleC, puis tentative de la manipuler via saleA1.
    const up = await uploadPhoto(adminTokenA, saleC.id, {
        name: 'clio-c1.jpg',
        mime: 'image/jpeg',
        buffer: JPG_BYTES,
    });
    assert.equal(up.status, 201, `Upload saleC échoué : ${JSON.stringify(up.data)}`);
    c1 = up.data;

    let r = await api('GET', `/api/vehicle-sales/${saleA1.id}/photos/${c1.id}`, { token: adminTokenA });
    assert.equal(r.status, 404);

    r = await api('PUT', `/api/vehicle-sales/${saleA1.id}/photos/${c1.id}/primary`, { token: adminTokenA });
    assert.equal(r.status, 404);

    r = await api('DELETE', `/api/vehicle-sales/${saleA1.id}/photos/${c1.id}`, { token: adminTokenA });
    assert.equal(r.status, 404);

    // La photo de saleC reste lisible depuis sa propre vente.
    const ok = await downloadPhoto(adminTokenA, saleC.id, c1.id);
    assert.equal(ok.status, 200);
});

test('Suppression d\'une photo non principale : fichier retiré du disque', async () => {
    // Ordre courant : [p3, p1, p2], principale = p3. On supprime p1.
    const before = saleFiles(orgAId, saleA1.id);
    assert.equal(before.length, 3, '3 fichiers sur disque avant suppression');

    const r = await api('DELETE', `/api/vehicle-sales/${saleA1.id}/photos/${p1.id}`, { token: adminTokenA });
    assert.equal(r.status, 200, `Suppression échouée : ${JSON.stringify(r.data)}`);
    assert.equal(r.data.id, p1.id);
    assert.equal(r.data.isPrimary, false);

    const after = saleFiles(orgAId, saleA1.id);
    assert.equal(after.length, 2, '2 fichiers sur disque après suppression');
    assert.equal(fs.existsSync(saleDir(orgAId, saleA1.id)), true, 'le dossier de la vente reste (autres photos)');

    const list = await api('GET', `/api/vehicle-sales/${saleA1.id}/photos`, { token: adminTokenA });
    assert.equal(list.data.total, 2);
    assert.equal(list.data.items.find((p) => p.id === p3.id).isPrimary, true, 'la principale est inchangée');
});

test('Suppression de la photo principale : promotion automatique + disque propre', async () => {
    const r = await api('DELETE', `/api/vehicle-sales/${saleA1.id}/photos/${p3.id}`, { token: adminTokenA });
    assert.equal(r.status, 200);
    assert.equal(r.data.id, p3.id);
    assert.equal(r.data.isPrimary, true, 'la photo supprimée était bien la principale');

    const list = await api('GET', `/api/vehicle-sales/${saleA1.id}/photos`, { token: adminTokenA });
    assert.equal(list.data.total, 1);
    assert.equal(list.data.items[0].id, p2.id, 'la photo restante prend le rôle principal');
    assert.equal(list.data.items[0].isPrimary, true, 'promotion automatique');

    const files = saleFiles(orgAId, saleA1.id);
    assert.equal(files.length, 1, 'un seul fichier restant sur disque');

    // Plus aucune photo WEBP sur le disque de la vente (la WEBP supprimée est partie).
    const webpLeft = files.some((f) => {
        const head = fs.readFileSync(path.join(saleDir(orgAId, saleA1.id), f)).subarray(0, 12);
        return head.includes(Buffer.from('WEBP'));
    });
    assert.equal(webpLeft, false, 'le fichier WEBP supprimé ne subsiste pas sur disque');
});

test('Agrégats dans la liste des ventes : photoCount + primaryPhotoId', async () => {
    const list = await api('GET', '/api/vehicle-sales?pageSize=200', { token: adminTokenA });
    assert.equal(list.status, 200);
    const a1 = list.data.items.find((s) => s.id === saleA1.id);
    const c = list.data.items.find((s) => s.id === saleC.id);
    assert.equal(a1.photoCount, 1, 'une photo restante sur saleA1');
    assert.equal(a1.primaryPhotoId, p2.id, 'primaryPhotoId reflète la principale actuelle');
    assert.equal(c.photoCount, 1, 'la photo de saleC est comptée');
    assert.equal(c.primaryPhotoId, c1.id);
});

test('Suppression de la vente : lignes photos + fichiers physiques nettoyés', async () => {
    // Deuxième photo sur saleC pour vérifier le nettoyage complet.
    const up = await uploadPhoto(adminTokenA, saleC.id, {
        name: 'clio-c2.png',
        mime: 'image/png',
        buffer: PNG_BYTES,
    });
    assert.equal(up.status, 201);
    c2 = up.data;
    assert.equal(c2.isPrimary, false);

    const dir = saleDir(orgAId, saleC.id);
    assert.equal(saleFiles(orgAId, saleC.id).length, 2, '2 fichiers sur disque pour saleC');

    const r = await api('DELETE', `/api/vehicle-sales/${saleC.id}`, { token: adminTokenA });
    assert.equal(r.status, 204, `Suppression vente échouée : ${JSON.stringify(r.data)}`);

    // Les photos ne sont plus accessibles (la vente n'existe plus).
    const gone = await api('GET', `/api/vehicle-sales/${saleC.id}/photos`, { token: adminTokenA });
    assert.equal(gone.status, 404);
    const download = await downloadPhoto(adminTokenA, saleC.id, c1.id);
    assert.equal(download.status, 404);

    // Aucun fichier orphelin sur disque : le dossier de la vente a été retiré.
    assert.equal(fs.existsSync(dir), false, 'le dossier de la vente supprimée n\'existe plus sur disque');

    // La liste des ventes ne contient plus saleC.
    const list = await api('GET', '/api/vehicle-sales?pageSize=200', { token: adminTokenA });
    assert.equal(list.data.items.some((s) => s.id === saleC.id), false);
});

test('Persistance : la photo survit au redémarrage du serveur', async () => {
    // Photo supplémentaire sur saleA1 avant le redémarrage (2 au total).
    const up = await uploadPhoto(adminTokenA, saleA1.id, {
        name: 'corolla-coffre.jpg',
        mime: 'image/jpeg',
        buffer: JPG_BYTES,
    });
    assert.equal(up.status, 201, `Upload pré-redémarrage échoué : ${JSON.stringify(up.data)}`);
    p7 = up.data;
    assert.equal(p7.isPrimary, false);
    assert.equal(saleFiles(orgAId, saleA1.id).length, 2, '2 fichiers sur disque avant redémarrage');

    // Redémarrage du serveur (fichiers sur disque : aucune perte).
    serverChild.kill();
    await Promise.race([
        new Promise((resolve) => serverChild.once('exit', resolve)),
        sleep(3000),
    ]);
    await startServer();

    const down = await downloadPhoto(adminTokenA, saleA1.id, p7.id);
    assert.equal(down.status, 200, 'photo accessible après redémarrage');
    assert.deepEqual(down.buffer, JPG_BYTES);

    const list = await api('GET', `/api/vehicle-sales/${saleA1.id}/photos`, { token: adminTokenA });
    assert.equal(list.data.total, 2);
    assert.equal(list.data.items.find((p) => p.id === p2.id).isPrimary, true, 'la principale survit au redémarrage');
    assert.equal(list.data.items.find((p) => p.id === p7.id).isPrimary, false);
});

test('Aucun fichier orphelin : disque en phase avec la base (fin de suite)', async () => {
    const files = saleFiles(orgAId, saleA1.id);
    assert.equal(files.length, 2, 'le disque contient exactement les photos restantes');
    const list = await api('GET', `/api/vehicle-sales/${saleA1.id}/photos`, { token: adminTokenA });
    assert.equal(list.data.total, 2);

    // Organisation B : 1 photo, 1 fichier.
    assert.equal(saleFiles(orgBId, saleB1.id).length, 1);
});

test('Audit frontend : la clé de stockage et les secrets ne fuient pas', async () => {
    const root = path.join(__dirname, '..');
    for (const file of ['app.js', 'index.html']) {
        const content = fs.readFileSync(path.join(root, file), 'utf8');
        const forbidden = ['storageKey', 'storage_key', 'JWT_SECRET', 'DATABASE_URL', 'password_hash'];
        for (const token of forbidden) {
            assert.ok(!content.includes(token), `${file} ne doit pas contenir "${token}"`);
        }
        // Marqueurs du feature photos présent côté client.
        assert.ok(content.includes('salePhotos'), `${file} doit gérer salePhotos`);
        assert.ok(content.includes('saleGallery'), `${file} doit gérer la galerie`);
    }
});
