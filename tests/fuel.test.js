// ============================================================
// Tests module carburant (Phase 7.3)
// ============================================================
// 1. Tests unitaires des fonctions pures (calculs consommation, coût/km,
//    KPI, comparaison de périodes, détection d'anomalies, graphiques).
// 2. Tests d'intégration de bout en bout (serveur + PostgreSQL) :
//    - création / modification / suppression d'un plein
//    - calcul automatique du montant (litres × prix/litre)
//    - calcul de la consommation et du coût/km
//    - statistiques et filtres de période
//    - isolation multi-tenant entre organisations
//    - permissions (rôles)
//    - valeurs invalides
//    - budget carburant (CRUD + upsert mensuel)
//
// Lancer avec :  node --test tests/fuel.test.js
// ============================================================
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const {
    DEFAULT_THRESHOLDS,
    parsePeriod,
    computeLogMetrics,
    attachMetrics,
    buildKpis,
    compareKpis,
    detectAnomalies,
    buildCharts,
} = require('../db/fuelAnalytics');

// Port dédié aux tests d'intégration du module carburant (évite toute
// collision avec le serveur de développement lancé sur 4000).
const PORT = 4320;
const BASE = `http://localhost:${PORT}`;

// ============================================================
// Partie 1 — Tests unitaires (aucune base requise)
// ============================================================

test('Consommation : calcul L/100km et coût/km depuis le plein précédent', () => {
    const prev = { mileage: 10000, liters: 40, cost: 30000 };
    const cur = { mileage: 10500, liters: 30, cost: 25000 };
    const m = computeLogMetrics(cur, prev);
    assert.equal(m.distance, 500);
    assert.ok(Math.abs(m.consumption - 6) < 0.001, `attendu 6 L/100km, reçu ${m.consumption}`);
    assert.ok(Math.abs(m.costPerKm - 50) < 0.001, `attendu 50 FCFA/km, reçu ${m.costPerKm}`);
});

test('Consommation : impossible (aucune valeur inventée) sans plein précédent', () => {
    const m = computeLogMetrics({ mileage: 10500, liters: 30, cost: 25000 }, null);
    assert.equal(m.consumption, null);
    assert.equal(m.costPerKm, null);
    assert.equal(m.distance, null);
});

test('Consommation : nulle/négative pour un kilométrage régressif ou identique', () => {
    const prev = { mileage: 11000 };
    assert.equal(computeLogMetrics({ mileage: 11000, liters: 30 }, prev).consumption, null);
    assert.equal(computeLogMetrics({ mileage: 10900, liters: 30 }, prev).consumption, null);
});

test('attachMetrics : rattache les métriques dans l\'ordre chronologique par véhicule', () => {
    const logs = [
        { id: 1, vehicleId: 1, vehicle: 'V1', date: '2026-08-05', mileage: 10500, liters: 30, cost: 25000 },
        { id: 2, vehicleId: 1, vehicle: 'V1', date: '2026-08-01', mileage: 10000, liters: 40, cost: 30000 },
        { id: 3, vehicleId: 2, vehicle: 'V2', date: '2026-08-03', mileage: 500, liters: 10, cost: 8000 },
    ];
    const metrics = attachMetrics(logs);
    const m1 = metrics.find((l) => l.id === 1);
    const m2 = metrics.find((l) => l.id === 2);
    const m3 = metrics.find((l) => l.id === 3);
    assert.equal(m2.consumption, null, 'premier plein : pas de calcul possible');
    assert.ok(Math.abs(m1.consumption - 6) < 0.001);
    assert.equal(m3.consumption, null, 'véhicule avec un seul plein : pas de calcul');
});

test('KPI : totaux, prix moyen pondéré, nombre de pleins et véhicules alimentés', () => {
    const logs = [
        { liters: 40, cost: 30000, consumption: 8, costPerKm: 60, vehicleId: 1 },
        { liters: 60, cost: 42000, consumption: 10, costPerKm: 70, vehicleId: 1 },
        { liters: 20, cost: 14000, consumption: null, costPerKm: null, vehicleId: 2 },
    ];
    const k = buildKpis(logs);
    assert.equal(k.count, 3);
    assert.equal(k.vehiclesFed, 2);
    assert.equal(k.liters, 120);
    assert.equal(k.cost, 86000);
    assert.ok(Math.abs(k.avgPricePerLiter - 716.67) < 0.01);
    assert.equal(k.avgConsumption, 9);
    assert.equal(k.costPerKm, 65);
});

