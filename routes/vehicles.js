const makeCrudRouter = require('./crudFactory');
const { vehicles } = require('../db/repositories');
const { validateVehicle } = require('../utils/validators');
const { enforceVehicleLimit } = require('../services/subscriptions');

// Ajout/modification/suppression réservés à Admin & Gestionnaire (comme dans le frontend).
// La création est bloquée si le plan de l'organisation a atteint sa limite de véhicules.
module.exports = makeCrudRouter(vehicles, {
    writeRoles: ['ADMIN', 'MANAGER'],
    deleteRoles: ['ADMIN', 'MANAGER'],
    validate: validateVehicle,
    limitCheck: (req) => enforceVehicleLimit(req.user.organizationId),
});
