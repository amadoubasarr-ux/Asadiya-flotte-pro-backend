const { pool, query, withTransaction } = require('./pool');
const { mapRow, mapRows } = require('./mappers');
const AppError = require('../utils/AppError');
const { config } = require('../config');
const { subscriptions: subscriptionsRepo } = require('./subscriptions');

function addDays(date, days) {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
}

// ============================================================
// Tables "métier" cloisonnées par organisation (multi-tenant)
// ============================================================

const TABLES = {
    vehicles: 'vehicles',
    drivers: 'drivers',
    reservations: 'reservations',
    maintenances: 'maintenances',
    incidents: 'incidents',
    accidents: 'accidents',
    fuelLogs: 'fuel_logs',
    users: 'users',
};

// Colonnes autorisées pour la création/mise à jour (camelCase -> snake_case).
const FIELD_MAPS = {
    vehicles: {
        plate: 'plate',
        brand: 'brand',
        model: 'model',
        year: 'year',
        mileage: 'mileage',
        lastOilChangeKm: 'last_oil_change_km',
        nextOilChangeKm: 'next_oil_change_km',
        fuel: 'fuel',
        status: 'status',
        driver: 'driver',
        insuranceExpiry: 'insurance_expiry',
        registrationExpiry: 'registration_expiry',
        technicalControlExpiry: 'technical_control_expiry',
        photo: 'photo',
    },
    drivers: {
        name: 'name',
        email: 'email',
        phone: 'phone',
        license: 'license',
        status: 'status',
        licenseExpiry: 'license_expiry',
        photo: 'photo',
    },
    reservations: {
        vehicleId: 'vehicle_id',
        vehicle: 'vehicle',
        driverId: 'driver_id',
        driver: 'driver',
        start: 'start',
        end: 'end',
        purpose: 'purpose',
        status: 'status',
    },
    maintenances: {
        vehicleId: 'vehicle_id',
        vehicle: 'vehicle',
        type: 'type',
        cost: 'cost',
        date: 'date',
        status: 'status',
        provider: 'provider',
    },
    incidents: {
        vehicleId: 'vehicle_id',
        vehicle: 'vehicle',
        driverId: 'driver_id',
        driver: 'driver',
        title: 'title',
        priority: 'priority',
        date: 'date',
        status: 'status',
        description: 'description',
    },
    accidents: {
        vehicleId: 'vehicle_id',
        vehicle: 'vehicle',
        driverId: 'driver_id',
        driver: 'driver',
        date: 'date',
        location: 'location',
        damage: 'damage',
        thirdParty: 'third_party',
        report: 'report',
        costEstimate: 'cost_estimate',
        status: 'status',
    },
    fuelLogs: {
        vehicleId: 'vehicle_id',
        vehicle: 'vehicle',
        driverId: 'driver_id',
        driver: 'driver',
        date: 'date',
        liters: 'liters',
        cost: 'cost',
        pricePerLiter: 'price_per_liter',
        mileage: 'mileage',
        fuelType: 'fuel_type',
        station: 'station',
        paymentMethod: 'payment_method',
        receiptNumber: 'receipt_number',
        notes: 'notes',
    },
    documents: {
        vehicleId: 'vehicle_id',
        driverId: 'driver_id',
        documentType: 'document_type',
        documentNumber: 'document_number',
        issueDate: 'issue_date',
        expiryDate: 'expiry_date',
        notes: 'notes',
        fileName: 'file_name',
        filePath: 'file_path',
        mimeType: 'mime_type',
        fileSize: 'file_size',
        fileUploadedAt: 'file_uploaded_at',
    },
};

// Colonnes référençant d'autres tables métier (à vérifier qu'elles appartiennent
// bien à la même organisation avant insertion).
const CHILD_REFS = {
    maintenances: ['vehicleId'],
    incidents: ['vehicleId', 'driverId'],
    accidents: ['vehicleId', 'driverId'],
    fuel_logs: ['vehicleId', 'driverId'],
    reservations: ['vehicleId', 'driverId'],
    documents: ['vehicleId', 'driverId'],
};

