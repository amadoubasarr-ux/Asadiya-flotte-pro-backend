const makeCrudRouter = require('./crudFactory');
const { accidents } = require('../db/repositories');
const { validateAccident } = require('../utils/validators');

module.exports = makeCrudRouter(accidents, {
    writeRoles: ['ADMIN', 'MANAGER', 'DRIVER'],
    deleteRoles: ['ADMIN', 'MANAGER', 'DRIVER'],
    validate: validateAccident,
});
