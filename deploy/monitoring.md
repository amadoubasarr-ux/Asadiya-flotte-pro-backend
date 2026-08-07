# Asadiya Flotte PRO — Observabilité (Phase 6.2)

Cette documentation décrit l'observabilité native de l'application :
points de terminaison de supervision, métriques, journalisation structurée
et outillage de contrôle. Aucune dépendance externe n'est requise
(Prometheus, Grafana, Loki, agents…) : tout est fourni par l'API Node.js et
ne dépend d'aucun module supplémentaire.

Aucune donnée confidentielle n'est exposée par ces endpoints : uniquement
des compteurs agrégés, des durées et l'état (activé / configuré) des
fournisseurs de paiement — jamais d'URLs internes, d'identifiants ou de clés.

---

## 1. Points de terminaison

| Route                  | Méthode | Sécurité | Contenu                                                                 |
|------------------------|---------|----------|-------------------------------------------------------------------------|
| `/api/health`          | GET     | Public   | État de base : `status`, `time`, `uptime`, `version`, `environment`, `pid`. Rapide et synchrone (aucune I/O). |
| `/api/health/live`     | GET     | Public   | Liveness : même contrat que `/api/health`. Vérifie que le processus répond. |
| `/api/health/ready`    | GET     | Public   | Readiness : `checks.database` (ping `SELECT 1` + `latencyMs`) et `checks.providers` (état de chaque fournisseur). **503** si PostgreSQL est injoignable. |
| `/api/health/details`  | GET     | Public   | Vue complète : version Node, mémoire (rss/heap), CPU (user/system/cores/loadavg), OS, disque (`fs.statfsSync`), base de données (latence, pool, connexions actives), compteurs métier, agrégats de paiements, état des providers, compteurs de requêtes du process. |
| `/api/metrics`         | GET     | Public   | Métriques agrégées : `process`, `requests`, `errors`, `database`, `sql`, `business`, `payments`. Tolérant aux pannes : si PostgreSQL est tombé, les sections base sont `ok:false`/`null`. |

`/api/health/live` est utilisé par le HEALTHCHECK Docker (contrat `{ "status": "ok" }`).

### Accès réseau (recommandation)

Les endpoints sont publics (aucun secret exposé), mais il est recommandé de
les restreindre au réseau de supervision via le reverse proxy. Exemple nginx :

```nginx
location ~ ^/api/(health|metrics) {
    allow 10.0.0.0/8;      # réseau interne de supervision
    deny all;
    proxy_pass http://127.0.0.1:4000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
}
```

> Le HEALTHCHECK Docker interroge `127.0.0.1` à l'intérieur du conteneur :
> il n'est pas affecté par ces restrictions.

---

## 2. Métriques (GET /api/metrics)

```jsonc
{
  "generatedAt": "…",        // horodatage
  "environment": "production",
  "process":   { "pid", "node", "uptime", "startedAt",
                 "memory": { "rss", "heapUsed", "heapTotal", "external", "arrayBuffers" },
                 "cpu": { "userMs", "systemMs", "cores", "loadavg" } },
  "requests":  { "total", "byStatus", "byMethod",
                 "avgDurationMs", "slowCount", "recentSlow": [ …≤20 ] },
  "errors":    { "total", "byStatus" },
  "database":  { "ok", "latencyMs", "pool": { "total", "idle", "waiting" },
                 "activeConnections" },
  "sql":       { "total", "avgDurationMs", "slowCount", "recentSlow": [ …≤20 ] },
  "business":  { "organizations", "activeSubscriptions", "paymentsToday", "failedTransactions" },
  "payments":  { "total", "byStatus", "byProvider",
                 "successRate", "avgProcessingTimeMs",
                 "errorsPerProvider", "today" }
}
```

### Sémantique

- **`requests`** — toutes les requêtes HTTP passées par `logger.requestLogger`
  (sauf celles qui échouent avant ce middleware). `avgDurationMs` = moyenne
  glissante depuis le démarrage du process. `recentSlow` liste les N dernières
  requêtes lentes (≥ `SLOW_REQUEST_THRESHOLD_MS`, défaut 500 ms) **sans** corps
  ni en-têtes.
- **`errors`** — requêtes terminées en 4xx/5xx, ventilées par statut.
- **`database`** — disponibilité et latence du ping, état du pool
  `node-postgres` et nombre de connexions actives (`pg_stat_activity`).
- **`sql`** — requêtes SQL instrumentées par `db/pool.js`, durée moyenne et
  requêtes lentes (≥ `SLOW_SQL_THRESHOLD_MS`, défaut 1000 ms).
- **`business`** — compteurs métier agrégés : organisations, abonnements
  `ACTIVE`/`TRIAL` non échus, transactions créées aujourd'hui, transactions en
  échec terminal (`FAILED`/`EXPIRED`).
- **`payments`** — surveillance des transactions de paiement :
  - `successRate` = SUCCESS / (SUCCESS + FAILED + CANCELLED + EXPIRED).
    *REFUNDED est exclu du dénominateur* (ces paiements avaient réussi).
  - `avgProcessingTimeMs` = écart moyen `initiated_at → completed_at`.
  - `byProvider` = ventilation (fournisseur → statut → compte).
  - `errorsPerProvider` = échecs terminaux par fournisseur.

---

