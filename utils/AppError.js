/**
 * Erreur applicative portant un statut HTTP, un message client-safe
 * et des métadonnées optionnelles (ex: le conflit de réservation).
 */
class AppError extends Error {
    /**
     * @param {number} status  Code HTTP
     * @param {string} message Message renvoyé au client
     * @param {object} [options] { code, conflict, details }
     */
    constructor(status, message, options = {}) {
        super(message);
        this.name = 'AppError';
        this.status = status;
        this.code = options.code || null;
        this.conflict = options.conflict || null;
        this.details = options.details || null;
    }

    static badRequest(message, options) {
        return new AppError(400, message, options);
    }

    static unauthorized(message) {
        return new AppError(401, message || 'Non authentifié.');
    }

    static forbidden(message) {
        return new AppError(403, message || 'Action non autorisée.');
    }

    static notFound(message) {
        return new AppError(404, message || 'Introuvable.');
    }

    static conflict(message, conflictData) {
        return new AppError(409, message, { conflict: conflictData });
    }

    static serviceUnavailable(message, options) {
        return new AppError(503, message || 'Service indisponible.', options);
    }

    static internal(message) {
        return new AppError(500, message || 'Erreur serveur interne.');
    }
}

module.exports = AppError;
