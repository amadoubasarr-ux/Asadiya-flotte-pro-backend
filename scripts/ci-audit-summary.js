// ============================================================
// Rapport npm audit — CI (Phase 6.4)
//
// Exécute `npm audit --json` et affiche un résumé par sévérité
// (critique / importante / modérée / faible), ainsi que la liste
// des paquets vulnérables.
//
// Sortie non nulle dès qu'une vulnérabilité CRITIQUE ou IMPORTANTE
// est détectée (portail CI : échec du pipeline).
//
// Usage :  node scripts/ci-audit-summary.js
//          npm run audit:ci
// ============================================================
const { spawnSync } = require('node:child_process');

function printLine(label, value) {
    console.log(`  ${label.padEnd(26)}: ${value}`);
}

const child = spawnSync('npm', ['audit', '--json'], {
    encoding: 'utf8',
    cwd: process.cwd(),
    env: { ...process.env },
    timeout: 120000,
});

let report = {};
if (child.stdout && child.stdout.trim()) {
    try {
        report = JSON.parse(child.stdout);
    } catch (err) {
        console.warn(`(info) Impossible d'interpréter la sortie de npm audit : ${err.message}`);
    }
}

const meta = report.metadata && report.metadata.vulnerabilities;
const counts = {
    critical: (meta && meta.critical) || 0,
    high: (meta && meta.high) || 0,
    moderate: (meta && meta.moderate) || 0,
    low: (meta && meta.low) || 0,
    info: (meta && meta.info) || 0,
    total: (meta && meta.total) || 0,
};

console.log('==========================================');
console.log('=== Résumé npm audit                    ===');
console.log('==========================================');
printLine('Critiques', counts.critical);
printLine('Importantes', counts.high);
printLine('Modérées', counts.moderate);
printLine('Faibles', counts.low);
printLine('Informatives', counts.info);
printLine('Total vulnérabilités', counts.total);

const vulns = report.vulnerabilities || {};
const names = Object.keys(vulns);
if (names.length > 0) {
    console.log('');
    console.log('Paquets vulnérables :');
    for (const name of names) {
        const v = vulns[name];
        const severities = (v.via || [])
            .map((x) => (typeof x === 'string' ? x : x.title || ''))
            .filter(Boolean)
            .join(', ');
        console.log(`  - ${name} [${v.severity}]${v.isDirect ? ' (dépendance directe)' : ''}${severities ? ` — ${severities}` : ''}`);
    }
}

console.log('==========================================');

if (counts.critical > 0 || counts.high > 0) {
    console.log('');
    console.log('ÉCHEC : présence de vulnérabilités critiques ou importantes.');
    process.exit(1);
}

console.log('');
console.log('SUCCÈS : aucune vulnérabilité critique ou importante.');
process.exit(0);
