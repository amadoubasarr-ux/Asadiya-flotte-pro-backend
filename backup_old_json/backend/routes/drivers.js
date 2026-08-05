const makeCrudRouter = require('./crudFactory');

// Tous les rôles connectés peuvent créer/modifier ; seul l'Admin peut supprimer (RH)
module.exports = makeCrudRouter('drivers', {
    writeRoles: ['ADMIN', 'MANAGER', 'DRIVER'],
    deleteRoles: ['ADMIN']
});
