"use strict";

// Server-rendered, read-only lore pages (a small encyclopedia).

const Icons = require("../public/assets/icons.js");
const lore = require("../lib/lore");
const dict = require("../lib/dictionary");
const eras = require("../lib/eras");
const books = require("../lib/books");
const maps = require("../lib/maps");
const { calendarUrl } = require("../lib/notes");
const { HttpError, sendHtml, redirect, parseInteger } = require("../lib/http");
const appConfig = require("../lib/config");
const { esc, ifEditing, langVars, langBadge, layout, renderText, renderLoreHtml } = require("../lib/render");
const { stripLinkSyntax } = require("../lib/html");

const SEARCH_LIMIT = 50;

const pageUrl = (categorySlug, pageSlug) =>
    `/lore/${encodeURIComponent(categorySlug)}/${encodeURIComponent(pageSlug)}`;
const categoryUrl = (categorySlug) => `/lore/${encodeURIComponent(categorySlug)}/`;

function loreLayout(options) {
    return layout({ section: "lore", search: { q: "" }, ...options });
}

// A category's color as page-level CSS variables.
const categoryVars = (category) => langVars(category.display_color, category.ink);

// ------------------------------------------------------
// Pages
// ------------------------------------------------------

function homePage(res) {
    const categories = lore.listCategories();
    const total = categories.reduce((sum, c) => sum + c.page_count, 0);

    const cards = categories.length
        ? categories
              .map(
                  (c) => `
        <a class="language-card" href="${categoryUrl(c.slug)}" style="${categoryVars(c)}">
            <span class="language-card-name">${esc(c.name)}</span>
            <span class="language-card-meta">${c.page_count} ${c.page_count === 1 ? "page" : "pages"}</span>
            ${c.description ? `<span class="category-blurb">${esc(((d) => (d.length > 110 ? d.slice(0, 110) + "…" : d))(stripLinkSyntax(c.description)))}</span>` : ""}
        </a>`
              )
              .join("")
        : `<p class="muted">No categories yet.${ifEditing(' Add one in the <a href="/lore/editor">editor</a>.')}</p>`;

    sendHtml(
        res,
        200,
        loreLayout({
            title: "Lore",
            body: `<main class="content">
    <h1>Lore</h1>
    <p class="muted">Search above, or choose a category to browse.</p>
    ${
        total
            ? `<p><a class="button-link" href="/lore/random">${Icons.svg("dice")} Random page</a></p>`
            : ""
    }
    <div class="language-grid">${cards}</div>
</main>`
        })
    );
}

function categoryPage(res, category) {
    const { total, items } = lore.listPages(category.id, { limit: 1000 });

    const list = items.length
        ? `<ul class="lore-list">${items
              .map(
                  (page) => `<li>
            <a href="${pageUrl(category.slug, page.slug)}">${esc(page.title)}</a>
            ${page.excerpt ? `<span class="gloss">${esc(page.excerpt)}</span>` : ""}
        </li>`
              )
              .join("")}</ul>`
        : '<p class="muted">No pages in this category yet.</p>';

    sendHtml(
        res,
        200,
        loreLayout({
            title: `${category.name} – Lore`,
            body: `<main class="content language-page" style="${categoryVars(category)}">
    <p class="crumbs"><a href="/lore">Lore</a> › ${esc(category.name)}</p>
    <h1>${esc(category.name)}</h1>
    ${category.description ? `<p class="language-notes">${renderText(category.description, null)}</p>` : ""}
    <p class="muted">${total} ${total === 1 ? "page" : "pages"}${
        total
            ? ` · <a href="/lore/random?category=${encodeURIComponent(category.slug)}">Random page</a>`
            : ""
    }</p>
    ${list}
</main>`
        })
    );
}