/** Vérifie qu'une ligne appartient bien à l'organisation (lutte anti fuite inter-tenant). */
async function assertOwned(client, table, id, orgId) {
    const result = await client.query(
        `SELECT 1 FROM ${table} WHERE id = $1 AND organization_id = $2`,
        [id, orgId]
    );
    if (result.rowCount === 0) {
        throw AppError.notFound('La ressource liée n\'existe pas dans votre organisation.');
    }
}

function buildInsert(client, table, { orgId, data }) {
    const row = orgId != null ? { ...data, organization_id: orgId } : data;
    const keys = Object.keys(row);
    const cols = keys.map((k) => `"${k}"`).join(', ');
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    return {
        text: `INSERT INTO ${table} (${cols}) VALUES (${placeholders}) RETURNING *`,
        values: Object.values(row),
    };
}

function buildUpdate(table, { orgId, id, data }) {
    const entries = Object.entries(data);
    if (entries.length === 0) return null;
    const sets = [];
    const params = [];
    let i = 1;
    for (const [key, value] of entries) {
        sets.push(`"${key}" = $${i++}`);
        params.push(value);
    }
    let where;
    if (orgId != null) {
        where = { clause: `organization_id = $${i++} AND id = $${i++}`, params: [orgId, id] };
    } else {
        where = { clause: `id = $${i++}`, params: [id] };
    }
    return {
        text: `UPDATE ${table} SET ${sets.join(', ')} WHERE ${where.clause} RETURNING *`,
        values: [...params, ...where.params],
    };
}

/**
 * CRUD générique paramétré, toujours filtré par organization_id.
 */
function makeCrudRepo(table, fieldMap) {
    const refs = CHILD_REFS[table] || [];

    function sanitize(data) {
        const out = {};
        for (const [camel, column] of Object.entries(fieldMap)) {
            if (data[camel] !== undefined) out[column] = data[camel];
        }
        return out;
    }

    return {
        async findAllByOrg(orgId) {
            const result = await query(
                `SELECT * FROM ${table} WHERE organization_id = $1 ORDER BY id`,
                [orgId]
            );
            return mapRows(result.rows);
        },

        async findById(orgId, id) {
            const result = await query(
                `SELECT * FROM ${table} WHERE organization_id = $1 AND id = $2`,
                [orgId, id]
            );
            return mapRow(result.rows[0] || null);
        },

        /** Crée la ligne dans une transaction (vérifie l'appartenance des références liées). */
        async create(orgId, data) {
            const clean = sanitize(data);
            for (const ref of refs) {
                if (clean[fieldMap[ref]] === '') clean[fieldMap[ref]] = null;
            }
            return withTransaction(async (client) => {
                for (const ref of refs) {
                    if (clean[fieldMap[ref]] != null) {
                        await assertOwned(client, TABLES[ref === 'vehicleId' ? 'vehicles' : 'drivers'], clean[fieldMap[ref]], orgId);
                    }
                }
                const result = await client.query(buildInsert(client, table, { orgId, data: clean }));
                return mapRow(result.rows[0] || null);
            });
        },

        async update(orgId, id, data) {
            const clean = sanitize(data);
            for (const ref of refs) {
                if (clean[fieldMap[ref]] === '') clean[fieldMap[ref]] = null;
            }
            return withTransaction(async (client) => {
                for (const ref of refs) {
                    if (clean[fieldMap[ref]] != null) {
                        await assertOwned(client, TABLES[ref === 'vehicleId' ? 'vehicles' : 'drivers'], clean[fieldMap[ref]], orgId);
                    }
                }
                const built = buildUpdate(table, { orgId, id, data: clean });
                if (!built) {
                    const result = await client.query(
                        `SELECT * FROM ${table} WHERE organization_id = $1 AND id = $2`,
                        [orgId, id]
                    );
                    return mapRow(result.rows[0] || null);
                }
                const result = await client.query(built);
                return mapRow(result.rows[0] || null);
            });
        },

        async remove(orgId, id) {
            const result = await query(
                `DELETE FROM ${table} WHERE organization_id = $1 AND id = $2 RETURNING id`,
                [orgId, id]
            );
            return (result.rowCount ?? 0) > 0;
        },
    };
}

