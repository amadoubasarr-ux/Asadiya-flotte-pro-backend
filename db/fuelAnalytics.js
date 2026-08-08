// ============================================================
// Analytics carburant (Phase 7.3) — module de gestion et d'analyse
// du carburant pour une flotte automobile.
//
// Toutes les fonctions "org" sont cloisonnées par organisation
// (column organization_id toujours imposée côté serveur).
// Les fonctions pures (calcul de consommation, anomalies, KPI)
// sont exportées pour être testées unitairement sans base.
// ============================================================
const { query } = require('./pool');
const { mapRows } = require('./mappers');
const { config } = require('../config');

const MS_DAY = 86400000;

// ============================================================
// Seuils de détection d'anomalies (documentés).
// Les valeurs sont configurables via les variables d'env FUEL_*,
// voir config.js → config.fuel.
// ============================================================
const DEFAULT_THRESHOLDS = {
    // Consommation (L/100km) jugée anormalement élevée :
    //  - en valeur absolue (un véhicule léger roulant à l'essence/gazole
    //    ne devrait pas dépasser cette valeur hors usage intense)
    //  - en facteur de la consommation moyenne du parc de la période
    highConsumptionMin: 15,
    highConsumptionFactor: 1.5,
    // Écart kilométrique (km) entre deux pleins d'un même véhicule :
    // au-delà, le relevé est considéré incohérent (oubli d'un plein,
    // erreur de saisie, véhicule de prêt...).
    maxMileageGap: 5000,
    // Volume (litres) hors des bornes "normales" d'un plein.
    maxLiters: 120,
    minLiters: 1,
    // Prix/litre (FCFA) jugé anormal : facteur du prix moyen de la période.
    abnormalPriceFactor: 1.3,
    // Deux pleins du même véhicule espacés de moins de N heures :
    // signalement possiblement redondant.
    closeFillsHours: 12,
    // Coût/km (FCFA) jugé anormal : en valeur absolue et en facteur de la
    // moyenne de la période.
    maxCostPerKm: 120,
    highCostPerKmFactor: 1.5,
};

// ============================================================
// Utilitaires dates
// ============================================================

function round1(v) {
    return Math.round(v * 10) / 10;
}

function round2(v) {
    return Math.round(v * 100) / 100;
}

function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
}

/**
 * Convertit une valeur de date en Date locale (milieu de journée).
 * Les dates "YYYY-MM-DD" (colonnes DATE PostgreSQL) sont interprétées en
 * heure LOCALE pour éviter les décalages d'un jour liés au fuseau horaire.
 */
function toDate(v) {
    if (!v) return null;
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
        const [y, m, d] = v.split('-').map(Number);
        const date = new Date(y, m - 1, d);
        return Number.isNaN(date.getTime()) ? null : date;
    }
    let s = String(v).replace(' ', 'T');
    s = s.replace(/[+-](\d{2})$/, (m, hh) => (hh === '00' ? 'Z' : m + ':00'));
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
}

function dayStart(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(date, days) {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
}

function isoDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
}

function monthRange(monthDate) {
    return {
        from: dayStart(monthDate),
        to: new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 1),
    };
}

// ============================================================
// Périodes (filtres globaux)
// ============================================================

const PERIOD_KEYS = ['today', 'week', 'month', 'prevMonth', 'year', 'custom'];

/**
 * Résout une période en bornes [from, to) et la période précédente de
 * durée équivalente (pour les comparaisons de KPI).
 * Périodes supportées : today, week, month, prevMonth, year, custom.
 */
