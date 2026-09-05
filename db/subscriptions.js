// ============================================================
// Abonnements SaaS — Plans, Abonnements, Historique
// ============================================================
// Accès aux données pour le module d'abonnements (Phase 3).
// Toutes les écritures qui touchent plusieurs tables (abonnement + historique)
// sont enveloppées dans une transaction PostgreSQL.
// ============================================================
const { query, withTransaction } = require('./pool');
const { mapRow, mapRows } = require('./mappers');
const AppError = require('../utils/AppError');

// ============================================================
// Plans d'abonnement
// ============================================================

const PLAN_COLUMNS = [
    'id', 'code', 'name', 'description', 'monthly_price', 'duration_months',
    'max_vehicles', 'max_users', 'features', 'active', 'created_at', 'updated_at',
].join(', ');

const PLAN_FIELD_MAP = {
    code: 'code',
    name: 'name',
    description: 'description',
    monthlyPrice: 'monthly_price',
    durationMonths: 'duration_months',
    maxVehicles: 'max_vehicles',
    maxUsers: 'max_users',
    features: 'features',
    active: 'active',
};

function sanitizePlan(data) {
    const out = {};
    for (const [camel, column] of Object.entries(PLAN_FIELD_MAP)) {
        if (data[camel] !== undefined) out[column] = data[camel];
    }
    if (out.features !== undefined && !Array.isArray(out.features)) {
        out.features = JSON.stringify(out.features);
    } else if (out.features !== undefined) {
        out.features = JSON.stringify(out.features);
    }
    return out;
}

const plans = {
    /** Tous les plans (superadmin : inclut les plans inactifs). */
    async findAll() {
        const result = await query(
            `SELECT ${PLAN_COLUMNS} FROM plans ORDER BY monthly_price, id`
        );
        return mapRows(result.rows);
    },

    /** Plans actifs uniquement. */
    async findAllActive() {
        const result = await query(
            `SELECT ${PLAN_COLUMNS} FROM plans WHERE active = TRUE ORDER BY monthly_price, id`
        );
        return mapRows(result.rows);
    },

    async findById(id) {
        const result = await query(`SELECT ${PLAN_COLUMNS} FROM plans WHERE id = $1`, [id]);
        return mapRow(result.rows[0] || null);
    },

    async findByCode(code) {
        const result = await query(
            `SELECT ${PLAN_COLUMNS} FROM plans WHERE UPPER(code) = UPPER($1)`,
            [code]
        );
        return mapRow(result.rows[0] || null);
    },

    async findByCodeOrId(reference) {
        if (/^\d+$/.test(String(reference))) {
            return this.findById(parseInt(reference, 10));
        }
        return this.findByCode(reference);
    },

    async create(data) {
        const clean = sanitizePlan(data);
        const keys = Object.keys(clean);
        const cols = keys.join(', ');
        const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
        const result = await query(
            `INSERT INTO plans (${cols}) VALUES (${placeholders}) RETURNING ${PLAN_COLUMNS}`,
            Object.values(clean)
        );
        return mapRow(result.rows[0] || null);
    },

    async update(id, data) {
        const clean = sanitizePlan(data);
        const entries = Object.entries(clean);
        if (entries.length === 0) return this.findById(id);
        const sets = [];
        const params = [];
        let i = 1;
        for (const [key, value] of entries) {
            sets.push(`${key} = $${i++}`);
            params.push(value);
        }
        params.push(id);
        const result = await query(
            `UPDATE plans SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${i} RETURNING ${PLAN_COLUMNS}`,
            params
        );
        return mapRow(result.rows[0] || null);
    },

    async remove(id) {
        const result = await query('DELETE FROM plans WHERE id = $1 RETURNING id', [id]);
        return (result.rowCount ?? 0) > 0;
    },

    /** Vrai si un abonnement référence ce plan. */
    async isInUse(id) {
        const result = await query('SELECT 1 FROM subscriptions WHERE plan_id = $1 LIMIT 1', [id]);
        return (result.rowCount ?? 0) > 0;
    },
};

// ============================================================
// Abonnements
// ============================================================

