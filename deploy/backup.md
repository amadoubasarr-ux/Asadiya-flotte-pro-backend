# Sauvegardes — Asadiya Flotte PRO

> Préparation : la procédure est fournie, **aucun cron n'est installé** à
> cette étape (Phase 6.1). L'activation de la planification est volontaire.

## Ce qu'il faut sauvegarder

1. **Base de données PostgreSQL** (données métier) — le point critique.
2. **Fichier d'environnement** `.env.docker` (secrets : JWT, Postgres, Wave/Orange/Stripe) — sans lui, aucune restauration n'est possible.
3. **Code source** (version déployée : `git tag` suffit).
4. *(Optionnel)* volume `pgdata` complet (voir section Docker).

## 1. Sauvegarde de la base (dump)

Script fourni : `deploy/backup.sh`.

```bash
./deploy/backup.sh /opt/asadiya/backups
# => /opt/asadiya/backups/asadiya-2026-08-07.sql.gz
```

Ce que fait le script :

- `pg_dump --format=custom --compress=9` via le service `db` (dump cohérent,
  restauration flexible avec `pg_restore`).
- Écrit un fichier horodaté `asadiya-<YYYY-MM-DD>.sql.gz`, permissions `600`.
- Vérifie que le fichier n'est pas vide (échec ⇒ suppression + exit 1).
- **Rotation automatique** : conserve `KEEP=14` fichiers (variable d'env),
  supprime les plus anciens.

## 2. Sauvegarde du fichier d'environnement

```bash
cp .env.docker /opt/asadiya/backups/env/.env.docker.$(date +%Y-%m-%d)
chmod 600 /opt/asadiya/backups/env/.env.docker.$(date +%Y-%m-%d)
```

> Stockez ce fichier **hors du serveur** (gestionnaire de secrets, coffre-fort).
> Il contient les secrets de production.

## 3. Sauvegarde du volume Docker (optionnel, gros)

Le volume `pgdata` contient les fichiers de données bruts. Le dump
(§ 1) est la méthode **recommandée** (portable entre versions). Un snap de
volume sert de filet de sécurité supplémentaire :

```bash
docker run --rm -v asadiya-flotte-pro-backend_pgdata:/data -v /opt/asadiya/backups/volumes:/backup \
  alpine tar czf /backup/pgdata-$(date +%Y-%m-%d).tar.gz -C /data .
```

## 4. Rotation & répertoires

- Les dumps tournent automatiquement (14 par défaut).
- Une **copie hors site** (autre machine / S3 / NAS) est vivement recommandée :
  copier `/opt/asadiya/backups` après chaque sauvegarde.

## 5. Planification (à activer plus tard, volontairement)

Exemple de crontab (racine) :

```
0 2 * * * /opt/asadiya/deploy/backup.sh /opt/asadiya/backups >> /var/log/asadiya-backup.log 2>&1
```

Ou systemd timer (recommandé) : unit `asadiya-backup.service` + `.timer`
quotidien à 02:00, avec `OnFailure` → email/admin.

## 6. Test de restauration

**Une sauvegarde non testée n'est pas une sauvegarde.** Tester
régulièrement sur un environnement isolé :

```bash
# 1) Monter une base jetable
docker run -d --name asadiya-restore-test -e POSTGRES_PASSWORD=x -e POSTGRES_DB=asadiya_flotte postgres:16-alpine

# 2) Restaurer
gzip -dc /opt/asadiya/backups/asadiya-2026-08-07.sql.gz \
  | docker exec -i asadiya-restore-test pg_restore --clean --if-exists --no-owner -U postgres -d asadiya_flotte

# 3) Compter les lignes et comparer avec le compte de production
docker exec asadiya-restore-test psql -U postgres -d asadiya_flotte -tAc "SELECT count(*) FROM clients;"

# 4) Nettoyage
docker rm -f asadiya-restore-test
```

## Bonnes pratiques

- Exécuter une sauvegarde **avant chaque mise à jour** ([update.md](./update.md)).
- Vérifier quotidiennement la présence et la taille des derniers dumps.
- ROTATION hors site : conserver au moins 30 jours.
- Le dump contient les mots de passe hachés (bcrypt) : protéger les fichiers.
