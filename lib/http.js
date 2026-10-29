"use strict";

const MAX_BODY_BYTES = 1024 * 1024;

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function send(res, status, contentType, payload) {
    res.writeHead(status, {
        "Content-Type": contentType,
        "Content-Length": Buffer.byteLength(payload)
    });
    res.end(payload);
}

function sendJson(res, status, data) {
    send(res, status, "application/json; charset=utf-8", JSON.stringify(data));
}

function sendHtml(res, status, html) {
    send(res, status, "text/html; charset=utf-8", html);
}

function redirect(res, location, status = 302) {
    res.writeHead(status, { Location: location });
    res.end();
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

// Parses a value that must be a safe integer (ids, civil day numbers).
function parseInteger(value, label = "value") {
    const n = typeof value === "string" && value.trim() === "" ? NaN : Number(value);

    if (!Number.isSafeInteger(n)) {
        throw new HttpError(400, `Invalid ${label}`);
    }

    return n;
}

module.exports = {
    HttpError,
    sendJson,
    sendHtml,
    redirect,
    readJson,
    parseInteger
};
