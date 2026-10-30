"use strict";

// Site-wide search: /search (results page) and /api/search/suggest (live
// suggestions on the home page). Searches the dictionary, lore and calendar.

const dict = require("../lib/dictionary");
const lore = require("../lib/lore");
const sitesearch = require("../lib/sitesearch");
const { HttpError, sendHtml, sendJson } = require("../lib/http");
const { esc, langBadge, layout, snippetHtml } = require("../lib/render");
const { excerpt } = require("../lib/html");

const GROUP_LIMIT = 10;

// "12" or "10+" when the list was cut off at the limit.
const count = (n) => (n >= GROUP_LIMIT ? `${GROUP_LIMIT}+` : String(n));

function groupHeading(title, n, moreHref) {
    return `<h2 class="search-group">${esc(title)} <span class="muted">${count(n)}</span>${
        n >= GROUP_LIMIT ? ` <a class="search-more" href="${moreHref}">See all →</a>` : ""
    }</h2>`;
}

function searchPage(res, url) {
    const q = (url.searchParams.get("q") || "").trim();

    const words = q ? dict.searchWords(q, { limit: GROUP_LIMIT }) : [];
    const pages = q ? lore.searchPages(q, { limit: GROUP_LIMIT }) : [];
    const notes = q ? sitesearch.searchNotes(q, { limit: GROUP_LIMIT }) : [];
    const encoded = encodeURIComponent(q);
    const total = words.length + pages.length + notes.length;

    const wordRows = words
        .map(
            (w) => `<li>
            <a class="conlang" href="/dictionary/${encodeURIComponent(w.language_slug)}/${encodeURIComponent(w.headword)}">${esc(
                w.language_is_proto ? `*${w.headword}` : w.headword
            )}</a>
            ${w.sinographs ? `<span class="sinographs conlang">${esc(w.sinographs)}</span>` : ""}
            ${langBadge(w.language_name, w.language_color, w.language_ink)}
            ${w.pos ? `<span class="pos-tag">${esc(w.pos)}</span>` : ""}
            <span class="gloss">${esc(excerpt(w.gloss || "", 140))}</span>
        </li>`
        )
        .join("");

    const pageRows = pages
        .map(
            (p) => `<li>
            <a href="/lore/${encodeURIComponent(p.category_slug)}/${encodeURIComponent(p.slug)}">${esc(p.title)}</a>
            ${langBadge(p.category_name, p.category_color, p.category_ink)}
            <span class="gloss search-snippet">${snippetHtml(p.snippet || p.excerpt)}</span>
        </li>`
        )
        .join("");

    const noteRows = notes
        .map((n) => {
            const when = [
                n.eraLabel,
                n.monthLabel ? `<span${n.monthIsNative ? ' class="conlang"' : ""}>${esc(n.monthLabel)} ${n.dayInMonth}</span>` : null
            ]
                .filter(Boolean)
                .join(" · ");

            return `<li>
            <a href="${n.year ? `/calendar/?year=${n.year}` : "/calendar/"}">${esc(n.title || excerpt(n.body, 60))}</a>
            <span class="muted">${when}${n.gregorian ? ` · ${esc(n.gregorian)}` : ""}</span>
            <span class="gloss search-snippet">${snippetHtml(n.snippet)}</span>
        </li>`;
        })
        .join("");

    const body = !q
        ? '<p class="muted">Enter a word, a name, or something from a page or a calendar note.</p>'
        : total === 0
          ? `<p>No results for “${esc(q)}”.</p>`
          : `<p class="muted">Searching the dictionary, the lore and the calendar's notes for “${esc(q)}”. Diacritics are ignored.</p>
    ${
        words.length
            ? `<section>${groupHeading("Dictionary", words.length, `/dictionary/search?q=${encoded}&go=0`)}<ul class="word-list search-results">${wordRows}</ul></section>`
            : ""
    }
    ${
        pages.length
            ? `<section>${groupHeading("Lore", pages.length, `/lore/search?q=${encoded}&go=0`)}<ul class="lore-list search-results">${pageRows}</ul></section>`
            : ""
    }
    ${
        notes.length
            ? `<section>${groupHeading("Calendar notes", notes.length, "/calendar/")}<ul class="lore-list search-results">${noteRows}</ul></section>`
            : ""
    }`;

    sendHtml(
        res,
        200,
        layout({
            section: "site",
            title: q ? `Search: ${q}` : "Search",
            search: { q },
            body: `<main class="content">
    <h1>Search</h1>
    ${body}
</main>`
        })
    );
}

module.exports = async function siteRoutes(req, res, url) {
    if (url.pathname === "/api/search/suggest") {
        if (req.method !== "GET") {
            throw new HttpError(405, "Method not allowed");
        }
        const q = (url.searchParams.get("q") || "").trim();
        sendJson(res, 200, q ? sitesearch.suggest(q) : []);
        return true;
    }

    if (url.pathname === "/search") {
        if (req.method !== "GET" && req.method !== "HEAD") {
            throw new HttpError(405, "Method not allowed");
        }
        searchPage(res, url);
        return true;
    }

    return false;
};
