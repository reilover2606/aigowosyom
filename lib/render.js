"use strict";

// HTML helpers: escaping, page layout, and [[link]] markup.

const dict = require("./dictionary");

function esc(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function entryUrl(slug, headword) {
    return `/dictionary/${encodeURIComponent(slug)}/${encodeURIComponent(headword)}`;
}

function languageUrl(slug) {
    return `/dictionary/${encodeURIComponent(slug)}/`;
}

// Headword as displayed: reconstructed languages get a leading "*".
function displayHeadword(headword, isProto) {
    return isProto ? `*${headword}` : headword;
}

// Page shell with the top bar shared by the dictionary and the editor.
//   active: "dictionary" | "editor"
function layout({ title, body, active = "dictionary", search = null, scripts = [] }) {
    const searchForm = search
        ? `<form class="topbar-search" action="/dictionary/search" method="get" role="search">
               <input type="search" name="q" value="${esc(search.q)}" placeholder="Search dictionary" aria-label="Search dictionary">
               <button type="submit">Search</button>
           </form>`
        : "";

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/assets/dictionary/dictionary.css">
${active === "editor" ? '<link rel="stylesheet" href="/assets/dictionary/editor.css">' : ""}
</head>
<body class="page-${esc(active)}">
<header class="topbar">
    <a class="brand" href="/">Aigowosyom</a>
    <nav>
        <a href="/dictionary"${active === "dictionary" ? ' class="active"' : ""}>Dictionary</a>
        <a href="/dictionary/editor"${active === "editor" ? ' class="active"' : ""}>Editor</a>
    </nav>
    ${searchForm}
</header>
${body}
${(search ? ["/assets/dictionary/suggest.js", ...scripts] : scripts)
    .map((src) => `<script src="${esc(src)}"></script>`)
    .join("\n")}
</body>
</html>`;
}

// Matches [[target]] and [[target|display text]].
const LINK_PATTERN = /\[\[([^\[\]|]+?)(?:\|([^\[\]]+?))?\]\]/g;

function plainText(text) {
    return esc(text).replace(/\r?\n/g, "<br>");
}

// Renders plain text with [[lang:word]] / [[word]] / [[lang:word|text]]
// links. A bare [[word]] refers to the entry's own language
// (`defaultSlug`). Links to entries that don't exist get a "missing" style.
function renderText(text, defaultSlug) {
    if (!text) {
        return "";
    }

    let html = "";
    let last = 0;

    for (const match of text.matchAll(LINK_PATTERN)) {
        html += plainText(text.slice(last, match.index));
        last = match.index + match[0].length;

        let target = match[1].trim();
        let slug = defaultSlug;
        const colon = target.indexOf(":");

        if (colon > 0) {
            const candidate = target.slice(0, colon).trim();
            if (dict.getLanguageBySlug(candidate)) {
                slug = candidate;
                target = target.slice(colon + 1).trim();
            }
        }

        const language = slug ? dict.getLanguageBySlug(slug) : null;
        const label = match[2]
            ? match[2].trim()
            : displayHeadword(target, language && language.is_proto);
        const missing = !dict.wordExists(slug, target);

        html += `<a href="${entryUrl(slug || "", target)}"${
            missing ? ' class="missing" title="No entry yet"' : ""
        }>${esc(label)}</a>`;
    }

    return html + plainText(text.slice(last));
}

module.exports = {
    esc,
    entryUrl,
    languageUrl,
    displayHeadword,
    layout,
    renderText
};
