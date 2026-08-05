const express = require('express');
const store = require('../data/store');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function getInterval(startStr, endStr) {
    const start = new Date(startStr);
    let end = endStr ? new Date(endStr) : null;
    if (!end || isNaN(end.getTime())) end = start;
    return { start, end };
}

// Retourne la réservation en conflit (même véhicule, créneau chevauchant), ou null
function findConflict(vehicleId, start, end, excludeId = null) {
    const { start: newStart, end: newEnd } = getInterval(start, end);
    if (isNaN(newStart.getTime())) return null;
    return store.getAll('reservations').find(r => {
        if (excludeId && r.id == excludeId) return false;
        if (r.vehicleId != vehicleId) return false;
        if (r.status === 'REJECTED' || r.status === 'CANCELLED') return false;
        const { start: exStart, end: exEnd } = getInterval(r.start, r.end);
        if (isNaN(exStart.getTime())) return false;
        return newStart < exEnd && exStart < newEnd;
    }) || null;
}

router.get('/', requireAuth, (req, res) => {
    res.json(store.getAll('reservations'));
});

router.post('/', requireAuth, (req, res) => {
    const body = req.body || {};
    if (!body.vehicleId || !body.driverId || !body.start) {
        return res.status(400).json({ error: 'Véhicule, conducteur et date de début requis.' });
    }
    const conflict = findConflict(body.vehicleId, body.start, body.end);
    if (conflict) {
        return res.status(409).json({
            error: 'Conflit de planning : ce véhicule est déjà réservé sur ce créneau.',
            conflict
        });
    }
    const item = store.create('reservations', { ...body, status: body.status || 'PENDING' });
    res.status(201).json(item);
});

router.put('/:id', requireAuth, (req, res) => {
    const body = req.body || {};
    if (body.vehicleId && body.start) {
        const conflict = findConflict(body.vehicleId, body.start, body.end, req.params.id);
        if (conflict) {
            return res.status(409).json({
                error: 'Conflit de planning : ce véhicule est déjà réservé sur ce créneau.',
                conflict
            });
        }
    }
    const item = store.update('reservations', req.params.id, body);
    if (!item) return res.status(404).json({ error: 'Réservation introuvable.' });
    res.json(item);
});

router.patch('/:id/approve', requireAuth, (req, res) => {
    const item = store.update('reservations', req.params.id, { status: 'APPROVED' });
    if (!item) return res.status(404).json({ error: 'Réservation introuvable.' });
    res.json(item);
});

router.delete('/:id', requireAuth, (req, res) => {
    const ok = store.remove('reservations', req.params.id);
    if (!ok) return res.status(404).json({ error: 'Réservation introuvable.' });
    res.status(204).end();
});

module.exports = router;