function parsePeriod({ period = 'month', from, to } = {}) {
    const now = new Date();
    const today = dayStart(now);
    let range;
    let label = '';

    switch (period) {
        case 'today':
            range = { from: today, to: addDays(today, 1) };
            label = "Aujourd'hui";
            break;
        case 'week': {
            const start = dayStart(now);
            // Lundi = début de semaine (ISO).
            start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
            range = { from: start, to: addDays(start, 7) };
            label = 'Cette semaine';
            break;
        }
        case 'prevMonth':
            range = {
                from: new Date(now.getFullYear(), now.getMonth() - 1, 1),
                to: new Date(now.getFullYear(), now.getMonth(), 1),
            };
            label = 'Mois précédent';
            break;
        case 'year':
            range = { from: new Date(now.getFullYear(), 0, 1), to: new Date(now.getFullYear() + 1, 0, 1) };
            label = 'Cette année';
            break;
        case 'custom': {
            const f = from ? toDate(String(from).slice(0, 10)) : null;
            const t = to ? toDate(String(to).slice(0, 10)) : null;
            if (f && t && t >= f) {
                range = { from: f, to: addDays(t, 1) };
                label = 'Période personnalisée';
            } else {
                // Dates invalides ou inversées : repli sur le mois en cours.
                range = { from: new Date(now.getFullYear(), now.getMonth(), 1), to: new Date(now.getFullYear(), now.getMonth() + 1, 1) };
                label = 'Ce mois';
            }
            break;
        }
        case 'month':
        default:
            range = { from: new Date(now.getFullYear(), now.getMonth(), 1), to: new Date(now.getFullYear(), now.getMonth() + 1, 1) };
            label = 'Ce mois';
            break;
    }

    const duration = range.to.getTime() - range.from.getTime();
    return {
        ...range,
        prevFrom: new Date(range.from.getTime() - duration),
        prevTo: range.from,
        label,
        key: period,
    };
}

function inRange(log, from, to) {
    const d = toDate(log.date);
    if (!d) return false;
    const t = d.getTime();
    if (from && t < from.getTime()) return false;
    if (to && t >= to.getTime()) return false;
    return true;
}

// ============================================================
// Calcul de consommation & coût/km
// ============================================================

/**
 * Consommation (L/100km) et coût/km d'un plein, calculés à partir du plein
 * précédent du même véhicule. Retourne null lorsque le calcul est impossible
 * (kilométrage antérieur absent, distance nulle ou négative) — aucune valeur
 * n'est inventée.
 */
function computeLogMetrics(log, prevLog) {
    if (!prevLog) {
        return { consumption: null, costPerKm: null, distance: null };
    }
    const prevKm = parseInt(prevLog.mileage, 10);
    const curKm = parseInt(log.mileage, 10);
    if (Number.isNaN(prevKm) || Number.isNaN(curKm)) {
        return { consumption: null, costPerKm: null, distance: null };
    }
    const distance = curKm - prevKm;
    const liters = parseFloat(log.liters);
    const cost = parseFloat(log.cost);
    if (distance <= 0) {
        return { consumption: null, costPerKm: null, distance };
    }
    const consumption = !Number.isNaN(liters) && liters > 0 ? (liters / distance) * 100 : null;
    const costPerKm = !Number.isNaN(cost) && cost >= 0 ? cost / distance : null;
    return { consumption, costPerKm, distance };
}

/**
 * Rattache à chaque plein ses métriques calculées (consommation, coût/km,
 * distance parcourue depuis le plein précédent du même véhicule).
 */
function attachMetrics(logs) {
    const byVehicle = {};
    for (const l of logs || []) {
        const key = l.vehicleId != null ? String(l.vehicleId) : String(l.vehicle || '');
        if (!key) continue;
        (byVehicle[key] = byVehicle[key] || []).push(l);
    }
    const result = [];
    for (const key of Object.keys(byVehicle)) {
        const sorted = byVehicle[key].slice().sort((a, b) => {
            const da = toDate(a.date);
            const db = toDate(b.date);
            if ((da || 0) - (db || 0) !== 0) return (da || 0) - (db || 0);
            return (parseInt(a.mileage, 10) || 0) - (parseInt(b.mileage, 10) || 0);
        });
        let prev = null;
        for (const l of sorted) {
            const metrics = computeLogMetrics(l, prev);
            result.push({
                ...l,
                consumption: metrics.consumption,
                costPerKm: metrics.costPerKm,
                distance: metrics.distance,
                prevMileage: prev ? prev.mileage : null,
            });
            prev = l;
        }
    }
    return result;
}

