// ============================================================
// Tests module Ventes de véhicules (Phase 7.7 — Commit 2)
// ============================================================
// Tests d'intégration de bout en bout (serveur + PostgreSQL) :
//   - CRUD complet avec numérotation auto VS-AAAA-NNNNNN sans collision
//   - montants : total recalculé côté serveur (prix + taxes + frais)
//   - instantanés véhicule (libellé, titre, kilométrage, année) figés à la vente
//   - cycle du véhicule piloté par la vente : AVAILABLE -> RESERVED -> SOLD
//     (création => RESERVED, COMPLETED => SOLD, CANCELLED/suppression => AVAILABLE)
//   - historique comptable : vente COMPLETED non supprimable, suppression d'un
//     véhicule référencé bloquée (ON DELETE RESTRICT -> 409)
//   - validation renforcée (prix > 0, devise, buyerType, e-mail, titre,
//     description, kilométrage, année, dates cohérentes, statuts)
//   - isolation multi-tenant sur toutes les opérations (GET/POST/PUT/DELETE,
//     filtres, recherche)
//   - permissions (ADMIN/MANAGER en écriture, DRIVER lecture seule, SUPERADMIN 403)
//
// Lancer avec :  node --test tests/vehicleSales.test.js
// ============================================================
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = 4332;
const BASE = `http://localhost:${PORT}`;

const SALE_NUMBER_RE = /^VS-\d{4}-\d{6}$/;

let serverChild = null;
let superToken = null;
let adminTokenA = null;
let adminTokenB = null;
let adminUserIdA = null;
let driverToken = null;
let createdOrgIds = [];

// Org A : véhicules et conducteur.
let vA1 = null;   // vente interne -> COMPLETED (protège aussi la suppression)
let vA2 = null;   // vente externe -> DRAFT (numérotation 000002)
let vA3 = null;   // annulation / relance
let vA4 = null;   // suppression -> libération du véhicule
let vA5 = null;   // cohérence des instantanés
let driverAId = null;
let vehicleB = null;

let sale1 = null;   // vente acheteur interne (vA1)
let sale2 = null;   // vente acheteur externe (vA2)

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

/** Crée un véhicule dans l'organisation du token. */
async function createVehicle(token, overrides = {}) {
    const r = await api('POST', '/api/vehicles', {
        token,
        body: { plate: unique('VS-V'), brand: 'Toyota', model: 'Corolla', mileage: 45000, year: 2020, fuel: 'Essence', ...overrides },
    });
    assert.equal(r.status, 201, `Création véhicule échouée : ${JSON.stringify(r.data)}`);
    return r.data;
}

/** Lit un véhicule par id. */
async function getVehicle(token, id) {
    const r = await api('GET', `/api/vehicles/${id}`, { token });
    assert.equal(r.status, 200, `Lecture véhicule ${id} échouée : ${JSON.stringify(r.data)}`);
    return r.data;
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
        const username = unique('vs_admin');
        const r = await api('POST', '/api/auth/signup', {
            body: { name: unique(label), adminName: 'Admin Ventes', adminUsername: username, adminPassword: 'secret123' },
        });
        assert.equal(r.status, 201, `Signup échoué : ${JSON.stringify(r.data)}`);
        const token = await login(username, 'secret123');
        return { orgId: r.data.organization.id, token, userId: r.data.admin.id };
    };

    const a = await mkOrg('VS Org A');
    const b = await mkOrg('VS Org B');
    createdOrgIds.push(a.orgId, b.orgId);
    adminTokenA = a.token;
    adminTokenB = b.token;
    adminUserIdA = a.userId;

    vA1 = await createVehicle(adminTokenA);
    vA2 = await createVehicle(adminTokenA, { brand: 'Renault', model: 'Clio', mileage: 20000, year: 2019 });
    vA3 = await createVehicle(adminTokenA, { brand: 'Peugeot', model: '208', mileage: 30000, year: 2018 });
    vA4 = await createVehicle(adminTokenA, { brand: 'Dacia', model: 'Sandero', mileage: 12000, year: 2021 });
    vA5 = await createVehicle(adminTokenA, { brand: 'Toyota', model: 'Yaris', mileage: 30000, year: 2021 });
    vehicleB = await createVehicle(adminTokenB, { brand: 'Ford', model: 'Focus', mileage: 5000, year: 2022 });

    const d = await api('POST', '/api/drivers', { token: adminTokenA, body: { name: 'Acheteur Interne', phone: '771234567' } });
    assert.equal(d.status, 201);
    driverAId = d.data.id;
});

