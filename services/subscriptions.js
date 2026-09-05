// ============================================================
// Service Abonnements SaaS (logique métier)
// ============================================================
// - Calcul du statut effectif d'un abonnement (TRIAL / ACTIVE / EXPIRED / ...)
// - Contexte d'abonnement exposé au frontend (plan, usage, limites, alerte)
// - Période d'essai configurable, renouvellement manuel (préparé pour les
//   futurs paiements Wave / Orange Money / Stripe)
// - Contrôles automatiques des limites (véhicules, utilisateurs)
// ============================================================
const { plans, subscriptions, countUsage } = require('../db/subscriptions');
const { config } = require('../config');
const AppError = require('../utils/AppError');

const VALID_STATUSES = ['TRIAL', 'ACTIVE', 'EXPIRED', 'CANCELLED', 'PAST_DUE'];

// ============================================================
// Utilitaires de date (valeurs DATE renvoyées par PostgreSQL : YYYY-MM-DD)
// ============================================================

function todayISO() {
    return new Date().toISOString().slice(0, 10);
}

function addDaysISO(dateStr, days) {
    const d = new Date(dateStr + 'T00:00:00');
    if (Number.isNaN(d.getTime())) return null;
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
}

function addMonthsISO(dateStr, months) {
    if (typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
    const [y, mo, d] = dateStr.split('-').map(Number);
    // Arithmétique calendaire stricte (pas de débordement JavaScript) : un
    // 31 janvier + 1 mois donne le 28/29 février, jamais le 3 mars.
    const total = (mo - 1) + months;
    const year = y + Math.floor(total / 12);
    const month = ((total % 12) + 12) % 12;
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const day = Math.min(d, lastDay);
    return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function daysBetween(fromISO, toISO) {
    if (!fromISO || !toISO) return null;
    const a = new Date(fromISO + 'T00:00:00').getTime();
    const b = new Date(toISO + 'T00:00:00').getTime();
    if (Number.isNaN(a) || Number.isNaN(b)) return null;
    return Math.round((b - a) / 86400000);
}

// ============================================================
// Statut effectif & alertes
// ============================================================

/**
 * Statut effectif : un abonnement TRIAL/ACTIVE dont la date de fin est dépassée
 * est considéré EXPIRED (sans attendre le job d'expiration).
 */
function computeEffectiveStatus(sub) {
    if (!sub) return null;
    if ((sub.status === 'TRIAL' || sub.status === 'ACTIVE') && sub.endDate) {
        const daysLeft = daysBetween(todayISO(), sub.endDate);
        if (daysLeft != null && daysLeft < 0) return 'EXPIRED';
    }
    return sub.status;
}

const STATUS_LABELS = {
    TRIAL: 'Période d\'essai',
    ACTIVE: 'Actif',
    EXPIRED: 'Expiré',
    CANCELLED: 'Résilié',
    PAST_DUE: 'Impayé',
};

function buildAlert(sub, effectiveStatus) {
    if (!sub) {
        return { severity: 'warning', title: 'Abonnement non défini', message: 'Aucun abonnement trouvé pour cette organisation.' };
    }
    const daysLeft = daysBetween(todayISO(), sub.endDate);

    if (effectiveStatus === 'EXPIRED') {
        return {
            severity: 'critical',
            title: 'Abonnement expiré',
            message: `Votre abonnement ${sub.planName || sub.planCode} a expiré${daysLeft != null ? ` depuis ${Math.abs(daysLeft)} jour(s)` : ''}. Contactez votre administrateur pour le renouveler.`,
        };
    }
    if (effectiveStatus === 'CANCELLED') {
        return {
            severity: 'critical',
            title: 'Abonnement résilié',
            message: 'Votre abonnement a été résilié. Contactez l\'équipe Asadiya pour le réactiver.',
        };
    }
    if (effectiveStatus === 'TRIAL') {
        return {
            severity: 'info',
            title: 'Période d\'essai en cours',
            message: daysLeft != null && daysLeft >= 0
                ? `Votre période d'essai se termine le ${sub.endDate} (${daysLeft} jour(s) restants).`
                : 'Votre période d\'essai est en cours.',
        };
    }
    if (effectiveStatus === 'ACTIVE' && daysLeft != null) {
        if (daysLeft <= 7) {
            return {
                severity: 'warning',
                title: 'Abonnement expirant bientôt',
                message: `Votre abonnement ${sub.planName || sub.planCode} expire le ${sub.endDate} (${daysLeft} jour(s) restants). Préparez le renouvellement.`,
            };
        }
        return {
            severity: 'ok',
            title: 'Abonnement actif',
            message: `Votre abonnement ${sub.planName || sub.planCode} est actif jusqu'au ${sub.endDate}.`,
        };
    }
    return {
        severity: 'ok',
        title: 'Abonnement actif',
        message: `Votre abonnement ${sub.planName || sub.planCode} est actif.`,
    };
}

// ============================================================
// Contexte d'abonnement exposé au frontend
// ============================================================

async function getSubscriptionContext(orgId) {
    const sub = await subscriptions.getByOrg(orgId);
    const usage = await countUsage(orgId);
    if (!sub) {
        return {
            exists: false,
            usage,
            limits: { vehicles: null, users: null },
            subscription: null,
            plan: null,
            alerts: [buildAlert(null, null)],
        };
    }

    const effectiveStatus = computeEffectiveStatus(sub);
    const maxVehicles = sub.maxVehicles != null ? parseInt(sub.maxVehicles, 10) : null;
    const maxUsers = sub.maxUsers != null ? parseInt(sub.maxUsers, 10) : null;

    return {
        exists: true,
        subscription: {
            id: sub.id,
            planId: sub.planId,
            planCode: sub.planCode,
            planName: sub.planName || sub.planCode,
            monthlyPrice: parseFloat(sub.monthlyPrice),
            status: effectiveStatus,
            rawStatus: sub.status,
            startDate: sub.startDate,
            endDate: sub.endDate,
            trialEndsAt: sub.trialEndsAt,
            autoRenew: sub.autoRenew,
        },
        plan: {
            id: sub.planId,
            code: sub.planCode,
            name: sub.planName || sub.planCode,
            description: sub.planDescription,
            monthlyPrice: parseFloat(sub.monthlyPrice),
            durationMonths: sub.durationMonths,
            maxVehicles,
            maxUsers,
            features: sub.features || [],
        },
        usage,
        limits: { vehicles: maxVehicles, users: maxUsers },
        statusLabel: STATUS_LABELS[effectiveStatus] || effectiveStatus,
        endDate: sub.endDate,
        daysLeft: daysBetween(todayISO(), sub.endDate),
        alert: buildAlert(sub, effectiveStatus),
    };
}

// ============================================================
// Contrôles des limites du plan
// ============================================================

async function getUsage(orgId) {
    return countUsage(orgId);
}

async function enforceVehicleLimit(orgId) {
    const ctx = await getSubscriptionContext(orgId);
    const limit = ctx.limits.vehicles;
    if (limit == null) return ctx;
    if (ctx.usage.vehicles >= limit) {
        throw AppError.conflict(
            `Limite de votre plan atteinte (${limit} véhicules maximum). Supprimez un véhicule ou contactez votre administrateur pour passer à un plan supérieur.`,
            { kind: 'vehicle_limit', limit, current: ctx.usage.vehicles }
        );
    }
    return ctx;
}

async function enforceUserLimit(orgId) {
    const ctx = await getSubscriptionContext(orgId);
    const limit = ctx.limits.users;
    if (limit == null) return ctx;
    if (ctx.usage.users >= limit) {
        throw AppError.conflict(
            `Limite de votre plan atteinte (${limit} utilisateurs maximum). Supprimez un compte ou contactez votre administrateur pour passer à un plan supérieur.`,
            { kind: 'user_limit', limit, current: ctx.usage.users }
        );
    }
    return ctx;
}

// ============================================================
// Opérations de gestion (SuperAdmin / futurs paiements)
// ============================================================

function resolvePlanId(reference) {
    return plans.findByCodeOrId(reference);
}

/** Active un abonnement (fin de la période d'essai, passage en ACTIVE). */
async function activate(orgId, { planId, changedBy, reason }) {
    const sub = await subscriptions.getByOrg(orgId);
    if (!sub) throw AppError.notFound('Aucun abonnement pour cette organisation.');

    let plan = null;
    if (planId != null) {
        plan = await resolvePlanId(planId);
        if (!plan) throw AppError.badRequest('Plan introuvable.');
    } else {
        // Sans plan explicite : on conserve le plan courant de l'abonnement.
        plan = sub.planId != null ? await resolvePlanId(sub.planId) : null;
        if (!plan) throw AppError.badRequest('Aucun plan à activer.');
    }

    const start = todayISO();
    const months = (plan.durationMonths != null && plan.durationMonths > 0) ? plan.durationMonths : 1;
    const end = addMonthsISO(start, months);

    return subscriptions.updateCurrent(orgId, {
        planId: plan.id,
        status: 'ACTIVE',
        startDate: start,
        endDate: end,
        trialEndsAt: start,
        autoRenew: false,
        changeType: 'ACTIVATED',
        changedBy,
        reason: reason || 'Activation manuelle de l\'abonnement.',
    });
}

/**
 * Renouvellement manuel : prolonge la période courante du nombre de mois du plan.
 * Préparé pour être déclenché automatiquement par les futurs fournisseurs de
 * paiement (Wave, Orange Money, Stripe) après confirmation d'un paiement.
 */
async function renew(orgId, { planId, changedBy, reason }) {
    const sub = await subscriptions.getByOrg(orgId);
    if (!sub) throw AppError.notFound('Aucun abonnement pour cette organisation.');

    let plan = null;
    if (planId != null) {
        plan = await resolvePlanId(planId);
        if (!plan) throw AppError.badRequest('Plan introuvable.');
    } else {
        // Sans plan explicite : on renouvelle sur le plan courant.
        plan = sub.planId != null ? await resolvePlanId(sub.planId) : null;
        if (!plan) throw AppError.badRequest('Aucun plan à renouveler.');
    }

    const months = (plan.durationMonths != null && plan.durationMonths > 0) ? plan.durationMonths : 1;

    // Base de renouvellement : la date de fin actuelle (si future) ou aujourd'hui.
    const base = sub.endDate && daysBetween(todayISO(), sub.endDate) >= 0 ? sub.endDate : todayISO();
    const end = addMonthsISO(base, months);

    return subscriptions.updateCurrent(orgId, {
        planId: plan.id,
        status: 'ACTIVE',
        startDate: sub.startDate || todayISO(),
        endDate: end,
        autoRenew: false,
        changeType: 'RENEWED',
        changedBy,
        reason: reason || 'Renouvellement manuel de l\'abonnement (paiement à venir).',
    });
}

/** Résilie un abonnement. */
async function cancel(orgId, { changedBy, reason }) {
    const sub = await subscriptions.getByOrg(orgId);
    if (!sub) throw AppError.notFound('Aucun abonnement pour cette organisation.');

    return subscriptions.updateCurrent(orgId, {
        status: 'CANCELLED',
        changeType: 'CANCELLED',
        changedBy,
        reason: reason || 'Résiliation de l\'abonnement.',
    });
}

/**
 * Change le plan d'une organisation tout en conservant son statut et ses dates,
 * sauf si le plan change le nombre de mois (on recalcule la date de fin).
 */
async function changePlan(orgId, { planId, status, startDate, endDate, changedBy, reason }) {
    const plan = await resolvePlanId(planId);
    if (!plan) throw AppError.badRequest('Plan introuvable.');
    const sub = await subscriptions.getByOrg(orgId);
    if (!sub) throw AppError.notFound('Aucun abonnement pour cette organisation.');

    const nextStatus = status !== undefined && VALID_STATUSES.includes(status) ? status : sub.status;
    const nextStart = startDate || sub.start_date || todayISO();
    const nextEnd = endDate || addMonthsISO(nextStart, plan.durationMonths > 0 ? plan.durationMonths : 1);

    return subscriptions.updateCurrent(orgId, {
        planId: plan.id,
        status: nextStatus,
        startDate: nextStart,
        endDate: nextEnd,
        changeType: 'PLAN_CHANGED',
        changedBy,
        reason: reason || `Changement de plan vers ${plan.name}.`,
    });
}

/** Création initiale d'abonnement pour un nouveau client (période d'essai). */
async function startTrial(orgId, { planId, changedBy, reason }) {
    const plan = planId != null ? await resolvePlanId(planId) : await plans.findByCode('STARTER');
    if (!plan) throw AppError.badRequest('Plan introuvable.');

    const start = todayISO();
    const end = addDaysISO(start, config.trialDays);
    return subscriptions.create(orgId, {
        planId: plan.id,
        status: 'TRIAL',
        startDate: start,
        endDate: end,
        trialEndsAt: end,
        autoRenew: false,
        changeType: 'TRIAL_STARTED',
        changedBy,
        reason: reason || `Période d'essai de ${config.trialDays} jours.`,
    });
}

module.exports = {
    getSubscriptionContext,
    getUsage,
    enforceVehicleLimit,
    enforceUserLimit,
    activate,
    renew,
    cancel,
    changePlan,
    startTrial,
    computeEffectiveStatus,
    buildAlert,
    STATUS_LABELS,
    VALID_STATUSES,
};
