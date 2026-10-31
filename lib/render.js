"use strict";

// HTML helpers: escaping, page layout, and [[link]] markup.

const dict = require("./dictionary");
const lore = require("./lore");
const { decodeEntities, stripLinkSyntax } = require("./html");

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

// CSS custom properties that tint a page region with a language's color.
function langVars(color, ink) {
    return `--lang-color:${color};--lang-ink:${ink}`;
}

// A language-colored badge (a link when href is given).
function langBadge(name, color, ink, href = null) {
    const style = `--lang-bg:${color};--lang-fg:${ink}`;
    return href
        ? `<a class="lang-tag" href="${esc(href)}" style="${style}">${esc(name)}</a>`
        : `<span class="lang-tag" style="${style}">${esc(name)}</span>`;
}

// Sections of the site that share the top bar. `nav` entries are
// [key, href, label]; `key` is matched against a page's `active` value.
const SECTIONS = {
    site: {
        nav: [["main", "/search", "Search"]],
        searchAction: "/search",
        placeholder: "Search everything",
        styles: ["/assets/lore/lore.css"]
    },
    dictionary: {
        nav: [
            ["main", "/dictionary", "Dictionary"],
            ["editor", "/dictionary/editor", "Editor"]
        ],
        searchAction: "/dictionary/search",
        placeholder: "Search dictionary",
        styles: []
    },
    lore: {
        nav: [
            ["main", "/lore", "Lore"],
            ["editor", "/lore/editor", "Editor"]
        ],
        searchAction: "/lore/search",
        placeholder: "Search lore",
        styles: ["/assets/lore/lore.css"]
    }
};

// The slim bar along the very top of every page: one link to the top page of
// each section. `current` is "calendar" | "lore" | "dictionary" (or anything
// else, e.g. "site", to highlight none). Pages written by hand (the home page
// and the calendar) carry a copy of this markup with `float` set.
const SITE_LINKS = [
    ["calendar", "/calendar/", "Calendar"],
    ["lore", "/lore", "Lore"],
    ["dictionary", "/dictionary", "Dictionary"]
];

// Section links on the left, the theme picker (filled in by /assets/theme.js)
// on the right.
function siteBar(current, { float = false } = {}) {
    const links = SITE_LINKS.map(
        ([key, href, label]) =>
            `<a href="${href}"${key === current ? ' aria-current="page"' : ""}>${label}</a>`
    ).join("\n    ");

    return `<nav class="sitebar${float ? " sitebar-float" : ""}" aria-label="Sections of the site">
    ${links}
    <label class="theme-switch"><span>Theme</span><select id="themeSelect" aria-label="Theme"></select></label>
</nav>`;
}

// Search-result snippet: escape first, then turn the match markers into <mark>.
function snippetHtml(snippet) {
    return esc(stripLinkSyntax(snippet).replace(/\s+/g, " "))
        .split(lore.MARK_START).join("<mark>")
        .split(lore.MARK_END).join("</mark>");
}