test('KPI : comparaison avec la période précédente (pct) et valeurs nulles', () => {
    const prev = { liters: 100, cost: 70000, avgPricePerLiter: 700, avgConsumption: 8, costPerKm: 50, count: 4, vehiclesFed: 3 };
    const cur = { liters: 110, cost: 77000, avgPricePerLiter: 700, avgConsumption: 9, costPerKm: 55, count: 5, vehiclesFed: 3 };
    const cmp = compareKpis(cur, prev);
    assert.ok(Math.abs(cmp.liters.pct - 10) < 0.01);
    assert.ok(Math.abs(cmp.cost.pct - 10) < 0.01);
    assert.ok(Math.abs(cmp.avgConsumption.pct - 12.5) < 0.01);
    assert.equal(cmp.avgPricePerLiter.pct, 0);
    assert.equal(cmp.vehiclesFed.pct, 0);
    // Période précédente vide => aucune tendance inventée.
    const empty = compareKpis(cur, { liters: 0, cost: 0, avgPricePerLiter: null, avgConsumption: null, costPerKm: null, count: 0, vehiclesFed: 0 });
    assert.equal(empty.liters.pct, null);
});

test('Détection d\'anomalies : consommation élevée, kilométrage incohérent, volume inhabituel, prix anormal, pleins rapprochés', () => {
    const logs = [
        { id: 1, vehicleId: 1, vehicle: 'V1', date: '2026-08-01', mileage: 10000, liters: 40, cost: 30000, pricePerLiter: 750, consumption: 6, costPerKm: 50, distance: 500, prevMileage: 9500 },
        { id: 2, vehicleId: 1, vehicle: 'V1', date: '2026-08-03', mileage: 10030, liters: 250, cost: 175000, pricePerLiter: 700, consumption: null, costPerKm: null, distance: -20, prevMileage: 10050 },
        { id: 3, vehicleId: 2, vehicle: 'V2', date: '2026-08-05', mileage: 5000, liters: 60, cost: 90000, pricePerLiter: 1500, consumption: 30, costPerKm: 80, distance: 200, prevMileage: 4800 },
    ];
    const anomalies = detectAnomalies(logs, DEFAULT_THRESHOLDS);
    const types = anomalies.map((a) => a.type);
    assert.ok(types.includes('high_consumption'), `attendu high_consumption : ${types.join(', ')}`);
    assert.ok(types.includes('unusual_quantity'), `attendu unusual_quantity : ${types.join(', ')}`);
    assert.ok(types.includes('mileage_regression'), `attendu mileage_regression : ${types.join(', ')}`);
    assert.ok(types.includes('abnormal_price'), `attendu abnormal_price : ${types.join(', ')}`);
    const sev = anomalies.find((a) => a.type === 'mileage_regression');
    assert.equal(sev.severity, 'ÉLEVÉE');
    // Seuils configurés : un seuil haut désactive une détection.
    const lenient = detectAnomalies(logs, { ...DEFAULT_THRESHOLDS, maxLiters: 1000 });
    assert.ok(!lenient.some((a) => a.type === 'unusual_quantity'));
});

test('Anomalies : pleins rapprochés détectés une seule fois par paire', () => {
    const logs = [
        { id: 1, vehicleId: 1, vehicle: 'V1', date: '2026-08-01T08:00:00', mileage: 10000, liters: 40, cost: 30000 },
        { id: 2, vehicleId: 1, vehicle: 'V1', date: '2026-08-01T12:00:00', mileage: 10100, liters: 30, cost: 21000 },
    ];
    const anomalies = detectAnomalies(logs, DEFAULT_THRESHOLDS);
    const close = anomalies.filter((a) => a.type === 'close_fills');
    assert.equal(close.length, 1, 'un seul signalement par couple de pleins');
    assert.equal(close[0].severity, 'FAIBLE');
});

