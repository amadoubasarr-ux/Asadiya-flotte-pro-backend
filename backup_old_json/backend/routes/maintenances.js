const makeCrudRouter = require('./crudFactory');

module.exports = makeCrudRouter('maintenances', {
    writeRoles: ['ADMIN', 'MANAGER'],
    deleteRoles: ['ADMIN', 'MANAGER']
});
