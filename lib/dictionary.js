"use strict";

// Dictionary data access shared by the editor API and the public pages.

const { db } = require("./db");
const { HttpError } = require("./http");

const GENDERS = ["masculine", "feminine", "neuter"];
const VARIANT_KINDS = ["dialectal", "spelling"];
const ANCESTRY_KINDS = ["inherited", "borrowed", "areal"];

const RESERVED_SLUGS = ["editor", "search", "api"];
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

// Lowercases and strips combining diacritics (macrons, acutes, ...),
// so "Hiūnmoin" and "hiunmoin" compare equal. Only the Combining
// Diacritical Marks block is stripped, so kana voicing marks survive.
function fold(text) {
    return text
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .normalize("NFC")
        .toLowerCase();
}

const stmt = {
    languages: db.prepare(`
        SELECT l.*, (SELECT COUNT(*) FROM words WHERE language_id = l.id) AS word_count
        FROM languages l
        ORDER BY l.name COLLATE NOCASE
    `),
    languageById: db.prepare("SELECT * FROM languages WHERE id = ?"),
    languageBySlug: db.prepare("SELECT * FROM languages WHERE slug = ?"),
    languageInsert: db.prepare(`
        INSERT INTO languages (slug, name, is_proto, has_gender, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    languageUpdate: db.prepare(`
        UPDATE languages SET slug = ?, name = ?, is_proto = ?, has_gender = ?, notes = ?, updated_at = ?
        WHERE id = ?
    `),
    languageDelete: db.prepare("DELETE FROM languages WHERE id = ?"),
    languageWordCount: db.prepare("SELECT COUNT(*) AS n FROM words WHERE language_id = ?"),

    wordById: db.prepare(`
        SELECT w.*, l.slug AS language_slug, l.name AS language_name,
               l.is_proto AS language_is_proto, l.has_gender AS language_has_gender
        FROM words w JOIN languages l ON l.id = w.language_id
        WHERE w.id = ?
    `),
    wordsByHeadword: db.prepare(`
        SELECT id FROM words WHERE language_id = ? AND headword = ? ORDER BY id
    `),
    wordsBySortKey: db.prepare(`
        SELECT w.id, w.headword, w.pos, l.slug AS language_slug, l.name AS language_name
        FROM words w JOIN languages l ON l.id = w.language_id
        WHERE w.language_id = ? AND w.sort_key = ?
        ORDER BY w.headword, w.id LIMIT 20
    `),
    wordsSameHeadword: db.prepare(`
        SELECT DISTINCT l.slug AS language_slug, l.name AS language_name
        FROM words w JOIN languages l ON l.id = w.language_id
        WHERE w.headword = ? AND w.language_id != ?
        ORDER BY l.name COLLATE NOCASE
    `),
    wordExists: db.prepare(`
        SELECT 1 FROM words w JOIN languages l ON l.id = w.language_id
        WHERE l.slug = ? AND w.headword = ? LIMIT 1
    `),
    wordInsert: db.prepare(`
        INSERT INTO words (language_id, headword, sort_key, pos, gender, pronunciation,
                           sinographs, etymology, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    wordUpdate: db.prepare(`
        UPDATE words SET headword = ?, sort_key = ?, pos = ?, gender = ?, pronunciation = ?,
                         sinographs = ?, etymology = ?, updated_at = ?
        WHERE id = ?
    `),
    wordDelete: db.prepare("DELETE FROM words WHERE id = ?"),

    senses: db.prepare("SELECT definition FROM senses WHERE word_id = ? ORDER BY position"),
    senseInsert: db.prepare("INSERT INTO senses (word_id, position, definition) VALUES (?, ?, ?)"),
    senseDelete: db.prepare("DELETE FROM senses WHERE word_id = ?"),

    variantOf: db.prepare(`
        SELECT v.kind, w.id, w.headword, l.slug AS language_slug, l.name AS language_name,
               l.is_proto AS language_is_proto
        FROM word_variants v
        JOIN words w ON w.id = v.variant_of_id
        JOIN languages l ON l.id = w.language_id
        WHERE v.word_id = ? ORDER BY w.sort_key
    `),
    variantForms: db.prepare(`
        SELECT v.kind, w.id, w.headword, l.slug AS language_slug, l.name AS language_name,
               l.is_proto AS language_is_proto
        FROM word_variants v
        JOIN words w ON w.id = v.word_id
        JOIN languages l ON l.id = w.language_id
        WHERE v.variant_of_id = ? ORDER BY w.sort_key
    `),
    variantInsert: db.prepare(
        "INSERT INTO word_variants (word_id, variant_of_id, kind) VALUES (?, ?, ?)"
    ),
    variantDelete: db.prepare("DELETE FROM word_variants WHERE word_id = ?"),

    ancestors: db.prepare(`
        SELECT a.kind, a.note, w.id, w.headword, l.slug AS language_slug,
               l.name AS language_name, l.is_proto AS language_is_proto
        FROM word_ancestry a
        JOIN words w ON w.id = a.ancestor_id
        JOIN languages l ON l.id = w.language_id
        WHERE a.word_id = ? ORDER BY l.name COLLATE NOCASE, w.sort_key
    `),
    descendants: db.prepare(`
        SELECT a.kind, a.note, w.id, w.headword, l.slug AS language_slug,
               l.name AS language_name, l.is_proto AS language_is_proto
        FROM word_ancestry a
        JOIN words w ON w.id = a.word_id
        JOIN languages l ON l.id = w.language_id
        WHERE a.ancestor_id = ? ORDER BY l.name COLLATE NOCASE, w.sort_key
    `),
    ancestryInsert: db.prepare(
        "INSERT INTO word_ancestry (word_id, ancestor_id, kind, note) VALUES (?, ?, ?, ?)"
    ),
    ancestryDelete: db.prepare("DELETE FROM word_ancestry WHERE word_id = ?"),

    ftsDelete: db.prepare("DELETE FROM words_fts WHERE word_id = ?"),
    ftsInsert: db.prepare(`
        INSERT INTO words_fts (word_id, headword, sinographs, definitions)
        SELECT w.id, w.headword, COALESCE(w.sinographs, ''),
               COALESCE((SELECT group_concat(definition, ' ') FROM senses WHERE word_id = w.id), '')
        FROM words w WHERE w.id = ?
    `)
};

const GLOSS_SQL =
    "(SELECT definition FROM senses WHERE word_id = w.id ORDER BY position LIMIT 1)";

// ------------------------------------------------------
// Languages
// ------------------------------------------------------

function listLanguages() {
    return stmt.languages.all();
}

function getLanguage(id) {
    return stmt.languageById.get(id);
}

function getLanguageBySlug(slug) {
    return stmt.languageBySlug.get(slug);
}

function text(value, label, max) {
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value !== "string") {
        throw new HttpError(400, `${label} must be text`);
    }
    const trimmed = value.trim();
    if (trimmed.length > max) {
        throw new HttpError(400, `${label} is too long`);
    }
    return trimmed || null;
}

function parseLanguage(data) {
    if (!data || typeof data !== "object") {
        throw new HttpError(400, "Invalid language");
    }

    const slug = text(data.slug, "Slug", 40);
    if (!slug || !SLUG_PATTERN.test(slug) || RESERVED_SLUGS.includes(slug)) {
        throw new HttpError(
            400,
            "Slug must use lowercase letters, digits and hyphens, and not be a reserved word " +
                `(${RESERVED_SLUGS.join(", ")})`
        );
    }

    const name = text(data.name, "Name", 100);
    if (!name) {
        throw new HttpError(400, "Language name is required");
    }

    return {
        slug,
        name,
        isProto: data.is_proto ? 1 : 0,
        hasGender: data.has_gender ? 1 : 0,
        notes: text(data.notes, "Notes", 5000)
    };
}

function uniqueSlugGuard(fn) {
    try {
        return fn();
    } catch (error) {
        if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
            throw new HttpError(409, "A language with that slug already exists");
        }
        throw error;
    }
}

