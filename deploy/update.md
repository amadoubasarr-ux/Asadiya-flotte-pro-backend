# Mise à jour en production — Asadiya Flotte PRO

Procédure de déploiement d'une nouvelle version. À exécuter **depuis le
répertoire du dépôt** (`/opt/asadiya`).

## Principe

1. **Sauvegarde** avant tout changement (données + éventuellement image actuelle).
2. **Récupération** du nouveau code.
3. **Rebuild** de l'image applicative.
4. **Recréation** des conteneurs (les données restent dans le volume `pgdata`).
5. **Migrations** automatiques au démarrage de `app` (`server.js`).
6. **Vérification** post-déploiement.

## Procédure pas à pas

```bash
cd /opt/asadiya

# 1) Sauvegarde de sécurité (voir backup.md)
./deploy/backup.sh /opt/asadiya/backups

# 2) Récupération du code
git pull --ff-only

# 3) Rebuild + recréation (sans arrêt des données)
docker compose --env-file .env.docker up -d --build

# 4) État
docker compose --env-file .env.docker ps

# 5) Vérification
./deploy/verify-production.sh
curl -s https://flotte.example.com/api/health
```

## Notes importantes

- **Migrations** : elles sont appliquées automatiquement au démarrage du
  conteneur `app` (dépend de `db` saine via `condition: service_healthy`).
  Ne les lancez jamais manuellement en parallèle d'un déploiement.
- **Aucune donnée perdue** : `down`/`up` n'efface pas le volume `pgdata`.
- En cas de régression : voir [rollback.md](./rollback.md).

## Rebuild sans redémarrage inutile

Seuls les changements de `package.json`/`package-lock.json` imposent un
rebuild complet des dépendances. Pour un simple changement de code :

```bash
docker compose --env-file .env.docker build app   # reconstruction
docker compose --env-file .env.docker up -d app   # recréation si besoin
```

## Journalisation

Les logs JSON ligne-à-ligne sont consultables sans altérer le système :

```bash
docker compose --env-file .env.docker logs -f --tail=200 app
```
