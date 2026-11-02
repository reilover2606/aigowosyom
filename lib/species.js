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
        SELECT p.id, p.title, p.slug, c.system_key AS kind, c.slug AS category_slug
        FROM lore_pages p JOIN lore_categories c ON c.id = p.category_id
        WHERE p.id = ? AND c.system_key IN ('flora', 'fauna')`),
    all: db.prepare(`
        SELECT p.id, p.title, p.slug, c.system_key AS kind, c.slug AS category_slug,
               (SELECT COUNT(*) FROM species_states ss WHERE ss.page_id = p.id) AS states
        FROM lore_pages p JOIN lore_categories c ON c.id = p.category_id
        WHERE c.system_key IN ('flora', 'fauna')
        ORDER BY c.system_key DESC, p.sort_key, p.id`),
    // The species found in a state itself, with how rare each is there.
    inState: db.prepare(`
        SELECT p.id, p.title, p.slug, ss.rarity, c.system_key AS kind, c.slug AS category_slug
        FROM species_states ss
        JOIN lore_pages p ON p.id = ss.page_id
        JOIN lore_categories c ON c.id = p.category_id
        WHERE ss.state_id = ?
        ORDER BY c.system_key DESC, ss.rarity, p.sort_key, p.id`),
    // The species found in the states under a superstate (clients, their clients, ...), state by state.
    inClients: db.prepare(`
        WITH RECURSIVE below(id) AS (
            SELECT id FROM map_states WHERE parent_id = ?
            UNION
            SELECT s.id FROM map_states s JOIN below b ON s.parent_id = b.id
        )
        SELECT p.id, p.title, p.slug, c.system_key AS kind, c.slug AS category_slug,
               s.id AS state_id, s.name AS state_name, ss.rarity
        FROM below
        JOIN map_states s ON s.id = below.id
        JOIN species_states ss ON ss.state_id = s.id
        JOIN lore_pages p ON p.id = ss.page_id
        JOIN lore_categories c ON c.id = p.category_id
        ORDER BY c.system_key DESC, p.sort_key, p.id, ss.rarity, s.name`),
    statesOf: db.prepare(`
        SELECT s.id, s.name, s.parent_id, s.map_id, m.name AS map_name, m.slug AS map_slug, ss.rarity,
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
    link: db.prepare(`
        INSERT INTO species_states (page_id, state_id, rarity) VALUES (?, ?, ?)
        ON CONFLICT (page_id, state_id) DO UPDATE SET rarity = excluded.rarity`),
    unlink: db.prepare("DELETE FROM species_states WHERE page_id = ? AND state_id = ?"),
    setRarity: db.prepare("UPDATE species_states SET rarity = ? WHERE page_id = ? AND state_id = ?")
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

const withLabel = (row) => row && { ...row, rarity_label: RARITY_LABELS[row.rarity] };

function getSpecies(pageId) {
    return stmt.page.get(pageId) || null;
}

// Every species, flora first, with how many states it is found in.
function listSpecies() {
    return stmt.all.all();
}

// The species found in a state itself, with their rarity there.
function speciesIn(stateId) {
    return stmt.inState.all(stateId).map(withLabel);
}

// What a superstate gets from its clients (and theirs): each species found in any of them, with the states it
// is found in and how rare it is in each. A species the superstate lists itself is in speciesIn() as well.
function speciesInClients(stateId) {
    const bySpecies = new Map();
    for (const row of stmt.inClients.all(stateId)) {
        if (!bySpecies.has(row.id)) {
            bySpecies.set(row.id, { id: row.id, title: row.title, slug: row.slug, kind: row.kind, category_slug: row.category_slug, found: [] });
        }
        bySpecies.get(row.id).found.push({ state_id: row.state_id, state_name: row.state_name, rarity: row.rarity, rarity_label: RARITY_LABELS[row.rarity] });
    }
    return [...bySpecies.values()];
}

// The states where a species is found, with the rarity there and the page of each state.
function statesOf(pageId) {
    return stmt.statesOf.all(pageId).map((row) => ({
        id: row.id,
        name: row.name,
        map_id: row.map_id,
        map_name: row.map_name,
        map_slug: row.map_slug,
        is_group: row.clients > 0,
        rarity: row.rarity,
        rarity_label: RARITY_LABELS[row.rarity],
        url: row.page_slug ? `/lore/${row.page_category}/${row.page_slug}` : `/maps/${row.map_slug}?state=${row.id}`
    }));
}

function requireState(stateId) {
    if (!stmt.stateExists.get(stateId)) {
        throw new HttpError(404, "State not found");
    }
}

// Makes a new species (a page in Flora or Fauna, with the given name) and, if a state is given, finds it there
// with the given rarity.
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
    if (stateId !== null) {
        stmt.link.run(pageId, stateId, parseRarity(rarity) || DEFAULT_RARITY);
    }
    return { ...getSpecies(pageId), ...(stateId !== null ? { rarity: parseRarity(rarity) || DEFAULT_RARITY } : {}) };
});

// Finds a species in a state (or changes how rare it is there).
function addToState(pageId, stateId, rarity) {
    if (!getSpecies(pageId)) {
        throw new HttpError(404, "Species not found");
    }
    requireState(stateId);
    stmt.link.run(pageId, stateId, parseRarity(rarity) || DEFAULT_RARITY);
}

function removeFromState(pageId, stateId) {
    stmt.unlink.run(pageId, stateId);
}

// Sets how rare a species is in one state (it has to be found there).
function setRarity(pageId, stateId, rarity) {
    if (stmt.setRarity.run(parseRarity(rarity, { required: true }), pageId, stateId).changes === 0) {
        throw new HttpError(404, "That species isn't found in this state");
    }
}

module.exports = {
    KINDS, RARITY_LABELS, DEFAULT_RARITY, ensureCategories, getSpecies, listSpecies, speciesIn, speciesInClients,
    statesOf, createSpecies, addToState, removeFromState, setRarity
};
