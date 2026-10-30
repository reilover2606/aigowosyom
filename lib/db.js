"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const DATA_DIR = path.join(__dirname, "..", "data");

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

module.exports = { db };
