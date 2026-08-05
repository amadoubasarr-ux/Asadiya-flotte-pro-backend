// Script à usage unique et sûr : migre une base "data/db.json" créée AVANT
// l'ajout du multi-tenant vers le nouveau format.
//
// Ce qu'il fait, sans jamais supprimer ou écraser vos données existantes :
//   1. Crée les collections manquantes (ex: "organizations") si besoin.
//   2. S'il n'existe encore aucune organisation, en crée une par défaut
//      ("Ma Flotte") et y rattache TOUS vos utilisateurs, véhicules,
//      conducteurs, réservations, entretiens, signalements, accidents et
//      pleins de carburant qui n'ont pas encore d'organisation.
//   3. Ne touche à rien qui a déjà une organisation assignée.
//
// Utilisation :
//   1. Placez ce fichier dans le dossier "backend/" (à côté de server.js)
//   2. node fix-database-schema.js
//   3. Redémarrez le serveur (npm start)

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'db.json');
const DEFAULT_ORG_NAME = 'Ma Flotte';

const COLLECTIONS = [
    'organizations', 'users', 'vehicles', 'drivers', 'reservations',
    'maintenances', 'incidents', 'accidents', 'fuelLogs'
];
const DATA_COLLECTIONS = COLLECTIONS.filter(c => c !== 'organizations' && c !== 'users');

if (!fs.existsSync(DB_PATH)) {
    console.error('❌ Fichier introuvable :', DB_PATH);
    process.exit(1);
}

const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));

let createdCollections = [];
for (const key of COLLECTIONS) {
    if (!Array.isArray(db[key])) {
        db[key] = [];
        createdCollections.push(key);
    }
}

let defaultOrg = db.organizations.find(o => o.name === DEFAULT_ORG_NAME);
let orgCreated = false;

const usersNeedingOrg = db.users.filter(u => u.role !== 'SUPERADMIN' && !u.organizationId);
const dataNeedingOrg = {};
let totalDataNeedingOrg = 0;
for (const key of DATA_COLLECTIONS) {
    dataNeedingOrg[key] = db[key].filter(item => !item.organizationId);
    totalDataNeedingOrg += dataNeedingOrg[key].length;
}

if (usersNeedingOrg.length > 0 || totalDataNeedingOrg > 0) {
    if (!defaultOrg) {
        const nextOrgId = db.organizations.length ? Math.max(...db.organizations.map(o => o.id)) + 1 : 1;
        defaultOrg = { id: nextOrgId, name: DEFAULT_ORG_NAME, createdAt: new Date().toISOString() };
        db.organizations.push(defaultOrg);
        orgCreated = true;
    }
    usersNeedingOrg.forEach(u => { u.organizationId = defaultOrg.id; });
    for (const key of DATA_COLLECTIONS) {
        dataNeedingOrg[key].forEach(item => { item.organizationId = defaultOrg.id; });
    }
}

fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');

console.log('=== Rapport de migration ===');
console.log(createdCollections.length ? '✅ Collections créées : ' + createdCollections.join(', ') : '✅ Toutes les collections existaient déjà.');
if (orgCreated) console.log(`✅ Organisation par défaut créée : "${DEFAULT_ORG_NAME}" (id ${defaultOrg.id})`);
if (usersNeedingOrg.length) console.log(`✅ ${usersNeedingOrg.length} utilisateur(s) rattaché(s) :`, usersNeedingOrg.map(u => u.username).join(', '));
for (const key of DATA_COLLECTIONS) {
    if (dataNeedingOrg[key].length) console.log(`✅ ${dataNeedingOrg[key].length} entrée(s) "${key}" rattachée(s) à "${DEFAULT_ORG_NAME}"`);
}
if (!usersNeedingOrg.length && !totalDataNeedingOrg && !orgCreated && !createdCollections.length) {
    console.log('✅ Rien à faire, votre base est déjà à jour.');
}

console.log('\nÉtat final :');
for (const key of COLLECTIONS) {
    console.log('  ', key.padEnd(15), db[key].length);
}
