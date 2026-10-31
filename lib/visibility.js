"use strict";

// The "do not publish" flag. Editing never hides anything locally; the flag
// only decides what is left out when the database is published (see
// lib/publish.js). Each save path calls applyHidden() with the request body;
// a body that doesn't mention `hidden` leaves the flag as it was.

const { db } = require("./db");

const TABLES = ["notes", "languages", "words", "lore_categories", "lore_pages"];

const setters = Object.fromEntries(
    TABLES.map((table) => [table, db.prepare(`UPDATE ${table} SET hidden = ? WHERE id = ?`)])
);

function applyHidden(table, id, data) {
    if (data && typeof data === "object" && data.hidden !== undefined) {
        setters[table].run(data.hidden ? 1 : 0, id);
    }
}

module.exports = { TABLES, applyHidden };
