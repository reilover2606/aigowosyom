"use strict";

// Calendar day notes API.

const { db } = require("../lib/db");
const books = require("../lib/books");
const { HttpError, sendJson, readJson, parseInteger } = require("../lib/http");

// A note with the book it is assigned to (if any).
const NOTE_SELECT = `
    SELECT n.id, n.day, n.title, n.body, n.book_id,
           p.title AS book_title, p.slug AS book_slug, c.slug AS book_category_slug
    FROM notes n
    LEFT JOIN lore_pages p ON p.id = n.book_id
    LEFT JOIN lore_categories c ON c.id = p.category_id`;

const stmt = {
    byDay: db.prepare(`${NOTE_SELECT} WHERE n.day = ? ORDER BY n.id`),
    counts: db.prepare(
        "SELECT day, COUNT(*) AS n FROM notes WHERE day BETWEEN ? AND ? GROUP BY day"
    ),
    get: db.prepare(`${NOTE_SELECT} WHERE n.id = ?`),
    insert: db.prepare(
        "INSERT INTO notes (day, title, body, book_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ),
    update: db.prepare(
        "UPDATE notes SET title = ?, body = ?, book_id = ?, updated_at = ? WHERE id = ?"
    ),
    remove: db.prepare("DELETE FROM notes WHERE id = ?")
};

// Validates a note payload; returns { title, body, bookId }. `bookId` is
// null (no book), a book's id, or undefined when the payload doesn't mention
// a book (so an update leaves the assignment alone).
function parseNote(data) {
    if (!data || typeof data !== "object") {
        throw new HttpError(400, "Invalid note");
    }

    const body = typeof data.body === "string" ? data.body.trim() : "";
    if (!body) {
        throw new HttpError(400, "Note body is required");
    }

    const title = typeof data.title === "string" ? data.title.trim() : "";

    let bookId;
    if (data.book_id !== undefined) {
        if (data.book_id === null || data.book_id === "") {
            bookId = null;
        } else {
            bookId = Number(data.book_id);
            if (!Number.isSafeInteger(bookId) || !books.isBook(bookId)) {
                throw new HttpError(400, "That book does not exist");
            }
        }
    }

    return { title: title || null, body, bookId };
}

module.exports = async function calendarRoutes(req, res, url) {
    if (!url.pathname.startsWith("/api/notes")) {
        return false;
    }

    const parts = url.pathname.split("/").filter(Boolean); // ["api", "notes", ...]
    const method = req.method;

    // GET /api/notes/counts?from=&to=  ->  { "<day>": count, ... }
    if (parts.length === 3 && parts[2] === "counts" && method === "GET") {
        const from = parseInteger(url.searchParams.get("from"), "day");
        const to = parseInteger(url.searchParams.get("to"), "day");
        const counts = {};
        for (const row of stmt.counts.all(from, to)) {
            counts[row.day] = row.n;
        }
        sendJson(res, 200, counts);
        return true;
    }

    // GET /api/notes?day=
    if (parts.length === 2 && method === "GET") {
        const day = parseInteger(url.searchParams.get("day"), "day");
        sendJson(res, 200, stmt.byDay.all(day));
        return true;
    }

    // POST /api/notes  { day, title?, body }
    if (parts.length === 2 && method === "POST") {
        const data = await readJson(req);
        const day = parseInteger(data && data.day, "day");
        const { title, body, bookId } = parseNote(data);
        const now = Date.now();
        const info = stmt.insert.run(day, title, body, bookId ?? null, now, now);
        sendJson(res, 201, stmt.get.get(info.lastInsertRowid));
        return true;
    }

    if (parts.length === 3) {
        const id = parseInteger(parts[2], "id");

        // PUT /api/notes/:id  { title?, body }
        if (method === "PUT") {
            const data = await readJson(req);
            const { title, body, bookId } = parseNote(data);
            const existing = stmt.get.get(id);
            if (!existing) {
                throw new HttpError(404, "Note not found");
            }
            stmt.update.run(
                title, body, bookId === undefined ? existing.book_id : bookId, Date.now(), id
            );
            sendJson(res, 200, stmt.get.get(id));
            return true;
        }

        // DELETE /api/notes/:id
        if (method === "DELETE") {
            const info = stmt.remove.run(id);
            if (info.changes === 0) {
                throw new HttpError(404, "Note not found");
            }
            sendJson(res, 200, { ok: true });
            return true;
        }
    }

    throw new HttpError(405, "Method not allowed");
};
