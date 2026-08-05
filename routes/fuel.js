const makeCrudRouter = require('./crudFactory');
const { fuelLogs } = require('../db/repositories');
const { validateFuelLog } = require('../utils/validators');

module.exports = makeCrudRouter(fuelLogs, {
    writeRoles: ['ADMIN', 'MANAGER', 'DRIVER'],
    deleteRoles: ['ADMIN', 'MANAGER', 'DRIVER'],
    validate: validateFuelLog,
});
