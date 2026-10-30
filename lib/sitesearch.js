"use strict";

// Site-wide search: the dictionary, the lore and the calendar's notes.

const { db } = require("./db");
const dict = require("./dictionary");
const lore = require("./lore");
const calendar = require("./calendar");
const eras = require("./eras");
const { stripLinkSyntax, excerpt } = require("./html");

// Prefix-matching FTS5 query from free text, or null if empty.
function ftsQuery(query) {
    const tokens = String(query).match(/[\p{L}\p{N}\p{M}]+/gu);
    return tokens ? tokens.map((token) => `"${token}"*`).join(" ") : null;
}

// Calendar notes matching the query, each with its calendar date and, where
// it falls in an era, the era label (e.g. "Kemairyom 10"). `snippet` wraps
// matches in lore.MARK_START / lore.MARK_END.
function searchNotes(query, { limit = 10 } = {}) {
    const match = ftsQuery(query);

    if (!match) {
        return [];
    }

    return db
        .prepare(`
            SELECT n.id, n.day, n.title, n.body,
                   snippet(notes_fts, 2, @open, @close, '…', 20) AS snippet
            FROM notes_fts JOIN notes n ON n.id = notes_fts.note_id
            WHERE notes_fts MATCH @match
            ORDER BY bm25(notes_fts, 0, 6, 1), n.day
            LIMIT @limit
        `)
        .all({ match, open: lore.MARK_START, close: lore.MARK_END, limit })
        .map((note) => {
            const date = calendar.describeDay(note.day);

            return {
                ...note,
                year: date ? date.year : null,
                eraLabel: date ? eras.eraLabelForYear(date.year) : null,
                monthLabel: date ? date.monthLabel : null,
                monthIsNative: date ? date.monthIsNative : false,
                dayInMonth: date ? date.dayInMonth : null,
                gregorian: date ? date.gregorian : null
            };
        });
}

// A short, mixed list for the live suggestions on the front page. Each item:
// { type: "word" | "page" | "note", title, detail, url, badge: {name,color,ink}|null, conlang }
function suggest(query) {
    const words = dict.searchWords(query, { limit: 4 }).map((w) => ({
        type: "word",
        title: w.language_is_proto ? `*${w.headword}` : w.headword,
        extra: w.sinographs || null,
        detail: [w.pos, w.gloss].filter(Boolean).join(" · "),
        url: `/dictionary/${encodeURIComponent(w.language_slug)}/${encodeURIComponent(w.headword)}`,
        badge: { name: w.language_name, color: w.language_color, ink: w.language_ink },
        conlang: true
    }));

    const pages = lore.searchPages(query, { limit: 4 }).map((p) => ({
        type: "page",
        title: p.title,
        detail: p.excerpt,
        url: `/lore/${encodeURIComponent(p.category_slug)}/${encodeURIComponent(p.slug)}`,
        badge: { name: p.category_name, color: p.category_color, ink: p.category_ink },
        conlang: false
    }));

    const notes = searchNotes(query, { limit: 3 }).map((n) => ({
        type: "note",
        title: n.title || excerpt(n.body, 60),
        detail: [n.eraLabel, n.monthLabel && `${n.monthLabel} ${n.dayInMonth}`, n.gregorian].filter(Boolean).join(" · "),
        url: n.year ? `/calendar/?year=${n.year}` : "/calendar/",
        badge: { name: "Calendar note", color: "#6e7681", ink: "#ffffff" },
        conlang: false
    }));

    return [...words, ...pages, ...notes].map((item) => ({
        ...item,
        detail: stripLinkSyntax(item.detail || "")
    }));
}

module.exports = { searchNotes, suggest };
