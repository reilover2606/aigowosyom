"use strict";

// Settings kept on this machine (data/settings.json, not in git): where the
// public instance lives and the shared secret used to publish to it.

const fs = require("node:fs");
const path = require("node:path");
const { DATA_DIR } = require("./config");
const { HttpError } = require("./http");

const FILE = path.join(DATA_DIR, "settings.json");

function read() {
    try {
        const data = JSON.parse(fs.readFileSync(FILE, "utf8"));
        return {
            publishUrl: typeof data.publishUrl === "string" ? data.publishUrl : "",
            token: typeof data.token === "string" ? data.token : ""
        };
    } catch {
        return { publishUrl: "", token: "" };
    }
}

// The token is never sent back to the page, only whether one is saved.
function publicView() {
    const { publishUrl, token } = read();
    return { publishUrl, tokenSet: Boolean(token) };
}

// Normalizes a site address: http(s) only, no path, query or trailing slash.
function parseAddress(value) {
    const text = typeof value === "string" ? value.trim() : "";

    if (!text) {
        return "";
    }

    let url;
    try {
        url = new URL(text);
    } catch {
        throw new HttpError(400, "That doesn't look like a web address (try https://example.org)");
    }

    if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new HttpError(400, "The address must start with https:// (or http://)");
    }

    return url.origin + url.pathname.replace(/\/+$/, "");
}

// `data.token`: a new token; absent or blank keeps the saved one.
// `data.clearToken`: forget it.
function save(data) {
    if (!data || typeof data !== "object") {
        throw new HttpError(400, "Invalid settings");
    }

    const current = read();
    const next = { publishUrl: parseAddress(data.publishUrl), token: current.token };

    if (data.clearToken) {
        next.token = "";
    } else if (typeof data.token === "string" && data.token.trim()) {
        next.token = data.token.trim();
    }

    fs.writeFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
    return publicView();
}

module.exports = { read, publicView, save };
