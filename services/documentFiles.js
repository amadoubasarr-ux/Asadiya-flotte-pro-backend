// ============================================================
// Stockage sécurisé des pièces jointes documents
// (Phase Documentation — Commit 5)
// ============================================================
// Les fichiers sont enregistrés sur disque (jamais en base64 dans
// PostgreSQL) sous :
//   uploads/documents/<organizationId>/<documentId>/document_<uuid>.<ext>
// Le chemin relatif stocké en base ne contient que des segments sûrs
// (chiffres / UUID / extension contrôlée). Le répertoire « uploads » est
// un volume Docker persistant, jamais exposé en statique : la lecture
// passe obligatoirement par l'API authentifiée (routes/documents.js).
//
// Validation multi-niveaux (aucune confiance accordée au seul MIME du
// navigateur) :
//   1. extension contrôlée ;
//   2. MIME déclaré dans la liste autorisée ;
//   3. taille <= DOCUMENT_MAX_FILE_SIZE (10 MB par défaut) ;
//   4. nom original sûr (pas de /, \, .., octet nul) ;
//   5. « magic bytes » du contenu cohérents avec le MIME déclaré.
// ============================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AppError = require('../utils/AppError');
const { config } = require('../config');
const logger = require('../utils/logger');

// Types MIME autorisés, associés aux extensions et aux signatures binaires.
// Les signatures sont vérifiées sur les premiers octets du fichier
// (« magic bytes ») : un PDF déguisé en .png ou un HTML retourné comme
// image est refusé.
const ALLOWED_TYPES = {
    'application/pdf': {
        extensions: ['.pdf'],
        detect: (buf) => buf.length >= 5 && buf.slice(0, 5).toString('latin1') === '%PDF-',
    },
    'image/jpeg': {
        extensions: ['.jpg', '.jpeg'],
        detect: (buf) => buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff,
    },
    'image/png': {
        extensions: ['.png'],
        detect: (buf) => buf.length >= 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    },
    'image/webp': {
        extensions: ['.webp'],
        detect: (buf) =>
            buf.length >= 12 &&
            buf.slice(0, 4).toString('latin1') === 'RIFF' &&
            buf.slice(8, 12).toString('latin1') === 'WEBP',
    },
};

const ALLOWED_EXTENSIONS = Object.values(ALLOWED_TYPES)
    .flatMap((t) => t.extensions)
    .sort();

// Un nom original est REFUSÉ s'il contient un séparateur de chemin (/ \),
// "..", un octet nul ou un caractère de contrôle. Espaces et accents sont
// autorisés (nom d'affichage uniquement, jamais utilisé pour un chemin).
const DANGEROUS_NAME_RE = /[/\\]|\.\./;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

function ensureBaseDir() {
    fs.mkdirSync(config.uploadsDir, { recursive: true });
}

/**
 * Nom original sûr à conserver en base (affichage uniquement). Les noms
 * contenant un séparateur de chemin, ".." ou un octet nul sont rejetés :
 * le nom original ne sert JAMAIS à construire un chemin système.
 */
function sanitizeOriginalName(name) {
    if (name === undefined || name === null) return '';
    const raw = String(name).replace(/\0/g, '');
    if (DANGEROUS_NAME_RE.test(raw) || CONTROL_CHARS_RE.test(raw)) {
        throw AppError.badRequest('Nom de fichier invalide ou dangereux.');
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed === '.' || trimmed === '..') {
        throw AppError.badRequest('Nom de fichier invalide ou dangereux.');
    }
    return trimmed.slice(0, 255);
}

/** Détermine le type autorisé depuis l'extension du nom original. */
function extensionToMime(basename) {
    const ext = path.extname(basename).toLowerCase();
    for (const [mime, info] of Object.entries(ALLOWED_TYPES)) {
        if (info.extensions.includes(ext)) return mime;
    }
    return null;
}

/** Détecte le type réel d'un buffer via ses « magic bytes ». */
function detectMime(buffer) {
    for (const [mime, info] of Object.entries(ALLOWED_TYPES)) {
        if (info.detect(buffer)) return mime;
    }
    return null;
}

/**
 * Valide un fichier (déclaré MIME + extension + taille + nom + contenu).
 * Lance AppError 400/413 en cas de refus. Retourne le nom original assaini.
 */
