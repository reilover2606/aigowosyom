"use strict";

// Inflection templates (paradigms) and the tables they make for words.
//
// A template lays a part of speech's forms out along categories. Each category (a "dimension") has a name
// and an ordered list of values: Person (1st, 2nd, 3rd), Number (singular, plural), Tense (present, past),
// Case, Gender, ... Up to three go down the side and up to three across the top, so a verb can have
// person and number as rows and tense and mood as columns. Every cell is addressed by the values it sits
// at, as indexes ("1.0|2": row values 1 and 0, column value 2), and holds a *pattern*: text with {stem}
// where the word's stem goes ("{stem}ana", "ge{stem}t", "{stem}"), or "—" for a form that doesn't exist.
//
// A language can have any number of templates, even for one part of speech, for word classes and for
// irregular or worn-down patterns. A word picks the templates it follows (a noun may have a case table
// and a possessive table), gives its stem (by default its headword with the template's "stem removal"
// taken off, e.g. "-a" for verbs that end in -a) and can override any single cell with its own form.

const { db } = require("./db");
const { HttpError } = require("./http");

const MAX_DIMENSIONS = 3;
const MAX_VALUES = 40;
const MAX_CELLS = 600;

const stmt = {
    templates: db.prepare("SELECT * FROM inflection_templates WHERE language_id = ? ORDER BY position, id"),
    templateById: db.prepare("SELECT * FROM inflection_templates WHERE id = ?"),
    insert: db.prepare(`
        INSERT INTO inflection_templates (language_id, name, pos, description, stem_remove, row_dims, col_dims, cells, position, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    update: db.prepare(`
        UPDATE inflection_templates SET name = ?, pos = ?, description = ?, stem_remove = ?, row_dims = ?, col_dims = ?, cells = ?, updated_at = ?
        WHERE id = ?`),
    remove: db.prepare("DELETE FROM inflection_templates WHERE id = ?"),
    nextPosition: db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM inflection_templates WHERE language_id = ?"),
    uses: db.prepare("SELECT template_id, COUNT(*) AS n FROM word_inflections GROUP BY template_id"),
    usedBy: db.prepare(`
        SELECT w.id, w.headword FROM word_inflections wi JOIN words w ON w.id = wi.word_id
        WHERE wi.template_id = ? ORDER BY w.sort_key LIMIT ?`),
    forWord: db.prepare("SELECT * FROM word_inflections WHERE word_id = ? ORDER BY position, id"),
    clearWord: db.prepare("DELETE FROM word_inflections WHERE word_id = ?"),
    insertWord: db.prepare("INSERT INTO word_inflections (word_id, template_id, stem, overrides, position) VALUES (?, ?, ?, ?, ?)"),
    languageExists: db.prepare("SELECT id FROM languages WHERE id = ?")
};

function cleanText(value, label, max, { required = false } = {}) {
    if (value === undefined || value === null || value === "") {
        if (required) {
            throw new HttpError(400, `${label} is required`);
        }
        return null;
    }
    if (typeof value !== "string") {
        throw new HttpError(400, `${label} must be text`);
    }
    const trimmed = value.trim();
    if (!trimmed && required) {
        throw new HttpError(400, `${label} is required`);
    }
    if (trimmed.length > max) {
        throw new HttpError(400, `${label} is too long`);
    }
    return trimmed || null;
}

// ---- cell addressing ----

// The key of the cell at these row value indexes and column value indexes.
const cellKey = (rowPath, colPath) => `${rowPath.join(".")}|${colPath.join(".")}`;

// Every combination of values along some dimensions, as index paths, in reading order: [[0,0],[0,1],[1,0]...].
function paths(dims) {
    let out = [[]];
    for (const dim of dims) {
        out = out.flatMap((path) => dim.values.map((_, i) => [...path, i]));
    }
    return out;
}

function template_(row) {
    return row && {
        id: row.id,
        language_id: row.language_id,
        name: row.name,
        pos: row.pos || "",
        description: row.description || "",
        stem_remove: row.stem_remove || "",
        rows: JSON.parse(row.row_dims),
        cols: JSON.parse(row.col_dims),
        cells: JSON.parse(row.cells),
        position: row.position
    };
}

// ---- checking what the editor sends ----

function normalizeDimensions(list, label) {
    if (list === undefined || list === null) {
        return [];
    }
    if (!Array.isArray(list) || list.length > MAX_DIMENSIONS) {
        throw new HttpError(400, `${label}: at most ${MAX_DIMENSIONS} categories`);
    }
    return list.map((dim) => {
        const name = cleanText(dim && dim.name, `${label}: a category name`, 40, { required: true });
        if (!Array.isArray(dim.values) || dim.values.length === 0 || dim.values.length > MAX_VALUES) {
            throw new HttpError(400, `${label}: “${name}” needs between 1 and ${MAX_VALUES} values`);
        }
        const seen = new Set();
        const values = dim.values.map((value) => {
            const text = cleanText(value, `${label}: a value of “${name}”`, 40, { required: true });
            if (seen.has(text.toLowerCase())) {
                throw new HttpError(400, `${label}: “${name}” has “${text}” twice`);
            }
            seen.add(text.toLowerCase());
            return text;
        });
        return { name, values };
    });
}

function normalize(data) {
    if (!data || typeof data !== "object") {
        throw new HttpError(400, "Invalid template");
    }
    const rows = normalizeDimensions(data.rows, "Rows");
    const cols = normalizeDimensions(data.cols, "Columns");
    const rowPaths = paths(rows);
    const colPaths = paths(cols);
    if (rowPaths.length * colPaths.length > MAX_CELLS) {
        throw new HttpError(400, `That table would have ${rowPaths.length * colPaths.length} cells; the most is ${MAX_CELLS}`);
    }

    const valid = new Set(rowPaths.flatMap((r) => colPaths.map((c) => cellKey(r, c))));
    const cells = {};
    for (const [key, pattern] of Object.entries(data.cells && typeof data.cells === "object" ? data.cells : {})) {
        if (!valid.has(key)) {
            continue; // a cell of a layout that has since changed
        }
        const text = cleanText(pattern, "A pattern", 200);
        if (text) {
            cells[key] = text;
        }
    }

    return {
        name: cleanText(data.name, "Name", 80, { required: true }),
        pos: cleanText(data.pos, "Part of speech", 40),
        description: cleanText(data.description, "Notes", 2000),
        stem_remove: cleanText(data.stem_remove, "Stem removal", 40),
        rows,
        cols,
        cells
    };
}

// ---- templates ----

function listTemplates(languageId) {
    const counts = new Map(stmt.uses.all().map((r) => [r.template_id, r.n]));
    return stmt.templates.all(languageId).map((row) => ({ ...template_(row), words: counts.get(row.id) || 0 }));
}

function getTemplate(id) {
    return template_(stmt.templateById.get(id));
}

function createTemplate(languageId, data) {
    if (!stmt.languageExists.get(languageId)) {
        throw new HttpError(400, "Language does not exist");
    }
    const t = normalize(data);
    const now = Date.now();
    const id = stmt.insert.run(
        languageId, t.name, t.pos, t.description, t.stem_remove,
        JSON.stringify(t.rows), JSON.stringify(t.cols), JSON.stringify(t.cells),
        stmt.nextPosition.get(languageId).next, now, now
    ).lastInsertRowid;
    return getTemplate(id);
}

function updateTemplate(id, data) {
    if (!stmt.templateById.get(id)) {
        throw new HttpError(404, "Template not found");
    }
    const t = normalize(data);
    stmt.update.run(t.name, t.pos, t.description, t.stem_remove, JSON.stringify(t.rows), JSON.stringify(t.cols), JSON.stringify(t.cells), Date.now(), id);
    return getTemplate(id);
}

function deleteTemplate(id) {
    if (stmt.remove.run(id).changes === 0) {
        throw new HttpError(404, "Template not found");
    }
}

function wordsUsing(templateId, limit = 200) {
    return stmt.usedBy.all(templateId, limit);
}

// ---- making a word's table ----

// The stem a template gives a headword: its "stem removal" taken off ("-a" the end, "ge-" the start).
function defaultStem(template, headword) {
    const word = headword.replace(/^\*/, "");
    const remove = (template.stem_remove || "").trim();
    if (!remove) {
        return word;
    }
    if (remove.startsWith("-") && word.endsWith(remove.slice(1)) && word.length > remove.length - 1) {
        return word.slice(0, word.length - (remove.length - 1));
    }
    if (remove.endsWith("-") && word.startsWith(remove.slice(0, -1)) && word.length > remove.length - 1) {
        return word.slice(remove.length - 1);
    }
    if (!remove.startsWith("-") && !remove.endsWith("-") && word.endsWith(remove) && word.length > remove.length) {
        return word.slice(0, word.length - remove.length);
    }
    return word;
}

const NONE = /^(—|–|-|n\/a)$/i;

// The form in one cell: the word's own override if it has one, else the template's pattern with the stem in.
function formIn(template, key, { stem, headword, overrides }) {
    const own = overrides && overrides[key];
    if (own !== undefined && own !== null && String(own).trim() !== "") {
        return NONE.test(String(own).trim()) ? { form: null, source: "own" } : { form: String(own).trim(), source: "own" };
    }
    const pattern = template.cells[key];
    if (!pattern) {
        return { form: null, source: null };
    }
    if (NONE.test(pattern.trim())) {
        return { form: null, source: "template" };
    }
    return { form: pattern.replace(/\{stem\}/g, stem).replace(/\{headword\}/g, headword.replace(/^\*/, "")), source: "template" };
}

// A word's table as rows to draw: { template, stem, rowHeaders, colHeaders, rows: [{ labels, cells: [{ key, form }] }] }.
function tableFor(template, word) {
    const stem = (word.stem && word.stem.trim()) || defaultStem(template, word.headword);
    const rowPaths = paths(template.rows);
    const colPaths = paths(template.cols);
    const context = { stem, headword: word.headword, overrides: word.overrides || {} };
    return {
        template,
        stem,
        rows: rowPaths.map((r) => ({
            path: r,
            labels: r.map((v, d) => template.rows[d].values[v]),
            cells: colPaths.map((c) => {
                const key = cellKey(r, c);
                return { key, ...formIn(template, key, context) };
            })
        })),
        colPaths
    };
}

// ---- a word's own choices ----

function forWord(wordId) {
    return stmt.forWord.all(wordId).map((row) => ({
        template_id: row.template_id,
        stem: row.stem || "",
        overrides: JSON.parse(row.overrides),
        template: getTemplate(row.template_id)
    }));
}

// Replaces what the word uses: [{ template_id, stem, overrides }] (only templates of the word's language).
function replaceForWord(wordId, languageId, list) {
    if (!Array.isArray(list)) {
        throw new HttpError(400, "Inflections must be a list");
    }
    stmt.clearWord.run(wordId);
    const seen = new Set();
    list.forEach((item, position) => {
        const template = getTemplate(Number(item && item.template_id));
        if (!template || template.language_id !== languageId) {
            throw new HttpError(400, "That inflection template doesn't belong to this language");
        }
        if (seen.has(template.id)) {
            throw new HttpError(400, `The table “${template.name}” is listed twice`);
        }
        seen.add(template.id);
        const stem = cleanText(item.stem, "A stem", 200);
        const overrides = {};
        const valid = new Set(paths(template.rows).flatMap((r) => paths(template.cols).map((c) => cellKey(r, c))));
        for (const [key, form] of Object.entries(item.overrides && typeof item.overrides === "object" ? item.overrides : {})) {
            const text = cleanText(form, "A form", 200);
            if (valid.has(key) && text) {
                overrides[key] = text;
            }
        }
        stmt.insertWord.run(wordId, template.id, stem, JSON.stringify(overrides), position);
    });
}

module.exports = {
    listTemplates, getTemplate, createTemplate, updateTemplate, deleteTemplate, wordsUsing,
    defaultStem, tableFor, forWord, replaceForWord, cellKey, paths
};