function createLanguage(data) {
    const lang = parseLanguage(data);
    const now = Date.now();
    const info = uniqueSlugGuard(() =>
        stmt.languageInsert.run(
            lang.slug, lang.name, lang.isProto, lang.hasGender, lang.notes, now, now
        )
    );
    return getLanguage(info.lastInsertRowid);
}

function updateLanguage(id, data) {
    const lang = parseLanguage(data);
    const info = uniqueSlugGuard(() =>
        stmt.languageUpdate.run(
            lang.slug, lang.name, lang.isProto, lang.hasGender, lang.notes, Date.now(), id
        )
    );
    if (info.changes === 0) {
        throw new HttpError(404, "Language not found");
    }
    return getLanguage(id);
}

function deleteLanguage(id) {
    if (!getLanguage(id)) {
        throw new HttpError(404, "Language not found");
    }
    if (stmt.languageWordCount.get(id).n > 0) {
        throw new HttpError(
            409,
            "This language still has words. Delete them first."
        );
    }
    stmt.languageDelete.run(id);
}

// ------------------------------------------------------
// Words
// ------------------------------------------------------

// A word with its senses and all related words.
function loadWord(id) {
    const word = stmt.wordById.get(id);

    if (!word) {
        return null;
    }

    word.senses = stmt.senses.all(id).map((row) => row.definition);
    word.variantOf = stmt.variantOf.all(id);
    word.variantForms = stmt.variantForms.all(id);
    word.ancestors = stmt.ancestors.all(id);
    word.descendants = stmt.descendants.all(id);

    return word;
}