function validateUploadFile(file) {
    if (!file || !file.buffer) {
        throw AppError.badRequest('Aucun fichier reçu (champ multipart "file" attendu).');
    }
    if (file.size > config.documentMaxFileSize) {
        throw new AppError(413, 'Le fichier dépasse la taille maximale autorisée (10 MB).', { code: 'file_too_large' });
    }
    const originalName = sanitizeOriginalName(file.originalname);
    if (originalName === '') {
        throw AppError.badRequest('Nom de fichier manquant.');
    }

    // 1. Extension contrôlée.
    const declaredByExtension = extensionToMime(originalName);
    if (!declaredByExtension) {
        throw AppError.badRequest(
            `Extension de fichier non autorisée. Formats acceptés : ${ALLOWED_EXTENSIONS.join(', ')}.`
        );
    }

    // 2. MIME déclaré (en-tête) autorisé ET cohérent avec l'extension.
    const declaredMime = String(file.mimetype || '').toLowerCase();
    if (!ALLOWED_TYPES[declaredMime]) {
        throw AppError.badRequest(
            `Type MIME non autorisé ("${declaredMime}"). Formats acceptés : ${Object.keys(ALLOWED_TYPES).join(', ')}.`
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
 * Chemin absolu sûr pour un chemin relatif stocké en base. Vérifie que le
 * chemin résolu reste bien dans le répertoire racine (anti traversée).
 */
function resolveSafePath(relativePath) {
    if (typeof relativePath !== 'string' || relativePath === '') return null;
    const rel = String(relativePath).replace(/^[\\/]+/, '');
    const abs = path.normalize(path.join(config.uploadsDir, rel));
    const root = path.normalize(config.uploadsDir);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
        return null;
    }
    return abs;
}

/** Crée le répertoire cible et écrit le fichier sur disque. */
async function saveFile({ organizationId, documentId, file }) {
    const { originalName, mimeType } = validateUploadFile(file);
    const dir = path.join(config.uploadsDir, 'documents', String(organizationId), String(documentId));
    fs.mkdirSync(dir, { recursive: true });

    const ext = path.extname(originalName).toLowerCase();
    const storedName = `document_${crypto.randomUUID()}${ext}`;
    const absolutePath = path.join(dir, storedName);

    await fs.promises.writeFile(absolutePath, file.buffer, { flag: 'wx' });
    logger.info('documents.file_saved', { organizationId, documentId, fileName: storedName, size: file.size });

    return {
        // Chemin relatif stocké en base (jamais exposé directement au client).
        relativePath: path.posix.join('documents', String(organizationId), String(documentId), storedName),
        originalName,
        mimeType,
        size: file.size,
        absolutePath,
    };
}

/** Supprime un fichier à partir de son chemin relatif stocké (idempotent). */
async function removeFile(relativePath) {
    if (!relativePath) return;
    const abs = resolveSafePath(relativePath);
    if (!abs) return;
    try {
        await fs.promises.unlink(abs);
    } catch (err) {
        if (err.code !== 'ENOENT') {
            logger.warn('documents.file_remove_failed', { path: relativePath, message: err.message });
            return;
        }
    }
    // Prune les dossiers parents devenus vides (ex. dossier de vente) afin
    // qu'aucun répertoire orphelin ne subsiste après la suppression.
    await pruneEmptyParents(path.dirname(abs));
}

/**
 * Supprime récursivement les dossiers vides jusqu'à la racine d'upload.
 * S'arrête dès qu'un dossier contient un fichier (jamais de suppression
 * d'un dossier non vide).
 */
async function pruneEmptyParents(dir) {
    const root = path.normalize(config.uploadsDir);
    let current = path.normalize(dir);
    const stop = root;
    while (current !== stop && (current + path.sep).startsWith(stop + path.sep)) {
        let empty = false;
        try {
            const entries = await fs.promises.readdir(current);
            empty = entries.length === 0;
        } catch (err) {
            return;
        }
        if (!empty) return;
        try {
            await fs.promises.rmdir(current);
        } catch (err) {
            return;
        }
        const parent = path.dirname(current);
        if (parent === current) return;
        current = parent;
    }
}

/**
 * Ouvre un flux de lecture vers le fichier (chemin relatif stocké en base).
 * Retourne null si le chemin est invalide ou si le fichier n'existe pas.
 */
function createReadStream(relativePath) {
    const abs = resolveSafePath(relativePath);
    if (!abs) return null;
    if (!fs.existsSync(abs)) return null;
    return fs.createReadStream(abs);
}

/** Nom de fichier sûr pour l'en-tête Content-Disposition (affichage). */
function dispositionFileName(originalName) {
    const safe = String(originalName || 'document').replace(/[^a-zA-Z0-9._-]/g, '_');
    return safe.slice(0, 255);
}

module.exports = {
    ALLOWED_TYPES,
    ALLOWED_EXTENSIONS,
    ensureBaseDir,
    validateUploadFile,
    saveFile,
    removeFile,
    createReadStream,
    resolveSafePath,
    dispositionFileName,
    sanitizeOriginalName,
};
