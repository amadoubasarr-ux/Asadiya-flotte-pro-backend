#!/usr/bin/env bash
# ============================================================
# Asadiya Flotte PRO — vérification de l'observabilité (LECTURE SEULE)
#
# Usage :
#   ./deploy/check-monitoring.sh
#   ./deploy/check-monitoring.sh --strict   # quitte en erreur au premier WARN/FAIL
#
# Ce script ne MODIFIE RIEN : il interroge les points de terminaison
# d'observabilité (/api/health*, /api/metrics) et lit l'état des
# conteneurs via docker inspect. Aucun secret n'est affiché : seules
# des métriques agrégées sont lues.
#
# Vérifie : liveness, readiness, détails (mémoire / disque / DB),
# métriques applicatives (requêtes, erreurs, requêtes SQL lentes,
# taux de succès des paiements) et le HEALTHCHECK Docker.
# ============================================================
set -u

ENV_FILE="${ENV_FILE:-.env.docker}"
COMPOSE_CMD="docker compose --env-file $ENV_FILE"
STRICT=0
[ "${1:-}" = "--strict" ] && STRICT=1

# Seuils d'alerte (personnalisables par variables d'environnement).
WARN_DB_LATENCY_MS="${WARN_DB_LATENCY_MS:-1000}"       # latence PostgreSQL en ms
WARN_SLOW_COUNT="${WARN_SLOW_COUNT:-10}"               # requêtes lentes cumulées (seuil SLOW_SQL)
WARN_SUCCESS_RATE="${WARN_SUCCESS_RATE:-0.9}"          # taux de succès des paiements
WARN_HTTP_ERRORS="${WARN_HTTP_ERRORS:-20}"             # erreurs HTTP (4xx/5xx) cumulées

PASS=0; FAIL=0; WARN=0
log()   { printf '%-5s %s\n' "$1" "$2"; }
ok()    { log OK "$1"; PASS=$((PASS+1)); }
bad()   { log FAIL "$1"; FAIL=$((FAIL+1)); }
warn()  { log WARN "$1"; WARN=$((WARN+1)); }

# ---------------------------------------------------------------------------
# Point d'entrée API : privilégie curl sur le port exposé, sinon repli via
# docker compose exec (aucune modification, aucune valeur sensible affichée).
# ---------------------------------------------------------------------------
API_BASE=""
api_get() {
  if [ -n "$API_BASE" ]; then
    curl -fsS --max-time 10 "$API_BASE$1" 2>/dev/null
  elif command -v docker >/dev/null 2>&1 && $COMPOSE_CMD ps app --status running >/dev/null 2>&1; then
    $COMPOSE_CMD exec -T app node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'$1').then(r=>{if(!r.ok)process.exit(1);return r.text()}).then(t=>process.stdout.write(t)).catch(()=>process.exit(1))" 2>/dev/null
  fi
}

# Extraction d'un champ JSON via Node (jq non requis ; Node est disponible).
# Robuste aux chemins imbriqués manquants (renvoie une chaîne vide).
jfield() {
  node -e '
    const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const p = process.argv[1];
    let v;
    try { v = p.split(".").filter(Boolean).reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), d); }
    catch (e) { v = undefined; }
    process.stdout.write(v === undefined || v === null ? "" : String(v));
  ' "$1"
}

echo "== [1] Outils requis =="
if command -v curl >/dev/null 2>&1; then ok "curl est installé"; else warn "curl introuvable (repli docker exec utilisé)"; fi
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  ok "plugin docker compose disponible"
else
  warn "docker compose indisponible (vérification via HTTP direct uniquement)"
fi

# Détection du port exposé (compose) ou via APP_PORT ; sinon 4000 (Dockerfile).
# APP_PORT, s'il est défini, force le port à vérifier (cas multi-instances).
PORT=""
if [ -z "${APP_PORT:-}" ] && command -v docker >/dev/null 2>&1; then
  PORT=$($COMPOSE_CMD port app 4000 2>/dev/null | grep -oE '[0-9]+$' | head -n1)
fi
PORT="${PORT:-${APP_PORT:-4000}}"
if curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/health/live" >/dev/null 2>&1; then
  API_BASE="http://127.0.0.1:$PORT"
  ok "API joignable en HTTP direct sur 127.0.0.1:$PORT"
