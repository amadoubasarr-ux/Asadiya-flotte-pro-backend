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

function textValue(value, name, { max = 2000, required = false } = {}) {
    if (value === undefined || value === null) {
        if (required) throw AppError.badRequest(`Le champ "${name}" est requis.`);
        return undefined;
    }
    const s = String(value);
    if (s.length > max) throw AppError.badRequest(`Le champ "${name}" est trop long (max ${max} caractères).`);
    return s;
}

// Champ de type DATE (colonnes DATE PostgreSQL). Accepte ''/null (=> non
// renseigné) mais exige sinon un format ISO YYYY-MM-DD réellement valide.
function dateValue(value, name, { required = false } = {}) {
    if (value === undefined || value === null || value === '') {
        if (required) throw AppError.badRequest(`Le champ "${name}" est requis.`);
        return undefined;
    }
    const s = String(value).trim();
    if (s.length > 32) throw AppError.badRequest(`Le champ "${name}" est trop long.`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        throw AppError.badRequest(`Le champ "${name}" doit être une date au format AAAA-MM-JJ.`);
    }
    const d = new Date(s + 'T00:00:00Z');
    if (Number.isNaN(d.getTime())) {
        throw AppError.badRequest(`Le champ "${name}" contient une date invalide.`);
    }
    return s;
}

// Champ de type TIMESTAMPTZ (ex: début/fin d'une réservation).
function dateTimeValue(value, name, { required = false } = {}) {
    if (value === undefined || value === null || value === '') {
        if (required) throw AppError.badRequest(`Le champ "${name}" est requis.`);
        return undefined;
    }
    const s = String(value).trim();
    if (s.length > 64) throw AppError.badRequest(`Le champ "${name}" est trop long.`);
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) {
        throw AppError.badRequest(`Le champ "${name}" contient une date/heure invalide.`);
    }
    return s;
}

// Photos encodées en base64 : longueur plafonnée juste sous la limite JSON
// (15 Mo) pour empêcher un abus de la bande passante par un client.
function photoValue(value, name) {
    return textValue(value, name, { max: 16_000_000 });
}

// ===== Ressources =====

const VEHICLE_KEYS = [
    'plate', 'brand', 'model', 'year', 'mileage', 'lastOilChangeKm', 'nextOilChangeKm',
    'fuel', 'status', 'driver', 'insuranceExpiry', 'registrationExpiry', 'technicalControlExpiry', 'photo',
];

function validateVehicle(body, { partial = false } = {}) {
    const data = pick(body || {}, VEHICLE_KEYS);
    if (!partial) requireFields(data, ['plate', 'brand', 'model'], 'un véhicule');
    if (data.plate !== undefined) data.plate = textValue(data.plate, 'plate', { max: 100 });
    if (data.brand !== undefined) data.brand = textValue(data.brand, 'brand', { max: 100 });
    if (data.model !== undefined) data.model = textValue(data.model, 'model', { max: 100 });
    if (data.fuel !== undefined) data.fuel = textValue(data.fuel, 'fuel', { max: 50 });
    if (data.status !== undefined) data.status = textValue(data.status, 'status', { max: 50 });
    if (data.driver !== undefined) data.driver = textValue(data.driver, 'driver', { max: 200 });
    if (data.photo !== undefined) data.photo = photoValue(data.photo, 'photo');
    if (data.year !== undefined) data.year = intValue(data.year, 'year', { min: 1900 });
    if (data.mileage !== undefined) data.mileage = intValue(data.mileage, 'mileage', { min: 0 });
    if (data.lastOilChangeKm !== undefined) data.lastOilChangeKm = intValue(data.lastOilChangeKm, 'lastOilChangeKm', { min: 0 });
    if (data.nextOilChangeKm !== undefined) data.nextOilChangeKm = intValue(data.nextOilChangeKm, 'nextOilChangeKm', { min: 0 });
    if (data.insuranceExpiry !== undefined) data.insuranceExpiry = dateValue(data.insuranceExpiry, 'insuranceExpiry');
    if (data.registrationExpiry !== undefined) data.registrationExpiry = dateValue(data.registrationExpiry, 'registrationExpiry');
    if (data.technicalControlExpiry !== undefined) data.technicalControlExpiry = dateValue(data.technicalControlExpiry, 'technicalControlExpiry');
    return data;
}

