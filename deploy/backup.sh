#!/usr/bin/env bash
# ============================================================
# Asadiya Flotte PRO — sauvegarde PostgreSQL (avec rotation)
#
# Usage :
#   ./deploy/backup.sh                      # sauvegarde dans ./backups
#   ./deploy/backup.sh /chemin/vers/sauvegardes   # autre répertoire
#
# Dépendances : docker compose (le service « db » doit tourner).
# Le nombre de sauvegardes conservées est KEEP (14 par défaut).
# Ce script est fourni en préparation : aucun cron n'est installé.
# Exemple de planification (à activer plus tard) :
#   0 2 * * * /opt/asadiya/deploy/backup.sh /opt/asadiya/backups >> /var/log/asadiya-backup.log 2>&1
# ============================================================
set -euo pipefail

BACKUP_DIR="${1:-./backups}"
KEEP="${KEEP:-14}"
ENV_FILE="${ENV_FILE:-.env.docker}"
COMPOSE=(docker compose --env-file "$ENV_FILE")

mkdir -p "$BACKUP_DIR"

# Horodatage du jour + étiquette du schéma : ex. asadiya-2026-08-07.sql.gz
STAMP="$(date +%Y-%m-%d)"
FILE="$BACKUP_DIR/asadiya-${STAMP}.sql.gz"
GZ="$(command -v gzip || true)"

# Sauvegarde complète (dump binaire/custom compressé) de la base « db ».
# --format=custom : restauration flexible (pg_restore, perte de données évitée).
echo "[backup] Dump de la base vers ${FILE} ..."
if [ -n "$GZ" ]; then
  "${COMPOSE[@]}" exec -T db pg_dump \
    --format=custom --compress=9 --file=/dev/stdout \
    -U "${POSTGRES_USER:-asadiya}" -d "${POSTGRES_DB:-asadiya_flotte}" \
    | gzip -9 > "$FILE"
else
  "${COMPOSE[@]}" exec -T db pg_dump \
    --format=custom --compress=9 --file=/dev/stdout \
    -U "${POSTGRES_USER:-asadiya}" -d "${POSTGRES_DB:-asadiya_flotte}" \
    > "$FILE"
fi

# Vérifie que le fichier n'est pas vide (dump réussi).
if [ ! -s "$FILE" ]; then
  echo "[backup] ERREUR : sauvegarde vide, fichier supprimé." >&2
  rm -f "$FILE"
  exit 1
fi

chmod 600 "$FILE"
echo "[backup] OK : $(du -h "$FILE" | cut -f1)"

# Rotation : ne conserve que les KEEP fichiers les plus récents.
OLD_COUNT=0
while [ "$(find "$BACKUP_DIR" -maxdepth 1 -name 'asadiya-*.sql.gz' | wc -l)" -gt "$KEEP" ]; do
  OLDEST="$(find "$BACKUP_DIR" -maxdepth 1 -name 'asadiya-*.sql.gz' -print0 | xargs -0 ls -1t | tail -n1)"
  if [ -z "$OLDEST" ]; then
    break
  fi
  echo "[backup] Rotation : suppression de ${OLDEST}"
  rm -f "$OLDEST"
  OLD_COUNT=$((OLD_COUNT + 1))
done
echo "[backup] Terminé (${OLD_COUNT} ancien(s) fichier(s) supprimé(s))."
