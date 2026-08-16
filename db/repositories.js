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
// Ventes de véhicules (Phase 7.7)
// ============================================================
// CRUD cloisonné par organisation. Règles métier appliquées côté serveur :
//   - sale_number auto-généré (VS-AAAA-NNNNNN, unique par organisation et par
//     année), jamais fourni par le client ;
//   - total_price TOUJOURS recalculé = price + tax + fees (le client ne peut
//     pas imposer un montant différent de la somme) ;
//   - instantanés « vehicle » et « buyer_name » remplis depuis les tables
//     liées quand l'écran n'en fournit pas (dénormalisation de confort) ;
//   - appartenance vérifiée pour vehicle_id / buyer_id / broker_id /
//     salesperson_id (anti fuite inter-tenant) ;
//   - un acheteur est exigé (buyer_id OU buyer_name), comme en base ;
//   - le montant déjà payé (paid_amount) ne peut pas dépasser le prix total.
const SALES_FIELD_MAP = {
    vehicleId: 'vehicle_id',
    vehicle: 'vehicle',
    title: 'title',
    description: 'description',
    mileage: 'mileage',
    year: 'year',
    buyerId: 'buyer_id',
    buyerType: 'buyer_type',
    buyerName: 'buyer_name',
    buyerPhone: 'buyer_phone',
    buyerEmail: 'buyer_email',
    buyerAddress: 'buyer_address',
    buyerIdCard: 'buyer_id_card',
    brokerId: 'broker_id',
    salespersonId: 'salesperson_id',
    saleDate: 'sale_date',
    currency: 'currency',
    price: 'price',
    tax: 'tax',
    fees: 'fees',
    paymentMethod: 'payment_method',
    paymentStatus: 'payment_status',
    paidAmount: 'paid_amount',
    deliveryStatus: 'delivery_status',
    deliveryDate: 'delivery_date',
    status: 'status',
    notes: 'notes',
    fileName: 'file_name',
    filePath: 'file_path',
    mimeType: 'mime_type',
    fileSize: 'file_size',
    fileUploadedAt: 'file_uploaded_at',
};

function sanitizeSale(data) {
    const out = {};
    for (const [camel, column] of Object.entries(SALES_FIELD_MAP)) {
        if (data[camel] !== undefined) out[column] = data[camel];
    }
    return out;
}

const SALE_REF_COLUMNS = ['vehicle_id', 'buyer_id', 'broker_id', 'salesperson_id'];

function sanitizeSaleRefs(clean) {
    for (const column of SALE_REF_COLUMNS) {
        if (clean[column] === '') clean[column] = null;
    }
}

// Statuts du cycle de vie du véhicule (pilotés par la vente).
const VEHICLE_AVAILABLE = 'AVAILABLE';
const VEHICLE_RESERVED = 'RESERVED';
const VEHICLE_SOLD = 'SOLD';

// Statuts de vente finaux : plus aucun changement de statut possible.
const SALE_FINAL_STATUSES = ['COMPLETED', 'CANCELLED'];

// Statuts du cycle de vie commercial du véhicule (Phase Vente, Commit 5).
const COMMERCIAL_AVAILABLE = 'AVAILABLE';
const COMMERCIAL_FOR_SALE = 'FOR_SALE';
const COMMERCIAL_SOLD = 'SOLD';

// Transitions autorisées de la machine à états commerciale :
//   AVAILABLE -> FOR_SALE (mise en vente)
//   FOR_SALE  -> AVAILABLE (retrait de la vente)
//   FOR_SALE  -> SOLD      (vente conclue, exige la vente concernée)
// Toute autre transition (ex. AVAILABLE -> SOLD) est refusée en 409.
const COMMERCIAL_TRANSITIONS = {
    [COMMERCIAL_AVAILABLE]: [COMMERCIAL_FOR_SALE],
    [COMMERCIAL_FOR_SALE]: [COMMERCIAL_AVAILABLE, COMMERCIAL_SOLD],
    [COMMERCIAL_SOLD]: [],
};

