"use strict";

// Flora and fauna. A species is a page in one of two built-in lore categories (Flora, Fauna) with a rarity
// from 1 (common) to 5 (extremely rare), and it can be found in any number of states on the maps (any state,
// a superstate too). The lore page is the species: its text is written in the lore editor, and below it a
// hard-coded section lists the states where it is found. Species are added to states, created, or taken
// out again from the map editor's menu for a selected state.

const { db } = require("./db");
const { HttpError } = require("./http");
const lore = require("./lore");
const { PUBLIC } = require("./config");

const KINDS = {
    flora: {
        key: "flora", slug: "flora", name: "Flora", color: "#2f855a",
        description: "Plants. Each page is a species; the states where it is found are listed below its text and are set on the map, from a selected state."
    },
    fauna: {
        key: "fauna", slug: "fauna", name: "Fauna", color: "#c05621",
        description: "Animals. Each page is a species; the states where it is found are listed below its text and are set on the map, from a selected state."
    }
};

const RARITY_LABELS = { 1: "common", 2: "fairly common", 3: "uncommon", 4: "rare", 5: "extremely rare" };
const DEFAULT_RARITY = 3;

const stmt = {
    categoryByKey: db.prepare("SELECT * FROM lore_categories WHERE system_key = ?"),
    categoryBySlug: db.prepare("SELECT * FROM lore_categories WHERE slug = ?"),
    categoryAdopt: db.prepare("UPDATE lore_categories SET system_key = ? WHERE id = ?"),
    categoryInsert: db.prepare(`
        INSERT INTO lore_categories (slug, name, description, color, system_key, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`),
    page: db.prepare(`
        SELECT p.id, p.title, p.slug, p.rarity, c.system_key AS kind, c.slug AS category_slug
        FROM lore_pages p JOIN lore_categories c ON c.id = p.category_id
        WHERE p.id = ? AND c.system_key IN ('flora', 'fauna')`),
    all: db.prepare(`
        SELECT p.id, p.title, p.slug, p.rarity, c.system_key AS kind, c.slug AS category_slug,
               (SELECT COUNT(*) FROM species_states ss WHERE ss.page_id = p.id) AS states
        FROM lore_pages p JOIN lore_categories c ON c.id = p.category_id
        WHERE c.system_key IN ('flora', 'fauna')
        ORDER BY c.system_key DESC, p.sort_key, p.id`),
    inState: db.prepare(`
        SELECT p.id, p.title, p.slug, p.rarity, c.system_key AS kind, c.slug AS category_slug
        FROM species_states ss
        JOIN lore_pages p ON p.id = ss.page_id
        JOIN lore_categories c ON c.id = p.category_id
        WHERE ss.state_id = ?
        ORDER BY c.system_key DESC, p.rarity, p.sort_key, p.id`),
    statesOf: db.prepare(`
        SELECT s.id, s.name, s.parent_id, s.map_id, m.name AS map_name, m.slug AS map_slug,
               sp.slug AS page_slug, sc.slug AS page_category,
               (SELECT COUNT(*) FROM map_states k WHERE k.parent_id = s.id) AS clients
        FROM species_states ss
        JOIN map_states s ON s.id = ss.state_id
        JOIN maps m ON m.id = s.map_id
        LEFT JOIN lore_pages sp ON sp.map_state_id = s.id
        LEFT JOIN lore_categories sc ON sc.id = sp.category_id
        WHERE ss.page_id = ?
        ORDER BY m.name, s.name`),
    stateExists: db.prepare("SELECT id FROM map_states WHERE id = ?"),
    link: db.prepare("INSERT OR IGNORE INTO species_states (page_id, state_id) VALUES (?, ?)"),
    unlink: db.prepare("DELETE FROM species_states WHERE page_id = ? AND state_id = ?"),
    setRarity: db.prepare("UPDATE lore_pages SET rarity = ?, updated_at = ? WHERE id = ?"),
    pageCategory: db.prepare(`
        SELECT c.system_key AS kind FROM lore_pages p JOIN lore_categories c ON c.id = p.category_id WHERE p.id = ?`)
};

