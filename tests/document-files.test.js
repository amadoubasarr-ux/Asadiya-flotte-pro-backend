// ============================================================
// Tests pièces jointes documents (Phase Documentation — Commit 5)
// ============================================================
// Tests d'intégration de bout en bout (serveur + PostgreSQL + disque) :
//   - upload des 4 formats autorisés (PDF, JPG, PNG, WEBP)
//   - rejets de sécurité : taille > 10 MB (413), extension interdite (400),
//     MIME incohérent (400), contenu non conforme (400)
//   - permissions : non authentifié (401), DRIVER (403), ADMIN/MANAGER (200)
//   - isolation multi-tenant : organisation A ne peut NI télécharger NI
//     supprimer le fichier de l'organisation B (404)
//   - téléchargement valide (contenu + type MIME)
//   - suppression de la pièce jointe (document conservé)
//   - suppression du document -> nettoyage du fichier physique
//   - remplacement de fichier : l'ancien fichier est supprimé sur disque
//   - métadonnées correctes (chemin interne sûr, nom original, taille, date)
//   - persistance après redémarrage du serveur (stockage sur disque)
//
// Lancer avec :  node --test tests/document-files.test.js
// ============================================================
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

// Port dédié + répertoire d'upload isolé (nettoyé en fin de suite).
const PORT = 4322;
const BASE = `http://localhost:${PORT}`;
const UPLOADS_DIR = path.join(os.tmpdir(), `asadiya-doc-files-test-${PORT}`);

// Fichiers « fake » valides au niveau des « magic bytes ».
const PDF_BYTES = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(512, 0x61), Buffer.from('\n%%EOF')]);
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
let vehicleAId = null;
let vehicleBId = null;
let createdOrgIds = [];

let pdfDocId = null;       // PDF uploadé (ADMIN)
let jpgDocId = null;       // JPG uploadé (MANAGER)
let docBId = null;         // document de l'organisation B (avec fichier)
let replaceDocId = null;   // utilisé pour le test de remplacement
let restartDocId = null;   // utilisé pour le test de persistance

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

/** POST multipart d'un fichier sur /api/documents/:id/file. */
async function uploadFile(token, docId, { name, mime, buffer }) {
    const fd = new FormData();
    fd.append('file', new Blob([buffer], { type: mime }), name);
    const res = await fetch(`${BASE}/api/documents/${docId}/file`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* pas de corps JSON */ }
    return { status: res.status, data };
}

