require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();

// Autorise les requêtes du frontend (ajustez l'origine en production)
app.use(cors());
// Augmenté pour accepter les photos encodées en base64 dans les payloads JSON
app.use(express.json({ limit: '15mb' }));

// ===== ROUTES API =====
app.use('/api/auth', require('./routes/auth'));
app.use('/api/vehicles', require('./routes/vehicles'));
app.use('/api/drivers', require('./routes/drivers'));
app.use('/api/reservations', require('./routes/reservations'));
app.use('/api/maintenances', require('./routes/maintenances'));
app.use('/api/incidents', require('./routes/incidents'));
app.use('/api/accidents', require('./routes/accidents'));
app.use('/api/fuel-logs', require('./routes/fuel'));
app.use('/api/organizations', require('./routes/organizations'));
app.use('/api/users', require('./routes/users'));

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
});

// ===== SERT LE FRONTEND (fichier statique index.html) =====
// Placez le fichier index.html de l'application dans ce même dossier "backend/"
// (ou ajustez le chemin ci-dessous) pour que le serveur serve aussi l'interface.
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Gestion d'erreurs génériques
app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur interne.' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`✅ Asadiya Flotte PRO — API démarrée sur http://localhost:${PORT}`);
    console.log(`   Comptes de démo : admin/admin123, gestionnaire/gest123, conducteur/cond123`);
});