const vehicles = makeCrudRepo('vehicles', FIELD_MAPS.vehicles);
const drivers = makeCrudRepo('drivers', FIELD_MAPS.drivers);
const maintenances = makeCrudRepo('maintenances', FIELD_MAPS.maintenances);
const incidents = makeCrudRepo('incidents', FIELD_MAPS.incidents);
const accidents = makeCrudRepo('accidents', FIELD_MAPS.accidents);
const fuelLogs = makeCrudRepo('fuel_logs', FIELD_MAPS.fuelLogs);

// ============================================================
// Documents (module documentation)
// ============================================================
// CRUD cloisonné par organisation : la création / modification vérifie que
// le véhicule ou le conducteur référencé appartient bien à l'organisation
// (CHILD_REFS). La liste filtrée applique les filtres SQL (véhicule,
// conducteur, type, recherche, plage d'expiration) ; le statut (dérivé de la
// date d'expiration), le tri et la pagination sont calculés côté route.
const documents = makeCrudRepo('documents', FIELD_MAPS.documents);

documents.findAllByOrg = async function findAllByOrg(orgId, filters = {}) {
    const { vehicleId, driverId, documentType, search, expiryFrom, expiryTo } = filters;
    const conditions = ['organization_id = $1'];
    const params = [orgId];
    const param = (value) => {
        params.push(value);
        return `$${params.length}`;
    };
    if (vehicleId != null) conditions.push(`vehicle_id = ${param(vehicleId)}`);
    if (driverId != null) conditions.push(`driver_id = ${param(driverId)}`);
    if (documentType) conditions.push(`document_type = ${param(documentType)}`);
    if (search) {
        conditions.push(
            `(document_number ILIKE ${param(`%${search}%`)} ` +
            `OR notes ILIKE ${param(`%${search}%`)} ` +
            `OR document_type ILIKE ${param(`%${search}%`)})`
        );
    }
    if (expiryFrom) conditions.push(`expiry_date >= ${param(expiryFrom)}`);
    if (expiryTo) conditions.push(`expiry_date <= ${param(expiryTo)}`);
    const result = await query(
        `SELECT * FROM documents WHERE ${conditions.join(' AND ')} ORDER BY id`,
        params
    );
    return mapRows(result.rows);
};

// ============================================================
// Documents — pièces jointes (Phase Documentation, Commit 5)
// ============================================================
// Métadonnées de fichier écrites UNIQUEMENT par le serveur (routes
// /api/documents/:id/file) : le chemin stocké est le chemin interne sûr,
// le nom est le nom original (affichage), jamais utilisé pour construire
// un chemin système. Toujours filtrées par organization_id.
// ============================================================

/** Enregistre (ou remplace) les métadonnées de fichier d'un document. */
documents.setFileMetadata = async function setFileMetadata(orgId, id, meta) {
    const result = await query(
        `UPDATE documents
         SET file_path = $1, file_name = $2, mime_type = $3,
             file_size = $4, file_uploaded_at = $5
         WHERE organization_id = $6 AND id = $7
         RETURNING *`,
        [
            meta.filePath ?? null,
            meta.fileName ?? null,
            meta.mimeType ?? null,
            meta.fileSize ?? null,
            meta.fileUploadedAt ?? null,
            orgId,
            id,
        ]
    );
    return mapRow(result.rows[0] || null);
};

/** Efface les métadonnées de fichier (sans toucher au document). */
documents.clearFileMetadata = async function clearFileMetadata(orgId, id) {
    return documents.setFileMetadata(orgId, id, {
        filePath: null,
        fileName: null,
        mimeType: null,
        fileSize: null,
        fileUploadedAt: null,
    });
};

