"use strict";

// Publishing: the editor instance sends a copy of its database, minus
// everything marked "do not publish", to a public (read-only) instance.
//
//   editor:  buildSnapshot() -> packSnapshot() -> publish() (HTTPS POST)
//   public:  receive() checks the signature and the database, swaps it in,
//            and asks the supervisor in server.js for a restart.
//
// The body is signed with HMAC-SHA256 using a shared secret, together with a
// timestamp so an intercepted upload can't be replayed later. The secret
// itself is never sent. The hidden rows are deleted from a copy before it
// leaves this machine, so they never travel.

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const Database = require("better-sqlite3");
const { db } = require("./db");
const config = require("./config");
const settings = require("./settings");
const { HttpError } = require("./http");

const ERAS_FILE = path.join(__dirname, "..", "public", "calendar", "eras.json");
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const { RESTART_CODE } = require("./publish-codes");
const REQUIRED_TABLES = ["notes", "languages", "words", "lore_categories", "lore_pages"];

// ------------------------------------------------------
// Building the copy (editor side)
// ------------------------------------------------------

// A state's lore page is withheld along with the state (or the map it is on).
const HIDDEN_PAGES = `hidden = 1 OR category_id IN (SELECT id FROM lore_categories WHERE hidden = 1)
    OR map_state_id IN (SELECT id FROM map_states WHERE hidden = 1 OR map_id IN (SELECT id FROM maps WHERE hidden = 1))`;
// Items on a map that is itself published (hiding a map hides everything on it).
const MAP_VISIBLE = `map_id IN (SELECT id FROM maps WHERE hidden = 0)`;
const HIDDEN_WORDS = `hidden = 1 OR language_id IN (SELECT id FROM languages WHERE hidden = 1)`;

// What marking something "do not publish" takes with it: hiding a category
// hides its pages, hiding a language hides its words. A note assigned to a
// hidden book stays, just no longer assigned to it.
function countHidden(c) {
    const n = (sql) => c.prepare(sql).get().n;

    return {
        notes: n("SELECT COUNT(*) AS n FROM notes WHERE hidden = 1"),
        lorePages: n(`SELECT COUNT(*) AS n FROM lore_pages WHERE ${HIDDEN_PAGES}`),
        loreCategories: n("SELECT COUNT(*) AS n FROM lore_categories WHERE hidden = 1"),
        words: n(`SELECT COUNT(*) AS n FROM words WHERE ${HIDDEN_WORDS}`),
        languages: n("SELECT COUNT(*) AS n FROM languages WHERE hidden = 1"),
        maps: n("SELECT COUNT(*) AS n FROM maps WHERE hidden = 1"),
        mapItems: n(`
            SELECT (SELECT COUNT(*) FROM map_states WHERE hidden = 1 AND ${MAP_VISIBLE})
                 + (SELECT COUNT(*) FROM map_points WHERE hidden = 1 AND ${MAP_VISIBLE})
                 + (SELECT COUNT(*) FROM map_features WHERE hidden = 1 AND ${MAP_VISIBLE}) AS n
        `)
    };
}

// What a publish would leave out right now (for the Settings page).
function hiddenSummary() {
    return countHidden(db);
}

