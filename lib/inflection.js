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
        INSERT INTO inflection_templates (language_id, name, pos, description, stem_remove, row_dims, col_dims, cells, position, created_at, updated_at, label)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    update: db.prepare(`
        UPDATE inflection_templates SET name = ?, pos = ?, description = ?, stem_remove = ?, row_dims = ?, col_dims = ?, cells = ?, updated_at = ?, label = ?
        WHERE id = ?`),
    remove: db.prepare("DELETE FROM inflection_templates WHERE id = ?"),
    nextPosition: db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM inflection_templates WHERE language_id = ?"),
    uses: db.prepare("SELECT template_id, COUNT(*) AS n FROM word_inflections GROUP BY template_id"),
    usedBy: db.prepare(`
        SELECT w.id, w.headword FROM word_inflections wi JOIN words w ON w.id = wi.word_id
        WHERE wi.template_id = ? ORDER BY w.sort_key LIMIT ?`),
    forWord: db.prepare("SELECT * FROM word_inflections WHERE word_id = ? ORDER BY position, id"),
    forTemplate: db.prepare("SELECT id, overrides FROM word_inflections WHERE template_id = ?"),
    setOverrides: db.prepare("UPDATE word_inflections SET overrides = ? WHERE id = ?"),
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
        label: row.label || "", // an optional title shown over the whole table
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
        label: cleanText(data.label, "Label", 80),
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
        stmt.nextPosition.get(languageId).next, now, now, t.label
    ).lastInsertRowid;
    return getTemplate(id);
}

// How the cells of a layout move to a changed layout, so the words' own forms follow them. Categories
// are matched by name (any not matched are paired up in order, on the same side: a renamed category),
// and the values of a matched category the same way (a renamed value keeps its place). Returns
// remapKey(oldKey) -> the new key, or null when that form no longer has a place: its value was
// removed, or it sat at a later value of a category that has gone (it keeps its place only when that
// category's first value was the one it was in); a category that is new starts at its first value.
function layoutMap(oldRows, oldCols, newRows, newCols) {
    const dims = (rows, cols) => [
        ...rows.map((d, i) => ({ axis: 0, i, name: d.name.trim().toLowerCase(), values: d.values })),
        ...cols.map((d, i) => ({ axis: 1, i, name: d.name.trim().toLowerCase(), values: d.values }))
    ];
    const was = dims(oldRows, oldCols);
    const now = dims(newRows, newCols);

    const pairs = new Map(); // was dim -> now dim
    const taken = new Set();
    for (const w of was) {
        const n = now.find((x) => !taken.has(x) && x.name === w.name);
        if (n) {
            pairs.set(w, n);
            taken.add(n);
        }
    }
    for (const axis of [0, 1]) {
        const lonelyWas = was.filter((w) => w.axis === axis && !pairs.has(w));
        const lonelyNow = now.filter((n) => n.axis === axis && !taken.has(n));
        lonelyWas.forEach((w, k) => {
            if (lonelyNow[k]) {
                pairs.set(w, lonelyNow[k]);
                taken.add(lonelyNow[k]);
            }
        });
    }

    // For a pair: old value index -> new value index (or null).
    const valueMap = new Map();
    for (const [w, n] of pairs) {
        const byLabel = new Map(n.values.map((v, i) => [v.trim().toLowerCase(), i]));
        const usedNew = new Set();
        const map = w.values.map((v) => {
            const hit = byLabel.get(v.trim().toLowerCase());
            if (hit !== undefined && !usedNew.has(hit)) {
                usedNew.add(hit);
                return hit;
            }
            return undefined;
        });
        // Values with no namesake: when as many are left over on each side they are taken to be renamed (paired
        // in order); otherwise one is paired only with a new value at the same place, and the rest have
        // no place to go (nothing is guessed).
        const freeNew = n.values.map((_, i) => i).filter((i) => !usedNew.has(i));
        const leftOver = map.filter((hit) => hit === undefined).length;
        valueMap.set(w, map.map((hit, i) => {
            if (hit !== undefined) {
                return hit;
            }
            if (leftOver === freeNew.length) {
                return freeNew.shift();
            }
            const same = freeNew.indexOf(i);
            return same >= 0 ? freeNew.splice(same, 1)[0] : null;
        }));
    }

    const parse = (text, count) => (text === "" ? [] : text.split(".").map(Number)).slice(0, count);

    return (key) => {
        const [r, c] = key.split("|");
        const old = [parse(r, oldRows.length), parse(c, oldCols.length)];
        const out = [newRows.map(() => 0), newCols.map(() => 0)];
        for (const w of was) {
            const index = old[w.axis][w.i];
            if (index === undefined || Number.isNaN(index)) {
                return null;
            }
            const n = pairs.get(w);
            if (!n) {
                if (index !== 0) {
                    return null; // a category that has gone: only its first value's forms are kept
                }
                continue;
            }
            const value = valueMap.get(w)[index];
            if (value === null || value === undefined) {
                return null;
            }
            out[n.axis][n.i] = value;
        }
        return `${out[0].join(".")}|${out[1].join(".")}`;
    };
}

// Moves every word's own forms (overrides) for this template to where the new layout has their cells.
// Returns how many were kept and how many no longer fit.
function remapWordForms(templateId, oldTemplate, t) {
    const remap = layoutMap(oldTemplate.rows, oldTemplate.cols, t.rows, t.cols);
    const valid = new Set(paths(t.rows).flatMap((r) => paths(t.cols).map((c) => cellKey(r, c))));
    let kept = 0;
    let lost = 0;

    for (const row of stmt.forTemplate.all(templateId)) {
        const moved = {};
        for (const [key, form] of Object.entries(JSON.parse(row.overrides))) {
            const to = remap(key);
            if (to !== null && valid.has(to) && !(to in moved)) {
                moved[to] = form;
                kept++;
            } else {
                lost++;
            }
        }
        stmt.setOverrides.run(JSON.stringify(moved), row.id);
    }
    return { kept, lost };
}

const updateTemplate = db.transaction((id, data) => {
    const old = getTemplate(id);
    if (!old) {
        throw new HttpError(404, "Template not found");
    }
    const t = normalize(data);
    const layoutChanged = JSON.stringify(old.rows) !== JSON.stringify(t.rows) || JSON.stringify(old.cols) !== JSON.stringify(t.cols);
    stmt.update.run(t.name, t.pos, t.description, t.stem_remove, JSON.stringify(t.rows), JSON.stringify(t.cols), JSON.stringify(t.cells), Date.now(), t.label, id);
    // Where the categories or values changed, the words' own forms move with them instead of being lost.
    const moved = layoutChanged ? remapWordForms(id, old, t) : { kept: 0, lost: 0 };
    return { ...getTemplate(id), moved };
});

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
    listTemplates, getTemplate, createTemplate, updateTemplate, layoutMap, deleteTemplate, wordsUsing,
    defaultStem, tableFor, forWord, replaceForWord, cellKey, paths
};