function wordsByHeadword(languageId, headword) {
    return stmt.wordsByHeadword
        .all(languageId, headword)
        .map((row) => loadWord(row.id));
}

function suggestWords(languageId, query) {
    return stmt.wordsBySortKey.all(languageId, fold(query));
}

function otherLanguagesWithHeadword(languageId, headword) {
    return stmt.wordsSameHeadword.all(headword, languageId);
}

function wordExists(slug, headword) {
    return Boolean(stmt.wordExists.get(slug, headword));
}

function indexWord(wordId) {
    stmt.ftsDelete.run(wordId);
    stmt.ftsInsert.run(wordId);
}

function refId(value, label) {
    const id = Number(value);
    if (!Number.isSafeInteger(id)) {
        throw new HttpError(400, `Invalid ${label}`);
    }
    return id;
}

// Validates a word payload against the DB. `selfId` is null for new words.
function parseWord(data, language, selfId) {
    if (!data || typeof data !== "object") {
        throw new HttpError(400, "Invalid word");
    }

    const headword = text(data.headword, "Headword", 200);
    if (!headword) {
        throw new HttpError(400, "Headword is required");
    }
    if (/[\r\n]/.test(headword)) {
        throw new HttpError(400, "Headword must be a single line");
    }

    let gender = text(data.gender, "Gender", 20);
    if (gender !== null && !GENDERS.includes(gender)) {
        throw new HttpError(400, "Invalid gender");
    }
    if (!language.has_gender) {
        gender = null;
    }

    const rawSenses = Array.isArray(data.senses) ? data.senses : [];
    const senses = rawSenses
        .map((sense) => text(sense, "Definition", 5000))
        .filter(Boolean);

    const variantOf = new Map();
    for (const item of Array.isArray(data.variantOf) ? data.variantOf : []) {
        const id = refId(item && item.id, "variant target");
        const kind = item.kind;
        if (!VARIANT_KINDS.includes(kind)) {
            throw new HttpError(400, "Invalid variant kind");
        }
        if (id === selfId) {
            throw new HttpError(400, "A word cannot be a variant of itself");
        }
        const target = stmt.wordById.get(id);
        if (!target) {
            throw new HttpError(400, "Variant target does not exist");
        }
        if (target.language_id !== language.id) {
            throw new HttpError(400, "A word can only be a variant of a word in the same language");
        }
        variantOf.set(id, kind);
    }

    const ancestors = new Map();
    for (const item of Array.isArray(data.ancestors) ? data.ancestors : []) {
        const id = refId(item && item.id, "ancestor");
        if (!ANCESTRY_KINDS.includes(item.kind)) {
            throw new HttpError(400, "Invalid ancestry kind");
        }
        if (id === selfId) {
            throw new HttpError(400, "A word cannot be its own ancestor");
        }
        if (!stmt.wordById.get(id)) {
            throw new HttpError(400, "Ancestor does not exist");
        }
        ancestors.set(id, { kind: item.kind, note: text(item.note, "Ancestry note", 1000) });
    }

    return {
        headword,
        sortKey: fold(headword),
        pos: text(data.pos, "Part of speech", 40),
        gender,
        pronunciation: text(data.pronunciation, "Pronunciation", 200),
        sinographs: text(data.sinographs, "Sinographs", 200),
        etymology: text(data.etymology, "Etymology", 20000),
        senses,
        variantOf,
        ancestors
    };
}

// Creates (id == null) or updates a word and replaces its related rows.
// A word's language never changes after creation.
const saveWord = db.transaction((id, languageId, data) => {
    let language;

    if (id === null) {
        language = getLanguage(languageId);
        if (!language) {
            throw new HttpError(400, "Language does not exist");
        }
    } else {
        const existing = stmt.wordById.get(id);
        if (!existing) {
            throw new HttpError(404, "Word not found");
        }
        language = getLanguage(existing.language_id);
    }

    const w = parseWord(data, language, id);
    const now = Date.now();

    if (id === null) {
        id = stmt.wordInsert.run(
            language.id, w.headword, w.sortKey, w.pos, w.gender,
            w.pronunciation, w.sinographs, w.etymology, now, now
        ).lastInsertRowid;
    } else {
        stmt.wordUpdate.run(
            w.headword, w.sortKey, w.pos, w.gender,
            w.pronunciation, w.sinographs, w.etymology, now, id
        );
        stmt.senseDelete.run(id);
        stmt.variantDelete.run(id);
        stmt.ancestryDelete.run(id);
    }

    w.senses.forEach((definition, position) => {
        stmt.senseInsert.run(id, position, definition);
    });
    for (const [targetId, kind] of w.variantOf) {
        stmt.variantInsert.run(id, targetId, kind);
    }
    for (const [ancestorId, { kind, note }] of w.ancestors) {
        stmt.ancestryInsert.run(id, ancestorId, kind, note);
    }

    indexWord(id);

    return id;
});

