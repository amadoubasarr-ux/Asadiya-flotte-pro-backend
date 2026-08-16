// ============================================================
// Asadiya Flotte PRO — Health checks (Phase 6.2)
// ============================================================
// Endpoints de supervision :
//   /api/health            — état de base (léger, sans I/O)
//   /api/health/live       — liveness : le processus est vivant
//   /api/health/ready      — readiness : l'API est prête à servir
//                            (PostgreSQL joignable + état des providers)
//   /api/health/details    — vue complète (mémoire, CPU, disque, DB,
//                            business, providers, requêtes)
//
// AUCUN secret n'est jamais exposé : pas d'URL, pas d'identifiants, pas de
// valeurs de configuration. Les fournisseurs de paiement sont décrits par
// leur ÉTAT (activé / configuré), jamais par leur clés.
// ============================================================
const os = require('os');
const fs = require('fs');
const path = require('path');

const { config } = require('../config');
const { isProviderEnabled, isProviderConfigured, KNOWN_PROVIDERS } = require('../services/paymentGateway');
const dbProbe = require('./dbProbe');
const paymentMonitor = require('./paymentMonitor');
const metrics = require('./metrics');

const VERSION = require('../package.json').version;
const APP_ROOT = path.join(__dirname, '..');

function round2(n) {
    return Math.round(n * 100) / 100;
}

/** Champs communs à tous les endpoints de santé. */
function base() {
    return {
        status: 'ok',
        time: new Date().toISOString(),
        uptime: round2(process.uptime()),
        version: VERSION,
        environment: config.nodeEnv,
        pid: process.pid,
    };
}

/** État des fournisseurs de paiement (activé / configuré — jamais les clés). */
function providers() {
    const out = {};
    for (const name of KNOWN_PROVIDERS) {
        out[name] = {
            enabled: isProviderEnabled(name),
            configured: isProviderConfigured(name),
        };
    }
    return out;
}

/** Espace disque de la racine applicative (si le système le permet). */
function disk() {
    try {
        const info = fs.statfsSync(APP_ROOT);
        const total = info.blocks * info.bsize;
        const free = info.bavail * info.bsize;
        const usedPercent = total > 0 ? round2(((total - free) / total) * 100) : 0;
        return {
            available: true,
            totalBytes: total,
            freeBytes: free,
            usedPercent,
        };
    } catch {
        return { available: false };
    }
}

/** Vue mémoire + CPU + OS (toujours disponible, sans I/O). */
function system() {
    const mem = process.memoryUsage();
    const cpu = process.cpuUsage();
    return {
        memory: {
            rss: mem.rss,
            heapUsed: mem.heapUsed,
            heapTotal: mem.heapTotal,
            external: mem.external,
        },
        cpu: {
            userMs: round2(cpu.user / 1000),
            systemMs: round2(cpu.system / 1000),
            cores: os.cpus().length,
            loadavg: os.loadavg(),
        },
        os: {
            platform: os.platform(),
            arch: os.arch(),
            hostname: os.hostname(),
            totalMemory: os.totalmem(),
            freeMemory: os.freemem(),
        },
    };
}

/** GET /api/health — état de base, léger et synchrone (sans base de données). */
function healthBasic() {
    return base();
}

/** GET /api/health/live — liveness (le processus est vivant). */
function healthLiveness() {
    return base();
}

/** GET /api/health/ready — readiness (PostgreSQL + providers). */
async function healthReadiness() {
    const db = await dbProbe.ping();
    const checks = {
        database: db,
        providers: providers(),
    };
    const ok = !!db.ok;
    return {
        ...base(),
        status: ok ? 'ok' : 'error',
        checks,
    };
}

/** GET /api/health/details — vue complète (aucun secret). */
async function healthDetails() {
    const startedAt = process.hrtime.bigint();
    const [db, business, payments, reqSnapshot] = await Promise.all([
        dbProbe.databaseStats(),
        dbProbe.businessCounts(),
        paymentMonitor.snapshot(),
        Promise.resolve(metrics.snapshot()),
    ]);
    const responseTimeMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const requests = reqSnapshot.requests;

    return {
        ...base(),
        node: process.version,
        ...system(),
        disk: disk(),
        database: db,
        business,
        payments: payments
            ? {
                  total: payments.total,
                  byStatus: payments.byStatus,
                  successRate: payments.successRate,
                  avgProcessingTimeMs: payments.avgProcessingTimeMs,
                  today: payments.today,
              }
            : null,
        providers: providers(),
        requests: {
            total: requests.total,
            byStatus: requests.byStatus,
            avgDurationMs: requests.avgDurationMs,
            slowCount: requests.slowCount,
        },
        responseTimeMs: round2(responseTimeMs),
    };
}

module.exports = {
    healthBasic,
    healthLiveness,
    healthReadiness,
    healthDetails,
};