const SUB_COLUMNS = `
    s.id, s.organization_id, s.plan_id, s.plan AS plan_code, s.monthly_price,
    s.status, s.start_date, s.end_date, s.trial_ends_at, s.auto_renew,
    s.created_at, s.updated_at,
    p.name AS plan_name, p.description AS plan_description,
    p.duration_months, p.max_vehicles, p.max_users, p.features
`;

const HISTORY_INSERT = `
    INSERT INTO subscription_history
        (organization_id, subscription_id, plan_id, plan_code, plan_name,
         monthly_price, status, change_type, start_date, end_date, changed_by, reason)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
`;

async function insertHistory(client, entry) {
    const plan = entry.plan || { id: null, code: '', name: '' };
    await client.query(HISTORY_INSERT, [
        entry.organizationId,
        entry.subscriptionId,
        plan.id,
        plan.code,
        plan.name,
        entry.monthlyPrice != null ? entry.monthlyPrice : 0,
        entry.status,
        entry.changeType,
        entry.startDate || null,
        entry.endDate || null,
        entry.changedBy || null,
        entry.reason || null,
    ]);
}

/**
 * Création d'un abonnement + journalisation, exécutée sur le client fourni
 * (utilisable dans une transaction existante).
 */
async function createOnClient(client, orgId, opts) {
    const { planId, status, startDate, endDate, trialEndsAt, autoRenew = false, changeType = 'SUBSCRIBED', reason, changedBy } = opts || {};
    const planRes = await client.query(
        'SELECT id, code, name, monthly_price FROM plans WHERE id = $1',
        [planId]
    );
    const plan = planRes.rows[0];
    if (!plan) throw AppError.badRequest('Plan introuvable.');

    const res = await client.query(
        `INSERT INTO subscriptions
            (organization_id, plan_id, plan, monthly_price, status,
             start_date, end_date, trial_ends_at, auto_renew)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [orgId, planId, plan.code, plan.monthly_price, status,
         startDate || null, endDate || null, trialEndsAt || null, autoRenew]
    );
    const row = res.rows[0];

    await insertHistory(client, {
        organizationId: orgId,
        subscriptionId: row.id,
        plan,
        monthlyPrice: plan.monthly_price,
        status,
        changeType,
        startDate: startDate || null,
        endDate: endDate || null,
        changedBy,
        reason,
    });
    return mapRow(row);
}

/** Abonnement courant d'une organisation, lu SUR UN client de transaction. */
async function getByOrgOnClient(client, orgId) {
    const result = await client.query(
        `SELECT ${SUB_COLUMNS}
         FROM subscriptions s
         LEFT JOIN plans p ON p.id = s.plan_id
         WHERE s.organization_id = $1
         ORDER BY s.id DESC
         LIMIT 1`,
        [orgId]
    );
    return mapRow(result.rows[0] || null);
}

/**
 * Version de updateCurrent exécutable DANS une transaction existante (le
 * client la reçoit, la transaction doit déjà être ouverte). Les lectures et
 * écritures portent toutes sur le même client : atomicité garantie par
 * l'appelant (withTransaction).
 */
async function updateCurrentOnClient(client, orgId, { planId, status, startDate, endDate, trialEndsAt, autoRenew, changeType, reason, changedBy }) {
    const currentRes = await client.query(
        `SELECT * FROM subscriptions
         WHERE organization_id = $1
         ORDER BY id DESC LIMIT 1
         FOR UPDATE`,
        [orgId]
    );
    const current = currentRes.rows[0];
    if (!current) throw AppError.notFound('Aucun abonnement pour cette organisation.');

    let plan = null;
    if (planId != null) {
        const planRes = await client.query(
            'SELECT id, code, name, monthly_price FROM plans WHERE id = $1',
            [planId]
        );
        plan = planRes.rows[0];
        if (!plan) throw AppError.badRequest('Plan introuvable.');
    } else {
        plan = { id: current.plan_id, code: current.plan, name: current.plan };
    }

    const nextStatus = status !== undefined ? status : current.status;
    const nextPlanId = planId != null ? planId : current.plan_id;
    const nextPlanCode = plan.code;
    const nextPrice = plan.monthly_price != null ? plan.monthly_price : current.monthly_price;

    const res = await client.query(
        `UPDATE subscriptions
         SET plan_id = $2, plan = $3, monthly_price = $4, status = $5,
             start_date = $6, end_date = $7, trial_ends_at = $8, auto_renew = $9,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [current.id, nextPlanId, nextPlanCode, nextPrice, nextStatus,
         startDate !== undefined ? startDate : current.start_date,
         endDate !== undefined ? endDate : current.end_date,
         trialEndsAt !== undefined ? trialEndsAt : current.trial_ends_at,
         autoRenew !== undefined ? autoRenew : current.auto_renew]
    );
    const row = res.rows[0];

    await insertHistory(client, {
        organizationId: orgId,
        subscriptionId: row.id,
        plan,
        monthlyPrice: nextPrice,
        status: nextStatus,
        changeType,
        startDate: row.start_date,
        endDate: row.end_date,
        changedBy,
        reason,
    });
    return mapRow(row);
}