/** Charge le véhicule lié et vérifie son appartenance à l'organisation. */
async function getOwnedVehicle(client, orgId, vehicleId, { forUpdate = false } = {}) {
    const sql = 'SELECT * FROM vehicles WHERE id = $1 AND organization_id = $2' + (forUpdate ? ' FOR UPDATE' : '');
    const result = await client.query(sql, [vehicleId, orgId]);
    if (result.rowCount === 0) {
        throw AppError.notFound('Le véhicule lié n\'existe pas dans votre organisation.');
    }
    return result.rows[0];
}

/** Bloque l'utilisation d'un véhicule déjà réservé ou vendu. */
function requireVehicleAvailable(vehicle) {
    if (vehicle.status === VEHICLE_SOLD) {
        throw AppError.conflict('Ce véhicule est déjà vendu (SOLD) : aucune nouvelle vente n\'est possible.');
    }
    if (vehicle.status === VEHICLE_RESERVED) {
        throw AppError.conflict('Ce véhicule est déjà réservé (RESERVED) par une autre vente en cours.');
    }
}

/** Libellé d'affichage d'un véhicule (instantané dénormalisé). */
function vehicleLabel(vehicle) {
    return [vehicle.plate, vehicle.brand, vehicle.model].filter(Boolean).join(' ');
}

/**
 * Instantanés du véhicule figés dans la vente : libellé, titre, kilométrage et
 * année au moment de la vente. Les valeurs fournies par le client priment ;
 * sinon on copie le véhicule lié. L'historique comptable ne doit pas bouger si
 * le véhicule est ensuite modifié.
 */
function buildVehicleSnapshots(vehicle, clean) {
    const snapshots = {};
    const label = vehicleLabel(vehicle);
    if (!clean.vehicle) snapshots.vehicle = label;
    if (!clean.title) snapshots.title = `Vente ${label}`;
    if (clean.mileage === undefined || clean.mileage === null || clean.mileage === '') {
        snapshots.mileage = vehicle.mileage != null ? Number(vehicle.mileage) : null;
    }
    if (clean.year === undefined || clean.year === null || clean.year === '') {
        snapshots.year = vehicle.year != null ? Number(vehicle.year) : null;
    }
    return snapshots;
}

/**
 * Contrôle les transitions de statut de la vente (machine à états) :
 * COMPLETED et CANCELLED sont terminaux ; les autres transitions (DRAFT /
 * IN_PROGRESS) sont libres.
 */
function assertSaleStatusTransition(currentStatus, newStatus) {
    if (currentStatus === newStatus) return;
    if (SALE_FINAL_STATUSES.includes(currentStatus)) {
        throw AppError.badRequest(
            `Une vente au statut ${currentStatus} est terminée : aucun changement de statut n'est possible.`
        );
    }
}

/** Applique le statut véhicule correspondant à l'état effectif de la vente. */
async function applyVehicleStatusFromSale(client, vehicle, saleStatus) {
    if (saleStatus === 'COMPLETED') {
        if (vehicle.status !== VEHICLE_SOLD) {
            await client.query('UPDATE vehicles SET status = $1 WHERE id = $2', [VEHICLE_SOLD, vehicle.id]);
        }
    } else if (saleStatus === 'CANCELLED') {
        if (vehicle.status === VEHICLE_RESERVED) {
            await client.query('UPDATE vehicles SET status = $1 WHERE id = $2', [VEHICLE_AVAILABLE, vehicle.id]);
        }
    } else if (vehicle.status === VEHICLE_AVAILABLE) {
        await client.query('UPDATE vehicles SET status = $1 WHERE id = $2', [VEHICLE_RESERVED, vehicle.id]);
    }
}

/**
 * Applique le cycle de vie commercial du véhicule (Phase Vente, Commit 5) :
 * statut commercial AVAILABLE / FOR_SALE / SOLD, piloté par la route dédiée
 * PATCH /api/vehicles/:id/commercial-status. Les transitions sont contrôlées
 * par la machine à états COMMERCIAL_TRANSITIONS ; le passage à SOLD exige la
 * vente concernée (saleId) : la vente est alors terminée (COMPLETED) et le
 * statut opérationnel du véhicule est synchronisé (SOLD) via
 * applyVehicleStatusFromSale. Retourne null si le véhicule n'appartient pas
 * à l'organisation, sinon le véhicule mis à jour.
 */
