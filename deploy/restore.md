# Restauration — Asadiya Flotte PRO

Restauration d'une sauvegarde PostgreSQL après incident, corruption ou
rollback de données.

> ⚠️ **La restauration ÉCRASE le contenu actuel de la base.** Vérifiez que
> vous disposez d'une sauvegarde valide avant de commencer.

## Prérequis

- Sauvegarde au format produit par `deploy/backup.sh`
  (`asadiya-<date>.sql.gz`, format `custom` compressé).
- Service `db` démarré.

## Restauration (script fourni)

```bash
cd /opt/asadiya
./deploy/restore.sh backups/asadiya-2026-08-07.sql.gz
```

Le script :

1. Demande une **confirmation explicite** (taper `OUI`).
2. Vérifie que le service `db` tourne.
3. Décompresse puis restaure avec `pg_restore --clean --if-exists
   --no-owner --no-privileges` (réinitialise les objets existants, préserve
   les droits gérés par l'application).
4. Redémarre le service `app`.

## Restauration manuelle

```bash
gzip -dc backups/asadiya-2026-08-07.sql.gz \
  | docker compose --env-file .env.docker exec -T db pg_restore \
      --clean --if-exists --no-owner --no-privileges \
      -U asadiya -d asadiya_flotte

docker compose --env-file .env.docker restart app
```

## Restauration des pièces jointes (volume `uploads`)

Les fichiers joints aux documents sont sauvegardés séparément par
`deploy/backup.sh` (`asadiya-uploads-<date>.tar.gz`). Pour les restaurer :

```bash
docker run --rm \
  -v asadiya-flotte-pro-backend_uploads:/uploads \
  -v /opt/asadiya/backups:/backups \
  alpine sh -c "rm -rf /uploads/* && tar xzf /backups/asadiya-uploads-2026-08-07.tar.gz -C /uploads --strip-components=1"
```

> L'archive contient le dossier `uploads/` à la racine ; `--strip-components=1`
> l'extrait directement dans le volume (structure `documents/<orgId>/<docId>/...`
> restaurée à l'identique). Les métadonnées en base pointent vers ces mêmes
> chemins internes : la restauration base + uploads est cohérente.

## Restauration d'un dump SQL « plain »

Si le dump est au format texte (`pg_dump` sans `--format=custom`) :

```bash
docker compose --env-file .env.docker exec -T db psql \
  -U asadiya -d asadiya_flotte < backups/dump-plain.sql
```

## Après restauration

```bash
./deploy/verify-production.sh
curl -s https://flotte.example.com/api/health
# Contrôler quelques données critiques (clients, véhicules, paiements)
```

## Notes

- `--no-owner`/`--no-privileges` : les rôles Postgres restent ceux gérés par
  Docker Compose ; évite les erreurs « role does not exist » lors d'un test
  ou d'un environnement différent.
- En cas d'échec partiel, refaire la restauration (le `--clean` rend la
  base **répétable** : on peut relancer sans état résiduel).
- Pour revenir à une **version applicative** antérieure (code), voir
  [rollback.md](./rollback.md).