// Calendar notes grouped by year (years without notes are left out), each
// with the calendar date it fell on. Used under an era page's text and under
// a book's text. `groups` come from lib/notes.js; `showBook` adds a link to
// the book a note belongs to (not needed on the book's own page).
function notesSectionHtml({ heading, intro, emptyText, groups, showBook = false }) {
    if (groups.length === 0) {
        return `<section class="era-notes"><h2>${esc(heading)}</h2>${intro}<p class="muted">${emptyText}</p></section>`;
    }

    const body = groups
        .map(
            (group) => `<h3 class="era-year"><a href="/calendar/?year=${group.year}" title="Universal year ${group.year}">${esc(group.label)}</a></h3>
        <ul class="era-note-list">${group.notes
            .map(
                (note) => `<li>
            <div class="era-note-date"><a${note.monthIsNative ? ' class="conlang"' : ""} href="${esc(calendarUrl(group.year, note))}">${esc(note.monthLabel)} ${note.dayInMonth}</a> <span class="muted">· ${esc(note.gregorian)}</span></div>
            ${note.title ? `<div class="era-note-title">${esc(note.title)}</div>` : ""}
            <div class="era-note-body">${esc(note.body).replace(/\r?\n/g, "<br>")}</div>
            ${showBook && note.book ? `<div class="era-note-book">${Icons.svg("book")} <a href="${esc(note.book.url)}">${esc(note.book.title)}</a></div>` : ""}
        </li>`
            )
            .join("")}</ul>`
        )
        .join("");

    return `<section class="era-notes"><h2>${esc(heading)}</h2>${intro}${body}</section>`;
}

// The notes inside an era.
function eraNotesHtml(era) {
    const span = era.lengthYears === null
        ? `${esc(era.name)} from year 1 on`
        : `${esc(era.name)} years 1–${era.lengthYears}`;

    return notesSectionHtml({
        heading: "Calendar notes",
        intro: `<p class="muted">Notes written in the <a href="/calendar/?year=${era.startYear}">calendar</a> for ${span}, in date order.
        A year shared with a neighbouring era appears in both.${ifEditing(" Edit them in the calendar.")}</p>`,
        emptyText: "No calendar notes fall within this era yet.",
        groups: era.groups,
        showBook: true
    });
}

// The notes assigned to a book.
function bookNotesHtml(book) {
    return notesSectionHtml({
        heading: "Notes",
        intro: `<p class="muted">Notes added to this book from the <a href="/calendar/">calendar</a>, in date order.
        ${ifEditing("Add, edit or reassign them there.")}</p>`,
        emptyText: `No notes have been added to this book yet.${ifEditing(" Assign a note to it from the calendar.")}`,
        groups: book.groups
    });
}

