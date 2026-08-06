# syntax=docker/dockerfile:1

# ============================================================
# Asadiya Flotte PRO — image Docker (production)
# Build multi-étapes : dépendances installées séparément,
# runtime non root, image finale allégée.
# ============================================================

# ---- Étape 1 : installation des dépendances (cache isolé) ----
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Dépendances de production uniquement, sans audit/fund (réduit le bruit du build).
RUN npm ci --omit=dev --no-audit --no-fund

# ---- Étape 2 : image finale (runtime) ----
FROM node:24-alpine AS runtime
# Mode production (config.js l'applique ; .env reste injecté au run par compose).
ENV NODE_ENV=production
ENV PORT=4000
WORKDIR /app

# Utilisateur applicatif non privilégié (compte dédié, pas de droits root).
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Copie des dépendances (étape 1) puis du code source uniquement.
# data/, tests/, .env... sont exclus via .dockerignore (aucune donnée sensible).
COPY --from=deps --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --chown=appuser:appgroup package.json ./
COPY --chown=appuser:appgroup server.js app.js index.html config.js ./
COPY --chown=appuser:appgroup db ./db
COPY --chown=appuser:appgroup middleware ./middleware
COPY --chown=appuser:appgroup routes ./routes
COPY --chown=appuser:appgroup services ./services
COPY --chown=appuser:appgroup utils ./utils
COPY --chown=appuser:appgroup scripts ./scripts

# Passe à l'utilisateur non root pour l'exécution.
USER appuser

EXPOSE 4000

# HEALTHCHECK : GET /api/health via le runtime Node intégré (fetch).
# Vérifie à la fois le code HTTP et le corps { status: "ok" }.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>{if(!r.ok)process.exit(1);return r.json()}).then(d=>process.exit(d&&d.status==='ok'?0:1)).catch(()=>process.exit(1))"

# Les migrations PostgreSQL s'exécutent automatiquement au démarrage (server.js).
CMD ["node", "server.js"]