/** GET du fichier (téléchargement). */
async function downloadFile(token, docId) {
    const res = await fetch(`${BASE}/api/documents/${docId}/file`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const buffer = Buffer.from(await res.arrayBuffer());
    return { status: res.status, buffer, contentType: res.headers.get('content-type'), disposition: res.headers.get('content-disposition') };
}

/** Chemin absolu d'un chemin relatif stocké (upload), sur le disque. */
function absUploadPath(relativePath) {
    return path.join(UPLOADS_DIR, relativePath.replace(/^[\\/]+/, ''));
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

test('Setup : organisations A et B, véhicules, ADMIN/MANAGER/DRIVER', async () => {
    const mkOrg = async (label) => {
        const username = unique('file_admin');
        const r = await api('POST', '/api/auth/signup', {
            body: { name: unique(label), adminName: 'Admin Fichiers', adminUsername: username, adminPassword: 'secret123' },
        });
        assert.equal(r.status, 201, `Signup échoué : ${JSON.stringify(r.data)}`);
        const token = await login(username, 'secret123');
        return { orgId: r.data.organization.id, token };
    };

    const a = await mkOrg('File Org A');
    const b = await mkOrg('File Org B');
    createdOrgIds.push(a.orgId, b.orgId);
    adminTokenA = a.token;
    adminTokenB = b.token;
    orgAId = a.orgId;

    const vA = await api('POST', '/api/vehicles', { token: adminTokenA, body: { plate: unique('FILE-A'), brand: 'Toyota', model: 'Hilux', mileage: 10000, fuel: 'Gazole' } });
    assert.equal(vA.status, 201);
    vehicleAId = vA.data.id;

    const vB = await api('POST', '/api/vehicles', { token: adminTokenB, body: { plate: unique('FILE-B'), brand: 'Renault', model: 'Clio', mileage: 2000, fuel: 'Essence' } });
    assert.equal(vB.status, 201);
    vehicleBId = vB.data.id;

    // MANAGER dans l'organisation A.
    const m = await api('POST', '/api/users', {
        token: adminTokenA,
        body: { username: unique('file_mgr'), password: 'secret123', name: 'Gérant Fichiers', role: 'MANAGER' },
    });
    assert.equal(m.status, 201);
    managerTokenA = await login(m.data.username, 'secret123');

    // DRIVER dans l'organisation A.
    const d = await api('POST', '/api/users', {
        token: adminTokenA,
        body: { username: unique('file_drv'), password: 'secret123', name: 'Chauffeur Fichiers', role: 'DRIVER' },
    });
    assert.equal(d.status, 201);
    driverTokenA = await login(d.data.username, 'secret123');
});

test('Upload PDF valide (ADMIN) : 200 + métadonnées correctes', async () => {
    const doc = await api('POST', '/api/documents', {
        token: adminTokenA,
        body: { vehicleId: vehicleAId, documentType: 'Assurance', documentNumber: unique('ASS') },
    });
    assert.equal(doc.status, 201);
    pdfDocId = doc.data.id;

    const r = await uploadFile(adminTokenA, pdfDocId, {
        name: 'assurance_2026.pdf',
        mime: 'application/pdf',
        buffer: PDF_BYTES,
    });
    assert.equal(r.status, 200, `Upload échoué : ${JSON.stringify(r.data)}`);
    assert.equal(r.data.fileName, 'assurance_2026.pdf');
    assert.equal(r.data.mimeType, 'application/pdf');
    assert.equal(r.data.fileSize, PDF_BYTES.length);
    // Chemin interne sécurisé : jamais le nom original, jamais exposé tel quel.
    assert.match(r.data.filePath, /^documents\/\d+\/\d+\/document_[0-9a-f-]+\.pdf$/);
    assert.ok(r.data.fileUploadedAt, 'fileUploadedAt renseigné');
    // Le chemin interne est relatif et contient l'org et l'id du document.
    assert.ok(r.data.filePath.startsWith(`documents/${orgAId}/${pdfDocId}/`), `filePath inattendu : ${r.data.filePath}`);
});

test('Upload JPG valide (MANAGER) : 200', async () => {
    const doc = await api('POST', '/api/documents', {
        token: adminTokenA,
        body: { vehicleId: vehicleAId, documentType: 'Carte Grise', documentNumber: unique('CG') },
    });
    assert.equal(doc.status, 201);
    jpgDocId = doc.data.id;

    const r = await uploadFile(managerTokenA, jpgDocId, {
        name: 'carte-grise.jpg',
        mime: 'image/jpeg',
        buffer: JPG_BYTES,
    });
    assert.equal(r.status, 200, `Upload MANAGER échoué : ${JSON.stringify(r.data)}`);
    assert.equal(r.data.mimeType, 'image/jpeg');
});

test('Upload PNG valide (ADMIN) : 200', async () => {
    const doc = await api('POST', '/api/documents', {
        token: adminTokenA,
        body: { vehicleId: vehicleAId, documentType: 'Autorisation', documentNumber: unique('AUT') },
    });
    assert.equal(doc.status, 201);

    const r = await uploadFile(adminTokenA, doc.data.id, {
        name: 'autorisation.png',
        mime: 'image/png',
        buffer: PNG_BYTES,
    });
    assert.equal(r.status, 200, `Upload PNG échoué : ${JSON.stringify(r.data)}`);
    assert.equal(r.data.mimeType, 'image/png');
});

test('Upload WEBP valide (ADMIN) : 200', async () => {
    const doc = await api('POST', '/api/documents', {
        token: adminTokenA,
        body: { vehicleId: vehicleAId, documentType: 'Vignette', documentNumber: unique('VIG') },
    });
    assert.equal(doc.status, 201);

    const r = await uploadFile(adminTokenA, doc.data.id, {
        name: 'vignette.webp',
        mime: 'image/webp',
        buffer: WEBP_BYTES,
    });
    assert.equal(r.status, 200, `Upload WEBP échoué : ${JSON.stringify(r.data)}`);
    assert.equal(r.data.mimeType, 'image/webp');
});

test('Téléchargement valide : contenu et type MIME corrects', async () => {
    const r = await downloadFile(adminTokenA, pdfDocId);
    assert.equal(r.status, 200);
    assert.equal(r.contentType, 'application/pdf');
    assert.deepEqual(r.buffer, PDF_BYTES, 'le contenu téléchargé est identique à l\'original');
});

test('Métadonnées persistées : détail du document', async () => {
    const r = await api('GET', `/api/documents/${pdfDocId}`, { token: adminTokenA });
    assert.equal(r.status, 200);
    assert.equal(r.data.fileName, 'assurance_2026.pdf');
    assert.equal(r.data.mimeType, 'application/pdf');
    assert.equal(r.data.fileSize, PDF_BYTES.length);
    assert.match(r.data.filePath, /^documents\/\d+\/\d+\/document_[0-9a-f-]+\.pdf$/);
    assert.ok(r.data.fileUploadedAt);
});

test('Fichier > 10 MB -> 413', async () => {
    const doc = await api('POST', '/api/documents', {
        token: adminTokenA,
        body: { vehicleId: vehicleAId, documentType: 'Autre', documentNumber: unique('BIG') },
    });
    assert.equal(doc.status, 201);

    const big = Buffer.alloc(10 * 1024 * 1024 + 1024, 0x61);
    const r = await uploadFile(adminTokenA, doc.data.id, {
        name: 'tres-gros.pdf',
        mime: 'application/pdf',
        buffer: big,
    });
    assert.equal(r.status, 413, `Attendu 413, reçu ${r.status} : ${JSON.stringify(r.data)}`);
});

test('Extension interdite -> 400', async () => {
    const doc = await api('POST', '/api/documents', {
        token: adminTokenA,
        body: { vehicleId: vehicleAId, documentType: 'Autre', documentNumber: unique('EXT') },
    });
    assert.equal(doc.status, 201);

    const r = await uploadFile(adminTokenA, doc.data.id, {
        name: 'malware.txt',
        mime: 'text/plain',
        buffer: Buffer.from('pas un fichier autorisé'),
    });
    assert.equal(r.status, 400, `Attendu 400, reçu ${r.status} : ${JSON.stringify(r.data)}`);
});

test('MIME incohérent avec l\'extension -> 400', async () => {
    const doc = await api('POST', '/api/documents', {
        token: adminTokenA,
        body: { vehicleId: vehicleAId, documentType: 'Autre', documentNumber: unique('MIM') },
    });
    assert.equal(doc.status, 201);

    const r = await uploadFile(adminTokenA, doc.data.id, {
        name: 'surprise.pdf',
        mime: 'image/jpeg', // déclaré JPEG, extension PDF
        buffer: JPG_BYTES,
    });
    assert.equal(r.status, 400, `Attendu 400, reçu ${r.status} : ${JSON.stringify(r.data)}`);
});

test('Contenu non conforme aux « magic bytes » -> 400', async () => {
    const doc = await api('POST', '/api/documents', {
        token: adminTokenA,
        body: { vehicleId: vehicleAId, documentType: 'Autre', documentNumber: unique('CONT') },
    });
    assert.equal(doc.status, 201);

    const r = await uploadFile(adminTokenA, doc.data.id, {
        name: 'photo.jpg',
        mime: 'image/jpeg',
        buffer: PNG_BYTES, // déclaré JPEG, contenu PNG
    });
    assert.equal(r.status, 400, `Attendu 400, reçu ${r.status} : ${JSON.stringify(r.data)}`);
});

test('Nom de fichier dangereux -> neutralisé ou refusé', async () => {
    const doc = await api('POST', '/api/documents', {
        token: adminTokenA,
        body: { vehicleId: vehicleAId, documentType: 'Autre', documentNumber: unique('NAME') },
    });
    assert.equal(doc.status, 201);

    // Traversée de chemin : busboy réduit le nom à son basename AVANT le
    // serveur, donc le fichier ne peut jamais sortir du dossier d'upload.
    const r = await uploadFile(adminTokenA, doc.data.id, {
        name: '../../etc/passwd.pdf',
        mime: 'application/pdf',
        buffer: PDF_BYTES,
    });
    assert.equal(r.status, 200, `Attendu 200 (nom neutralisé), reçu ${r.status} : ${JSON.stringify(r.data)}`);
    assert.equal(r.data.fileName, 'passwd.pdf');
    assert.match(r.data.filePath, /^documents\/\d+\/\d+\/document_[0-9a-f-]+\.pdf$/);
    assert.ok(!r.data.filePath.includes('..'), 'filePath ne doit pas contenir ".."');

    // Nom contenant ".." sans séparateur (non modifié par busboy) -> refusé.
    const r2 = await uploadFile(adminTokenA, doc.data.id, {
        name: '..pdf',
        mime: 'application/pdf',
        buffer: PDF_BYTES,
    });
    assert.equal(r2.status, 400, `Attendu 400, reçu ${r2.status} : ${JSON.stringify(r2.data)}`);
});

test('Non authentifié -> 401', async () => {
    const doc = await api('POST', '/api/documents', {
        token: adminTokenA,
        body: { vehicleId: vehicleAId, documentType: 'Autre', documentNumber: unique('NONAUTH') },
    });
    assert.equal(doc.status, 201);

    const r = await uploadFile(null, doc.data.id, {
        name: 'sans-token.pdf',
        mime: 'application/pdf',
        buffer: PDF_BYTES,
    });
    assert.equal(r.status, 401, `Attendu 401, reçu ${r.status}`);

    const down = await downloadFile(null, doc.data.id);
    assert.equal(down.status, 401);
});

test('DRIVER : upload refusé -> 403 (lecture autorisée)', async () => {
    const doc = await api('POST', '/api/documents', {
        token: adminTokenA,
        body: { vehicleId: vehicleAId, documentType: 'Autre', documentNumber: unique('DRV') },
    });
    assert.equal(doc.status, 201);

    const up = await uploadFile(driverTokenA, doc.data.id, {
        name: 'chauffeur.pdf',
        mime: 'application/pdf',
        buffer: PDF_BYTES,
    });
    assert.equal(up.status, 403, `Attendu 403, reçu ${up.status}`);

    const del = await api('DELETE', `/api/documents/${doc.data.id}/file`, { token: driverTokenA });
    assert.equal(del.status, 403);

    const down = await downloadFile(driverTokenA, pdfDocId);
    assert.equal(down.status, 200, 'le DRIVER peut télécharger la pièce jointe de son organisation');
});

test('Organisation B : préparation d\'un fichier (upload par admin B)', async () => {
    const doc = await api('POST', '/api/documents', {
        token: adminTokenB,
        body: { vehicleId: vehicleBId, documentType: 'Assurance', documentNumber: unique('ASS-B') },
    });
    assert.equal(doc.status, 201);
    docBId = doc.data.id;

    const r = await uploadFile(adminTokenB, docBId, {
        name: 'assurance-B.pdf',
        mime: 'application/pdf',
        buffer: PDF_BYTES,
    });
    assert.equal(r.status, 200, `Upload B échoué : ${JSON.stringify(r.data)}`);
});

test('Isolation multi-tenant : A ne peut pas télécharger le fichier de B', async () => {
    const r = await downloadFile(adminTokenA, docBId);
    assert.equal(r.status, 404, `Attendu 404, reçu ${r.status}`);

    // B, en revanche, télécharge bien son propre fichier.
    const own = await downloadFile(adminTokenB, docBId);
    assert.equal(own.status, 200);
    assert.deepEqual(own.buffer, PDF_BYTES);
});

test('Isolation multi-tenant : A ne peut pas supprimer le fichier de B', async () => {
    const r = await api('DELETE', `/api/documents/${docBId}/file`, { token: adminTokenA });
    assert.equal(r.status, 404, `Attendu 404, reçu ${r.status}`);

    const still = await downloadFile(adminTokenB, docBId);
    assert.equal(still.status, 200, 'le fichier de B est intact');
});

test('Suppression de la pièce jointe : document conservé, fichier retiré', async () => {
    const before = await api('GET', `/api/documents/${jpgDocId}`, { token: adminTokenA });
    assert.ok(before.data.filePath, 'une pièce jointe existe avant suppression');

    const r = await api('DELETE', `/api/documents/${jpgDocId}/file`, { token: adminTokenA });
    assert.equal(r.status, 200);
    assert.equal(r.data.id, jpgDocId);
    assert.equal(r.data.filePath, null);
    assert.equal(r.data.fileName, null);
    assert.equal(r.data.mimeType, null);
    assert.equal(r.data.fileSize, null);

    const gone = await downloadFile(adminTokenA, jpgDocId);
    assert.equal(gone.status, 404);

    const disk = absUploadPath(before.data.filePath);
    assert.equal(fs.existsSync(disk), false, 'fichier physique supprimé du disque');
});

test('Remplacement de fichier : nouveau contenu + ancien fichier supprimé', async () => {
    const doc = await api('POST', '/api/documents', {
        token: adminTokenA,
        body: { vehicleId: vehicleAId, documentType: 'Contrôle Technique', documentNumber: unique('CT') },
    });
    assert.equal(doc.status, 201);
    replaceDocId = doc.data.id;

    const first = await uploadFile(adminTokenA, replaceDocId, {
        name: 'ct-ancien.pdf',
        mime: 'application/pdf',
        buffer: PDF_BYTES,
    });
    assert.equal(first.status, 200);
    const oldPath = first.data.filePath;
    assert.ok(fs.existsSync(absUploadPath(oldPath)), 'ancien fichier présent sur disque');

    const second = await uploadFile(adminTokenA, replaceDocId, {
        name: 'ct-nouveau.pdf',
        mime: 'application/pdf',
        buffer: JPG_BYTES, // contenu différent (simple octet, valide PDF ?)
    });
    // Contenu non PDF : doit être rejeté (400) et l'ancien fichier conservé.
    assert.equal(second.status, 400);
    const still = await downloadFile(adminTokenA, replaceDocId);
    assert.equal(still.status, 200);
    assert.deepEqual(still.buffer, PDF_BYTES, 'ancien fichier toujours accessible');

    // Remplacement propre avec un contenu PDF valide.
    const third = await uploadFile(adminTokenA, replaceDocId, {
        name: 'ct-nouveau-v2.pdf',
        mime: 'application/pdf',
        buffer: PNG_BYTES,
    });
    assert.equal(third.status, 400);

    const NEW_BYTES = Buffer.concat([Buffer.from('%PDF-2.0\n'), Buffer.alloc(600, 0x62)]);
    const fourth = await uploadFile(adminTokenA, replaceDocId, {
        name: 'ct-nouveau-v3.pdf',
        mime: 'application/pdf',
        buffer: NEW_BYTES,
    });
    assert.equal(fourth.status, 200, `Remplacement échoué : ${JSON.stringify(fourth.data)}`);
    assert.equal(fourth.data.fileName, 'ct-nouveau-v3.pdf');
    assert.notEqual(fourth.data.filePath, oldPath);

    const newDisk = absUploadPath(fourth.data.filePath);
    assert.ok(fs.existsSync(newDisk), 'nouveau fichier présent sur disque');
    assert.equal(fs.existsSync(absUploadPath(oldPath)), false, 'ancien fichier supprimé du disque');

    const after = await downloadFile(adminTokenA, replaceDocId);
    assert.deepEqual(after.buffer, NEW_BYTES);
});

test('Suppression du document : le fichier physique est nettoyé', async () => {
    const before = await api('GET', `/api/documents/${replaceDocId}`, { token: adminTokenA });
    assert.ok(before.data.filePath);

    const r = await api('DELETE', `/api/documents/${replaceDocId}`, { token: adminTokenA });
    assert.equal(r.status, 204);

    const gone = await api('GET', `/api/documents/${replaceDocId}`, { token: adminTokenA });
    assert.equal(gone.status, 404);

    assert.equal(fs.existsSync(absUploadPath(before.data.filePath)), false, 'fichier nettoyé à la suppression du document');
});

test('Persistance : le fichier survit au redémarrage du serveur', async () => {
    // Document + fichier avant redémarrage.
    const doc = await api('POST', '/api/documents', {
        token: adminTokenA,
        body: { vehicleId: vehicleAId, documentType: 'Permis', documentNumber: unique('PER') },
    });
    assert.equal(doc.status, 201);
    restartDocId = doc.data.id;

    const up = await uploadFile(adminTokenA, restartDocId, {
        name: 'permis.pdf',
        mime: 'application/pdf',
        buffer: PDF_BYTES,
    });
    assert.equal(up.status, 200);
    assert.ok(fs.existsSync(absUploadPath(up.data.filePath)), 'fichier sur disque');

    // Redémarrage du serveur (fichiers sur disque : aucune perte).
    serverChild.kill();
    await Promise.race([
        new Promise((resolve) => serverChild.once('exit', resolve)),
        sleep(3000),
    ]);
    await startServer();

    // Les jetons JWT restent valides (même secret) ; on revérifie malgré tout.
    const r = await downloadFile(adminTokenA, restartDocId);
    assert.equal(r.status, 200, 'fichier accessible après redémarrage');
    assert.deepEqual(r.buffer, PDF_BYTES);

    const detail = await api('GET', `/api/documents/${restartDocId}`, { token: adminTokenA });
    assert.equal(detail.status, 200);
    assert.equal(detail.data.fileName, 'permis.pdf');
});
