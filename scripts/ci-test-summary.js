// ============================================================
// Résumé des tests — CI (Phase 6.4)
//
// Lance `node --test tests/` (découverte ciblée du dossier de tests,
// comme `npm test`) et affiche un résumé compact :
//
//   Tests exécutés / Pass / Fail / Skipped / Durée
//
// Sort non nul si UN SEUL test échoue (ou si le runner échoue).
//
// Usage :  node scripts/ci-test-summary.js
//          npm run test:ci
// ============================================================
const { spawn } = require('node:child_process');

function matchInt(text, re) {
    const m = text.match(re);
    return m ? parseInt(m[1], 10) : 0;
}

const child = spawn(process.execPath, ['--test', '--test-reporter=tap', 'tests/*.test.js'], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
child.stdout.on('data', (d) => { output += d; });
child.stderr.on('data', (d) => { output += d; });

child.on('error', (err) => {
    console.error(`Impossible de lancer node --test : ${err.message}`);
    process.exit(1);
});

child.on('exit', (code) => {
    const pass = matchInt(output, /^# pass (\d+)/m);
    const fail = matchInt(output, /^# fail (\d+)/m);
    const cancelled = matchInt(output, /^# cancelled (\d+)/m);
    const skipped = matchInt(output, /^# skipped (\d+)/m);
    const todo = matchInt(output, /^# todo (\d+)/m);
    const durationMs = matchInt(output, /^# duration_ms (\d+)/m);

    const total = pass + fail + cancelled + skipped + todo;

    console.log('');
    console.log('==========================================');
    console.log('=== Résumé des tests (node --test)      ===');
    console.log('==========================================');
    console.log(`  Tests exécutés : ${total}`);
    console.log(`  Pass           : ${pass}`);
    console.log(`  Fail           : ${fail}`);
    console.log(`  Skipped        : ${skipped + todo}`);
    console.log(`  Durée          : ${(durationMs / 1000).toFixed(1)} s`);
    console.log('==========================================');

    const failures = output.match(/^not ok \d+.*$/gm) || [];
    if (failures.length > 0) {
        console.log('');
        console.log('Échecs :');
        failures.forEach((l) => console.log('  ' + l));
    }

    const runnerFailed = code !== 0;
    if (runnerFailed || fail > 0 || cancelled > 0) {
        console.log('');
        console.log('ÉCHEC : la suite de tests n\'est pas verte.');
        process.exit(1);
    }
    console.log('');
    console.log('SUCCÈS : tous les tests passent.');
    process.exit(0);
});
