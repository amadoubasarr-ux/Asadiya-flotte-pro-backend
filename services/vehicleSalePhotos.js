// ============================================================
// Stockage sécurisé des photos de vente de véhicules
// (Phase 7.7 — Commit 4)
// ============================================================
// Les fichiers sont enregistrés sur disque (jamais en base64 dans
// PostgreSQL) sous :
//   uploads/vehicle-sales/<organizationId>/<saleId>/photo_<uuid>.<ext>
// La clé de stockage relative (storage_key) stockée en base ne contient
// que des segments sûrs (chiffres / UUID / extension contrôlée) : elle
// n'est JAMAIS exposée au client (seule la lecture authentifiée par l'API
// est possible). Le répertoire « uploads » est un volume Docker persistant,
// jamais servi en statique.
//
// Validation multi-niveaux (aucune confiance accordée au seul MIME du
// navigateur), sur le même modèle que services/documentFiles.js :
//   1. extension contrôlée (JPG, PNG, WEBP) ;
//   2. MIME déclaré dans la liste autorisée et cohérent avec l'extension ;
//   3. taille <= PHOTO_MAX_FILE_SIZE (5 MB par défaut) ;
//   4. nom original sûr (pas de /, \, .., octet nul) ;
//   5. « magic bytes » du contenu cohérents avec le MIME déclaré.
// ============================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AppError = require('../utils/AppError');
const { config } = require('../config');
const logger = require('../utils/logger');
const documentFiles = require('./documentFiles');

// Types MIME autorisés pour les photos : uniquement les images déjà
// contrôlées par signature binaire dans services/documentFiles.js.
const PHOTO_ALLOWED_TYPES = {
    'image/jpeg': documentFiles.ALLOWED_TYPES['image/jpeg'],
    'image/png': documentFiles.ALLOWED_TYPES['image/png'],
    'image/webp': documentFiles.ALLOWED_TYPES['image/webp'],
};

const PHOTO_ALLOWED_EXTENSIONS = Object.values(PHOTO_ALLOWED_TYPES)
    .flatMap((t) => t.extensions)
    .sort();

/** Détermine le type autorisé depuis l'extension du nom original. */
function extensionToMime(basename) {
    const ext = path.extname(basename).toLowerCase();
    for (const [mime, info] of Object.entries(PHOTO_ALLOWED_TYPES)) {
        if (info.extensions.includes(ext)) return mime;
    }
    return null;
}

/** Détecte le type réel d'un buffer via ses « magic bytes ». */
function detectMime(buffer) {
    for (const [mime, info] of Object.entries(PHOTO_ALLOWED_TYPES)) {
        if (info.detect(buffer)) return mime;
    }
    return null;
}

/**
 * Valide une photo (fichier + taille + nom + extension + MIME + contenu).
 * Lance AppError 400/413 en cas de refus. Retourne le nom original assaini.
 */
function validatePhotoFile(file) {
    if (!file || !file.buffer) {
        throw AppError.badRequest('Aucun fichier reçu (champ multipart "file" attendu).');
    }
    if (file.size > config.photoMaxFileSize) {
        throw new AppError(413, 'La photo dépasse la taille maximale autorisée.', { code: 'file_too_large' });
    }
    const originalName = documentFiles.sanitizeOriginalName(file.originalname);
    if (originalName === '') {
        throw AppError.badRequest('Nom de fichier manquant.');
    }

    // 1. Extension contrôlée.
    const declaredByExtension = extensionToMime(originalName);
    if (!declaredByExtension) {
        throw AppError.badRequest(
            `Extension de fichier non autorisée. Formats acceptés : ${PHOTO_ALLOWED_EXTENSIONS.join(', ')}.`
        );
    }

    // 2. MIME déclaré (en-tête) autorisé ET cohérent avec l'extension.
    const declaredMime = String(file.mimetype || '').toLowerCase();
    if (!PHOTO_ALLOWED_TYPES[declaredMime]) {
        throw AppError.badRequest(
            `Type MIME non autorisé ("${declaredMime}"). Formats acceptés : ${Object.keys(PHOTO_ALLOWED_TYPES).join(', ')}.`
        );
    }
    if (declaredMime !== declaredByExtension) {
        throw AppError.badRequest(`Incohérence entre l'extension ("${path.extname(originalName)}") et le type MIME déclaré ("${declaredMime}").`);
    }

    // 3. Contenu réel (« magic bytes ») cohérent.
    const detected = detectMime(file.buffer);
    if (!detected || detected !== declaredMime) {
        throw AppError.badRequest('Le contenu du fichier ne correspond pas au type déclaré.');
    }

    return { originalName, mimeType: declaredMime };
}

/**
 * Écrit la photo sur disque et retourne les métadonnées à stocker en base.
 * Le nom interne (photo_<uuid>.<ext>) est généré par le serveur : le nom
 * original ne sert jamais à construire un chemin système.
 */
async function savePhoto({ organizationId, saleId, file }) {
    const { originalName, mimeType } = validatePhotoFile(file);
    const dir = path.join(config.uploadsDir, 'vehicle-sales', String(organizationId), String(saleId));
    fs.mkdirSync(dir, { recursive: true });

    const ext = path.extname(originalName).toLowerCase();
    const storedName = `photo_${crypto.randomUUID()}${ext}`;
    const absolutePath = path.join(dir, storedName);

    await fs.promises.writeFile(absolutePath, file.buffer, { flag: 'wx' });
    logger.info('vehicle_sales.photo_saved', { organizationId, saleId, fileName: storedName, size: file.size });

    return {
        // Clé de stockage relative, stockée en base (jamais exposée au client).
        storageKey: path.posix.join('vehicle-sales', String(organizationId), String(saleId), storedName),
        originalName,
        mimeType,
        sizeBytes: file.size,
        absolutePath,
    };
}

/** Supprime le fichier physique d'une photo à partir de sa clé (idempotent). */
async function removePhoto(storageKey) {
    await documentFiles.removeFile(storageKey);
}

/** Ouvre un flux de lecture vers la photo (null si clé invalide ou absente). */
function createReadStream(storageKey) {
    return documentFiles.createReadStream(storageKey);
}

module.exports = {
    PHOTO_ALLOWED_TYPES,
    PHOTO_ALLOWED_EXTENSIONS,
    validatePhotoFile,
    savePhoto,
    removePhoto,
    createReadStream,
    dispositionFileName: documentFiles.dispositionFileName,
};
