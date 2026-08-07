// ============================================================
// Outil de test de charge léger — Asadiya Flotte PRO (Phase 6.3)
//
// Node natif (aucune dépendance) : mesure latence (moy/p50/p90/p95/p99),
// débit (req/s), taux d'erreur et requêtes SQL évitées par le cache.
//
// Usage :
//   node scripts/load-test.js --base http://localhost:4399 \
//       --login admin:admin123 --concurrency 20 --duration 15 \
//       --endpoint GET:/api/health \
//       --endpoint GET:/api/plans/public \
//       --endpoint GET:/api/vehicles \
//       --endpoint GET:/api/analytics/overview
//
// Options :
//   --base         URL de base (défaut http://localhost:4000)
//   --login user:pass   connexion préalable pour obtenir un jeton
//   --token        jeton Bearer direct (alternative à --login)
//   --concurrency  nombre de travailleurs simultanés (défaut 10)
//   --duration     durée en secondes (défaut 10)
//   --timeout      timeout par requête en ms (défaut 30000)
//   --endpoint     spécification METHOD:PATH (répétable)
//   --json         affiche le résultat en JSON (pour automatisation)
// ============================================================
const BASE = process.argv.find((_, i) => process.argv[i - 1] === '--base') || 'http://localhost:4000';

function argValue(name, fallback) {
    const i = process.argv.indexOf(name);
    return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}
function hasFlag(name) {
    return process.argv.includes(name);
}

const CONCURRENCY = parseInt(argValue('--concurrency', '10'), 10);
const DURATION_S = parseInt(argValue('--duration', '10'), 10);
const REQUEST_TIMEOUT_MS = parseInt(argValue('--timeout', '30000'), 10);
const LOGIN_SPEC = argValue('--login', '');
const TOKEN = argValue('--token', '');

const ENDPOINTS = [];
for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === '--endpoint' && process.argv[i + 1]) {
        const spec = process.argv[i + 1];
        const m = spec.match(/^(GET|POST|PUT|DELETE|HEAD):(\S+)$/);
        if (!m) {
            console.error(`Endpoint invalide : "${spec}" (attendu GET:/path)`);
            process.exit(2);
        }
        ENDPOINTS.push({ method: m[1], path: m[2] });
    }
}
if (ENDPOINTS.length === 0) {
    console.error('Aucun endpoint fourni (--endpoint METHOD:PATH).');
    process.exit(2);
}

async function login() {
    const [username, password] = LOGIN_SPEC.split(':');
    const res = await fetch(`${BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.token) {
        console.error(`Connexion échouée (${username}) : ${res.status} ${JSON.stringify(data)}`);
        process.exit(1);
    }
    console.error(`Connecté : ${username}`);
    return data.token;
}

function percentile(sorted, p) {
    if (sorted.length === 0) return 0;
    const idx = Math.min(sorted.length - 1, Math.round((p / 100) * (sorted.length - 1)));
    return sorted[idx];
}

async function run() {
    const token = TOKEN || (LOGIN_SPEC ? await login() : '');

    const deadline = Date.now() + DURATION_S * 1000;
    const results = ENDPOINTS.map((e) => ({
        ...e,
        latencies: [],
        errors: 0,
        timeouts: 0,
        count: 0,
        statusCounts: {},
    }));

    const metricsBefore = await fetch(`${BASE}/api/metrics`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);

    const timers = [];
    async function worker(id) {
        let i = id;
        while (Date.now() < deadline) {
            const endpoint = ENDPOINTS[i % ENDPOINTS.length];
            const stat = results[i % ENDPOINTS.length];
            i++;

            const started = process.hrtime.bigint();
            const controller = new AbortController();
            const t = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
            try {
                const res = await fetch(`${BASE}${endpoint.path}`, {
                    method: endpoint.method,
                    headers: {
                        'Content-Type': 'application/json',
                        ...(token ? { Authorization: `Bearer ${token}` } : {}),
                    },
                    signal: controller.signal,
                });
                const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
                stat.latencies.push(elapsedMs);
                stat.count++;
                stat.statusCounts[res.status] = (stat.statusCounts[res.status] || 0) + 1;
                if (res.status >= 400) stat.errors++;
            } catch (e) {
                const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
                stat.latencies.push(elapsedMs);
                stat.count++;
                stat.timeouts++;
                stat.errors++;
            } finally {
                clearTimeout(t);
            }
        }
        timers.push(Date.now());
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, (_, k) => worker(k)));
    const elapsedS = (Math.max(...timers) - (deadline - DURATION_S * 1000)) / 1000;

    const metricsAfter = await fetch(`${BASE}/api/metrics`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);

    function sqlDelta() {
        const before = metricsBefore && metricsBefore.sql ? metricsBefore.sql.total : null;
        const after = metricsAfter && metricsAfter.sql ? metricsAfter.sql.total : null;
        if (typeof before === 'number' && typeof after === 'number') return after - before;
        return null;
    }

    const output = results.map((stat) => {
        const sorted = [...stat.latencies].sort((a, b) => a - b);
        const total = stat.latencies.length || 1;
        const sum = stat.latencies.reduce((s, v) => s + v, 0);
        return {
            endpoint: `${stat.method} ${stat.path}`,
            requests: stat.count,
            errorRatePct: total ? Number(((stat.errors / total) * 100).toFixed(2)) : 0,
            rps: Number((stat.count / elapsedS).toFixed(1)),
            avgMs: Number((sum / total).toFixed(1)),
            p50: Number(percentile(sorted, 50).toFixed(1)),
            p90: Number(percentile(sorted, 90).toFixed(1)),
            p95: Number(percentile(sorted, 95).toFixed(1)),
            p99: Number(percentile(sorted, 99).toFixed(1)),
            statuses: stat.statusCounts,
        };
    });

    const sqlDeltaCount = sqlDelta();
    if (hasFlag('--json')) {
        console.log(JSON.stringify({
            base: BASE,
            concurrency: CONCURRENCY,
            durationS: DURATION_S,
            elapsedS: Number(elapsedS.toFixed(1)),
            sqlQueriesExecuted: sqlDeltaCount,
            endpoints: output,
        }, null, 2));
        return;
    }

    console.log('\n=== Test de charge ===');
    console.log(`Base: ${BASE}  |  Concurrence: ${CONCURRENCY}  |  Durée: ${DURATION_S}s`);
    if (sqlDeltaCount !== null) console.log(`Requêtes SQL exécutées pendant le test : ${sqlDeltaCount}`);
    console.log('');
    const header = [
        'Endpoint'.padEnd(38),
        'Req'.padStart(6),
        'Err%'.padStart(6),
        'req/s'.padStart(7),
        'Moy'.padStart(7),
        'p50'.padStart(7),
        'p90'.padStart(7),
        'p95'.padStart(7),
        'p99'.padStart(7),
    ].join(' ');
    console.log(header);
    console.log('-'.repeat(header.length));
    for (const o of output) {
        console.log(
            [
                o.endpoint.padEnd(38),
                String(o.requests).padStart(6),
                String(o.errorRatePct).padStart(6),
                String(o.rps).padStart(7),
                String(o.avgMs).padStart(7),
                String(o.p50).padStart(7),
                String(o.p90).padStart(7),
                String(o.p95).padStart(7),
                String(o.p99).padStart(7),
            ].join(' ')
        );
    }
    console.log('');
}

run().catch((e) => {
    console.error(`Erreur d'exécution : ${e.message}`);
    process.exit(1);
});
