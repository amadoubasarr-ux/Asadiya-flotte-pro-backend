const makeCrudRouter = require('./crudFactory');
const { incidents } = require('../db/repositories');
const { validateIncident } = require('../utils/validators');

// Tout utilisateur connecté (y compris conducteur) peut SIGNALER un incident,
// mais la modification et la suppression sont réservées aux rôles de gestion.
module.exports = makeCrudRouter(incidents, {
    writeRoles: ['ADMIN', 'MANAGER', 'DRIVER'],
    updateRoles: ['ADMIN', 'MANAGER'],
    deleteRoles: ['ADMIN', 'MANAGER'],
    validate: validateIncident,
});
