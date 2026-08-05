// Script à usage unique : crée (ou répare le mot de passe) du compte superadmin
// SANS toucher à aucune autre donnée de votre base (véhicules, conducteurs, clients...).
//
// Utilisation :
//   1. Placez ce fichier dans le même dossier que server.js (dossier "backend/")
//   2. Dans le terminal : node fix-superadmin.js
//   3. Supprimez ce fichier une fois que ça a fonctionné (optionnel)

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, 'data', 'db.json');
const USERNAME = 'superadmin';
const PASSWORD = 'superadmin123';

if (!fs.existsSync(DB_PATH)) {
    console.error('❌ Fichier introuvable :', DB_PATH);
    console.error('   Vérifiez que ce script est bien dans le dossier "backend/".');
    process.exit(1);
}

const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
if (!Array.isArray(db.users)) db.users = [];

const passwordHash = bcrypt.hashSync(PASSWORD, 10);
const existing = db.users.find(u => u.username === USERNAME);

if (existing) {
    existing.passwordHash = passwordHash;
    existing.role = 'SUPERADMIN';
    existing.organizationId = null;
    console.log('✅ Mot de passe du compte "superadmin" réinitialisé.');
} else {
    const nextId = db.users.length ? Math.max(...db.users.map(u => u.id)) + 1 : 1;
    db.users.push({
        id: nextId,
        username: USERNAME,
        passwordHash,
        name: 'Super Administrateur',
        role: 'SUPERADMIN',
        title: 'Administrateur Plateforme',
        organizationId: null
    });
    console.log('✅ Compte "superadmin" créé.');
}

fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
console.log('   Identifiant : superadmin');
console.log('   Mot de passe : superadmin123');
console.log('   (Toutes vos autres données sont intactes.)');
