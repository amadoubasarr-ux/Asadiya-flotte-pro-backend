// ============================================================
// Analytics — Fleet Health Score, Risk Score, classements,
// prévisions et statistiques plateforme (SuperAdmin).
//
// Toutes les fonctions "org" sont cloisonnées par organisation :
// la colonne organization_id est toujours imposée côté serveur.
// ============================================================
const { query } = require('./pool');
const { mapRow, mapRows } = require('./mappers');
const { config } = require('../config');
const AppError = require('../utils/AppError');

const MS_DAY = 86400000;
const REF_CONSUMPTION = 8;        // L/100km de référence (thermique)
const REF_COST_PER_KM = 45;       // FCFA/km de réparation cible

// ============================================================
// Utilitaires
// ============================================================

function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
}

function round1(v) {
    return Math.round(v * 10) / 10;
}

function sum(list, field) {
    return list.reduce((s, it) => s + (parseFloat(it[field]) || 0), 0);
}

function toDate(v) {
    if (!v) return null;
    let s = String(v).replace(' ', 'T');
    s = s.replace(/[+-](\d{2})$/, (m, hh) => (hh === '00' ? 'Z' : m + ':00'));
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
}

function today() {
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    return t;
}

function addDays(date, days) {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
}

// ============================================================
// Périodes (filtres de date)
// ============================================================

const PERIODS = ['month', 'quarter', 'year', 'all'];

function normalizePeriod(p) {
    return PERIODS.includes(p) ? p : 'all';
}

function periodRange(period) {
    const now = new Date();
    if (period === 'month') {
        return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: null };
    }
    if (period === 'quarter') {
        const q = Math.floor(now.getMonth() / 3);
        return { from: new Date(now.getFullYear(), q * 3, 1), to: null };
    }
    if (period === 'year') {
        return { from: new Date(now.getFullYear(), 0, 1), to: null };
    }
    return { from: null, to: null };
}

function prevPeriodRange(period) {
    const now = new Date();
    if (period === 'month') {
        return {
            from: new Date(now.getFullYear(), now.getMonth() - 1, 1),
            to: new Date(now.getFullYear(), now.getMonth(), 1),
        };
    }
    if (period === 'quarter') {
        const q = Math.floor(now.getMonth() / 3);
        const startOfQ = new Date(now.getFullYear(), q * 3, 1);
        return {
            from: new Date(startOfQ.getFullYear(), startOfQ.getMonth() - 3, 1),
            to: startOfQ,
        };
    }
    if (period === 'year') {
        return {
            from: new Date(now.getFullYear() - 1, 0, 1),
            to: new Date(now.getFullYear(), 0, 1),
        };
    }
    // 'all' → 30 derniers jours vs les 30 jours précédents
    const to = today();
    const from = addDays(to, -30);
    return { from: addDays(from, -30), to: from };
}

function inRange(date, from, to) {
    if (!date) return false;
    if (from && date < from) return false;
    if (to && date >= to) return false;
    return true;
}

function filterByRange(list, from, to) {
    return list.filter((it) => inRange(toDate(it.date), from, to));
}

// ============================================================
// Métriques véhicule
// ============================================================

function isElectric(v) {
    return String(v.fuel || '').toLowerCase().replace(/é/g, 'e') === 'electrique';
}

/**
 * Retard kilométrique de vidange (km restants).
 * Négatif = dépassé, Infinity = non applicable (électrique / seuil absent).
 */
function oilDelayKm(v) {
    if (isElectric(v)) return Infinity;
    const next = parseFloat(v.nextOilChangeKm) || 0;
    const mileage = parseFloat(v.mileage) || 0;
    if (next <= 0) return Infinity;
    return Math.round(next - mileage);
}

function documentStatus(dateStr) {
    if (!dateStr) return { status: 'UNKNOWN', daysLeft: null };
    const expiry = toDate(dateStr);
    if (!expiry) return { status: 'UNKNOWN', daysLeft: null };
    const daysLeft = Math.round((expiry - today()) / MS_DAY);
    if (daysLeft < 0) return { status: 'EXPIRED', daysLeft };
    if (daysLeft <= 30) return { status: 'SOON', daysLeft };
    return { status: 'OK', daysLeft };
}

function countBy(list, field, value) {
    return list.filter((it) => String(it[field] || '').toUpperCase() === value).length;
}

/** Kilomètres parcourus par véhicule (somme des écarts entre pleins successifs). */
function kmStats(fuelLogs) {
    const byVehicle = {};
    const sorted = [...fuelLogs]
        .filter((f) => !Number.isNaN(parseInt(f.mileage, 10)))
        .sort((a, b) => (toDate(a.date) || 0) - (toDate(b.date) || 0));
    let total = 0;
    const prev = {};
    sorted.forEach((f) => {
        const m = parseInt(f.mileage, 10);
        if (prev[f.vehicleId] !== undefined) {
            const delta = m - prev[f.vehicleId];
            if (delta > 0 && delta < 100000) {
                byVehicle[f.vehicleId] = (byVehicle[f.vehicleId] || 0) + delta;
                total += delta;
            }
        }
        prev[f.vehicleId] = m;
    });
    return { byVehicle, total };
}

/** Consommation moyenne (L/100km) d'un véhicule à partir des 2 derniers pleins exploitables. */
function vehicleConsumption(fuelLogs, vehicleId) {
    const logs = fuelLogs
        .filter((f) => f.vehicleId === vehicleId && !Number.isNaN(parseInt(f.mileage, 10)))
        .sort((a, b) => (toDate(a.date) || 0) - (toDate(b.date) || 0));
    if (logs.length < 2) return null;
    const last = logs[logs.length - 1];
    let prev = null;
    for (let i = logs.length - 2; i >= 0; i--) {
        if (parseInt(logs[i].mileage, 10) < parseInt(last.mileage, 10)) {
            prev = logs[i];
            break;
        }
    }
    if (!prev) return null;
    const distance = parseInt(last.mileage, 10) - parseInt(prev.mileage, 10);
    if (distance <= 0) return null;
    return (parseFloat(last.liters) / distance) * 100;
}