// ============================================================
// Budgets carburant (Phase 7.3) — un budget par organisation et par mois
// ============================================================
const fuelBudgets = {
    async findAllByOrg(orgId) {
        const result = await query(
            'SELECT * FROM fuel_budgets WHERE organization_id = $1 ORDER BY month DESC, id DESC',
            [orgId]
        );
        return mapRows(result.rows);
    },

    async findById(orgId, id) {
        const result = await query(
            'SELECT * FROM fuel_budgets WHERE organization_id = $1 AND id = $2',
            [orgId, id]
        );
        return mapRow(result.rows[0] || null);
    },

    /** Crée ou met à jour (upsert) le budget d'un mois donné. */
    async upsert(orgId, month, amount) {
        const result = await query(
            `INSERT INTO fuel_budgets (organization_id, month, amount)
             VALUES ($1, $2, $3)
             ON CONFLICT (organization_id, month)
             DO UPDATE SET amount = EXCLUDED.amount, updated_at = NOW()
             RETURNING *`,
            [orgId, month, amount]
        );
        return mapRow(result.rows[0] || null);
    },

    async remove(orgId, id) {
        const result = await query(
            'DELETE FROM fuel_budgets WHERE organization_id = $1 AND id = $2 RETURNING id',
            [orgId, id]
        );
        return (result.rowCount ?? 0) > 0;
    },
};

// ============================================================
// Réservations (avec détection de conflit en base)
// ============================================================

const CONFLICT_SQL = `
    SELECT * FROM reservations
    WHERE organization_id = $1
      AND vehicle_id = $2
      AND status NOT IN ('REJECTED', 'CANCELLED')
      AND ($3::timestamptz, $4::timestamptz) OVERLAPS (start, COALESCE("end", start))
`;

async function findConflict(orgId, vehicleId, start, end, excludeId = null) {
    const effectiveEnd = end || start;
    const params = [orgId, vehicleId, start, effectiveEnd];
    if (excludeId != null) {
        params.push(excludeId);
        const result = await query(`${CONFLICT_SQL} AND id <> $5 LIMIT 1`, params);
        return mapRow(result.rows[0] || null);
    }
    const result = await query(`${CONFLICT_SQL} LIMIT 1`, params);
    return mapRow(result.rows[0] || null);
}

