const makeCrudRouter = require('./crudFactory');
const { accidents } = require('../db/repositories');
const { validateAccident } = require('../utils/validators');

module.exports = makeCrudRouter(accidents, {
    // Le signalement (création) reste ouvert aux conducteurs, mais la
    // modification et la suppression sont réservées aux rôles de gestion.
    writeRoles: ['ADMIN', 'MANAGER', 'DRIVER'],
    updateRoles: ['ADMIN', 'MANAGER'],
    deleteRoles: ['ADMIN', 'MANAGER'],
    validate: validateAccident,
});