vehicles.setCommercialStatus = async function setCommercialStatus(orgId, vehicleId, { status, saleId }) {
    return withTransaction(async (client) => {
        const lock = await client.query(
            'SELECT * FROM vehicles WHERE organization_id = $1 AND id = $2 FOR UPDATE',
            [orgId, vehicleId]
        );
        const vehicle = lock.rows[0];
        if (!vehicle) return null;

        const current = vehicle.commercial_status || COMMERCIAL_AVAILABLE;
        if (status !== current && !COMMERCIAL_TRANSITIONS[current].includes(status)) {
            throw AppError.conflict(
                `Transition de statut commercial interdite : ${current} → ${status}.`
            );
        }

        if (status === COMMERCIAL_SOLD) {
            const sale = await requireOwnedSaleForVehicle(client, orgId, saleId, vehicleId);
            if (sale.status === 'CANCELLED') {
                throw AppError.conflict(
                    'La vente sélectionnée est annulée : impossible de marquer le véhicule comme vendu.'
                );
            }
            if (sale.status !== 'COMPLETED') {
                if (!sale.buyer_id && !sale.buyer_name) {
                    throw AppError.badRequest(
                        'La vente doit comporter un acheteur (buyerId ou buyerName) avant de marquer le véhicule comme vendu.'
                    );
                }
                if (!sale.price || Number(sale.price) <= 0) {
                    throw AppError.badRequest(
                        'La vente doit comporter un prix strictement positif avant de marquer le véhicule comme vendu.'
                    );
                }
                if (sale.paid_amount != null && Number(sale.paid_amount) > Number(sale.total_price || 0)) {
                    throw AppError.badRequest(
                        'Le versement ne peut pas dépasser le prix total de la vente.'
                    );
                }
                await client.query(
                    'UPDATE vehicle_sales SET status = $1 WHERE organization_id = $2 AND id = $3',
                    ['COMPLETED', orgId, sale.id]
                );
            }
            // Synchronise le statut opérationnel du véhicule (SOLD).
            await applyVehicleStatusFromSale(client, vehicle, 'COMPLETED');
        }

        const updated = await client.query(
            'UPDATE vehicles SET commercial_status = $1 WHERE organization_id = $2 AND id = $3 RETURNING *',
            [status, orgId, vehicleId]
        );
        return mapRow(updated.rows[0] || null);
    });
};

/**
 * Vérifie que la vente fournie (saleId) appartient à l'organisation ET porte
 * sur le véhicule donné. Sinon 404 (vente invisible / autre véhicule).
 */
async function requireOwnedSaleForVehicle(client, orgId, saleId, vehicleId) {
    const result = await client.query(
        'SELECT * FROM vehicle_sales WHERE organization_id = $1 AND id = $2',
        [orgId, saleId]
    );
    const sale = result.rows[0];
    if (!sale) {
        throw AppError.notFound('La vente sélectionnée n\'existe pas dans votre organisation.');
    }
    if (Number(sale.vehicle_id) !== Number(vehicleId)) {
        throw AppError.badRequest('La vente sélectionnée ne concerne pas ce véhicule.');
    }
    return sale;
}

/** Nom de l'acheteur interne (instantané dénormalisé depuis drivers). */
async function snapshotBuyerName(client, orgId, buyerId) {
    const result = await client.query(
        'SELECT name FROM drivers WHERE id = $1 AND organization_id = $2',
        [buyerId, orgId]
    );
    if (result.rowCount === 0) {
        throw AppError.notFound('L\'acheteur lié n\'existe pas dans votre organisation.');
    }
    return result.rows[0].name;
}

