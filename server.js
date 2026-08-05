require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');

const { config, assertProductionConfig } = require('./config');
const { migrate } = require('./db/migrate');
const { pool } = require('./db/pool');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');

assertProductionConfig();

const app = express();

// En-têtes de sécurité de base (HSTS, X-Content-Type-Options, CSP en mode dev, ...)
app.use(helmet());

// CORS : origine restreinte en production, ouvert en développement.
app.use(cors({
    origin: config.nodeEnv === 'production' ? config.corsOrigin : true,
}));

// Augmenté pour accepter les photos encodées en base64 dans les payloads JSON
app.use(express.json({ limit: config.jsonLimit }));

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

// Route API inconnue -> 404 JSON (plutôt qu'un fallback HTML)
app.use('/api', notFoundHandler);

// ===== SERT LE FRONTEND (fichier statique index.html) =====
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Gestion d'erreurs centralisée (AppError, erreurs PostgreSQL, JSON invalide)
app.use(errorHandler);

async function start() {
    try {
        // Crée automatiquement les tables au démarrage (idempotent)
        await migrate();
        console.log('[db] Schéma PostgreSQL prêt.');

        const server = app.listen(config.port, () => {
            console.log(`✅ Asadiya Flotte PRO — API démarrée sur http://localhost:${config.port}`);
        });

        const shutdown = (signal) => {
            console.log(`\n[server] ${signal} reçu, arrêt propre...`);
            server.close(async () => {
                await pool.end().catch(() => {});
                process.exit(0);
            });
        };
        process.on('SIGINT', () => shutdown('SIGINT'));
        process.on('SIGTERM', () => shutdown('SIGTERM'));
    } catch (err) {
        console.error('[db] Impossible de se connecter à PostgreSQL. Vérifiez DATABASE_URL.');
        console.error(err.message);
        process.exit(1);
    }
}

start();