test('Création : vente acheteur interne — numéro, total, instantanés, réservation', async () => {
    const r = await api('POST', '/api/vehicle-sales', {
        token: adminTokenA,
        body: {
            vehicleId: vA1.id,
            buyerId: driverAId,
            saleDate: '2026-08-01',
            price: 8500000,
            tax: 170000,
            fees: 50000,
            // Champs serveur : le client ne peut pas les imposer.
            saleNumber: 'HACK-1',
            totalPrice: 1,
        },
    });
    assert.equal(r.status, 201, `Création échouée : ${JSON.stringify(r.data)}`);
    sale1 = r.data;

    assert.match(sale1.saleNumber, SALE_NUMBER_RE);
    assert.equal(sale1.saleNumber, 'VS-2026-000001', 'première vente de l\'organisation');
    assert.equal(sale1.totalPrice, 8720000, 'total = prix + taxes + frais (ignoré côté client)');
    assert.equal(sale1.currency, 'XOF');
    assert.equal(sale1.buyerType, 'INTERNAL');
    assert.equal(sale1.buyerName, 'Acheteur Interne', 'instantané depuis drivers');
    assert.equal(sale1.vehicle, `${vA1.plate} Toyota Corolla`);
    assert.equal(sale1.title, `Vente ${vA1.plate} Toyota Corolla`);
    assert.equal(sale1.mileage, 45000, 'kilométrage figé à la vente');
    assert.equal(sale1.year, 2020, 'année figée à la vente');
    assert.equal(sale1.salespersonId, adminUserIdA, 'vendeur = utilisateur connecté');
    assert.equal(sale1.status, 'DRAFT');
    assert.equal(sale1.paymentStatus, 'PENDING');
    assert.equal(sale1.deliveryStatus, 'PENDING');
    assert.equal(sale1.paidAmount, 0);

    const vehicle = await getVehicle(adminTokenA, vA1.id);
    assert.equal(vehicle.status, 'RESERVED', 'création => véhicule réservé');
});

test('Création : vente acheteur externe — numérotation sans collision', async () => {
    const r = await api('POST', '/api/vehicle-sales', {
        token: adminTokenA,
        body: {
            vehicleId: vA2.id,
            buyerName: 'Client Externe',
            buyerPhone: '771112233',
            buyerEmail: 'client.externe@example.com',
            buyerAddress: 'Dakar, Sénégal',
            buyerIdCard: 'ID-2026-123',
            saleDate: '2026-08-02',
            currency: 'EUR',
            price: 5000000,
        },
    });
    assert.equal(r.status, 201, `Création échouée : ${JSON.stringify(r.data)}`);
    sale2 = r.data;

    assert.equal(sale2.saleNumber, 'VS-2026-000002', 'pas de collision avec la vente 1');
    assert.equal(sale2.buyerType, 'EXTERNAL');
    assert.equal(sale2.buyerEmail, 'client.externe@example.com');
    assert.equal(sale2.currency, 'EUR');
    assert.equal(sale2.totalPrice, 5000000);
    assert.ok(sale2.title && sale2.title.length >= 3, 'titre auto-généré');

    const vehicle = await getVehicle(adminTokenA, vA2.id);
    assert.equal(vehicle.status, 'RESERVED');
});

