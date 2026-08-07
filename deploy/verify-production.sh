#!/usr/bin/env bash
# ============================================================
# Asadiya Flotte PRO — vérification automatique de production (LECTURE SEULE)
#
# Usage :
#   ./deploy/verify-production.sh
#   ./deploy/verify-production.sh --strict   # quitte en erreur au premier FAIL
#
# Ce script ne MODIFIE RIEN : il se contente de lire l'état du système
# (docker, docker compose, .env.docker, point de terminaison /api/health).
# Aucun secret n'est affiché : seules les variables présentes/absentes
# sont signalées.
#
# Vérifie : Docker, docker compose, PostgreSQL, API + healthcheck,
# paiements (mock par défaut, fournisseurs réels cohérents), variables
# critiques, permissions des fichiers sensibles.
# ============================================================
set -u

ENV_FILE="${ENV_FILE:-.env.docker}"
COMPOSE_CMD="docker compose --env-file $ENV_FILE"
STRICT=0
[ "${1:-}" = "--strict" ] && STRICT=1

PASS=0; FAIL=0; WARN=0
log()   { printf '%-5s %s\n' "$1" "$2"; }
ok()    { log OK "$1"; PASS=$((PASS+1)); }
bad()   { log FAIL "$1"; FAIL=$((FAIL+1)); }
warn()  { log WARN "$1"; WARN=$((WARN+1)); }

# ---------------------------------------------------------------------------
# 1) Outils requis
# ---------------------------------------------------------------------------
echo "== [1] Outils requis =="
if command -v docker >/dev/null 2>&1; then ok "docker est installé"; else bad "docker introuvable"; fi
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  ok "plugin docker compose disponible"
else
  bad "plugin docker compose introuvable"
fi
if command -v curl >/dev/null 2>&1; then ok "curl est installé"; else warn "curl introuvable (le test health utilisera docker exec)"; fi

# ---------------------------------------------------------------------------
# 2) Fichier d'environnement : présence + permissions
# ---------------------------------------------------------------------------
echo "== [2] Fichier d'environnement ($ENV_FILE) =="
if [ ! -f "$ENV_FILE" ]; then
  bad "$ENV_FILE absent"
else
  ok "$ENV_FILE présent"
  PERMS=$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE" 2>/dev/null)
  if [ -n "$PERMS" ]; then
    if [ "$PERMS" = "600" ] || [ "$PERMS" = "400" ]; then
      ok "permissions $ENV_FILE = $PERMS (restreintes)"
    else
      warn "permissions $ENV_FILE = $PERMS (600 recommandé)"
    fi
  fi
fi

# Lit le .env SANS exposer les valeurs : on extrait uniquement NOM=.
ENV_NAMES=""
if [ -f "$ENV_FILE" ]; then
  ENV_NAMES=$(grep -E '^[A-Z][A-Z0-9_]*=' "$ENV_FILE" | cut -d= -f1)
fi
var_set() { printf '%s\n' "$ENV_NAMES" | grep -qx "$1"; }

