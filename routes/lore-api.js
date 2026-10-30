"use strict";

// JSON API used by the lore editor.

const lore = require("../lib/lore");
const eras = require("../lib/eras");
const books = require("../lib/books");
const { HttpError, sendJson, readJson, parseInteger } = require("../lib/http");
const { stripLinkSyntax } = require("../lib/html");

const PREFIX = "/api/lore/";

function clampInt(value, fallback, min, max) {
    const n = value === null || value === "" ? NaN : Number(value);
    return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

// Search hits without the \u0001/\u0002 match markers.
function plainSnippet(row) {
    if (row.snippet !== undefined) {
        row.snippet = stripLinkSyntax(row.snippet).replace(/[\u0001\u0002]/g, "");
    }
    return row;
}

// A page for the editor; era pages also carry the calendar notes in their span.
function pageJson(id) {
    const page = lore.getPage(id);

    if (page) {
        page.is_era = page.era_start_year !== null;
        page.era = page.is_era ? eras.eraNotes(page.era_start_year) : null;
        // Pages in the Books category are books: they carry their assigned notes.
        page.is_book = page.category_system_key === books.CATEGORY_KEY;
        page.book = page.is_book ? books.bookNotes(id) : null;
    }

    return page;
}

module.exports = async function loreApi(req, res, url) {
    if (!url.pathname.startsWith(PREFIX)) {
        return false;
    }

    eras.syncIfChanged();

    const parts = url.pathname.slice(PREFIX.length).split("/").filter(Boolean);
    const method = req.method;
    const [resource, rawId] = parts;
    const params = url.searchParams;

    if (parts.length > 2) {
        throw new HttpError(404, "Not found");
    }

    // ---- Categories ---------------------------------------------------
    if (resource === "categories") {
        if (parts.length === 1 && method === "GET") {
            sendJson(res, 200, lore.listCategories());
            return true;
        }

        if (parts.length === 1 && method === "POST") {
            sendJson(res, 201, lore.createCategory(await readJson(req)));
            return true;
        }

        if (parts.length === 2) {
            const id = parseInteger(rawId, "id");

            if (method === "PUT") {
                sendJson(res, 200, lore.updateCategory(id, await readJson(req)));
                return true;
            }

            if (method === "DELETE") {
                lore.deleteCategory(id);
                sendJson(res, 200, { ok: true });
                return true;
            }
        }
    }

    // ---- Books (for the calendar's "assign to a book" list) -----------
    if (resource === "books" && parts.length === 1 && method === "GET") {
        sendJson(res, 200, books.listBooks());
        return true;
    }

    // ---- Pages --------------------------------------------------------
    if (resource === "pages") {
        // GET /pages?category=&q=&sort=alpha|updated&offset=&limit=
        if (parts.length === 1 && method === "GET") {
            const categoryId = parseInteger(params.get("category"), "category");
            const q = (params.get("q") || "").trim();
            const sort = params.get("sort") === "updated" ? "updated" : "alpha";

            if (q) {
                const items = lore.searchPages(q, { categoryId, limit: 200, order: sort }).map(plainSnippet);
                sendJson(res, 200, { total: items.length, items });
            } else {
                sendJson(
                    res,
                    200,
                    lore.listPages(categoryId, {
                        sort,
                        limit: clampInt(params.get("limit"), 200, 1, 500),
                        offset: clampInt(params.get("offset"), 0, 0, 1e9)
                    })
                );
            }
            return true;
        }

        // POST /pages  { category_id, title, slug?, body }
        if (parts.length === 1 && method === "POST") {
            const id = lore.savePage(null, await readJson(req));
            sendJson(res, 201, pageJson(id));
            return true;
        }

        if (parts.length === 2) {
            const id = parseInteger(rawId, "id");

            if (method === "GET") {
                const page = pageJson(id);
                if (!page) {
                    throw new HttpError(404, "Page not found");
                }
                sendJson(res, 200, page);
                return true;
            }

            if (method === "PUT") {
                lore.savePage(id, await readJson(req));
                sendJson(res, 200, pageJson(id));
                return true;
            }

            if (method === "DELETE") {
                lore.deletePage(id);
                sendJson(res, 200, { ok: true });
                return true;
            }
        }
    }

    // ---- Suggestions (editor link picker, public live search) ---------
    // GET /search-pages?q=
    if (resource === "search-pages" && parts.length === 1 && method === "GET") {
        const q = (params.get("q") || "").trim();
        sendJson(res, 200, lore.searchPages(q, { limit: 10 }).map(plainSnippet));
        return true;
    }

    throw new HttpError(404, "Not found");
};