async function buildSnapshot() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aigowosyom-publish-"));
    const file = path.join(dir, "snapshot.db");

    try {
        await db.backup(file); // a consistent copy while the app keeps running

        const copy = new Database(file);
        let omitted;

        try {
            copy.pragma("foreign_keys = ON");
            omitted = countHidden(copy);

            copy.transaction(() => {
                copy.exec(`
                    DELETE FROM notes WHERE hidden = 1;

                    DELETE FROM lore_fts WHERE page_id IN (SELECT id FROM lore_pages WHERE ${HIDDEN_PAGES});
                    DELETE FROM lore_pages WHERE ${HIDDEN_PAGES};
                    DELETE FROM lore_categories WHERE hidden = 1;

                    DELETE FROM words_fts WHERE word_id IN (SELECT id FROM words WHERE ${HIDDEN_WORDS});
                    DELETE FROM words WHERE ${HIDDEN_WORDS};
                    DELETE FROM languages WHERE hidden = 1;

                    -- Maps: a hidden map takes its contents with it (cascade). Tracer
                    -- images are only for editing and are never published.
                    DELETE FROM maps WHERE hidden = 1;
                    DELETE FROM map_states WHERE hidden = 1;
                    DELETE FROM map_points WHERE hidden = 1;
                    DELETE FROM map_features WHERE hidden = 1;
                    DELETE FROM map_images;
                `);

                // A superstate whose clients were all left out has nothing left to be.
                // Its lore page goes with it: the state would not exist on the public site.
                const emptyGroups = copy.prepare(`
                    SELECT id FROM map_states
                    WHERE geometry = '[]' AND id NOT IN (SELECT parent_id FROM map_states WHERE parent_id IS NOT NULL)
                `).pluck();
                for (let ids = emptyGroups.all(); ids.length > 0; ids = emptyGroups.all()) {
                    for (const id of ids) {
                        copy.prepare("DELETE FROM lore_fts WHERE page_id IN (SELECT id FROM lore_pages WHERE map_state_id = ?)").run(id);
                        omitted.lorePages += copy.prepare("DELETE FROM lore_pages WHERE map_state_id = ?").run(id).changes;
                        copy.prepare("DELETE FROM map_states WHERE id = ?").run(id);
                    }
                }

                // Corners that no remaining state uses.
                const used = new Set();
                for (const { geometry } of copy.prepare("SELECT geometry FROM map_states").all()) {
                    JSON.parse(geometry).forEach((polygon) => polygon.forEach((ring) => ring.forEach((id) => used.add(id))));
                }
                const drop = copy.prepare("DELETE FROM map_vertices WHERE id = ?");
                for (const { id } of copy.prepare("SELECT id FROM map_vertices").all()) {
                    if (!used.has(id)) {
                        drop.run(id);
                    }
                }
            })();

            // Deleted rows linger in the search indexes until they are merged, so
            // merge them: hidden text must not survive anywhere in the file.
            for (const index of ["notes_fts", "lore_fts", "words_fts"]) {
                copy.exec(`INSERT INTO ${index} (${index}) VALUES ('optimize')`);
            }

            // One self-contained file, with the deleted content truly gone.
            copy.pragma("journal_mode = DELETE");
            copy.exec("VACUUM");
        } finally {
            copy.close();
        }

        return { data: fs.readFileSync(file), omitted };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// [4 bytes: header length][header JSON][database bytes], gzipped.
function pack(header, data) {
    const json = Buffer.from(JSON.stringify(header), "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(json.length);
    return zlib.gzipSync(Buffer.concat([length, json, data]));
}

function unpack(body) {
    let raw;
    try {
        raw = zlib.gunzipSync(body, { maxOutputLength: MAX_UPLOAD_BYTES });
    } catch {
        throw new HttpError(400, "The upload could not be decompressed");
    }

    const length = raw.length >= 4 ? raw.readUInt32BE(0) : 0;
    if (!length || 4 + length > raw.length) {
        throw new HttpError(400, "The upload is malformed");
    }

    let header;
    try {
        header = JSON.parse(raw.subarray(4, 4 + length).toString("utf8"));
    } catch {
        throw new HttpError(400, "The upload is malformed");
    }

    return { header, data: raw.subarray(4 + length) };
}

function sign(token, timestamp, body) {
    return crypto.createHmac("sha256", token).update(`${timestamp}.`).update(body).digest("hex");
}

// ------------------------------------------------------
// Sending (editor side)
// ------------------------------------------------------

function endpointFor(address) {
    const url = new URL(address);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);

    if (url.protocol !== "https:" && !local) {
        throw new HttpError(
            400,
            "Publishing needs an https:// address (plain http is only allowed for this machine itself), " +
                "so the database isn't sent in the clear."
        );
    }

    return `${address}/api/publish/receive`;
}

async function publish() {
    const { publishUrl, token } = settings.read();

    if (!publishUrl) {
        throw new HttpError(400, "Set the public site's address first.");
    }
    if (!token) {
        throw new HttpError(400, "Set the shared secret token first.");
    }

    const endpoint = endpointFor(publishUrl);
    const { data, omitted } = await buildSnapshot();
    const erasText = fs.existsSync(ERAS_FILE) ? fs.readFileSync(ERAS_FILE, "utf8") : null;
    const body = pack({ eras: erasText, sentAt: Date.now() }, data);
    const timestamp = String(Date.now());

    let response;
    try {
        response = await fetch(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/octet-stream",
                "X-Publish-Timestamp": timestamp,
                "X-Publish-Signature": sign(token, timestamp, body)
            },
            body,
            signal: AbortSignal.timeout(120000)
        });
    } catch (error) {
        throw new HttpError(502, `Could not reach ${publishUrl}: ${error.cause?.code || error.message}`);
    }

    let result = null;
    try {
        result = await response.json();
    } catch { /* not JSON */ }

    if (!response.ok) {
        const reason = response.status === 401
            ? "The public site rejected the token. Check that both sides have the same one."
            : (result && result.error) || `The public site answered ${response.status}.`;
        throw new HttpError(502, reason);
    }

    return { bytes: body.length, omitted, publishedAt: Date.now() };
}

