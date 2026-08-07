// ============================================================
// Cache TTL natif en mémoire (Phase 6.3 — Performance)
//
// Implémentation volontairement simple et sans dépendance :
//   - aucune librairie externe (pas de Redis / Memcached / node-cache)
//   - TTL mesuré au moment de l'écriture (aucune prolongation à la lecture)
//   - borné en taille (maxEntries) pour garantir une mémoire bornée
//   - compteurs hits/misses pour l'audit (GET /api/metrics reste inchangé)
//
// Usage :
//   const { createTtlCache } = require('../utils/ttlCache');
//   const cache = createTtlCache({ ttlMs: 30000, maxEntries: 500 });
//   let v = cache.get('ma-cle');
//   if (v === undefined) { v = await compute(); cache.set('ma-cle', v); }
//
// La valeur stockée est une copie JSON (défensive) : l'objet renvoyé au
// client ne peut jamais muter l'entrée en cache.
// ============================================================

/**
 * Crée un cache TTL en mémoire.
 * @param {object} [options]
 * @param {number} [options.ttlMs=30000]   Durée de vie par défaut (ms). <= 0 ⇒ set() ne stocke rien.
 * @param {number} [options.maxEntries=500] Nombre maximal d'entrées (éviction FIFO du plus ancien).
 */
function createTtlCache({ ttlMs = 30000, maxEntries = 500 } = {}) {
    const store = new Map();
    const stats = { hits: 0, misses: 0, evictions: 0 };

    function get(key) {
        const entry = store.get(key);
        if (!entry) {
            stats.misses += 1;
            return undefined;
        }
        if (entry.expiresAt <= Date.now()) {
            store.delete(key);
            stats.misses += 1;
            return undefined;
        }
        stats.hits += 1;
        return entry.value;
    }

    function set(key, value, customTtlMs) {
        const ttl = customTtlMs === undefined ? ttlMs : customTtlMs;
        if (ttl <= 0) return;
        // Copie JSON défensive : isole l'entrée en cache des mutations ultérieures.
        const stored = JSON.parse(JSON.stringify(value));
        store.delete(key);
        store.set(key, { value: stored, expiresAt: Date.now() + ttl });
        if (store.size > maxEntries) {
            const oldest = store.keys().next().value;
            if (oldest !== undefined) {
                store.delete(oldest);
                stats.evictions += 1;
            }
        }
    }

    function del(key) {
        store.delete(key);
    }

    function clear() {
        store.clear();
    }

    function snapshot() {
        const total = stats.hits + stats.misses;
        return {
            size: store.size,
            maxEntries,
            ttlMs,
            hits: stats.hits,
            misses: stats.misses,
            evictions: stats.evictions,
            hitRate: total > 0 ? Number(((stats.hits / total) * 100).toFixed(1)) : 0,
        };
    }

    return { get, set, del, clear, snapshot };
}

module.exports = { createTtlCache };