/** Consommation moyenne de la flotte (moyenne des consommations par véhicule). */
function fleetAvgConsumption(fuelLogs) {
    const ids = [...new Set(fuelLogs.map((f) => f.vehicleId))];
    const values = ids.map((id) => vehicleConsumption(fuelLogs, id)).filter((v) => v != null);
    if (!values.length) return null;
    return values.reduce((s, v) => s + v, 0) / values.length;
}

/** Estimation des km parcourus par jour (fallback 50). */
function kmPerDay(fuelLogs, vehicleId) {
    const logs = fuelLogs
        .filter((f) => f.vehicleId === vehicleId && !Number.isNaN(parseInt(f.mileage, 10)))
        .sort((a, b) => (toDate(a.date) || 0) - (toDate(b.date) || 0));
    if (logs.length < 2) return 50;
    const last = logs[logs.length - 1];
    let prev = null;
    for (let i = logs.length - 2; i >= 0; i--) {
        if (parseInt(logs[i].mileage, 10) < parseInt(last.mileage, 10)) {
            prev = logs[i];
            break;
        }
    }
    if (!prev) return 50;
    const days = Math.max(1, Math.round(((toDate(last.date) || 0) - (toDate(prev.date) || 0)) / MS_DAY));
    const km = parseInt(last.mileage, 10) - parseInt(prev.mileage, 10);
    if (km <= 0) return 50;
    return km / days;
}

// ============================================================
// Scores
// ============================================================

function riskGrade(score) {
    return score >= 70 ? 'ÉLEVÉ' : score >= 40 ? 'MOYEN' : 'FAIBLE';
}

/**
 * Risk Score d'un véhicule (0-100, plus haut = plus risqué).
 * Context attendu : { incidents, accidents } filtrés par période.
 */
function vehicleRiskScore(v, ctx) {
    let risk = 0;
    if (v.status === 'IN_MAINTENANCE') risk += 30;
    else if (v.status === 'BOOKED') risk += 5;

    const delay = oilDelayKm(v);
    if (delay < 0) risk += 25;
    else if (delay <= 1500) risk += 15;
    else if (delay <= 3000) risk += 8;

    ['insuranceExpiry', 'registrationExpiry', 'technicalControlExpiry'].forEach((key) => {
        const s = documentStatus(v[key]);
        if (s.status === 'EXPIRED') risk += 8;
        else if (s.status === 'SOON') risk += 4;
    });

    risk += Math.min(15, (ctx.incidents || []).filter((i) => i.vehicleId === v.id).length * 5);
    risk += Math.min(30, (ctx.accidents || []).filter((a) => a.vehicleId === v.id).length * 10);

    const age = new Date().getFullYear() - (parseInt(v.year, 10) || new Date().getFullYear());
    if (age >= 10) risk += 8;
    else if (age >= 8) risk += 5;
    else if (age >= 6) risk += 3;

    return Math.round(clamp(risk, 0, 100));
}

/** Health Score d'un véhicule (0-100, plus haut = plus sain). */
function vehicleHealthScore(v, ctx) {
    const avail = v.status === 'IN_MAINTENANCE' ? 0 : 100;

    const delay = oilDelayKm(v);
    const maint = delay < 0 ? 0 : delay <= 1500 ? 50 : delay <= 3000 ? 75 : 100;

    let docScore = 100;
    ['insuranceExpiry', 'registrationExpiry', 'technicalControlExpiry'].forEach((key) => {
        const s = documentStatus(v[key]);
        if (s.status === 'EXPIRED') docScore -= 34;
        else if (s.status === 'SOON') docScore -= 17;
    });
    docScore = clamp(docScore, 0, 100);

    const inc = (ctx.incidents || []).filter((i) => i.vehicleId === v.id).length;
    const acc = (ctx.accidents || []).filter((a) => a.vehicleId === v.id).length;
    const incScore = clamp(100 - inc * 20, 0, 100);
    const accScore = clamp(100 - acc * 50, 0, 100);

    const cons = vehicleConsumption(ctx.fuelLogs || [], v.id);
    const consScore = cons == null ? 75 : clamp((REF_CONSUMPTION / cons) * 100, 0, 100);

    const maintCost = sum((ctx.maintenances || []).filter((m) => m.vehicleId === v.id), 'cost');
    const km = (ctx.kmByVehicle && ctx.kmByVehicle[v.id]) || 0;
    const cpm = km > 0 ? maintCost / km : null;
    const costScore = cpm == null ? 75 : clamp((REF_COST_PER_KM / cpm) * 100, 0, 100);

    return Math.round(
        avail * 0.25 + maint * 0.15 + docScore * 0.15 + incScore * 0.10 + accScore * 0.15 + consScore * 0.10 + costScore * 0.10
    );
}

/**
 * Fleet Health Score global (0-100) : moyenne pondérée de 7 sous-scores.
 */