const subscriptions = {
    /** Abonnement courant d'une organisation (avec le plan rattaché). */
    async getByOrg(orgId) {
        const result = await query(
            `SELECT ${SUB_COLUMNS}
             FROM subscriptions s
             LEFT JOIN plans p ON p.id = s.plan_id
             WHERE s.organization_id = $1
             ORDER BY s.id DESC
             LIMIT 1`,
            [orgId]
        );
        return mapRow(result.rows[0] || null);
    },

    /** Abonnement courant, lu sur un client de transaction (récupérable par updateCurrentOnClient). */
    async getByOrgOnClient(client, orgId) {
        return getByOrgOnClient(client, orgId);
    },

    async getById(id) {
        const result = await query(
            `SELECT ${SUB_COLUMNS}
             FROM subscriptions s
             LEFT JOIN plans p ON p.id = s.plan_id
             WHERE s.id = $1`,
            [id]
        );
        return mapRow(result.rows[0] || null);
    },

    /**
     * Crée l'abonnement initial d'une organisation (généralement en TRIAL)
     * et journalise l'événement dans l'historique. Atomique.
     * Version autonome : ouvre sa propre transaction.
     */
    async create(orgId, opts) {
        return withTransaction((client) => createOnClient(client, orgId, opts));
    },

    /**
     * Version utilisable DANS une transaction existante (ex: création d'une
     * organisation + admin + abonnement en une seule transaction).
     */
    async createOnClient(client, orgId, opts) {
        return createOnClient(client, orgId, opts);
    },

    /**
     * Met à jour l'abonnement courant d'une organisation et journalise le
     * changement. Atomique. Utilisé pour le changement de plan, l'activation,
     * la résiliation et le renouvellement.
     */
    async updateCurrent(orgId, opts) {
        return withTransaction((client) => updateCurrentOnClient(client, orgId, opts));
    },

    /**
     * Version exécutable DANS une transaction existante (ex: synchronisation
     * des paiements : facture PAID + renouvellement atomiques).
     */
    async updateCurrentOnClient(client, orgId, opts) {
        return updateCurrentOnClient(client, orgId, opts);
    },

    /** Tous les abonnements courants (le plus récent par organisation). */
    async findAllCurrent() {
        const result = await query(
            `SELECT ${SUB_COLUMNS}, o.name AS organization_name
             FROM subscriptions s
             JOIN organizations o ON o.id = s.organization_id
             LEFT JOIN plans p ON p.id = s.plan_id
             WHERE s.id = (
                 SELECT MAX(s2.id) FROM subscriptions s2 WHERE s2.organization_id = s.organization_id
             )
             ORDER BY o.id`
        );
        return mapRows(result.rows);
    },

    /**
     * Bascule automatique des abonnements échus en EXPIRED et journalisation.
     * Appelé au démarrage du serveur et périodiquement. Retourne le nombre
     * d'abonnements passés à EXPIRED.
     */
    async markExpired() {
        return withTransaction(async (client) => {
            const res = await client.query(
                `SELECT s.id, s.organization_id, s.plan_id, s.plan, s.monthly_price,
                        s.status, s.start_date, s.end_date, s.trial_ends_at
                 FROM subscriptions s
                 WHERE s.status IN ('TRIAL', 'ACTIVE')
                   AND s.end_date IS NOT NULL
                   AND s.end_date < CURRENT_DATE
                 FOR UPDATE`
            );
            const rows = res.rows;
            if (rows.length > 0) {
                await client.query(
                    `UPDATE subscriptions SET status = 'EXPIRED', updated_at = NOW()
                     WHERE id = ANY($1)`,
                    [rows.map((r) => r.id)]
                );
                for (const r of rows) {
                    const planRes = await client.query(
                        'SELECT name FROM plans WHERE id = $1',
                        [r.plan_id]
                    );
                    const planName = planRes.rows[0] ? planRes.rows[0].name : r.plan;
                    await client.query(HISTORY_INSERT, [
                        r.organization_id, r.id, r.plan_id, r.plan, planName,
                        r.monthly_price, 'EXPIRED',
                        r.status === 'TRIAL' ? 'TRIAL_EXPIRED' : 'EXPIRED',
                        r.start_date, r.end_date, null,
                        r.status === 'TRIAL'
                            ? 'Période d\'essai arrivée à expiration.'
                            : 'Abonnement arrivé à expiration (renouvellement requis).',
                    ]);
                }
            }
            return rows.length;
        });
    },

    /** Comptes globaux par statut (pour le tableau SuperAdmin). */
    async countByStatus() {
        const result = await query(
            `SELECT status, COUNT(*) AS count
             FROM subscriptions
             WHERE id = (
                 SELECT MAX(s2.id) FROM subscriptions s2 WHERE s2.organization_id = subscriptions.organization_id
             )
             GROUP BY status`
        );
        const out = { TRIAL: 0, ACTIVE: 0, EXPIRED: 0, CANCELLED: 0, PAST_DUE: 0 };
        for (const r of result.rows) {
            if (out[r.status] !== undefined) out[r.status] = parseInt(r.count, 10);
        }
        return out;
    },
};

