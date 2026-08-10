const { pool } = require('./pool');
const { config } = require('../config');
const logger = require('../utils/logger');

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

-- Budget carburant mensuel (Phase 7.3) : une ligne par organisation et par mois.
CREATE TABLE IF NOT EXISTS fuel_budgets (
    id              SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    month           DATE NOT NULL,
    amount          NUMERIC(12, 0) NOT NULL DEFAULT 0 CHECK (amount >= 0),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fuel_budgets_org_month_unique UNIQUE (organization_id, month)
);

-- ============================================================
-- Plans d'abonnement SaaS
-- ============================================================
-- max_vehicles / max_users : NULL signifie "illimité".
-- features : liste JSONB des fonctionnalités incluses (pour la page tarifs).
CREATE TABLE IF NOT EXISTS plans (
    id              SERIAL PRIMARY KEY,
    code            TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    description     TEXT,
    monthly_price   NUMERIC(12, 0) NOT NULL DEFAULT 0,
    duration_months INTEGER NOT NULL DEFAULT 1,
    max_vehicles    INTEGER CHECK (max_vehicles IS NULL OR max_vehicles >= 1),
    max_users       INTEGER CHECK (max_users IS NULL OR max_users >= 1),
    features        JSONB NOT NULL DEFAULT '[]'::jsonb,
    active          BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- Abonnements des clients (SaaS multi-entreprises)
-- ============================================================
-- Une ligne = l'abonnement "courant" d'un client. Les changements successifs
-- sont journalisés dans subscription_history. Les colonnes plan et
-- monthly_price sont des instantanés du plan au moment de la souscription
-- (résilients même si le plan est ensuite modifié/supprimé).
-- Statuts : TRIAL (période d'essai), ACTIVE (en cours), EXPIRED (échu),
-- CANCELLED (résilié), PAST_DUE (impayé — futur).
CREATE TABLE IF NOT EXISTS subscriptions (
    id              SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    plan_id         INTEGER REFERENCES plans(id) ON DELETE SET NULL,
    plan            TEXT NOT NULL DEFAULT 'STARTER',
    monthly_price   NUMERIC(12, 0) NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'TRIAL'
                    CHECK (status IN ('TRIAL', 'ACTIVE', 'EXPIRED', 'CANCELLED', 'PAST_DUE')),
    start_date      DATE,
    end_date        DATE,
    trial_ends_at   DATE,
    auto_renew      BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- Historique des changements d'abonnement (audit trail)
-- ============================================================
-- change_type : SUBSCRIBED | TRIAL_STARTED | PLAN_CHANGED | RENEWED
--               | CANCELLED | EXPIRED | TRIAL_EXPIRED | ACTIVATED | UPDATED
CREATE TABLE IF NOT EXISTS subscription_history (
    id              SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    subscription_id INTEGER REFERENCES subscriptions(id) ON DELETE SET NULL,
    plan_id         INTEGER REFERENCES plans(id) ON DELETE SET NULL,
    plan_code       TEXT NOT NULL,
    plan_name       TEXT NOT NULL,
    monthly_price   NUMERIC(12, 0) NOT NULL DEFAULT 0,
    status          TEXT NOT NULL,
    change_type     TEXT NOT NULL
                    CHECK (change_type IN ('SUBSCRIBED', 'TRIAL_STARTED', 'PLAN_CHANGED',
                                          'RENEWED', 'CANCELLED', 'EXPIRED', 'TRIAL_EXPIRED',
                                          'ACTIVATED', 'UPDATED')),
    start_date      DATE,
    end_date        DATE,
    changed_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reason          TEXT,
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
CREATE INDEX IF NOT EXISTS idx_subscriptions_organization        ON subscriptions(organization_id);
CREATE INDEX IF NOT EXISTS idx_subscription_history_organization ON subscription_history(organization_id);
CREATE INDEX IF NOT EXISTS idx_subscription_history_subscription ON subscription_history(subscription_id);
CREATE INDEX IF NOT EXISTS idx_plans_active                      ON plans(active);

-- ============================================================
-- Paiements (Phase 5.1 — Architecture des paiements SaaS)
-- ============================================================
-- Une ligne = une tentative de paiement. Le fournisseur (provider) est
-- indépendant : 'mock' (simulation locale), 'wave', 'orange_money', 'stripe'.
-- Les changements de statut suivent une machine à états stricte :
--   CREATED -> PENDING -> PROCESSING -> SUCCESS | FAILED | CANCELLED | EXPIRED
--   (voir services/paymentStateMachine.js). Chaque transition est journalisée
--   dans payment_events (audit trail complet).
CREATE TABLE IF NOT EXISTS payment_transactions (
    id                    SERIAL PRIMARY KEY,
    organization_id       INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    subscription_id       INTEGER REFERENCES subscriptions(id) ON DELETE SET NULL,
    invoice_id            TEXT,
    provider              TEXT NOT NULL,
    transaction_reference TEXT NOT NULL UNIQUE,
    provider_reference    TEXT,
    amount                NUMERIC(12, 0) NOT NULL,
    currency              TEXT NOT NULL DEFAULT 'XOF',
    status                TEXT NOT NULL DEFAULT 'CREATED'
                          CHECK (status IN ('CREATED', 'PENDING', 'PROCESSING',
                                           'SUCCESS', 'FAILED', 'CANCELLED',
                                           'EXPIRED', 'REFUNDED')),
    payment_method        TEXT,
    initiated_at          TIMESTAMPTZ,
    completed_at          TIMESTAMPTZ,
    provider_response     JSONB NOT NULL DEFAULT '{}'::jsonb,
    metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Historique (audit trail) : un événement par changement de statut et pour
-- chaque webhook reçu. Jamais de suppression (traçabilité complète).
CREATE TABLE IF NOT EXISTS payment_events (
    id             SERIAL PRIMARY KEY,
    transaction_id INTEGER NOT NULL REFERENCES payment_transactions(id) ON DELETE CASCADE,
    event          TEXT NOT NULL
                   CHECK (event IN ('CREATED', 'PENDING', 'PROCESSING', 'SUCCESS',
                                    'FAILED', 'CANCELLED', 'EXPIRED', 'REFUNDED')),
    message        TEXT,
    payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_transactions_organization ON payment_transactions(organization_id);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_subscription ON payment_transactions(subscription_id);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_status      ON payment_transactions(status);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_provider    ON payment_transactions(provider);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_reference   ON payment_transactions(transaction_reference);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_created     ON payment_transactions(created_at);
CREATE INDEX IF NOT EXISTS idx_payment_events_transaction       ON payment_events(transaction_id);
CREATE INDEX IF NOT EXISTS idx_payment_events_created           ON payment_events(created_at);

-- ============================================================
-- Factures (Phase 5.2 — synchronisation SaaS après paiement)
-- ============================================================
-- Une facture est liée à un paiement via payment_transactions.invoice_id
-- (numéro de facture). Lorsqu'un paiement passe à SUCCESS, la facture
-- correspondante devient PAID automatiquement (services/paymentSync.js).
-- Statuts : PENDING | PAID | FAILED | CANCELLED | REFUNDED.
CREATE TABLE IF NOT EXISTS invoices (
    id                     SERIAL PRIMARY KEY,
    invoice_number         TEXT NOT NULL UNIQUE,
    organization_id        INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    subscription_id        INTEGER REFERENCES subscriptions(id) ON DELETE SET NULL,
    amount                 NUMERIC(12, 0) NOT NULL,
    currency               TEXT NOT NULL DEFAULT 'XOF',
    status                 TEXT NOT NULL DEFAULT 'PENDING'
                           CHECK (status IN ('PENDING', 'PAID', 'FAILED', 'CANCELLED', 'REFUNDED')),
    provider               TEXT,
    payment_transaction_id INTEGER REFERENCES payment_transactions(id) ON DELETE SET NULL,
    issued_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    paid_at                TIMESTAMPTZ,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoices_organization     ON invoices(organization_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status           ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_invoice_number   ON invoices(invoice_number);

-- ============================================================
-- Documents (module documentation) — une ligne = un document rattaché à un
-- véhicule OU à un conducteur de l'organisation. Le fichier n'est jamais
-- stocké : seules ses métadonnées (nom, chemin, type MIME, taille) sont
-- conservées. Types : Assurance, Carte Grise, Contrôle Technique, Permis,
-- Vignette, Autorisation, Autre. Le statut (OK / SOON / EXPIRED / UNKNOWN)
-- est dérivé de la date d'expiration, jamais stocké.
CREATE TABLE IF NOT EXISTS documents (
    id              SERIAL PRIMARY KEY,
    vehicle_id      INTEGER REFERENCES vehicles(id) ON DELETE CASCADE,
    driver_id       INTEGER REFERENCES drivers(id) ON DELETE CASCADE,
    document_type   TEXT NOT NULL,
    document_number TEXT,
    issue_date      DATE,
    expiry_date     DATE,
    notes           TEXT,
    file_name       TEXT,
    file_path       TEXT,
    mime_type       TEXT,
    file_size       INTEGER CHECK (file_size IS NULL OR file_size >= 0),
    file_uploaded_at TIMESTAMPTZ,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT documents_single_owner CHECK (num_nonnulls(vehicle_id, driver_id) = 1)
);

CREATE INDEX IF NOT EXISTS idx_documents_organization ON documents(organization_id);
CREATE INDEX IF NOT EXISTS idx_documents_vehicle      ON documents(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_documents_driver       ON documents(driver_id);
CREATE INDEX IF NOT EXISTS idx_documents_expiry       ON documents(expiry_date);

-- ============================================================
-- Ventes de véhicules (Phase 7.7) — une ligne = une vente
-- ============================================================
-- L'acheteur est interne (buyer_id -> drivers) OU externe (buyer_name et
-- coordonnées en texte libre) : la contrainte exige qu'au moins une des deux
-- références soit renseignée, et buyer_type explicite le cas (INTERNAL /
-- EXTERNAL). Le numéro de vente (sale_number) est généré par le serveur au
-- format VS-AAAA-NNNNNN, unique par organisation et par année. Le prix total
-- (total_price) est toujours calculé côté serveur (prix + taxes + frais) et le
-- prix est strictement positif. Les instantanés (vehicle, title, mileage,
-- year) sont figés au moment de la vente pour préserver l'historique comptable.
-- Statuts de vente : DRAFT / IN_PROGRESS / COMPLETED / CANCELLED ; paiement
-- PENDING / PARTIAL / PAID / REFUNDED ; livraison PENDING / DELIVERED.
-- Cycle du véhicule piloté par la vente : AVAILABLE -> RESERVED -> SOLD
-- (le statut du véhicule lié est mis à jour par le serveur, jamais par le
-- client). Les métadonnées de pièce jointe (file_*) sont écrites uniquement
-- par le serveur (phase ultérieure).
CREATE TABLE IF NOT EXISTS vehicle_sales (
    id                SERIAL PRIMARY KEY,
    sale_number       TEXT NOT NULL,
    vehicle_id        INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE RESTRICT,
    vehicle           TEXT,
    title             TEXT,
    description       TEXT,
    mileage           INTEGER CHECK (mileage IS NULL OR mileage >= 0),
    year              INTEGER CHECK (year IS NULL OR (year >= 1900 AND year <= 2100)),
    buyer_id          INTEGER REFERENCES drivers(id) ON DELETE SET NULL,
    buyer_type        TEXT CHECK (buyer_type IS NULL OR buyer_type IN ('INTERNAL', 'EXTERNAL')),
    buyer_name        TEXT,
    buyer_phone       TEXT,
    buyer_email       TEXT,
    buyer_address     TEXT,
    buyer_id_card     TEXT,
    broker_id         INTEGER REFERENCES drivers(id) ON DELETE SET NULL,
    salesperson_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    sale_date         DATE NOT NULL,
    currency          TEXT NOT NULL DEFAULT 'XOF'
                      CHECK (currency IN ('XOF', 'EUR', 'USD')),
    price             NUMERIC(12, 0) NOT NULL DEFAULT 0
                      CONSTRAINT vehicle_sales_price_positive CHECK (price > 0),
    tax               NUMERIC(12, 0) NOT NULL DEFAULT 0 CHECK (tax >= 0),
    fees              NUMERIC(12, 0) NOT NULL DEFAULT 0 CHECK (fees >= 0),
    total_price       NUMERIC(12, 0) NOT NULL DEFAULT 0 CHECK (total_price >= 0),
    payment_method    TEXT,
    payment_status    TEXT NOT NULL DEFAULT 'PENDING'
                      CHECK (payment_status IN ('PENDING', 'PARTIAL', 'PAID', 'REFUNDED')),
    paid_amount       NUMERIC(12, 0) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
    delivery_status   TEXT NOT NULL DEFAULT 'PENDING'
                      CHECK (delivery_status IN ('PENDING', 'DELIVERED')),
    delivery_date     DATE,
    status            TEXT NOT NULL DEFAULT 'DRAFT'
                      CHECK (status IN ('DRAFT', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')),
    notes             TEXT,
    file_name         TEXT,
    file_path         TEXT,
    mime_type         TEXT,
    file_size         INTEGER CHECK (file_size IS NULL OR file_size >= 0),
    file_uploaded_at  TIMESTAMPTZ,
    organization_id   INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT vehicle_sales_buyer_required
        CHECK (num_nonnulls(buyer_id, buyer_name) >= 1),
    CONSTRAINT vehicle_sales_org_number_unique UNIQUE (organization_id, sale_number)
);

CREATE INDEX IF NOT EXISTS idx_vehicle_sales_organization ON vehicle_sales(organization_id);
CREATE INDEX IF NOT EXISTS idx_vehicle_sales_vehicle      ON vehicle_sales(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_vehicle_sales_buyer        ON vehicle_sales(buyer_id);
CREATE INDEX IF NOT EXISTS idx_vehicle_sales_broker       ON vehicle_sales(broker_id);
CREATE INDEX IF NOT EXISTS idx_vehicle_sales_sale_date    ON vehicle_sales(organization_id, sale_date);
CREATE INDEX IF NOT EXISTS idx_vehicle_sales_org_status   ON vehicle_sales(organization_id, status);

-- ============================================================
-- Photos des ventes de véhicules (Phase 7.7 — Commit 4) — une
-- ligne = une photo rattachée à une vente de l'organisation.
-- ============================================================
-- Plusieurs photos par annonce, avec une photo principale
-- (is_primary) et un ordre d'affichage (sort_order) pilotés par le
-- serveur. Le fichier physique n'est JAMAIS stocké en base : seule la
-- clé de stockage interne (storage_key, chemin relatif sûr généré par
-- le serveur, jamais exposé au client) et les métadonnées (nom
-- original, type MIME, taille, date) sont conservées. Le répertoire
-- « uploads » n'est jamais servi en statique : la lecture passe par
-- l'API authentifiée /api/vehicle-sales/:saleId/photos/:photoId.
CREATE TABLE IF NOT EXISTS vehicle_sale_photos (
    id                SERIAL PRIMARY KEY,
    vehicle_sale_id   INTEGER NOT NULL REFERENCES vehicle_sales(id) ON DELETE CASCADE,
    storage_key       TEXT NOT NULL,
    original_name     TEXT NOT NULL,
    mime_type         TEXT NOT NULL,
    size_bytes        INTEGER NOT NULL CHECK (size_bytes >= 0),
    is_primary        BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order        INTEGER NOT NULL DEFAULT 0,
    organization_id   INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT vehicle_sale_photos_storage_key_unique UNIQUE (organization_id, vehicle_sale_id, storage_key)
);

CREATE INDEX IF NOT EXISTS idx_vehicle_sale_photos_org     ON vehicle_sale_photos(organization_id);
CREATE INDEX IF NOT EXISTS idx_vehicle_sale_photos_sale    ON vehicle_sale_photos(vehicle_sale_id);
CREATE INDEX IF NOT EXISTS idx_vehicle_sale_photos_primary ON vehicle_sale_photos(organization_id, vehicle_sale_id, is_primary);
`;

// ============================================================
// Migration des bases existantes (bases créées avant la Phase 5.2)
// ============================================================

// La table invoices peut pré-exister avec un schéma différent (bases
// antérieures) : le CREATE TABLE IF NOT EXISTS du SCHEMA ne modifie pas une
// table existante. Cette montée de version ajoute idempotemment les colonnes
// manquantes (création de l'index de transaction dans le même lot).
const UPGRADE_INVOICES_SQL = `
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS
    payment_transaction_id INTEGER REFERENCES payment_transactions(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_invoices_transaction ON invoices(payment_transaction_id);
`;

// ============================================================
// Migration des bases existantes (bases créées avant la Phase 3)
// ============================================================

// Rend la table subscriptions compatible avec le nouveau schéma SaaS
// (colonnes supplémentaires, nouvelle contrainte de statut).
const UPGRADE_SUBSCRIPTIONS_SQL = `
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS plan_id     INTEGER REFERENCES plans(id) ON DELETE SET NULL;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS trial_ends_at DATE;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS auto_renew  BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE subscriptions ALTER COLUMN plan SET DEFAULT 'STARTER';
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_status_check;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_status_check
    CHECK (status IN ('TRIAL', 'ACTIVE', 'EXPIRED', 'CANCELLED', 'PAST_DUE'));
CREATE INDEX IF NOT EXISTS idx_subscriptions_plan ON subscriptions(plan_id);
`;

// Rattache les abonnements existants à un plan (par code ou défaut STARTER)
// et complète trial_ends_at / end_date manquants.
const BACKFILL_SUBSCRIPTIONS_SQL = `
UPDATE subscriptions s
SET plan_id = p.id,
    monthly_price = CASE WHEN s.monthly_price > 0 THEN s.monthly_price ELSE p.monthly_price END
FROM plans p
WHERE s.plan_id IS NULL
  AND UPPER(REPLACE(REPLACE(s.plan, 'É', 'E'), ' ', '')) = p.code;

UPDATE subscriptions s
SET plan_id = p.id,
    monthly_price = CASE WHEN s.monthly_price > 0 THEN s.monthly_price ELSE p.monthly_price END
FROM plans p
WHERE s.plan_id IS NULL AND p.code = 'STARTER';

UPDATE subscriptions
SET trial_ends_at = COALESCE(trial_ends_at, end_date, start_date),
    end_date      = COALESCE(end_date, start_date)
WHERE trial_ends_at IS NULL OR end_date IS NULL;
`;

// ============================================================
// Migration des bases existantes (bases créées avant la Phase 7.3)
// ============================================================

// Enrichit fuel_logs avec les champs du module carburant professionnel.
// Strictement idempotent (ADD COLUMN IF NOT EXISTS) : aucune perte de
// données, les colonnes existantes ne sont pas touchées.
const UPGRADE_FUEL_SQL = `
ALTER TABLE fuel_logs ADD COLUMN IF NOT EXISTS driver_id     INTEGER REFERENCES drivers(id) ON DELETE SET NULL;
ALTER TABLE fuel_logs ADD COLUMN IF NOT EXISTS driver        TEXT;
ALTER TABLE fuel_logs ADD COLUMN IF NOT EXISTS fuel_type     TEXT;
ALTER TABLE fuel_logs ADD COLUMN IF NOT EXISTS price_per_liter NUMERIC(12, 2);
ALTER TABLE fuel_logs ADD COLUMN IF NOT EXISTS station       TEXT;
ALTER TABLE fuel_logs ADD COLUMN IF NOT EXISTS payment_method TEXT;
ALTER TABLE fuel_logs ADD COLUMN IF NOT EXISTS receipt_number TEXT;
ALTER TABLE fuel_logs ADD COLUMN IF NOT EXISTS notes         TEXT;
CREATE INDEX IF NOT EXISTS idx_fuel_logs_date   ON fuel_logs(organization_id, date);
CREATE INDEX IF NOT EXISTS idx_fuel_logs_vehicle ON fuel_logs(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_fuel_budgets_organization ON fuel_budgets(organization_id);
CREATE INDEX IF NOT EXISTS idx_fuel_budgets_month ON fuel_budgets(organization_id, month);
`;

// ============================================================
// Migration des bases existantes — pièces jointes documents
// (Phase Documentation, Commit 5)
// ============================================================

// La table documents possède déjà file_name / file_path / mime_type /
// file_size (métadonnées de fichier, Commit 1). On ajoute uniquement la
// date d'upload. file_name conserve le NOM ORIGINAL du fichier (affichage
// côté client) ; file_path stocke le chemin INTERNE sécurisé relatif à la
// racine « uploads » (jamais exposé directement). Strictement idempotent :
// les documents existants ne sont jamais altérés.
const UPGRADE_DOCUMENTS_FILES_SQL = `
ALTER TABLE documents ADD COLUMN IF NOT EXISTS file_uploaded_at TIMESTAMPTZ;
`;

// ============================================================
// Migration des bases existantes — Ventes de véhicules
// (Phase 7.7, Commit 2 : validation renforcée)
// ============================================================

// La table vehicle_sales peut pré-exister avec le schéma du Commit 1 (bases
// ayant démarré le serveur avant cette montée de version) : le CREATE TABLE
// IF NOT EXISTS du SCHEMA ne modifie pas une table existante. On ajoute donc
// idempotemment les colonnes de validation (devise, type d'acheteur, e-mail,
// instantanés titre/description/kilométrage/année) et on durcit les
// contraintes nommées (prix strictement positif, devises autorisées). Les
// DROP CONSTRAINT IF EXISTS garantissent l'idempotence dans les deux cas
// (base ancienne avec contrainte auto-nommée, ou base récente avec contrainte
// nommée déjà en place).
const UPGRADE_VEHICLE_SALES_SQL = `
ALTER TABLE vehicle_sales ADD COLUMN IF NOT EXISTS currency      TEXT NOT NULL DEFAULT 'XOF';
ALTER TABLE vehicle_sales ADD COLUMN IF NOT EXISTS buyer_type    TEXT;
ALTER TABLE vehicle_sales ADD COLUMN IF NOT EXISTS buyer_email   TEXT;
ALTER TABLE vehicle_sales ADD COLUMN IF NOT EXISTS title         TEXT;
ALTER TABLE vehicle_sales ADD COLUMN IF NOT EXISTS description   TEXT;
ALTER TABLE vehicle_sales ADD COLUMN IF NOT EXISTS mileage       INTEGER;
ALTER TABLE vehicle_sales ADD COLUMN IF NOT EXISTS year          INTEGER;

ALTER TABLE vehicle_sales DROP CONSTRAINT IF EXISTS vehicle_sales_price_check;
ALTER TABLE vehicle_sales DROP CONSTRAINT IF EXISTS vehicle_sales_price_positive;
ALTER TABLE vehicle_sales ADD CONSTRAINT vehicle_sales_price_positive CHECK (price > 0);

ALTER TABLE vehicle_sales DROP CONSTRAINT IF EXISTS vehicle_sales_currency_allowed;
ALTER TABLE vehicle_sales ADD CONSTRAINT vehicle_sales_currency_allowed
    CHECK (currency IN ('XOF', 'EUR', 'USD'));

ALTER TABLE vehicle_sales DROP CONSTRAINT IF EXISTS vehicle_sales_buyer_type_allowed;
ALTER TABLE vehicle_sales ADD CONSTRAINT vehicle_sales_buyer_type_allowed
    CHECK (buyer_type IS NULL OR buyer_type IN ('INTERNAL', 'EXTERNAL'));

CREATE INDEX IF NOT EXISTS idx_vehicle_sales_org_status ON vehicle_sales(organization_id, status);
`;

// ============================================================
// Plans par défaut (Seed)
// ============================================================

const DEFAULT_PLANS = [
    {
        code: 'STARTER',
        name: 'Starter',
        description: "Pour les petites flottes qui démarrent : le nécessaire pour piloter son parc au quotidien.",
        monthlyPrice: 15000,
        durationMonths: 1,
        maxVehicles: 10,
        maxUsers: 5,
        features: [
            'Jusqu\'à 10 véhicules',
            'Jusqu\'à 5 utilisateurs',
            'Tableau de bord & KPIs',
            'Suivi des vidanges et alertes',
            'Gestion des conducteurs',
            'Planning et réservations',
            'Entretien et carburant',
            'Support par e-mail',
        ],
    },
    {
        code: 'PRO',
        name: 'Pro',
        description: "Pour les flottes en croissance : analyses avancées et outils complets.",
        monthlyPrice: 50000,
        durationMonths: 1,
        maxVehicles: 50,
        maxUsers: 25,
        features: [
            'Tout le plan Starter',
            'Jusqu\'à 50 véhicules',
            'Jusqu\'à 25 utilisateurs',
            'Signalements et accidents',
            'Analyses et Fleet Health Score',
            'Export PDF / Excel',
            'Alertes documents et permis',
            'Support prioritaire',
        ],
    },
    {
        code: 'ENTERPRISE',
        name: 'Enterprise',
        description: "Pour les grands parcs : véhicules illimités et accompagnement dédié.",
        monthlyPrice: 150000,
        durationMonths: 1,
        maxVehicles: null,
        maxUsers: null,
        features: [
            'Tout le plan Pro',
            'Véhicules illimités',
            'Utilisateurs illimités',
            'Accompagnement dédié',
            'Personnalisation',
            'API et intégrations',
            'SLA garanti',
        ],
    },
];

function plansSeedSql(plans) {
    const values = plans
        .map((p, i) => {
            const base = i * 8;
            return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}::jsonb)`;
        })
        .join(', ');
    const params = [];
    for (const p of plans) {
        params.push(
            p.code,
            p.name,
            p.description,
            p.monthlyPrice,
            p.durationMonths,
            p.maxVehicles,
            p.maxUsers,
            JSON.stringify(p.features)
        );
    }
    return { values, params };
}

/** Insère les plans par défaut s'ils n'existent pas encore. Idempotent. */
async function seedDefaultPlans() {
    const { rows } = await pool.query('SELECT COUNT(*) AS count FROM plans');
    if (parseInt(rows[0].count, 10) > 0) return;

    const { values, params } = plansSeedSql(DEFAULT_PLANS);
    await pool.query(
        `INSERT INTO plans
            (code, name, description, monthly_price, duration_months, max_vehicles, max_users, features)
         VALUES ${values}
         ON CONFLICT (code) DO NOTHING`,
        params
    );
    logger.info('db.plans_seeded', { count: DEFAULT_PLANS.length });
}

/** Adapte les bases préexistantes au schéma SaaS (Phase 3). */
async function upgradeExistingSubscriptions() {
    await pool.query(UPGRADE_SUBSCRIPTIONS_SQL);
    await pool.query(BACKFILL_SUBSCRIPTIONS_SQL);
}

/** Crée les tables si elles n'existent pas encore. Idempotent. */
async function migrate() {
    await pool.query(SCHEMA);
    await pool.query(UPGRADE_INVOICES_SQL);
    await pool.query(UPGRADE_FUEL_SQL);
    await pool.query(UPGRADE_DOCUMENTS_FILES_SQL);
    await pool.query(UPGRADE_VEHICLE_SALES_SQL);
    await upgradeExistingSubscriptions();
    await seedDefaultPlans();
}

module.exports = { migrate, SCHEMA, DEFAULT_PLANS };