function computeFleetHealthScore({ vehicles, maintenances, incidents, accidents, fuelLogs, kmByVehicle }) {
    const total = vehicles.length;
    if (!total) return { total: 0, grade: 'Aucun véhicule', components: [] };

    const inMaintenance = vehicles.filter((v) => v.status === 'IN_MAINTENANCE').length;
    const availabilityPct = (total - inMaintenance) / total;

    const overdue = vehicles.filter((v) => oilDelayKm(v) < 0).length;
    const maintenancePct = (total - overdue) / total;

    const incidentsScore = clamp(100 - incidents.length * 8, 0, 100);
    const accidentsScore = clamp(100 - accidents.length * 20, 0, 100);

    const cons = fleetAvgConsumption(fuelLogs);
    const consScore = cons == null ? 75 : clamp((REF_CONSUMPTION / cons) * 100, 0, 100);

    const maintCost = sum(maintenances, 'cost');
    const km = kmByVehicle ? kmByVehicle.total || 0 : 0;
    const costPerKm = km > 0 ? maintCost / km : null;
    const costScore = costPerKm == null ? 75 : clamp((REF_COST_PER_KM / costPerKm) * 100, 0, 100);

    const immoScore = clamp(100 - (inMaintenance / total) * 500, 0, 100);

    const components = [
        { key: 'availability', label: 'Disponibilité', weight: 0.20, score: Math.round(availabilityPct * 100) },
        { key: 'maintenance', label: 'Maintenance à jour', weight: 0.15, score: Math.round(maintenancePct * 100) },
        { key: 'incidents', label: 'Incidents', weight: 0.10, score: Math.round(incidentsScore) },
        { key: 'accidents', label: 'Accidents', weight: 0.20, score: Math.round(accidentsScore) },
        { key: 'consumption', label: 'Consommation carburant', weight: 0.10, score: Math.round(consScore) },
        { key: 'repairCost', label: 'Coût des réparations', weight: 0.10, score: Math.round(costScore) },
        { key: 'immobilization', label: 'Immobilisation', weight: 0.15, score: Math.round(immoScore) },
    ].map((c) => ({ ...c, points: Math.round(c.score * c.weight) }));

    const healthTotal = components.reduce((s, c) => s + c.points, 0);
    const grade = healthTotal >= 85 ? 'Excellent' : healthTotal >= 70 ? 'Bon' : healthTotal >= 50 ? 'Moyen' : 'Critique';
    return { total: healthTotal, grade, components };
}

/** Score conducteur (0-100, plus haut = meilleur). */
function driverScore(d, incidents, accidents, reservations) {
    const inc = incidents.filter((i) => i.driverId === d.id).length;
    const acc = accidents.filter((a) => a.driverId === d.id).length;
    const missions = reservations.filter((r) => r.driverId === d.id && r.status === 'APPROVED').length;
    const lic = documentStatus(d.licenseExpiry);
    const licensePenalty = lic.status === 'EXPIRED' ? 20 : lic.status === 'SOON' ? 10 : 0;
    const risk = inc * 15 + acc * 40 + licensePenalty;
    const score = clamp(100 - inc * 15 - acc * 40 - licensePenalty + Math.min(5, missions * 0.5), 0, 100);
    return { inc, acc, missions, licenseStatus: lic.status, licenseDaysLeft: lic.daysLeft, risk, score };
}

// ============================================================
// Séries pour graphiques
// ============================================================

function costsByMonth(maintenances, fuelLogs) {
    const monthNames = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc'];
    const labels = [];
    const fuel = [];
    const maintenance = [];
    const idx = {};
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
        labels.push(monthNames[d.getMonth()] + ' ' + String(d.getFullYear()).slice(2));
        fuel.push(0);
        maintenance.push(0);
        idx[key] = 11 - i;
    }
    maintenances.forEach((m) => {
        const d = toDate(m.date);
        if (!d) return;
        const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
        if (idx[key] !== undefined) maintenance[idx[key]] += parseFloat(m.cost) || 0;
    });
    fuelLogs.forEach((f) => {
        const d = toDate(f.date);
        if (!d) return;
        const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
        if (idx[key] !== undefined) fuel[idx[key]] += parseFloat(f.cost) || 0;
    });
    return { labels, fuel, maintenance };
}

function topConsumption(fuelLogs, n = 5) {
    const totals = {};
    fuelLogs.forEach((f) => {
        const liters = parseFloat(f.liters) || 0;
        const key = f.vehicle || 'Véhicule inconnu';
        totals[key] = (totals[key] || 0) + liters;
    });
    const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, n);
    return { labels: sorted.map((e) => e[0]), data: sorted.map((e) => round1(e[1])) };
}

function monthlySeries(rows, n = 12, mapper) {
    const monthNames = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc'];
    const labels = [];
    const data = [];
    const idx = {};
    const now = new Date();
    for (let i = n - 1; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
        labels.push(monthNames[d.getMonth()] + ' ' + String(d.getFullYear()).slice(2));
        data.push(0);
        idx[key] = n - 1 - i;
    }
    rows.forEach((r) => {
        const d = toDate(r.date);
        if (!d) return;
        const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
        if (idx[key] !== undefined) data[idx[key]] += mapper(r);
    });
    return { labels, data };
}

// ============================================================
// Prévisions
// ============================================================

function computeForecast({ maintenances, fuelLogs, vehicles, incidents }) {
    const costs = costsByMonth(maintenances, fuelLogs);
    const last3 = costs.maintenance.slice(-3).map((m, i) => m + costs.fuel[i]);
    const withData = last3.filter((v) => v > 0);
    const base = withData.length ? withData.reduce((s, v) => s + v, 0) / withData.length : 0;
    const monthFactor = 30 / 30.44;
    const costNext30d = Math.round(base * monthFactor);
    const costNext30dMin = Math.round(costNext30d * 0.85);
    const costNext30dMax = Math.round(costNext30d * 1.15);

    const cutoff90 = addDays(today(), -90);
    const likelyBreakdown = vehicles
        .map((v) => {
            const delay = oilDelayKm(v);
            const recentInc = incidents.filter((i) => i.vehicleId === v.id && toDate(i.date) && toDate(i.date) >= cutoff90).length;
            let propensity = 0;
            if (delay < 0) propensity += 40;
            else if (delay <= 1500) propensity += 25;
            else if (delay <= 3000) propensity += 12;
            propensity += recentInc * 15;
            if (v.status === 'IN_MAINTENANCE') propensity += 10;
            const kpd = kmPerDay(fuelLogs, v.id);
            return {
                vehicleId: v.id,
                label: `${v.brand} ${v.model} (${v.plate})`,
                propensity: Math.min(95, Math.round(propensity)),
                daysToMaintenance: delay > 0 && delay !== Infinity ? Math.round(delay / Math.max(1, kpd)) : null,
                delayKm: delay === Infinity ? null : delay,
            };
        })
        .filter((x) => x.propensity >= 30)
        .sort((a, b) => b.propensity - a.propensity)
        .slice(0, 3);

    const due30 = addDays(today(), 30);
    const dueMaintenances30d = maintenances
        .filter((m) => {
            const st = String(m.status || '').toUpperCase().replace(/É/g, 'E');
            const d = toDate(m.date);
            return (st === 'PLANIFIE' || st === 'URGENT') && d && d >= today() && d <= due30;
        })
        .sort((a, b) => (toDate(a.date) || 0) - (toDate(b.date) || 0))
        .map((m) => ({
            vehicleId: m.vehicleId,
            label: m.vehicle || `Véhicule #${m.vehicleId}`,
            type: m.type,
            date: m.date,
            status: m.status,
            cost: parseFloat(m.cost) || 0,
        }));

    return { costNext30d, costNext30dMin, costNext30dMax, likelyBreakdown, dueMaintenances30d };
}

