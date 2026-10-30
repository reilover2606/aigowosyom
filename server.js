"use strict";

const http = require("node:http");
const { db } = require("./lib/db");
const { HttpError, sendJson, sendHtml } = require("./lib/http");
const { esc, layout } = require("./lib/render");

const PORT = Number(process.env.PORT) || 3000;
const HOST = "127.0.0.1"; // local only

// Each handler returns true if it handled the request. Static files
// come last and always handle it.
const handlers = [
    require("./routes/calendar"),
    require("./routes/dictionary-api"),
    require("./routes/dictionary-pages"),
    require("./routes/lore-api"),
    require("./routes/lore-pages"),
    require("./lib/static")
];

function sendError(req, res, url, status, message) {
    if (url && url.pathname.startsWith("/api/")) {
        sendJson(res, status, { error: message });
    } else if (url && (url.pathname.startsWith("/dictionary") || url.pathname.startsWith("/lore"))) {
        const section = url.pathname.startsWith("/lore") ? "lore" : "dictionary";
        sendHtml(
            res,
            status,
            layout({
                section,
                title: message,
                search: { q: "" },
                body: `<main class="content"><h1>${esc(message)}</h1><p><a href="/${section}">Back to ${section === "lore" ? "the lore" : "the dictionary"}</a></p></main>`
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
    console.log(`Aigowosyom running at http://localhost:${PORT}`);
});

process.on("SIGINT", () => {
    db.close();
    process.exit(0);
});
