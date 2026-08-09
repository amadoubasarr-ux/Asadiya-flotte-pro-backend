const AppError = require('../utils/AppError');
const logger = require('../utils/logger');

// Mapping des erreurs PostgreSQL vers des erreurs HTTP proprement exposées.
function mapPgError(err) {
    switch (err.code) {
        case '23505': // unique_violation
            return AppError.conflict(
                'Cette valeur est déjà utilisée (contrainte d\'unicité).'
            );
        case '23503': // foreign_key_violation
        case '23001': // restrict_violation (ON DELETE RESTRICT)
            return AppError.conflict(
                'Cette action est impossible : la ressource est référencée par d\'autres données.'
            );
        case '23514': // check_violation
        case '22P02': // invalid_text_representation
        case '22007': // invalid_datetime_format
        case '22008': // datetime_field_overflow
            return AppError.badRequest('Donnée invalide envoyée au serveur de base de données.');
        case '42703': // undefined_column
        case '42P01': // undefined_table
        case '42601': // syntax_error
            return AppError.internal('Erreur interne de base de données.');
        default:
            return null;
    }
}

/**
 * Middleware de gestion d'erreurs : dernier `app.use((err, req, res, next))`.
 * Centralise la transformation des erreurs (AppError, PostgreSQL, body-parser)
 * en réponses JSON cohérentes, sans fuiter les détails internes.
 */
function errorHandler(err, req, res, _next) {
    // Taille de requête dépassée (body-parser : limite JSON_LIMIT).
    if (err && err.type === 'entity.too.large') {
        logger.warn('http.body.too_large', { method: req.method, path: req.originalUrl, ip: req.ip });
        return res.status(413).json({ error: 'Corps de requête trop volumineux.', code: 'payload_too_large' });
    }

    // Charset / encodage non supporté par le body-parser.
    if (err && (err.type === 'charset.unsupported' || err.type === 'encoding.unsupported')) {
        return res.status(415).json({ error: 'Type de contenu non supporté.' });
    }

    // Erreur de parsing du corps JSON (body-parser)
    if (err && err.type === 'entity.parse.failed') {
        return res.status(400).json({ error: 'Corps JSON invalide.' });
    }
    if (err && err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        return res.status(400).json({ error: 'Corps JSON invalide.' });
    }

    // Erreur applicative explicite
    if (err instanceof AppError) {
        const body = { error: err.message };
        if (err.code) body.code = err.code;
        if (err.conflict) body.conflict = err.conflict;
        if (err.details) body.details = err.details;
        if (err.status >= 500) {
            logger.error('http.app_error', {
                method: req.method,
                path: req.originalUrl,
                status: err.status,
                code: err.code,
                message: err.message,
            });
        }
        return res.status(err.status).json(body);
    }

    // Erreur PostgreSQL connue
    const mapped = mapPgError(err);
    if (mapped) {
        const body = { error: mapped.message };
        if (mapped.conflict) body.conflict = mapped.conflict;
        if (mapped.status >= 500) {
            logger.error('db.error', {
                method: req.method,
                path: req.originalUrl,
                pgCode: err.code,
                message: err.message,
            });
        }
        return res.status(mapped.status).json(body);
    }

    // Erreur de validation d'une entrée non gérée ailleurs
    if (err && err.name === 'ValidationError') {
        return res.status(400).json({ error: err.message });
    }

    // Erreur inattendue
    logger.error('http.unhandled_error', {
        method: req.method,
        path: req.originalUrl,
        status: 500,
        message: err && err.message ? err.message : String(err),
    });
    return res.status(500).json({ error: 'Erreur serveur interne.' });
}

// Route inconnue -> 404 JSON (plutôt qu'un fallback HTML).
function notFoundHandler(req, res) {
    res.status(404).json({ error: 'Ressource introuvable.' });
}

module.exports = { errorHandler, notFoundHandler };
