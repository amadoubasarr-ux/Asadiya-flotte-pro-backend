const makeCrudRouter = require('./crudFactory');

// Ajout/modification/suppression réservés à Admin & Gestionnaire (comme dans le frontend)
module.exports = makeCrudRouter('vehicles', {
    writeRoles: ['ADMIN', 'MANAGER'],
    deleteRoles: ['ADMIN', 'MANAGER']
});
