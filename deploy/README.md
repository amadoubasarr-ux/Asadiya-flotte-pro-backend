# deploy/ — Préparation à la mise en production

> Phase 6.1 : **infrastructure préparée, rien n'est installé ni déployé.**
> Tous les fichiers de ce dossier sont des références / scripts à utiliser
> lors de la mise en production réelle.

## Fichiers

| Fichier | Rôle |
|---|---|
| `nginx.conf.example` | Configuration reverse proxy Nginx complète (HTTP→HTTPS, TLS, gzip, rate limiting, en-têtes) |
| `https-letsencrypt.md` | Obtention + renouvellement automatique du certificat Let's Encrypt |
| `install.md` | Installation de zéro sur un serveur (Docker, env, Nginx, HTTPS) |
| `update.md` | Mise à jour d'une version vers la suivante |
| `backup.sh` + `backup.md` | Sauvegarde PostgreSQL avec rotation (14 jours) + procédure |
| `restore.sh` + `restore.md` | Restauration d'un dump (avec confirmation explicite) |
| `rollback.md` | Retour à une version antérieure (code et/ou données) |
| `verify-production.sh` | **Vérification automatique lecture seule** de la production |
| `monitoring.md` + `check-monitoring.sh` | Observabilité (Phase 6.2) : endpoints de supervision, métriques, journalisation, contrôle lecture seule |
| `security-report.md` | Rapport de sécurité infrastructure (Phase 6.1) |
| `ci-cd.md` (dans `docs/`) + `ci-endpoints.sh` | Intégration continue (Phase 6.4) : pipeline GitHub Actions et validation des endpoints — voir `docs/ci-cd.md` |
| `phase-6.4-report.md` | Rapport final de la Phase 6.4 (CI/CD) |

## Démarrage rapide (serveur de production)

```bash
# 1. Sur le serveur : code + env
git clone <depot> /opt/asadiya && cd /opt/asadiya
cp .env.docker.example .env.docker && chmod 600 .env.docker
#   remplir secrets (openssl rand -hex 32) — voir install.md

# 2. Application
docker compose --env-file .env.docker up -d --build

# 3. Vérification
./deploy/verify-production.sh

# 4. Nginx + HTTPS (voir install.md, https-letsencrypt.md)
```

## Aucune action effectuée lors de la Phase 6.1

- ❌ Aucun serveur provisionné
- ❌ Aucun conteneur lancé
- ❌ Aucun paquet installé (nginx, certbot, docker)
- ❌ Aucun domaine acheté / certificat émis
- ❌ Aucun cron / timer systemd configuré
- ✅ Tous les tests existants restent verts (`npm test`)
