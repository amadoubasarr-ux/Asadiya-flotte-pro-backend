const jwt = require('jsonwebtoken');
const { config } = require('../config');
const { users } = require('../db/repositories');

// En production, assertProductionConfig() a déjà refusé le démarrage
// si JWT_SECRET est absent ou trop court : on peut donc se fier au secret ici.
const JWT_SECRET =
    config.jwtSecret || (config.nodeEnv === 'production' ? null : 'change-moi-en-production-asadiya-flotte-pro');

// Revalidation systématique en base (Phase 8.4, N7) : un jeton ne fait
// autorité que si son détenteur existe toujours avec le MÊME rôle et la MÊME
// organisation que ceux signés dans le jeton. Sans cela, un changement de rôle
// (ou une suppression de compte) ne serait appliqué qu'à la prochaine
// reconnexion. Le payload est reconstruit à partir des données fraîches.
async function requireAuth(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) {
        return res.status(401).json({ error: 'Non authentifié. Veuillez vous connecter.' });
    }
    let payload;
    try {
        payload = jwt.verify(token, JWT_SECRET);
    } catch (e) {
        return res.status(401).json({ error: 'Session invalide ou expirée. Veuillez vous reconnecter.' });
    }

    const orgClaim = payload.organizationId ?? null;
    try {
        const fresh = await users.findById(orgClaim, payload.id);
        if (
            !fresh ||
            fresh.id !== payload.id ||
            fresh.role !== payload.role ||
            fresh.organizationId !== orgClaim
        ) {
            return res.status(401).json({ error: 'Session invalide. Veuillez vous reconnecter.' });
        }
        req.user = {
            id: fresh.id,
            username: fresh.username,
            name: fresh.name,
            role: fresh.role,
            title: fresh.title,
            organizationId: fresh.organizationId,
        };
    } catch (err) {
        return res.status(401).json({ error: 'Session invalide. Veuillez vous reconnecter.' });
    }
    next();
}

// Autorise uniquement les rôles listés (ex: requireRole('ADMIN', 'MANAGER'))
function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.user || !roles.includes(req.user.role)) {
            return res.status(403).json({ error: 'Action non autorisée pour votre rôle.' });
        }
        next();
    };
}

module.exports = { requireAuth, requireRole, JWT_SECRET };