// ============================================================
// Alertes intelligentes
// ============================================================

const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 };

function buildAlerts({ vehicles, drivers, incidents, accidents }) {
    const alerts = [];
    const push = (severity, category, title, message, entityType, entityId) => {
        alerts.push({ severity, category, title, message, entityType, entityId });
    };

    vehicles.forEach((v) => {
        const label = `${v.brand} ${v.model} (${v.plate})`;
        const delay = oilDelayKm(v);
        if (delay < 0) {
            push('critical', 'maintenance', 'Vidange dépassée', `${label} : ${Math.abs(delay).toLocaleString('fr-FR')} km de retard.`, 'vehicle', v.id);
        } else if (delay <= 1500) {
            push('warning', 'maintenance', 'Vidange imminente', `${label} : ${delay.toLocaleString('fr-FR')} km restants.`, 'vehicle', v.id);
        }
        const docs = [
            ['Assurance', v.insuranceExpiry],
            ['Carte grise', v.registrationExpiry],
            ['Contrôle technique', v.technicalControlExpiry],
        ];
        docs.forEach(([docLabel, date]) => {
            const s = documentStatus(date);
            if (s.status === 'EXPIRED') {
                push('critical', 'documents', `${docLabel} expiré(e)`, `${label} : expiré depuis ${Math.abs(s.daysLeft)} j.`, 'vehicle', v.id);
            } else if (s.status === 'SOON') {
                push('warning', 'documents', `${docLabel} expire bientôt`, `${label} : expire dans ${s.daysLeft} j.`, 'vehicle', v.id);
            }
        });
    });

    drivers.forEach((d) => {
        const s = documentStatus(d.licenseExpiry);
        if (s.status === 'EXPIRED') {
            push('critical', 'drivers', 'Permis de conduire expiré', `${d.name} : expiré depuis ${Math.abs(s.daysLeft)} j.`, 'driver', d.id);
        } else if (s.status === 'SOON') {
            push('warning', 'drivers', 'Permis expire bientôt', `${d.name} : expire dans ${s.daysLeft} j.`, 'driver', d.id);
        }
    });

    incidents.forEach((i) => {
        if (String(i.status || '').toUpperCase() === 'OUVERT') {
            push('warning', 'incidents', 'Signalement non traité', `${i.title} (${i.vehicle || 'Véhicule #' + i.vehicleId}).`, 'incident', i.id);
        }
    });

    accidents.forEach((a) => {
        if (String(a.status || '').toUpperCase().replace(/É/g, 'E') === 'DECLARE') {
            push('warning', 'accidents', 'Accident non clôturé', `${a.vehicle || 'Véhicule #' + a.vehicleId} : dossier encore "Déclaré".`, 'accident', a.id);
        }
    });

    alerts.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
    return alerts.slice(0, 20);
}

// ============================================================
// Classements
// ============================================================

function computeRankings({ vehicles, drivers, maintenances, incidents, accidents, fuelLogs, reservations, periodMaintenances, periodIncidents, periodAccidents, periodFuelLogs, kmByVehicle, ctx }) {
    const vehicleLabel = (v) => `${v.brand} ${v.model} (${v.plate})`;

    const vehicleCost = vehicles.map((v) => {
        const maintenance = sum(periodMaintenances.filter((m) => m.vehicleId === v.id), 'cost');
        const fuel = sum(periodFuelLogs.filter((f) => f.vehicleId === v.id), 'cost');
        const accidentsCost = sum(periodAccidents.filter((a) => a.vehicleId === v.id), 'costEstimate');
        return {
            vehicleId: v.id,
            label: vehicleLabel(v),
            totalCost: Math.round(maintenance + fuel + accidentsCost),
            maintenance: Math.round(maintenance),
            fuel: Math.round(fuel),
            accidents: Math.round(accidentsCost),
        };
    });

    const bestVehicles = vehicles
        .map((v) => {
            const cost = vehicleCost.find((c) => c.vehicleId === v.id);
            return {
                vehicleId: v.id,
                label: vehicleLabel(v),
                health: vehicleHealthScore(v, ctx),
                risk: vehicleRiskScore(v, ctx),
                costPerKm: cost && cost.totalCost > 0 && kmByVehicle[v.id]
                    ? Math.round(cost.totalCost / kmByVehicle[v.id])
                    : null,
            };
        })
        .sort((a, b) => b.health - a.health)
        .slice(0, 5);

    const mostExpensive = [...vehicleCost].sort((a, b) => b.totalCost - a.totalCost).slice(0, 5);

    const mostReliable = vehicles
        .map((v) => {
            const km = kmByVehicle[v.id] || parseFloat(v.mileage) || 0;
            const inc = periodIncidents.filter((i) => i.vehicleId === v.id).length;
            const acc = periodAccidents.filter((a) => a.vehicleId === v.id).length;
            return {
                vehicleId: v.id,
                label: vehicleLabel(v),
                km: Math.round(km),
                incidents: inc,
                accidents: acc,
                reliability: km > 0 ? Math.round(km / Math.max(1, inc + acc)) : 0,
            };
        })
        .filter((x) => x.km > 0)
        .sort((a, b) => b.reliability - a.reliability)
        .slice(0, 5);

    const mostCritical = vehicles
        .map((v) => ({ vehicleId: v.id, label: vehicleLabel(v), risk: vehicleRiskScore(v, ctx) }))
        .sort((a, b) => b.risk - a.risk)
        .slice(0, 5);

    const driverStats = drivers.map((d) => ({ driverId: d.id, name: d.name, ...driverScore(d, incidents, accidents, reservations) }));
    const bestDrivers = [...driverStats].sort((a, b) => b.score - a.score).slice(0, 5);
    const riskiestDrivers = [...driverStats].sort((a, b) => b.risk - a.risk).slice(0, 5);

    return { bestVehicles, mostExpensive, mostReliable, mostCritical, bestDrivers, riskiestDrivers };
}