else
  warn "API non joignable en HTTP direct sur 127.0.0.1:$PORT (repli docker exec)"
fi

# ---------------------------------------------------------------------------
# 2) Liveness + readiness
# ---------------------------------------------------------------------------
echo "== [2] Liveness / Readiness =="
LIVE=$(api_get /api/health/live)
if [ -n "$LIVE" ] && [ "$(printf '%s' "$LIVE" | jfield '.status')" = "ok" ]; then
  ok "/api/health/live : ok (uptime $(printf '%s' "$LIVE" | jfield '.uptime') s)"
else
  bad "/api/health/live ne répond pas (processus indisponible)"
fi

READY=$(api_get /api/health/ready)
if [ -n "$READY" ]; then
  DB_OK=$(printf '%s' "$READY" | jfield '.checks.database.ok')
  if [ "$DB_OK" = "true" ]; then
    ok "/api/health/ready : PostgreSQL sain (latence $(printf '%s' "$READY" | jfield '.checks.database.latencyMs') ms)"
  else
    bad "/api/health/ready : PostgreSQL injoignable"
  fi
else
  bad "/api/health/ready ne répond pas"
fi

# ---------------------------------------------------------------------------
# 3) Détails (mémoire, disque, DB, business, paiements, providers)
# ---------------------------------------------------------------------------
echo "== [3] Détails =="
DET=$(api_get /api/health/details)
if [ -z "$DET" ]; then
  bad "/api/health/details indisponible (la suite est ignorée)"
else
  VERSION=$(printf '%s' "$DET" | jfield '.version')
  ok "version API : $VERSION"

  UPTIME=$(printf '%s' "$DET" | jfield '.uptime')
  RSS=$(printf '%s' "$DET" | jfield '.memory.rss')
  RSS_MB=$((RSS / 1024 / 1024))
  ok "processus : uptime ${UPTIME}s, RSS ${RSS_MB} Mo"

  DISK_AVAIL=$(printf '%s' "$DET" | jfield '.disk.available')
  if [ "$DISK_AVAIL" = "true" ]; then
    DISK_USED=$(printf '%s' "$DET" | jfield '.disk.usedPercent')
    ok "disque : ${DISK_USED}% utilisé"
    if [ -n "$DISK_USED" ] && [ "$(printf '%.0f' "$DISK_USED" 2>/dev/null)" -ge 85 ] 2>/dev/null; then
      warn "disque utilisé à ${DISK_USED}% (>= 85% : risque de saturation)"
    fi
  else
    warn "mesure du disque indisponible sur ce système"
  fi

  DB_LATENCY=$(printf '%s' "$DET" | jfield '.database.latencyMs')
  ok "PostgreSQL : latence ${DB_LATENCY} ms"
  if [ -n "$DB_LATENCY" ] && [ "$(printf '%.0f' "$DB_LATENCY" 2>/dev/null)" -gt "$WARN_DB_LATENCY_MS" ] 2>/dev/null; then
    warn "latence PostgreSQL ${DB_LATENCY} ms > ${WARN_DB_LATENCY_MS} ms"
  fi

  ORGS=$(printf '%s' "$DET" | jfield '.business.organizations')
  SUB_ACTIVE=$(printf '%s' "$DET" | jfield '.business.activeSubscriptions')
  PAY_TODAY=$(printf '%s' "$DET" | jfield '.business.paymentsToday')
  ok "business : $ORGS organisations, $SUB_ACTIVE abonnements actifs, $PAY_TODAY paiements aujourd'hui"

  SUCCESS_RATE=$(printf '%s' "$DET" | jfield '.payments.successRate')
  PAY_TOTAL=$(printf '%s' "$DET" | jfield '.payments.total')
  ok "paiements : taux de succès ${SUCCESS_RATE:-n/a} (total ${PAY_TOTAL:-0})"
  # Alerte seulement s'il y a eu une activité de paiement terminale.
  if [ -n "$SUCCESS_RATE" ] && [ "${PAY_TOTAL:-0}" -gt 0 ] && [ "$(node -e "console.log($SUCCESS_RATE<$WARN_SUCCESS_RATE?1:0)")" = "1" ]; then
    warn "taux de succès des paiements ${SUCCESS_RATE} < ${WARN_SUCCESS_RATE}"
  fi

  # État des providers (activé / configuré uniquement, jamais de clé).
  for P in mock wave orange_money stripe; do
    ENABLED=$(printf '%s' "$DET" | jfield ".providers.$P.enabled")
    CONFIGURED=$(printf '%s' "$DET" | jfield ".providers.$P.configured")
    ok "provider $P : enabled=$ENABLED configured=$CONFIGURED"
  done
