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

# ============================================================
# Pièces jointes documents (Phase Documentation — Commit 5)
# ============================================================
# Le volume Docker « uploads » (/app/uploads, monté dans le conteneur app)
# contient les fichiers joints aux documents. Il est archivé séparément
# (même rotation que la base) pour permettre une restauration VPS complète :
#   PostgreSQL        -> asadiya-YYYY-MM-DD.sql.gz
#   Pièces jointes    -> asadiya-uploads-YYYY-MM-DD.tar.gz
# Si le conteneur app n'est pas démarré, l'archive est simplement sautée
# (la sauvegarde de la base reste prioritaire et non bloquante).
UPLOADS_FILE="$BACKUP_DIR/asadiya-uploads-${STAMP}.tar.gz"
echo "[backup] Archive des pièces jointes (uploads) vers ${UPLOADS_FILE} ..."
if "${COMPOSE[@]}" exec -T app sh -c 'test -d /app/uploads' >/dev/null 2>&1; then
  "${COMPOSE[@]}" exec -T app tar -czf - -C /app uploads > "$UPLOADS_FILE" 2>/dev/null || true
  if [ ! -s "$UPLOADS_FILE" ]; then
    rm -f "$UPLOADS_FILE"
    echo "[backup] (aucune pièce jointe : archive non créée)"
  else
    chmod 600 "$UPLOADS_FILE"
    echo "[backup] OK : $(du -h "$UPLOADS_FILE" | cut -f1)"
  fi
else
  echo "[backup] (conteneur app indisponible : pièces jointes non sauvegardées)"
fi

# Rotation : ne conserve que les KEEP fichiers les plus récents
# (dumps PostgreSQL et archives uploads confondues).
OLD_COUNT=0
while [ "$(find "$BACKUP_DIR" -maxdepth 1 \( -name 'asadiya-*.sql.gz' -o -name 'asadiya-uploads-*.tar.gz' \) | wc -l)" -gt "$KEEP" ]; do
  OLDEST="$(find "$BACKUP_DIR" -maxdepth 1 \( -name 'asadiya-*.sql.gz' -o -name 'asadiya-uploads-*.tar.gz' \) -print0 | xargs -0 ls -1t | tail -n1)"
  if [ -z "$OLDEST" ]; then
    break
  fi
  echo "[backup] Rotation : suppression de ${OLDEST}"
  rm -f "$OLDEST"
  OLD_COUNT=$((OLD_COUNT + 1))
done
echo "[backup] Terminé (${OLD_COUNT} ancien(s) fichier(s) supprimé(s))."
