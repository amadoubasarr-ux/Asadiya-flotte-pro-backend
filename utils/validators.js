const AppError = require('./AppError');

// ===== Petits utilitaires =====

function pick(body, allowedKeys) {
    const out = {};
    for (const key of allowedKeys) {
        if (body[key] !== undefined) out[key] = body[key];
    }
    return out;
}

function requireFields(data, fields, subject) {
    const missing = fields.filter((f) => data[f] === undefined || data[f] === null || String(data[f]).trim() === '');
    if (missing.length > 0) {
        throw AppError.badRequest(`Champ(s) requis manquant(s) pour ${subject} : ${missing.join(', ')}.`);
    }
}

function intValue(value, name, { min = null, required = true } = {}) {
    if (value === undefined || value === null || value === '') {
        if (required) throw AppError.badRequest(`Le champ "${name}" doit être un nombre entier.`);
        return undefined;
    }
    const n = parseInt(value, 10);
    if (Number.isNaN(n) || (min !== null && n < min)) {
        throw AppError.badRequest(`Le champ "${name}" doit être un nombre entier${min !== null ? ` supérieur ou égal à ${min}` : ''}.`);
    }
    return n;
}

function numberValue(value, name, { min = 0 } = {}) {
    if (value === undefined || value === null || value === '') return undefined;
    const n = parseFloat(value);
    if (Number.isNaN(n) || n < min) {
        throw AppError.badRequest(`Le champ "${name}" doit être un nombre${min !== 0 ? ` supérieur ou égal à ${min}` : ''}.`);
    }
    return n;
}

function textValue(value, name, { max = 2000 } = {}) {
    if (value === undefined || value === null) return undefined;
    const s = String(value);
    if (s.length > max) throw AppError.badRequest(`Le champ "${name}" est trop long (max ${max} caractères).`);
    return s;
}

// ===== Ressources =====

const VEHICLE_KEYS = [
    'plate', 'brand', 'model', 'year', 'mileage', 'lastOilChangeKm', 'nextOilChangeKm',
    'fuel', 'status', 'driver', 'insuranceExpiry', 'registrationExpiry', 'technicalControlExpiry', 'photo',
];

function validateVehicle(body, { partial = false } = {}) {
    const data = pick(body || {}, VEHICLE_KEYS);
    if (!partial) requireFields(data, ['plate', 'brand', 'model'], 'un véhicule');
    if (data.year !== undefined) data.year = intValue(data.year, 'year', { min: 1900 });
    if (data.mileage !== undefined) data.mileage = intValue(data.mileage, 'mileage', { min: 0 });
    if (data.lastOilChangeKm !== undefined) data.lastOilChangeKm = intValue(data.lastOilChangeKm, 'lastOilChangeKm', { min: 0 });
    if (data.nextOilChangeKm !== undefined) data.nextOilChangeKm = intValue(data.nextOilChangeKm, 'nextOilChangeKm', { min: 0 });
    return data;
}

const DRIVER_KEYS = ['name', 'email', 'phone', 'license', 'status', 'licenseExpiry', 'photo'];

function validateDriver(body, { partial = false } = {}) {
    const data = pick(body || {}, DRIVER_KEYS);
    if (!partial) requireFields(data, ['name'], 'un conducteur');
    if (data.email !== undefined) data.email = textValue(data.email, 'email', { max: 255 });
    return data;
}

const MAINTENANCE_KEYS = ['vehicleId', 'vehicle', 'type', 'cost', 'date', 'status', 'provider'];

function validateMaintenance(body, { partial = false } = {}) {
    const data = pick(body || {}, MAINTENANCE_KEYS);
    if (!partial) requireFields(data, ['vehicleId', 'type', 'date'], 'un entretien');
    if (data.vehicleId !== undefined) data.vehicleId = intValue(data.vehicleId, 'vehicleId', { min: 1 });
    if (data.cost !== undefined) data.cost = numberValue(data.cost, 'cost', { min: 0 });
    return data;
}

const INCIDENT_KEYS = ['vehicleId', 'vehicle', 'driverId', 'driver', 'title', 'priority', 'date', 'status', 'description'];

function validateIncident(body, { partial = false } = {}) {
    const data = pick(body || {}, INCIDENT_KEYS);
    if (!partial) requireFields(data, ['vehicleId', 'title'], 'un signalement');
    if (data.vehicleId !== undefined) data.vehicleId = intValue(data.vehicleId, 'vehicleId', { min: 1 });
    if (data.driverId !== undefined && data.driverId !== '') data.driverId = intValue(data.driverId, 'driverId', { min: 1 });
    if (data.description !== undefined) data.description = textValue(data.description, 'description', { max: 4000 });
    return data;
}