// ============================================================
// KPI & comparaison avec la période précédente
// ============================================================

function buildKpis(logs) {
    let liters = 0;
    let cost = 0;
    const consumptions = [];
    const costPerKms = [];
    const vehicles = new Set();
    for (const l of logs || []) {
        liters += parseFloat(l.liters) || 0;
        cost += parseFloat(l.cost) || 0;
        if (l.consumption != null) consumptions.push(Number(l.consumption));
        if (l.costPerKm != null) costPerKms.push(Number(l.costPerKm));
        if (l.vehicleId != null) vehicles.add(l.vehicleId);
    }
    const avgPricePerLiter = liters > 0 ? cost / liters : null;
    const avgConsumption = consumptions.length
        ? consumptions.reduce((s, v) => s + v, 0) / consumptions.length
        : null;
    const avgCostPerKm = costPerKms.length
        ? costPerKms.reduce((s, v) => s + v, 0) / costPerKms.length
        : null;
    return {
        liters: round2(liters),
        cost: round2(cost),
        avgPricePerLiter: avgPricePerLiter == null ? null : round2(avgPricePerLiter),
        avgConsumption: avgConsumption == null ? null : round2(avgConsumption),
        costPerKm: avgCostPerKm == null ? null : round2(avgCostPerKm),
        count: (logs || []).length,
        vehiclesFed: vehicles.size,
    };
}

const KPI_KEYS = ['liters', 'cost', 'avgPricePerLiter', 'avgConsumption', 'costPerKm', 'count', 'vehiclesFed'];

/**
 * Compare les KPI de la période courante à ceux de la période précédente.
 * pct === null lorsque la comparaison est impossible (période précédente vide
 * ou valeur nulle) : on n'affiche alors aucune tendance plutôt qu'une valeur
 * inventée.
 */
function compareKpis(current, previous) {
    const out = {};
    for (const key of KPI_KEYS) {
        const c = current[key];
        const p = previous[key];
        let pct = null;
        if (c != null && p != null && p !== 0) {
            pct = round1(((c - p) / Math.abs(p)) * 100);
        }
        out[key] = { value: c, previous: p, pct };
    }
    return out;
}

// ============================================================
// Anomalies
// ============================================================

/**
 * Détecte les anomalies sur une liste de pleins (avec métriques attachées).
 * Retourne une liste triée par criticité :
 *   { id, vehicle, vehicleId, date, value, reason, severity, type }
 * severity : 'ÉLEVÉE' | 'MOYENNE' | 'FAIBLE'.
 */
