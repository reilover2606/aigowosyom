"use strict";

const config = require("./lib/config");
const { RESTART_CODE, SETUP_PROBLEM_CODE } = require("./lib/publish-codes");

// A public instance runs under a small supervisor, so that when a newly
// published database has been swapped in, the worker can exit and be started
// again on it. (Under systemd or Docker the same restart happens there, too.)
if (config.PUBLIC && !process.env.AIGOWOSYOM_WORKER) {
    const { spawn } = require("node:child_process");
    let child = null;
    let stopping = false;

    const start = () => {
        child = spawn(process.execPath, [__filename], {
            stdio: "inherit",
            env: { ...process.env, AIGOWOSYOM_WORKER: "1" }
        });
        child.on("exit", (code) => {
            if (code === SETUP_PROBLEM_CODE) {
                process.exit(code); // it has said what is wrong; starting it again won't help
            }
            if (!stopping) {
                setTimeout(start, code === RESTART_CODE ? 0 : 2000);
            }
        });
    };

    for (const signal of ["SIGINT", "SIGTERM"]) {
        process.on(signal, () => {
            stopping = true;
            if (child) {
                child.kill(signal);
            }
            process.exit(0);
        });
    }

    start();
    return;
}

const http = require("node:http");
const { db } = require("./lib/db");
require("./lib/eras").syncIfChanged(); // era pages for the lore section (editor only)
require("./lib/books").ensureBooksCategory(); // the built-in Books category (editor only)
require("./lib/maps").syncStateSlugs(); // state pages' slugs follow their names (editor only)
require("./lib/species").ensureCategories(); // the built-in Flora and Fauna categories (editor only)
const { HttpError, sendJson, sendHtml } = require("./lib/http");
const { esc, layout } = require("./lib/render");
const locks = require("./lib/locks");

const { PORT, HOST } = config;

// Each handler returns true if it handled the request. Static files
// come last and always handle it.
const handlers = [
    require("./routes/settings"),
    require("./routes/calendar"),
    require("./routes/maps-api"),
    require("./routes/maps-pages"),
    require("./routes/dictionary-api"),
    require("./routes/dictionary-pages"),
    require("./routes/lore-api"),
    require("./routes/lore-pages"),
    require("./routes/site"),
    require("./lib/static")
];

// What a public (read-only) instance refuses: anything that isn't a plain read
// (uploads of published databases are handled by routes/settings.js first),
// and the editor pages and scripts.
const EDITOR_PATHS = [
    /^\/(dictionary|lore|maps)\/editor(\/|$)/,
    /^\/assets\/(dictionary|lore)\/editor\.(js|css)$/,
    /^\/assets\/maps\/map-editor\.js$/
];

function refusedWhenPublic(req, url) {
    if (url.pathname === "/api/publish/receive") {
        return false;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
        return { status: 405, message: "This site is read-only" };
    }
    if (EDITOR_PATHS.some((pattern) => pattern.test(url.pathname))) {
        return { status: 404, message: "Not found" };
    }
    return false;
}

function sendError(req, res, url, status, message) {
    if (url && url.pathname.startsWith("/api/")) {
        sendJson(res, status, { error: message });
    } else if (url && (url.pathname.startsWith("/dictionary") || url.pathname.startsWith("/lore") || url.pathname.startsWith("/maps"))) {
        const section = url.pathname.startsWith("/lore") ? "lore" : url.pathname.startsWith("/maps") ? "maps" : "dictionary";
        sendHtml(
            res,
            status,
            layout({
                section,
                title: message,
                search: { q: "" },
                body: `<main class="content"><h1>${esc(message)}</h1><p><a href="/${section}">Back to ${section === "lore" ? "the lore" : section === "maps" ? "the maps" : "the dictionary"}</a></p></main>`
            })
        );
    } else {
        res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(message);
    }
}

// Slow requests and a blocked event loop are written to the console, so a stall can be traced to the
// server (and to which request) or ruled out. SLOW_MS (default 300) sets the threshold; 0 turns it off.
const SLOW_MS = process.env.SLOW_MS === undefined ? 300 : Number(process.env.SLOW_MS);

// The sizes of the database file and its write-ahead log (a log that has grown huge, because something
// else has the database open, makes every save slow), for the slow log and the startup line.
const fs = require("node:fs");
const pathModule = require("node:path");
function databaseSizes() {
    const size = (suffix) => {
        try {
            return fs.statSync(pathModule.join(config.DATA_DIR, `worldbuilding.db${suffix}`)).size;
        } catch {
            return 0;
        }
    };
    const mb = (bytes) => `${(bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0)} MB`;
    return { text: `database ${mb(size(""))}, write-ahead log ${mb(size("-wal"))}`, wal: size("-wal") };
}
{
    const sizes = databaseSizes();
    if (sizes.wal > 64 * 1048576) {
        console.warn(`[slow] the write-ahead log is large (${sizes.text}). Another program with the database open (a viewer, a backup or sync tool) can stop it being cleared, and that slows every save.`);
        try {
            db.pragma("wal_checkpoint(TRUNCATE)");
        } catch {
            // something else has it open: the warning above stands
        }
    }
}

if (SLOW_MS > 0) {
    let last = Date.now();
    setInterval(() => {
        const now = Date.now();
        // (A gap of many minutes is the computer asleep, not the server busy.)
        if (now - last - 100 > SLOW_MS && now - last < 120000) {
            console.warn(`[slow] the server was busy for ${now - last - 100} ms without answering anything (a long calculation)`);
        }
        last = now;
    }, 100).unref();
}

const server = http.createServer(async (req, res) => {
    let url = null;
    const started = Date.now();

    if (SLOW_MS > 0) {
        res.on("close", () => {
            const took = Date.now() - started;
            if (took > SLOW_MS) {
                console.warn(`[slow] ${req.method} ${req.url} took ${took} ms (${databaseSizes().text})`);
            }
        });
    }

    try {
        url = new URL(req.url, `http://${req.headers.host}`);

        if (config.PUBLIC) {
            const refused = refusedWhenPublic(req, url);
            if (refused) {
                throw new HttpError(refused.status, refused.message);
            }
        }

        // Delete locks (lib/locks.js): which items the editors must not delete.
        if (url.pathname === "/api/locks" && req.method === "GET") {
            sendJson(res, 200, locks.current());
            return;
        }
        locks.refuseIfLocked(req.method, url.pathname);

        for (const handler of handlers) {
            if (await handler(req, res, url)) {
                return;
            }
        }
    } catch (error) {
        if (res.headersSent) {
            res.end();
        } else if (error instanceof HttpError) {
            sendError(req, res, url, error.status, error.message);
        } else {
            console.error(error);
            sendError(req, res, url, 500, "Internal server error");
        }
    }
});

server.listen(PORT, HOST, () => {
    console.log(`Aigowosyom (${config.MODE} mode) running at http://${HOST === "127.0.0.1" ? "localhost" : HOST}:${PORT}`);
});

process.on("SIGINT", () => {
    db.close();
    process.exit(0);
});