const deleteWord = db.transaction((id) => {
    stmt.ftsDelete.run(id);
    if (stmt.wordDelete.run(id).changes === 0) {
        throw new HttpError(404, "Word not found");
    }
});

// ------------------------------------------------------
// Lists and search
// ------------------------------------------------------

// Alphabetical page of a language's words (optionally one initial letter).
function listWords(languageId, { letter = null, limit = 200, offset = 0 } = {}) {
    const where = letter
        ? "w.language_id = ? AND substr(w.sort_key, 1, 1) = ?"
        : "w.language_id = ?";
    const params = letter ? [languageId, letter] : [languageId];

    const total = db
        .prepare(`SELECT COUNT(*) AS n FROM words w WHERE ${where}`)
        .get(...params).n;

    const items = db
        .prepare(`
            SELECT w.id, w.headword, w.pos, w.sort_key, ${GLOSS_SQL} AS gloss
            FROM words w WHERE ${where}
            ORDER BY w.sort_key, w.headword, w.id LIMIT ? OFFSET ?
        `)
        .all(...params, limit, offset);

    return { total, items };
}

// Initial letters (folded) present in a language, with counts.
function listInitials(languageId) {
    return db
        .prepare(`
            SELECT substr(sort_key, 1, 1) AS letter, COUNT(*) AS n
            FROM words WHERE language_id = ?
            GROUP BY letter ORDER BY letter
        `)
        .all(languageId);
}

// Builds a prefix-matching FTS5 query from free text, or null if empty.
function ftsQuery(query) {
    const tokens = String(query).match(/[\p{L}\p{N}\p{M}]+/gu);

    if (!tokens) {
        return null;
    }

    return tokens.map((token) => `"${token}"*`).join(" ");
}

// Searches headwords, sinographs and English definitions. Exact
// (diacritic-folded) headword matches come first.
function searchWords(query, { languageId = null, limit = 50, offset = 0 } = {}) {
    const match = ftsQuery(query);

    if (!match) {
        return [];
    }

    const languageFilter = languageId === null ? "" : "AND w.language_id = ?";
    const params = [match];
    if (languageId !== null) {
        params.push(languageId);
    }

    return db
        .prepare(`
            SELECT w.id, w.headword, w.pos, w.sinographs,
                   l.slug AS language_slug, l.name AS language_name,
                   l.is_proto AS language_is_proto, ${GLOSS_SQL} AS gloss
            FROM words_fts
            JOIN words w ON w.id = words_fts.word_id
            JOIN languages l ON l.id = w.language_id
            WHERE words_fts MATCH ? ${languageFilter}
            ORDER BY (w.sort_key = ?) DESC,
                     bm25(words_fts, 0, 10, 10, 1),
                     w.sort_key
            LIMIT ? OFFSET ?
        `)
        .all(...params, fold(String(query).trim()), limit, offset);
}

// Words whose folded headword equals the folded query exactly.
function exactMatches(query, languageId = null) {
    const languageFilter = languageId === null ? "" : "AND w.language_id = ?";
    const params = [fold(String(query).trim())];
    if (languageId !== null) {
        params.push(languageId);
    }

    return db
        .prepare(`
            SELECT w.id, w.headword, l.slug AS language_slug
            FROM words w JOIN languages l ON l.id = w.language_id
            WHERE w.sort_key = ? ${languageFilter}
            ORDER BY w.id LIMIT 2
        `)
        .all(...params);
}

module.exports = {
    GENDERS,
    VARIANT_KINDS,
    ANCESTRY_KINDS,
    fold,
    listLanguages,
    getLanguage,
    getLanguageBySlug,
    createLanguage,
    updateLanguage,
    deleteLanguage,
    loadWord,
    wordsByHeadword,
    suggestWords,
    otherLanguagesWithHeadword,
    wordExists,
    saveWord,
    deleteWord,
    listWords,
    listInitials,
    searchWords,
    exactMatches
};