const reservations = {
    async findAllByOrg(orgId) {
        const result = await query(
            'SELECT * FROM reservations WHERE organization_id = $1 ORDER BY id',
            [orgId]
        );
        return mapRows(result.rows);
    },

    async findById(orgId, id) {
        const result = await query(
            'SELECT * FROM reservations WHERE organization_id = $1 AND id = $2',
            [orgId, id]
        );
        return mapRow(result.rows[0] || null);
    },

    /**
     * Création avec détection de conflit atomique : la vérification de chevauchement
     * et l'insertion se font dans la même transaction.
     */
    async create(orgId, data) {
        const clean = {};
        for (const [camel, column] of Object.entries(FIELD_MAPS.reservations)) {
            if (data[camel] !== undefined) clean[column] = data[camel];
        }
        return withTransaction(async (client) => {
            if (clean.vehicle_id != null) {
                await assertOwned(client, 'vehicles', clean.vehicle_id, orgId);
            }
            if (clean.driver_id === '') clean.driver_id = null;
            if (clean.driver_id != null) {
                await assertOwned(client, 'drivers', clean.driver_id, orgId);
            }
            const effectiveEnd = clean.end || clean.start;
            const conflict = await findConflict(orgId, clean.vehicle_id, clean.start, effectiveEnd);
            if (conflict) {
                throw AppError.conflict(
                    'Conflit de planning : ce véhicule est déjà réservé sur ce créneau.',
                    conflict
                );
            }
            const result = await client.query(buildInsert(client, 'reservations', { orgId, data: clean }));
            return mapRow(result.rows[0] || null);
        });
    },

    async update(orgId, id, data) {
        const clean = {};
        for (const [camel, column] of Object.entries(FIELD_MAPS.reservations)) {
            if (data[camel] !== undefined) clean[column] = data[camel];
        }
        return withTransaction(async (client) => {
            const existing = await client.query(
                'SELECT * FROM reservations WHERE organization_id = $1 AND id = $2',
                [orgId, id]
            );
            const current = existing.rows[0];
            if (!current) {
                throw AppError.notFound('Réservation introuvable.');
            }
            if (clean.vehicle_id != null) {
                await assertOwned(client, 'vehicles', clean.vehicle_id, orgId);
            }
            if (clean.driver_id === '') clean.driver_id = null;
            if (clean.driver_id != null) {
                await assertOwned(client, 'drivers', clean.driver_id, orgId);
            }
            const vehicleId = clean.vehicle_id ?? current.vehicle_id;
            const start = clean.start ?? current.start;
            const end = clean.end !== undefined ? clean.end : current.end;
            if (vehicleId != null && start != null) {
                const conflict = await findConflict(orgId, vehicleId, start, end || start, id);
                if (conflict) {
                    throw AppError.conflict(
                        'Conflit de planning : ce véhicule est déjà réservé sur ce créneau.',
                        conflict
                    );
                }
            }
            const built = buildUpdate('reservations', { orgId, id, data: clean });
            if (!built) return mapRow(current);
            const result = await client.query(built);
            return mapRow(result.rows[0] || null);
        });
    },

    async approve(orgId, id) {
        const result = await query(
            `UPDATE reservations SET status = 'APPROVED'
             WHERE organization_id = $1 AND id = $2 RETURNING *`,
            [orgId, id]
        );
        return mapRow(result.rows[0] || null);
    },

    async remove(orgId, id) {
        const result = await query(
            'DELETE FROM reservations WHERE organization_id = $1 AND id = $2 RETURNING id',
            [orgId, id]
        );
        return (result.rowCount ?? 0) > 0;
    },
};

// ============================================================
// Utilisateurs
// ============================================================

const USER_SAFE_COLUMNS = 'id, username, name, role, title, organization_id, created_at';

const USER_FIELD_MAP = {
    username: 'username',
    passwordHash: 'password_hash',
    name: 'name',
    role: 'role',
    title: 'title',
};

function sanitizeUser(data) {
    const out = {};
    for (const [camel, column] of Object.entries(USER_FIELD_MAP)) {
        if (data[camel] !== undefined) out[column] = data[camel];
    }
    return out;
}

const users = {
    async findAllByOrg(orgId) {
        const result = await query(
            `SELECT ${USER_SAFE_COLUMNS} FROM users WHERE organization_id = $1 ORDER BY id`,
            [orgId]
        );
        return mapRows(result.rows);
    },

    async findById(orgId, id) {
        const result = await query(
            `SELECT ${USER_SAFE_COLUMNS} FROM users WHERE organization_id = $1 AND id = $2`,
            [orgId, id]
        );
        return mapRow(result.rows[0] || null);
    },

    /** Avec mot de passe (réservé à l'authentification). */
    async findByUsername(username) {
        const result = await query('SELECT * FROM users WHERE username = $1', [username]);
        return mapRow(result.rows[0] || null);
    },

    async create(data) {
        const clean = sanitizeUser(data);
        const built = buildInsert(null, 'users', { orgId: data.organizationId, data: clean });
        const result = await query(built);
        return mapRow(result.rows[0] || null);
    },

    async update(orgId, id, data) {
        const clean = sanitizeUser(data);
        const built = buildUpdate('users', { orgId, id, data: clean });
        if (!built) return this.findById(orgId, id);
        const result = await query(built);
        return mapRow(result.rows[0] || null);
    },

    async remove(orgId, id) {
        const result = await query(
            'DELETE FROM users WHERE organization_id = $1 AND id = $2 RETURNING id',
            [orgId, id]
        );
        return (result.rowCount ?? 0) > 0;
    },

    async countAdminsInOrg(orgId) {
        const result = await query(
            `SELECT COUNT(*) AS count FROM users
             WHERE organization_id = $1 AND role = 'ADMIN'`,
            [orgId]
        );
        return parseInt(result.rows[0].count, 10);
    },
};