// ============================================================
// Données d'une organisation
// ============================================================

async function loadOrgData(orgId) {
    const [vehicles, drivers, maintenances, incidents, accidents, fuelLogs, reservations] = await Promise.all([
        query('SELECT * FROM vehicles WHERE organization_id = $1 ORDER BY id', [orgId]),
        query('SELECT * FROM drivers WHERE organization_id = $1 ORDER BY id', [orgId]),
        query('SELECT * FROM maintenances WHERE organization_id = $1 ORDER BY date', [orgId]),
        query('SELECT * FROM incidents WHERE organization_id = $1 ORDER BY date', [orgId]),
        query('SELECT * FROM accidents WHERE organization_id = $1 ORDER BY date', [orgId]),
        query('SELECT * FROM fuel_logs WHERE organization_id = $1 ORDER BY date', [orgId]),
        query('SELECT * FROM reservations WHERE organization_id = $1 ORDER BY start', [orgId]),
    ]);
    return {
        vehicles: mapRows(vehicles.rows),
        drivers: mapRows(drivers.rows),
        maintenances: mapRows(maintenances.rows),
        incidents: mapRows(incidents.rows),
        accidents: mapRows(accidents.rows),
        fuelLogs: mapRows(fuelLogs.rows),
        reservations: mapRows(reservations.rows),
    };
}

// ============================================================
// Vue d'ensemble (Fleet Health Score + KPIs + graphiques + prévisions + classements)
// ============================================================

async function getOverview(orgId, rawPeriod) {
    const period = normalizePeriod(rawPeriod);
    const data = await loadOrgData(orgId);
    const { vehicles, drivers, maintenances, incidents, accidents, fuelLogs, reservations } = data;

    const range = periodRange(period);
    const { from, to } = range;

    const periodMaintenances = filterByRange(maintenances, from, to);
    const periodIncidents = filterByRange(incidents, from, to);
    const periodAccidents = filterByRange(accidents, from, to);
    const periodFuelLogs = filterByRange(fuelLogs, from, to);

    const km = kmStats(periodFuelLogs);
    const ctx = {
        maintenances: periodMaintenances,
        incidents: periodIncidents,
        accidents: periodAccidents,
        fuelLogs: periodFuelLogs,
        kmByVehicle: km.byVehicle,
    };

    // ---- Fleet Health Score (actuel + précédent pour la tendance) ----
    const health = computeFleetHealthScore({
        vehicles,
        maintenances: periodMaintenances,
        incidents: periodIncidents,
        accidents: periodAccidents,
        fuelLogs: periodFuelLogs,
        kmByVehicle: km.byVehicle,
    });

    const prevRange = prevPeriodRange(period);
    const prevHealth = computeFleetHealthScore({
        vehicles,
        maintenances: filterByRange(maintenances, prevRange.from, prevRange.to),
        incidents: filterByRange(incidents, prevRange.from, prevRange.to),
        accidents: filterByRange(accidents, prevRange.from, prevRange.to),
        fuelLogs: filterByRange(fuelLogs, prevRange.from, prevRange.to),
        kmByVehicle: kmStats(filterByRange(fuelLogs, prevRange.from, prevRange.to)).byVehicle,
    });

    // ---- KPIs ----
    const total = vehicles.length;
    const availableCount = vehicles.filter((v) => v.status === 'AVAILABLE').length;
    const bookedCount = vehicles.filter((v) => v.status === 'BOOKED').length;
    const maintenanceCount = vehicles.filter((v) => v.status === 'IN_MAINTENANCE').length;

    const fuelCost = sum(periodFuelLogs, 'cost');
    const fuelLiters = sum(periodFuelLogs, 'liters');
    const maintenanceCost = sum(periodMaintenances, 'cost');
    const accidentCost = sum(periodAccidents, 'costEstimate');
    const totalCost = Math.round(fuelCost + maintenanceCost + accidentCost);

    const avgConsumption = fleetAvgConsumption(periodFuelLogs);
    const avgFuelPricePerLiter = fuelLiters > 0 ? Math.round(fuelCost / fuelLiters) : 0;

    const riskScores = vehicles.map((v) => vehicleRiskScore(v, ctx));
    const riskAverage = riskScores.length ? Math.round(riskScores.reduce((s, r) => s + r, 0) / riskScores.length) : 0;

    const oilChangeAlerts = vehicles.filter((v) => !isElectric(v) && oilDelayKm(v) <= 1500).length;
    const maintenanceOverdue = vehicles.filter((v) => oilDelayKm(v) < 0).length;

    const todayStart = today();
    const tomorrow = addDays(todayStart, 1);
    const missionsToday = reservations.filter((r) => {
        const s = toDate(r.start);
        return s && s >= todayStart && s < addDays(todayStart, 1);
    }).length;
    const pendingReservations = reservations.filter((r) => r.status === 'PENDING').length;

    const co2Kg = fuelLiters > 0 ? Math.round(fuelLiters * 2.39) : 0;

    // ---- Graphiques ----
    const costs = costsByMonth(maintenances, fuelLogs);
    const fleetStatus = { available: availableCount, booked: bookedCount, maintenance: maintenanceCount };
    const incidentPriority = {
        high: countBy(periodIncidents, 'priority', 'HAUTE'),
        medium: countBy(periodIncidents, 'priority', 'MOYENNE'),
        low: countBy(periodIncidents, 'priority', 'BASSE'),
    };
    const accidentStatus = {
        declared: countBy(periodAccidents, 'status', 'DECLARÉ'),
        insurance: countBy(periodAccidents, 'status', 'ASSURANCE'),
        repaired: countBy(periodAccidents, 'status', 'RÉPARÉ'),
    };
    const consumptionTop = topConsumption(periodFuelLogs, 5);
    const maintenanceByMonth = monthlySeries(periodMaintenances, 12, (m) => (parseFloat(m.cost) || 0));
    const incidentsByMonth = monthlySeries(periodIncidents, 12, () => 1);
    const accidentsByMonth = monthlySeries(periodAccidents, 12, () => 1);

    // ---- Prévisions ----
    const forecast = computeForecast({ maintenances, fuelLogs, vehicles, incidents });

    // ---- Classements ----
    const rankings = computeRankings({
        vehicles,
        drivers,
        maintenances,
        incidents,
        accidents,
        fuelLogs,
        reservations,
        periodMaintenances,
        periodIncidents,
        periodAccidents,
        periodFuelLogs,
        kmByVehicle: km.byVehicle,
        ctx,
    });

    // ---- Alertes ----
    const alerts = buildAlerts({ vehicles, drivers, incidents, accidents });

    return {
        period,
        generatedAt: new Date().toISOString(),
        fleetHealthScore: {
            total: health.total,
            grade: health.grade,
            delta: health.total - prevHealth.total,
            components: health.components,
        },
        kpi: {
            totalVehicles: total,
            availableCount,
            bookedCount,
            maintenanceCount,
            availabilityRate: total ? round1(((total - maintenanceCount) / total) * 100) : 0,
            immobilizationRate: total ? round1((maintenanceCount / total) * 100) : 0,
            fuelCost: Math.round(fuelCost),
            fuelLiters: round1(fuelLiters),
            maintenanceCost: Math.round(maintenanceCost),
            accidentCost: Math.round(accidentCost),
            totalCost,
            avgConsumption: avgConsumption == null ? null : round1(avgConsumption),
            avgFuelPricePerLiter,
            totalKm: Math.round(km.total),
            totalIncidents: periodIncidents.length,
            totalAccidents: periodAccidents.length,
            riskAverage,
            oilChangeAlerts,
            maintenanceOverdue,
            co2Kg,
            missionsToday,
            pendingReservations,
        },
        charts: {
            costsByMonth: costs,
            fleetStatus,
            incidentPriority,
            accidentStatus,
            consumptionTop,
            maintenanceByMonth,
            incidentsByMonth,
            accidentsByMonth,
        },
        forecast,
        rankings,
        alerts,
    };
}