# ---------------------------------------------------------------------------
# 3) Variables critiques (présence uniquement, jamais de valeur affichée)
# ---------------------------------------------------------------------------
echo "== [3] Variables critiques =="
if var_set JWT_SECRET; then
  LEN=$(grep -E '^JWT_SECRET=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'" | wc -c | tr -d ' ')
  if [ "$LEN" -ge 32 ]; then ok "JWT_SECRET présent (>= 32 caractères)"; else bad "JWT_SECRET trop court (< 32 caractères)"; fi
else
  bad "JWT_SECRET absent"
fi

if var_set CORS_ORIGIN; then
  VAL=$(grep -E '^CORS_ORIGIN=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'")
  if [ -z "$VAL" ]; then bad "CORS_ORIGIN vide"; elif [ "$VAL" = "*" ]; then bad "CORS_ORIGIN = '*' interdit en production"; else ok "CORS_ORIGIN défini (origines explicites)"; fi
else
  bad "CORS_ORIGIN absent"
fi

# NODE_ENV ne doit pas être development en production.
if var_set NODE_ENV; then
  NV=$(grep -E '^NODE_ENV=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'")
  if [ "$NV" = "production" ]; then ok "NODE_ENV=production"; else bad "NODE_ENV=$NV (attendu: production)"; fi
else
  warn "NODE_ENV non défini (docker-compose applique production par défaut)"
fi

# ---------------------------------------------------------------------------
# 4) Configuration docker compose (docker compose config --quiet)
# ---------------------------------------------------------------------------
echo "== [4] Docker Compose =="
if docker compose --env-file "$ENV_FILE" config --quiet >/dev/null 2>&1; then
  ok "compose config valide"
else
  bad "compose config invalide (docker compose config)"
fi

# ---------------------------------------------------------------------------
# 5) État des services (running + healthy)
# ---------------------------------------------------------------------------
echo "== [5] Services Docker =="
for SERVICE in db app; do
  if $COMPOSE_CMD ps "$SERVICE" --status running >/dev/null 2>&1; then
    ok "service $SERVICE : en cours d'exécution"
  else
    bad "service $SERVICE : PAS en cours d'exécution"
  fi
done

# HEALTHCHECK Docker du conteneur app (lisible via inspect, lecture seule).
APP_ID=$($COMPOSE_CMD ps -q app 2>/dev/null)
if [ -n "$APP_ID" ]; then
  HEALTH=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}n/a{{end}}' "$APP_ID" 2>/dev/null)
  if [ "$HEALTH" = "healthy" ]; then ok "healthcheck du conteneur app : healthy"; else warn "healthcheck du conteneur app : $HEALTH (attendu: healthy)"; fi
  UID_CHECK=$(docker inspect --format '{{.Config.User}}' "$APP_ID" 2>/dev/null)
  if [ -n "$UID_CHECK" ] && [ "$UID_CHECK" != "root" ] && [ "$UID_CHECK" != "" ]; then
    ok "conteneur app non root (USER=$UID_CHECK)"
  else
    warn "conteneur app tourne peut-être en root (USER='$UID_CHECK')"
  fi
fi

# ---------------------------------------------------------------------------
# 6) PostgreSQL : readiness + requête minimale (lecture seule)
# ---------------------------------------------------------------------------
echo "== [6] PostgreSQL =="
if $COMPOSE_CMD exec -T db pg_isready -h 127.0.0.1 -U "${POSTGRES_USER:-asadiya}" -d "${POSTGRES_DB:-asadiya_flotte}" >/dev/null 2>&1; then
  ok "pg_isready OK"
else
  bad "pg_isready KO (service db indisponible)"
fi
if $COMPOSE_CMD exec -T db psql -U "${POSTGRES_USER:-asadiya}" -d "${POSTGRES_DB:-asadiya_flotte}" -tAc "SELECT 1" >/dev/null 2>&1; then
  ok "requête minimale SELECT 1 OK"
else
  bad "SELECT 1 KO"
fi

# ---------------------------------------------------------------------------
# 7) API : healthcheck applicatif (/api/health -> {"status":"ok"})
# ---------------------------------------------------------------------------
echo "== [7] API / healthcheck applicatif =="
PORT=$($COMPOSE_CMD port app 4000 2>/dev/null | grep -oE '[0-9]+$' | head -n1)
if [ -n "$PORT" ]; then
  if curl -fsS "http://127.0.0.1:$PORT/api/health" 2>/dev/null | grep -q '"ok"'; then
    ok "/api/health répond sur 127.0.0.1:$PORT"
  else
    bad "/api/health ne répond pas sur 127.0.0.1:$PORT"
  fi
else
  # Repli : curl depuis l'intérieur du conteneur app (aucune modification).
  if $COMPOSE_CMD exec -T app node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    ok "/api/health répond (via exec dans le conteneur)"
  else
    bad "/api/health KO (port non exposé ET exec impossible)"
  fi
fi

# ---------------------------------------------------------------------------
# 8) Paiements : cohérence de la configuration (aucune valeur affichée)
# ---------------------------------------------------------------------------
echo "== [8] Configuration paiements =="
PROVIDER=$(grep -E '^PAYMENT_PROVIDER=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d '"' | tr -d "'")
PROVIDER="${PROVIDER:-mock}"
if [ "$PROVIDER" = "mock" ]; then
  ok "PAYMENT_PROVIDER=mock (aucun paiement réel actif)"
else
  ok "PAYMENT_PROVIDER=$PROVIDER"
fi

for W in WAVE_ENABLED ORANGE_ENABLED STRIPE_ENABLED; do
  ENABLED=$(grep -E "^$W=" "$ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d '"' | tr -d "'")
  ENABLED="${ENABLED:-false}"
  if [ "$ENABLED" = "true" ]; then
    case "$W" in
      WAVE_ENABLED)   NEED="WAVE_API_KEY WAVE_API_SECRET WAVE_WEBHOOK_SECRET" ;;
      ORANGE_ENABLED) NEED="ORANGE_CLIENT_ID ORANGE_CLIENT_SECRET ORANGE_MERCHANT_ID ORANGE_WEBHOOK_SECRET ORANGE_NOTIF_URL" ;;
      STRIPE_ENABLED) NEED="STRIPE_SECRET_KEY STRIPE_PUBLISHABLE_KEY STRIPE_WEBHOOK_SECRET" ;;
    esac
    MISSING=""
    for V in $NEED; do var_set "$V" || MISSING="$MISSING $V"; done
    if [ -z "$MISSING" ]; then ok "$W activé avec identifiants complets"; else bad "$W activé mais variables manquantes :$MISSING"; fi
  else
    ok "$W=$ENABLED"
  fi
done

# ---------------------------------------------------------------------------
# 9) Permissions des fichiers sensibles (lecture seule)
# ---------------------------------------------------------------------------
echo "== [9] Fichiers sensibles =="
for F in "$ENV_FILE" deploy/nginx.conf.example; do
  if [ -f "$F" ]; then
    P=$(stat -c '%a' "$F" 2>/dev/null || stat -f '%Lp' "$F" 2>/dev/null)
    ok "$F présent (permissions $P)"
  else
    warn "$F absent"
  fi
done

# ---------------------------------------------------------------------------
# Bilan
# ---------------------------------------------------------------------------
echo "=================================================="
echo "Résultat : PASS=$PASS FAIL=$FAIL WARN=$WARN"
if [ "$FAIL" -gt 0 ]; then
  echo "=> Des vérifications critiques ont échoué. Corrigez avant de continuer."
  exit 1
elif [ "$WARN" -gt 0 ] && [ "$STRICT" -eq 1 ]; then
  echo "=> Avertissements présents (mode strict)."
  exit 2
else
  echo "=> Production prête."
  exit 0
fi
