# CI/CD — Pipeline d'intégration continue (Phase 6.4)

Ce document décrit le pipeline d'intégration continue du projet
**Asadiya Flotte PRO — Backend**. Il automatisé les vérifications
de qualité, de sécurité et de déploiement à chaque changement, sans
modifier le code métier, les routes, les fournisseurs ni le frontend.

---

## 1. Vue d'ensemble

| Élément | Valeur |
|---|---|
| Fichier de workflow | `.github/workflows/ci.yml` |
| Déclencheurs | `push` et `pull_request` sur `main`, `master`, `develop` |
| Plateforme | GitHub Actions (`ubuntu-latest`) |
| Runtime Node | v24 (verrouillé via `package-lock.json` + `npm ci`) |
| Base de données | PostgreSQL 16 (service GitHub Actions pour le job `quality` ; service `db` du Compose pour le job `docker`) |
| Secrets | Aucun requis : les secrets de paiement restent vides, fournisseur `mock` |

Le pipeline comporte **deux jobs** :

1. **`quality`** — qualité statique, sécurité des dépendances, base de
   données et suite de tests complète.
2. **`docker`** — validation de l'image, du Compose et des endpoints
   publics (nécessite le job `quality`).

Un **résumé de test** (`npm run test:ci`) donne pour chaque exécution :
Tests exécutés, Pass, Fail, Skipped et Durée.

---

## 2. Job `quality` (étapes)

| Étape | Commande | Critère de réussite |
|---|---|---|
| Checkout + Node 24 + cache npm | GitHub Actions | — |
| Installation | `npm ci` | dépendances verrouillées, aucune vulnérabilité bloquante |
| **Lint ESLint** | `npm run lint` | `0 erreur` (les warnings sont tolérés, `$LASTEXITCODE=0`) |
| **Audit npm** | `npm run audit:ci` | `0` vulnérabilité critique **ou** importante ; rapport modérée/faible affiché |
| **Validation PostgreSQL** | `npm run pg:check` | connexion OK, migrations idempotentes OK, tables et index complets, aucune table supprimée (non destructif) |
| **Suite de tests** | `npm run test:ci` | `77+` tests, `0` échec, résumé affiché |
| **Tests paiements** | `npm run test:payments` | `51` tests (Wave / Orange Money / Stripe / Mock), aucun réseau réel |

La validation PostgreSQL est **non destructive** : elle rejoue
`db/migrate.js` (idempotent, `CREATE ... IF NOT EXISTS`), vérifie que
toutes les tables et tous les index déclarés dans le schéma existent
(la liste est **dérivée automatiquement** du fichier de migration, donc
toujours synchronisée), puis compare la liste des tables avant/après
pour s'assurer qu'aucune n'a été supprimée.

---

## 3. Job `docker` (étapes)

| Étape | Commande | Critère de réussite |
|---|---|---|
| Préparation de l'environnement | `cp .env.docker.example .env.docker` | aucune valeur sensible requise |
| Configuration Compose | `docker compose config --quiet` | fichier valide |
| Build | `docker compose build` | image construite (multi-étages, runtime non-root) |
| Démarrage | `docker compose up -d` | `app` et `db` démarrés |
| État des conteneurs | `docker compose ps` | — |
| Attente de disponibilité | boucle `curl /api/health/live` | l'API répond dans les délais |
| **Validation des endpoints** | `bash deploy/ci-endpoints.sh http://localhost:4000` | `8/8` contrôles (voir § 5) |
| Logs (diagnostic, si échec) | `docker compose logs --tail=50` | — |

---

## 4. Exécution locale des mêmes contrôles

Toutes les vérifications du pipeline se rejouent localement (Windows
PowerShell, ou WSL/Git Bash pour les scripts `.sh`) :

```powershell
npm ci                          # dépendances verrouillées
npm run lint                    # ESLint (0 erreur)
npm run audit:ci                # rapport npm audit + portail
npm run pg:check                # validation PostgreSQL (non destructif)
npm run test:ci                 # résumé de toute la suite (77+ tests)
npm run test:payments           # tests paiements (51, sans réseau)

# Job docker :
docker compose config --quiet
docker compose build
docker compose up -d
docker compose ps
# Attendre que l'API soit prête :
#   Invoke-WebRequest http://localhost:4000/api/health/ready
bash deploy/ci-endpoints.sh http://localhost:4000   # 8/8 contrôles
docker compose down                # arrêt propre après validation
```

