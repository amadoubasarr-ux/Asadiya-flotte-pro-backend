# Rapport de sécurité — Phase 4.1 (préparation production)

Date : Août 2026
Périmètre : backend **Asadiya Flotte PRO** (Express 5.2.1, Node.js, PostgreSQL).
Objectif : audit et durcissement de la sécurité **sans modifier les fonctionnalités métier**
ni les écrans (aucun changement d'UI, aucun redesign).

---

## 1. Résumé

| Domaine | Statut avant | Action |
|---------|--------------|--------|
| Exposition de la source (`/config.js`, `/server.js`, `.env`...) | ❌ **Fuite critique** | ✅ Serveur statique restreint + 404 propre |
| Force brute sur la connexion | ❌ Aucune limite | ✅ `loginLimiter` (429 + en-têtes `RateLimit`) |
| Anti-DoS sur l'API | ❌ Aucune limite | ✅ `apiLimiter` global |
| CORS en production | ❌ `*` accepté | ✅ Liste d'origines + refus de `*` au démarrage |
| `JWT_SECRET` par défaut | ❌ Valeur de démo acceptée | ✅ Refus au démarrage si faible/connu |
| Expiration JWT | ⚠️ Codée en dur (`'7d'`) | ✅ `config.jwtExpiresIn` (env `JWT_EXPIRES_IN`) |
| En-têtes HTTP | ⚠️ `X-Powered-By` exposé | ✅ Supprimé |
| `Permissions-Policy` | ❌ Absent (retiré de helmet v8) | ✅ Middleware manuel |
| Adresse IP client derrière proxy | ⚠️ Non gérée | ✅ `TRUST_PROXY` + `app.set('trust proxy')` |
| Validation des entrées | ⚠️ Pas de longueurs max, dates non validées | ✅ Validators durcis |
| Injections SQL | ✅ Déjà sûr (requêtes paramétrées) | — |
| Fuite d'infos dans les erreurs/réponses | ✅ Déjà masquée (`safeUser`, errorHandler) | — |
| Mots de passe | ✅ bcrypt | — |

Toutes les corrections sont couvertes par des tests (`tests/security.test.js`) et la suite
complète passe **14/14** sans régression sur les tests métier existants.

---

## 2. Points déjà sûrs (vérifiés, non modifiés)

- **Injections SQL** : toutes les requêtes (`db/repositories.js`, `db/analytics.js`, services)
  utilisent des requêtes paramétrées (`$1`, `$2`, ...) et des *whitelists* de colonnes
  (`FIELD_MAPS`) pour le tri — aucun risque de `ORDER BY` injectable.
- **Données sensibles dans les réponses API** : `safeUser` exclut `password`/`passwordHash` ;
  `errorHandler` ne renvoie jamais les détails internes (stack, message SQL brut) en dehors
  du développement.
- **Hachage des mots de passe** : bcrypt (10 rounds par défaut, configurable via
  `BCRYPT_ROUNDS` — valeur minimale **10** exigée en production).
- **Identification des échecs de connexion** : message d'erreur générique (401) ne révélant
  pas si le nom d'utilisateur existe.
- **Helmet** : déjà en place (CSP avec `frame-ancestors 'none'`, `nosniff`, HSTS,
  `Referrer-Policy: no-referrer`).

---

## 3. Vulnérabilités corrigées

### 3.1 Fuite critique : tout le répertoire du projet exposé en HTTP

**Problème.** Le serveur statique `express.static(path.join(__dirname))` servait **tout le
projet** : `/config.js`, `/server.js`, `/db/migrate.js`, `/routes/auth.js`,
`/data/db.json` (données clients + hashs), `/tests/...`, `/node_modules/...`, et le
fichier `.env` (si présent dans le dossier). Un attaquant pouvait télécharger la source
complète et les données.

**Correction.** `server.js` sert uniquement une whitelist :
`PUBLIC_STATIC_FILES = ['/index.html', '/app.js', '/landing.html', '/landing.js']`. Tous les autres chemins (y compris les
tentatives de *path traversal* `/%2e%2e/server.js`) retombent sur `notFoundHandler` → 404.

**Vérifié par test** : `Fichiers sensibles du projet non exposés` (liste complète des
fichiers bloqués).

### 3.2 Force brute sur la connexion / inscription

**Problème.** Aucune limite de tentatives : un attaquant pouvait essayer des mots de passe
indéfiniment, à l'infini et sans ralentissement.

**Correction.** `middleware/rateLimit.js` (basé sur `express-rate-limit`) :
- `loginLimiter` sur `POST /api/auth/login` et `POST /api/auth/signup` :
  **20 échecs / 15 min** par IP (`LOGIN_RATE_LIMIT_MAX`, `LOGIN_RATE_LIMIT_WINDOW_MS`).
  `skipSuccessfulRequests: true` → seuls les échecs sont comptés (les bons utilisateurs
  légitimes ne sont jamais bloqués).
- Réponse 429 avec `code: 'login_rate_limited'` et en-têtes standards `RateLimit-*`.

**Vérifié par test** : `Anti force brute` (limite forcée à 5 → 5×401 puis 429, même avec
le bon mot de passe).

### 3.3 Absence de limite globale sur l'API (anti-DoS)

**Correction.** `apiLimiter` appliqué sur `/api` : **300 requêtes / 15 min** par IP
(`RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`). Réponse 429 avec en-têtes `RateLimit-*`.

### 3.4 CORS ouvert à toutes les origines en production

**Problème.** `corsOrigin: '*'` par défaut et utilisé tel quel : n'importe quel site web
malveillant pouvait faire des appels authentifiés (avec un jeton volé) depuis le navigateur
de la victime.

**Correction.**
- `config.corsOrigins` : liste d'origines issue de `CORS_ORIGIN`
  (plusieurs valeurs séparées par des virgules) et normalisée (minuscules, sans `/` final).
- En production : origine non listée → la requête passe **sans en-tête**
  `Access-Control-Allow-Origin` (le navigateur bloque la lecture), via le callback
  `callback(null, false)`.
- En développement : comportement inchangé (`*` réfléchi) pour ne pas gêner le front local.

**Vérifié par test** : `CORS restreint en production` (origine autorisée reçoit l'en-tête,
origine étrangère ne le reçoit pas).

### 3.5 Secrets faibles / connus acceptés

**Problème.** Le serveur démarrait avec `JWT_SECRET=change-moi-en-production-...` :
un attaquant connaissant la valeur de démo pouvait forger des jetons d'administration.

**Correction.** `assertProductionConfig()` exécutée au démarrage quand
`NODE_ENV=production` :
- refuse `JWT_SECRET` absent, < 32 caractères, ou présent dans la liste
  `WEAK_JWT_SECRETS` (`change-moi-...`, `changeme`, `secret`, `password`, ...) ;
- refuse `CORS_ORIGIN=*` ou vide ;
- exige `DATABASE_URL` explicite (pas de valeur par défaut locale).

**Vérifié par test** : `Configuration production`.

### 3.6 Divers

- **`X-Powered-By`** exposé (`Express`) : `app.disable('x-powered-by')`.
- **`Permissions-Policy`** absent : helmet v8 a retiré ce middleware → ajout manuel
  (`camera=(), microphone=(), geolocation=(), payment=(), usb=(), notifications=(), fullscreen=(self)`).
- **Expiration JWT** codée en dur dans `routes/auth.js` : déplacée vers `config.jwtExpiresIn`.
- **Validation des entrées** (`utils/validators.js`) : longueurs maximales par ressource
  (plaque 100, modèle 100, nom 200...), date d'assurance au format `AAAA-MM-JJ` (refusée
  sinon), dates vides `''` (envoyées par le front) acceptées et stockées `NULL`,
  photos plafonnées à 16 Mo, mot de passe 6–128 caractères.
  **Vérifié par test** : `Validation d'entrée` (date invalide → 400, vide → 201/null,
  valide → 201).