test('Sécurité : un véhicule d\'une autre organisation est refusé (404)', async () => {
    const crossA = await api('POST', '/api/vehicle-sales', {
        token: adminTokenB,
        body: { vehicleId: vA1.id, buyerName: 'Intrus', saleDate: '2026-08-01', price: 1000 },
    });
    assert.equal(crossA.status, 404, `org B ne peut pas utiliser le véhicule de org A : ${JSON.stringify(crossA.data)}`);

    const crossB = await api('POST', '/api/vehicle-sales', {
        token: adminTokenA,
        body: { vehicleId: vehicleB.id, buyerName: 'Intrus', saleDate: '2026-08-01', price: 1000 },
    });
    assert.equal(crossB.status, 404, `org A ne peut pas utiliser le véhicule de org B : ${JSON.stringify(crossB.data)}`);

    const driverCross = await api('POST', '/api/vehicle-sales', {
        token: adminTokenA,
        body: { vehicleId: vA2.id, buyerId: 99999999, saleDate: '2026-08-01', price: 1000 },
    });
    assert.equal(driverCross.status, 404, 'acheteur d\'une autre organisation refusé');
});

test('Conflit : double réservation du même véhicule (409)', async () => {
    const again1 = await api('POST', '/api/vehicle-sales', {
        token: adminTokenA,
        body: { vehicleId: vA1.id, buyerName: 'Second Acheteur', saleDate: '2026-08-03', price: 1000 },
    });
    assert.equal(again1.status, 409, `vA1 réservé : ${JSON.stringify(again1.data)}`);

    const again2 = await api('POST', '/api/vehicle-sales', {
        token: adminTokenA,
        body: { vehicleId: vA2.id, buyerName: 'Second Acheteur', saleDate: '2026-08-03', price: 1000 },
    });
    assert.equal(again2.status, 409, `vA2 réservé : ${JSON.stringify(again2.data)}`);
});

test('Validation : champs requis et valeurs refusées (400)', async () => {
    const base = { vehicleId: vA1.id, saleDate: '2026-08-01', price: 1000, buyerName: 'Test' };
    const cases = [
        // Champs requis.
        { ...base, vehicleId: undefined },
        { ...base, saleDate: undefined },
        { ...base, price: undefined },
        // Prix strictement positif.
        { ...base, price: 0 },
        { ...base, price: -500 },
        // vehicleId entier valide.
        { ...base, vehicleId: 'abc' },
        { ...base, vehicleId: 0 },
        // Devise autorisée.
        { ...base, currency: 'INR' },
        // Type d'acheteur limité.
        { ...base, buyerType: 'BOTH' },
        { ...base, buyerType: 'INTERNAL' },
        { ...base, buyerId: driverAId, buyerType: 'EXTERNAL' },
        // Aucun acheteur.
        { vehicleId: vA1.id, saleDate: '2026-08-01', price: 1000, buyerName: '' },
        // E-mail invalide.
        { ...base, buyerEmail: 'pas-un-email' },
        // Titre longueur minimale / maximale.
        { ...base, title: 'ab' },
        { ...base, title: 'T'.repeat(201) },
        // Description limitée.
        { ...base, description: 'D'.repeat(2001) },
        // Kilométrage non négatif.
        { ...base, mileage: -1 },
        // Année valide.
        { ...base, year: 1899 },
        { ...base, year: 9999 },
        // Date invalide.
        { ...base, saleDate: '01/08/2026' },
        // Dates cohérentes (livraison avant vente).
        { ...base, saleDate: '2026-08-05', deliveryDate: '2026-08-01' },
        // Versement supérieur au total.
        { ...base, price: 1000, tax: 0, fees: 0, paidAmount: 2000 },
        // Statuts / modes limités.
        { ...base, status: 'RESERVED' },
        { ...base, paymentStatus: 'UNPAID' },
        { ...base, deliveryStatus: 'SHIPPED' },
        { ...base, paymentMethod: 'BITCOIN' },
    ];
    for (const body of cases) {
        const r = await api('POST', '/api/vehicle-sales', { token: adminTokenA, body });
        assert.equal(r.status, 400, `Attendu 400 pour ${JSON.stringify(body)} : ${JSON.stringify(r.data)}`);
    }
});

