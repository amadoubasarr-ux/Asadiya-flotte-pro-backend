const { pool } = require('./pool');

// Schéma PostgreSQL normalisé.
// Toutes les tables sont créées de façon idempotente (CREATE ... IF NOT EXISTS),
// le serveur les crée automatiquement au démarrage.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS organizations (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
    id              SERIAL PRIMARY KEY,
    username        TEXT NOT NULL UNIQUE,
    password_hash   TEXT NOT NULL,
    name            TEXT NOT NULL,
    role            TEXT NOT NULL CHECK (role IN ('SUPERADMIN', 'ADMIN', 'MANAGER', 'DRIVER')),
    title           TEXT,
    organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vehicles (
    id                       SERIAL PRIMARY KEY,
    plate                    TEXT NOT NULL,
    brand                    TEXT NOT NULL,
    model                    TEXT NOT NULL,
    year                     INTEGER,
    mileage                  INTEGER NOT NULL DEFAULT 0,
    last_oil_change_km       INTEGER NOT NULL DEFAULT 0,
    next_oil_change_km       INTEGER NOT NULL DEFAULT 0,
    fuel                     TEXT,
    status                   TEXT NOT NULL DEFAULT 'AVAILABLE',
    driver                   TEXT,
    insurance_expiry         DATE,
    registration_expiry      DATE,
    technical_control_expiry DATE,
    photo                    TEXT,
    organization_id          INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS drivers (
    id              SERIAL PRIMARY KEY,
    name            TEXT NOT NULL,
    email           TEXT,
    phone           TEXT,
    license         TEXT,
    status          TEXT,
    license_expiry  DATE,
    photo           TEXT,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reservations (
    id              SERIAL PRIMARY KEY,
    vehicle_id      INTEGER REFERENCES vehicles(id) ON DELETE CASCADE,
    vehicle         TEXT,
    driver_id       INTEGER REFERENCES drivers(id) ON DELETE SET NULL,
    driver          TEXT,
    start           TIMESTAMPTZ NOT NULL,
    "end"           TIMESTAMPTZ,
    purpose         TEXT,
    status          TEXT NOT NULL DEFAULT 'PENDING',
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS maintenances (
    id              SERIAL PRIMARY KEY,
    vehicle_id      INTEGER REFERENCES vehicles(id) ON DELETE CASCADE,
    vehicle         TEXT,
    type            TEXT,
    cost            NUMERIC(12, 0),
    date            DATE,
    status          TEXT,
    provider        TEXT,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS incidents (
    id              SERIAL PRIMARY KEY,
    vehicle_id      INTEGER REFERENCES vehicles(id) ON DELETE CASCADE,
    vehicle         TEXT,
    driver_id       INTEGER REFERENCES drivers(id) ON DELETE SET NULL,
    driver          TEXT,
    title           TEXT,
    priority        TEXT,
    date            DATE,
    status          TEXT,
    description     TEXT,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS accidents (
    id              SERIAL PRIMARY KEY,
    vehicle_id      INTEGER REFERENCES vehicles(id) ON DELETE CASCADE,
    vehicle         TEXT,
    driver_id       INTEGER REFERENCES drivers(id) ON DELETE SET NULL,
    driver          TEXT,
    date            DATE,
    location        TEXT,
    damage          TEXT,
    third_party     TEXT,
    report          TEXT,
    cost_estimate   NUMERIC(12, 0),
    status          TEXT,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fuel_logs (
    id              SERIAL PRIMARY KEY,
    vehicle_id      INTEGER REFERENCES vehicles(id) ON DELETE CASCADE,
    vehicle         TEXT,
    date            DATE,
    liters          NUMERIC(10, 2),
    cost            NUMERIC(12, 0),
    mileage         INTEGER,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_organization        ON users(organization_id);
CREATE INDEX IF NOT EXISTS idx_vehicles_organization     ON vehicles(organization_id);
CREATE INDEX IF NOT EXISTS idx_drivers_organization      ON drivers(organization_id);
CREATE INDEX IF NOT EXISTS idx_reservations_organization ON reservations(organization_id);
CREATE INDEX IF NOT EXISTS idx_reservations_vehicle      ON reservations(organization_id, vehicle_id, start, "end");
CREATE INDEX IF NOT EXISTS idx_maintenances_organization ON maintenances(organization_id);
CREATE INDEX IF NOT EXISTS idx_incidents_organization    ON incidents(organization_id);
CREATE INDEX IF NOT EXISTS idx_accidents_organization    ON accidents(organization_id);
CREATE INDEX IF NOT EXISTS idx_fuel_logs_organization    ON fuel_logs(organization_id);
`;

/** Crée les tables si elles n'existent pas encore. Idempotent. */
async function migrate() {
    await pool.query(SCHEMA);
}

module.exports = { migrate, SCHEMA };
