"use strict";

// JSON API used by the dictionary editor.

const dict = require("../lib/dictionary");
const { HttpError, sendJson, readJson, parseInteger } = require("../lib/http");

const PREFIX = "/api/dictionary/";

function clampInt(value, fallback, min, max) {
    // A missing parameter is null, and Number(null) would be 0.
    const n = value === null || value === "" ? NaN : Number(value);
    if (!Number.isInteger(n)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, n));
}

module.exports = async function dictionaryApi(req, res, url) {
    if (!url.pathname.startsWith(PREFIX)) {
        return false;
    }

    const parts = url.pathname.slice(PREFIX.length).split("/").filter(Boolean);
    const method = req.method;
    const [resource, rawId] = parts;
    const params = url.searchParams;

    if (parts.length > 2) {
        throw new HttpError(404, "Not found");
    }

    // ---- Languages ----------------------------------------------------
    if (resource === "languages") {
        if (parts.length === 1 && method === "GET") {
            sendJson(res, 200, dict.listLanguages());
            return true;
        }

        if (parts.length === 1 && method === "POST") {
            sendJson(res, 201, dict.createLanguage(await readJson(req)));
            return true;
        }

        if (parts.length === 2) {
            const id = parseInteger(rawId, "id");

            if (method === "PUT") {
                sendJson(res, 200, dict.updateLanguage(id, await readJson(req)));
                return true;
            }

            if (method === "DELETE") {
                dict.deleteLanguage(id);
                sendJson(res, 200, { ok: true });
                return true;
            }
        }
    }

    // ---- Words --------------------------------------------------------
    if (resource === "words") {
        // GET /words?language=&q=&offset=&limit=
        if (parts.length === 1 && method === "GET") {
            const languageId = parseInteger(params.get("language"), "language");
            const q = (params.get("q") || "").trim();
            const limit = clampInt(params.get("limit"), 200, 1, 500);
            const offset = clampInt(params.get("offset"), 0, 0, 1e9);

            if (q) {
                const items = dict.searchWords(q, { languageId, limit: 200 });
                sendJson(res, 200, { total: items.length, items });
            } else {
                sendJson(res, 200, dict.listWords(languageId, { limit, offset }));
            }
            return true;
        }

        // POST /words  { language_id, ...word }
        if (parts.length === 1 && method === "POST") {
            const data = await readJson(req);
            const id = dict.saveWord(
                null,
                parseInteger(data && data.language_id, "language"),
                data
            );
            sendJson(res, 201, dict.loadWord(id));
            return true;
        }

        if (parts.length === 2) {
            const id = parseInteger(rawId, "id");

            if (method === "GET") {
                const word = dict.loadWord(id);
                if (!word) {
                    throw new HttpError(404, "Word not found");
                }
                sendJson(res, 200, word);
                return true;
            }

            if (method === "PUT") {
                dict.saveWord(id, null, await readJson(req));
                sendJson(res, 200, dict.loadWord(id));
                return true;
            }

            if (method === "DELETE") {
                dict.deleteWord(id);
                sendJson(res, 200, { ok: true });
                return true;
            }
        }
    }

    // ---- Word picker --------------------------------------------------
    // GET /search-words?q=&language=
    if (resource === "search-words" && parts.length === 1 && method === "GET") {
        const q = (params.get("q") || "").trim();
        const languageParam = params.get("language");
        const languageId = languageParam ? parseInteger(languageParam, "language") : null;

        sendJson(res, 200, dict.searchWords(q, { languageId, limit: 10 }));
        return true;
    }

    throw new HttpError(404, "Not found");
};
