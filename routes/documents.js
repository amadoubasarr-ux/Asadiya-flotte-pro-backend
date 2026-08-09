const express = require('express');
const multer = require('multer');
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { documents } = require('../db/repositories');
const { validateDocument } = require('../utils/validators');
const { documentStatus } = require('../db/analytics');
const { config } = require('../config');
const documentFiles = require('../services/documentFiles');

// ============================================================
// Routes Documents (module documentation)
//  - GET    /            → liste filtrée (vehicleId, driverId, documentType,
//                          status, recherche, expiryFrom/expiryTo), triée par
//                          échéance ou création et paginée
//  - GET    /:id         → détail d'un document (avec statut dérivé)
//  - POST   /            → création (ADMIN, MANAGER) — rattachement véhicule OU
//                          conducteur, métadonnées de fichier uniquement
//  - PUT    /:id         → modification (ADMIN, MANAGER)
//  - DELETE /:id         → suppression (ADMIN, MANAGER) — nettoie la pièce jointe
//
// Pièces jointes (Phase Documentation — Commit 5) :
//  - GET    /:id/file    → télécharger / visualiser la pièce jointe (tous rôles)
//  - POST   /:id/file    → uploader / remplacer la pièce jointe (ADMIN, MANAGER)
//  - DELETE /:id/file    → supprimer la pièce jointe (ADMIN, MANAGER)
//
// Lecture : tous les comptes rattachés à une organisation (DRIVER inclus).
// Écriture : réservée aux rôles de gestion. Le statut (OK / SOON / CRITICAL /
// EXPIRED / UNKNOWN) est dérivé de la date d'expiration (db/analytics.documentStatus),
// jamais stocké : EXPIRED (< 0 j), CRITICAL (≤ 7 j), SOON (≤ 30 j), OK, UNKNOWN.
//
// SÉCURITÉ MULTI-TENANT (prioritaire) : chaque accès fichier recherche le
// document par (documentId + organizationId) — jamais par le seul documentId.
// Le chemin physique est un chemin interne relatif sûr, jamais exposé ; la
// lecture passe obligatoirement par l'API authentifiée (pas de express.static
// sur le dossier uploads).
// ============================================================

const DOCUMENT_STATUSES = ['OK', 'CRITICAL', 'SOON', 'EXPIRED', 'UNKNOWN'];

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

// ============================================================
// Upload multipart sécurisé (multer, mémoire uniquement)
// ============================================================
// La limite multer (413) s'applique avant toute écriture sur disque ; la
// validation complète (extension, MIME, contenu, nom) est faite ensuite par
// services/documentFiles.validateUploadFile avant la moindre écriture.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: config.documentMaxFileSize,
        files: 1,
    },
});

function uploadSingleFile(req, res, next) {
    upload.single('file')(req, res, (err) => {
        if (!err) return next();
        if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ error: 'Le fichier est trop volumineux (10 MB maximum).', code: 'file_too_large' });
        }
        if (err instanceof multer.MulterError) {
            return res.status(400).json({ error: 'Upload invalide : ' + err.message, code: 'upload_error' });
        }
        return next(err);
    });
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
    const item = await documents.findById(req.user.organizationId, req.params.id);
    if (!item) throw AppError.notFound('Introuvable.');
    const filePath = item.filePath || null;
    const ok = await documents.remove(req.user.organizationId, req.params.id);
    if (!ok) throw AppError.notFound('Introuvable.');
    // Nettoyage de la pièce jointe physique : meilleur effort, après la
    // suppression en base (aucun fichier orphelin).
    if (filePath) await documentFiles.removeFile(filePath);
    res.status(204).end();
}));

// ============================================================
// Pièces jointes — upload / téléchargement / suppression
// ============================================================