test('Montants : total toujours recalculé côté serveur', async () => {
    let r = await api('PUT', `/api/vehicle-sales/${sale1.id}`, { token: adminTokenA, body: { price: 9000000 } });
    assert.equal(r.status, 200, `PUT price échoué : ${JSON.stringify(r.data)}`);
    assert.equal(r.data.totalPrice, 9000000 + 170000 + 50000, 'taxes/frais conservés, total recalculé');

    r = await api('PUT', `/api/vehicle-sales/${sale1.id}`, { token: adminTokenA, body: { tax: 200000 } });
    assert.equal(r.status, 200);
    assert.equal(r.data.totalPrice, 9000000 + 200000 + 50000);

    r = await api('PUT', `/api/vehicle-sales/${sale1.id}`, { token: adminTokenA, body: { price: 0 } });
    assert.equal(r.status, 400, 'prix nul refusé');

    r = await api('PUT', `/api/vehicle-sales/${sale1.id}`, { token: adminTokenA, body: { paidAmount: 99999999 } });
    assert.equal(r.status, 400, 'versement supérieur au total refusé');
});

test('Transitions : AVAILABLE -> RESERVED -> SOLD (véhicule)', async () => {
    // DRAFT -> IN_PROGRESS : le véhicule reste réservé.
    let r = await api('PUT', `/api/vehicle-sales/${sale1.id}`, { token: adminTokenA, body: { status: 'IN_PROGRESS' } });
    assert.equal(r.status, 200);
    assert.equal(r.data.status, 'IN_PROGRESS');
    assert.equal((await getVehicle(adminTokenA, vA1.id)).status, 'RESERVED');

    // IN_PROGRESS -> COMPLETED : le véhicule passe SOLD.
    r = await api('PUT', `/api/vehicle-sales/${sale1.id}`, {
        token: adminTokenA,
        body: { status: 'COMPLETED', paymentStatus: 'PAID', deliveryStatus: 'DELIVERED', deliveryDate: '2026-08-10' },
    });
    assert.equal(r.status, 200, `Completion échouée : ${JSON.stringify(r.data)}`);
    assert.equal(r.data.status, 'COMPLETED');
    assert.equal((await getVehicle(adminTokenA, vA1.id)).status, 'SOLD');

    // COMPLETED est terminal : aucun retour arrière.
    r = await api('PUT', `/api/vehicle-sales/${sale1.id}`, { token: adminTokenA, body: { status: 'DRAFT' } });
    assert.equal(r.status, 400, 'retour arrière depuis COMPLETED refusé');

    // Un véhicule SOLD ne peut plus être vendu.
    const resell = await api('POST', '/api/vehicle-sales', {
        token: adminTokenA,
        body: { vehicleId: vA1.id, buyerName: 'Revendeur', saleDate: '2026-08-11', price: 1000 },
    });
    assert.equal(resell.status, 409);

    // Édition non-statutaire d'une vente terminée : autorisée.
    r = await api('PUT', `/api/vehicle-sales/${sale1.id}`, { token: adminTokenA, body: { notes: 'Archive OK' } });
    assert.equal(r.status, 200);
    assert.equal(r.data.notes, 'Archive OK');
});