> **Note Git Bash** : sur Windows, `bash` par défaut peut pointer vers
> WSL. Utiliser Git Bash explicite si besoin :
> `& "C:\Program Files\Git\bin\bash.exe" deploy/ci-endpoints.sh http://localhost:4000`

---

## 5. Validation des endpoints (`deploy/ci-endpoints.sh`)

Le script reproduit des comportements déjà couverts par la suite de
tests (`tests/api.test.js`, `monitoring.test.js`, `security.test.js`,
`payments.test.js`) :

| Contrôle | Attendu | Réfère le comportement testé |
|---|---|---|
| `GET /api/health` | `200` | liveness/readiness de l'API |
| `GET /api/health/live` | `200` | liveness (processus vivant) |
| `GET /api/health/ready` | `200` | readiness (PostgreSQL + fournisseurs) |
| `GET /api/metrics` | `200` | compteurs de supervision |
| `GET /api/plans/public` | `200` + tableau JSON | catalogue public |
| `POST /api/auth/login` (identifiants invalides) | `401` | refus d'authentification |
| `GET /api/payments` (sans jeton) | `401` | `requireAuth` protège les paiements |
| `GET /api/auth` (route inexistante) | `404` JSON | `notFoundHandler` |

---

## 6. Variables d'environnement

### Job `quality`

| Variable | Valeur en CI | Rôle |
|---|---|---|
| `DATABASE_URL` | `postgres://asadiya:asadiya_ci_password@localhost:5432/asadiya_flotte_test` | connexion au service PostgreSQL |
| `NODE_ENV` | `test` | configuration de test (cache désactivé, validations dev) |

### Job `docker`

Aucune variable spéciale : le Compose utilise `.env.docker.example`
copié tel quel (`NODE_ENV=production`, `PAYMENT_PROVIDER=mock`,
aucun secret de paiement).

### Secrets GitHub

Aucun secret GitHub n'est utilisé. Pour un déploiement réel
(post-phase 6.4), on recommanderait des secrets comme `JWT_SECRET`,
`POSTGRES_PASSWORD`, `PAYMENT_WEBHOOK_SECRET`, `WAVE_API_SECRET`… —
ils ne sont **pas** ajoutés ici par choix (aucun secret réel, aucun
déploiement).

---

## 7. Contraintes respectées

- **Aucune modification du code métier, des routes, des fournisseurs
  ni du frontend**, sauf nécessité documentée :
  - `monitoring/metrics.js` : correctif d'un bug (`path` non
    déstructuré dans `recordRequest`) — nécessaire pour que le
    premier log de requête lente ne plante pas.
  - `Dockerfile` : ajout de `COPY monitoring ./monitoring` — l'image
    n'incluait pas le dossier `monitoring/` (Phase 6.2) et ne pouvait
    donc pas démarrer (`MODULE_NOT_FOUND ../monitoring/metrics`).
- **PostgreSQL** : la validation ne modifie jamais les données
  (migrations idempotentes uniquement, aucune suppression).
- **Paiements** : tests exécutés avec les serveurs simulés existants,
  aucun appel réseau réel.

---

## 8. Débogage du pipeline

- **Un job échoue** : le pipeline s'arrête (le job `docker` dépend de
  `quality`). La capture d'écran/les logs de l'étape fautive montrent
  la commande exacte et sa sortie.
- **Résumé des tests** : `npm run test:ci` affiche un bloc
  `=== Résumé des tests ===` avec le décompte ; en cas d'échec, il
  liste les sous-tests `not ok`.
- **Endpoints** : `deploy/ci-endpoints.sh` affiche `[PASS]`/`[FAIL]`
  par contrôle avec le code HTTP reçu.
- **Conteneur `app` en redémarrage** : `docker compose logs --tail=100 app`
  (le job journalise les 50 dernières lignes en cas d'échec).
- **Régénérer le verrou** : après une modification de `package.json`,
  exécuter `npm install` puis committer `package-lock.json`.

---

## 9. Fichiers liés

- `.github/workflows/ci.yml` — le workflow
- `scripts/ci-test-summary.js` — résumé `node --test`
- `scripts/ci-audit-summary.js` — rapport `npm audit`
- `scripts/ci-pg-check.js` — validation PostgreSQL (non destructif)
- `deploy/ci-endpoints.sh` — validation des endpoints
- `package.json` — scripts `lint`, `audit:ci`, `pg:check`, `test:ci`,
  `test:payments`
