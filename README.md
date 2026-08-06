# Asadiya Flotte PRO — Backend API

Backend Node.js / Express pour l'application de gestion de flotte **Asadiya Flotte PRO**.
API REST multi-tenant (JWT, rôles ADMIN / MANAGER / DRIVER / SUPERADMIN) alimentée par
**PostgreSQL** (schéma normalisé avec clés étrangères, créé automatiquement au démarrage).

## 1. Prérequis

- Node.js 18+ (développement) **ou** Docker 24+ avec Docker Compose v2 (déploiement)
- PostgreSQL 14+ (local ou distant) — fourni automatiquement par Docker Compose

> La méthode recommandée pour la production est **Docker Compose** (section 12) :
> l'image construit l'application Node.js et Compose orchestre PostgreSQL avec
> un volume persistant.

## 2. Installation

**Déploiement en production** : suivez la section 12 (Docker Compose).

Développement local :

```bash
npm install
cp .env.example .env
# éditez .env : renseignez DATABASE_URL (et JWT_SECRET en production)
npm run migrate:json   # UNE SEULE FOIS : importe les données de data/db.json dans PostgreSQL
npm start
```

Le serveur :
1. crée automatiquement les tables (idempotent, `CREATE TABLE IF NOT EXISTS`) ;
2. démarre l'API sur **http://localhost:4000** (configurable via `PORT`).

`npm run migrate:json` est un import *one-time* : à lancer sur une base vide. Il préserve
les identifiants, resynchronise les séquences et est atomique (une seule transaction).

## 3. Configuration (`.env`)

| Variable | Rôle |
|----------|------|
| `DATABASE_URL` | Connexion PostgreSQL (`postgres://user:password@host:port/db`) |
| `DB_SSL` | `true` si la base exige TLS (RDS, Heroku, ...) |
| `PORT` | Port HTTP (défaut `4000`) |
| `JWT_SECRET` | Secret JWT. **Obligatoire (≥ 32 caractères) en production : le serveur refuse de démarrer sinon.** |
| `JWT_EXPIRES_IN` | Durée des jetons (défaut `7d`) |
| `BCRYPT_ROUNDS` | Coût bcrypt (défaut `10`) |
| `JSON_LIMIT` | Taille max des corps JSON (photos base64) |
| `CORS_ORIGIN` | Origine autorisée en production (`*` en développement) |
| `NODE_ENV` | `development` ou `production` |

## 4. Comptes de démonstration

Après `npm run migrate:json`, les comptes importés restent valides :

| Rôle          | Identifiant     | Mot de passe |
|---------------|-----------------|--------------|
| Super Admin   | `superadmin`    | `superadmin123` |
| Gestionnaire  | `gestionnaire`  | `gest123`    |
| Conducteur    | `conducteur`    | `cond123`    |

> Note : le compte `admin/admin123` (données de démo d'origine) possède un hash bcrypt
> invalide et ne peut plus se connecter. Si besoin, réinitialisez son mot de passe via
> `PATCH /api/organizations/:id/users/:userId/reset-password` (SUPERADMIN).

Les mots de passe sont stockés **hachés** (bcrypt), jamais en clair.

## 5. Authentification

```
POST /api/auth/login
Body: { "username": "gestionnaire", "password": "gest123" }
Réponse: { "token": "<JWT>", "user": { id, username, name, role, title, organizationId, organizationName } }
```

Toutes les autres routes exigent l'en-tête :
```
Authorization: Bearer <token>
```

```
GET /api/auth/me   → renvoie l'utilisateur actuellement connecté
```

## 6. Ressources disponibles (CRUD REST)

```
GET    /api/<ressource>        Liste complète (cloisonnée par organisation)
GET    /api/<ressource>/:id    Détail
POST   /api/<ressource>        Création
PUT    /api/<ressource>/:id    Modification
DELETE /api/<ressource>/:id    Suppression
```

| Ressource              | Créer / Modifier            | Supprimer               | Particularités |
|-------------------------|------------------------------|--------------------------|-----------------|
| `/api/vehicles`         | Admin, Gestionnaire          | Admin, Gestionnaire      | — |
| `/api/drivers`          | Admin, Gestionnaire, Conducteur | **Admin uniquement**  | Suppression réservée (RH) |
| `/api/reservations`     | Tous les rôles connectés     | Tous les rôles connectés | **Détection de conflit de planning en base** (409 si chevauchement) + `PATCH /api/reservations/:id/approve` (Admin/Gestionnaire uniquement) |
| `/api/maintenances`     | Admin, Gestionnaire          | Admin, Gestionnaire      | — |
| `/api/incidents`        | Tous les rôles connectés     | Tous les rôles connectés | — |
| `/api/accidents`        | Tous les rôles connectés     | Tous les rôles connectés | — |
| `/api/fuel-logs`        | Tous les rôles connectés     | Tous les rôles connectés | — |

Règles de sécurité appliquées :
- **Multi-tenant** : l'`organizationId` est toujours imposé par le serveur (jamais par le
  client) et chaque requête est filtrée par organisation.
