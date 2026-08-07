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
| `LOG_LEVEL` | Niveau de journalisation : `debug` \| `info` \| `warn` \| `error` (défaut `info`) |

> **Validation au démarrage (production)** : si `JWT_SECRET` est absent/faible, `CORS_ORIGIN`
> vaut `*` ou est vide, `DATABASE_URL` manque, ou une valeur critique (`PORT`, `JSON_LIMIT`,
> `BCRYPT_ROUNDS`, `JWT_EXPIRES_IN`, `TRIAL_DAYS`, limites de rate limiting, `BILLING_PROVIDER`…)
> est malformée, le serveur **refuse de démarrer** avec un message expliquant chaque variable
> à corriger (voir section 13).

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
│   ├── repositories.js       # Accès aux données (requêtes paramétrées)
│   ├── subscriptions.js      # Plans, abonnements, historique (Phase 3)
│   └── payments.js           # Transactions & événements de paiement (Phase 5.1)
├── middleware/
│   ├── auth.js               # JWT + contrôle des rôles
│   ├── errorHandler.js       # Erreurs centralisées (AppError, codes pg, JSON invalide, 413/415)
│   ├── rateLimit.js          # Rate limiting global API + anti force brute (login/signup)
│   └── subscriptionGuard.js  # Contrôle d'abonnement (lectures OK, écritures bloquées si EXPIRED)
├── services/
│   ├── subscriptions.js      # Logique métier abonnements (statuts, limites, renouvellement)
│   ├── paymentGateway.js     # Interface unique des fournisseurs de paiement (Phase 5.1)
│   └── paymentStateMachine.js# Machine à états des transactions de paiement
├── providers/                # Fournisseurs de paiement (aucun appel réseau, Phase 5.1)
│   ├── mock.js               # Simulateur local (fournisseur par défaut)
│   ├── wave.js               # Préparation Wave (non implémenté -> 501)
│   ├── orangeMoney.js        # Préparation Orange Money (non implémenté -> 501)
│   └── stripe.js             # Préparation Stripe (non implémenté -> 501)
├── routes/                   # Express routers (CRUD via crudFactory.js)
├── scripts/
│   └── migrate-from-json.js  # Import one-time db.json -> PostgreSQL
├── utils/
│   ├── AppError.js
│   ├── asyncHandler.js
│   ├── logger.js             # Journalisation structurée (JSON en production, §13.4)
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
  Depuis la Phase 4.3, Compose définit aussi `NODE_ENV=${NODE_ENV:-production}` par défaut :
  une instance lancée sans `.env.docker` démarre donc en production, jamais en développement.
- Le volume `pgdata` est **indispensable** à la persistance : ne lancez jamais `down -v`
  sans sauvegarde.

### 12.12 Documentation et scripts de mise en production (Phase 6.1)

