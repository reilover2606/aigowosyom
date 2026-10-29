"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const PORT = Number(process.env.PORT) || 3000;
const HOST = "127.0.0.1"; // local only
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const MAX_BODY_BYTES = 1024 * 1024;

// ======================================================
// DATABASE
// ======================================================

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "worldbuilding.db"));
db.pragma("journal_mode = WAL");

// `day` is the civil day number: days since 1970-01-01 UTC,
// the same integer the calendar uses internally.
db.exec(`
    CREATE TABLE IF NOT EXISTS notes (
        id         INTEGER PRIMARY KEY,
        day        INTEGER NOT NULL,
        title      TEXT,
        body       TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notes_day ON notes (day);
`);

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

// ======================================================
// HELPERS
// ======================================================

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function sendJson(res, status, data) {
    const payload = JSON.stringify(data);
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(payload)
    });
    res.end(payload);
}

function readJson(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;

        req.on("data", (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(new HttpError(413, "Request body too large"));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });

        req.on("end", () => {
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch {
                reject(new HttpError(400, "Invalid JSON"));
            }
        });

        req.on("error", reject);
    });
}

function parseDay(value) {
    const n = Number(value);
    if (!Number.isSafeInteger(n)) {
        throw new HttpError(400, "Invalid day");
    }
    return n;
}

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

// ======================================================
// API
// ======================================================

async function handleApi(req, res, url) {
    const parts = url.pathname.split("/").filter(Boolean); // ["api", "notes", ...]
    const method = req.method;

    if (parts[1] !== "notes") {
        throw new HttpError(404, "Not found");
    }

    // GET /api/notes/counts?from=&to=  ->  { "<day>": count, ... }
    if (parts.length === 3 && parts[2] === "counts" && method === "GET") {
        const from = parseDay(url.searchParams.get("from"));
        const to = parseDay(url.searchParams.get("to"));
        const counts = {};
        for (const row of stmt.counts.all(from, to)) {
            counts[row.day] = row.n;
        }
        return sendJson(res, 200, counts);
    }

    // GET /api/notes?day=
    if (parts.length === 2 && method === "GET") {
        const day = parseDay(url.searchParams.get("day"));
        return sendJson(res, 200, stmt.byDay.all(day));
    }

    // POST /api/notes  { day, title?, body }
    if (parts.length === 2 && method === "POST") {
        const data = await readJson(req);
        const day = parseDay(data && data.day);
        const { title, body } = parseNote(data);
        const now = Date.now();
        const info = stmt.insert.run(day, title, body, now, now);
        return sendJson(res, 201, stmt.get.get(info.lastInsertRowid));
    }

    if (parts.length === 3) {
        const id = parseDay(parts[2]);

        // PUT /api/notes/:id  { title?, body }
        if (method === "PUT") {
            const data = await readJson(req);
            const { title, body } = parseNote(data);
            const info = stmt.update.run(title, body, Date.now(), id);
            if (info.changes === 0) {
                throw new HttpError(404, "Note not found");
            }
            return sendJson(res, 200, stmt.get.get(id));
        }

        // DELETE /api/notes/:id
        if (method === "DELETE") {
            const info = stmt.remove.run(id);
            if (info.changes === 0) {
                throw new HttpError(404, "Note not found");
            }
            return sendJson(res, 200, { ok: true });
        }
    }

    throw new HttpError(405, "Method not allowed");
}

// ======================================================
// STATIC FILES
// ======================================================

const MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon"
};

function serveStatic(req, res, url) {
    if (req.method !== "GET" && req.method !== "HEAD") {
        throw new HttpError(405, "Method not allowed");
    }

    let pathname;
    try {
        pathname = decodeURIComponent(url.pathname);
    } catch {
        throw new HttpError(400, "Bad path");
    }

    if (pathname.endsWith("/")) {
        pathname += "index.html";
    }

    const filePath = path.join(PUBLIC_DIR, pathname);
    if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
        throw new HttpError(403, "Forbidden");
    }

    fs.readFile(filePath, (err, content) => {
        if (err) {
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Not found");
            return;
        }

        res.writeHead(200, {
            "Content-Type":
                MIME_TYPES[path.extname(filePath).toLowerCase()] ||
                "application/octet-stream",
            "Cache-Control": "no-cache"
        });
        res.end(req.method === "HEAD" ? undefined : content);
    });
}

// ======================================================
// SERVER
// ======================================================

const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);

        if (url.pathname.startsWith("/api/")) {
            await handleApi(req, res, url);
        } else {
            serveStatic(req, res, url);
        }
    } catch (error) {
        if (error instanceof HttpError) {
            sendJson(res, error.status, { error: error.message });
        } else {
            console.error(error);
            sendJson(res, 500, { error: "Internal server error" });
        }
    }
});

server.listen(PORT, HOST, () => {
    console.log(`Tanakōdeyam running at http://localhost:${PORT}`);
});

process.on("SIGINT", () => {
    db.close();
    process.exit(0);
});
