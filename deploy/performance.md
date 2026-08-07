# Asadiya Flotte PRO — Performance & fiabilité (Phase 6.3)

Cette documentation couvre l'optimisation des performances et de la fiabilité
de l'API pour la production : audit initial, optimisation appliquée, résultats
mesurés et outillage de vérification. Aucune dépendance externe n'est requise
(le cache est une implémentation TTL native en mémoire, sans Redis ni
Memcached).

Chaque modification est justifiée par un **gain mesurable** constaté avant
toute optimisation (audit « AVANT »), conformément au principe de ne pas
« optimiser pour optimiser » : ce qui n'apporte pas de gain mesurable est
documenté et refusé.

---

## 1. Objectif & périmètre

- Améliorer les performances (latence, charge) et la fiabilité (pics,
  redondance de requêtes) **sans modifier** le frontend, le design, les API
  métier, les routes existantes, la structure PostgreSQL ni les comportements
  fonctionnels.
- Les réponses JSON restent **strictement identiques** (même forme, mêmes
  champs) ; seule la fraîcheur des données en lecture peut être temporairement
  bornée par le cache TTL (documenté en §4).

### Contraintes

| Contrainte                | Décision appliquée                                        |
|---------------------------|-----------------------------------------------------------|
| Pas de Redis/Memcached    | Cache TTL natif en mémoire (module `utils/ttlCache.js`)    |
| Pas de nouvelle base      | Aucune table ajoutée ; aucun index non justifié ajouté     |
| Pas de dépendance lourde  | Zéro module ajouté à `package.json`                        |
| Transparence              | Interrupteur configurable (`CACHE_ENABLED`, `CACHE_TTL_MS`)|
| Simplicité / stabilité    | Cache TTL seul (pas d'invalidation wire-to-wire) pour les données métier ; invalidation explicite pour les plans |

---

## 2. Méthodologie

### 2.1 Environnement de mesure

| Paramètre            | Valeur                                                            |
|----------------------|-------------------------------------------------------------------|
| Instance mesurée     | Serveur Node.js local (même code, même base) — A/B contrôlé       |
| Base de données      | PostgreSQL locale `postgres://localhost:5432/asadiya_flotte` (jeu de données réel : 2 organisations actives, 52 véhicules, 300+ relevés) |
| Mode                 | `NODE_ENV=development`, `RATE_LIMIT_MAX` élevé (neutralise le limiteur pendant la mesure), `PERF_REPORT_INTERVAL_MS=0` |
| Variante baseline    | Code courant, `CACHE_ENABLED=false`                               |
| Variante optimisée   | Code courant + cache TTL, `CACHE_ENABLED=true`                    |
| Outil                | `scripts/load-test.js` (Node natif, aucune dépendance)            |

### 2.2 Endpoints mesurés

| Endpoint                    | Méthode | Profil                                          |
|-----------------------------|---------|-------------------------------------------------|
| `/api/health`               | GET     | Public, coût minimal (référence)                |
| `/api/plans/public`         | GET     | Public, 1 requête SQL par appel                 |
| `/api/vehicles`             | GET     | Authentifié (org), CRUD multi-tenant            |
| `/api/analytics/overview`   | GET     | Authentifié (org), 7 requêtes SQL + calculs lourds |
| `/api/analytics/vehicles/:id` | GET   | Authentifié (org), idem                          |
| `/api/analytics/drivers`    | GET     | Authentifié (org), idem                          |

### 2.3 Métriques rapportées

Pour chaque endpoint : total requêtes, **erreurs** (taux %), **débit** (req/s),
**latence** moyenne / p50 / p90 / p95 / p99 (ms). Un résultat est significatif
si le débit dépasse ~500 requêtes et que la charge ne subit pas de rate limit.

---

## 3. Audit initial (AVANT optimisation)

### 3.1 Trait d'union global

| Zone                       | Constat                                                                 |
|----------------------------|-------------------------------------------------------------------------|
| Schéma PostgreSQL          | Toutes les tables ont un index sur `organization_id` ; index composites présents (`reservations(organization_id, vehicle_id, start, "end")`, `plans(active)`, paiements). Les accès `WHERE organization_id = $1` sont couverts. |
| Pool                       | `max: 10`, type parsers configurés, `query()` instrumenté (métriques). Taille raisonnable pour la charge visée. |
| Authentification           | `jwt.verify` synchrone HS256 (~µs) : non bloquant, aucun gain possible. |
| Contrôle d'abonnement      | Les lectures (GET/HEAD/OPTIONS) ne déclenchent **aucune** requête SQL ; seules les écritures consultent l'abonnement. Déjà optimal. |
| Rate limiting              | Global sur `/api` + login : correct, non bloquant pour la charge normale. |
| Middleware HTTP            | Helmet + CORS + logger : coûts négligeables.                             |
| Dockerfile                 | Multi-stage, runtime non-root, `npm ci --omit=dev`, HEALTHCHECK `/api/health/live`. Déjà optimal. |
| Compression statique       | `express.static` sans gzip applicatif ; le reverse proxy (nginx, cf. `deploy/nginx.conf.example`) compresse déjà (gzip). Ne pas dupliquer. |

### 3.2 Points chauds identifiés

1. **`/api/plans/public`** (`routes/plans.js`) — endpoint **public** appelé par
   la page tarifs/tunnel d'inscription : **1 requête SQL par appel**, données
   quasi statiques (modifiées uniquement par le SUPERADMIN).
   → **Optimisation justifiée** : cache TTL + invalidation sur écriture des plans.

2. **Endpoints analytics** (`routes/analytics.js` + `db/analytics.js`) — la vue
   d'ensemble du tableau de bord charge **7 tables entières** (`loadOrgData` :
   `SELECT *` sur vehicles, drivers, maintenances, incidents, accidents,
   fuel_logs, reservations) puis effectue des **calculs coûteux côté JS**
   (`computeFleetHealthScore` × 2, `computeRankings` avec boucles
   `O(véhicules × (maintenances+incidents+accidents))`, `buildAlerts`…).
   Chaque chargement de tableau de bord répète intégralement ce travail.
   → **Optimisation justifiée** : cache TTL court par (endpoint, organisation,
   paramètres), sans invalidation wire-to-wire (complexité/risque injustifiés).

