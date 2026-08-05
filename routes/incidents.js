const makeCrudRouter = require('./crudFactory');
const { incidents } = require('../db/repositories');
const { validateIncident } = require('../utils/validators');

// Tout utilisateur connecté (y compris conducteur) peut signaler un incident
module.exports = makeCrudRouter(incidents, {
    writeRoles: ['ADMIN', 'MANAGER', 'DRIVER'],
    deleteRoles: ['ADMIN', 'MANAGER', 'DRIVER'],
    validate: validateIncident,
});