// Page shell with the top bar shared by a section's public pages and editor.
//   section: "dictionary" | "lore"
//   active:  "main" | "editor" (which nav item is highlighted)
function layout({
    title,
    body,
    section = "dictionary",
    active = "main",
    search = null,
    scripts = [],
    styles = []
}) {
    const config = SECTIONS[section];

    const searchForm = search
        ? `<form class="topbar-search" action="${config.searchAction}" method="get" role="search" data-suggest="${section}">
               <input type="search" name="q" value="${esc(search.q)}" placeholder="${config.placeholder}" aria-label="${config.placeholder}">
               <button type="submit">Search</button>
           </form>`
        : "";

    const stylesheets = [
        "/assets/site.css",
        "/assets/dictionary/dictionary.css",
        ...(search ? ["/assets/suggest.css"] : []),
        ...config.styles,
        ...(active === "editor" ? ["/assets/dictionary/editor.css"] : []),
        ...styles,
        "/assets/themes/neumorph.css",
        "/assets/themes/dark.css" // last, so a theme can override everything above
    ];

    const nav = config.nav
        .map(
            ([key, href, label]) =>
                `<a href="${href}"${active === key ? ' class="active"' : ""}>${label}</a>`
        )
        .join("\n        ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<script src="/assets/theme.js"></script>
<script src="/assets/icons.js"></script>
${stylesheets.map((href) => `<link rel="stylesheet" href="${href}">`).join("\n")}
</head>
<body class="page-${esc(section)}-${esc(active)}">
${siteBar(section)}
<header class="topbar">
    <a class="brand" href="/">Aigowosyom</a>
    <nav>
        ${nav}
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

// ------------------------------------------------------
// [[links]]
// ------------------------------------------------------
//
//   [[word]]                     dictionary word, in the current language
//   [[lang:word]]                dictionary word in another language
//   [[lang:word|display text]]   ... with display text
//   [[category]]                 lore category
//   [[category|Page]]            lore page (matched by title or slug)
//   [[category|Page|display]]    ... with display text
//
// A first part that is the slug of an existing lore category wins over a
// dictionary word of the same spelling.

const LINK_PATTERN = /\[\[([^\[\]]+?)\]\]/g;

// Resolves the text inside [[ ]]. `defaultSlug` is the language a bare
// [[word]] belongs to; null means we're in lore text, where there is no
// default language. Returns { href, label, missing, conlang }.
function resolveLink(inner, defaultSlug) {
    const parts = inner.split("|").map((part) => part.trim());
    const target = parts[0];

    if (!target) {
        return null;
    }

    // Lore: a category (and optionally a page in it).
    if (!target.includes(":")) {
        const category = lore.getCategoryBySlug(target.toLowerCase());

        if (category) {
            if (parts.length === 1) {
                return { href: `/lore/${category.slug}/`, label: category.name, missing: false, conlang: false };
            }

            const page = lore.findPageForLink(category.slug, parts[1]);

            return {
                href: `/lore/${category.slug}/${page ? page.slug : lore.slugify(parts[1])}`,
                label: parts[2] || (page ? page.title : parts[1]),
                missing: !page,
                conlang: false
            };
        }

        // In lore text, an unknown first part is a (not yet existing) category.
        if (defaultSlug === null) {
            const categorySlug = lore.slugify(target);
            return {
                href: parts.length > 1
                    ? `/lore/${categorySlug}/${lore.slugify(parts[1])}`
                    : `/lore/${categorySlug}/`,
                label: parts[2] || parts[1] || target,
                missing: true,
                conlang: false
            };
        }
    }

    // Dictionary word.
    let word = target;
    let slug = defaultSlug;
    const colon = word.indexOf(":");

    if (colon > 0) {
        const candidate = word.slice(0, colon).trim();
        if (dict.getLanguageBySlug(candidate)) {
            slug = candidate;
            word = word.slice(colon + 1).trim();
        }
    }

    if (!slug) {
        // Lore text with an unknown language prefix: show it as a missing link.
        return { href: "/dictionary", label: parts[1] || target, missing: true, conlang: true };
    }

    const language = dict.getLanguageBySlug(slug);

    return {
        href: entryUrl(slug, word),
        label: parts[1] || displayHeadword(word, language && language.is_proto),
        missing: !dict.wordExists(slug, word),
        conlang: true
    };
}

function linkHtml(link) {
    const classes = [link.conlang ? "conlang" : "lore-link", link.missing ? "missing" : ""]
        .filter(Boolean)
        .join(" ");

    return `<a href="${esc(link.href)}" class="${classes}"${
        link.missing ? ' title="No entry yet"' : ""
    }>${esc(link.label)}</a>`;
}

function plainText(text) {
    return esc(text).replace(/\r?\n/g, "<br>");
}

// Renders plain text with [[links]] (see above). `defaultSlug` is the
// entry's own language, so a bare [[word]] links within it.
function renderText(text, defaultSlug) {
    if (!text) {
        return "";
    }

    let html = "";
    let last = 0;

    for (const match of text.matchAll(LINK_PATTERN)) {
        html += plainText(text.slice(last, match.index));
        last = match.index + match[0].length;

        const link = resolveLink(match[1], defaultSlug);
        html += link ? linkHtml(link) : esc(match[0]);
    }

    return html + plainText(text.slice(last));
}

// Turns [[links]] in sanitized lore HTML into anchors. Only text outside
// existing links and code is touched.
function renderLoreHtml(html) {
    let depth = { a: 0, code: 0, pre: 0 };

    return String(html ?? "")
        .split(/(<[^>]*>)/)
        .map((piece) => {
            if (piece.startsWith("<")) {
                const tag = /^<(\/?)(a|code|pre)\b/.exec(piece);
                if (tag) {
                    depth[tag[2]] += tag[1] ? -1 : 1;
                }
                return piece;
            }

            if (depth.a > 0 || depth.code > 0 || depth.pre > 0 || !piece.includes("[[")) {
                return piece;
            }

            let out = "";
            let last = 0;

            for (const match of piece.matchAll(LINK_PATTERN)) {
                out += piece.slice(last, match.index);
                last = match.index + match[0].length;

                // The text is already HTML-escaped; undo that to parse the link.
                const link = resolveLink(decodeEntities(match[1]), null);
                out += link ? linkHtml(link) : match[0];
            }

            return out + piece.slice(last);
        })
        .join("");
}

module.exports = {
    esc,
    entryUrl,
    languageUrl,
    displayHeadword,
    langVars,
    langBadge,
    layout,
    renderText,
    renderLoreHtml,
    siteBar,
    snippetHtml,
    resolveLink,
    linkHtml
};
