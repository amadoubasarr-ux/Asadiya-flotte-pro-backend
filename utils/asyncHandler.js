/**
 * Wrapper pour les handlers Express asynchrones :
 * transmet les erreurs au middleware de gestion d'erreurs au lieu de les laisser
 * devenir des promesses non gérées.
 */
const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = asyncHandler;