const ACCIDENT_KEYS = ['vehicleId', 'vehicle', 'driverId', 'driver', 'date', 'location', 'damage', 'thirdParty', 'report', 'costEstimate', 'status'];

function validateAccident(body, { partial = false } = {}) {
    const data = pick(body || {}, ACCIDENT_KEYS);
    if (!partial) requireFields(data, ['vehicleId', 'date', 'location'], 'un accident');
    if (data.vehicleId !== undefined) data.vehicleId = intValue(data.vehicleId, 'vehicleId', { min: 1 });
    if (data.driverId !== undefined && data.driverId !== '') data.driverId = intValue(data.driverId, 'driverId', { min: 1 });
    if (data.costEstimate !== undefined) data.costEstimate = numberValue(data.costEstimate, 'costEstimate', { min: 0 });
    return data;
}

const FUEL_KEYS = ['vehicleId', 'vehicle', 'date', 'liters', 'cost', 'mileage'];

function validateFuelLog(body, { partial = false } = {}) {
    const data = pick(body || {}, FUEL_KEYS);
    if (!partial) requireFields(data, ['vehicleId', 'date', 'liters', 'cost'], 'un plein de carburant');
    if (data.vehicleId !== undefined) data.vehicleId = intValue(data.vehicleId, 'vehicleId', { min: 1 });
    if (data.liters !== undefined) data.liters = numberValue(data.liters, 'liters', { min: 0 });
    if (data.cost !== undefined) data.cost = numberValue(data.cost, 'cost', { min: 0 });
    if (data.mileage !== undefined) data.mileage = intValue(data.mileage, 'mileage', { min: 0 });
    return data;
}

// ===== Réservations =====

const RESERVATION_KEYS = ['vehicleId', 'vehicle', 'driverId', 'driver', 'start', 'end', 'purpose', 'status'];
const RESERVATION_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'];

function validateReservation(body, { partial = false } = {}) {
    const data = pick(body || {}, RESERVATION_KEYS);
    if (!partial) requireFields(data, ['vehicleId', 'driverId', 'start'], 'une réservation');
    if (data.vehicleId !== undefined) data.vehicleId = intValue(data.vehicleId, 'vehicleId', { min: 1 });
    if (data.driverId !== undefined && data.driverId !== '') data.driverId = intValue(data.driverId, 'driverId', { min: 1 });

    // `end` peut être absent ou une chaîne non horodatable ("Non précisée") :
    // dans ce cas la réservation est traitée comme un événement ponctuel.
    if (data.end !== undefined && data.end !== null && data.end !== '') {
        const endDate = new Date(data.end);
        if (Number.isNaN(endDate.getTime())) data.end = null;
    }

    if (data.status !== undefined && !RESERVATION_STATUSES.includes(data.status)) {
        throw AppError.badRequest(`Statut de réservation invalide (attendu : ${RESERVATION_STATUSES.join(', ')}).`);
    }
    return data;
}

// ===== Utilisateurs =====

const VALID_ROLES = ['ADMIN', 'MANAGER', 'DRIVER'];
const USER_KEYS = ['username', 'password', 'name', 'role', 'title'];

function validateUser(body, { partial = false } = {}) {
    const data = pick(body || {}, USER_KEYS);
    if (!partial) {
        requireFields(data, ['username', 'password', 'name', 'role'], 'un utilisateur');
    }
    if (data.username !== undefined) data.username = textValue(data.username, 'username', { max: 100 });
    if (data.name !== undefined) data.name = textValue(data.name, 'name', { max: 200 });
    if (data.title !== undefined) data.title = textValue(data.title, 'title', { max: 200 });
    if (data.password !== undefined) {
        if (String(data.password).length < 6) {
            throw AppError.badRequest('Le mot de passe doit contenir au moins 6 caractères.');
        }
        data.password = String(data.password);
    }
    if (data.role !== undefined && !VALID_ROLES.includes(data.role)) {
        throw AppError.badRequest(`Rôle invalide (attendu : ${VALID_ROLES.join(', ')}).`);
    }
    return data;
}

// ===== Organisations =====

function validateOrganization(body) {
    const data = pick(body || {}, ['name', 'adminName', 'adminUsername', 'adminPassword']);
    requireFields(data, ['name', 'adminName', 'adminUsername', 'adminPassword'], 'une organisation');
    if (String(data.adminPassword).length < 6) {
        throw AppError.badRequest('Le mot de passe doit contenir au moins 6 caractères.');
    }
    return data;
}

module.exports = {
    validateVehicle,
    validateDriver,
    validateMaintenance,
    validateIncident,
    validateAccident,
    validateFuelLog,
    validateReservation,
    validateUser,
    validateOrganization,
    VALID_ROLES,
};