function articlePage(res, category, page) {
    const siblings = lore.listPageBrief(category.id);

    // Dictionary entries with the same name as this page.
    const words = dict.findWordsByTitleKey(lore.fold(page.title));
    const dictionaryLinks = words.length
        ? `<p class="lore-also">In the dictionary: ${words
              .map(
                  (w) =>
                      `<a class="also-link" href="/dictionary/${encodeURIComponent(w.language_slug)}/${encodeURIComponent(w.headword)}">${langBadge(w.language_name, w.language_color, w.language_ink)} <span class="conlang">${esc(w.language_is_proto ? "*" + w.headword : w.headword)}</span></a>`
              )
              .join(" · ")}</p>`
        : "";

    // A page in the Books category is a book: its own text (which may be
    // blank) is followed by the calendar notes assigned to it.
    const isBook = category.system_key === books.CATEGORY_KEY;
    const book = isBook ? books.bookNotes(page.id) : null;

    // Era pages show the span they cover and the calendar notes inside it.
    const stateInfo = page.map_state_id !== null ? maps.stateInfo(page.map_state_id) : null;
    const stateLine = stateInfo
        ? `<p class="era-span">A state on the map <a href="/maps/${encodeURIComponent(stateInfo.map_slug)}?state=${stateInfo.id}">${esc(stateInfo.map_name)}</a></p>`
        : "";
    const era = page.era_start_year !== null ? eras.eraNotes(page.era_start_year) : null;
    const eraSpan = era
        ? `<p class="era-span">${
              era.lengthYears === null ? `From year 1 of ${esc(era.name)}` : `${esc(era.name)} years 1–${era.lengthYears}`
          } · <a href="/calendar/?year=${era.startYear}">Open in the calendar</a></p>`
        : "";

    const aside = `<aside class="lore-aside" aria-label="Pages in ${esc(category.name)}">
        <h2><a href="${categoryUrl(category.slug)}">${esc(category.name)}</a></h2>
        <ul>${siblings
            .map(
                (s) =>
                    `<li${s.id === page.id ? ' class="current"' : ""}>${
                        s.id === page.id
                            ? esc(s.title)
                            : `<a href="${pageUrl(category.slug, s.slug)}">${esc(s.title)}</a>`
                    }</li>`
            )
            .join("")}</ul>
        <p><a class="button-link small" href="/lore/random?category=${encodeURIComponent(category.slug)}&amp;from=${encodeURIComponent(page.slug)}">${Icons.svg("dice")} Random ${esc(category.name)} page</a></p>
    </aside>`;

    sendHtml(
        res,
        200,
        loreLayout({
            title: `${page.title} – ${category.name} – Lore`,
            body: `<main class="content wide entry-page" style="${categoryVars(category)}">
    <p class="crumbs"><a href="/lore">Lore</a> › <a href="${categoryUrl(category.slug)}">${esc(category.name)}</a></p>
    <div class="lore-layout">
        <article class="lore-article">
            <h1>${esc(page.title)}</h1>
            <p class="lore-category">${langBadge(category.name, category.display_color, category.ink, categoryUrl(category.slug))}</p>
            ${eraSpan}
            ${stateLine}
            ${dictionaryLinks}
            ${
                page.body
                    ? `<div class="lore-body">${renderLoreHtml(page.body)}</div>`
                    : isBook
                      ? "" // a book's own text is optional
                      : '<div class="lore-body"><p class="muted">This page has no content yet.</p></div>'
            }
            ${era ? eraNotesHtml(era) : ""}
            ${book ? bookNotesHtml(book) : ""}
        </article>
        ${aside}
    </div>
</main>`
        })
    );
}

function missingPage(res, category, slug) {
    sendHtml(
        res,
        404,
        loreLayout({
            title: `${slug} – ${category.name} – Lore`,
            body: `<main class="content" style="${categoryVars(category)}">
    <p class="crumbs"><a href="/lore">Lore</a> › <a href="${categoryUrl(category.slug)}">${esc(category.name)}</a></p>
    <h1>${esc(slug)}</h1>
    <p>There is no page called “${esc(slug)}” in ${esc(category.name)}.</p>
    <p>${ifEditing('<a href="/lore/editor">Create it in the editor</a> or ')}<a href="${categoryUrl(category.slug)}">${appConfig.PUBLIC ? "Browse" : "browse"} ${esc(category.name)}</a>.</p>
</main>`
        })
    );
}

// Search snippet: escape first, then turn the match markers into <mark>.
function snippetHtml(snippet) {
    return esc(stripLinkSyntax(snippet).replace(/\s+/g, " "))
        .split(lore.MARK_START).join("<mark>")
        .split(lore.MARK_END).join("</mark>");
}

