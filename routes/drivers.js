const makeCrudRouter = require('./crudFactory');
const { drivers } = require('../db/repositories');
const { validateDriver } = require('../utils/validators');

// Tous les rôles connectés peuvent créer/modifier ; seul l'Admin peut supprimer (RH)
module.exports = makeCrudRouter(drivers, {
    writeRoles: ['ADMIN', 'MANAGER', 'DRIVER'],
    deleteRoles: ['ADMIN'],
    validate: validateDriver,
});
