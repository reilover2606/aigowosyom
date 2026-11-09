"use strict";

// Delete locks: items listed in a text file that can't be deleted. In the editors
// their Delete buttons are grayed out (nothing says why), and the server refuses a
// delete of one even if it is asked for another way.
//
// The file is data/delete-locks.txt (or DELETE_LOCKS_FILE), one item per line, read
// again whenever it changes. Blank lines and lines starting with # are ignored;
// names are not case-sensitive:
//
//   language: kyora
//   word: kyora / headword
//   template: kyora / Verb table          (an inflection template)
//   category: states                      (a lore category, by slug or name)
//   page: states / old-tanak              (a lore page: category / slug or title)
//   map: tanak-lands                      (by slug or name)
//   state: tanak-lands / Old Tanak        (also what "Dissolve" removes)
//   place: tanak-lands / Gate City
//   shape: tanak-lands / Southern Sea
//   image: tanak-lands / Old survey
//   note: 123                             (a calendar note, by its id)
//   era: Kemairyom
//
// Only deleting the item itself is stopped; deleting something that contains it
// (a language with a locked word in it, say) is not.

const fs = require("node:fs");
const path = require("node:path");
const { db } = require("./db");
const { DATA_DIR } = require("./config");
const { HttpError } = require("./http");

const FILE = process.env.DELETE_LOCKS_FILE
    ? path.resolve(process.env.DELETE_LOCKS_FILE)
    : path.join(DATA_DIR, "delete-locks.txt");

const KINDS = {
    language: "language", lang: "language",
    word: "word", entry: "word",
    template: "template", "inflection-template": "template",
    category: "category", "lore-category": "category",
    page: "page", "lore-page": "page", book: "page",
    map: "map",
    state: "state",
    place: "place", point: "place",
    shape: "shape", feature: "shape",
    image: "image",
    note: "note",
    era: "era"
};

const norm = (text) => String(text).trim().toLowerCase();

let cache = { modified: -1, lines: [] };

// [{ kind, parts: [lowercased pieces] }] from the file (none if it doesn't exist).
function readLines() {
    let modified = 0;
    try {
        modified = fs.statSync(FILE).mtimeMs;
    } catch {
        return [];
    }

    if (modified !== cache.modified) {
        const lines = [];
        for (const raw of fs.readFileSync(FILE, "utf8").split(/\r?\n/)) {
            const line = raw.trim();
            const colon = line.indexOf(":");
            if (!line || line.startsWith("#") || colon < 0) {
                continue;
            }
            const kind = KINDS[norm(line.slice(0, colon))];
            const rest = line.slice(colon + 1);
            if (kind && rest.trim()) {
                // "a / b": the first slash splits a container from the item.
                const slash = rest.indexOf("/");
                lines.push({
                    kind,
                    parts: slash < 0 ? [norm(rest)] : [norm(rest.slice(0, slash)), norm(rest.slice(slash + 1))]
                });
            }
        }
        cache = { modified, lines };
    }

    return cache.lines;
}

const ids = (sql, ...params) => db.prepare(sql).all(...params).map((row) => row.id);

// The ids (and, for eras, the names) of everything locked right now:
// { language: [id], word: [id], ..., era: [name] }
function current() {
    const lines = readLines();
    const out = { language: [], word: [], template: [], category: [], page: [], map: [], state: [], place: [], shape: [], image: [], note: [], era: [] };

    for (const { kind, parts } of lines) {
        const [a, b] = parts;

        if (kind === "era") {
            out.era.push(a);
        } else if (kind === "note") {
            const id = Number(a);
            if (Number.isSafeInteger(id)) {
                out.note.push(id);
            }
        } else if (kind === "language") {
            out.language.push(...ids("SELECT id FROM languages WHERE lower(slug) = ? OR lower(name) = ?", a, a));
        } else if (kind === "category") {
            out.category.push(...ids("SELECT id FROM lore_categories WHERE lower(slug) = ? OR lower(name) = ?", a, a));
        } else if (kind === "map") {
            out.map.push(...ids("SELECT id FROM maps WHERE lower(slug) = ? OR lower(name) = ?", a, a));
        } else if (b === undefined) {
            continue; // the other kinds need "container / item"
        } else if (kind === "word") {
            out.word.push(...ids(
                `SELECT w.id FROM words w JOIN languages l ON l.id = w.language_id
                 WHERE (lower(l.slug) = ? OR lower(l.name) = ?) AND lower(w.headword) = ?`, a, a, b));
        } else if (kind === "template") {
            out.template.push(...ids(
                `SELECT t.id FROM inflection_templates t JOIN languages l ON l.id = t.language_id
                 WHERE (lower(l.slug) = ? OR lower(l.name) = ?) AND lower(t.name) = ?`, a, a, b));
        } else if (kind === "page") {
            out.page.push(...ids(
                `SELECT p.id FROM lore_pages p JOIN lore_categories c ON c.id = p.category_id
                 WHERE (lower(c.slug) = ? OR lower(c.name) = ?) AND (lower(p.slug) = ? OR lower(p.title) = ?)`, a, a, b, b));
        } else {
            const table = { state: "map_states", place: "map_points", shape: "map_features", image: "map_images" }[kind];
            out[kind].push(...ids(
                `SELECT t.id FROM ${table} t JOIN maps m ON m.id = t.map_id
                 WHERE (lower(m.slug) = ? OR lower(m.name) = ?) AND lower(t.name) = ?`, a, a, b));
        }
    }

    return out;
}

// Which kind of item a DELETE request is for: /api/<...>/<id> (and nothing after the id).
const ROUTES = [
    [/^\/api\/dictionary\/words\/(\d+)$/, "word"],
    [/^\/api\/dictionary\/languages\/(\d+)$/, "language"],
    [/^\/api\/dictionary\/inflection-templates\/(\d+)$/, "template"],
    [/^\/api\/lore\/pages\/(\d+)$/, "page"],
    [/^\/api\/lore\/categories\/(\d+)$/, "category"],
    [/^\/api\/maps\/(\d+)$/, "map"],
    [/^\/api\/map-states\/(\d+)$/, "state"],
    [/^\/api\/map-points\/(\d+)$/, "place"],
    [/^\/api\/map-features\/(\d+)$/, "shape"],
    [/^\/api\/map-images\/(\d+)$/, "image"],
    [/^\/api\/notes\/(\d+)$/, "note"]
];

// Throws 403 when a DELETE request is for a locked item.
function refuseIfLocked(method, pathname) {
    if (method !== "DELETE") {
        return;
    }

    for (const [pattern, kind] of ROUTES) {
        const match = pattern.exec(pathname);
        if (match) {
            if (current()[kind].includes(Number(match[1]))) {
                throw new HttpError(403, "This item is locked against deletion");
            }
            return;
        }
    }
}

// Era names (lowercased) that can't be removed from the calendar.
const lockedEraNames = () => readLines().filter((l) => l.kind === "era").map((l) => l.parts[0]);

module.exports = { current, refuseIfLocked, lockedEraNames, FILE };