## 3. Journalisation structurée (production)

En `NODE_ENV=production`, chaque événement est une **ligne JSON unique** sur
stdout (info) ou stderr (warn/error). Champs communs : `ts`, `level`, `msg`.

La ligne `msg:"http.request"` (une par requête) contient :

```json
{ "ts", "level": "info", "msg": "http.request",
  "method", "path", "status", "durationMs",
  "ip", "agent", "requestId", "correlationId",
  "userId", "organizationId" }
```

- `requestId` : identifiant unique généré côté serveur (renvoyé au client via
  l'en-tête `X-Request-Id`).
- `correlationId` : propagé depuis l'en-tête `X-Correlation-Id` du client
  (permet de tracer une chaîne frontend → API → jobs) ; sinon égal au
  `requestId`. Limité à 128 caractères.
- `userId` / `organizationId` : renseignés **uniquement** si la requête est
  authentifiée.
- Requêtes lentes (≥ seuil) : ligne `msg:"http.request.slow"` avec `thresholdMs`.

Rapport périodique : `msg:"perf.report"` (résumé process/requêtes/SQL), émis
toutes les `PERF_REPORT_INTERVAL_MS` (défaut 15 min en production, désactivé
avec `0`).

**Garde-fous** : ni JWT, ni mots de passe, ni corps de requête, ni en-têtes
ne sont jamais journalisés. Les chemins sont sans chaîne de requête.

---

## 4. Variables d'environnement

| Variable                     | Défaut            | Rôle                                                            |
|------------------------------|-------------------|-----------------------------------------------------------------|
| `SLOW_REQUEST_THRESHOLD_MS`  | `500`             | Seuil de requête HTTP lente (log `http.request.slow`).          |
| `SLOW_SQL_THRESHOLD_MS`      | `1000`            | Seuil de requête SQL lente (compteur + `recentSlow`).           |
| `PERF_REPORT_INTERVAL_MS`    | `15*60*1000` (prod), `0` sinon | Intervalle du rapport `perf.report` ; `0` = désactivé. |
| `LOG_LEVEL`                  | `info`            | Filtrage des niveaux : `debug < info < warn < error`.           |

Exemple `.env.docker` :

```dotenv
SLOW_REQUEST_THRESHOLD_MS=500
SLOW_SQL_THRESHOLD_MS=1000
PERF_REPORT_INTERVAL_MS=900000
LOG_LEVEL=info
```

---

## 5. Outillage

### `deploy/check-monitoring.sh`

Contrôle **lecture seule** de l'observabilité (aucune modification) :

```bash
./deploy/check-monitoring.sh            # vérifie liveness, readiness, détails, métriques, HEALTHCHECK Docker
./deploy/check-monitoring.sh --strict   # quitte en erreur au premier WARN/FAIL
```

Il interroge l'API via `curl` (port exposé détecté par `docker compose port`,
ou forcez avec `APP_PORT=…`) et lit l'état du HEALTHCHECK via `docker inspect`.
Seuils personnalisables :

| Variable                 | Défaut  | Signification                              |
|--------------------------|---------|--------------------------------------------|
| `WARN_DB_LATENCY_MS`     | `1000`  | Latence PostgreSQL d'alerte (ms).          |
| `WARN_SLOW_COUNT`        | `10`    | Requêtes HTTP/SQL lentes cumulées.         |
| `WARN_SUCCESS_RATE`      | `0.9`   | Taux de succès des paiements minimum.      |
| `WARN_HTTP_ERRORS`       | `20`    | Erreurs HTTP (4xx/5xx) cumulées.           |

Code de sortie : `0` = sain, `1` = échec critique, `2` = avertissements (strict).

### HEALTHCHECK Docker

Le Dockerfile vérifie `/api/health/live` (liveness pure, indépendante de
PostgreSQL). La readiness applicative est exposée séparément sur
`/api/health/ready` pour un orchestrateur (Kubernetes `readinessProbe`).

---

## 6. Interprétation et dépannage

| Symptôme                                | Cause probable                              | Action                                        |
|-----------------------------------------|---------------------------------------------|-----------------------------------------------|
| `/api/health/ready` → 503               | PostgreSQL injoignable                      | `docker compose ps db`, `pg_isready`, logs db |
| `/api/metrics` → `database.ok:false`    | Ping DB en échec (le reste est conservé)    | Vérifier le réseau / la configuration DB      |
| `http.request.slow` fréquentes          | Requête lente récurrente                    | Identifier via `recentSlow` (méthode/chemin)  |
| `sql.slowCount` en croissance            | Index manquant ou requête coûteuse          | `EXPLAIN ANALYZE` sur les requêtes concernées |
| `payments.successRate` < seuil          | Échecs de paiement                          | `errorsPerProvider` pour isoler le fournisseur|
| Disque ≥ 85 %                           | Volume PG saturé                            | `deploy/backup.sh`, purge, augmentation volume|
| `perf.report` absent                    | `PERF_REPORT_INTERVAL_MS=0`                 | Activer l'intervalle en production            |

Les métriques étant **en mémoire**, un redémarrage réinitialise les compteurs.
Pour une rétention longue, intégrez la sortie JSON (stdout) à un collecteur
(Loki, ELK, CloudWatch…) et exécutez `check-monitoring.sh` via cron ou un
système d'alerting.
