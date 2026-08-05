# Asadiya Flotte PRO — Backend API

Backend Node.js / Express pour l'application de gestion de flotte **Asadiya Flotte PRO**.
API REST multi-tenant (JWT, rôles ADMIN / MANAGER / DRIVER / SUPERADMIN) alimentée par
**PostgreSQL** (schéma normalisé avec clés étrangères, créé automatiquement au démarrage).

## 1. Prérequis

- Node.js 18+
- PostgreSQL 14+ (local ou distant)

## 2. Installation

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
└── utils/
    ├── AppError.js
    ├── asyncHandler.js
    └── validators.js         # Validation des corps de requête
```

## 11. Production

- `JWT_SECRET` aléatoire ≥ 32 caractères (`openssl rand -hex 32`) — le serveur refuse de
  démarrer sinon.
- `NODE_ENV=production`, `CORS_ORIGIN` = origine exacte du frontend, `DB_SSL=true` si besoin.
- Derrière un reverse proxy TLS (nginx, Caddy) avec arrêt propre (SIGINT/SIGTERM gérés).
- Sauvegardes PostgreSQL régulières (`pg_dump`).