test('Annulation : le véhicule est libéré (AVAILABLE)', async () => {
    const created = await api('POST', '/api/vehicle-sales', {
        token: adminTokenA,
        body: { vehicleId: vA3.id, buyerName: 'Vente Annulée', saleDate: '2026-07-15', price: 100000 },
    });
    assert.equal(created.status, 201);
    assert.equal((await getVehicle(adminTokenA, vA3.id)).status, 'RESERVED');

    let r = await api('PUT', `/api/vehicle-sales/${created.data.id}`, { token: adminTokenA, body: { status: 'CANCELLED' } });
    assert.equal(r.status, 200, `Annulation échouée : ${JSON.stringify(r.data)}`);
    assert.equal((await getVehicle(adminTokenA, vA3.id)).status, 'AVAILABLE', 'annulation => véhicule libéré');

    // CANCELLED est terminal.
    r = await api('PUT', `/api/vehicle-sales/${created.data.id}`, { token: adminTokenA, body: { status: 'DRAFT' } });
    assert.equal(r.status, 400, 'retour arrière depuis CANCELLED refusé');

    // Le véhicule libéré peut être remis en vente.
    const relance = await api('POST', '/api/vehicle-sales', {
        token: adminTokenA,
        body: { vehicleId: vA3.id, buyerName: 'Nouvel Acheteur', saleDate: '2026-07-20', price: 150000 },
    });
    assert.equal(relance.status, 201);
    assert.equal((await getVehicle(adminTokenA, vA3.id)).status, 'RESERVED');
});

test('Suppression : historique comptable protégé, véhicule libéré', async () => {
    // Une vente terminée ne peut pas être supprimée (historique comptable).
    const delCompleted = await api('DELETE', `/api/vehicle-sales/${sale1.id}`, { token: adminTokenA });
    assert.equal(delCompleted.status, 400, `vente COMPLETED non supprimable : ${JSON.stringify(delCompleted.data)}`);

    // Une vente en cours peut être supprimée et libère le véhicule.
    const created = await api('POST', '/api/vehicle-sales', {
        token: adminTokenA,
        body: { vehicleId: vA4.id, buyerName: 'Vente Supprimée', saleDate: '2026-07-20', price: 200000 },
    });
    assert.equal(created.status, 201);
    assert.equal((await getVehicle(adminTokenA, vA4.id)).status, 'RESERVED');

    const del = await api('DELETE', `/api/vehicle-sales/${created.data.id}`, { token: adminTokenA });
    assert.equal(del.status, 204);
    assert.equal((await getVehicle(adminTokenA, vA4.id)).status, 'AVAILABLE', 'suppression => véhicule libéré');

    const gone = await api('GET', `/api/vehicle-sales/${created.data.id}`, { token: adminTokenA });
    assert.equal(gone.status, 404);
});

test('Suppression véhicule : ON DELETE RESTRICT protège l\'historique (409)', async () => {
    // vA1 porte une vente COMPLETED : sa suppression est bloquée.
    const del = await api('DELETE', `/api/vehicles/${vA1.id}`, { token: adminTokenA });
    assert.equal(del.status, 409, `suppression d'un véhicule avec historique refusée : ${JSON.stringify(del.data)}`);

    const still = await getVehicle(adminTokenA, vA1.id);
    assert.equal(still.status, 'SOLD', 'le véhicule existe toujours');
});

test('Isolation multi-tenant : aucune fuite entre organisations', async () => {
    // Org B ne voit aucune vente de org A.
    const listB = await api('GET', '/api/vehicle-sales', { token: adminTokenB });
    assert.equal(listB.status, 200);
    assert.equal(listB.data.total, 0, 'org B ne voit pas les ventes de org A');

    // Lecture / modification / suppression croisées refusées.
    assert.equal((await api('GET', `/api/vehicle-sales/${sale1.id}`, { token: adminTokenB })).status, 404);
    assert.equal((await api('PUT', `/api/vehicle-sales/${sale1.id}`, { token: adminTokenB, body: { notes: 'x' } })).status, 404);
    assert.equal((await api('DELETE', `/api/vehicle-sales/${sale1.id}`, { token: adminTokenB })).status, 404);

    // Filtres croisés : org B ne voit rien même en cherchant l'id du véhicule A.
    const filteredB = await api('GET', `/api/vehicle-sales?vehicleId=${vA1.id}`, { token: adminTokenB });
    assert.equal(filteredB.data.total, 0);

    // Org B crée sa propre vente : numérotation indépendante par organisation.
    const own = await api('POST', '/api/vehicle-sales', {
        token: adminTokenB,
        body: { vehicleId: vehicleB.id, buyerName: 'Acheteur Org B', saleDate: '2026-08-01', price: 3000000 },
    });
    assert.equal(own.status, 201, `Création org B échouée : ${JSON.stringify(own.data)}`);
    assert.equal(own.data.saleNumber, 'VS-2026-000001', 'numérotation par organisation');

    // Org A ne voit pas la vente de org B.
    const listA = await api('GET', `/api/vehicle-sales?vehicleId=${vehicleB.id}`, { token: adminTokenA });
    assert.equal(listA.data.total, 0);
});

