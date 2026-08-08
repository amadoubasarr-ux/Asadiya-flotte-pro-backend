const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { documents } = require('../db/repositories');
const { validateDocument } = require('../utils/validators');
const { documentStatus } = require('../db/analytics');

// ============================================================
// Routes Documents (module documentation)
//  - GET    /      → liste filtrée (vehicleId, driverId, documentType,
//                    status, recherche, expiryFrom/expiryTo), triée par
//                    échéance ou création et paginée
//  - GET    /:id   → détail d'un document (avec statut dérivé)
//  - POST   /      → création (ADMIN, MANAGER) — rattachement véhicule OU
//                    conducteur, métadonnées de fichier uniquement
//  - PUT    /:id   → modification (ADMIN, MANAGER)
//  - DELETE /:id   → suppression (ADMIN, MANAGER)
//
// Lecture : tous les comptes rattachés à une organisation (DRIVER inclus).
// Écriture : réservée aux rôles de gestion. Le statut (OK / SOON / EXPIRED /
// UNKNOWN) est dérivé de la date d'expiration (db/analytics.documentStatus),
// jamais stocké.
// ============================================================

const DOCUMENT_STATUSES = ['OK', 'SOON', 'EXPIRED', 'UNKNOWN'];

function requireOrgUser(req, res, next) {
    if (!req.user || !req.user.organizationId) {
        return res.status(403).json({ error: 'Cette ressource nécessite un compte rattaché à une organisation.' });
    }
    next();
}

function attachStatus(doc) {
    if (!doc) return doc;
    const { status, daysLeft } = documentStatus(doc.expiryDate);
    return { ...doc, status, daysLeft };
}

function parseIdFilter(value, name) {
    if (value === undefined || value === null || value === '') return undefined;
    const n = parseInt(value, 10);
    if (!Number.isInteger(n) || n < 1) {
        throw AppError.badRequest(`Le filtre "${name}" doit être un nombre entier positif.`);
    }
    return n;
}

function parseDateFilter(value, name) {
    if (value === undefined || value === null || value === '') return undefined;
    const s = String(value).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        throw AppError.badRequest(`Le filtre "${name}" doit être une date au format AAAA-MM-JJ.`);
    }
    return s;
}

const router = express.Router();

router.get('/', requireAuth, requireOrgUser, asyncHandler(async (req, res) => {
    const { search, status, sort, page, pageSize } = req.query;
    if (status !== undefined && status !== '' && !DOCUMENT_STATUSES.includes(status)) {
        throw AppError.badRequest(`Statut invalide (attendu : ${DOCUMENT_STATUSES.join(', ')}).`);
    }
    const rows = await documents.findAllByOrg(req.user.organizationId, {
        vehicleId: parseIdFilter(req.query.vehicleId, 'vehicleId'),
        driverId: parseIdFilter(req.query.driverId, 'driverId'),
        documentType: req.query.documentType || undefined,
        search: search || undefined,
        expiryFrom: parseDateFilter(req.query.expiryFrom, 'expiryFrom'),
        expiryTo: parseDateFilter(req.query.expiryTo, 'expiryTo'),
    });
    let items = rows.map(attachStatus);
    if (status) items = items.filter((d) => d.status === status);
    // Tri par date d'expiration (croissante) ou par date de création
    // (décroissante, ordre par défaut).
    if (sort === 'expiry') {
        items.sort((a, b) => String(a.expiryDate || '9999-12-31').localeCompare(String(b.expiryDate || '9999-12-31')));
    } else {
        items.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    }
    const p = Math.max(1, parseInt(page, 10) || 1);
    const ps = Math.min(200, Math.max(1, parseInt(pageSize, 10) || 100));
    res.json({ items: items.slice((p - 1) * ps, p * ps), total: items.length, page: p, pageSize: ps });
}));

router.get('/:id', requireAuth, requireOrgUser, asyncHandler(async (req, res) => {
    const item = await documents.findById(req.user.organizationId, req.params.id);
    if (!item) throw AppError.notFound('Introuvable.');
    res.json(attachStatus(item));
}));

router.post('/', requireAuth, requireOrgUser, requireRole('ADMIN', 'MANAGER'), asyncHandler(async (req, res) => {
    const body = validateDocument(req.body || {});
    const item = await documents.create(req.user.organizationId, body);
    res.status(201).json(attachStatus(item));
}));

router.put('/:id', requireAuth, requireOrgUser, requireRole('ADMIN', 'MANAGER'), asyncHandler(async (req, res) => {
    const body = validateDocument(req.body || {}, { partial: true });
    const item = await documents.update(req.user.organizationId, req.params.id, body);
    if (!item) throw AppError.notFound('Introuvable.');
    res.json(attachStatus(item));
}));

router.delete('/:id', requireAuth, requireOrgUser, requireRole('ADMIN', 'MANAGER'), asyncHandler(async (req, res) => {
    const ok = await documents.remove(req.user.organizationId, req.params.id);
    if (!ok) throw AppError.notFound('Introuvable.');
    res.status(204).end();
}));

module.exports = router;
