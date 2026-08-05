// Conversion snake_case <-> camelCase pour faire le pont entre
// les colonnes PostgreSQL et les champs camelCase attendus par le frontend.

function toCamel(key) {
    return key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function toSnake(key) {
    return key.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
}

/** Convertit une ligne PostgreSQL (snake_case) en objet camelCase. */
function mapRow(row) {
    if (!row) return null;
    const out = {};
    for (const [key, value] of Object.entries(row)) {
        out[toCamel(key)] = value;
    }
    return out;
}

/** Convertit une liste de lignes. */
function mapRows(rows) {
    return (rows || []).map(mapRow);
}

module.exports = { toCamel, toSnake, mapRow, mapRows };