test('Filtres, recherche, tri et pagination', async () => {
    // Par statut de vente.
    const draft = await api('GET', '/api/vehicle-sales?status=DRAFT', { token: adminTokenA });
    assert.equal(draft.status, 200);
    assert.ok(draft.data.total >= 2);
    assert.ok(draft.data.items.every((s) => s.status === 'DRAFT'));

    const completed = await api('GET', '/api/vehicle-sales?status=COMPLETED', { token: adminTokenA });
    assert.ok(completed.data.items.some((s) => s.id === sale1.id));
    assert.ok(completed.data.items.every((s) => s.status === 'COMPLETED'));

    const cancelled = await api('GET', '/api/vehicle-sales?status=CANCELLED', { token: adminTokenA });
    assert.ok(cancelled.data.items.length >= 1);
    assert.ok(cancelled.data.items.every((s) => s.status === 'CANCELLED'));

    // Par statut de paiement.
    const paid = await api('GET', '/api/vehicle-sales?paymentStatus=PAID', { token: adminTokenA });
    assert.ok(paid.data.items.some((s) => s.id === sale1.id));
    assert.ok(paid.data.items.every((s) => s.paymentStatus === 'PAID'));

    // Par véhicule.
    const byVehicle = await api('GET', `/api/vehicle-sales?vehicleId=${vA1.id}`, { token: adminTokenA });
    assert.ok(byVehicle.data.items.length >= 1);
    assert.ok(byVehicle.data.items.every((s) => s.vehicleId === vA1.id));

    // Recherche texte (numéro, nom, téléphone, véhicule).
    const byNumber = await api('GET', `/api/vehicle-sales?search=${encodeURIComponent(sale1.saleNumber)}`, { token: adminTokenA });
    assert.ok(byNumber.data.items.some((s) => s.id === sale1.id));

    const byName = await api('GET', `/api/vehicle-sales?search=${encodeURIComponent('Client Externe')}`, { token: adminTokenA });
    assert.ok(byName.data.items.some((s) => s.id === sale2.id));

    const byPhone = await api('GET', `/api/vehicle-sales?search=${sale2.buyerPhone}`, { token: adminTokenA });
    assert.ok(byPhone.data.items.some((s) => s.id === sale2.id));

    const byVehicleLabel = await api('GET', `/api/vehicle-sales?search=${encodeURIComponent(vA2.plate)}`, { token: adminTokenA });
    assert.ok(byVehicleLabel.data.items.some((s) => s.id === sale2.id));

    // Plage de dates.
    const range = await api('GET', '/api/vehicle-sales?dateFrom=2026-08-01&dateTo=2026-08-02', { token: adminTokenA });
    assert.ok(range.data.items.some((s) => s.id === sale1.id));
    assert.ok(range.data.items.some((s) => s.id === sale2.id));
    assert.ok(!range.data.items.some((s) => s.vehicleId === vA3.id), 'hors plage exclu');

    // Tri par date (décroissante).
    const byDate = await api('GET', '/api/vehicle-sales?sort=date', { token: adminTokenA });
    assert.equal(byDate.data.items[0].id, sale2.id, 'la vente la plus récente en premier');

    // Tri par prix total (décroissant).
    const byPrice = await api('GET', '/api/vehicle-sales?sort=price', { token: adminTokenA });
    assert.equal(byPrice.data.items[0].id, sale1.id, 'vente au plus fort total en premier');

    // Pagination.
    const paged = await api('GET', '/api/vehicle-sales?page=1&pageSize=1', { token: adminTokenA });
    assert.equal(paged.data.page, 1);
    assert.equal(paged.data.pageSize, 1);
    assert.equal(paged.data.items.length, 1);
    assert.ok(paged.data.total >= 4);

    // Filtres invalides -> 400.
    assert.equal((await api('GET', '/api/vehicle-sales?status=INVALID', { token: adminTokenA })).status, 400);
    assert.equal((await api('GET', '/api/vehicle-sales?paymentStatus=UNPAID', { token: adminTokenA })).status, 400);
    assert.equal((await api('GET', '/api/vehicle-sales?vehicleId=abc', { token: adminTokenA })).status, 400);
    assert.equal((await api('GET', '/api/vehicle-sales?dateFrom=2026/08/01', { token: adminTokenA })).status, 400);
});