/** Prochain numéro de vente de l'année : VS-AAAA-000001 (par organisation). */
async function nextSaleNumber(client, orgId, year) {
    const result = await client.query(
        `SELECT COUNT(*) AS count FROM vehicle_sales
         WHERE organization_id = $1 AND EXTRACT(YEAR FROM sale_date) = $2`,
        [orgId, year]
    );
    const n = parseInt(result.rows[0].count, 10) + 1;
    return `VS-${year}-${String(n).padStart(6, '0')}`;
}

/** Vérifie la présence d'un acheteur (interne OU externe). */
function assertBuyerPresent(clean) {
    if (clean.buyer_id == null && !clean.buyer_name) {
        throw AppError.badRequest(
            'Un acheteur est requis : renseignez un acheteur interne (buyerId) ou un acheteur externe (buyerName).'
        );
    }
}

const vehicleSales = {
    async findAllByOrg(orgId, filters = {}) {
        const { status, paymentStatus, deliveryStatus, vehicleId, search, dateFrom, dateTo } = filters;
        const conditions = ['organization_id = $1'];
        const params = [orgId];
        const param = (value) => {
            params.push(value);
            return `$${params.length}`;
        };
        if (status) conditions.push(`status = ${param(status)}`);
        if (paymentStatus) conditions.push(`payment_status = ${param(paymentStatus)}`);
        if (deliveryStatus) conditions.push(`delivery_status = ${param(deliveryStatus)}`);
        if (vehicleId != null) conditions.push(`vehicle_id = ${param(vehicleId)}`);
        if (search) {
            conditions.push(
                `(sale_number ILIKE ${param(`%${search}%`)} ` +
                `OR buyer_name ILIKE ${param(`%${search}%`)} ` +
                `OR buyer_phone ILIKE ${param(`%${search}%`)} ` +
                `OR vehicle ILIKE ${param(`%${search}%`)} ` +
                `OR notes ILIKE ${param(`%${search}%`)})`
            );
        }
        if (dateFrom) conditions.push(`sale_date >= ${param(dateFrom)}`);
        if (dateTo) conditions.push(`sale_date <= ${param(dateTo)}`);
        // Agrégats photos (Phase 7.7 — Commit 4) : nombre de photos et photo
        // principale de chaque vente, pour l'affichage du catalogue sans
        // requête supplémentaire par carte. Jamais la clé de stockage interne.
        const result = await query(
            `SELECT vehicle_sales.*,
                    (SELECT COUNT(*) FROM vehicle_sale_photos p
                     WHERE p.vehicle_sale_id = vehicle_sales.id
                       AND p.organization_id = vehicle_sales.organization_id) AS photo_count,
                    (SELECT id FROM vehicle_sale_photos p
                     WHERE p.vehicle_sale_id = vehicle_sales.id
                       AND p.organization_id = vehicle_sales.organization_id
                       AND p.is_primary = TRUE) AS primary_photo_id
             FROM vehicle_sales WHERE ${conditions.join(' AND ')} ORDER BY id`,
            params
        );
        return mapRows(result.rows);
    },

    async findById(orgId, id) {
        const result = await query(
            'SELECT * FROM vehicle_sales WHERE organization_id = $1 AND id = $2',
            [orgId, id]
        );
        return mapRow(result.rows[0] || null);
    },

    async create(orgId, data) {
        const clean = sanitizeSale(data);
        sanitizeSaleRefs(clean);
        assertBuyerPresent(clean);
        const price = Number(clean.price) || 0;
        const tax = Number(clean.tax) || 0;
        const fees = Number(clean.fees) || 0;
        clean.total_price = price + tax + fees;
        if (clean.paid_amount != null && Number(clean.paid_amount) > clean.total_price) {
            throw AppError.badRequest('Le montant déjà payé (paidAmount) ne peut pas dépasser le prix total.');
        }
        if (clean.currency === undefined) clean.currency = 'XOF';
        if (clean.buyer_type === undefined) clean.buyer_type = clean.buyer_id != null ? 'INTERNAL' : 'EXTERNAL';
        const saleYear = String(clean.sale_date || '').slice(0, 4) || String(new Date().getFullYear());

        // Le numéro de vente peut entrer en collision sous forte concurrence
        // (comptage + insertion) : on relance dans ce cas très rare.
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                return await withTransaction(async (client) => {
                    const vehicle = await getOwnedVehicle(client, orgId, clean.vehicle_id, { forUpdate: true });
                    // Vérifications d'appartenance AVANT l'état de disponibilité :
                    // un acheteur / courtier / vendeur d'une autre organisation
                    // doit être refusé (404) même si le véhicule est réservé.
                    if (clean.buyer_id != null) {
                        await assertOwned(client, 'drivers', clean.buyer_id, orgId);
                        if (!clean.buyer_name) clean.buyer_name = await snapshotBuyerName(client, orgId, clean.buyer_id);
                    }
                    if (clean.broker_id != null) await assertOwned(client, 'drivers', clean.broker_id, orgId);
                    if (clean.salesperson_id != null) await assertOwned(client, 'users', clean.salesperson_id, orgId);
                    requireVehicleAvailable(vehicle);
                    Object.assign(clean, buildVehicleSnapshots(vehicle, clean));
                    clean.sale_number = await nextSaleNumber(client, orgId, saleYear);
                    const result = await client.query(buildInsert(client, 'vehicle_sales', { orgId, data: clean }));
                    // La réservation du véhicule suit la création de la vente.
                    await client.query('UPDATE vehicles SET status = $1 WHERE id = $2', [VEHICLE_RESERVED, vehicle.id]);
                    return mapRow(result.rows[0] || null);
                });
            } catch (err) {
                if (err.code === '23505' && String(err.constraint).includes('org_number')) continue;
                throw err;
            }
        }
        throw AppError.internal('Impossible de générer un numéro de vente unique, réessayez.');
    },

    async update(orgId, id, data) {
        const clean = sanitizeSale(data);
        sanitizeSaleRefs(clean);
        return withTransaction(async (client) => {
            const existing = await client.query(
                'SELECT * FROM vehicle_sales WHERE organization_id = $1 AND id = $2',
                [orgId, id]
            );
            const current = existing.rows[0];
            if (!current) throw AppError.notFound('Vente de véhicule introuvable.');

            const currentStatus = current.status;
            const newStatus = clean.status !== undefined ? clean.status : currentStatus;
            assertSaleStatusTransition(currentStatus, newStatus);

            // Changement de véhicule : libérer l'ancien, vérifier le nouveau.
            const currentVehicleId = current.vehicle_id;
            const newVehicleId = clean.vehicle_id != null ? clean.vehicle_id : currentVehicleId;
            if (newVehicleId !== currentVehicleId) {
                await client.query(
                    'UPDATE vehicles SET status = $1 WHERE id = $2 AND status = $3',
                    [VEHICLE_AVAILABLE, currentVehicleId, VEHICLE_RESERVED]
                );
            }
            const vehicle = await getOwnedVehicle(client, orgId, newVehicleId);
            if (newVehicleId !== currentVehicleId) {
                requireVehicleAvailable(vehicle);
            }

            // Une vente passant à COMPLETED sur un véhicule déjà vendu est incohérente.
            if (newStatus === 'COMPLETED' && currentStatus !== 'COMPLETED' && vehicle.status === VEHICLE_SOLD) {
                throw AppError.conflict('Ce véhicule a déjà été vendu (SOLD) : la vente ne peut pas être terminée.');
            }

            // Instantanés figés du véhicule (rafraîchis uniquement si le
            // véhicule change : l'historique comptable ne doit pas bouger).
            if (newVehicleId !== currentVehicleId) {
                Object.assign(clean, buildVehicleSnapshots(vehicle, clean));
            }

            if (clean.buyer_id != null && clean.buyer_id !== current.buyer_id) {
                await assertOwned(client, 'drivers', clean.buyer_id, orgId);
                if (!clean.buyer_name) clean.buyer_name = await snapshotBuyerName(client, orgId, clean.buyer_id);
            }
            if (clean.broker_id != null) await assertOwned(client, 'drivers', clean.broker_id, orgId);
            if (clean.salesperson_id != null) await assertOwned(client, 'users', clean.salesperson_id, orgId);

            // Un acheteur doit toujours rester défini après la mise à jour.
            const buyerId = clean.buyer_id !== undefined ? clean.buyer_id : current.buyer_id;
            const buyerName = clean.buyer_name !== undefined ? clean.buyer_name : current.buyer_name;
            if (buyerId == null && !buyerName) {
                throw AppError.badRequest(
                    'Un acheteur est requis : renseignez un acheteur interne (buyerId) ou un acheteur externe (buyerName).'
                );
            }

            // Le type d'acheteur suit les changements d'acheteur, sauf si le
            // client le précise explicitement.
            if (clean.buyer_type === undefined && (clean.buyer_id !== undefined || clean.buyer_name !== undefined)) {
                clean.buyer_type = clean.buyer_id != null ? 'INTERNAL' : 'EXTERNAL';
            }
            const buyerType = clean.buyer_type !== undefined ? clean.buyer_type : current.buyer_type;
            if (buyerType === 'INTERNAL' && buyerId == null) {
                throw AppError.badRequest('Un acheteur interne (buyerType INTERNAL) exige un buyerId.');
            }
            if (buyerType === 'EXTERNAL' && !buyerName) {
                throw AppError.badRequest('Un acheteur externe (buyerType EXTERNAL) exige un buyerName.');
            }

            // Recalcul systématique du total avec les valeurs effectives.
            const price = clean.price !== undefined ? Number(clean.price) : Number(current.price) || 0;
            const tax = clean.tax !== undefined ? Number(clean.tax) : Number(current.tax) || 0;
            const fees = clean.fees !== undefined ? Number(clean.fees) : Number(current.fees) || 0;
            clean.total_price = price + tax + fees;
            if (price <= 0) {
                throw AppError.badRequest('Le champ "price" doit être strictement positif.');
            }
            if (clean.paid_amount !== undefined && Number(clean.paid_amount) > clean.total_price) {
                throw AppError.badRequest('Le montant déjà payé (paidAmount) ne peut pas dépasser le prix total.');
            }

            const built = buildUpdate('vehicle_sales', { orgId, id, data: clean });
            if (!built) {
                await applyVehicleStatusFromSale(client, vehicle, newStatus);
                return mapRow(current);
            }
            const result = await client.query(built);
            await applyVehicleStatusFromSale(client, vehicle, newStatus);
            return mapRow(result.rows[0] || null);
        });
    },

    async remove(orgId, id) {
        return withTransaction(async (client) => {
            const existing = await client.query(
                'SELECT * FROM vehicle_sales WHERE organization_id = $1 AND id = $2',
                [orgId, id]
            );
            const current = existing.rows[0];
            if (!current) return false;
            // L'historique comptable d'une vente terminée est intouchable.
            if (current.status === 'COMPLETED') {
                throw AppError.badRequest(
                    'Une vente terminée (COMPLETED) ne peut pas être supprimée : elle fait partie de l\'historique comptable.'
                );
            }
            const result = await client.query(
                'DELETE FROM vehicle_sales WHERE organization_id = $1 AND id = $2 RETURNING id',
                [orgId, id]
            );
            if ((result.rowCount ?? 0) > 0 && current.vehicle_id != null) {
                // Libère le véhicule si la vente l'avait réservé.
                await client.query(
                    'UPDATE vehicles SET status = $1 WHERE id = $2 AND status = $3',
                    [VEHICLE_AVAILABLE, current.vehicle_id, VEHICLE_RESERVED]
                );
            }
            return (result.rowCount ?? 0) > 0;
        });
    },
};

