// ============================================================
// Asadiya Flotte PRO — Contexte de requête (Phase 6.2)
// ============================================================
// Attribue à chaque requête :
//   - requestId     : identifiant unique (X-Request-Id, renvoyé au client)
//   - correlationId : identifiant de corrélation (X-Correlation-Id, propagé)
// et expose req.logContext pour que la journalisation de la requête et les
// logs d'erreur puissent rattacher les identifiants.
//
// Aucune donnée sensible n'est lue ni enregistrée (ni JWT, ni corps).
// ============================================================
const crypto = require('crypto');

function requestContext(req, res, next) {
    // X-Request-Id : l'id est généré ici (jamais de confiance aveugle en
    // l'en-tête client, qui pourrait être abusé ; il reste utile en retour).
    const requestId = crypto.randomUUID();
    // X-Correlation-Id : propagé depuis l'appelant s'il en fournit un
    // (permet de tracer une chaîne frontend -> API -> jobs).
    const correlationId = String(req.get('x-correlation-id') || '').slice(0, 128) || requestId;

    req.requestId = requestId;
    req.correlationId = correlationId;
    // Contexte de logs réutilisable par les logs d'erreur et de requête.
    req.logContext = { requestId, correlationId };

    res.setHeader('X-Request-Id', requestId);

    next();
}

module.exports = { requestContext };
