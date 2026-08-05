# Asadiya Flotte PRO — Backend API

Backend Node.js / Express pour l'application de gestion de flotte **Asadiya Flotte PRO**.
Auto-hébergeable, sans dépendance native à compiler : les données sont stockées dans un
fichier JSON (`data/db.json`), suffisant pour une flotte de quelques centaines de véhicules.
Pour un usage à plus grande échelle, migrer vers PostgreSQL/MySQL (voir section *Aller plus loin*).

## 1. Installation

```bash
cd backend
npm install
cp .env.example .env
# éditez .env et changez JWT_SECRET avant toute mise en production
npm start
```

Le serveur démarre sur **http://localhost:4000** (configurable via `PORT` dans `.env`).

Les données de démonstration sont déjà présentes dans `data/db.json` (identiques à celles
du frontend) : 50 véhicules, 50 conducteurs, 60 entretiens, réservations, signalements,
accidents, pleins de carburant, et 3 comptes utilisateurs.

## 2. Comptes de démonstration

| Rôle          | Identifiant     | Mot de passe |
|---------------|-----------------|--------------|
| Administrateur | `admin`        | `admin123`   |
| Gestionnaire   | `gestionnaire` | `gest123`    |
| Conducteur     | `conducteur`   | `cond123`    |

Les mots de passe sont stockés **hachés** (bcrypt) dans `data/db.json`, jamais en clair.

## 3. Authentification

```
POST /api/auth/login
Body: { "username": "admin", "password": "admin123" }
Réponse: { "token": "<JWT>", "user": { id, username, name, role, title } }
```

Toutes les autres routes exigent l'en-tête :
```
Authorization: Bearer <token>
```
Le token est valable 7 jours.

```
GET /api/auth/me   → renvoie l'utilisateur actuellement connecté (à partir du token)
```

## 4. Ressources disponibles (CRUD REST)

Chaque ressource expose les mêmes verbes :

```
GET    /api/<ressource>        Liste complète
GET    /api/<ressource>/:id    Détail
POST   /api/<ressource>        Création
PUT    /api/<ressource>/:id    Modification
DELETE /api/<ressource>/:id    Suppression
```

| Ressource              | Créer / Modifier         | Supprimer                | Particularités |
|-------------------------|---------------------------|----------------------------|-----------------|
| `/api/vehicles`         | Admin, Gestionnaire       | Admin, Gestionnaire        | — |
| `/api/drivers`          | Admin, Gestionnaire, Conducteur | **Admin uniquement** | Suppression réservée (RH) |
| `/api/reservations`     | Tous les rôles connectés  | Tous les rôles connectés   | **Détection de conflit de planning** (409 si le véhicule est déjà réservé sur le créneau) + `PATCH /api/reservations/:id/approve` |
| `/api/maintenances`     | Admin, Gestionnaire       | Admin, Gestionnaire        | — |
| `/api/incidents`        | Tous les rôles connectés  | Tous les rôles connectés   | — |
| `/api/accidents`        | Tous les rôles connectés  | Tous les rôles connectés   | — |
| `/api/fuel-logs`        | Tous les rôles connectés  | Tous les rôles connectés   | — |

Ces règles reproduisent exactement les permissions déjà définies côté frontend
(`canManageFleet`, `canDeleteDrivers`, etc.).

Les **photos** (véhicules/conducteurs) sont envoyées telles quelles dans le champ `photo`
du JSON (chaîne `data:image/jpeg;base64,...`), exactement comme le frontend les produit déjà
— aucun endpoint d'upload de fichier séparé n'est nécessaire.

### Exemple : créer une réservation

```bash
curl -X POST http://localhost:4000/api/reservations \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"vehicleId":1,"vehicle":"Peugeot 208 (AA-123-BB)","driverId":2,"driver":"Mamadou Ndiaye","start":"2026-08-05 08:00","end":"2026-08-05 18:00","purpose":"Mission Thiès"}'
```

En cas de chevauchement avec une réservation existante sur le même véhicule, l'API renvoie :
```json
HTTP 409
{ "error": "Conflit de planning : ce véhicule est déjà réservé sur ce créneau.", "conflict": { ... } }
```

## 5. Santé du service

```
GET /api/health  → { "status": "ok", "time": "..." }
```

## 6. Frontend inclus (index.html)

Le fichier `index.html` de l'application est **déjà inclus dans ce dossier** et **déjà branché
sur cette API** (authentification JWT, chargement des données, CRUD sur les 7 ressources —
véhicules, conducteurs, réservations, entretiens, signalements, accidents, carburant).
Plus aucune donnée n'est stockée en `localStorage` : tout transite désormais par l'API.

Lancez simplement :
```bash
npm install
npm start
```
puis ouvrez **http://localhost:4000** — l'application est immédiatement fonctionnelle,
avec les mêmes comptes de démonstration.

Si vous servez `index.html` depuis une origine différente du backend (autre port/domaine),
modifiez la constante `apiBaseUrl` en haut du `<script>` du fichier HTML (ex:
`apiBaseUrl: 'https://api.mondomaine.com'`) — par défaut elle est vide, ce qui suppose que
le frontend et l'API sont servis depuis la même origine (cas par défaut ci-dessus).

## 8. Aller plus loin (production)

- **Base de données** : remplacer `data/store.js` par une implémentation PostgreSQL
  (le reste du code — routes, middleware — n'a pas besoin de changer, `store.js` est le
  seul point d'accès aux données).
- **JWT_SECRET** : générez une valeur aléatoire longue (`openssl rand -hex 32`) et ne la
  committez jamais.
- **HTTPS** : à mettre derrière un reverse proxy (nginx, Caddy) avec certificat TLS.
- **CORS** : restreindre `cors()` à l'origine exacte de votre frontend en production.
- **Sauvegardes** : `data/db.json` est le fichier à sauvegarder régulièrement (ou migrer
  vers une vraie base de données pour la fiabilité).

## Structure du projet

```
backend/
├── server.js              # Point d'entrée Express
├── package.json
├── .env.example            # Variables d'environnement (à copier en .env)
├── data/
│   ├── db.json              # "Base de données" JSON (véhicules, conducteurs, etc.)
│   └── store.js             # Accès aux données (get/create/update/remove)
├── middleware/
│   └── auth.js              # Vérification JWT + contrôle des rôles
└── routes/
    ├── auth.js               # POST /login, GET /me
    ├── crudFactory.js         # Générateur de routes CRUD réutilisable
    ├── vehicles.js
    ├── drivers.js
    ├── reservations.js        # + détection de conflits + approbation
    ├── maintenances.js
    ├── incidents.js
    ├── accidents.js
    └── fuel.js
```
