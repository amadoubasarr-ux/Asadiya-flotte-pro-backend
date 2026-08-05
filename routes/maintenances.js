const makeCrudRouter = require('./crudFactory');
const { maintenances } = require('../db/repositories');
const { validateMaintenance } = require('../utils/validators');

module.exports = makeCrudRouter(maintenances, {
    writeRoles: ['ADMIN', 'MANAGER'],
    deleteRoles: ['ADMIN', 'MANAGER'],
    validate: validateMaintenance,
});
