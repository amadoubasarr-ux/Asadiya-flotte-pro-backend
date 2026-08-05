/**
 * Import one-time des données de data/db.json vers PostgreSQL.
 *
 * Usage :  node scripts/migrate-from-json.js
 *
 * - Préserve les identifiants existants puis resynchronise les séquences.
 * - Idempotent côté schéma (CREATE IF NOT EXISTS), mais réinsère les lignes :
 *   à lancer une seule fois sur une base vide.
 * - Toute l'opération est atomique (transaction unique).
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { withTransaction } = require('../db/pool');
const { migrate } = require('../db/migrate');

const DB_PATH = path.join(__dirname, '..', 'data', 'db.json');

// [clé db.json (camelCase), colonne SQL]
// `dbKey`: nom de la collection dans db.json ; `table`: nom de la table SQL.
const TABLES = [
    {
        dbKey: 'organizations', table: 'organizations',
        cols: [['id', 'id'], ['name', 'name'], ['createdAt', 'created_at']],
    },
    {
        dbKey: 'users', table: 'users',
        cols: [
            ['id', 'id'], ['username', 'username'], ['passwordHash', 'password_hash'],
            ['name', 'name'], ['role', 'role'], ['title', 'title'],
            ['organizationId', 'organization_id'], ['createdAt', 'created_at'],
        ],
    },
    {
        dbKey: 'vehicles', table: 'vehicles',
        cols: [
            ['id', 'id'], ['plate', 'plate'], ['brand', 'brand'], ['model', 'model'],
            ['year', 'year'], ['mileage', 'mileage'],
            ['lastOilChangeKm', 'last_oil_change_km'], ['nextOilChangeKm', 'next_oil_change_km'],
            ['fuel', 'fuel'], ['status', 'status'], ['driver', 'driver'],
            ['insuranceExpiry', 'insurance_expiry'], ['registrationExpiry', 'registration_expiry'],
            ['technicalControlExpiry', 'technical_control_expiry'], ['photo', 'photo'],
            ['organizationId', 'organization_id'],
        ],
    },
    {
        dbKey: 'drivers', table: 'drivers',
        cols: [
            ['id', 'id'], ['name', 'name'], ['email', 'email'], ['phone', 'phone'],
            ['license', 'license'], ['status', 'status'], ['licenseExpiry', 'license_expiry'],
            ['photo', 'photo'], ['organizationId', 'organization_id'],
        ],
    },
    {
        dbKey: 'reservations', table: 'reservations',
        cols: [
            ['id', 'id'], ['vehicleId', 'vehicle_id'], ['vehicle', 'vehicle'],
            ['driverId', 'driver_id'], ['driver', 'driver'], ['start', 'start'],
            ['end', 'end'], ['purpose', 'purpose'], ['status', 'status'],
            ['organizationId', 'organization_id'],
        ],
    },
    {
        dbKey: 'maintenances', table: 'maintenances',
        cols: [
            ['id', 'id'], ['vehicleId', 'vehicle_id'], ['vehicle', 'vehicle'], ['type', 'type'],
            ['cost', 'cost'], ['date', 'date'], ['status', 'status'], ['provider', 'provider'],
            ['organizationId', 'organization_id'],
        ],
    },
    {
        dbKey: 'incidents', table: 'incidents',
        cols: [
            ['id', 'id'], ['vehicleId', 'vehicle_id'], ['vehicle', 'vehicle'],
            ['driverId', 'driver_id'], ['driver', 'driver'], ['title', 'title'],
            ['priority', 'priority'], ['date', 'date'], ['status', 'status'],
            ['description', 'description'], ['organizationId', 'organization_id'],
        ],
    },
    {
        dbKey: 'accidents', table: 'accidents',
        cols: [
            ['id', 'id'], ['vehicleId', 'vehicle_id'], ['vehicle', 'vehicle'],
            ['driverId', 'driver_id'], ['driver', 'driver'], ['date', 'date'],
            ['location', 'location'], ['damage', 'damage'], ['thirdParty', 'third_party'],
            ['report', 'report'], ['costEstimate', 'cost_estimate'], ['status', 'status'],
            ['organizationId', 'organization_id'],
        ],
    },
    {
        dbKey: 'fuelLogs', table: 'fuel_logs',
        cols: [
            ['id', 'id'], ['vehicleId', 'vehicle_id'], ['vehicle', 'vehicle'],
            ['date', 'date'], ['liters', 'liters'], ['cost', 'cost'], ['mileage', 'mileage'],
            ['organizationId', 'organization_id'],
        ],
    },
];

function buildRow(dbRow, cols) {
    const columns = [];
    const values = [];
    for (const [dbKey, column] of cols) {
        const value = dbRow[dbKey];
        if (value === undefined) continue;
        columns.push(`"${column}"`);
        values.push(value === '' ? null : value);
    }
    return { columns, values };
}

async function main() {
    if (!fs.existsSync(DB_PATH)) {
        console.error(`[import] Fichier introuvable : ${DB_PATH}`);
        process.exit(1);
    }
    const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));

    await migrate();
    console.log('[import] Schéma prêt.');

    const summary = await withTransaction(async (client) => {
        const counts = {};
        for (const { dbKey, table, cols } of TABLES) {
            const rows = data[dbKey] || [];
            for (const dbRow of rows) {
                const { columns, values } = buildRow(dbRow, cols);
                const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
                await client.query(
                    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`,
                    values
                );
            }
            await client.query(
                `SELECT setval(pg_get_serial_sequence('${table}', 'id'), GREATEST(COALESCE(MAX(id), 1), 1)) FROM ${table}`
            );
            counts[table] = rows.length;
        }
        return counts;
    });

    console.log('[import] Terminé :', JSON.stringify(summary, null, 2));
    console.log('[import] Pensez à renseigner DATABASE_URL dans .env puis à lancer le serveur.');
}

main().catch((err) => {
    console.error('[import] Échec de l\'import :');
    console.error(err.message);
    process.exit(1);
});