// ============================================================
// Photos des ventes de véhicules (Phase 7.7 — Commit 4)
// ============================================================
// CRUD cloisonné par organisation. Les métadonnées (storage_key, nom
// original, type MIME, taille) sont écrites UNIQUEMENT par le serveur
// (routes /api/vehicle-sales/:saleId/photos). La photo principale
// (is_primary) est unique par vente et l'ordre d'affichage (sort_order)
// est piloté côté serveur. La clé de stockage interne n'est jamais
// retournée au client (stripStorageKey dans les routes).
// ============================================================

/** Colonnes publiques d'une photo (sans la clé de stockage interne). */
const PHOTO_PUBLIC_COLUMNS =
    'id, vehicle_sale_id, original_name, mime_type, size_bytes, is_primary, sort_order, created_at';

const vehicleSalePhotos = {
    /** Photos d'une vente, ordonnées pour l'affichage (sort_order, id). */
    async listBySale(orgId, saleId) {
        const result = await query(
            `SELECT ${PHOTO_PUBLIC_COLUMNS} FROM vehicle_sale_photos
             WHERE organization_id = $1 AND vehicle_sale_id = $2
             ORDER BY sort_order, id`,
            [orgId, saleId]
        );
        return mapRows(result.rows);
    },

    async findById(orgId, id) {
        const result = await query(
            `SELECT ${PHOTO_PUBLIC_COLUMNS} FROM vehicle_sale_photos
             WHERE organization_id = $1 AND id = $2`,
            [orgId, id]
        );
        return mapRow(result.rows[0] || null);
    },

    /** Clés de stockage internes des photos d'une vente (nettoyage disque). */
    async listStorageKeysBySale(orgId, saleId) {
        const result = await query(
            'SELECT storage_key FROM vehicle_sale_photos WHERE organization_id = $1 AND vehicle_sale_id = $2',
            [orgId, saleId]
        );
        return result.rows.map((r) => r.storage_key);
    },

    /** Clé de stockage et attribut « photo principale » d'une photo donnée. */
    async findStorageKey(orgId, id) {
        const result = await query(
            'SELECT storage_key, is_primary, vehicle_sale_id FROM vehicle_sale_photos WHERE organization_id = $1 AND id = $2',
            [orgId, id]
        );
        return mapRow(result.rows[0] || null);
    },

    /**
     * Enregistre une photo fraîchement écrite sur disque. La première photo
     * de la vente devient automatiquement la photo principale. Le sort_order
     * suit l'ordre d'insertion (max + 1).
     */
    async create(orgId, saleId, meta) {
        return withTransaction(async (client) => {
            const sale = await client.query(
                'SELECT 1 FROM vehicle_sales WHERE organization_id = $1 AND id = $2 FOR UPDATE',
                [orgId, saleId]
            );
            if (sale.rowCount === 0) {
                throw AppError.notFound('La vente liée n\'existe pas dans votre organisation.');
            }
            const existing = await client.query(
                'SELECT COUNT(*) AS count, COALESCE(MAX(sort_order), 0) AS max_sort FROM vehicle_sale_photos WHERE organization_id = $1 AND vehicle_sale_id = $2',
                [orgId, saleId]
            );
            const count = parseInt(existing.rows[0].count, 10) || 0;
            const maxSort = parseInt(existing.rows[0].max_sort, 10) || 0;
            const isPrimary = count === 0;
            const result = await client.query(
                `INSERT INTO vehicle_sale_photos
                   (vehicle_sale_id, storage_key, original_name, mime_type, size_bytes, is_primary, sort_order, organization_id)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 RETURNING ${PHOTO_PUBLIC_COLUMNS}`,
                [saleId, meta.storageKey, meta.originalName, meta.mimeType, meta.sizeBytes, isPrimary, maxSort + 1, orgId]
            );
            return mapRow(result.rows[0] || null);
        });
    },

    /**
     * Supprime une photo (ligne en base) et renvoie ce qu'il faut nettoyer
     * sur disque. Si la photo supprimée était la principale, la photo
     * restante la plus proche (sort_order le plus petit) devient principale.
     */
    async remove(orgId, id) {
        return withTransaction(async (client) => {
            const existing = await client.query(
                'SELECT * FROM vehicle_sale_photos WHERE organization_id = $1 AND id = $2',
                [orgId, id]
            );
            const photo = existing.rows[0];
            if (!photo) return null;
            await client.query(
                'DELETE FROM vehicle_sale_photos WHERE organization_id = $1 AND id = $2',
                [orgId, id]
            );
            if (photo.is_primary) {
                await client.query(
                    `UPDATE vehicle_sale_photos SET is_primary = TRUE
                     WHERE id = (
                         SELECT id FROM vehicle_sale_photos
                         WHERE organization_id = $1 AND vehicle_sale_id = $2
                         ORDER BY sort_order, id LIMIT 1
                     )`,
                    [orgId, photo.vehicle_sale_id]
                );
            }
            return mapRow(photo);
        });
    },

    /**
     * Définit la photo principale d'une vente (unique par vente). La photo
     * doit appartenir à la vente et à l'organisation.
     */
    async setPrimary(orgId, saleId, id) {
        return withTransaction(async (client) => {
            const target = await client.query(
                'SELECT 1 FROM vehicle_sale_photos WHERE organization_id = $1 AND vehicle_sale_id = $2 AND id = $3',
                [orgId, saleId, id]
            );
            if (target.rowCount === 0) {
                throw AppError.notFound('Photo introuvable pour cette vente.');
            }
            await client.query(
                'UPDATE vehicle_sale_photos SET is_primary = FALSE WHERE organization_id = $1 AND vehicle_sale_id = $2',
                [orgId, saleId]
            );
            const result = await client.query(
                `UPDATE vehicle_sale_photos SET is_primary = TRUE
                 WHERE organization_id = $1 AND id = $2
                 RETURNING ${PHOTO_PUBLIC_COLUMNS}`,
                [orgId, id]
            );
            return mapRow(result.rows[0] || null);
        });
    },

    /**
     * Réordonne les photos d'une vente selon la liste d'identifiants fournie.
     * Tous les identifiants doivent appartenir à la vente et à l'organisation.
     */
    async reorder(orgId, saleId, photoIds) {
        return withTransaction(async (client) => {
            const existing = await client.query(
                'SELECT id FROM vehicle_sale_photos WHERE organization_id = $1 AND vehicle_sale_id = $2',
                [orgId, saleId]
            );
            const owned = new Set(existing.rows.map((r) => r.id));
            if (photoIds.length === 0 || photoIds.length !== owned.size || photoIds.some((id) => !owned.has(id))) {
                throw AppError.badRequest('La liste d\'ordre des photos est invalide.');
            }
            for (let i = 0; i < photoIds.length; i++) {
                await client.query(
                    'UPDATE vehicle_sale_photos SET sort_order = $1 WHERE organization_id = $2 AND id = $3',
                    [i + 1, orgId, photoIds[i]]
                );
            }
            const result = await client.query(
                `SELECT ${PHOTO_PUBLIC_COLUMNS} FROM vehicle_sale_photos
                 WHERE organization_id = $1 AND vehicle_sale_id = $2
                 ORDER BY sort_order, id`,
                [orgId, saleId]
            );
            return mapRows(result.rows);
        });
    },
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

async function findConflict(orgId, vehicleId, start, end, excludeId = null, client = null) {
    const effectiveEnd = end || start;
    const params = [orgId, vehicleId, start, effectiveEnd];
    const exec = client || query;
    if (excludeId != null) {
        params.push(excludeId);
        const result = await exec(`${CONFLICT_SQL} AND id <> $5 FOR UPDATE LIMIT 1`, params);
        return mapRow(result.rows[0] || null);
    }
    const result = await exec(`${CONFLICT_SQL} FOR UPDATE LIMIT 1`, params);
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
            const conflict = await findConflict(orgId, clean.vehicle_id, clean.start, effectiveEnd, null, client);
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
                const conflict = await findConflict(orgId, vehicleId, start, end || start, id, client);
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

    async resetPassword(orgId, userId, passwordHash) {
        const result = await query(
            'UPDATE users SET password_hash = $1 WHERE id = $2 AND organization_id = $3 RETURNING id, username',
            [passwordHash, userId, orgId]
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
    vehicleSales,
    vehicleSalePhotos,
    fuelBudgets,
    users,
    organizations,
    findConflict,
    assertOwned,
};