function detectAnomalies(logs, thresholds = {}) {
    const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
    const list = logs || [];
    const anomalies = [];

    const validCons = list.filter((l) => l.consumption != null).map((l) => Number(l.consumption));
    const validCost = list.filter((l) => l.costPerKm != null).map((l) => Number(l.costPerKm));
    const prices = list
        .filter((l) => l.pricePerLiter != null && !Number.isNaN(parseFloat(l.pricePerLiter)))
        .map((l) => parseFloat(l.pricePerLiter));
    const avgConsumption = validCons.length ? validCons.reduce((s, v) => s + v, 0) / validCons.length : null;
    const avgCostPerKm = validCost.length ? validCost.reduce((s, v) => s + v, 0) / validCost.length : null;
    const avgPrice = prices.length ? prices.reduce((s, v) => s + v, 0) / prices.length : null;

    const closePairs = new Set();

    for (const l of list) {
        const vehicle = l.vehicle || 'Véhicule inconnu';
        const key = (l, suffix) => `L${l.id}-${suffix}`;

        if (l.consumption != null && l.consumption > 0) {
            const highAbs = l.consumption > t.highConsumptionMin;
            const highRel = avgConsumption != null && l.consumption > avgConsumption * t.highConsumptionFactor;
            if (highAbs || highRel) {
                const severity = l.consumption > t.highConsumptionMin * 2 ? 'ÉLEVÉE' : 'MOYENNE';
                anomalies.push({
                    id: l.id, vehicle, vehicleId: l.vehicleId, date: l.date,
                    value: `${round1(l.consumption)} L/100km`,
                    reason: 'Consommation anormalement élevée',
                    severity, type: 'high_consumption',
                });
            }
        }

        if (l.distance != null) {
            if (l.distance < 0) {
                anomalies.push({
                    id: l.id, vehicle, vehicleId: l.vehicleId, date: l.date,
                    value: `${l.mileage} km (plein précédent : ${l.prevMileage} km)`,
                    reason: 'Kilométrage incohérent : relevé inférieur au plein précédent',
                    severity: 'ÉLEVÉE', type: 'mileage_regression',
                });
            } else if (l.distance === 0) {
                anomalies.push({
                    id: l.id, vehicle, vehicleId: l.vehicleId, date: l.date,
                    value: `${l.mileage} km`,
                    reason: 'Kilométrage identique au plein précédent : consommation impossible',
                    severity: 'ÉLEVÉE', type: 'impossible_consumption',
                });
            } else if (l.distance > t.maxMileageGap) {
                anomalies.push({
                    id: l.id, vehicle, vehicleId: l.vehicleId, date: l.date,
                    value: `${l.distance} km depuis le plein précédent`,
                    reason: `Écart kilométrique anormalement grand (> ${t.maxMileageGap} km)`,
                    severity: 'MOYENNE', type: 'mileage_gap',
                });
            }
        }

        const qty = parseFloat(l.liters);
        if (!Number.isNaN(qty)) {
            if (qty > t.maxLiters) {
                anomalies.push({
                    id: l.id, vehicle, vehicleId: l.vehicleId, date: l.date,
                    value: `${qty} L`,
                    reason: `Volume inhabituel : ${qty} L (> ${t.maxLiters} L)`,
                    severity: qty > t.maxLiters * 2 ? 'ÉLEVÉE' : 'MOYENNE',
                    type: 'unusual_quantity',
                });
            } else if (qty < t.minLiters) {
                anomalies.push({
                    id: l.id, vehicle, vehicleId: l.vehicleId, date: l.date,
                    value: `${qty} L`,
                    reason: `Volume inhabituel : ${qty} L (< ${t.minLiters} L)`,
                    severity: 'MOYENNE', type: 'unusual_quantity',
                });
            }
        }

        const ppl = parseFloat(l.pricePerLiter);
        if (!Number.isNaN(ppl) && avgPrice != null && ppl > avgPrice * t.abnormalPriceFactor) {
            anomalies.push({
                id: l.id, vehicle, vehicleId: l.vehicleId, date: l.date,
                value: `${Math.round(ppl)} FCFA/L`,
                reason: 'Prix/litre anormal par rapport au prix moyen de la période',
                severity: 'MOYENNE', type: 'abnormal_price',
            });
        }

        if (l.costPerKm != null) {
            const highAbs = l.costPerKm > t.maxCostPerKm;
            const highRel = avgCostPerKm != null && l.costPerKm > avgCostPerKm * t.highCostPerKmFactor;
            if (highAbs || highRel) {
                anomalies.push({
                    id: l.id, vehicle, vehicleId: l.vehicleId, date: l.date,
                    value: `${round1(l.costPerKm)} FCFA/km`,
                    reason: 'Coût/km anormal',
                    severity: 'MOYENNE', type: 'high_cost_per_km',
                });
            }
        }

        // Pleins rapprochés : un couple n'est signalé qu'une seule fois.
        const ts = toDate(l.date);
        if (ts) {
            const vehicleKey = l.vehicleId != null ? String(l.vehicleId) : String(l.vehicle || '');
            for (const o of list) {
                const oKey = o.vehicleId != null ? String(o.vehicleId) : String(o.vehicle || '');
                if (o.id === l.id || oKey !== vehicleKey) continue;
                const ots = toDate(o.date);
                if (!ots) continue;
                const gap = Math.abs(ots - ts);
                if (gap < t.closeFillsHours * 3600000) {
                    const pairKey = l.id < o.id ? `${l.id}-${o.id}` : `${o.id}-${l.id}`;
                    if (closePairs.has(pairKey)) continue;
                    closePairs.add(pairKey);
                    anomalies.push({
                        id: l.id, vehicle, vehicleId: l.vehicleId, date: l.date,
                        value: `≈ ${Math.round(gap / 3600000)} h d'écart`,
                        reason: `Deux pleins très rapprochés (< ${t.closeFillsHours} h)`,
                        severity: 'FAIBLE', type: 'close_fills',
                    });
                }
            }
        }
    }

    const severityOrder = { 'ÉLEVÉE': 0, 'MOYENNE': 1, 'FAIBLE': 2 };
    return anomalies.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
}