// ============================================================
// Historique
// ============================================================

const HISTORY_COLUMNS = `
    h.id, h.organization_id, h.subscription_id, h.plan_id, h.plan_code,
    h.plan_name, h.monthly_price, h.status, h.change_type,
    h.start_date, h.end_date, h.changed_by, h.reason, h.created_at,
    o.name AS organization_name,
    u.username AS changed_by_username
`;

const history = {
    async findByOrg(orgId, limit = 50) {
        const result = await query(
            `SELECT ${HISTORY_COLUMNS}
             FROM subscription_history h
             LEFT JOIN organizations o ON o.id = h.organization_id
             LEFT JOIN users u ON u.id = h.changed_by
             WHERE h.organization_id = $1
             ORDER BY h.id DESC
             LIMIT $2`,
            [orgId, limit]
        );
        return mapRows(result.rows);
    },

    async findAll(limit = 100) {
        const result = await query(
            `SELECT ${HISTORY_COLUMNS}
             FROM subscription_history h
             LEFT JOIN organizations o ON o.id = h.organization_id
             LEFT JOIN users u ON u.id = h.changed_by
             ORDER BY h.id DESC
             LIMIT $1`,
            [limit]
        );
        return mapRows(result.rows);
    },

    async count() {
        const result = await query('SELECT COUNT(*) AS count FROM subscription_history');
        return parseInt(result.rows[0].count, 10);
    },
};

// ============================================================
// Utilisation (compteurs par organisation)
// ============================================================

async function countUsage(orgId) {
    const [vehicles, users, drivers] = await Promise.all([
        query('SELECT COUNT(*) AS count FROM vehicles WHERE organization_id = $1', [orgId]),
        query('SELECT COUNT(*) AS count FROM users WHERE organization_id = $1', [orgId]),
        query('SELECT COUNT(*) AS count FROM drivers WHERE organization_id = $1', [orgId]),
    ]);
    return {
        vehicles: parseInt(vehicles.rows[0].count, 10),
        users: parseInt(users.rows[0].count, 10),
        drivers: parseInt(drivers.rows[0].count, 10),
    };
}

module.exports = { plans, subscriptions, history, countUsage };
