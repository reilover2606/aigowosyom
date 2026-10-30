"use strict";

// Lore (encyclopedia) data access: categories and the pages inside them.

const { db } = require("./db");
const { HttpError } = require("./http");
const { parseColor, resolveColor } = require("./color");
const { sanitizeHtml, htmlToText, excerpt } = require("./html");

const RESERVED_SLUGS = ["editor", "search", "random", "api"];
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

// Lowercases, strips diacritics and punctuation: "The Fall of Kyōra!" ->
// "the-fall-of-kyora". Also used to match [[category|Page Title]] links.
function slugify(text) {
    return String(text ?? "")
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80)
        .replace(/-+$/g, "");
}

function fold(text) {
    return String(text)
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .normalize("NFC")
        .toLowerCase();
}

const stmt = {
    categories: db.prepare(`
        SELECT c.*, (SELECT COUNT(*) FROM lore_pages WHERE category_id = c.id) AS page_count
        FROM lore_categories c
        ORDER BY c.name COLLATE NOCASE
    `),
    categoryById: db.prepare("SELECT * FROM lore_categories WHERE id = ?"),
    categoryBySlug: db.prepare("SELECT * FROM lore_categories WHERE slug = ?"),
    categoryInsert: db.prepare(`
        INSERT INTO lore_categories (slug, name, description, color, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
    `),
    categoryUpdate: db.prepare(`
        UPDATE lore_categories SET slug = ?, name = ?, description = ?, color = ?, updated_at = ?
        WHERE id = ?
    `),
    categoryDelete: db.prepare("DELETE FROM lore_categories WHERE id = ?"),
    categoryPageCount: db.prepare("SELECT COUNT(*) AS n FROM lore_pages WHERE category_id = ?"),

    pageById: db.prepare(`
        SELECT p.*, c.slug AS category_slug, c.name AS category_name, c.color AS category_color
        FROM lore_pages p JOIN lore_categories c ON c.id = p.category_id
        WHERE p.id = ?
    `),
    pageBySlug: db.prepare(`
        SELECT p.*, c.slug AS category_slug, c.name AS category_name, c.color AS category_color
        FROM lore_pages p JOIN lore_categories c ON c.id = p.category_id
        WHERE c.slug = ? AND p.slug = ?
    `),
    pageSlugTaken: db.prepare("SELECT id FROM lore_pages WHERE category_id = ? AND slug = ?"),
    pageInsert: db.prepare(`
        INSERT INTO lore_pages (category_id, slug, title, sort_key, body, body_text, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    pageUpdate: db.prepare(`
        UPDATE lore_pages SET category_id = ?, slug = ?, title = ?, sort_key = ?, body = ?, body_text = ?,
                              updated_at = ?
        WHERE id = ?
    `),
    pageDelete: db.prepare("DELETE FROM lore_pages WHERE id = ?"),
    pageBrief: db.prepare(
        "SELECT id, slug, title FROM lore_pages WHERE category_id = ? ORDER BY sort_key, id"
    ),

    ftsDelete: db.prepare("DELETE FROM lore_fts WHERE page_id = ?"),
    ftsInsert: db.prepare(
        "INSERT INTO lore_fts (page_id, title, body) SELECT id, title, body_text FROM lore_pages WHERE id = ?"
    )
};

function withColor(row, prefix = "") {
    if (row) {
        const { color, ink } = resolveColor(row[`${prefix}color`]);
        row[`${prefix}display_color`] = color;
        row[`${prefix}ink`] = ink;
    }
    return row;
}

// ------------------------------------------------------
// Categories
// ------------------------------------------------------

function text(value, label, max) {
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value !== "string") {
        throw new HttpError(400, `${label} must be text`);
    }
    const trimmed = value.trim();
    if (trimmed.length > max) {
        throw new HttpError(400, `${label} is too long`);
    }
    return trimmed || null;
}

function listCategories() {
    return stmt.categories.all().map((row) => withColor(row));
}

function getCategory(id) {
    return withColor(stmt.categoryById.get(id));
}

function getCategoryBySlug(slug) {
    return withColor(stmt.categoryBySlug.get(slug));
}

function parseCategory(data) {
    if (!data || typeof data !== "object") {
        throw new HttpError(400, "Invalid category");
    }

    const slug = text(data.slug, "Slug", 40);
    if (!slug || !SLUG_PATTERN.test(slug) || RESERVED_SLUGS.includes(slug)) {
        throw new HttpError(
            400,
            "Slug must use lowercase letters, digits and hyphens, and not be a reserved word " +
                `(${RESERVED_SLUGS.join(", ")})`
        );
    }

    const name = text(data.name, "Name", 100);
    if (!name) {
        throw new HttpError(400, "Category name is required");
    }

    let color;
    try {
        color = parseColor(data.color);
    } catch (error) {
        throw new HttpError(400, error.message);
    }

    return { slug, name, description: text(data.description, "Description", 5000), color };
}

function uniqueGuard(fn, message) {
    try {
        return fn();
    } catch (error) {
        if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
            throw new HttpError(409, message);
        }
        throw error;
    }
}

function createCategory(data) {
    const c = parseCategory(data);
    const now = Date.now();
    const info = uniqueGuard(
        () => stmt.categoryInsert.run(c.slug, c.name, c.description, c.color, now, now),
        "A category with that slug already exists"
    );
    return getCategory(info.lastInsertRowid);
}

function updateCategory(id, data) {
    const c = parseCategory(data);
    const info = uniqueGuard(
        () => stmt.categoryUpdate.run(c.slug, c.name, c.description, c.color, Date.now(), id),
        "A category with that slug already exists"
    );
    if (info.changes === 0) {
        throw new HttpError(404, "Category not found");
    }
    return getCategory(id);
}

function deleteCategory(id) {
    if (!getCategory(id)) {
        throw new HttpError(404, "Category not found");
    }
    if (stmt.categoryPageCount.get(id).n > 0) {
        throw new HttpError(409, "This category still has pages. Delete or move them first.");
    }
    stmt.categoryDelete.run(id);
}

// ------------------------------------------------------
// Pages
// ------------------------------------------------------

function loadPage(row) {
    if (!row) {
        return null;
    }
    row.category_color = withColor({ color: row.category_color }).display_color;
    row.category_ink = resolveColor(row.category_color).ink;
    row.excerpt = excerpt(row.body_text);
    return row;
}

function getPage(id) {
    return loadPage(stmt.pageById.get(id));
}

function getPageBySlug(categorySlug, slug) {
    return loadPage(stmt.pageBySlug.get(categorySlug, slug));
}

// For [[category|Page Title]] links: matches by slug or by slugified title.
function findPageForLink(categorySlug, textOrSlug) {
    const wanted = slugify(textOrSlug);
    return wanted ? stmt.pageBySlug.get(categorySlug, wanted) || null : null;
}

function listPageBrief(categoryId) {
    return stmt.pageBrief.all(categoryId);
}

function indexPage(id) {
    stmt.ftsDelete.run(id);
    stmt.ftsInsert.run(id);
}

// A slug not yet used in the category: "the-war", "the-war-2", ...
function freeSlug(categoryId, base, exceptId = null) {
    const root = base || "page";
    let candidate = root;

    for (let n = 2; ; n++) {
        const taken = stmt.pageSlugTaken.get(categoryId, candidate);
        if (!taken || taken.id === exceptId) {
            return candidate;
        }
        candidate = `${root}-${n}`;
    }
}

// Creates (id === null) or updates a page. On update, `data.category_id`
// may move the page to another category.
const savePage = db.transaction((id, data) => {
    if (!data || typeof data !== "object") {
        throw new HttpError(400, "Invalid page");
    }

    const existing = id === null ? null : stmt.pageById.get(id);
    if (id !== null && !existing) {
        throw new HttpError(404, "Page not found");
    }

    const categoryId = Number(data.category_id ?? existing?.category_id);
    if (!Number.isSafeInteger(categoryId) || !getCategory(categoryId)) {
        throw new HttpError(400, "Category does not exist");
    }

    const title = text(data.title, "Title", 200);
    if (!title) {
        throw new HttpError(400, "Title is required");
    }
    if (/[\r\n]/.test(title)) {
        throw new HttpError(400, "Title must be a single line");
    }

    // An explicit slug must be valid and free; otherwise derive one.
    const given = text(data.slug, "Slug", 80);
    let slug;
    if (given) {
        if (!SLUG_PATTERN.test(given)) {
            throw new HttpError(400, "Slug must use lowercase letters, digits and hyphens");
        }
        const taken = stmt.pageSlugTaken.get(categoryId, given);
        if (taken && taken.id !== id) {
            throw new HttpError(409, "Another page in this category already uses that slug");
        }
        slug = given;
    } else if (existing && existing.category_id === categoryId) {
        slug = existing.slug; // keep the URL stable when none is supplied
    } else {
        slug = freeSlug(categoryId, slugify(title), id);
    }

    if (typeof data.body !== "string" && data.body !== undefined && data.body !== null) {
        throw new HttpError(400, "Body must be text");
    }
    const body = sanitizeHtml(data.body ?? "");
    const bodyText = htmlToText(body);
    const now = Date.now();

    if (id === null) {
        id = stmt.pageInsert.run(categoryId, slug, title, fold(title), body, bodyText, now, now)
            .lastInsertRowid;
    } else {
        stmt.pageUpdate.run(categoryId, slug, title, fold(title), body, bodyText, now, id);
    }

    indexPage(id);
    return id;
});

const deletePage = db.transaction((id) => {
    stmt.ftsDelete.run(id);
    if (stmt.pageDelete.run(id).changes === 0) {
        throw new HttpError(404, "Page not found");
    }
});

const PAGE_ORDER = {
    alpha: "p.sort_key, p.id",
    updated: "p.updated_at DESC, p.id DESC"
};

const PAGE_COLUMNS = `p.id, p.slug, p.title, p.updated_at, p.category_id,
    c.slug AS category_slug, c.name AS category_name, c.color AS category_color,
    substr(p.body_text, 1, 400) AS body_start`;

function summarize(row) {
    row.excerpt = excerpt(row.body_start);
    delete row.body_start;
    const { color, ink } = resolveColor(row.category_color);
    row.category_color = color;
    row.category_ink = ink;
    return row;
}

// A category's pages, alphabetical or most recently updated first.
function listPages(categoryId, { sort = "alpha", limit = 200, offset = 0 } = {}) {
    const total = stmt.categoryPageCount.get(categoryId).n;
    const items = db
        .prepare(`
            SELECT ${PAGE_COLUMNS}
            FROM lore_pages p JOIN lore_categories c ON c.id = p.category_id
            WHERE p.category_id = ?
            ORDER BY ${PAGE_ORDER[sort] || PAGE_ORDER.alpha}
            LIMIT ? OFFSET ?
        `)
        .all(categoryId, limit, offset)
        .map(summarize);

    return { total, items };
}

// ------------------------------------------------------
// Search and random
// ------------------------------------------------------

// Prefix-matching FTS5 query from free text, or null if empty.
function ftsQuery(query) {
    const tokens = String(query).match(/[\p{L}\p{N}\p{M}]+/gu);
    return tokens ? tokens.map((token) => `"${token}"*`).join(" ") : null;
}

const MARK_START = "\u0001";
const MARK_END = "\u0002";

// Searches titles and bodies. Titles that match exactly come first, then
// by relevance (titles weigh more than body text). Each result carries a
// snippet in which matches are wrapped in \u0001 ... \u0002 (escape before
// turning those into markup).
const SEARCH_ORDER = {
    relevance: "(p.sort_key = @exact) DESC, bm25(lore_fts, 0, 8, 1), p.sort_key",
    alpha: "p.sort_key, p.id",
    updated: "p.updated_at DESC, p.id DESC"
};

function searchPages(
    query,
    { categoryId = null, limit = 30, offset = 0, order = "relevance" } = {}
) {
    const match = ftsQuery(query);

    if (!match) {
        return [];
    }

    const filter = categoryId === null ? "" : "AND p.category_id = @category";

    return db
        .prepare(`
            SELECT ${PAGE_COLUMNS},
                   snippet(lore_fts, 2, @open, @close, '…', 20) AS snippet
            FROM lore_fts
            JOIN lore_pages p ON p.id = lore_fts.page_id
            JOIN lore_categories c ON c.id = p.category_id
            WHERE lore_fts MATCH @match ${filter}
            ORDER BY ${SEARCH_ORDER[order] || SEARCH_ORDER.relevance}
            LIMIT @limit OFFSET @offset
        `)
        .all({
            match,
            open: MARK_START,
            close: MARK_END,
            exact: fold(String(query).trim()),
            limit,
            offset,
            ...(categoryId === null ? {} : { category: categoryId })
        })
        .map(summarize);
}

// Pages whose folded title (or slug) equals the folded query.
function exactTitleMatches(query) {
    const wanted = fold(String(query).trim());

    return db
        .prepare(`
            SELECT p.slug, c.slug AS category_slug
            FROM lore_pages p JOIN lore_categories c ON c.id = p.category_id
            WHERE p.sort_key = ? ORDER BY p.id LIMIT 2
        `)
        .all(wanted);
}

// A uniformly random page, optionally within one category, avoiding
// `exceptId` when there is any other choice.
function randomPage(categoryId = null, exceptId = null) {
    const conditions = [];
    const params = [];

    if (categoryId !== null) {
        conditions.push("p.category_id = ?");
        params.push(categoryId);
    }

    const count = (extra, extraParams) => {
        const all = [...conditions, ...extra];
        return db
            .prepare(`SELECT COUNT(*) AS n FROM lore_pages p ${all.length ? "WHERE " + all.join(" AND ") : ""}`)
            .get(...params, ...extraParams).n;
    };

    let extra = [];
    let extraParams = [];

    if (exceptId !== null && count(["p.id != ?"], [exceptId]) > 0) {
        extra = ["p.id != ?"];
        extraParams = [exceptId];
    }

    const total = count(extra, extraParams);

    if (total === 0) {
        return null;
    }

    const where = [...conditions, ...extra];

    return db
        .prepare(`
            SELECT p.slug, c.slug AS category_slug
            FROM lore_pages p JOIN lore_categories c ON c.id = p.category_id
            ${where.length ? "WHERE " + where.join(" AND ") : ""}
            ORDER BY p.id LIMIT 1 OFFSET ?
        `)
        .get(...params, ...extraParams, Math.floor(Math.random() * total));
}

module.exports = {
    RESERVED_SLUGS,
    MARK_START,
    MARK_END,
    slugify,
    listCategories,
    getCategory,
    getCategoryBySlug,
    createCategory,
    updateCategory,
    deleteCategory,
    getPage,
    getPageBySlug,
    findPageForLink,
    listPageBrief,
    listPages,
    savePage,
    deletePage,
    searchPages,
    exactTitleMatches,
    randomPage
};
