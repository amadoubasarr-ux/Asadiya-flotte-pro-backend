const makeCrudRouter = require('./crudFactory');

module.exports = makeCrudRouter('accidents', {
    writeRoles: ['ADMIN', 'MANAGER', 'DRIVER'],
    deleteRoles: ['ADMIN', 'MANAGER', 'DRIVER']
});
