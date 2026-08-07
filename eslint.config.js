// ============================================================
// ESLint — configuration plate-forme (Phase 6.4)
//
// - Flat config (ESLint >= 9) : package.json est en CommonJS,
//   ce fichier exporte donc via module.exports.
// - Projet backend Node.js (CommonJS) : globals node + fetch.
// - NE PAS modifier le code métier : seules quelques règles sont
//   assouplies pour refléter le style existant du dépôt.
//   Lancer `npm run lint` (sans --fix : aucun correctif automatique).
//
// Exclusions : dépendances, données, déploiement, docs, workflow,
// artefacts minifiés et fichiers legacy.
// ============================================================

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
    {
        ignores: [
            'node_modules/',
            'data/',
            'backup_old_json/',
            'coverage/',
            'deploy/',
            'docs/',
            '.github/',
            '.git/',
            '*.min.js',
            '**/vendor/**',
        ],
    },
    js.configs.recommended,
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: {
                ...globals.node,
            },
        },
        rules: {
            // --- Assouplissements adaptés au style existant du dépôt ---
            // Variables/arguments non utilisés : signalés en avertissement
            // (préfixe _ = intentionnellement ignoré), jamais bloquant.
            'no-unused-vars': ['warn', {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
                caughtErrors: 'none',
            }],
            'no-empty': 'warn',
            'no-constant-condition': 'warn',
            'no-fallthrough': 'warn',
            'no-useless-escape': 'warn',
            'no-control-regex': 'off',
            'no-prototype-builtins': 'off',
            'no-async-promise-executor': 'off',
            'no-empty-pattern': 'off',
            'no-unreachable': 'warn',
            // Assignations successives délibérées (ex: rechargement d'un
            // enregistrement après écriture) : heuristique trop bavarde pour
            // ce dépôt, sans bénéfice réel. Désactivée pour ne pas exiger de
            // modification du code métier.
            'no-useless-assignment': 'off',
        },
    },
    // Frontend (app.js) : globals navigateur + librairies externes chargées
    // via CDN (XLSX pour les exports, Chart pour les graphiques). Le fichier
    // n'est pas modifié : seules ses globals sont déclarées.
    {
        files: ['app.js'],
        languageOptions: {
            globals: {
                ...globals.browser,
                XLSX: 'readonly',
                Chart: 'readonly',
            },
        },
    },
];