function searchPage(res, url) {
    const q = (url.searchParams.get("q") || "").trim();
    const categoryParam = url.searchParams.get("category");
    const categoryId = categoryParam ? parseInteger(categoryParam, "category") : null;
    const categories = lore.listCategories();

    // Like Wikipedia, an unambiguous exact title goes straight to its page.
    if (q && url.searchParams.get("go") !== "0" && categoryId === null) {
        const exact = lore.exactTitleMatches(q);
        if (exact.length === 1) {
            redirect(res, pageUrl(exact[0].category_slug, exact[0].slug));
            return;
        }
    }

    const results = q ? lore.searchPages(q, { categoryId, limit: SEARCH_LIMIT }) : [];

    const rows = results
        .map(
            (r) => `<li>
            <a href="${pageUrl(r.category_slug, r.slug)}">${esc(r.title)}</a>
            ${langBadge(r.category_name, r.category_color, r.category_ink)}
            <span class="gloss search-snippet">${snippetHtml(r.snippet || r.excerpt)}</span>
        </li>`
        )
        .join("");

    sendHtml(
        res,
        200,
        layout({
            section: "lore",
            title: q ? `Search: ${q} – Lore` : "Search – Lore",
            search: { q },
            body: `<main class="content">
    <h1>Search</h1>
    <form class="search-filter" action="/lore/search" method="get">
        <input type="hidden" name="q" value="${esc(q)}">
        <input type="hidden" name="go" value="0">
        <label>Category:
            <select name="category" onchange="this.form.submit()">
                <option value="">All categories</option>
                ${categories
                    .map(
                        (c) =>
                            `<option value="${c.id}"${c.id === categoryId ? " selected" : ""}>${esc(c.name)}</option>`
                    )
                    .join("")}
            </select>
        </label>
    </form>
    ${
        !q
            ? '<p class="muted">Enter a title or something from the text of a page.</p>'
            : results.length
              ? `<p class="muted">${results.length}${results.length === SEARCH_LIMIT ? "+" : ""} result${
                    results.length === 1 ? "" : "s"
                } for “${esc(q)}”. Diacritics are ignored.</p>
    <ul class="lore-list search-results">${rows}</ul>`
              : `<p>No results for “${esc(q)}”.</p>`
    }
</main>`
        })
    );
}

function editorPage(res) {
    sendHtml(
        res,
        200,
        layout({
            section: "lore",
            title: "Lore editor",
            active: "editor",
            styles: ["/assets/lore/editor.css"],
            body: '<main id="editor" class="editor"><p class="muted">Loading…</p></main>',
            scripts: ["/assets/ui.js", "/assets/lore/editor.js"]
        })
    );
}

module.exports = async function lorePages(req, res, url) {
    const isLore = url.pathname === "/lore" || url.pathname.startsWith("/lore/");

    if (!isLore) {
        return false;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
        throw new HttpError(405, "Method not allowed");
    }

    eras.syncIfChanged();

    let parts;
    try {
        parts = url.pathname.split("/").filter(Boolean).slice(1).map(decodeURIComponent);
    } catch {
        throw new HttpError(400, "Bad path");
    }

    if (parts.length === 0) {
        if (url.pathname.endsWith("/")) {
            redirect(res, "/lore" + url.search, 301);
        } else {
            homePage(res);
        }
        return true;
    }

    const [first, second] = parts;

    if (first === "editor" && parts.length === 1) {
        editorPage(res);
        return true;
    }

    if (first === "search" && parts.length === 1) {
        searchPage(res, url);
        return true;
    }

    // /lore/random[?category=<slug>[&from=<page slug>]]
    if (first === "random" && parts.length === 1) {
        const slug = url.searchParams.get("category");
        let categoryId = null;
        let exceptId = null;

        if (slug) {
            const scope = lore.getCategoryBySlug(slug);
            if (!scope) {
                throw new HttpError(404, `No category “${slug}”`);
            }
            categoryId = scope.id;

            const from = url.searchParams.get("from");
            const current = from ? lore.getPageBySlug(slug, from) : null;
            exceptId = current ? current.id : null;
        }

        const target = lore.randomPage(categoryId, exceptId);
        res.setHeader("Cache-Control", "no-store");
        redirect(res, target ? pageUrl(target.category_slug, target.slug) : slug ? categoryUrl(slug) : "/lore");
        return true;
    }

    const category = lore.getCategoryBySlug(first);

    if (!category) {
        throw new HttpError(404, `No category “${first}”`);
    }

    if (parts.length === 1) {
        if (!url.pathname.endsWith("/")) {
            redirect(res, url.pathname + "/" + url.search, 301);
        } else {
            categoryPage(res, category);
        }
        return true;
    }

    if (parts.length === 2) {
        const page = lore.getPageBySlug(category.slug, second);
        if (page) {
            articlePage(res, category, page);
        } else {
            missingPage(res, category, second);
        }
        return true;
    }

    throw new HttpError(404, "Not found");
};
