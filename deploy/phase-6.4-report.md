# Rapport — Phase 6.4 : CI/CD & automatisation

> **Périmètre** : pipeline d'intégration continue complet, qualité
> statique, sécurité des dépendances, validation PostgreSQL et Docker,
> résumé de tests, validation des endpoints, documentation.
>
> **Contrainte** : aucune modification du code métier, des routes, des
> fournisseurs ni du frontend — sauf nécessité strictement documentée
> (§ 4). Aucun secret GitHub réel, aucun déploiement.

---

## 1. Livraisons

| Livrable | Emplacement | Rôle |
|---|---|---|
| Workflow GitHub Actions | `.github/workflows/ci.yml` | Pipeline 2 jobs (`quality`, `docker`) sur push/PR `main`, `master`, `develop` |
| Lint ESLint (flat config) | `eslint.config.js` + `npm run lint` | 0 erreur (warnings préexistants tolérés) |
| Audit npm | `npm run audit:ci` | Rapport par sévérité + **portail** (échec si critique/importante) |
| Validation PostgreSQL | `npm run pg:check` | Connexion, migrations idempotentes, tables + index, **non destructif** |
| Résumé de tests | `npm run test:ci` | Tests exécutés / Pass / Fail / Skipped / Durée |
| Tests paiements isolés | `npm run test:payments` | Wave / Orange Money / Stripe / Mock — sans réseau |
| Validation endpoints | `deploy/ci-endpoints.sh` | 8 contrôles reproduisant les comportements testés |
| Documentation | `docs/ci-cd.md` | Pipeline, exécution locale, débogage |
| README | `README.md` § 15 | Raccourci utilisateur |
| Index `deploy/` | `deploy/README.md` | Référence des livrables 6.4 |

---

## 2. Résultats des validations (exécution réelle)

| Contrôle | Résultat |
|---|---|
| `npm run lint` | **0 erreur**, 10 warnings (préexistants, non bloquants) |
| `npm run audit:ci` | **0 vulnérabilité** (critique / importante / modérée / faible / info) |
| `npm run pg:check` | **OK** — 15/15 tables, 24/24 index, aucune table supprimée |
| `npm run test:ci` | **77/77 pass**, 0 fail, 0 skipped, ~64 s |
| `npm run test:payments` | **51/51 pass**, 0 fail (~44 s) |
| `docker compose config` | valide |
| `docker compose build` | image `asadiya-flotte-pro-backend:latest` construite |
| `docker compose up -d` | `db` healthy, `app` prêt (`/api/health/ready` 200) |
| `deploy/ci-endpoints.sh http://localhost:4000` | **8/8 PASS** |

---

## 3. Corrections apportées (documentées)

### 3.1 `monitoring/metrics.js` — bug `path` non déstructuré

`recordRequest()` référençait `path` sans le déstructurer depuis son
paramètre : le premier log de requête lente aurait levé une exception.
Correctif : signature `{ method, status, durationMs, path: reqPath }`
+ `String(reqPath || '')`. Ce fichier **ne fait pas partie du code
métier** ; l'appelant (`utils/logger.js`) fournit déjà `path: req.path`.

### 3.2 `Dockerfile` — dossier `monitoring/` manquant

L'image n'incluait pas `monitoring/` (introduit en Phase 6.2) :
`utils/logger.js` → `require('../monitoring/metrics')` échouait
(`MODULE_NOT_FOUND`), l'image ne pouvait **pas démarrer**. Ajout de
`COPY monitoring ./monitoring`. Aucun autre module manquant (vérifié
par analyse croisée des `require` dans les dossiers copiés).

---

## 4. Décisions techniques

- **Découverte des tests ciblée** : `node --test tests/*.test.js`
  (l'outil de charge `scripts/load-test.js` correspondait au motif
  `*-test.js` du runner et ne doit pas être exécuté par la suite).
- **Liste tables/index auto-dérivée** : `ci-pg-check.js` parse
  `db/migrate.js` (`SCHEMA`) — toujours synchronisée, aucune liste
  codée en dur.
- **Portail strict sur l'audit** : échec uniquement sur vulnérabilités
  **critiques ou importantes** ; modérées/faibles signalées sans
  bloquer.
- **Fournisseur `mock`** dans le job docker : aucun secret, aucun appel
  réseau réel, conforme aux phases 5.1→5.4.
- **`NODE_ENV=test`** dans le job `quality` (cache désactivé,
  validations dev) ; **`production`** dans le job `docker` (cohérent
  avec le Dockerfile, validation stricte du démarrage).

---

## 5. Non réalisé (par choix / hors périmètre)

- ❌ Aucun secret GitHub réel ajouté (variables de paiement,
  `JWT_SECRET`…) — à configurer par l'utilisateur en cas de
  déploiement réel.
- ❌ Aucun déploiement (pas de serveur, pas de registre d'images).
- ❌ Aucune modification du code métier, des routes, des fournisseurs
  ou du frontend.
- ⏭️ Phase 6.5 non démarrée.
- ⏳ Phase 6.3 (performance/cache) : code appliqué et baseline mesurée ;
  la mesure APRÈS et le rapport `deploy/performance.md` final restent à
  compléter (hors périmètre 6.4, le pipeline 6.4 valide le cache).
