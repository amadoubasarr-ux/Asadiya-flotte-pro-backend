# HTTPS — Let's Encrypt / Certbot — Asadiya Flotte PRO

> **Préparation uniquement** : aucune installation n'est réalisée à cette
> étape (Phase 6.1). Document de référence pour la mise en place du TLS.

## Prérequis

- Domaine `flotte.example.com` pointant (record A) vers l'IP du serveur.
- Ports `80` et `443` ouverts (le port 80 sert à la validation ACME
  **avant** la redirection définitive vers HTTPS).
- Nginx installé et configuré ([install.md](./install.md), étape 6).

## 1. Installation de Certbot

```bash
sudo apt update
sudo apt install certbot python3-certbot-nginx
certbot --version
```

## 2. Obtention du certificat

```bash
# Le plugin --nginx détecte le bloc server_name et configure le TLS
# automatiquement. --redirect ajoute la redirection HTTP -> HTTPS.
sudo certbot --nginx -d flotte.example.com --redirect --email admin@example.com --agree-tos --no-eff-email
```

Ce que ça produit :

- Certificat + clé : `/etc/letsencrypt/live/flotte.example.com/`
  (`fullchain.pem`, `privkey.pem`).
- Modification du bloc `server` Nginx (ajout `listen 443 ssl`, `ssl_certificate`,
  etc.) — le fichier de référence est `deploy/nginx.conf.example`.

## 3. Activation du bloc HTTPS de référence

Après obtention du certificat, décommenter/adapter le serveur HTTPS de
`deploy/nginx.conf.example` (TLSv1.2/1.3, ciphers, HSTS, gzip, cache,
`limit_req` sur `/api/auth/login`) puis :

```bash
sudo nginx -t && sudo systemctl reload nginx
```

## 4. Renouvellement automatique

Certbot installe par défaut un timer systemd. Vérifier :

```bash
systemctl list-timers | grep certbot
# ou
sudo certbot renew --dry-run   # test réel du renouvellement (aucun effet)
```

Les certificats Let's Encrypt durent 90 jours ; le renouvellement tente
automatiquement 30 jours avant expiration. La validation ACME recharge
Nginx via `deploy-hook` automatique (`systemctl reload nginx`) géré par le
package `python3-certbot-nginx`.

## 5. Vérifications finales

```bash
sudo certbot certificates                 # état des certificats
curl -sI https://flotte.example.com/api/health | head -n1   # HTTP/2 200
curl -s  http://flotte.example.com/ -o /dev/null -w '%{http_code}\n'  # 301
# HSTS présent :
curl -sI https://flotte.example.com/api/health | grep -i strict-transport-security
# Note SSL :
curl -s https://www.ssllabs.com/ssltest/analyze.html?d=flotte.example.com -o /dev/null -w '%{http_code}\n'
```

## Rappels

- Ne **jamais** utiliser le certificat en `http://` dans `CORS_ORIGIN` ni
  dans les `*_SUCCESS_URL`/`*_ERROR_URL` des paiements.
- `TRUST_PROXY=1` doit rester activé (l'API lit `X-Forwarded-Proto` pour
  construire des URL HTTPS et retrouver l'IP réelle du client).
- Le bloc HTTP→HTTPS (`return 301`) est à activer **après** le certificat,
  pour éviter une boucle de redirection.