// ------------------------------------------------------
// Receiving (public side)
// ------------------------------------------------------

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;

        req.on("data", (chunk) => {
            size += chunk.length;
            if (size > MAX_UPLOAD_BYTES) {
                reject(new HttpError(413, "The upload is too large"));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
    });
}

function verify(req, body) {
    const token = config.PUBLISH_TOKEN;
    const timestamp = String(req.headers["x-publish-timestamp"] || "");
    const given = String(req.headers["x-publish-signature"] || "");
    const expected = token ? sign(token, timestamp, body) : "";
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    const fresh = Math.abs(Date.now() - Number(timestamp)) <= MAX_CLOCK_SKEW_MS;

    if (!token || !fresh || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return false;
    }

    return true;
}

// The file must be a healthy database with the tables the site needs.
function checkDatabase(file) {
    let check;

    try {
        check = new Database(file, { readonly: true, fileMustExist: true });
    } catch {
        throw new HttpError(400, "The upload is not a database");
    }

    try {
        const integrity = check.pragma("integrity_check", { simple: true });
        const tables = new Set(check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all());

        if (integrity !== "ok" || !REQUIRED_TABLES.every((t) => tables.has(t))) {
            throw new HttpError(400, "The uploaded database failed its checks");
        }
    } catch (error) {
        throw error instanceof HttpError ? error : new HttpError(400, "The uploaded database failed its checks");
    } finally {
        check.close();
    }
}

function replaceFile(target, content) {
    const temp = `${target}.incoming`;
    fs.writeFileSync(temp, content);
    fs.renameSync(temp, target);
}

// POST /api/publish/receive. Verified, checked, swapped in; the worker then
// exits so the supervisor starts it again on the new database.
async function receive(req, res, sendJson) {
    if (!config.PUBLISH_TOKEN) {
        throw new HttpError(404, "Not found");
    }

    const body = await readBody(req);

    if (!verify(req, body)) {
        await new Promise((resolve) => setTimeout(resolve, 500)); // slow down guessing
        throw new HttpError(401, "Not authorized");
    }

    const { header, data } = unpack(body);
    const live = path.join(config.DATA_DIR, "worldbuilding.db");
    const incoming = `${live}.incoming`;

    fs.writeFileSync(incoming, data);

    try {
        checkDatabase(incoming);
    } catch (error) {
        fs.rmSync(incoming, { force: true });
        throw error;
    }

    // Era data first (the calendar page reads it directly), then the database.
    if (typeof header.eras === "string" && header.eras !== (fs.existsSync(ERAS_FILE) ? fs.readFileSync(ERAS_FILE, "utf8") : null)) {
        JSON.parse(header.eras);
        replaceFile(ERAS_FILE, header.eras);
    }

    db.close();

    if (fs.existsSync(live)) {
        fs.copyFileSync(live, `${live}.previous`);
    }
    fs.renameSync(incoming, live);
    fs.rmSync(`${live}-wal`, { force: true });
    fs.rmSync(`${live}-shm`, { force: true });

    sendJson(res, 200, { ok: true, bytes: data.length });
    res.on("finish", () => process.exit(RESTART_CODE));
}

module.exports = { RESTART_CODE, hiddenSummary, buildSnapshot, publish, receive };