// ============================================================
// Fiche analytique d'un véhicule (Risk Score + santé + finances)
// ============================================================

async function getVehicleAnalytics(orgId, vehicleId) {
    const data = await loadOrgData(orgId);
    const vehicle = data.vehicles.find((v) => v.id === vehicleId);
    if (!vehicle) throw AppError.notFound('Véhicule introuvable.');

    const km = kmStats(data.fuelLogs);
    const ctx = {
        maintenances: data.maintenances,
        incidents: data.incidents,
        accidents: data.accidents,
        fuelLogs: data.fuelLogs,
        kmByVehicle: km.byVehicle,
    };

    const maint = data.maintenances.filter((m) => m.vehicleId === vehicleId);
    const fuel = data.fuelLogs.filter((f) => f.vehicleId === vehicleId);
    const inc = data.incidents.filter((i) => i.vehicleId === vehicleId);
    const acc = data.accidents.filter((a) => a.vehicleId === vehicleId);

    const maintenanceCost = sum(maint, 'cost');
    const fuelCost = sum(fuel, 'cost');
    const accidentsCost = sum(acc, 'costEstimate');
    const totalCost = maintenanceCost + fuelCost + accidentsCost;
    const vehicleKm = km.byVehicle[vehicleId] || 0;

    const risk = vehicleRiskScore(vehicle, ctx);
    const delay = oilDelayKm(vehicle);

    return {
        vehicle: {
            id: vehicle.id,
            plate: vehicle.plate,
            brand: vehicle.brand,
            model: vehicle.model,
            year: vehicle.year,
            fuel: vehicle.fuel,
            status: vehicle.status,
            mileage: vehicle.mileage,
            driver: vehicle.driver,
        },
        risk: { score: risk, grade: riskGrade(risk) },
        health: vehicleHealthScore(vehicle, ctx),
        oil: {
            delayKm: delay === Infinity ? null : delay,
            nextOilChangeKm: vehicle.nextOilChangeKm,
            mileage: vehicle.mileage,
        },
        documents: {
            insurance: documentStatus(vehicle.insuranceExpiry),
            registration: documentStatus(vehicle.registrationExpiry),
            technicalControl: documentStatus(vehicle.technicalControlExpiry),
        },
        financial: {
            maintenance: Math.round(maintenanceCost),
            fuel: Math.round(fuelCost),
            accidents: Math.round(accidentsCost),
            total: Math.round(totalCost),
            costPerKm: vehicleKm > 0 ? Math.round(totalCost / vehicleKm) : null,
        },
        performance: {
            km: Math.round(vehicleKm),
            consumption: vehicleConsumption(data.fuelLogs, vehicleId),
            kmPerDay: kmPerDay(data.fuelLogs, vehicleId),
        },
        counts: { maintenances: maint.length, fuelLogs: fuel.length, incidents: inc.length, accidents: acc.length },
        maintenances: maint.slice(-5),
        incidents: inc.slice(-5),
        accidents: acc.slice(-5),
    };
}

