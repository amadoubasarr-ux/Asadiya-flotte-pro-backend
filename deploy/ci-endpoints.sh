#!/usr/bin/env bash
# ============================================================
# Validation des endpoints — CI (Phase 6.4)
#
# Vérifie que l'API répond conformément aux comportements déjà
# couverts par la suite de tests (tests/api.test.js, monitoring,
# security, payments) :
#
#   GET  /api/health            -> 200
#   GET  /api/health/live       -> 200
#   GET  /api/health/ready      -> 200
#   GET  /api/metrics           -> 200
#   GET  /api/plans/public      -> 200 + tableau JSON
#   POST /api/auth/login        -> 401 (identifiants invalides)
#   GET  /api/payments          -> 401 (non authentifié)
#   GET  /api/auth              -> 404 (route inexistante, JSON)
#
# Usage :  bash deploy/ci-endpoints.sh [BASE_URL]
#          (BASE_URL par défaut : http://localhost:4000)
# ============================================================
set -u

BASE_URL="${1:-http://localhost:4000}"
PASS=0
FAIL=0

check() {
    local name="$1" method="$2" path="$3" expected="$4" data="${5:-}"
    local out code
    if [ -n "$data" ]; then
        out=$(curl -s -w '\n%{http_code}' -X "$method" \
            -H 'Content-Type: application/json' --data-binary "$data" \
            "$BASE_URL$path" 2>/dev/null)
    else
        out=$(curl -s -w '\n%{http_code}' -X "$method" "$BASE_URL$path" 2>/dev/null)
    fi
    code=$(printf '%s' "$out" | tail -n 1)
    if [ "$code" = "$expected" ]; then
        echo "  [PASS] $method $path -> $code"
        PASS=$((PASS + 1))
    else
        echo "  [FAIL] $method $path -> attendu $expected, reçu $code"
        echo "         corps : $(printf '%s' "$out" | head -n 1 | head -c 200)"
        FAIL=$((FAIL + 1))
    fi
}

echo "=============================================="
echo "=== Validation des endpoints : $BASE_URL ==="
echo "=============================================="

check "Health (léger)"           GET  /api/health             200
check "Liveness"                 GET  /api/health/live        200
check "Readiness"                GET  /api/health/ready       200
check "Métriques"                GET  /api/metrics            200

# plans/public doit renvoyer un tableau JSON
body=$(curl -s -X GET "$BASE_URL/api/plans/public" 2>/dev/null)
code=$(curl -s -o /dev/null -w '%{http_code}' -X GET "$BASE_URL/api/plans/public" 2>/dev/null)
if [ "$code" = "200" ]; then
    if printf '%s' "$body" | grep -Eq '^\s*\[' ; then
        echo "  [PASS] GET /api/plans/public -> 200 (tableau JSON)"
        PASS=$((PASS + 1))
    else
        echo "  [FAIL] GET /api/plans/public -> 200 mais corps non-tableau JSON"
        FAIL=$((FAIL + 1))
    fi
else
    echo "  [FAIL] GET /api/plans/public -> attendu 200, reçu $code"
    FAIL=$((FAIL + 1))
fi

# login invalide -> 401 (comportement couvert par tests/security.test.js)
check "Login invalide" POST /api/auth/login 401 \
    '{"username":"__ci_probe__","password":"wrong"}'

# /api/payments sans jeton -> 401 (requireAuth)
check "Payments non authentifié" GET /api/payments 401

# /api/auth sans route GET -> 404 JSON (notFoundHandler)
check "Route inexistante" GET /api/auth 404

rm -f /tmp/ci_endpoint_body.$$

echo "=============================================="
echo "  Pass : $PASS   Fail : $FAIL"
echo "=============================================="

if [ "$FAIL" -gt 0 ]; then
    echo "ÉCHEC : des endpoints ne répondent pas conformément."
    exit 1
fi
echo "SUCCÈS : tous les endpoints répondent conformément."
exit 0