test('Périodes : bornes et période précédente de durée équivalente', () => {
    const month = parsePeriod({ period: 'month' });
    assert.equal(month.key, 'month');
    const duration = month.to - month.from;
    const prevDuration = month.from - month.prevFrom;
    assert.equal(duration, prevDuration, 'périodes de durée égale');
    const custom = parsePeriod({ period: 'custom', from: '2026-07-10', to: '2026-07-20' });
    assert.equal(custom.label, 'Période personnalisée');
    assert.equal((custom.to - custom.from) / 86400000, 11);
    // Dates invalides : repli sur le mois en cours, pas de crash.
    const bad = parsePeriod({ period: 'custom', from: 'nimporte', to: '' });
    assert.equal(bad.key, 'custom');
    assert.ok(bad.from && bad.to);
});

test('Graphiques : agrégations par mois, par véhicule, par type et top consommateurs', () => {
    const logs = [
        { vehicleId: 1, vehicle: 'V1', fuelType: 'Gazole', date: '2026-08-05', liters: 40, cost: 30000, consumption: 8, costPerKm: 50 },
        { vehicleId: 1, vehicle: 'V1', fuelType: 'Gazole', date: '2026-07-20', liters: 60, cost: 42000, consumption: 10, costPerKm: 55 },
        { vehicleId: 2, vehicle: 'V2', fuelType: 'Essence', date: '2026-08-10', liters: 20, cost: 15000, consumption: 6, costPerKm: 40 },
    ];
    const c = buildCharts(logs);
    assert.equal(c.costByMonth.labels.length, 2);
    assert.equal(c.litersByMonth.data.reduce((s, v) => s + v, 0), 120);
    assert.equal(c.costByVehicle.labels.length, 2);
    assert.equal(c.topConsumers.labels[0], 'V1');
    assert.equal(c.topConsumers.data[0], 100);
    assert.equal(c.costByFuelType.labels.length, 2);
    assert.ok(c.costPerKmByVehicle.data.some((v) => Math.abs(v - 52.5) < 0.01));
});

// ============================================================
// Partie 2 — Tests d'intégration (serveur + PostgreSQL)
// ============================================================

let serverChild = null;
let superToken = null;
let adminTokenA = null;
let adminTokenB = null;
let vehicleAId = null;
let driverAId = null;
let createdOrgIds = [];

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

// Date "JJ" du mois en cours : les pleins sont saisis dans le mois courant
// pour que les filtres month / custom / budget le couvrent réellement.
function curMonthDay(day) {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function curMonthKey() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function lastDayOfCurrentMonth() {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
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
        const username = unique('fuel_admin');
        const r = await api('POST', '/api/auth/signup', {
            body: { name: unique(label), adminName: 'Admin Carburant', adminUsername: username, adminPassword: 'secret123' },
        });
        assert.equal(r.status, 201, `Signup échoué : ${JSON.stringify(r.data)}`);
        const token = await login(username, 'secret123');
        return { orgId: r.data.organization.id, token };
    };

    const a = await mkOrg('Fuel Org A');
    const b = await mkOrg('Fuel Org B');
    createdOrgIds.push(a.orgId, b.orgId);
    adminTokenA = a.token;
    adminTokenB = b.token;

    const vA = await api('POST', '/api/vehicles', { token: adminTokenA, body: { plate: unique('FUEL-A'), brand: 'Toyota', model: 'Hilux', mileage: 10000, fuel: 'Gazole' } });
    assert.equal(vA.status, 201);
    vehicleAId = vA.data.id;

    const vB = await api('POST', '/api/vehicles', { token: adminTokenB, body: { plate: unique('FUEL-B'), brand: 'Renault', model: 'Clio', mileage: 2000, fuel: 'Essence' } });
    assert.equal(vB.status, 201);

    const dA = await api('POST', '/api/drivers', { token: adminTokenA, body: { name: 'Conducteur Test', phone: '771234567' } });
    assert.equal(dA.status, 201);
    driverAId = dA.data.id;
});