// ============================================================
// Conducteurs (scores + classements complets)
// ============================================================

async function getDriverAnalytics(orgId) {
    const data = await loadOrgData(orgId);
    const list = data.drivers.map((d) => ({
        driverId: d.id,
        name: d.name,
        email: d.email,
        status: d.status,
        license: d.license,
        licenseExpiry: d.licenseExpiry,
        ...driverScore(d, data.incidents, data.accidents, data.reservations),
    }));
    return {
        drivers: list,
        bestDrivers: [...list].sort((a, b) => b.score - a.score).slice(0, 5),
        riskiestDrivers: [...list].sort((a, b) => b.risk - a.risk).slice(0, 5),
    };
}

// ============================================================
// Stats plateforme (SuperAdmin)
// ============================================================

function orgGrowthByMonth(organizations) {
    return monthlySeries(
        organizations.map((o) => ({ date: o.created_at })),
        12,
        () => 1
    );
}

function mrrByMonth(organizations, mrrPerOrg) {
    return monthlySeries(
        organizations.map((o) => ({ id: o.id, date: o.created_at })),
        12,
        (o) => mrrPerOrg[o.id] || 0
    );
}

async function computeOrgHealth(orgId) {
    const vehicles = mapRows((await query('SELECT * FROM vehicles WHERE organization_id = $1', [orgId])).rows);
    if (!vehicles.length) return null;
    const maintenances = mapRows((await query('SELECT cost, date, vehicle_id FROM maintenances WHERE organization_id = $1', [orgId])).rows);
    const incidents = mapRows((await query('SELECT id, date, vehicle_id FROM incidents WHERE organization_id = $1', [orgId])).rows);
    const accidents = mapRows((await query('SELECT id, date, vehicle_id FROM accidents WHERE organization_id = $1', [orgId])).rows);
    const fuelLogs = mapRows((await query('SELECT vehicle_id, liters, cost, date, mileage FROM fuel_logs WHERE organization_id = $1', [orgId])).rows);
    return computeFleetHealthScore({
        vehicles,
        maintenances,
        incidents,
        accidents,
        fuelLogs,
        kmByVehicle: kmStats(fuelLogs).byVehicle,
    });
}