- **Statut des réservations** : un conducteur ne peut pas s'auto-approuver (son statut reste
  `PENDING`) ; seuls Admin/Gestionnaire peuvent approuver.
- **Validation d'entrée** : tous les corps sont validés (`utils/validators.js`) avant écriture.
- **Transactions** : création de réservation (conflit + insertion), création/suppression
  d'organisation, mises à jour avec références croisées sont atomiques.

### Exemple : créer une réservation

```bash
curl -X POST http://localhost:4000/api/reservations \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"vehicleId":1,"vehicle":"Peugeot 208 (AA-123-BB)","driverId":2,"driver":"Mamadou Ndiaye","start":"2026-08-05 08:00","end":"2026-08-05 18:00","purpose":"Mission Thiès"}'
```

En cas de chevauchement, l'API renvoie :
```json
HTTP 409
{ "error": "Conflit de planning : ce véhicule est déjà réservé sur ce créneau.", "conflict": { ... } }
```

## 7. Santé du service

```
GET /api/health  → { "status": "ok", "time": "..." }
```

## 8. Frontend (index.html)

Le fichier `index.html` fourni (SPA Alpine.js) est servi par le serveur sur
`http://localhost:4000/`. Le CORS est ouvert en développement et restreint via
`CORS_ORIGIN` en production.

## 9. Schéma de base de données

Tables : `organizations`, `users`, `vehicles`, `drivers`, `reservations`, `maintenances`,
`incidents`, `accidents`, `fuel_logs` — clés étrangères, index sur `organization_id`
et sur `(organization_id, vehicle_id, start, "end")` pour les réservations.
Le schéma est défini dans `db/migrate.js` et appliqué au démarrage.

## 10. Structure du projet

```
├── server.js                 # Point d'entrée : migrate() + Express (helmet, CORS, erreurs)
├── config.js                 # Configuration centralisée (.env)
├── data/db.json              # Source des données (import one-time via npm run migrate:json)
├── db/
│   ├── pool.js               # Pool PostgreSQL + withTransaction()
│   ├── mappers.js            # snake_case <-> camelCase
│   ├── migrate.js            # Schéma SQL idempotent
│   └── repositories.js       # Accès aux données (requêtes paramétrées)
├── middleware/
│   ├── auth.js               # JWT + contrôle des rôles
│   └── errorHandler.js       # Erreurs centralisées (AppError, codes pg, JSON invalide)
├── routes/                   # Express routers (CRUD via crudFactory.js)
├── scripts/
│   └── migrate-from-json.js  # Import one-time db.json -> PostgreSQL
├── utils/
│   ├── AppError.js
│   ├── asyncHandler.js
│   └── validators.js         # Validation des corps de requête
├── Dockerfile                # Image multi-étapes, non root, HEALTHCHECK
├── docker-compose.yml        # Pile app + PostgreSQL + volume + réseau (section 12)
├── .dockerignore             # Exclusion des secrets/données de l'image
├── .env.docker.example       # Modèle des variables d'environnement Docker
└── deploy/
    └── nginx.conf.example    # Reverse proxy Nginx (préparation, non installé)
```

## 11. Production

- `JWT_SECRET` aléatoire ≥ 32 caractères (`openssl rand -hex 32`) — le serveur refuse de
  démarrer sinon.
- `NODE_ENV=production`, `CORS_ORIGIN` = origine exacte du frontend, `DB_SSL=true` si besoin.
- Derrière un reverse proxy TLS (nginx, Caddy) avec arrêt propre (SIGINT/SIGTERM gérés) :
  réglez `TRUST_PROXY=1` (voir `deploy/nginx.conf.example`).
- Sauvegardes PostgreSQL régulières (`pg_dump`).
- En production, déployez avec Docker Compose (section 12) : l'image est construite en
  multi-étapes, s'exécute avec un utilisateur non root et intègre un HEALTHCHECK sur `/api/health`.

## 12. Déploiement avec Docker (Docker Compose)