// Creates the built-in Flora and Fauna categories if they are missing (adopting a category the user
// already made with the same slug). Safe to call repeatedly; the public site doesn't write.
function ensureCategories() {
    if (PUBLIC) {
        return;
    }
    for (const kind of Object.values(KINDS)) {
        if (stmt.categoryByKey.get(kind.key)) {
            continue;
        }
        const existing = stmt.categoryBySlug.get(kind.slug);
        if (existing) {
            stmt.categoryAdopt.run(kind.key, existing.id);
        } else {
            const now = Date.now();
            stmt.categoryInsert.run(kind.slug, kind.name, kind.description, kind.color, kind.key, now, now);
        }
    }
}

function parseRarity(value, { required = false } = {}) {
    if (value === undefined || value === null || value === "") {
        if (required) {
            throw new HttpError(400, "Rarity is required (1 to 5)");
        }
        return null;
    }
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 5) {
        throw new HttpError(400, "Rarity is a whole number from 1 (common) to 5 (extremely rare)");
    }
    return n;
}

const decorate = (row) => row && { ...row, rarity: row.rarity || DEFAULT_RARITY, rarity_label: RARITY_LABELS[row.rarity || DEFAULT_RARITY] };

function getSpecies(pageId) {
    return decorate(stmt.page.get(pageId));
}

// Every species, flora first.
function listSpecies() {
    return stmt.all.all().map(decorate);
}

// The species found in a state.
function speciesIn(stateId) {
    return stmt.inState.all(stateId).map(decorate);
}

// The states where a species is found, with the page of each state.
function statesOf(pageId) {
    return stmt.statesOf.all(pageId).map((row) => ({
        id: row.id,
        name: row.name,
        map_id: row.map_id,
        map_name: row.map_name,
        map_slug: row.map_slug,
        is_group: row.clients > 0,
        url: row.page_slug ? `/lore/${row.page_category}/${row.page_slug}` : `/maps/${row.map_slug}?state=${row.id}`
    }));
}

function requireState(stateId) {
    if (!stmt.stateExists.get(stateId)) {
        throw new HttpError(404, "State not found");
    }
}

// Makes a new species (a page in Flora or Fauna, named and with its rarity) and, if a state is given, finds it there.
const createSpecies = db.transaction((kind, name, rarity, stateId = null) => {
    const info = KINDS[kind];
    if (!info) {
        throw new HttpError(400, "A species is flora or fauna");
    }
    if (stateId !== null) {
        requireState(stateId);
    }
    ensureCategories();
    const category = stmt.categoryByKey.get(info.key);
    const pageId = lore.savePage(null, { category_id: category.id, title: name, body: "" });
    stmt.setRarity.run(parseRarity(rarity) || DEFAULT_RARITY, Date.now(), pageId);
    if (stateId !== null) {
        stmt.link.run(pageId, stateId);
    }
    return getSpecies(pageId);
});

function addToState(pageId, stateId) {
    if (!getSpecies(pageId)) {
        throw new HttpError(404, "Species not found");
    }
    requireState(stateId);
    stmt.link.run(pageId, stateId);
}

function removeFromState(pageId, stateId) {
    stmt.unlink.run(pageId, stateId);
}

// Sets a species' rarity (only for pages in Flora or Fauna).
function setRarity(pageId, rarity) {
    if (!getSpecies(pageId)) {
        throw new HttpError(404, "Species not found");
    }
    stmt.setRarity.run(parseRarity(rarity, { required: true }), Date.now(), pageId);
    return getSpecies(pageId);
}

// After a page is saved from the lore editor: a species page keeps (or is given) its rarity.
function afterPageSaved(pageId, data) {
    const category = stmt.pageCategory.get(pageId);
    if (!category || !KINDS[category.kind]) {
        return;
    }
    const given = parseRarity(data && data.rarity);
    const current = stmt.page.get(pageId);
    stmt.setRarity.run(given || (current && current.rarity) || DEFAULT_RARITY, Date.now(), pageId);
}

module.exports = {
    KINDS, RARITY_LABELS, DEFAULT_RARITY, ensureCategories, getSpecies, listSpecies, speciesIn, statesOf,
    createSpecies, addToState, removeFromState, setRarity, afterPageSaved
};