fi

# ---------------------------------------------------------------------------
# 4) Métriques applicatives
# ---------------------------------------------------------------------------
echo "== [4] Métriques =="
MET=$(api_get /api/metrics)
if [ -z "$MET" ]; then
  bad "/api/metrics indisponible"
else
  REQ_TOTAL=$(printf '%s' "$MET" | jfield '.requests.total')
  REQ_AVG=$(printf '%s' "$MET" | jfield '.requests.avgDurationMs')
  REQ_SLOW=$(printf '%s' "$MET" | jfield '.requests.slowCount')
  HTTP_ERR=$(printf '%s' "$MET" | jfield '.errors.total')
  HTTP_ERR=$(( ${HTTP_ERR:-0} + 0 ))
  ok "requêtes : $REQ_TOTAL (moyenne ${REQ_AVG} ms, lentes: $REQ_SLOW)"
  if [ -n "$REQ_SLOW" ] && [ "$REQ_SLOW" -gt "$WARN_SLOW_COUNT" ] 2>/dev/null; then
    warn "requêtes lentes cumulées : $REQ_SLOW > $WARN_SLOW_COUNT"
  fi
  ok "erreurs HTTP cumulées : $HTTP_ERR"
  if [ -n "$HTTP_ERR" ] && [ "$HTTP_ERR" -gt "$WARN_HTTP_ERRORS" ] 2>/dev/null; then
    warn "erreurs HTTP cumulées : $HTTP_ERR > $WARN_HTTP_ERRORS"
  fi

  SQL_TOTAL=$(printf '%s' "$MET" | jfield '.sql.total')
  SQL_AVG=$(printf '%s' "$MET" | jfield '.sql.avgDurationMs')
  SQL_SLOW=$(printf '%s' "$MET" | jfield '.sql.slowCount')
  ok "SQL : ${SQL_TOTAL:-0} requêtes (moyenne ${SQL_AVG} ms, lentes: ${SQL_SLOW:-0})"
  if [ -n "$SQL_SLOW" ] && [ "$SQL_SLOW" -gt "$WARN_SLOW_COUNT" ] 2>/dev/null; then
    warn "requêtes SQL lentes cumulées : $SQL_SLOW > $WARN_SLOW_COUNT"
  fi

  POOL_TOTAL=$(printf '%s' "$MET" | jfield '.database.pool.total')
  POOL_IDLE=$(printf '%s' "$MET" | jfield '.database.pool.idle')
  POOL_USED=$(( ${POOL_TOTAL:-0} - ${POOL_IDLE:-0} ))
  ok "pool PostgreSQL : ${POOL_USED}/${POOL_TOTAL} connexions utilisées"
fi

# ---------------------------------------------------------------------------
# 5) HEALTHCHECK Docker (lecture seule via inspect)
# ---------------------------------------------------------------------------
echo "== [5] Docker HEALTHCHECK =="
if command -v docker >/dev/null 2>&1; then
  APP_ID=$($COMPOSE_CMD ps -q app 2>/dev/null)
  if [ -n "$APP_ID" ]; then
    HEALTH=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}n/a{{end}}' "$APP_ID" 2>/dev/null)
    if [ "$HEALTH" = "healthy" ]; then
      ok "healthcheck du conteneur app : healthy"
    else
      bad "healthcheck du conteneur app : $HEALTH (attendu: healthy)"
    fi
  else
    warn "service app introuvable (docker compose ps -q app)"
  fi
fi

# ---------------------------------------------------------------------------
# Bilan
# ---------------------------------------------------------------------------
echo "=================================================="
echo "Résultat : PASS=$PASS FAIL=$FAIL WARN=$WARN"
if [ "$FAIL" -gt 0 ]; then
  echo "=> Des vérifications critiques ont échoué."
  exit 1
elif [ "$WARN" -gt 0 ] && [ "$STRICT" -eq 1 ]; then
  echo "=> Avertissements présents (mode strict)."
  exit 2
else
  echo "=> Observabilité saine."
  exit 0
fi
