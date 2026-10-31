"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { HttpError, redirect } = require("./http");

const { PUBLIC } = require("./config");
const PUBLIC_DIR = path.join(__dirname, "..", "public");

const MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon"
};

// Serves files from public/. Always handles the request.
module.exports = async function staticFiles(req, res, url) {
    if (req.method !== "GET" && req.method !== "HEAD") {
        throw new HttpError(405, "Method not allowed");
    }

    let pathname;
    try {
        pathname = decodeURIComponent(url.pathname);
    } catch {
        throw new HttpError(400, "Bad path");
    }

    let filePath = path.join(PUBLIC_DIR, pathname);
    if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
        throw new HttpError(403, "Forbidden");
    }

    try {
        const stat = await fs.stat(filePath);

        if (stat.isDirectory()) {
            // Directories need a trailing slash so relative URLs resolve.
            if (!pathname.endsWith("/")) {
                redirect(res, url.pathname + "/" + url.search, 301);
                return true;
            }
            filePath = path.join(filePath, "index.html");
        }

        let content = await fs.readFile(filePath);

        // A public site tells its hand-written pages, so they can hide editing controls.
        if (PUBLIC && path.extname(filePath).toLowerCase() === ".html") {
            content = Buffer.from(content.toString("utf8").replace("<html", '<html data-site-mode="public"'));
        }

        res.writeHead(200, {
            "Content-Type":
                MIME_TYPES[path.extname(filePath).toLowerCase()] ||
                "application/octet-stream",
            "Cache-Control": "no-cache"
        });
        res.end(req.method === "HEAD" ? undefined : content);
    } catch (error) {
        if (error instanceof HttpError) {
            throw error;
        }
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
    }

    return true;
};
