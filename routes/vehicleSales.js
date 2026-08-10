const express = require('express');
const multer = require('multer');
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { vehicleSales, vehicleSalePhotos } = require('../db/repositories');
const {
    validateVehicleSale,
    SALE_STATUSES,
    SALE_PAYMENT_STATUSES,
    SALE_DELIVERY_STATUSES,
} = require('../utils/validators');
const { config } = require('../config');
const vehicleSalePhotosService = require('../services/vehicleSalePhotos');

// ============================================================
// Routes Ventes de véhicules (Phase 7.7 — Commit 1)
//  - GET    /            → liste filtrée (status, paymentStatus,
//                          deliveryStatus, vehicleId, recherche,
//                          dateFrom/dateTo), triée et paginée
//  - GET    /:id         → détail d'une vente
//  - POST   /            → création (ADMIN, MANAGER)
//  - PUT    /:id         → modification (ADMIN, MANAGER)
//  - DELETE /:id         → suppression (ADMIN, MANAGER) — nettoie les photos
//
// Photos (Phase 7.7 — Commit 4) :
//  - GET    /:saleId/photos               → liste des photos d'une vente
//  - POST   /:saleId/photos               → ajouter une photo (ADMIN, MANAGER)
//  - GET    /:saleId/photos/:photoId      → visualiser / télécharger une photo
//  - DELETE /:saleId/photos/:photoId      → supprimer une photo (ADMIN, MANAGER)
//  - PUT    /:saleId/photos/:photoId/primary → définir la photo principale
//  - PUT    /:saleId/photos               → réordonner les photos (ADMIN, MANAGER)
//
// Lecture : tous les comptes rattachés à une organisation (DRIVER inclus).
// Écriture : réservée aux rôles de gestion. Le numéro de vente, le prix
// total (prix + taxes + frais), les instantanés « vehicle » / « buyerName »
// et toutes les métadonnées de photos sont générés côté serveur
// (db/repositories.js + services/vehicleSalePhotos.js) : jamais fournis par
// le client.
//
// SÉCURITÉ MULTI-TENANT (prioritaire) : chaque accès photo vérifie
// (photoId + organizationId) ET l'appartenance de la photo à la vente de
// l'URL. Le chemin physique (storage_key) est un chemin relatif interne sûr,
// jamais exposé au client ; la lecture passe obligatoirement par l'API
// authentifiée (pas de express.static sur le dossier uploads).
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

/** Supprime la clé de stockage interne d'une photo (jamais exposée). */
function stripStorageKey(photo) {
    if (!photo) return null;
    const { storageKey: _storageKey, ...rest } = photo;
    return rest;
}

// ============================================================
// Upload multipart sécurisé (multer, mémoire uniquement)
// ============================================================
// La limite multer (413) s'applique avant toute écriture sur disque ; la
// validation complète (extension, MIME, contenu, nom) est faite ensuite par
// services/vehicleSalePhotos.validatePhotoFile avant la moindre écriture.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: config.photoMaxFileSize,
        files: 1,
    },
});

function uploadSinglePhoto(req, res, next) {
    upload.single('file')(req, res, (err) => {
        if (!err) return next();
        if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ error: 'La photo est trop volumineuse (5 MB maximum).', code: 'file_too_large' });
        }
        if (err instanceof multer.MulterError) {
            return res.status(400).json({ error: 'Upload invalide : ' + err.message, code: 'upload_error' });
        }
        return next(err);
    });
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
    // Clés de stockage des photos AVANT suppression : le nettoyage physique
    // doit suivre la suppression en base (aucun fichier orphelin).
    const photoKeys = await vehicleSalePhotos.listStorageKeysBySale(req.user.organizationId, req.params.id);
    const ok = await vehicleSales.remove(req.user.organizationId, req.params.id);
    if (!ok) throw AppError.notFound('Introuvable.');
    // La suppression en base (ON DELETE CASCADE) retire les lignes photos ;
    // on retire alors les fichiers physiques (meilleur effort).
    for (const key of photoKeys) {
        await vehicleSalePhotosService.removePhoto(key);
    }
    res.status(204).end();
}));

// ============================================================
// Photos — liste / upload / visualisation / suppression / principale / ordre
// ============================================================

router.get('/:saleId/photos', requireAuth, requireOrgUser, asyncHandler(async (req, res) => {
    const saleId = parseIdFilter(req.params.saleId, 'saleId');
    const sale = await vehicleSales.findById(req.user.organizationId, saleId);
    if (!sale) throw AppError.notFound('Vente introuvable.');
    const photos = await vehicleSalePhotos.listBySale(req.user.organizationId, saleId);
    res.json({ items: photos.map(stripStorageKey), total: photos.length });
}));