test('Création d\'un plein : montant calculé automatiquement (litres × prix/litre)', async () => {
    const r = await api('POST', '/api/fuel-logs', {
        token: adminTokenA,
        body: {
            vehicleId: vehicleAId,
            vehicle: 'Toyota Hilux',
            driverId: driverAId,
            driver: 'Conducteur Test',
            date: curMonthDay(1),
            mileage: 10000,
            liters: 40,
            pricePerLiter: 750,
            fuelType: 'Gazole',
            station: 'Station A',
            paymentMethod: 'Espèces',
            receiptNumber: 'RCP-001',
            notes: 'Plein test',
        },
    });
    assert.equal(r.status, 201, `Création échouée : ${JSON.stringify(r.data)}`);
    assert.equal(r.data.cost, 30000, 'coût = 40 × 750');
    assert.equal(r.data.pricePerLiter, 750);
    assert.equal(r.data.fuelType, 'Gazole');
    assert.equal(r.data.station, 'Station A');
    assert.equal(r.data.paymentMethod, 'Espèces');
    assert.equal(r.data.receiptNumber, 'RCP-001');
    assert.equal(r.data.notes, 'Plein test');
    assert.equal(r.data.driverId, driverAId);
});

test('Création d\'un plein : montant fourni directement (sans pricePerLiter)', async () => {
    const r = await api('POST', '/api/fuel-logs', {
        token: adminTokenA,
        body: {
            vehicleId: vehicleAId,
            vehicle: 'Toyota Hilux',
            date: curMonthDay(5),
            mileage: 10500,
            liters: 30,
            cost: 22500,
        },
    });
    assert.equal(r.status, 201, `Création échouée : ${JSON.stringify(r.data)}`);
    assert.equal(r.data.cost, 22500);
});

