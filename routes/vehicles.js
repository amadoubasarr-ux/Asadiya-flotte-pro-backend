const makeCrudRouter = require('./crudFactory');
const { vehicles } = require('../db/repositories');
const { validateVehicle } = require('../utils/validators');

// Ajout/modification/suppression réservés à Admin & Gestionnaire (comme dans le frontend)
module.exports = makeCrudRouter(vehicles, {
    writeRoles: ['ADMIN', 'MANAGER'],
    deleteRoles: ['ADMIN', 'MANAGER'],
    validate: validateVehicle,
});