// Télécharger / visualiser la pièce jointe (tous les rôles de l'organisation,
// DRIVER inclus). Le document est TOUJOURS recherché par (id + organizationId) :
// impossible de lire le fichier d'une autre organisation. Le chemin physique
// résolu est vérifié (anti traversée) et reste interne au dossier uploads.
router.get('/:id/file', requireAuth, requireOrgUser, asyncHandler(async (req, res) => {
    const item = await documents.findById(req.user.organizationId, req.params.id);
    if (!item || !item.filePath) throw AppError.notFound('Pièce jointe introuvable.');
    const stream = documentFiles.createReadStream(item.filePath);
    if (!stream) {
        // Fichier physique absent : les métadonnées sont orphelines.
        await documents.clearFileMetadata(req.user.organizationId, item.id);
        throw AppError.notFound('Pièce jointe introuvable.');
    }
    res.setHeader('Content-Type', item.mimeType || 'application/octet-stream');
    if (item.fileSize != null) res.setHeader('Content-Length', String(item.fileSize));
    res.setHeader(
        'Content-Disposition',
        `inline; filename="${documentFiles.dispositionFileName(item.fileName || 'document')}"`
    );
    res.setHeader('Cache-Control', 'private, no-store');
    stream.on('error', () => {
        if (!res.headersSent) {
            res.removeHeader('Content-Length');
            res.status(404).end();
        }
    });
    stream.pipe(res);
}));

// Uploader / remplacer la pièce jointe (ADMIN, MANAGER). Ordre de sécurité :
//  1. validation complète + écriture du nouveau fichier sur disque ;
//  2. mise à jour des métadonnées en base ;
//  3. suppression de l'ancien fichier physique (après succès, jamais avant).
// Si la mise à jour en base échoue, le nouveau fichier est retiré (pas d'orphelin).
router.post('/:id/file', requireAuth, requireOrgUser, requireRole('ADMIN', 'MANAGER'), uploadSingleFile, asyncHandler(async (req, res) => {
    if (!req.file) throw AppError.badRequest('Aucun fichier reçu (champ multipart "file" attendu).');
    const item = await documents.findById(req.user.organizationId, req.params.id);
    if (!item) {
        throw AppError.notFound('Document introuvable.');
    }

    const saved = await documentFiles.saveFile({
        organizationId: req.user.organizationId,
        documentId: item.id,
        file: req.file,
    });

    let updated;
    try {
        updated = await documents.setFileMetadata(req.user.organizationId, item.id, {
            filePath: saved.relativePath,
            fileName: saved.originalName,
            mimeType: saved.mimeType,
            fileSize: saved.size,
            fileUploadedAt: new Date().toISOString(),
        });
    } catch (err) {
        // L'écriture en base a échoué : on retire le fichier fraîchement écrit
        // pour ne pas laisser d'orphelin, puis on propage l'erreur.
        await documentFiles.removeFile(saved.relativePath);
        throw err;
    }

    // Remplacement : l'ancien fichier est supprimé UNIQUEMENT après le succès
    // complet (nouveau fichier écrit + métadonnées en base).
    if (item.filePath && item.filePath !== saved.relativePath) {
        await documentFiles.removeFile(item.filePath);
    }

    res.json(attachStatus(updated));
}));

// Supprimer la pièce jointe (ADMIN, MANAGER) : le document est conservé.
//  1. métadonnées nettoyées en base ;
//  2. fichier physique supprimé (meilleur effort : absent déjà => idem).
router.delete('/:id/file', requireAuth, requireOrgUser, requireRole('ADMIN', 'MANAGER'), asyncHandler(async (req, res) => {
    const item = await documents.findById(req.user.organizationId, req.params.id);
    if (!item) throw AppError.notFound('Document introuvable.');
    if (!item.filePath) throw AppError.notFound('Aucune pièce jointe à supprimer.');
    const filePath = item.filePath;
    const updated = await documents.clearFileMetadata(req.user.organizationId, item.id);
    await documentFiles.removeFile(filePath);
    res.json(attachStatus(updated));
}));

module.exports = router;