async function getSuperAdminStats() {
    const [orgsRes, vehiclesRes, driversRes, usersRes, maintRes, incRes, accRes, fuelRes, subsRes, historyRes] = await Promise.all([
        query('SELECT id, name, created_at FROM organizations ORDER BY id'),
        query('SELECT id, organization_id FROM vehicles'),
        query('SELECT id, organization_id FROM drivers'),
        query('SELECT id, organization_id, role FROM users'),
        query('SELECT organization_id, cost, date FROM maintenances'),
        query('SELECT organization_id, date FROM incidents'),
        query('SELECT organization_id, cost_estimate, date FROM accidents'),
        query('SELECT organization_id, liters, cost, date FROM fuel_logs'),
        query(`
            SELECT s.organization_id, s.plan_id, s.plan AS plan_code, s.monthly_price,
                   s.status, s.start_date, s.end_date, s.trial_ends_at,
                   p.name AS plan_name, p.max_vehicles, p.max_users
            FROM subscriptions s
            LEFT JOIN plans p ON p.id = s.plan_id
            WHERE s.id = (
                SELECT MAX(s2.id) FROM subscriptions s2 WHERE s2.organization_id = s.organization_id
            )
        `),
        query(`
            SELECT h.id, h.organization_id, h.plan_code, h.plan_name, h.status,
                   h.change_type, h.reason, h.created_at,
                   o.name AS organization_name
            FROM subscription_history h
            LEFT JOIN organizations o ON o.id = h.organization_id
            ORDER BY h.id DESC
            LIMIT 20
        `),
    ]);

    const orgRows = orgsRes.rows;
    const vCount = {};
    const dCount = {};
    const uCount = {};
    const maintCost = {};
    const fuelCost = {};
    const accCost = {};
    let totalIncidents = 0;
    let totalAccidents = 0;
    let totalFuelLiters = 0;

    vehiclesRes.rows.forEach((r) => { vCount[r.organization_id] = (vCount[r.organization_id] || 0) + 1; });
    driversRes.rows.forEach((r) => { dCount[r.organization_id] = (dCount[r.organization_id] || 0) + 1; });
    usersRes.rows.forEach((r) => { if (r.role !== 'SUPERADMIN') uCount[r.organization_id] = (uCount[r.organization_id] || 0) + 1; });
    maintRes.rows.forEach((r) => { if (r.cost) maintCost[r.organization_id] = (maintCost[r.organization_id] || 0) + parseFloat(r.cost); });
    fuelRes.rows.forEach((r) => {
        if (r.cost) fuelCost[r.organization_id] = (fuelCost[r.organization_id] || 0) + parseFloat(r.cost);
        if (r.liters) totalFuelLiters += parseFloat(r.liters);
    });
    accRes.rows.forEach((r) => { if (r.cost_estimate) accCost[r.organization_id] = (accCost[r.organization_id] || 0) + parseFloat(r.cost_estimate); });
    totalIncidents = incRes.rowCount || 0;
    totalAccidents = accRes.rowCount || 0;

    const subs = mapRows(subsRes.rows);
    const subByOrg = {};
    subs.forEach((s) => {
        if (!subByOrg[s.organizationId]) subByOrg[s.organizationId] = s;
    });

    // Statut "effectif" (les abonnements échus comptent comme EXPIRED).
    const effectiveSubStatus = (sub) => {
        if (!sub) return 'NONE';
        const now = new Date();
        if (sub.status === 'TRIAL') {
            const trialEnd = toDate(sub.trialEndsAt);
            if (trialEnd && trialEnd < now) return 'TRIAL_EXPIRED';
            return 'TRIAL';
        }
        if (sub.status === 'ACTIVE') {
            const end = toDate(sub.endDate);
            if (end && end < now) return 'EXPIRED';
            return 'ACTIVE';
        }
        return sub.status;
    };

    // Répartition des clients par plan.
    const planDistribution = {};
    subs.forEach((s) => {
        const code = s.planCode || 'AUCUN';
        planDistribution[code] = (planDistribution[code] || 0) + 1;
    });

    // Revenu récurrent mensuel estimé : prix de l'abonnement explicite s'il existe
    // et est facturé (ACTIVE), sinon estimation = véhicules × prix par véhicule.
    const mrrPerOrg = {};
    let mrr = 0;
    orgRows.forEach((o) => {
        const sub = subByOrg[o.id];
        let price = 0;
        if (sub && effectiveSubStatus(sub) === 'ACTIVE' && parseFloat(sub.monthlyPrice) > 0) {
            price = parseFloat(sub.monthlyPrice);
        } else {
            price = (vCount[o.id] || 0) * config.platformPricePerVehicle;
        }
        mrrPerOrg[o.id] = price;
        mrr += price;
    });

    const now = new Date();
    const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const newOrganizationsThisMonth = orgRows.filter((o) => {
        const d = toDate(o.created_at);
        return d && d >= firstOfMonth;
    }).length;

    const totalMaintenanceCost = Object.values(maintCost).reduce((s, v) => s + v, 0);
    const totalFuelCost = Object.values(fuelCost).reduce((s, v) => s + v, 0);
    const totalAccidentCost = Object.values(accCost).reduce((s, v) => s + v, 0);

    // Tendance du MRR : nouveau revenu signé ce mois-ci (orgs créées ce mois)
    const baseMrr = orgRows
        .filter((o) => {
            const d = toDate(o.created_at);
            return d && d < firstOfMonth;
        })
        .reduce((s, o) => s + mrrPerOrg[o.id], 0);

    const organizations = orgRows.map((o) => {
        const vc = vCount[o.id] || 0;
        const sub = subByOrg[o.id];
        const status = effectiveSubStatus(sub);
        return {
            id: o.id,
            name: o.name,
            createdAt: o.created_at,
            vehicleCount: vc,
            driverCount: dCount[o.id] || 0,
            userCount: uCount[o.id] || 0,
            active: vc > 0,
            totalCost: Math.round((maintCost[o.id] || 0) + (fuelCost[o.id] || 0) + (accCost[o.id] || 0)),
            mrr: Math.round(mrrPerOrg[o.id]),
            subscription: sub
                ? {
                    planCode: sub.planCode,
                    planName: sub.planName,
                    status,
                    monthlyPrice: parseFloat(sub.monthlyPrice),
                    startDate: sub.startDate,
                    endDate: sub.endDate,
                    trialEndsAt: sub.trialEndsAt,
                    maxVehicles: sub.maxVehicles,
                    maxUsers: sub.maxUsers,
                }
                : null,
        };
    });

    // Santé de flotte par client (limitée aux 25 premiers pour rester léger)
    const healthByOrg = {};
    if (organizations.length <= 25) {
        for (const o of organizations) {
            const h = await computeOrgHealth(o.id);
            if (h) healthByOrg[o.id] = { total: h.total, grade: h.grade };
        }
    }

    // Répartition des clients par statut d'abonnement (statut effectif).
    const subStatusCounts = { ACTIVE: 0, TRIAL: 0, TRIAL_EXPIRED: 0, EXPIRED: 0, CANCELLED: 0, NONE: 0 };
    organizations.forEach((o) => {
        const st = o.subscription ? o.subscription.status : 'NONE';
        subStatusCounts[st] = (subStatusCounts[st] || 0) + 1;
    });

    return {
        generatedAt: new Date().toISOString(),
        kpi: {
            totalOrganizations: orgRows.length,
            activeOrganizations: organizations.filter((o) => o.active).length,
            newOrganizationsThisMonth,
            totalVehicles: vehiclesRes.rowCount || 0,
            totalDrivers: driversRes.rowCount || 0,
            totalUsers: Object.values(uCount).reduce((s, v) => s + v, 0),
            mrr: Math.round(mrr),
            mrrDelta: Math.round(mrr - baseMrr),
            totalMaintenanceCost: Math.round(totalMaintenanceCost),
            totalFuelCost: Math.round(totalFuelCost),
            totalAccidentCost: Math.round(totalAccidentCost),
            totalCost: Math.round(totalMaintenanceCost + totalFuelCost + totalAccidentCost),
            totalIncidents,
            totalAccidents,
            totalFuelLiters: round1(totalFuelLiters),
            co2Kg: Math.round(totalFuelLiters * 2.39),
            activeSubscriptions: subStatusCounts.ACTIVE,
            trialSubscriptions: subStatusCounts.TRIAL,
            expiredSubscriptions: subStatusCounts.EXPIRED + subStatusCounts.TRIAL_EXPIRED,
            cancelledSubscriptions: subStatusCounts.CANCELLED,
        },
        subscriptionHistory: mapRows(historyRes.rows),
        charts: {
            orgGrowth: orgGrowthByMonth(orgRows),
            mrrByMonth: mrrByMonth(orgRows, mrrPerOrg),
            fleetByOrg: {
                labels: organizations.map((o) => o.name).slice(0, 10),
                data: organizations.map((o) => o.vehicleCount).slice(0, 10),
            },
            planDistribution: Object.entries(planDistribution).map(([plan, count]) => ({ plan, count })),
        },
        organizations: organizations.map((o) => ({ ...o, health: healthByOrg[o.id] || null })),
    };
}

module.exports = {
    getOverview,
    getVehicleAnalytics,
    getDriverAnalytics,
    getSuperAdminStats,
    normalizePeriod,
    PERIODS,
};
