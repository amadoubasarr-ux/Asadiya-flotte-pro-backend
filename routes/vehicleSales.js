const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { vehicleSales } = require('../db/repositories');
const {
    validateVehicleSale,
    SALE_STATUSES,
    SALE_PAYMENT_STATUSES,
    SALE_DELIVERY_STATUSES,
} = require('../utils/validators');

// ============================================================
// Routes Ventes de véhicules (Phase 7.7 — Commit 1)
//  - GET    /            → liste filtrée (status, paymentStatus,
//                          deliveryStatus, vehicleId, recherche,
//                          dateFrom/dateTo), triée et paginée
//  - GET    /:id         → détail d'une vente
//  - POST   /            → création (ADMIN, MANAGER)
//  - PUT    /:id         → modification (ADMIN, MANAGER)
//  - DELETE /:id         → suppression (ADMIN, MANAGER)
//
// Lecture : tous les comptes rattachés à une organisation (DRIVER inclus).
// Écriture : réservée aux rôles de gestion. Le numéro de vente, le prix
// total (prix + taxes + frais) et les instantanés « vehicle » / « buyerName »
// sont générés côté serveur (db/repositories.js) : jamais fournis par le client.
// ============================================================

function requireOrgUser(req, res, next) {
    if (!req.user || !req.user.organizationId) {
        return res.status(403).json({ error: 'Cette ressource nécessite un compte rattaché à une organisation.' });
    }
    next();
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
    const { status, paymentStatus, deliveryStatus, search, sort, page, pageSize } = req.query;
    if (status !== undefined && status !== '' && !SALE_STATUSES.includes(status)) {
        throw AppError.badRequest(`Statut de vente invalide (attendu : ${SALE_STATUSES.join(', ')}).`);
    }
    if (paymentStatus !== undefined && paymentStatus !== '' && !SALE_PAYMENT_STATUSES.includes(paymentStatus)) {
        throw AppError.badRequest(`Statut de paiement invalide (attendu : ${SALE_PAYMENT_STATUSES.join(', ')}).`);
    }
    if (deliveryStatus !== undefined && deliveryStatus !== '' && !SALE_DELIVERY_STATUSES.includes(deliveryStatus)) {
        throw AppError.badRequest(`Statut de livraison invalide (attendu : ${SALE_DELIVERY_STATUSES.join(', ')}).`);
    }
    const rows = await vehicleSales.findAllByOrg(req.user.organizationId, {
        status: status || undefined,
        paymentStatus: paymentStatus || undefined,
        deliveryStatus: deliveryStatus || undefined,
        vehicleId: parseIdFilter(req.query.vehicleId, 'vehicleId'),
        search: search || undefined,
        dateFrom: parseDateFilter(req.query.dateFrom, 'dateFrom'),
        dateTo: parseDateFilter(req.query.dateTo, 'dateTo'),
    });
    const items = [...rows];
    if (sort === 'date') {
        items.sort((a, b) => String(b.saleDate || '').localeCompare(String(a.saleDate || '')));
    } else if (sort === 'price') {
        items.sort((a, b) => (parseFloat(b.totalPrice) || 0) - (parseFloat(a.totalPrice) || 0));
    } else {
        items.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    }
    const p = Math.max(1, parseInt(page, 10) || 1);
    const ps = Math.min(200, Math.max(1, parseInt(pageSize, 10) || 100));
    res.json({ items: items.slice((p - 1) * ps, p * ps), total: items.length, page: p, pageSize: ps });
}));

router.get('/:id', requireAuth, requireOrgUser, asyncHandler(async (req, res) => {
    const item = await vehicleSales.findById(req.user.organizationId, req.params.id);
    if (!item) throw AppError.notFound('Introuvable.');
    res.json(item);
}));

router.post('/', requireAuth, requireOrgUser, requireRole('ADMIN', 'MANAGER'), asyncHandler(async (req, res) => {
    const body = validateVehicleSale(req.body || {});
    // Le vendeur est l'utilisateur connecté par défaut.
    if (body.salespersonId === undefined) body.salespersonId = req.user.id;
    const item = await vehicleSales.create(req.user.organizationId, body);
    res.status(201).json(item);
}));

router.put('/:id', requireAuth, requireOrgUser, requireRole('ADMIN', 'MANAGER'), asyncHandler(async (req, res) => {
    const body = validateVehicleSale(req.body || {}, { partial: true });
    const item = await vehicleSales.update(req.user.organizationId, req.params.id, body);
    if (!item) throw AppError.notFound('Introuvable.');
    res.json(item);
}));

router.delete('/:id', requireAuth, requireOrgUser, requireRole('ADMIN', 'MANAGER'), asyncHandler(async (req, res) => {
    const ok = await vehicleSales.remove(req.user.organizationId, req.params.id);
    if (!ok) throw AppError.notFound('Introuvable.');
    res.status(204).end();
}));

module.exports = router;
