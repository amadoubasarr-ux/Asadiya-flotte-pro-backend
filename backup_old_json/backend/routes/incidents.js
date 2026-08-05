const makeCrudRouter = require('./crudFactory');

// Tout utilisateur connecté (y compris conducteur) peut signaler un incident
module.exports = makeCrudRouter('incidents', {
    writeRoles: ['ADMIN', 'MANAGER', 'DRIVER'],
    deleteRoles: ['ADMIN', 'MANAGER', 'DRIVER']
});
