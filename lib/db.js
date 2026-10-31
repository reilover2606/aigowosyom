"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const { DATA_DIR } = require("./config");

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "worldbuilding.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
    -- Calendar notes. "day" is the civil day number: days since
    -- 1970-01-01 UTC, the same integer the calendar uses internally.
    CREATE TABLE IF NOT EXISTS notes (
        id         INTEGER PRIMARY KEY,
        day        INTEGER NOT NULL,
        title      TEXT,
        body       TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notes_day ON notes (day);

    -- Dictionary.
    CREATE TABLE IF NOT EXISTS languages (
        id         INTEGER PRIMARY KEY,
        slug       TEXT NOT NULL UNIQUE,
        name       TEXT NOT NULL,
        is_proto   INTEGER NOT NULL DEFAULT 0,
        has_gender INTEGER NOT NULL DEFAULT 0,
        notes      TEXT,
        color      TEXT, -- "#rrggbb"; null = default gray
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );

    -- sort_key is the headword with diacritics folded and lowercased.
    CREATE TABLE IF NOT EXISTS words (
        id             INTEGER PRIMARY KEY,
        language_id    INTEGER NOT NULL REFERENCES languages (id),
        headword       TEXT NOT NULL,
        sort_key       TEXT NOT NULL,
        pos            TEXT,
        gender         TEXT CHECK (gender IN ('masculine', 'feminine', 'neuter')),
        pronunciation  TEXT,
        sinographs     TEXT,
        etymology      TEXT,
        inflection_data TEXT, -- reserved for inflection tables
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_words_lang_sort ON words (language_id, sort_key);
    CREATE INDEX IF NOT EXISTS idx_words_headword ON words (language_id, headword);
    CREATE INDEX IF NOT EXISTS idx_words_sort ON words (sort_key);

    CREATE TABLE IF NOT EXISTS senses (
        id         INTEGER PRIMARY KEY,
        word_id    INTEGER NOT NULL REFERENCES words (id) ON DELETE CASCADE,
        position   INTEGER NOT NULL,
        definition TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_senses_word ON senses (word_id, position);

    -- word_id is a dialectal or spelling variant of variant_of_id
    -- (same language).
    CREATE TABLE IF NOT EXISTS word_variants (
        word_id       INTEGER NOT NULL REFERENCES words (id) ON DELETE CASCADE,
        variant_of_id INTEGER NOT NULL REFERENCES words (id) ON DELETE CASCADE,
        kind          TEXT NOT NULL CHECK (kind IN ('dialectal', 'spelling')),
        PRIMARY KEY (word_id, variant_of_id)
    );
    CREATE INDEX IF NOT EXISTS idx_variants_target ON word_variants (variant_of_id);

    -- word_id descends from (or is areally related to) ancestor_id,
    -- which may be in any language.
    CREATE TABLE IF NOT EXISTS word_ancestry (
        word_id     INTEGER NOT NULL REFERENCES words (id) ON DELETE CASCADE,
        ancestor_id INTEGER NOT NULL REFERENCES words (id) ON DELETE CASCADE,
        kind        TEXT NOT NULL CHECK (kind IN ('inherited', 'borrowed', 'areal')),
        note        TEXT,
        PRIMARY KEY (word_id, ancestor_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ancestry_ancestor ON word_ancestry (ancestor_id);

    -- Lore (encyclopedia): categories hold pages; each page is in one category.
    CREATE TABLE IF NOT EXISTS lore_categories (
        id          INTEGER PRIMARY KEY,
        slug        TEXT NOT NULL UNIQUE,
        name        TEXT NOT NULL,
        description TEXT,
        color       TEXT, -- "#rrggbb"; null = default gray
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
    );

    -- body is sanitized HTML; body_text is its plain-text form for search.
    CREATE TABLE IF NOT EXISTS lore_pages (
        id          INTEGER PRIMARY KEY,
        category_id INTEGER NOT NULL REFERENCES lore_categories (id),
        slug        TEXT NOT NULL,
        title       TEXT NOT NULL,
        sort_key    TEXT NOT NULL,
        body        TEXT NOT NULL DEFAULT '',
        body_text   TEXT NOT NULL DEFAULT '',
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        UNIQUE (category_id, slug)
    );
    CREATE INDEX IF NOT EXISTS idx_lore_pages_sort ON lore_pages (category_id, sort_key);

    CREATE VIRTUAL TABLE IF NOT EXISTS lore_fts USING fts5(
        page_id UNINDEXED,
        title,
        body,
        tokenize = 'unicode61 remove_diacritics 2'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS words_fts USING fts5(
        word_id UNINDEXED,
        headword,
        sinographs,
        definitions,
        tokenize = 'unicode61 remove_diacritics 2'
    );
`);

// Databases created before language colors existed.
const languageColumns = db.prepare("PRAGMA table_info(languages)").all().map((c) => c.name);
if (!languageColumns.includes("color")) {
    db.exec("ALTER TABLE languages ADD COLUMN color TEXT");
}

// Lore: system categories (e.g. "eras") and era pages generated from eras.json.
const categoryColumns = db.prepare("PRAGMA table_info(lore_categories)").all().map((c) => c.name);
if (!categoryColumns.includes("system_key")) {
    db.exec("ALTER TABLE lore_categories ADD COLUMN system_key TEXT");
}
const pageColumns = db.prepare("PRAGMA table_info(lore_pages)").all().map((c) => c.name);
if (!pageColumns.includes("era_start_year")) {
    db.exec("ALTER TABLE lore_pages ADD COLUMN era_start_year INTEGER");
}
// Dictionary: a built-in language and the entries generated from eras.json.
const languageCols = db.prepare("PRAGMA table_info(languages)").all().map((c) => c.name);
if (!languageCols.includes("system_key")) {
    db.exec("ALTER TABLE languages ADD COLUMN system_key TEXT");
}
const wordCols = db.prepare("PRAGMA table_info(words)").all().map((c) => c.name);
if (!wordCols.includes("era_start_year")) {
    db.exec("ALTER TABLE words ADD COLUMN era_start_year INTEGER");
}
db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_languages_system
        ON languages (system_key) WHERE system_key IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_words_era
        ON words (era_start_year) WHERE era_start_year IS NOT NULL;
`);

db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_lore_categories_system
        ON lore_categories (system_key) WHERE system_key IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_lore_pages_era
        ON lore_pages (era_start_year) WHERE era_start_year IS NOT NULL;
`);

// Calendar notes can be assigned to a book (a lore page in the Books category).
// Deleting the page just unassigns its notes.
const noteColumns = db.prepare("PRAGMA table_info(notes)").all().map((c) => c.name);
if (!noteColumns.includes("book_id")) {
    db.exec("ALTER TABLE notes ADD COLUMN book_id INTEGER REFERENCES lore_pages (id) ON DELETE SET NULL");
}
db.exec("CREATE INDEX IF NOT EXISTS idx_notes_book ON notes (book_id) WHERE book_id IS NOT NULL");

// Full-text search over calendar notes, kept in step by triggers so the
// calendar code doesn't need to know about it.
db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
        note_id UNINDEXED,
        title,
        body,
        tokenize = 'unicode61 remove_diacritics 2'
    );

    CREATE TRIGGER IF NOT EXISTS notes_fts_insert AFTER INSERT ON notes BEGIN
        INSERT INTO notes_fts (note_id, title, body) VALUES (new.id, COALESCE(new.title, ''), new.body);
    END;

    CREATE TRIGGER IF NOT EXISTS notes_fts_delete AFTER DELETE ON notes BEGIN
        DELETE FROM notes_fts WHERE note_id = old.id;
    END;

    CREATE TRIGGER IF NOT EXISTS notes_fts_update AFTER UPDATE ON notes BEGIN
        DELETE FROM notes_fts WHERE note_id = old.id;
        INSERT INTO notes_fts (note_id, title, body) VALUES (new.id, COALESCE(new.title, ''), new.body);
    END;
`);

// Notes saved before the index existed.
if (
    db.prepare("SELECT COUNT(*) AS n FROM notes").get().n !==
    db.prepare("SELECT COUNT(*) AS n FROM notes_fts").get().n
) {
    db.exec(`
        DELETE FROM notes_fts;
        INSERT INTO notes_fts (note_id, title, body)
            SELECT id, COALESCE(title, ''), body FROM notes;
    `);
}

// Maps. Coordinates are in "map units" (a map is width x height of them, y
// pointing up as in OpenLayers); miles_per_unit gives the scale.
//
// Political states share their borders: every corner of every state is a row
// in map_vertices, and a state's rings list vertex ids (map_states.geometry:
// [ [ outerRing, ...holeRings ], ...one entry per separate piece ]). Two
// states that touch simply use the same vertices along the shared edge, so
// moving a corner moves it for both. Land, lakes and rivers (map_features)
// are independent shapes stored as GeoJSON geometry.
db.exec(`
    CREATE TABLE IF NOT EXISTS maps (
        id             INTEGER PRIMARY KEY,
        slug           TEXT NOT NULL UNIQUE,
        name           TEXT NOT NULL,
        description    TEXT,
        width          REAL NOT NULL DEFAULT 2000,
        height         REAL NOT NULL DEFAULT 1500,
        miles_per_unit REAL NOT NULL DEFAULT 1,
        hidden         INTEGER NOT NULL DEFAULT 0,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS map_features (
        id         INTEGER PRIMARY KEY,
        map_id     INTEGER NOT NULL REFERENCES maps (id) ON DELETE CASCADE,
        kind       TEXT NOT NULL CHECK (kind IN ('land', 'lake', 'river', 'ocean')),
        name       TEXT,
        geometry   TEXT NOT NULL,
        hidden     INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_map_features_map ON map_features (map_id);

    CREATE TABLE IF NOT EXISTS map_vertices (
        id     INTEGER PRIMARY KEY,
        map_id INTEGER NOT NULL REFERENCES maps (id) ON DELETE CASCADE,
        x      REAL NOT NULL,
        y      REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_map_vertices_map ON map_vertices (map_id);

    CREATE TABLE IF NOT EXISTS map_states (
        id         INTEGER PRIMARY KEY,
        map_id     INTEGER NOT NULL REFERENCES maps (id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        color      TEXT,
        label_sans INTEGER NOT NULL DEFAULT 0,
        geometry   TEXT NOT NULL,
        hidden     INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_map_states_map ON map_states (map_id);

    CREATE TABLE IF NOT EXISTS map_points (
        id         INTEGER PRIMARY KEY,
        map_id     INTEGER NOT NULL REFERENCES maps (id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        kind       TEXT NOT NULL DEFAULT 'city',
        x          REAL NOT NULL,
        y          REAL NOT NULL,
        page_id    INTEGER REFERENCES lore_pages (id) ON DELETE SET NULL,
        hidden     INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_map_points_map ON map_points (map_id);

    -- Tracer images: drawn under the map in the editor to trace over. The
    -- files live in DATA_DIR/map-images and are never published.
    CREATE TABLE IF NOT EXISTS map_images (
        id       INTEGER PRIMARY KEY,
        map_id   INTEGER NOT NULL REFERENCES maps (id) ON DELETE CASCADE,
        name     TEXT NOT NULL,
        file     TEXT NOT NULL,
        mime     TEXT NOT NULL,
        x        REAL NOT NULL DEFAULT 0,
        y        REAL NOT NULL DEFAULT 0,
        width    REAL NOT NULL,
        height   REAL NOT NULL,
        opacity  REAL NOT NULL DEFAULT 0.5,
        visible  INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_map_images_map ON map_images (map_id);
`);

// Superstates: a state can be a client (child) of another state. A superstate
// has no shape of its own (geometry '[]'): it is the sum of its clients, and
// it only exists while it has some (lib/maps.js removes it when the last one
// goes).
const stateColumns = db.prepare("PRAGMA table_info(map_states)").all().map((c) => c.name);
if (!stateColumns.includes("parent_id")) {
    db.exec("ALTER TABLE map_states ADD COLUMN parent_id INTEGER REFERENCES map_states (id) ON DELETE SET NULL");
}
db.exec("CREATE INDEX IF NOT EXISTS idx_map_states_parent ON map_states (parent_id) WHERE parent_id IS NOT NULL");

// Status of a client state within its superstate: capital, province (the
// default, stored as NULL), vassal, march or territory.
if (!db.prepare("PRAGMA table_info(map_states)").all().some((c) => c.name === "status")) {
    db.exec("ALTER TABLE map_states ADD COLUMN status TEXT");
}

// Seas and oceans: a named area (a loose outline of the water, whose name is
// shown in its middle, sized to it). Older databases only allow land, lakes
// and rivers in map_features, so the table is rebuilt to allow 'ocean'.
const featureSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'map_features'").pluck().get();
if (featureSql && !featureSql.includes("'ocean'")) {
    db.exec(`
        ALTER TABLE map_features RENAME TO map_features_old;
        CREATE TABLE map_features (
            id         INTEGER PRIMARY KEY,
            map_id     INTEGER NOT NULL REFERENCES maps (id) ON DELETE CASCADE,
            kind       TEXT NOT NULL CHECK (kind IN ('land', 'lake', 'river', 'ocean')),
            name       TEXT,
            geometry   TEXT NOT NULL,
            hidden     INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        INSERT INTO map_features (id, map_id, kind, name, geometry, hidden, created_at, updated_at)
            SELECT id, map_id, kind, name, geometry, hidden, created_at, updated_at FROM map_features_old;
        DROP TABLE map_features_old;
        CREATE INDEX IF NOT EXISTS idx_map_features_map ON map_features (map_id);
    `);
}

// A lore page can belong to a state on a map (the States category).
const pageColumnsForStates = db.prepare("PRAGMA table_info(lore_pages)").all().map((c) => c.name);
if (!pageColumnsForStates.includes("map_state_id")) {
    db.exec("ALTER TABLE lore_pages ADD COLUMN map_state_id INTEGER REFERENCES map_states (id) ON DELETE SET NULL");
}
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_lore_pages_state ON lore_pages (map_state_id) WHERE map_state_id IS NOT NULL");

// "Do not publish": a flag on everything that can be published. Off by
// default, so everything is published unless marked. See lib/publish.js.
for (const table of ["notes", "languages", "words", "lore_categories", "lore_pages", "maps", "map_features", "map_states", "map_points"]) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!columns.includes("hidden")) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0`);
    }
}

module.exports = { db };