router.post('/:saleId/photos', requireAuth, requireOrgUser, requireRole('ADMIN', 'MANAGER'), uploadSinglePhoto, asyncHandler(async (req, res) => {
    if (!req.file) throw AppError.badRequest('Aucun fichier reçu (champ multipart "file" attendu).');
    const saleId = parseIdFilter(req.params.saleId, 'saleId');
    const sale = await vehicleSales.findById(req.user.organizationId, saleId);
    if (!sale) {
        throw AppError.notFound('Vente introuvable.');
    }

    const saved = await vehicleSalePhotosService.savePhoto({
        organizationId: req.user.organizationId,
        saleId,
        file: req.file,
    });

    let created;
    try {
        created = await vehicleSalePhotos.create(req.user.organizationId, saleId, saved);
    } catch (err) {
        // L'écriture en base a échoué : on retire le fichier fraîchement écrit
        // pour ne pas laisser d'orphelin, puis on propage l'erreur.
        await vehicleSalePhotosService.removePhoto(saved.storageKey);
        throw err;
    }

    res.status(201).json(stripStorageKey(created));
}));

router.get('/:saleId/photos/:photoId', requireAuth, requireOrgUser, asyncHandler(async (req, res) => {
    const saleId = parseIdFilter(req.params.saleId, 'saleId');
    const photoId = parseIdFilter(req.params.photoId, 'photoId');
    const photo = await vehicleSalePhotos.findById(req.user.organizationId, photoId);
    // La photo doit appartenir à la vente de l'URL : toute tentative de
    // lecture croisée (vente / organisation) est traitée comme introuvable.
    if (!photo || Number(photo.vehicleSaleId) !== saleId) {
        throw AppError.notFound('Photo introuvable.');
    }
    const meta = await vehicleSalePhotos.findStorageKey(req.user.organizationId, photoId);
    if (!meta) throw AppError.notFound('Photo introuvable.');
    const stream = vehicleSalePhotosService.createReadStream(meta.storageKey);
    if (!stream) {
        throw AppError.notFound('Photo introuvable.');
    }
    res.setHeader('Content-Type', photo.mimeType || 'application/octet-stream');
    if (photo.sizeBytes != null) res.setHeader('Content-Length', String(photo.sizeBytes));
    res.setHeader(
        'Content-Disposition',
        `inline; filename="${vehicleSalePhotosService.dispositionFileName(photo.originalName || 'photo')}"`
    );
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    stream.on('error', () => {
        if (!res.headersSent) {
            res.removeHeader('Content-Length');
            res.status(404).end();
        }
    });
    stream.pipe(res);
}));

router.delete('/:saleId/photos/:photoId', requireAuth, requireOrgUser, requireRole('ADMIN', 'MANAGER'), asyncHandler(async (req, res) => {
    const saleId = parseIdFilter(req.params.saleId, 'saleId');
    const photoId = parseIdFilter(req.params.photoId, 'photoId');
    // Vérification d'appartenance AVANT toute suppression : une photo ne peut
    // être supprimée que via la vente à laquelle elle appartient (sinon 404
    // et aucune mutation, ni en base ni sur disque).
    const meta = await vehicleSalePhotos.findStorageKey(req.user.organizationId, photoId);
    if (!meta || Number(meta.vehicleSaleId) !== saleId) {
        throw AppError.notFound('Photo introuvable.');
    }
    const removed = await vehicleSalePhotos.remove(req.user.organizationId, photoId);
    // Suppression physique (meilleur effort) après la suppression en base.
    await vehicleSalePhotosService.removePhoto(meta.storageKey);
    res.json(stripStorageKey(removed));
}));

router.put('/:saleId/photos/:photoId/primary', requireAuth, requireOrgUser, requireRole('ADMIN', 'MANAGER'), asyncHandler(async (req, res) => {
    const saleId = parseIdFilter(req.params.saleId, 'saleId');
    const photoId = parseIdFilter(req.params.photoId, 'photoId');
    const photo = await vehicleSalePhotos.findById(req.user.organizationId, photoId);
    if (!photo || Number(photo.vehicleSaleId) !== saleId) {
        throw AppError.notFound('Photo introuvable.');
    }
    const updated = await vehicleSalePhotos.setPrimary(req.user.organizationId, saleId, photoId);
    res.json(stripStorageKey(updated));
}));

router.put('/:saleId/photos', requireAuth, requireOrgUser, requireRole('ADMIN', 'MANAGER'), asyncHandler(async (req, res) => {
    const saleId = parseIdFilter(req.params.saleId, 'saleId');
    const sale = await vehicleSales.findById(req.user.organizationId, saleId);
    if (!sale) throw AppError.notFound('Vente introuvable.');
    const raw = (req.body && req.body.photoIds) || [];
    if (!Array.isArray(raw) || raw.length === 0) {
        throw AppError.badRequest('Le champ "photoIds" doit être une liste non vide d\'identifiants.');
    }
    const photoIds = raw.map((id) => {
        const n = parseInt(id, 10);
        if (!Number.isInteger(n) || n < 1) {
            throw AppError.badRequest('La liste "photoIds" doit ne contenir que des identifiants entiers positifs.');
        }
        return n;
    });
    const items = await vehicleSalePhotos.reorder(req.user.organizationId, saleId, photoIds);
    res.json({ items: items.map(stripStorageKey), total: items.length });
}));

module.exports = router;
