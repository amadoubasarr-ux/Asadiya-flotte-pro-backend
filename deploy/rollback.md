# Rollback — Asadiya Flotte PRO

Procédure de retour à une version antérieure après une mise à jour
problématique.

## Deux types de rollback

| Type | Ce qui est remis | Méthode |
|---|---|---|
| Code / image | La version précédente de l'application | Git + rebuild de l'ancienne image |
| Données | La base dans un état antérieur | `restore.sh` avec la dernière sauvegarde |

Ils sont **indépendants** : un problème de code ne nécessite pas de toucher
aux données.

## 1. Rollback du code

```bash
cd /opt/asadiya

# Identifier la version déployée précédemment
git log --oneline -10

# Revenir au commit précédent (ou à un tag)
git checkout <commit-precedent>

# Rebuild de l'image + recréation du conteneur app
docker compose --env-file .env.docker up -d --build

# Vérifier
./deploy/verify-production.sh
curl -s https://flotte.example.com/api/health
```

**Remarque** : si la version antérieure a un `package-lock.json` différent,
le rebuild réinstalle les dépendances de cette version (`npm ci` dans le
Dockerfile multi-étapes).

## 2. Rollback des données (uniquement si nécessaire)

S'applique si la mise à jour a **altéré des données** (ex : une migration
destructive) — rare avec des migrations additives, mais toujours possible :

```bash
./deploy/backup.sh /opt/asadiya/backups        # sauvegarder l'état actuel d'abord
./deploy/restore.sh backups/asadiya-<date-avant-deploiement>.sql.gz
```

## 3. Rollback Nginx

Le fichier de config Nginx est versionné (`deploy/nginx.conf.example`) :

```bash
sudo cp /etc/nginx/sites-available/asadiya-flotte /etc/nginx/sites-available/asadiya-flotte.bak
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/asadiya-flotte
sudo nginx -t && sudo systemctl reload nginx
```

## Principes

1. **Toujours sauvegarder avant** (données + note du commit actuel).
2. Préférer **corriger en avant** (hotfix) à un rollback si le correctif est
   rapide — un rollback de données est toujours risqué.
3. Après rollback : rejouer `verify-production.sh` et contrôler les paiements
   et l'état des webhooks (Wave/Orange/Stripe) si un fournisseur est actif.
4. Journaliser la cause (contenu des logs `app`) avant de revenir en avant.