La pile Docker se compose de deux services sur un réseau dédié :
`db` (PostgreSQL 16 avec volume persistant) et `app` (l'application Node.js).
Les migrations PostgreSQL s'exécutent **automatiquement au démarrage** de l'application
(`db/migrate.js`), le seed des plans d'abonnement également.

### 12.1 Installation de Docker

- **Docker Engine 24+** : https://docs.docker.com/engine/install/
- **Docker Compose v2** (plugin inclus avec Docker Desktop, ou paquet
  `docker-compose-plugin` sur Linux)
- Vérification : `docker --version` et `docker compose version`

### 12.2 Configuration

```bash
cp .env.docker.example .env.docker
# 1. Générer un JWT_SECRET fort :
openssl rand -hex 32        # -> collez le résultat dans .env.docker (JWT_SECRET)
# 2. Renseigner :
#    - POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB (base de données)
#    - CORS_ORIGIN : l'origine exacte du frontend (ex: https://flotte.example.com)
#    - NODE_ENV=production, TRUST_PROXY=1, BILLING_PROVIDER...
#    - APP_PORT : port exposé sur l'hôte (défaut 4000)
```

> ⚠️ `.env.docker` contient des secrets : il est ignoré par git (`.gitignore`) et
> **exclu de l'image Docker** (`.dockerignore`). Ne jamais le commiter.

### 12.3 Démarrage

```bash
docker compose --env-file .env.docker up -d --build
```

- `-d` : détaché (en arrière-plan) ; `--build` : construit l'image à la première exécution.
- Le conteneur `app` n'attend pas : il démarre dès que `db` est sain (`pg_isready`),
  puis `migrate()` crée le schéma et seed les plans.

Vérifications :

```bash
docker compose --env-file .env.docker ps                 # les deux services doivent être "running"/"healthy"
curl http://localhost:4000/api/health                     # -> {"status":"ok",...}
docker compose --env-file .env.docker logs -f app         # suivi des journaux
```

Si `CORS_ORIGIN` ou `JWT_SECRET` sont invalides en `NODE_ENV=production`,
l'application refuse de démarrer (voir les logs `app`) : corrigez `.env.docker`.

### 12.4 Arrêt

```bash
docker compose --env-file .env.docker down               # arrête les conteneurs, GARDE les données
docker compose --env-file .env.docker down -v            # arrête ET supprime le volume pgdata (⚠️ détruit les données)
```

> `down` (sans `-v`) conserve le volume `pgdata` : les données survivent.

### 12.5 Mise à jour

```bash
git pull                          # récupère la nouvelle version du code
docker compose --env-file .env.docker up -d --build      # reconstruit l'image et redémarre
```

Les migrations étant idempotentes (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`),
elles s'appliquent automatiquement au redémarrage, sans perte de données.

### 12.6 Sauvegarde des volumes (PostgreSQL)

```bash
# Dump logique de la base (recommandé, portable) — remplacez asadiya/asadiya_flotte
# par votre POSTGRES_USER / POSTGRES_DB (défauts : asadiya / asadiya_flotte) :
docker compose --env-file .env.docker exec db \
  pg_dump -U asadiya asadiya_flotte > backup_$(date +%F).sql

# Alternative : sauvegarde brute du volume
#   docker run --rm -v asadiya-flotte-pro-backend_pgdata:/var/lib/postgresql/data \
#     -v "$(pwd)":/backup alpine tar czf /backup/pgdata_$(date +%F).tar.gz \
#     -C /var/lib/postgresql data
```

### 12.7 Restauration

```bash
# Restaurer un dump SQL dans la base (base vide au préalable) :
docker compose --env-file .env.docker exec -T db psql -U asadiya -d asadiya_flotte < backup_2026-08-06.sql
```

Pour restaurer un dump **avec les tables déjà présentes**, utilisez
`psql --clean --if-exists` ou créez la base avec `DROP SCHEMA public CASCADE; CREATE SCHEMA public;`
avant l'import. L'application recrée le schéma manquant au démarrage, mais n'efface **jamais**
les données existantes.

### 12.8 Import des données historiques (optionnel)

L'image Docker n'embarque pas `data/db.json` (données clients exclues de l'image).
Pour importer la base JSON legacy sur une base Docker **vide**, montez le fichier :

```bash
docker compose --env-file .env.docker run --rm \
  -v "$(pwd)/data/db.json:/app/data/db.json" app npm run migrate:json
```

### 12.9 Reverse proxy (Nginx)

Le projet est prêt à être servi derrière Nginx (aucun Nginx n'est installé à cette étape) :

1. Réglez `TRUST_PROXY=1` dans `.env.docker` (IP réelle du client pour le rate limiting).
2. Limitez l'exposition publique : remplacez dans `docker-compose.yml`
   `- "${APP_PORT:-4000}:${PORT:-4000}"` par `- "127.0.0.1:${APP_PORT:-4000}:${PORT:-4000}"`
   (le port n'est alors joignable que depuis l'hôte).
3. Configurez Nginx selon `deploy/nginx.conf.example` (proxy vers `127.0.0.1:4000`,
   en-têtes `X-Forwarded-*`, TLS via Let's Encrypt).

### 12.10 Commandes utiles

```bash
docker compose --env-file .env.docker build              # reconstruit l'image
docker compose --env-file .env.docker restart            # redémarre les conteneurs
docker compose --env-file .env.docker logs -f --tail=100 app
docker compose --env-file .env.docker exec -it app sh    # shell dans l'application (utilisateur non root)
docker inspect asadiya-flotte-pro-backend_app --format "{{json .State.Health}}"   # état du HEALTHCHECK
```

### 12.11 Défauts connus / limites Docker

- L'image s'exécute en **non-root** (`appuser`) : tout fichier écrit dans le système de
  fichiers du conteneur y est restreint — les données applicatives vivent dans PostgreSQL.
- `NODE_ENV=production` est appliqué par le Dockerfile **et** par `.env.docker` :
  en cas de doute, c'est la valeur stricte (secret fort + CORS fermé) qui s'applique.
- Le volume `pgdata` est **indispensable** à la persistance : ne lancez jamais `down -v`
  sans sauvegarde.