test('Modification d\'un plein : PUT partiel', async () => {
    const list = await api('GET', '/api/fuel-logs', { token: adminTokenA });
    assert.equal(list.status, 200);
    const target = list.data.find((f) => f.mileage === 10500);
    assert.ok(target, 'plein à modifier trouvé');
    const r = await api('PUT', `/api/fuel-logs/${target.id}`, {
        token: adminTokenA,
        body: { station: 'Station B', paymentMethod: 'Carte' },
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.station, 'Station B');
    assert.equal(r.data.paymentMethod, 'Carte');
    assert.equal(r.data.cost, 22500, 'le coût existant n\'est pas perdu');
});

test('Statistiques : KPI, consommation calculée, comparaison et anomalies', async () => {
    const stats = await api('GET', '/api/fuel-logs/stats?period=month', { token: adminTokenA });
    assert.equal(stats.status, 200, `Stats échouées : ${JSON.stringify(stats.data)}`);
    const s = stats.data;
    assert.equal(s.period.key, 'month');
    assert.ok(s.kpi.liters.value >= 70, 'litres de la période');
    assert.ok(s.kpi.cost.value >= 52500, 'coût de la période');
    assert.ok(s.kpi.count.value >= 2);
    // Consommation du 2e plein : 500 km pour 30 L => 6 L/100km.
    const consumption = s.kpi.avgConsumption;
    assert.ok(consumption != null, 'consommation moyenne calculée');
    assert.ok(Math.abs(consumption.value - 6) < 0.5, `attendu ~6, reçu ${consumption.value}`);
    // Coût/km du 2e plein : 22500 / 500 = 45 FCFA/km.
    assert.ok(s.kpi.costPerKm.value != null);
    assert.ok(Math.abs(s.kpi.costPerKm.value - 45) < 1, `attendu ~45, reçu ${s.kpi.costPerKm.value}`);
    // Graphiques disponibles.
    assert.ok(Array.isArray(s.charts.costByMonth.labels));
    assert.ok(Array.isArray(s.charts.costByFuelType.labels));
    assert.ok(s.charts.costByFuelType.labels.includes('Gazole'));
    assert.ok(s.budget && typeof s.budget.spent === 'number');
});

test('Statistiques : données insuffisantes -> aucune valeur inventée (org B vierge)', async () => {
    const stats = await api('GET', '/api/fuel-logs/stats?period=month', { token: adminTokenB });
    assert.equal(stats.status, 200);
    assert.equal(stats.data.kpi.count.value, 0);
    assert.equal(stats.data.kpi.liters.value, 0);
    assert.equal(stats.data.kpi.cost.value, 0);
    assert.equal(stats.data.kpi.avgConsumption.value, null);
    assert.equal(stats.data.kpi.costPerKm.value, null);
    assert.equal(stats.data.kpi.liters.pct, null, 'pas de tendance sans période précédente');
    assert.deepEqual(stats.data.anomalies, []);
});

test('Filtres : période personnalisée et mois précédent', async () => {
    // Le mois précédent est vide pour l'organisation A.
    const prev = await api('GET', '/api/fuel-logs/stats?period=prevMonth', { token: adminTokenA });
    assert.equal(prev.status, 200);
    assert.equal(prev.data.kpi.count.value, 0);
    // La comparaison du mois courant vs mois précédent doit donc être nulle.
    const current = await api('GET', '/api/fuel-logs/stats?period=month', { token: adminTokenA });
    assert.equal(current.data.kpi.count.pct, null);

    // Période personnalisée couvrant exactement les 2 pleins.
    const from = curMonthDay(1);
    const to = curMonthDay(lastDayOfCurrentMonth());
    const custom = await api('GET', `/api/fuel-logs/stats?period=custom&from=${from}&to=${to}`, { token: adminTokenA });
    assert.equal(custom.status, 200);
    assert.ok(custom.data.kpi.count.value >= 2, `pleins sur la période : ${custom.data.kpi.count.value}`);
});

test('Isolation multi-tenant : une organisation ne voit jamais les pleins de l\'autre', async () => {
    const listA = await api('GET', '/api/fuel-logs', { token: adminTokenA });
    const listB = await api('GET', '/api/fuel-logs', { token: adminTokenB });
    assert.ok(listA.data.length >= 2);
    assert.equal(listB.data.length, 0, 'org B ne voit pas les pleins de org A');

    // Statistiques cloisonnées.
    const statsB = await api('GET', '/api/fuel-logs/stats?period=year', { token: adminTokenB });
    assert.equal(statsB.data.kpi.count.value, 0);

    // Accès direct à un plein de A via le token de B : 404.
    const target = listA.data[0];
    const cross = await api('GET', `/api/fuel-logs/${target.id}`, { token: adminTokenB });
    assert.equal(cross.status, 404);

    // Suppression croisée refusée.
    const crossDel = await api('DELETE', `/api/fuel-logs/${target.id}`, { token: adminTokenB });
    assert.equal(crossDel.status, 404);

    // Le plein existe toujours pour A.
    const stillThere = await api('GET', `/api/fuel-logs/${target.id}`, { token: adminTokenA });
    assert.equal(stillThere.status, 200);
});

test('Permissions : DRIVER peut saisir des pleins mais pas gérer les budgets', async () => {
    const username = unique('fuel_driver');
    const created = await api('POST', '/api/users', {
        token: adminTokenA,
        body: { username, password: 'secret123', name: 'Chauffeur Test', role: 'DRIVER' },
    });
    assert.equal(created.status, 201, `Création utilisateur échouée : ${JSON.stringify(created.data)}`);
    const driverToken = await login(username, 'secret123');

    // DRIVER : création d'un plein autorisée.
    const fill = await api('POST', '/api/fuel-logs', {
        token: driverToken,
        body: { vehicleId: vehicleAId, vehicle: 'Toyota Hilux', date: curMonthDay(10), mileage: 11000, liters: 50, pricePerLiter: 750 },
    });
    assert.equal(fill.status, 201, `Le DRIVER doit pouvoir saisir un plein : ${JSON.stringify(fill.data)}`);
    assert.equal(fill.data.cost, 37500);

    // DRIVER : budget refusé (403).
    const budget = await api('POST', '/api/fuel-logs/budgets', {
        token: driverToken,
        body: { month: curMonthKey(), amount: 100000 },
    });
    assert.equal(budget.status, 403, 'Le DRIVER ne doit pas configurer de budget');
});

test('Budget carburant : CRUD, upsert mensuel et suivi de l\'utilisation', async () => {
    const month = curMonthKey();
    const r = await api('POST', '/api/fuel-logs/budgets', {
        token: adminTokenA,
        body: { month, amount: 200000 },
    });
    assert.equal(r.status, 201, `Création budget échouée : ${JSON.stringify(r.data)}`);
    assert.equal(r.data.month, `${month}-01`);

    // Upsert : le même mois écrase le montant.
    const up = await api('POST', '/api/fuel-logs/budgets', {
        token: adminTokenA,
        body: { month, amount: 250000 },
    });
    assert.equal(up.status, 201);
    assert.equal(up.data.amount, 250000);

    const list = await api('GET', '/api/fuel-logs/budgets', { token: adminTokenA });
    assert.equal(list.status, 200);
    assert.equal(list.data.length, 1);

    // PUT du budget.
    const put = await api('PUT', `/api/fuel-logs/budgets/${list.data[0].id}`, {
        token: adminTokenA,
        body: { amount: 300000 },
    });
    assert.equal(put.status, 200);
    assert.equal(put.data.amount, 300000);

    // Le budget apparaît dans les stats.
    const stats = await api('GET', '/api/fuel-logs/stats?period=month', { token: adminTokenA });
    assert.equal(stats.data.budget.hasBudget, true);
    assert.equal(stats.data.budget.amount, 300000);
    assert.ok(stats.data.budget.spent > 0);
    assert.ok(stats.data.budget.utilization != null && stats.data.budget.utilization < 100);
    assert.ok(stats.data.budgetList.length >= 1);

    // Budget invalide : 400.
    const badMonth = await api('POST', '/api/fuel-logs/budgets', { token: adminTokenA, body: { month: 'août', amount: 1000 } });
    assert.equal(badMonth.status, 400);
    const badAmount = await api('POST', '/api/fuel-logs/budgets', { token: adminTokenA, body: { month, amount: -5 } });
    assert.equal(badAmount.status, 400);

    // Suppression.
    const del = await api('DELETE', `/api/fuel-logs/budgets/${list.data[0].id}`, { token: adminTokenA });
    assert.equal(del.status, 204);
});

test('Valeurs invalides : litres à zéro, dates et kilométrage incorrects refusés', async () => {
    const base = { vehicleId: vehicleAId, vehicle: 'Toyota Hilux', date: curMonthDay(20) };

    const zeroLiters = await api('POST', '/api/fuel-logs', { token: adminTokenA, body: { ...base, liters: 0, cost: 0 } });
    assert.equal(zeroLiters.status, 400);

    const noCostNoPrice = await api('POST', '/api/fuel-logs', { token: adminTokenA, body: { ...base, liters: 30 } });
    assert.equal(noCostNoPrice.status, 400, 'ni cost ni pricePerLiter : refusé');

    const badDate = await api('POST', '/api/fuel-logs', { token: adminTokenA, body: { ...base, date: '01/08/2026', liters: 30, cost: 20000 } });
    assert.equal(badDate.status, 400);

    const negMileage = await api('POST', '/api/fuel-logs', { token: adminTokenA, body: { ...base, mileage: -10, liters: 30, cost: 20000 } });
    assert.equal(negMileage.status, 400);

    // Véhicule d'une autre organisation : refusé (protection multi-tenant).
    const crossVehicle = await api('POST', '/api/fuel-logs', {
        token: adminTokenB,
        body: { vehicleId: vehicleAId, vehicle: 'Toyota Hilux', date: curMonthDay(21), liters: 30, cost: 20000 },
    });
    assert.equal(crossVehicle.status, 404, 'véhicule étranger refusé');
});

test('Suppression d\'un plein : 204 puis introuvable', async () => {
    const list = await api('GET', '/api/fuel-logs', { token: adminTokenA });
    const target = list.data[0];
    const del = await api('DELETE', `/api/fuel-logs/${target.id}`, { token: adminTokenA });
    assert.equal(del.status, 204);
    const gone = await api('GET', `/api/fuel-logs/${target.id}`, { token: adminTokenA });
    assert.equal(gone.status, 404);
    const again = await api('DELETE', `/api/fuel-logs/${target.id}`, { token: adminTokenA });
    assert.equal(again.status, 404);
});

test('Route inconnue du module carburant : 404 propre', async () => {
    const r = await api('GET', '/api/fuel-logs/inexistant-route/extra', { token: adminTokenA });
    assert.equal(r.status, 404);
});
