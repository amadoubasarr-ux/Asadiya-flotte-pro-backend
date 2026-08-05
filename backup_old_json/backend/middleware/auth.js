const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'change-moi-en-production-asadiya-flotte-pro';

function requireAuth(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) {
        return res.status(401).json({ error: 'Non authentifié. Veuillez vous connecter.' });
    }
    try {
        const payload = jwt.verify(token, JWT_SECRET);
        req.user = payload; // { id, username, role, name, title }
        next();
    } catch (e) {
        return res.status(401).json({ error: 'Session invalide ou expirée. Veuillez vous reconnecter.' });
    }
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