- **IP client derrière proxy** : `TRUST_PROXY` (nombre de sauts) appliqué via
  `app.set('trust proxy', config.trustProxy)` pour que le rate limiting identifie la
  vraie IP du client (indispensable derrière nginx/Caddy).

---

## 4. Configuration de production stricte (checklist au démarrage)

Refus de démarrer si `NODE_ENV=production` et :
1. `JWT_SECRET` absent / < 32 caractères / valeur de démonstration connue ;
2. `CORS_ORIGIN` = `*` ou vide (il faut la liste exacte des origines) ;
3. `DATABASE_URL` non défini.

`config.js` exporte `assertProductionConfig()` (appelée dans `server.js` avant l'écoute).

---

## 5. Tests

- `tests/api.test.js` (Phase 3.5, inchangé) : 7/7 ✓
- `tests/security.test.js` (nouveau) : 7/7 ✓
  - configuration de production stricte ;
  - non-exposition des fichiers sensibles ;
  - en-têtes de sécurité (CSP, HSTS, Permissions-Policy, nosniff, pas de X-Powered-By) ;
  - 404 propres sur chemins inconnus et traversées de répertoire ;
  - CORS restreint en production ;
  - validation d'entrée (dates) ;
  - anti force brute.

Commande : `npm test` (chaque fichier lance son propre serveur sur un port dédié, en
`NODE_ENV=test`, base PostgreSQL locale).

---

## 6. Limites connues / recommandations avant mise en ligne

- **Bug fonctionnel préexistant (HORS PÉRIMÈTRE sécurité, à corriger séparément)**
  `GET /api/auth/me` pour un **SUPERADMIN** renvoie `404 Utilisateur introuvable`
  (`safeUser`/`findById` cherchent une organisation dont `organizationId` est nul).
  Les autres rôles sont correctement servis. Ce comportement existait avant la Phase 4.1.
- **Rate limiting en mémoire** : les compteurs sont stockés en mémoire dans le process.
  Avec plusieurs instances derrière un load balancer, chaque instance a son propre
  compteur → prévoir un stockage partagé (Redis) pour une limite stricte globale, ou
  accepter une limite par instance.
- **`TRUST_PROXY`** : ne l'activer (1+) que si l'application est réellement derrière un
  reverse proxy ; sinon quiconque peut forger l'en-tête `X-Forwarded-For`.
- **Génération de `JWT_SECRET`** (à faire sur le serveur) :
  `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
- **HTTPS/TLS** : à terminer au niveau du reverse proxy (HSTS est déjà émis par Helmet).
- **Sauvegarde `data/db.json`** : le fichier n'est plus servi en HTTP, mais reste une
  source de données sensibles sur le disque (le supprimer une fois la migration SQL finale).
- **`npm run migrate:json`** : ne plus l'exécuter en production (une seule fois, sur base vide).

---

## 7. Procédure de mise en production (rappel)

```bash
npm ci --omit=dev
cp .env.example .env
# .env : renseigner DATABASE_URL, JWT_SECRET (aléatoire ≥ 32 car.), CORS_ORIGIN (liste exacte),
#        NODE_ENV=production, TRUST_PROXY (sauf si exposition directe)
npm test          # suite complète 14/14
npm start         # refuse de démarrer si la config prod est invalide
```