const DRIVER_KEYS = ['name', 'email', 'phone', 'license', 'status', 'licenseExpiry', 'photo'];

function validateDriver(body, { partial = false } = {}) {
    const data = pick(body || {}, DRIVER_KEYS);
    if (!partial) requireFields(data, ['name'], 'un conducteur');
    if (data.name !== undefined) data.name = textValue(data.name, 'name', { max: 200 });
    if (data.email !== undefined) data.email = textValue(data.email, 'email', { max: 255 });
    if (data.phone !== undefined) data.phone = textValue(data.phone, 'phone', { max: 50 });
    if (data.license !== undefined) data.license = textValue(data.license, 'license', { max: 100 });
    if (data.status !== undefined) data.status = textValue(data.status, 'status', { max: 50 });
    if (data.photo !== undefined) data.photo = photoValue(data.photo, 'photo');
    if (data.licenseExpiry !== undefined) data.licenseExpiry = dateValue(data.licenseExpiry, 'licenseExpiry');
    return data;
}

const MAINTENANCE_KEYS = ['vehicleId', 'vehicle', 'type', 'cost', 'date', 'status', 'provider'];

function validateMaintenance(body, { partial = false } = {}) {
    const data = pick(body || {}, MAINTENANCE_KEYS);
    if (!partial) requireFields(data, ['vehicleId', 'type', 'date'], 'un entretien');
    if (data.vehicleId !== undefined) data.vehicleId = intValue(data.vehicleId, 'vehicleId', { min: 1 });
    if (data.vehicle !== undefined) data.vehicle = textValue(data.vehicle, 'vehicle', { max: 200 });
    if (data.type !== undefined) data.type = textValue(data.type, 'type', { max: 200 });
    if (data.status !== undefined) data.status = textValue(data.status, 'status', { max: 100 });
    if (data.provider !== undefined) data.provider = textValue(data.provider, 'provider', { max: 200 });
    if (data.cost !== undefined) data.cost = numberValue(data.cost, 'cost', { min: 0 });
    if (data.date !== undefined) data.date = dateValue(data.date, 'date', { required: !partial });
    return data;
}

const INCIDENT_KEYS = ['vehicleId', 'vehicle', 'driverId', 'driver', 'title', 'priority', 'date', 'status', 'description'];

function validateIncident(body, { partial = false } = {}) {
    const data = pick(body || {}, INCIDENT_KEYS);
    if (!partial) requireFields(data, ['vehicleId', 'title'], 'un signalement');
    if (data.vehicleId !== undefined) data.vehicleId = intValue(data.vehicleId, 'vehicleId', { min: 1 });
    if (data.driverId !== undefined && data.driverId !== '') data.driverId = intValue(data.driverId, 'driverId', { min: 1 });
    if (data.vehicle !== undefined) data.vehicle = textValue(data.vehicle, 'vehicle', { max: 200 });
    if (data.driver !== undefined) data.driver = textValue(data.driver, 'driver', { max: 200 });
    if (data.title !== undefined) data.title = textValue(data.title, 'title', { max: 300 });
    if (data.priority !== undefined) data.priority = textValue(data.priority, 'priority', { max: 50 });
    if (data.status !== undefined) data.status = textValue(data.status, 'status', { max: 100 });
    if (data.description !== undefined) data.description = textValue(data.description, 'description', { max: 4000 });
    if (data.date !== undefined) data.date = dateValue(data.date, 'date');
    return data;
}

const ACCIDENT_KEYS = ['vehicleId', 'vehicle', 'driverId', 'driver', 'date', 'location', 'damage', 'thirdParty', 'report', 'costEstimate', 'status'];