// ============================================================
// Données des graphiques (période sélectionnée)
// ============================================================

const MONTH_NAMES = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc'];

function monthLabel(d) {
    return `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;
}

function sumByMonth(logs, valueFn) {
    const map = {};
    for (const l of logs || []) {
        const d = toDate(l.date);
        if (!d) continue;
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        map[key] = (map[key] || 0) + (valueFn(l) || 0);
    }
    return Object.keys(map).sort().map((k) => {
        const [y, m] = k.split('-');
        return { label: `${MONTH_NAMES[parseInt(m, 10) - 1]} ${y}`, value: round2(map[k]) };
    });
}

function avgByMonth(logs, valueFn) {
    const map = {};
    for (const l of logs || []) {
        const d = toDate(l.date);
        if (!d) continue;
        const v = valueFn(l);
        if (v == null) continue;
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        (map[key] = map[key] || []).push(Number(v));
    }
    return Object.keys(map).sort().map((k) => {
        const [y, m] = k.split('-');
        const values = map[k];
        return {
            label: `${MONTH_NAMES[parseInt(m, 10) - 1]} ${y}`,
            value: round2(values.reduce((s, v) => s + v, 0) / values.length),
        };
    });
}

function sumByLabel(logs, labelFn, valueFn) {
    const map = {};
    for (const l of logs || []) {
        const label = labelFn(l) || 'Non renseigné';
        map[label] = (map[label] || 0) + (valueFn(l) || 0);
    }
    return Object.keys(map).map((label) => ({ label, value: round2(map[label]) }));
}

function avgByLabel(logs, labelFn, valueFn) {
    const map = {};
    for (const l of logs || []) {
        const v = valueFn(l);
        if (v == null) continue;
        const label = labelFn(l) || 'Non renseigné';
        (map[label] = map[label] || []).push(Number(v));
    }
    return Object.keys(map).map((label) => ({
        label,
        value: round2(map[label].reduce((s, v) => s + v, 0) / map[label].length),
    }));
}

function buildCharts(logs) {
    const costByMonth = sumByMonth(logs, (l) => parseFloat(l.cost));
    const litersByMonth = sumByMonth(logs, (l) => parseFloat(l.liters));
    const consumptionByMonth = avgByMonth(logs, (l) => l.consumption);
    const costByVehicle = sumByLabel(logs, (l) => l.vehicle, (l) => parseFloat(l.cost));
    const topConsumers = sumByLabel(logs, (l) => l.vehicle, (l) => parseFloat(l.liters))
        .sort((a, b) => b.value - a.value)
        .slice(0, 10);
    const costByFuelType = sumByLabel(logs, (l) => l.fuelType, (l) => parseFloat(l.cost));
    const costPerKmByVehicle = avgByLabel(logs, (l) => l.vehicle, (l) => l.costPerKm);

    return {
        costByMonth: { labels: costByMonth.map((e) => e.label), data: costByMonth.map((e) => e.value) },
        litersByMonth: { labels: litersByMonth.map((e) => e.label), data: litersByMonth.map((e) => e.value) },
        consumptionByMonth: { labels: consumptionByMonth.map((e) => e.label), data: consumptionByMonth.map((e) => e.value) },
        costByVehicle: { labels: costByVehicle.map((e) => e.label), data: costByVehicle.map((e) => e.value) },
        topConsumers: { labels: topConsumers.map((e) => e.label), data: topConsumers.map((e) => e.value) },
        costByFuelType: { labels: costByFuelType.map((e) => e.label), data: costByFuelType.map((e) => e.value) },
        costPerKmByVehicle: { labels: costPerKmByVehicle.map((e) => e.label), data: costPerKmByVehicle.map((e) => e.value) },
    };
}

// ============================================================
// Budget mensuel
// ============================================================

/**
 * État du budget du mois donné : montant prévu, dépensé, restant et taux
 * d'utilisation, avec alerte quand le seuil est approché (>= 80 %) ou dépassé.
 */
async function buildBudget(orgId, month) {
    const range = monthRange(month);
    const { rows } = await query(
        `SELECT COALESCE(SUM(cost), 0) AS spent
         FROM fuel_logs
         WHERE organization_id = $1 AND date >= $2 AND date < $3`,
        [orgId, isoDate(range.from), isoDate(range.to)]
    );
    const spent = round2(parseFloat(rows[0].spent) || 0);

    const budgetRes = await query(
        'SELECT * FROM fuel_budgets WHERE organization_id = $1 AND month = $2',
        [orgId, isoDate(month)]
    );
    const budget = mapRows(budgetRes.rows)[0] || null;

    if (!budget) {
        return {
            month: isoDate(month),
            hasBudget: false,
            amount: null,
            spent,
            remaining: null,
            utilization: null,
            status: 'NO_BUDGET',
        };
    }

    const amount = parseFloat(budget.amount) || 0;
    const utilization = amount > 0 ? round1((spent / amount) * 100) : null;
    const status = utilization != null && utilization > 100 ? 'OVER' : utilization != null && utilization >= 80 ? 'WARNING' : 'OK';

    return {
        month: isoDate(month),
        hasBudget: true,
        amount: round2(amount),
        spent,
        remaining: round2(amount - spent),
        utilization,
        status,
        budgetId: budget.id,
    };
}

// ============================================================
// Vue complète /api/fuel-logs/stats
// ============================================================

async function getFuelStats(orgId, opts = {}) {
    const { rows } = await query(
        'SELECT * FROM fuel_logs WHERE organization_id = $1 ORDER BY id',
        [orgId]
    );
    const withMetrics = attachMetrics(mapRows(rows));

    const range = parsePeriod(opts);
    const periodLogs = withMetrics.filter((l) => inRange(l, range.from, range.to));
    const prevLogs = withMetrics.filter((l) => inRange(l, range.prevFrom, range.prevTo));

    const current = buildKpis(periodLogs);
    const previous = buildKpis(prevLogs);
    const kpi = compareKpis(current, previous);

    const anomalies = detectAnomalies(periodLogs, opts.thresholds || config.fuel || {});

    const charts = buildCharts(periodLogs);

    // Budget : toujours le mois civil en cours (les budgets sont mensuels).
    const now = new Date();
    const budgetMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const budget = await buildBudget(orgId, budgetMonth);

    const budgetRows = await query(
        'SELECT * FROM fuel_budgets WHERE organization_id = $1 ORDER BY month DESC',
        [orgId]
    );
    const budgetList = mapRows(budgetRows.rows);

    return {
        period: {
            key: range.key,
            label: range.label,
            from: isoDate(range.from),
            to: isoDate(range.to),
            prevFrom: isoDate(range.prevFrom),
            prevTo: isoDate(range.prevTo),
        },
        kpi,
        charts,
        anomalies,
        budget,
        budgetList,
    };
}

module.exports = {
    DEFAULT_THRESHOLDS,
    PERIOD_KEYS,
    toDate,
    parsePeriod,
    inRange,
    computeLogMetrics,
    attachMetrics,
    buildKpis,
    compareKpis,
    detectAnomalies,
    buildCharts,
    getFuelStats,
};
