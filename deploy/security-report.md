# Rapport de sécurité — Phase 6.1 (préparation infrastructure de production)

Date : Août 2026
Périmètre : infrastructure de production **Asadiya Flotte PRO** (Docker, Nginx,
HTTPS, variables d'environnement, sauvegardes) — **aucun déploiement réalisé**,
aucune modification du comportement applicatif.
Référence : [SECURITY.md](../SECURITY.md) (rapport applicatif Phase 4.1) — les
mesures applicatives (JWT, CORS, Helmet/CSP, rate limiting, validation, SQL
paramétré) y sont documentées et testées.

---

## 1. Résumé

| Domaine | Statut | Verdict |
|---|---|---|
| JWT | Secret requis ≥ 32 car., refus des valeurs de démo au démarrage | ✅ Sûr |
| CORS | Origines exactes, `*` refusé en production | ✅ Sûr |
| Helmet / CSP | Présents (CSP, HSTS, nosniff, frame-ancestors 'none') | ✅ Sûr |
| Secrets | Jamais commités (`.dockerignore` exclut `.env*`), `.env.docker` 600 | ✅ Sûr |
| Ports | `app` exposé sur toutes interfaces par défaut | ⚠️ Restreindre à `127.0.0.1` |
| Docker | Multi-étapes, non-root, HEALTHCHECK, volume, restart, réseau dédié | ✅ Sûr |
| Nginx | Reverse proxy seul point d'entrée, TLS, rate limiting, en-têtes | ✅ Prêt (à activer) |
| HTTPS | Procédure Let's Encrypt/Certbot documentée, renouvellement auto | ✅ Prêt (à exécuter) |

---

## 2. JWT, CORS, Helmet/CSP (rappel — déjà durcis et testés en Phase 4.1)

- **JWT** : `config.js:200` `assertProductionConfig()` refuse de démarrer si
  `JWT_SECRET` est absent, < 32 caractères ou dans `WEAK_JWT_SECRETS`.
  Expiration via `JWT_EXPIRES_IN` (défaut `7d`). Vérifié par
  `tests/security.test.js`.
- **CORS** : liste d'origines exactes (`CORS_ORIGIN`, séparées par virgules),
  normalisées (minuscules, sans `/` final). En production une origine non
  listée ne reçoit **aucun** en-tête `Access-Control-Allow-Origin`.
- **Helmet** : CSP (`frame-ancestors 'none'`, restrictif), HSTS,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `Permissions-Policy` manuel (camera/mic/geolocation/payment/usb/notifications
  interdits), `X-Powered-By` supprimé.

## 3. Secrets

- `.dockerignore` exclut `.env*`, `data/`, `tests/`, `deploy/`, `*.md`,
  `docker-compose.yml`, `Dockerfile` : **aucune donnée sensible dans l'image**.
- `.env.production.example` et `.env.docker.example` ne contiennent **aucun
  secret** (placeholders `REMPLACER`/vides).
- Les fichiers `.env` réels ne sont jamais suivis par git (`git status` à
  vérifier) ; permissions recommandées `600`.
- Les scripts de vérification (`verify-production.sh`) n'affichent **jamais**
  les valeurs des secrets — uniquement présent/absent.

## 4. Ports

- `docker-compose.yml:106` expose `4000` sur toutes les interfaces
  (`"${APP_PORT:-4000}:${PORT:-4000}"`).
- **Recommandation (documentée, non appliquée automatiquement)** : restreindre
  à `127.0.0.1:4000:4000` lorsque Nginx est sur le même hôte — Nginx devient
  la seule porte d'entrée publique (voir `deploy/install.md` étape 3 et
  `deploy/nginx.conf.example`).
- PostgreSQL n'expose **aucun port** sur l'hôte (service `db` interne au
  réseau `asadiya_net` uniquement).

## 5. Docker

| Élément | État |
|---|---|
| Build multi-étapes (`deps` + `runtime`) | ✅ `Dockerfile:9-20` |
| Utilisateur non root (`appuser`) | ✅ `Dockerfile:24,39-40` |
| `npm ci --omit=dev` (aucune dépendance dev en prod) | ✅ `Dockerfile:14` |
| HEALTHCHECK `/api/health` | ✅ `Dockerfile:46-47` |
| `init: true` (Tini PID 1) + `stop_grace_period` | ✅ `docker-compose.yml:46-48` |
| `restart: unless-stopped` | ✅ `docker-compose.yml:19,43` |
| Volume nommé `pgdata` | ✅ `docker-compose.yml:26,116-118` |
| Réseau dédié `asadiya_net` | ✅ `docker-compose.yml:107-113` |
| Healthcheck DB (`pg_isready -h 127.0.0.1`) | ✅ `docker-compose.yml:29-37` |
| `depends_on: db: condition: service_healthy` | ✅ `docker-compose.yml:49-53` |
| Migrations automatiques au démarrage | ✅ (documenté dans `server.js`) |

## 6. Nginx

- Config de référence complète fournie : `deploy/nginx.conf.example`.
- HTTP→HTTPS (`return 301`), TLSv1.2/1.3, HSTS, `nosniff`, `X-Frame-Options`,
  `Referrer-Policy` en défense en profondeur (Helmet reste la couche
  applicative).
- `limit_req` sur `POST /api/auth/login` en complément du rate limiting
  applicatif.
- `client_max_body_size 15m` aligné sur `JSON_LIMIT=15mb` (photos base64).
- gzip + en-têtes de proxy standards (`X-Forwarded-*`, websocket prêt).
- ⚠️ À exécuter lors de la mise en production : `nginx -t` avant chaque reload.

## 7. HTTPS

- Procédure documentée (`deploy/https-letsencrypt.md`) : Certbot + plugin
  `--nginx`, renouvellement automatique (timer systemd), `renew --dry-run`.
- Ne jamais activer la redirection 301 avant d'avoir le certificat.
- `TRUST_PROXY=1` requis pour que l'API voie l'IP réelle et construise des
  URL HTTPS.

## 8. Sauvegardes

- Script `deploy/backup.sh` : dump `pg_dump --format=custom --compress=9`,
  rotation `KEEP=14`, permissions `600`, refus de sauvegarde vide.
- Script `deploy/restore.sh` : confirmation explicite, `pg_restore --clean
  --if-exists --no-owner`, redémarrage `app`.
- Documentation complète : `deploy/backup.md`, `deploy/restore.md`.
- ⚠️ Aucun cron installé volontairement (préparation uniquement).

## 9. Points d'attention avant mise en production

1. **Boucler HTTPS** et restreindre le port `app` à `127.0.0.1`.
2. **Générer** des secrets réels (`openssl rand -hex 32` pour `JWT_SECRET`,
   mots de passe Postgres) — aucun secret ne doit rester par défaut.
3. **Fichiers `.env` non suivis** : vérifier `git status` avant chaque push.
4. Bug fonctionnel préexistant documenté en Phase 4.1 :
   `GET /api/auth/me` pour un SUPERADMIN → 404 (à corriger séparément,
   hors périmètre infrastructure).
5. Rate limiting en mémoire (par instance) : acceptable en mono-instance ;
   prévoir Redis si scale-out.

## 10. Vérifications à rejouer à la mise en production

```bash
./deploy/verify-production.sh --strict
sudo nginx -t
sudo certbot renew --dry-run
npm test   # suite complète (aucune régression)
```
