"use strict";

// Calendar day notes API.

const { db } = require("../lib/db");
const { HttpError, sendJson, readJson, parseInteger } = require("../lib/http");

const stmt = {
    byDay: db.prepare(
        "SELECT id, day, title, body FROM notes WHERE day = ? ORDER BY id"
    ),
    counts: db.prepare(
        "SELECT day, COUNT(*) AS n FROM notes WHERE day BETWEEN ? AND ? GROUP BY day"
    ),
    get: db.prepare("SELECT id, day, title, body FROM notes WHERE id = ?"),
    insert: db.prepare(
        "INSERT INTO notes (day, title, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    ),
    update: db.prepare(
        "UPDATE notes SET title = ?, body = ?, updated_at = ? WHERE id = ?"
    ),
    remove: db.prepare("DELETE FROM notes WHERE id = ?")
};

// Validates a note payload; returns { title, body }.
function parseNote(data) {
    if (!data || typeof data !== "object") {
        throw new HttpError(400, "Invalid note");
    }

    const body = typeof data.body === "string" ? data.body.trim() : "";
    if (!body) {
        throw new HttpError(400, "Note body is required");
    }

    const title = typeof data.title === "string" ? data.title.trim() : "";

    return { title: title || null, body };
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
        const { title, body } = parseNote(data);
        const now = Date.now();
        const info = stmt.insert.run(day, title, body, now, now);
        sendJson(res, 201, stmt.get.get(info.lastInsertRowid));
        return true;
    }

    if (parts.length === 3) {
        const id = parseInteger(parts[2], "id");

        // PUT /api/notes/:id  { title?, body }
        if (method === "PUT") {
            const data = await readJson(req);
            const { title, body } = parseNote(data);
            const info = stmt.update.run(title, body, Date.now(), id);
            if (info.changes === 0) {
                throw new HttpError(404, "Note not found");
            }
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
