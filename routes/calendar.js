"use strict";

// Calendar day notes API.

const { db } = require("../lib/db");
const books = require("../lib/books");
const { applyHidden } = require("../lib/visibility");
const calendar = require("../lib/calendar");
const { excerpt } = require("../lib/html");
const { HttpError, sendJson, readJson, parseInteger } = require("../lib/http");

// A note with the book it is assigned to (if any).
const NOTE_SELECT = `
    SELECT n.id, n.day, n.title, n.body, n.book_id, n.hidden,
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
        "UPDATE notes SET day = ?, title = ?, body = ?, book_id = ?, updated_at = ? WHERE id = ?"
    ),
    remove: db.prepare("DELETE FROM notes WHERE id = ?"),
    inRange: db.prepare("SELECT id, day, title, body FROM notes WHERE day BETWEEN ? AND ? ORDER BY day, id"),
    moveDay: db.prepare("UPDATE notes SET day = ?, updated_at = ? WHERE id = ?")
};

// How a note reads in a list of exceptions: its title, else the start of its text.
const noteName = (note) => note.title || excerpt(note.body, 40);

// A year number from a request: a whole number from 1 up.
function parseYear(value, label) {
    const year = Number(value);

    if (!Number.isSafeInteger(year) || year < 1 || year > 1000000) {
        throw new HttpError(400, `Invalid ${label} year`);
    }

    return year;
}

// Moves every note in year `from` to the same month and day-in-month of year
// `to`. A day past the end of the new month is shortened to its last day; a
// note whose month has no days in the new year stays where it is. With
// `dryRun` nothing is changed, so the caller can preview. All-or-nothing.
const moveYear = db.transaction((from, to, dryRun) => {
    const range = calendar.yearDayRange(from);
    const notes = stmt.inRange.all(range.first, range.last);
    const updates = [];
    const shortened = [];
    const blocked = [];

    for (const note of notes) {
        const date = calendar.describeDay(note.day);
        const plan = calendar.planDayInYear(to, date.monthIndex, date.dayInMonth);

        if (!plan.ok) {
            blocked.push({ id: note.id, title: noteName(note), monthName: date.monthName, dayInMonth: date.dayInMonth });
            continue;
        }

        updates.push([plan.day, note.id]);

        if (plan.clamped) {
            shortened.push({
                id: note.id,
                title: noteName(note),
                monthName: date.monthName,
                dayInMonth: date.dayInMonth,
                movedToDay: plan.dayInMonth
            });
        }
    }

    if (!dryRun) {
        const now = Date.now();
        for (const [day, id] of updates) {
            stmt.moveDay.run(day, now, id);
        }
    }

    return { from, to, dryRun, total: notes.length, moving: updates.length, shortened, blocked };
});

// Validates a note payload; returns { day, title, body, bookId }. `bookId` is
// null (no book), a book's id, or undefined when the payload doesn't mention
// a book (so an update leaves the assignment alone). `day` is likewise
// undefined unless the payload names one (an update with a day moves the note).
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

    const day = data.day === undefined ? undefined : parseInteger(data.day, "day");

    return { day, title: title || null, body, bookId };
}

module.exports = async function calendarRoutes(req, res, url) {
    if (!url.pathname.startsWith("/api/notes")) {
        return false;
    }

    const parts = url.pathname.split("/").filter(Boolean); // ["api", "notes", ...]
    const method = req.method;

    // POST /api/notes/move-year  { from, to, dryRun? }  -> what moved (or would)
    if (parts.length === 3 && parts[2] === "move-year" && method === "POST") {
        const data = await readJson(req);
        const from = parseYear(data && data.from, "source");
        const to = parseYear(data && data.to, "target");

        if (from === to) {
            throw new HttpError(400, "Choose a different year to move the notes to");
        }

        sendJson(res, 200, moveYear(from, to, data.dryRun === true));
        return true;
    }

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
        const { title, body, bookId } = parseNote(data); // (day comes from above)
        const now = Date.now();
        const info = stmt.insert.run(day, title, body, bookId ?? null, now, now);
        applyHidden("notes", info.lastInsertRowid, data);
        sendJson(res, 201, stmt.get.get(info.lastInsertRowid));
        return true;
    }

    if (parts.length === 3) {
        const id = parseInteger(parts[2], "id");

        // PUT /api/notes/:id  { title?, body, day?, book_id? }  (day moves the note)
        if (method === "PUT") {
            const data = await readJson(req);
            const { day, title, body, bookId } = parseNote(data);
            const existing = stmt.get.get(id);
            if (!existing) {
                throw new HttpError(404, "Note not found");
            }
            stmt.update.run(
                day === undefined ? existing.day : day,
                title,
                body,
                bookId === undefined ? existing.book_id : bookId,
                Date.now(),
                id
            );
            applyHidden("notes", id, data);
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
