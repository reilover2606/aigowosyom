"use strict";

// Books: a built-in lore category whose pages are books. Calendar notes can
// be assigned to a book (notes.book_id); a book page shows its notes the way
// an era page shows the notes in its span.

const { db } = require("./db");
const eras = require("./eras");
const { groupNotes, NOTE_COLUMNS, NOTE_JOINS } = require("./notes");

const CATEGORY_KEY = "books"; // lore_categories.system_key
const CATEGORY_SLUG = "books";

const stmt = {
    categoryByKey: db.prepare("SELECT * FROM lore_categories WHERE system_key = ?"),
    categoryBySlug: db.prepare("SELECT * FROM lore_categories WHERE slug = ?"),
    categoryAdopt: db.prepare("UPDATE lore_categories SET system_key = ? WHERE id = ?"),
    categoryInsert: db.prepare(`
        INSERT INTO lore_categories (slug, name, description, color, system_key, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    books: db.prepare(`
        SELECT p.id, p.title, p.slug, c.slug AS category_slug
        FROM lore_pages p JOIN lore_categories c ON c.id = p.category_id
        WHERE c.system_key = ?
        ORDER BY p.sort_key, p.id
    `),
    isBook: db.prepare(`
        SELECT 1 FROM lore_pages p JOIN lore_categories c ON c.id = p.category_id
        WHERE p.id = ? AND c.system_key = ?
    `),
    notesOf: db.prepare(
        `SELECT ${NOTE_COLUMNS} FROM notes n ${NOTE_JOINS} WHERE n.book_id = ? ORDER BY n.day, n.id`
    )
};

// Creates the built-in Books category if it is missing (adopting a category
// the user already made with the slug "books"). Safe to call repeatedly.
function ensureBooksCategory() {
    if (stmt.categoryByKey.get(CATEGORY_KEY)) {
        return;
    }

    const existing = stmt.categoryBySlug.get(CATEGORY_SLUG);

    if (existing) {
        stmt.categoryAdopt.run(CATEGORY_KEY, existing.id);
        return;
    }

    const now = Date.now();
    stmt.categoryInsert.run(
        CATEGORY_SLUG,
        "Books",
        "Each page here is a book. Add calendar notes to a book from the calendar, and they are " +
            "collected below the book's own text in date order.",
        "#8b5a2b",
        CATEGORY_KEY,
        now,
        now
    );
}

// All books (pages in the Books category), alphabetically.
function listBooks() {
    return stmt.books.all(CATEGORY_KEY);
}

function isBook(pageId) {
    return Boolean(stmt.isBook.get(pageId, CATEGORY_KEY));
}

// A book's notes in date order, grouped by year. A year heading reads like
// the calendar's own ("Kemairyom 10"), or "Year N" before the first era.
function bookNotes(pageId) {
    const groups = groupNotes(stmt.notesOf.all(pageId), (year) => ({
        label: eras.eraLabelForYear(year) || `Year ${year}`
    }));

    return { groups, count: groups.reduce((sum, group) => sum + group.notes.length, 0) };
}

module.exports = { CATEGORY_KEY, ensureBooksCategory, listBooks, isBook, bookNotes };