function validateAccident(body, { partial = false } = {}) {
    const data = pick(body || {}, ACCIDENT_KEYS);
    if (!partial) requireFields(data, ['vehicleId', 'date', 'location'], 'un accident');
    if (data.vehicleId !== undefined) data.vehicleId = intValue(data.vehicleId, 'vehicleId', { min: 1 });
    if (data.driverId !== undefined && data.driverId !== '') data.driverId = intValue(data.driverId, 'driverId', { min: 1 });
    if (data.vehicle !== undefined) data.vehicle = textValue(data.vehicle, 'vehicle', { max: 200 });
    if (data.driver !== undefined) data.driver = textValue(data.driver, 'driver', { max: 200 });
    if (data.location !== undefined) data.location = textValue(data.location, 'location', { max: 300 });
    if (data.damage !== undefined) data.damage = textValue(data.damage, 'damage', { max: 2000 });
    if (data.thirdParty !== undefined) data.thirdParty = textValue(data.thirdParty, 'thirdParty', { max: 50 });
    if (data.report !== undefined) data.report = textValue(data.report, 'report', { max: 50 });
    if (data.status !== undefined) data.status = textValue(data.status, 'status', { max: 100 });
    if (data.costEstimate !== undefined) data.costEstimate = numberValue(data.costEstimate, 'costEstimate', { min: 0 });
    if (data.date !== undefined) data.date = dateValue(data.date, 'date', { required: !partial });
    return data;
}

const FUEL_KEYS = [
    'vehicleId', 'vehicle', 'driverId', 'driver', 'date', 'liters', 'cost',
    'pricePerLiter', 'mileage', 'fuelType', 'station', 'paymentMethod',
    'receiptNumber', 'notes',
];

function validateFuelLog(body, { partial = false } = {}) {
    const data = pick(body || {}, FUEL_KEYS);
    if (!partial) {
        requireFields(data, ['vehicleId', 'date', 'liters'], 'un plein de carburant');
        // Le montant peut être fourni directement (cost) ou calculé
        // automatiquement (litres × prix/litre) quand pricePerLiter est donné.
        if (data.cost === undefined && data.pricePerLiter === undefined) {
            throw AppError.badRequest('Le champ "cost" (ou "pricePerLiter" pour le calcul automatique) est requis pour un plein de carburant.');
        }
    }
    if (data.vehicleId !== undefined) data.vehicleId = intValue(data.vehicleId, 'vehicleId', { min: 1 });
    if (data.vehicle !== undefined) data.vehicle = textValue(data.vehicle, 'vehicle', { max: 200 });
    if (data.driverId !== undefined && data.driverId !== '') data.driverId = intValue(data.driverId, 'driverId', { min: 1 });
    if (data.driver !== undefined) data.driver = textValue(data.driver, 'driver', { max: 200 });
    if (data.liters !== undefined) data.liters = numberValue(data.liters, 'liters', { min: 0 });
    if (data.pricePerLiter !== undefined) data.pricePerLiter = numberValue(data.pricePerLiter, 'pricePerLiter', { min: 0 });
    if (data.mileage !== undefined) data.mileage = intValue(data.mileage, 'mileage', { min: 0 });
    if (data.fuelType !== undefined) data.fuelType = textValue(data.fuelType, 'fuelType', { max: 50 });
    if (data.station !== undefined) data.station = textValue(data.station, 'station', { max: 200 });
    if (data.paymentMethod !== undefined) data.paymentMethod = textValue(data.paymentMethod, 'paymentMethod', { max: 100 });
    if (data.receiptNumber !== undefined) data.receiptNumber = textValue(data.receiptNumber, 'receiptNumber', { max: 100 });
    if (data.notes !== undefined) data.notes = textValue(data.notes, 'notes', { max: 4000 });

    // Calcul automatique : montant total = litres × prix/litre.
    if (data.cost === undefined && data.liters !== undefined && data.pricePerLiter !== undefined) {
        data.cost = Math.round(parseFloat(data.liters) * parseFloat(data.pricePerLiter));
    }
    if (data.cost !== undefined) data.cost = numberValue(data.cost, 'cost', { min: 0 });

    // Un plein sans volume n'a aucun sens : litres strictement positifs à la création.
    if (!partial && data.liters !== undefined && Number(data.liters) <= 0) {
        throw AppError.badRequest('Le champ "liters" doit être strictement positif pour un plein de carburant.');
    }
    if (data.date !== undefined) data.date = dateValue(data.date, 'date', { required: !partial });
    return data;
}

// ===== Documents =====

const DOCUMENT_KEYS = [
    'vehicleId', 'driverId', 'documentType', 'documentNumber', 'issueDate',
    'expiryDate', 'notes', 'fileName', 'filePath', 'mimeType', 'fileSize',
];

const DOCUMENT_TYPES = [
    'Assurance', 'Carte Grise', 'Contrôle Technique', 'Permis',
    'Vignette', 'Autorisation', 'Autre',
];

