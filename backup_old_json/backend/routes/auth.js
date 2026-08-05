const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const store = require('../data/store');
const { requireAuth, JWT_SECRET } = require('../middleware/auth');

const router = express.Router();

function safeUser(u) {
    const { id, username, name, role, title } = u;
    return { id, username, name, role, title };
}

router.post('/login', (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
        return res.status(400).json({ error: 'Identifiant et mot de passe requis.' });
    }
    const user = store.getAll('users').find(u => u.username === username);
    if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
        return res.status(401).json({ error: 'Identifiants incorrects.' });
    }
    const payload = safeUser(user);
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: payload });
});

router.get('/me', requireAuth, (req, res) => {
    const user = store.getById('users', req.user.id);
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable.' });
    res.json({ user: safeUser(user) });
});

module.exports = router;