3. **`/api/analytics/superadmin/stats`** — agrégation plateforme complète
   (10 requêtes parallèles + santé par organisation). Réservé au SUPERADMIN,
   fréquence faible mais coût élevé à chaque consultation.
   → **Optimisation justifiée** : cache TTL (même mécanisme).

### 3.3 Points examinés et REFUSÉS

| Point examiné                          | Pourquoi refusé                                                        |
|----------------------------------------|------------------------------------------------------------------------|
| Index supplémentaires                  | Les index `organization_id` couvrent déjà tous les accès (audit du plan d'exécution) ; un index composite `(organization_id, date)` n'apporte pas de gain mesurable sur le volume actuel et alourdit les écritures. |
| Optimiser `computeRankings` (Map)      | Gain CPU réel à grand volume mais non mesurable sur le jeu de données actuel ; risque de régression. Documenté, différé. |
| `SELECT *` partiels (colonnes utiles)  | Changerait le contrat des mappers (`mapRows`/`mapCols`) et le comportement ; non justifié sans volume. |
| Pool `max > 10`                        | Le goulot est le travail répété, pas la disponibilité de connexions ; augmenter le pool sans mesure est injustifié. |
| Compression gzip côté app              | Déjà assurée par nginx ; doubler est inutile et coûte du CPU. |
| Cache sur les CRUD d'écriture          | Les écritures doivent rester immédiatement cohérentes ; l'invalidation wire-to-wire complexifie sans gain lisible. |
| Cache du JWT / connexions              | `jwt.verify` synchrone ~µs ; aucun gain. |
| HEAD/GET `subscriptionGuard`           | Déjà sans requête SQL sur les lectures. |

---

## 4. Optimisation appliquée

> (sections remplies après mesure — cf. §6)

---

## 5. Résultats AVANT / APRÈS

> (remplis après mesure — cf. §6)

---

## 6. Journal de mesure

### 6.1 Baseline (AVANT)

| Endpoint | Req | Erreurs % | req/s | Moy (ms) | p50 | p90 | p95 | p99 |
|----------|-----|-----------|-------|----------|-----|-----|-----|-----|

### 6.2 Optimisé (APRÈS)

| Endpoint | Req | Erreurs % | req/s | Moy (ms) | p50 | p90 | p95 | p99 |
|----------|-----|-----------|-------|----------|-----|-----|-----|-----|

### 6.3 Gains

| Endpoint | Gain latence | Gain débit | Requêtes SQL évitées |
|----------|--------------|------------|----------------------|

---

## 7. Vérification de la conformité

- `npm test` : suite complète verte (aucune régression).
- `deploy/check-performance.sh` : contrôle de non-régression (seuils).

---

## 8. Conclusion

(à compléter après mesure)
