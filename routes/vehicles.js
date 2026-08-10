const makeCrudRouter = require('./crudFactory');
const { vehicles } = require('../db/repositories');
const { validateVehicle } = require('../utils/validators');
const { enforceVehicleLimit } = require('../services/subscriptions');
const { requireRole } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');

function requireOrgUser(req, res, next) {
    if (!req.user || !req.user.organizationId) {
        return res.status(403).json({ error: 'Cette ressource nécessite un compte rattaché à une organisation.' });
    }
    next();
}

// Ajout/modification/suppression réservés à Admin & Gestionnaire (comme dans le frontend).
// La création est bloquée si le plan de l'organisation a atteint sa limite de véhicules.
const router = makeCrudRouter(vehicles, {
    writeRoles: ['ADMIN', 'MANAGER'],
    deleteRoles: ['ADMIN', 'MANAGER'],
    validate: validateVehicle,
    limitCheck: (req) => enforceVehicleLimit(req.user.organizationId),
});

// Cycle de vie commercial du véhicule (Phase Vente, Commit 5).
// PATCH /api/vehicles/:id/commercial-status  { status: 'FOR_SALE' | 'AVAILABLE' | 'SOLD', saleId? }
// Écriture réservée à Admin & Gestionnaire ; le conducteur (lecture seule) et
// le super-admin sont refusés. L'état est piloté côté serveur uniquement
// (machine à états) : transitions interdites -> 409.
const COMMERCIAL_STATUSES = ['AVAILABLE', 'FOR_SALE', 'SOLD'];

router.patch(
    '/:id/commercial-status',
    requireOrgUser,
    requireRole('ADMIN', 'MANAGER'),
    asyncHandler(async (req, res) => {
        const vehicleId = parseInt(req.params.id, 10);
        if (!Number.isInteger(vehicleId) || vehicleId < 1) {
            throw AppError.badRequest('Identifiant de véhicule invalide.');
        }

        const status = String((req.body && req.body.status) || '').toUpperCase();
        if (!COMMERCIAL_STATUSES.includes(status)) {
            throw AppError.badRequest(
                `Statut commercial invalide (attendu : ${COMMERCIAL_STATUSES.join(', ')}).`
            );
        }

        let saleId;
        if (status === 'SOLD') {
            saleId = parseInt(req.body && req.body.saleId, 10);
            if (!Number.isInteger(saleId) || saleId < 1) {
                throw AppError.badRequest(
                    'Le passage à "Vendu" exige la vente concernée (saleId).'
                );
            }
        }

        const updated = await vehicles.setCommercialStatus(req.user.organizationId, vehicleId, { status, saleId });
        if (!updated) throw AppError.notFound('Véhicule introuvable.');
        res.json(updated);
    })
);

module.exports = router;
