"use strict";

// Era pages: the calendar's eras (public/calendar/eras.json) mirrored as
// pages in the built-in "Eras" lore category, plus the calendar notes that
// fall within each era.

const fs = require("node:fs");
const path = require("node:path");
const { db } = require("./db");
const calendar = require("./calendar");
const lore = require("./lore");
const dict = require("./dictionary");
const { sanitizeHtml, htmlToText } = require("./html");
const { groupNotes, NOTE_COLUMNS, NOTE_JOINS } = require("./notes");

const ERAS_FILE = path.join(__dirname, "..", "public", "calendar", "eras.json");
const CATEGORY_KEY = "eras"; // lore_categories.system_key
const CATEGORY_SLUG = "eras";

const stmt = {
    categoryByKey: db.prepare("SELECT * FROM lore_categories WHERE system_key = ?"),
    categoryBySlug: db.prepare("SELECT * FROM lore_categories WHERE slug = ?"),
    categoryAdopt: db.prepare("UPDATE lore_categories SET system_key = ? WHERE id = ?"),
    categoryInsert: db.prepare(`
        INSERT INTO lore_categories (slug, name, description, color, system_key, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    eraPages: db.prepare(
        "SELECT id, era_start_year, title, slug FROM lore_pages WHERE era_start_year IS NOT NULL"
    ),
    detach: db.prepare("UPDATE lore_pages SET era_start_year = NULL WHERE id = ?"),
    insertPage: db.prepare(`
        INSERT INTO lore_pages (category_id, slug, title, sort_key, body, body_text, created_at, updated_at, era_start_year)
        VALUES (?, ?, ?, ?, '', '', ?, ?, ?)
    `),
    retitle: db.prepare("UPDATE lore_pages SET title = ?, sort_key = ?, updated_at = ? WHERE id = ?"),
    setBody: db.prepare("UPDATE lore_pages SET body = ?, body_text = ? WHERE id = ?"),
    notesBetween: db.prepare(
        `SELECT ${NOTE_COLUMNS} FROM notes n ${NOTE_JOINS} WHERE n.day BETWEEN ? AND ? ORDER BY n.day, n.id`
    )
};

// ------------------------------------------------------
// eras.json
// ------------------------------------------------------

// eras.json entries are { "name", "sinographs", "startYear" }. An older file
// with the gloss glued onto the name ("Niwosara 新雨") is split here.
const TRAILING_SINOGRAPHS = /^(.*?)\s*([\u3000-\u9fff\uf900-\ufaff]+)$/;

function normalizeEra(era) {
    let name = era.name.trim();
    let sinographs = typeof era.sinographs === "string" ? era.sinographs.trim() : "";

    if (!sinographs) {
        const match = TRAILING_SINOGRAPHS.exec(name);
        if (match && match[1]) {
            name = match[1].trim();
            sinographs = match[2];
        }
    }

    return { name, sinographs, startYear: era.startYear };
}

function readEras() {
    try {
        const data = JSON.parse(fs.readFileSync(ERAS_FILE, "utf8"));

        return (Array.isArray(data) ? data : [])
            .filter((era) => era && typeof era.name === "string" && Number.isInteger(era.startYear))
            .map(normalizeEra)
            .sort((a, b) => a.startYear - b.startYear);
    } catch {
        return [];
    }
}

// "Later Kemairyom" and similar continuation entries get no page of their own.
const isIgnored = (era) => /^later\b/i.test(era.name.trim());

// The eras that get pages, with their neighbours and length. An era runs
// until the universal year the next era in the file begins (even when that
// next era is one of the ignored ones).
function eraSpans() {
    const all = readEras();
    const kept = all.filter((era) => !isIgnored(era));

    return kept.map((era, i) => {
        const following = all[all.indexOf(era) + 1] || null;

        return {
            name: era.name,
            sinographs: era.sinographs,
            startYear: era.startYear,
            endYear: following ? following.startYear : null,
            years: following ? following.startYear - era.startYear : null,
            previous: kept[i - 1] || null,
            next: kept[i + 1] || null
        };
    });
}

// ------------------------------------------------------
// Keeping the lore pages in step with eras.json
// ------------------------------------------------------

function ensureCategory() {
    let category = stmt.categoryByKey.get(CATEGORY_KEY);

    if (!category) {
        // Adopt a category the user already made with this slug.
        category = stmt.categoryBySlug.get(CATEGORY_SLUG);

        if (category) {
            stmt.categoryAdopt.run(CATEGORY_KEY, category.id);
        } else {
            const now = Date.now();
            const id = stmt.categoryInsert.run(
                CATEGORY_SLUG,
                "Eras",
                "The eras of the Tanakōdeyam calendar, in order. These pages are generated from the " +
                    "calendar's eras; each one also gathers the calendar notes that fall within it.",
                "#0f766e",
                CATEGORY_KEY,
                now,
                now
            ).lastInsertRowid;
            category = { id };
        }
    }

    return category;
}

// Link by the era's name (readable when editing); fall back to the page slug
// in the rare case a suffix like "-2" was needed to keep slugs unique.
function linkTarget(era, slugOf) {
    const slug = slugOf.get(era.startYear);
    return slug === lore.slugify(era.name) ? era.name : slug;
}

// "An era succeeding X and preceding Y, lasting a total of N years."
function defaultBody(span, slugOf) {
    const link = (era) => `[[${CATEGORY_SLUG}|${linkTarget(era, slugOf)}]]`;
    const relations = [];

    if (span.previous) {
        relations.push(`succeeding ${link(span.previous)}`);
    }
    if (span.next) {
        relations.push(`preceding ${link(span.next)}`);
    }

    const duration = span.years === null
        ? ""
        : `, lasting a total of ${span.years} ${span.years === 1 ? "year" : "years"}`;

    return `<p>An era${relations.length ? ` ${relations.join(" and ")}` : ""}${duration}.</p>`;
}

// Creates any missing era pages (with the default text, which is then free
// to edit), follows renamed eras, and releases pages whose era has been
// removed from eras.json. Existing text is never overwritten.
const syncEraPages = db.transaction(() => {
    const category = ensureCategory();
    const spans = eraSpans();
    const wanted = new Set(spans.map((span) => span.startYear));
    const byYear = new Map();

    for (const row of stmt.eraPages.all()) {
        if (wanted.has(row.era_start_year)) {
            byYear.set(row.era_start_year, row);
        } else {
            stmt.detach.run(row.id);
        }
    }

    const now = Date.now();
    const created = [];

    for (const span of spans) {
        const row = byYear.get(span.startYear);

        if (!row) {
            const slug = lore.freeSlug(category.id, lore.slugify(span.name));
            const id = stmt.insertPage.run(
                category.id, slug, span.name, lore.fold(span.name), now, now, span.startYear
            ).lastInsertRowid;

            byYear.set(span.startYear, { id, slug });
            created.push({ id, span });
        } else if (row.title !== span.name) {
            stmt.retitle.run(span.name, lore.fold(span.name), now, row.id);
            lore.indexPage(row.id);
        }
    }

    // Default text needs every page's slug, so it is written in a second pass.
    const slugOf = new Map([...byYear].map(([year, row]) => [year, row.slug]));

    for (const { id, span } of created) {
        const body = sanitizeHtml(defaultBody(span, slugOf));
        stmt.setBody.run(body, htmlToText(body), id);
        lore.indexPage(id);
    }

    // Dictionary entries for the era names: the name as headword, the gloss as
    // its sinographs, and a definition that points at the lore page. (The
    // entry also gets the automatic "In the lore" link, since the titles match.)
    dict.syncEraWords(
        spans.map((span) => ({
            startYear: span.startYear,
            headword: span.name,
            sinographs: span.sinographs,
            senses: [`An era of the calendar. See [[${CATEGORY_SLUG}|${linkTarget(span, slugOf)}]].`]
        }))
    );
});

let lastModified = null;

// Re-syncs when eras.json has changed since the last check (and on first use).
function syncIfChanged() {
    let modified;
    try {
        modified = fs.statSync(ERAS_FILE).mtimeMs;
    } catch {
        modified = 0;
    }

    if (modified !== lastModified) {
        lastModified = modified;
        syncEraPages();
    }
}

// ------------------------------------------------------
// Calendar notes within an era
// ------------------------------------------------------

// The years of an era's span run from its start year through the year the
// next era begins, both inclusive, so a boundary year belongs to both eras.
// Years are labelled the way the calendar counts them within the era: the
// era's name and the year of the era ("Kemairyom 34"). Returns
//   { name, startYear, endYear, lengthYears, groups: [{ year, eraYear, label, notes }] }
// with only the years that have notes, in date order, or null for an unknown era.
function eraNotes(startYear) {
    const span = eraSpans().find((s) => s.startYear === startYear);

    if (!span) {
        return null;
    }

    const first = calendar.yearDayRange(span.startYear).first;
    const last = span.endYear === null ? Number.MAX_SAFE_INTEGER : calendar.yearDayRange(span.endYear).last;

    const groups = groupNotes(stmt.notesBetween.all(first, last), (year) => {
        const eraYear = year - span.startYear + 1;
        return { eraYear, label: `${span.name} ${eraYear}` };
    });

    return {
        name: span.name,
        startYear: span.startYear,
        endYear: span.endYear,
        // Years of the era counted inclusively, so the last year of the span
        // (shared with the next era) is the era's final year.
        lengthYears: span.endYear === null ? null : span.endYear - span.startYear + 1,
        groups
    };
}

// "Kemairyom 10" for a universal year: the latest era (in eras.json, "Later
// ..." entries included) that has begun by then. Null before the first era.
function eraLabelForYear(year) {
    const era = readEras().filter((e) => e.startYear <= year).pop();
    return era ? `${era.name} ${year - era.startYear + 1}` : null;
}

module.exports = { syncIfChanged, syncEraPages, eraNotes, eraSpans, eraLabelForYear };
