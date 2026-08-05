// Store JSON simple, synchrone, sans dépendance native.
// Toutes les données sont chargées en mémoire au démarrage, puis
// réécrites sur disque (data/db.json) à chaque mutation.
// Suffisant pour une flotte de quelques centaines de véhicules/conducteurs.
// Pour un usage à plus grande échelle ou multi-serveur, migrer vers PostgreSQL.

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'db.json');

function load() {
    const raw = fs.readFileSync(DB_PATH, 'utf-8');
    return JSON.parse(raw);
}

let db = load();

function save() {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf-8');
}

function nextId(collection) {
    const items = db[collection];
    if (!items || items.length === 0) return 1;
    return Math.max(...items.map(i => i.id)) + 1;
}

module.exports = {
    // Accès brut (lecture)
    getAll(collection) {
        return db[collection] || [];
    },
    getById(collection, id) {
        return (db[collection] || []).find(item => item.id == id);
    },

    // Création
    create(collection, item) {
        const id = nextId(collection);
        const newItem = { id, ...item };
        db[collection].push(newItem);
        save();
        return newItem;
    },

    // Mise à jour (fusion partielle)
    update(collection, id, changes) {
        const items = db[collection];
        const idx = items.findIndex(i => i.id == id);
        if (idx === -1) return null;
        items[idx] = { ...items[idx], ...changes, id: items[idx].id };
        save();
        return items[idx];
    },

    // Suppression
    remove(collection, id) {
        const items = db[collection];
        const idx = items.findIndex(i => i.id == id);
        if (idx === -1) return false;
        items.splice(idx, 1);
        save();
        return true;
    },

    // Accès direct pour cas particuliers (ex: auth)
    raw() {
        return db;
    },

    reload() {
        db = load();
    }
};
