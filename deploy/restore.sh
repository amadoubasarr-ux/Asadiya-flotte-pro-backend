#!/usr/bin/env bash
# ============================================================
# Asadiya Flotte PRO — restauration d'une sauvegarde PostgreSQL
#
# Usage :
#   ./deploy/restore.sh backups/asadiya-2026-08-07.sql.gz
#
# PRÉCAUTION : ce script DÉTRUIT le contenu actuel de la base « db »
# avant de restaurer. À n'exécuter que pour revenir à un état connu
# (rollback de données ou reprise après incident).
#
# Dépendances : docker compose (le service « db » doit tourner).
# ============================================================
set -euo pipefail

DUMP="${1:-}"
ENV_FILE="${ENV_FILE:-.env.docker}"
COMPOSE=(docker compose --env-file "$ENV_FILE")

if [ -z "$DUMP" ] || [ ! -f "$DUMP" ]; then
  echo "Usage : $0 <fichier-dump.sql.gz>" >&2
  echo "Exemple : $0 backups/asadiya-2026-08-07.sql.gz" >&2
  exit 1
fi

DB_USER="${POSTGRES_USER:-asadiya}"
DB_NAME="${POSTGRES_DB:-asadiya_flotte}"

echo "[restore] Confirmation requise — la base « $DB_NAME » va être REPLACÉE."
read -r -p "Taper OUI pour continuer : " CONFIRM
if [ "$CONFIRM" != "OUI" ]; then
  echo "[restore] Annulé."
  exit 1
fi

# 1) Vérifie que le service db est démarré.
"${COMPOSE[@]}" ps db --status running >/dev/null 2>&1 || {
  echo "[restore] ERREUR : le service « db » ne tourne pas." >&2
  exit 1
}

# 2) Restaure le contenu (--clean réinitialise les objets existants).
#    Le dump est au format custom compressé (produit par backup.sh).
echo "[restore] Décompression puis restauration de $DUMP ..."
gzip -dc "$DUMP" | "${COMPOSE[@]}" exec -T db pg_restore \
  --clean --if-exists --no-owner --no-privileges \
  -U "$DB_USER" -d "$DB_NAME"

echo "[restore] OK : restauration terminée."
echo "[restore] Redémarrage du service app pour recharger l'état :"
"${COMPOSE[@]}" restart app
echo "[restore] Terminé. Vérifiez : ./deploy/verify-production.sh"