Le dossier `deploy/` contient la **préparation complète** de la production
(rien n'est installé ni exécuté) : index dans `deploy/README.md`.

- Installation de zéro : `deploy/install.md` — Mise à jour : `deploy/update.md`
- Reverse proxy Nginx complet (HTTP→HTTPS, TLS, gzip, rate limiting) :
  `deploy/nginx.conf.example`
- HTTPS Let's Encrypt + renouvellement automatique : `deploy/https-letsencrypt.md`
- Sauvegarde (avec rotation) / restauration : `deploy/backup.sh`, `deploy/restore.sh`
  + `deploy/backup.md`, `deploy/restore.md` — Rollback : `deploy/rollback.md`
- Vérification automatique lecture seule de la production :
  `./deploy/verify-production.sh`
- Rapport de sécurité infrastructure : `deploy/security-report.md`

### 12.13 Observabilité (Phase 6.2)

L'application expose une **supervision native** (aucune dépendance externe) :

- Endpoints publics (à restreindre au réseau de supervision via nginx) :
  `/api/health`, `/api/health/live`, `/api/health/ready`, `/api/health/details`,
  `/api/metrics`.
- Journalisation structurée en production : ligne JSON par requête avec
  `requestId`, `correlationId`, durée, IP, userAgent, utilisateur et
  organisation (jamais de JWT/mot de passe).
- Compteurs en mémoire : requêtes, erreurs HTTP, requêtes SQL lentes,
  agrégats de paiements (taux de succès, erreurs par fournisseur).
- Documentation complète : `deploy/monitoring.md` — Contrôle lecture seule :
  `./deploy/check-monitoring.sh`
- Variables : `SLOW_REQUEST_THRESHOLD_MS` (500), `SLOW_SQL_THRESHOLD_MS` (1000),
  `PERF_REPORT_INTERVAL_MS` (15 min en production, `0` = désactivé).

## 13. Sécurisation Production (Phase 4.3)

Cette section décrit les protections mises en place pour préparer un déploiement Internet.
Aucune fonctionnalité métier ni aucun design n'ont été modifiés : seules les couches
transversales (HTTP, configuration, API, journaux, Docker) ont été durcies.

### 13.1 Sécurité HTTP (en-têtes)

Le serveur applique des en-têtes de sécurité via **Helmet** (v8) sur **toutes** les réponses :

| En-tête | Valeur | Rôle |
|---------|--------|------|
| `Content-Security-Policy` | `default-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`… | Bloque scripts/styles/frames tiers non autorisés. `'unsafe-eval'` (Alpine.js) et `'unsafe-inline'` (styles Tailwind CDN) restent **volontairement** autorisés : ils sont requis par le frontend. |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` | Force HTTPS pendant 2 ans. ⚠️ Vérifiez que le TLS est bien en place (nginx/Caddy) avant de basculer en production ; `preload` exige une soumission au registre HSTS. |
| `X-Frame-Options` | `DENY` | Interdit l'embarquement en iframe (cohérent avec `frame-ancestors 'none'`). |
| `Referrer-Policy` | `no-referrer` | Aucun référent envoyé aux origines externes. |
| `Permissions-Policy` | `camera=()`, `microphone=()`, `geolocation=()`, `payment=()`, `usb=()`, `notifications=()`, `fullscreen=(self)` | Désactive les API navigateur non nécessaires. |
| `Cross-Origin-Opener-Policy` | `same-origin` | Isole l'origine des fenêtres. |
| `Cross-Origin-Resource-Policy` | `same-origin` | Empêche d'autres origines d'embarquer nos ressources. |
| `X-Content-Type-Options` | `nosniff` | Refuse les réponses MIME ambiguës. |
| `X-Powered-By` | (absent) | Aucune divulgation de la technologie serveur. |

`Cross-Origin-Embedder-Policy` est **désactivé** : il casserait le chargement des CDN
(Tailwind, Alpine, Chart.js) indispensables au frontend.

### 13.2 Variables d'environnement (validation au démarrage)

En `NODE_ENV=production`, `config.js` (`assertProductionConfig()`) valide **toutes** les
variables critiques **avant** d'ouvrir le serveur et **refuse de démarrer** en cas d'erreur.
Le message d'erreur liste chaque variable fautive :

- `JWT_SECRET` : présent, ≥ 32 caractères, non figurant dans la liste des secrets de démo ;
- `CORS_ORIGIN` : présent, non vide, différent de `*` (liste exacte d'origines) ;
- `DATABASE_URL` : obligatoire (aucun défaut local en production) ;
- `PORT` : entier valide (1–65535) ;
- `JWT_EXPIRES_IN` : format valide (`7d`, `24h`, `3600`, …) ;
- `BCRYPT_ROUNDS` : entier entre 4 et 20 ;
- `JSON_LIMIT` : format valide (`15mb`, `1048576`, …) ;
- `TRIAL_DAYS` : entier positif ;
- `TRUST_PROXY` : entier entre 0 et 10 ;
- `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX`, `LOGIN_RATE_LIMIT_WINDOW_MS`,
  `LOGIN_RATE_LIMIT_MAX`, `DB_CONNECTION_TIMEOUT_MS`, `DB_IDLE_TIMEOUT_MS` : entiers positifs ;
- `BILLING_PROVIDER` : `none` \| `wave` \| `orange_money` \| `stripe`.

Test rapide :
```bash
NODE_ENV=production node -e "require('./config'); require('./config').assertProductionConfig()"
```

### 13.3 Protection API

- **Anti-DoS** : `express-rate-limit` sur toutes les routes `/api` (défaut 300 req / 15 min
  par IP, en-têtes `RateLimit-*`).
- **Anti force brute** : limite stricte sur `/api/auth/login` et `/api/auth/signup`
  (défaut 20 échecs / 15 min ; `skipSuccessfulRequests` : un mot de passe correct ne bloque jamais).
  Le comptage par IP exige `TRUST_PROXY=1` derrière nginx/Caddy.
- **Taille des corps** : `express.json({ limit: JSON_LIMIT })` (défaut `15mb`, photos base64).
  Un corps trop grand reçoit un **413** `{ code: "payload_too_large" }`, un JSON invalide un
  **400**, un charset non supporté un **415** — sans jamais fuiter de détail interne.
- **Validation d'entrée** : tous les corps sont validés (`utils/validators.js`) avant écriture.

### 13.4 Journalisation (`utils/logger.js`)

- **Développement / test** : texte lisible horodaté (`[ISO] [INFO] msg champs=...`).
- **Production** : une **ligne JSON par événement** (`{"ts","level","msg",...}`), exploitable
  par un collecteur (Loki, ELK, CloudWatch…). Filtrage par `LOG_LEVEL`.
- Événements journalisés :
  - démarrage / arrêt du serveur (`server.started`, `server.shutdown`) ;
  - **une ligne par requête HTTP** (`http.request` : méthode, chemin, statut, durée, IP) ;
  - connexions / échecs de connexion (`auth.login.success`, `auth.login.failed`) et
    inscriptions (`auth.signup`) ;
  - erreurs PostgreSQL (`db.error`, `db.pool_idle_error`, `db.rollback_failed`) ;
  - erreurs non interceptées (`process.uncaught_exception`, `process.unhandled_rejection`) ;
  - erreurs applicatives 5xx (`http.app_error`, `http.unhandled_error`) ;
  - bascule des abonnements en `EXPIRED` (`subscriptions.marked_expired`).
- **Aucune donnée sensible n'est journalisée** : pas de mot de passe, pas de jeton JWT,
  pas de corps de requête.

### 13.5 Docker (cohérence, santé, non-root)

- `NODE_ENV` par défaut **production** dans `docker-compose.yml` (cohérent avec le Dockerfile) :
  impossible de démarrer une instance de production en mode développement par oubli.
- `init: true` (Tini) : signaux correctement transmis à Node (arrêt propre) et récolte des
  zombies ; `stop_grace_period: 20s` pour laisser fermer les connexions.
- **HEALTHCHECK** sur `GET /api/health` (état `healthy` dans `docker ps`) : vérifie le code
  HTTP **et** le corps `{ "status": "ok" }`.
- Image **non-root** (`appuser`) : aucune élévation de privilèges dans le conteneur.
- `.env` / `.env.*` et `data/` sont exclus de l'image (`.dockerignore`) : les secrets et
  données clients n'y voyagent jamais.

### 13.6 Checklist avant mise en production

1. `openssl rand -hex 32` → `JWT_SECRET` (≥ 32 caractères) dans `.env.docker`.
2. `CORS_ORIGIN` = l'origine publique exacte du frontend (pas `*`).
3. TLS en place (nginx/Caddy) puis `TRUST_PROXY=1` ; restreindre l'exposition du port app
   à `127.0.0.1` (section 12.9).
4. Vérifier `DATABASE_URL` distante et `DB_SSL=true` si la base l'exige.
5. Consulter les logs JSON (`docker compose logs -f app`), `LOG_LEVEL` réglable.
6. Vérifier le HEALTHCHECK : `docker compose ps` doit afficher `healthy`.
7. Sauvegardes PostgreSQL planifiées (`pg_dump`, section 12.6).
8. Lancer `npm test` : toutes les suites (API + sécurité) doivent passer.

## 14. Architecture des paiements (Phase 5.1)

> **Aucune API externe n'est connectée.** Wave, Orange Money et Stripe sont
> préparés mais non implémentés (chaque méthode lève `Provider not implemented`
> et les routes renvoient HTTP 501). Le fournisseur actif par défaut est
> **`mock`** : un simulateur local qui ne fait aucun appel réseau et ne
> nécessite aucune clé API.

### 14.1 Principe

| Couche | Fichiers | Rôle |
|---|---|---|
| Base de données | `db/migrate.js`, `db/payments.js` | Tables `payment_transactions` + `payment_events`, accès et audit |
| Machine à états | `services/paymentStateMachine.js` | Transitions autorisées/refusées entre statuts |
| Interface | `services/paymentGateway.js` | Contrat unique : `createPayment`, `checkPayment`, `cancelPayment`, `refundPayment`, `receiveWebhook` |
| Fournisseurs | `providers/*.js` | Implémentation par fournisseur (mock actif, autres à venir) |
| API | `routes/paymentsGateway.js` | Endpoints REST (simulation) |
| Config | `config.js` | `PAYMENT_PROVIDER`, `PAYMENT_TIMEOUT`, `PAYMENT_WEBHOOK_SECRET`, `WAVE_ENABLED`, `ORANGE_ENABLED`, `STRIPE_ENABLED` |

Le fournisseur est **indépendant du reste du système** : pour brancher un vrai
fournisseur (Phase 5.2), on implémentera uniquement sa classe dans `providers/`
en respectant l'interface, sans toucher aux routes ni à la base.

### 14.2 Tables PostgreSQL

**`payment_transactions`** — une ligne = une tentative de paiement :

| Colonne | Type | Notes |
|---|---|---|
| `id` | SERIAL PK | |
| `organization_id` | FK → organizations | Organisme payant (CASCADE) |
| `subscription_id` | FK → subscriptions | Abonnement concerné (optionnel) |
| `invoice_id` | TEXT | Numéro de facture (généré si absent) |
| `provider` | TEXT | `mock` \| `wave` \| `orange_money` \| `stripe` |
| `transaction_reference` | TEXT UNIQUE | Référence applicative (`pay_...`) |
| `provider_reference` | TEXT | Référence fournie par le fournisseur |
| `amount` / `currency` | NUMERIC / TEXT | Montant + devise (défaut `XOF`) |
| `status` | TEXT (CHECK) | Machine à états (§14.3) |
| `payment_method` | TEXT | `MOBILE_MONEY`, `CARD`, ... |
| `initiated_at` / `completed_at` | TIMESTAMPTZ | Cycle de vie |
| `provider_response` | JSONB | Réponse brute du fournisseur |
| `metadata` | JSONB | Données libres (`planCode`, ...) |

**`payment_events`** — audit trail complet (jamais supprimé) :
`id`, `transaction_id` (FK CASCADE), `event` (CHECK sur les 8 statuts),
`message`, `payload` (JSONB), `created_at`. **Chaque changement** — création,
initiation, traitement, succès, échec, annulation, expiration, remboursement et
**chaque webhook reçu** — écrit automatiquement un événement (transactions
atomiques dans `db/payments.js`).

Index : `organization_id`, `subscription_id`, `status`, `provider`,
`transaction_reference`, `created_at` (transactions) ; `transaction_id`,
`created_at` (événements).

### 14.3 Machine à états

```
CREATED
   │
   ▼
PENDING
   │
   ▼
PROCESSING ──► SUCCESS ──► REFUNDED
   │
   ├──► FAILED
   ├──► CANCELLED
   └──► EXPIRED
```

Transitions **valides** :

| De | Vers |
|---|---|
| `CREATED` | `PENDING`, `CANCELLED`, `EXPIRED` |
| `PENDING` | `PROCESSING`, `CANCELLED`, `EXPIRED` |
| `PROCESSING` | `SUCCESS`, `FAILED`, `CANCELLED`, `EXPIRED` |
| `SUCCESS` | `REFUNDED` |

Toute autre transition est **refusée** (HTTP 409 avec `{ from, to }`).
Les états `FAILED`, `CANCELLED`, `EXPIRED`, `REFUNDED` sont terminaux. Un
webhook redélivré (même statut) est accepté sans erreur et journalisé
(idempotence).

### 14.4 API

Tous les endpoints de gestion exigent un JWT (`/api/auth/login`) ; les
webhooks fournisseurs sont **publics**.

| Méthode | Route | Description |
|---|---|---|
| `POST` | `/api/payments/create` | Initie un paiement (mock : `CREATED → PENDING`). Corps : `{ amount, currency?, provider?, paymentMethod?, subscriptionId?, organizationId?, metadata? }` |
| `GET` | `/api/payments/:id` | Détail + historique complet (`events`) |
| `POST` | `/api/payments/:id/cancel` | Annule (si non terminal) |
| `POST` | `/api/payments/:id/refund` | Rembourse (depuis `SUCCESS`) |
| `GET` | `/api/payments/me` | Transactions de l'organisation connectée |
| `GET` | `/api/payments` | Toutes les transactions (SUPERADMIN) |
| `POST` | `/api/payments/webhook/:provider` | Webhook fournisseur (public) |

Droits : une organisation ne voit que ses propres transactions ; le
SUPERADMIN voit tout et peut créer pour une organisation donnée
(`organizationId` obligatoire pour lui).

**Simulation du cycle complet** (fournisseur `mock`) :

```bash
# 1. Créer une transaction (montant, devise) -> PENDING
curl -X POST http://localhost:4000/api/payments/create \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"amount": 15000, "currency": "XOF", "paymentMethod": "MOBILE_MONEY"}'

# 2. Piloter le fournisseur via son webhook simulé
curl -X POST http://localhost:4000/api/payments/webhook/mock \
  -H "Content-Type: application/json" \
  -d '{"transactionReference": "pay_...", "event": "PROCESSING"}'
curl -X POST http://localhost:4000/api/payments/webhook/mock \
  -H "Content-Type: application/json" \
  -d '{"transactionReference": "pay_...", "event": "SUCCESS"}'
```

**Réponses utiles** :
- `201` création / transition appliquée (objet transaction complet).
- `409` transition de statut invalide (`{ error, conflict: { from, to } }`).
- `501` fournisseur non implémenté (`code: "provider_not_implemented"`).
- `403` fournisseur désactivé (`WAVE_ENABLED=false`, ...).
- `401` webhook sans `x-webhook-secret` valide (quand `PAYMENT_WEBHOOK_SECRET` est configuré).

### 14.5 Configuration

| Variable | Défaut | Rôle |
|---|---|---|
| `PAYMENT_PROVIDER` | `mock` | Fournisseur actif (aucun réel activé par défaut) |
| `PAYMENT_TIMEOUT` | `120000` | Délai avant expiration d'un paiement non complété |
| `PAYMENT_WEBHOOK_SECRET` | *(vide)* | Secret exigé sur les webhooks (≥ 16 caractères en production si un fournisseur réel est activé) |
| `WAVE_ENABLED` / `ORANGE_ENABLED` / `STRIPE_ENABLED` | `false` | Activation des fournisseurs réels (à venir) |

En production, `assertProductionConfig()` refuse un `PAYMENT_PROVIDER`
inconnu, un `PAYMENT_TIMEOUT` invalide, ou un fournisseur réel sans secret de
webhook solide.

### 14.6 Préparation Wave (Phase 5.2)

1. Implémenter `providers/wave.js` : `createPayment` (initiation mobile money),
   `checkPayment`, `cancelPayment`, `refundPayment`, `receiveWebhook`
   (vérification HMAC + idempotence).
2. Renseigner `WAVE_API_URL` / `WAVE_API_SECRET` (déjà présents dans la
   config `billing.wave`), puis `PAYMENT_PROVIDER=wave` et `WAVE_ENABLED=true`.
3. Brancher le webhook Wave sur `POST /api/payments/webhook/wave`.

### 14.7 Préparation Orange Money (Phase 5.2)

1. Implémenter `providers/orangeMoney.js` (même interface).
2. Renseigner `ORANGE_MONEY_API_URL` / `ORANGE_MONEY_CLIENT_ID` /
   `ORANGE_MONEY_CLIENT_SECRET` (config `billing.orangeMoney`), puis
   `PAYMENT_PROVIDER=orange_money` et `ORANGE_ENABLED=true`.
3. Brancher le webhook Orange Money sur `POST /api/payments/webhook/orange_money`.

### 14.8 Préparation Stripe (Phase 5.2)

1. Implémenter `providers/stripe.js` : `PaymentIntent`/`PaymentLink` pour la
   création, `Retrieve` pour le contrôle, `Refund` pour le remboursement,
   `constructEvent` (vérification signature `Stripe-Signature`) pour le webhook.
2. Renseigner `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` (config
   `billing.stripe`), puis `PAYMENT_PROVIDER=stripe` et `STRIPE_ENABLED=true`.
3. Brancher le webhook Stripe sur `POST /api/payments/webhook/stripe`.

### 14.9 Validation des paiements

`npm test` inclut la suite `tests/payments.test.js` : création, historique
(audit), transitions valides/refusées, annulation, remboursement, idempotence
des webhooks, fournisseurs non implémenté (501) / désactivé (403) / inconnu
(400), secret de webhook et contrôle d'accès par organisation.

## 15. Intégration continue (Phase 6.4)

Le projet est couvert par un **pipeline CI/CD** (`GitHub Actions`) qui
s'exécute à chaque `push` / `pull request` sur `main`, `master` et
`develop` :

- **Qualité & tests** : lint ESLint (0 erreur), rapport `npm audit`
  (portail : échec si vulnérabilité critique ou importante), validation
  PostgreSQL **non destructive** (migrations idempotentes, tables + index,
  aucune table supprimée), suite complète `node --test` avec **résumé**
  (tests exécutés / pass / fail / skipped / durée), tests paiements
  (mock, sans réseau).
- **Docker & endpoints** : `docker compose config`, build, démarrage,
  disponibilité de l'API puis validation des endpoints
  (`/api/health*`, `/api/metrics`, `/api/plans/public`, `/api/auth`,
  `/api/payments`) via `deploy/ci-endpoints.sh`.

Toutes ces vérifications se rejouent **localement** (voir
[`docs/ci-cd.md`](docs/ci-cd.md)) :

```bash
npm run lint            # ESLint (0 erreur)
npm run audit:ci        # rapport npm audit + portail
npm run pg:check        # validation PostgreSQL (non destructif)
npm run test:ci         # résumé de toute la suite (77+ tests)
npm run test:payments   # tests paiements (51, sans réseau)
bash deploy/ci-endpoints.sh http://localhost:4000   # 8/8 contrôles
```
