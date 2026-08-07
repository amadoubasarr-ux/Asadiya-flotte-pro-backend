# Installation en production — Asadiya Flotte PRO

> Préparation uniquement : ce document décrit la procédure. Aucune
> installation n'est réalisée à cette étape (Phase 6.1).

## Prérequis serveur (Debian/Ubuntu)

- Ubuntu 22.04/24.04 LTS ou Debian 12
- Domaine DNS : `flotte.example.com` → IP publique du serveur (record A)
- Ports ouverts : `80` (HTTP, redirection), `443` (HTTPS), `22` (SSH)
- Docker Engine + plugin compose ≥ 2.20

```bash
# Installer Docker (documentation officielle)
curl -fsSL https://get.docker.com | sh
docker --version && docker compose version
```

## 1. Déposer le code

```bash
sudo mkdir -p /opt/asadiya
sudo chown "$USER" /opt/asadiya
git clone <URL-DU-DEPOT> /opt/asadiya
cd /opt/asadiya
```

## 2. Fichiers d'environnement

```bash
cp .env.docker.example .env.docker
chmod 600 .env.docker
nano .env.docker   # remplir : POSTGRES_PASSWORD, JWT_SECRET, CORS_ORIGIN...
```

Points obligatoires avant le premier démarrage :

| Variable | Règle de production |
|---|---|
| `POSTGRES_PASSWORD` | aléatoire fort, sans caractères d'URL réservés `:@/?#&` |
| `JWT_SECRET` | ≥ 32 caractères : `openssl rand -hex 32` |
| `CORS_ORIGIN` | origines exactes, `*` interdit : `https://flotte.example.com` |
| `NODE_ENV` | `production` (appliqué par défaut par compose) |
| `PAYMENT_PROVIDER` | `mock` tant qu'aucun fournisseur réel n'est configuré |

> Le serveur **refuse de démarrer** en production si `JWT_SECRET` est faible,
> si `CORS_ORIGIN` est `*` ou si `DATABASE_URL` manque (`config.js:200`).

## 3. Limiter l'exposition du port applicatif

`docker-compose.yml` expose le port `4000` sur toutes les interfaces. En
production derrière Nginx, ne l'exposez que sur `127.0.0.1` :

```yaml
    ports:
      - "127.0.0.1:4000:4000"
```

(Nginx sur le même hôte devient alors la seule porte d'entrée publique.)

## 4. Construire et démarrer

```bash
docker compose --env-file .env.docker up -d --build
docker compose --env-file .env.docker ps
```

- `db` : PostgreSQL 16, volume nommé `pgdata` (données persistantes),
  healthcheck `pg_isready`.
- `app` : image multi-étapes, utilisateur non root, `restart: unless-stopped`,
  healthcheck `/api/health`.
- Les **migrations PostgreSQL s'exécutent automatiquement au démarrage**
  (`server.js`) — aucun init-db séparé à lancer.

## 5. Vérifier

```bash
# Vérification automatique (lecture seule) :
./deploy/verify-production.sh

# Vérification manuelle :
curl -s http://127.0.0.1:4000/api/health
# => {"status":"ok"}
```

## 6. Reverse proxy Nginx

```bash
sudo apt install nginx
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/asadiya-flotte
sudo ln -s /etc/nginx/sites-available/asadiya-flotte /etc/nginx/sites-enabled/
# adapter server_name / proxy_pass dans le fichier copié
sudo nginx -t && sudo systemctl reload nginx
```

## 7. HTTPS (Let's Encrypt)

Voir [https-letsencrypt.md](./https-letsencrypt.md). Résumé :

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d flotte.example.com --redirect
# renouvellement automatique testé :
sudo certbot renew --dry-run
```

## 8. Sauvegardes

Voir [backup.md](./backup.md). Mettre en place immédiatement :

```bash
mkdir -p /opt/asadiya/backups
./deploy/backup.sh /opt/asadiya/backups
```

## 9. Contrôle final

```bash
./deploy/verify-production.sh --strict
curl -sI https://flotte.example.com/api/health | head -n1   # HTTP/2 200
```
