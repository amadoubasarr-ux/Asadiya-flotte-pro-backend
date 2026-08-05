const makeCrudRouter = require('./crudFactory');

module.exports = makeCrudRouter('fuelLogs', {
    writeRoles: ['ADMIN', 'MANAGER', 'DRIVER'],
    deleteRoles: ['ADMIN', 'MANAGER', 'DRIVER']
});
