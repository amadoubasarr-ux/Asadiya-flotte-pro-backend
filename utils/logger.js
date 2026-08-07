// ============================================================
// Journalisation structurée (Phase 4.3 — Sécurisation Production,
// complétée Phase 6.2 — Observabilité)
// ============================================================
// - Développement / test : sortie lisible (texte horodaté).
// - Production : une ligne JSON par événement, exploitable par un
//   collecteur de logs (Loki, ELK, CloudWatch, ...).
// - Niveaux filtrés via LOG_LEVEL : debug < info < warn < error.
// - Ne journalise JAMAIS de données sensibles : pas de mots de passe,
//   pas de jetons JWT, pas de secrets, pas de cartes, pas de tokens,
//   pas de corps de requête.
// - Contexte de requête (Phase 6.2) : requestId, correlationId, durée,
//   IP, userAgent, organisation et utilisateur sur la ligne http.request.
// ============================================================
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const metrics = require('../monitoring/metrics');

function now() {
    return new Date().toISOString();
}

function activeLevel() {
    const raw = String(process.env.LOG_LEVEL || 'info').toLowerCase();
    return LEVELS[raw] !== undefined ? LEVELS[raw] : LEVELS.info;
}

function isProd() {
    return process.env.NODE_ENV === 'production';
}

function formatValue(v) {
    if (v === null || v === undefined) return String(v);
    if (typeof v === 'string') return /[\s"]/.test(v) ? JSON.stringify(v) : v;
    if (typeof v === 'object') {
        try {
            return JSON.stringify(v);
        } catch (e) {
            return String(v);
        }
    }
    return String(v);
}

function formatDev(entry) {
    const { ts, level, msg, ...fields } = entry;
    const head = `${ts} [${level.toUpperCase()}] ${msg}`;
    const keys = Object.keys(fields);
    if (keys.length === 0) return head;
    return `${head} ${keys.map((k) => `${k}=${formatValue(fields[k])}`).join(' ')}`;
}

function write(level, msg, fields) {
    if (LEVELS[level] < activeLevel()) return;
    const entry = { ts: now(), level, msg, ...(fields || {}) };
    const line = isProd() ? JSON.stringify(entry) : formatDev(entry);
    const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
    stream.write(line + '\n');
}

const logger = {
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),

    /**
     * Middleware Express : une ligne de journal par requête HTTP
     * (méthode, chemin, statut, durée, IP, userAgent, requestId,
     * correlationId, utilisateur et organisation si authentifiés).
     * N'expose ni l'en-tête Authorization ni le corps de la requête.
     *
     * Alimente aussi les métriques en mémoire (monitoring/metrics.js) :
     * nombre de requêtes, répartition par statut/méthode, durée moyenne,
     * requêtes lentes et erreurs HTTP.
     */
    requestLogger(req, res, next) {
        const startedAt = process.hrtime.bigint();
        res.on('finish', () => {
            const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
            const status = res.statusCode;
            const context = req.logContext || {};

            // Champs du log : aucune donnée sensible (pas de token, pas de corps).
            const fields = {
                method: req.method,
                path: req.path, // sans chaîne de requête (évite de fuiter d'éventuels paramètres)
                status,
                durationMs: Math.round(durationMs * 10) / 10,
                ip: req.ip,
                agent: String(req.get('user-agent') || '').slice(0, 120),
                requestId: context.requestId,
                correlationId: context.correlationId,
                // Renseignés uniquement si la requête est authentifiée.
                userId: req.user ? req.user.id : undefined,
                organizationId: req.user ? req.user.organizationId : undefined,
            };

            logger.info('http.request', fields);

            // Requête lente (seuil SLOW_REQUEST_THRESHOLD_MS, défaut 500 ms).
            if (durationMs >= metrics.SLOW_REQUEST_THRESHOLD_MS) {
                logger.warn('http.request.slow', { ...fields, thresholdMs: metrics.SLOW_REQUEST_THRESHOLD_MS });
            }

            // Alimentation des métriques (ne doit jamais faire échouer la requête).
            try {
                metrics.recordRequest({ method: req.method, path: req.path, status, durationMs });
            } catch (e) {
                logger.error('metrics.record_failed', { message: String(e && e.message || e) });
            }
        });
        next();
    },
};

module.exports = logger;