// ============================================================
// Organisations
// ============================================================

const organizations = {
    async findAllWithCounts() {
        const result = await query(
            `SELECT o.*,
                    COUNT(DISTINCT u.id) AS user_count,
                    COUNT(DISTINCT v.id) AS vehicle_count
             FROM organizations o
             LEFT JOIN users u ON u.organization_id = o.id
             LEFT JOIN vehicles v ON v.organization_id = o.id
             GROUP BY o.id
             ORDER BY o.id`
        );
        return mapRows(result.rows);
    },

    async findById(orgId) {
        const result = await query('SELECT * FROM organizations WHERE id = $1', [orgId]);
        return mapRow(result.rows[0] || null);
    },

    /**
     * Création atomique d'un client : l'organisation + son premier administrateur
     * + son abonnement par défaut (plan STARTER, période d'essai configurable).
     * Le plan peut être précisé via planId ; sinon le plan STARTER est utilisé.
     */
    async createWithAdmin({ name, adminName, adminUsername, adminPasswordHash, planId = null }) {
        return withTransaction(async (client) => {
            const orgResult = await client.query(
                `INSERT INTO organizations (name) VALUES ($1) RETURNING *`,
                [name]
            );
            const org = mapRow(orgResult.rows[0]);
            const userResult = await client.query(
                `INSERT INTO users (username, password_hash, name, role, title, organization_id)
                 VALUES ($1, $2, $3, 'ADMIN', 'Administrateur', $4) RETURNING id, username, name, role, title, organization_id, created_at`,
                [adminUsername, adminPasswordHash, adminName, org.id]
            );
            const admin = mapRow(userResult.rows[0]);

            // Plan par défaut : STARTER (ou celui demandé), toujours en période d'essai.
            let plan = null;
            if (planId) {
                const planRes = await client.query('SELECT * FROM plans WHERE id = $1', [planId]);
                plan = planRes.rows[0];
            }
            if (!plan) {
                const planRes = await client.query(
                    `SELECT * FROM plans WHERE code = 'STARTER' ORDER BY id LIMIT 1`
                );
                plan = planRes.rows[0];
            }
            if (!plan) {
                throw AppError.internal('Aucun plan par défaut disponible.');
            }

            const start = new Date().toISOString().slice(0, 10);
            const end = addDays(start, config.trialDays);
            const subscription = await subscriptionsRepo.createOnClient(client, org.id, {
                planId: plan.id,
                status: 'TRIAL',
                startDate: start,
                endDate: end,
                trialEndsAt: end,
                autoRenew: false,
                changeType: 'TRIAL_STARTED',
                reason: `Période d'essai de ${config.trialDays} jours.`,
            });

            return {
                organization: org,
                admin,
                subscription,
            };
        });
    },

    /**
     * Suppression atomique d'un client : les tables filles sont supprimées
     * (CASCADE) puis l'organisation elle-même.
     */
    async remove(orgId) {
        return withTransaction(async (client) => {
            const result = await client.query(
                'DELETE FROM organizations WHERE id = $1 RETURNING id',
                [orgId]
            );
            return (result.rowCount ?? 0) > 0;
        });
    },

    async findUsersByOrg(orgId) {
        const result = await query(
            `SELECT ${USER_SAFE_COLUMNS} FROM users WHERE organization_id = $1 ORDER BY id`,
            [orgId]
        );
        return mapRows(result.rows);
    },

    async resetPassword(userId, passwordHash) {
        const result = await query(
            'UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING id, username',
            [passwordHash, userId]
        );
        return mapRow(result.rows[0] || null);
    },
};

module.exports = {
    vehicles,
    drivers,
    reservations,
    maintenances,
    incidents,
    accidents,
    fuelLogs,
    documents,
    fuelBudgets,
    users,
    organizations,
    findConflict,
    assertOwned,
};