function validateDocument(body, { partial = false } = {}) {
    const data = pick(body || {}, DOCUMENT_KEYS);
    // Chaînes vides traitées comme absentes (rattachement "véhicule OU conducteur").
    if (data.vehicleId === '') data.vehicleId = undefined;
    if (data.driverId === '') data.driverId = undefined;

    if (!partial) {
        requireFields(data, ['documentType'], 'un document');
        const hasVehicle = data.vehicleId !== undefined && data.vehicleId !== null;
        const hasDriver = data.driverId !== undefined && data.driverId !== null;
        if (!hasVehicle && !hasDriver) {
            throw AppError.badRequest('Un document doit être rattaché à un véhicule OU à un conducteur.');
        }
        if (hasVehicle && hasDriver) {
            throw AppError.badRequest('Un document ne peut pas être rattaché à la fois à un véhicule et à un conducteur.');
        }
    }
    if (data.vehicleId !== undefined && data.vehicleId !== null) data.vehicleId = intValue(data.vehicleId, 'vehicleId', { min: 1 });
    if (data.driverId !== undefined && data.driverId !== null) data.driverId = intValue(data.driverId, 'driverId', { min: 1 });
    if (data.documentType !== undefined) {
        data.documentType = textValue(data.documentType, 'documentType', { max: 100 });
        if (!DOCUMENT_TYPES.includes(data.documentType)) {
            throw AppError.badRequest(`Type de document invalide (attendu : ${DOCUMENT_TYPES.join(', ')}).`);
        }
    }
    if (data.documentNumber !== undefined) data.documentNumber = textValue(data.documentNumber, 'documentNumber', { max: 100 });
    if (data.issueDate !== undefined) data.issueDate = dateValue(data.issueDate, 'issueDate');
    if (data.expiryDate !== undefined) data.expiryDate = dateValue(data.expiryDate, 'expiryDate');
    if (data.notes !== undefined) data.notes = textValue(data.notes, 'notes', { max: 4000 });
    if (data.fileName !== undefined) data.fileName = textValue(data.fileName, 'fileName', { max: 255 });
    if (data.filePath !== undefined) data.filePath = textValue(data.filePath, 'filePath', { max: 2000 });
    if (data.mimeType !== undefined) data.mimeType = textValue(data.mimeType, 'mimeType', { max: 100 });
    if (data.fileSize !== undefined) data.fileSize = intValue(data.fileSize, 'fileSize', { min: 0 });

    // Cohérence des dates : la date d'émission précède toujours l'expiration.
    if (data.issueDate && data.expiryDate && String(data.issueDate) > String(data.expiryDate)) {
        throw AppError.badRequest('La date d\'émission (issueDate) ne peut pas être postérieure à la date d\'expiration (expiryDate).');
    }
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
    if (data.vehicle !== undefined) data.vehicle = textValue(data.vehicle, 'vehicle', { max: 200 });
    if (data.driver !== undefined) data.driver = textValue(data.driver, 'driver', { max: 200 });
    if (data.purpose !== undefined) data.purpose = textValue(data.purpose, 'purpose', { max: 2000 });

    if (data.start !== undefined) data.start = dateTimeValue(data.start, 'start', { required: !partial });

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
        const pwd = String(data.password);
        if (pwd.length < 6) {
            throw AppError.badRequest('Le mot de passe doit contenir au moins 6 caractères.');
        }
        if (pwd.length > 128) {
            throw AppError.badRequest('Le mot de passe est trop long (max 128 caractères).');
        }
        data.password = pwd;
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
    data.name = textValue(data.name, 'name', { max: 200 });
    data.adminName = textValue(data.adminName, 'adminName', { max: 200 });
    data.adminUsername = textValue(data.adminUsername, 'adminUsername', { max: 100 });
    const pwd = String(data.adminPassword);
    if (pwd.length < 6) {
        throw AppError.badRequest('Le mot de passe doit contenir au moins 6 caractères.');
    }
    if (pwd.length > 128) {
        throw AppError.badRequest('Le mot de passe est trop long (max 128 caractères).');
    }
    data.adminPassword = pwd;
    return data;
}

module.exports = {
    validateVehicle,
    validateDriver,
    validateMaintenance,
    validateIncident,
    validateAccident,
    validateFuelLog,
    validateDocument,
    validateReservation,
    validateUser,
    validateOrganization,
    VALID_ROLES,
    DOCUMENT_TYPES,
};