test('Permissions : DRIVER lecture seule, SUPERADMIN 403', async () => {
    const username = unique('vs_driver');
    const u = await api('POST', '/api/users', {
        token: adminTokenA,
        body: { username, password: 'secret123', name: 'Chauffeur Ventes', role: 'DRIVER' },
    });
    assert.equal(u.status, 201, `Création utilisateur échouée : ${JSON.stringify(u.data)}`);
    driverToken = await login(username, 'secret123');

    assert.equal((await api('GET', '/api/vehicle-sales', { token: driverToken })).status, 200, 'le DRIVER peut lire');
    assert.equal((await api('GET', `/api/vehicle-sales/${sale2.id}`, { token: driverToken })).status, 200);
    assert.equal(
        (await api('POST', '/api/vehicle-sales', { token: driverToken, body: { vehicleId: vA3.id, buyerName: 'Non', saleDate: '2026-08-01', price: 100 } })).status,
        403
    );
    assert.equal((await api('PUT', `/api/vehicle-sales/${sale2.id}`, { token: driverToken, body: { notes: 'x' } })).status, 403);
    assert.equal((await api('DELETE', `/api/vehicle-sales/${sale2.id}`, { token: driverToken })).status, 403);

    // SUPERADMIN sans organisation -> 403.
    assert.equal((await api('GET', '/api/vehicle-sales', { token: superToken })).status, 403);
});

test('Snapshots véhicule : cohérence conservée après modification du véhicule', async () => {
    const created = await api('POST', '/api/vehicle-sales', {
        token: adminTokenA,
        body: { vehicleId: vA5.id, buyerName: 'Snapshot Test', saleDate: '2026-08-15', price: 8000000 },
    });
    assert.equal(created.status, 201);
    const snapshotVehicle = created.data.vehicle;
    const snapshotMileage = created.data.mileage;
    const snapshotYear = created.data.year;
    assert.equal(snapshotMileage, 30000);
    assert.equal(snapshotYear, 2021);

    // On modifie le véhicule ensuite (kilométrage, marque, modèle).
    const updated = await api('PUT', `/api/vehicles/${vA5.id}`, {
        token: adminTokenA,
        body: { mileage: 999999, brand: 'Renault', model: 'Clio' },
    });
    assert.equal(updated.status, 200, `MAJ véhicule échouée : ${JSON.stringify(updated.data)}`);

    // Les instantanés de la vente ne bougent pas.
    const read = await api('GET', `/api/vehicle-sales/${created.data.id}`, { token: adminTokenA });
    assert.equal(read.status, 200);
    assert.equal(read.data.vehicle, snapshotVehicle, 'libellé véhicule figé à la vente');
    assert.equal(read.data.mileage, snapshotMileage, 'kilométrage figé à la vente');
    assert.equal(read.data.year, snapshotYear, 'année figée à la vente');

    // Nettoyage : suppression de la vente -> véhicule libéré.
    const del = await api('DELETE', `/api/vehicle-sales/${created.data.id}`, { token: adminTokenA });
    assert.equal(del.status, 204);
    assert.equal((await getVehicle(adminTokenA, vA5.id)).status, 'AVAILABLE');
});
