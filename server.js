"use strict";

const config = require("./lib/config");
const { RESTART_CODE } = require("./lib/publish-codes");

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
const { HttpError, sendJson, sendHtml } = require("./lib/http");
const { esc, layout } = require("./lib/render");

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

const server = http.createServer(async (req, res) => {
    let url = null;

    try {
        url = new URL(req.url, `http://${req.headers.host}`);

        if (config.PUBLIC) {
            const refused = refusedWhenPublic(req, url);
            if (refused) {
                throw new HttpError(refused.status, refused.message);
            }
        }

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
