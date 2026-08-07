// ============================================================
// Validation PostgreSQL — CI (Phase 6.4)
//
// Vérifie, de façon NON destructive :
//   1. La connexion à la base (DATABASE_URL / config).
//   2. L'application des migrations (idempotentes, CREATE IF NOT
//      EXISTS) — le serveur les joue déjà au démarrage.
//   3. La présence de toutes les tables et tous les index déclarés
//      dans db/migrate.js (la liste est dérivée automatiquement du
//      schéma pour rester toujours synchronisée).
//   4. Qu'aucune table n'a été supprimée pendant les migrations
//      (comparaison de la liste avant/après, "non destructif").
//
// Usage :  node scripts/ci-pg-check.js
//          npm run pg:check
// ============================================================
const { migrate, SCHEMA } = require('../db/migrate');
const { pool, query } = require('../db/pool');

function extractTables() {
    return [...SCHEMA.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)/g)].map((m) => m[1]);
}

function extractIndexes() {
    return [...SCHEMA.matchAll(/CREATE INDEX IF NOT EXISTS\s+(idx_\w+)/g)].map((m) => m[1]);
}

async function listTables() {
    const { rows } = await query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'"
    );
    return new Set(rows.map((r) => r.table_name));
}

async function listIndexes() {
    const { rows } = await query(
        "SELECT indexname FROM pg_indexes WHERE schemaname='public'"
    );
    return new Set(rows.map((r) => r.indexname));
}

(async () => {
    const requiredTables = extractTables();
    const requiredIndexes = extractIndexes();

    console.log('==========================================');
    console.log('=== Validation PostgreSQL (non destructive) ===');
    console.log('==========================================');
    console.log(`  Tables attendues : ${requiredTables.length}`);
    console.log(`  Index attendus    : ${requiredIndexes.length}`);

    // 1. Connexion
    await query('SELECT 1');
    console.log('  1. Connexion à la base ......... OK');

    // 2. Migrations (idempotentes)
    await migrate();
    console.log('  2. Migrations (idempotentes) ... OK');

    // 3. Tables
    const before = await listTables();
    const missingTables = requiredTables.filter((t) => !before.has(t));
    console.log(`  3. Tables présentes ............. ${requiredTables.length - missingTables.length}/${requiredTables.length}`);
    if (missingTables.length > 0) {
        console.log(`     Manquantes : ${missingTables.join(', ')}`);
    }

    // 4. Index
    const idx = await listIndexes();
    const missingIndexes = requiredIndexes.filter((i) => !idx.has(i));
    console.log(`  4. Index présents ............... ${requiredIndexes.length - missingIndexes.length}/${requiredIndexes.length}`);
    if (missingIndexes.length > 0) {
        console.log(`     Manquants : ${missingIndexes.join(', ')}`);
    }

    // 5. Non destructif : re-jouer migrate puis vérifier qu'aucune
    //    table n'a disparu (aucun DROP).
    await migrate();
    const after = await listTables();
    const dropped = [...before].filter((t) => !after.has(t));
    console.log(`  5. Aucune table supprimée ....... ${dropped.length === 0 ? 'OK' : 'ÉCHEC : ' + dropped.join(', ')}`);

    console.log('==========================================');

    if (missingTables.length > 0 || missingIndexes.length > 0 || dropped.length > 0) {
        console.log('ÉCHEC : le schéma PostgreSQL ne correspond pas aux migrations.');
        await pool.end();
        process.exit(1);
    }

    console.log('SUCCÈS : PostgreSQL est prêt et conforme au schéma.');
    await pool.end();
    process.exit(0);
})().catch(async (err) => {
    console.error(`ÉCHEC : ${err.message}`);
    try { await pool.end(); } catch { /* ignore */ }
    process.exit(1);
});
