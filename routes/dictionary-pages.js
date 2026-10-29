"use strict";

// Server-rendered, read-only dictionary pages. Rendered from the database
// on every request, so edits made in the editor show up immediately.

const dict = require("../lib/dictionary");
const {
    HttpError,
    sendHtml,
    redirect,
    parseInteger
} = require("../lib/http");
const {
    esc,
    entryUrl,
    languageUrl,
    displayHeadword,
    layout,
    renderText
} = require("../lib/render");
const { languageStats } = require("../lib/stats");
const charts = require("../lib/charts");

const PAGE_SIZE = 200;
const SEARCH_LIMIT = 100;

const ANCESTRY_LABELS = {
    inherited: "Inherited from",
    borrowed: "Borrowed from",
    areal: "Areally related to"
};

const VARIANT_LABELS = {
    dialectal: "dialectal variant",
    spelling: "spelling variant"
};

const GENDER_ABBREVIATIONS = { masculine: "m", feminine: "f", neuter: "n" };

function capitalize(text) {
    return text.charAt(0).toUpperCase() + text.slice(1);
}

function glossSnippet(gloss) {
    if (!gloss) {
        return "";
    }
    return gloss.length > 140 ? gloss.slice(0, 140) + "…" : gloss;
}

// A link to a related word, preceded by its language name.
function relatedWordLink(rel) {
    return (
        `<a href="${languageUrl(rel.language_slug)}">${esc(rel.language_name)}</a> ` +
        `<a href="${entryUrl(rel.language_slug, rel.headword)}" lang="${esc(rel.language_slug)}">` +
        `${esc(displayHeadword(rel.headword, rel.language_is_proto))}</a>`
    );
}

// ------------------------------------------------------
// Pages
// ------------------------------------------------------

function homePage(res) {
    const languages = dict.listLanguages();

    const cards = languages.length
        ? languages
              .map(
                  (lang) => `
        <a class="language-card" href="${languageUrl(lang.slug)}">
            <span class="language-card-name">${esc(lang.name)}</span>
            <span class="language-card-meta">${lang.word_count} ${
                lang.word_count === 1 ? "entry" : "entries"
            }${lang.is_proto ? " · reconstructed" : ""}</span>
        </a>`
              )
              .join("")
        : `<p class="muted">No languages yet. Add one in the <a href="/dictionary/editor">editor</a>.</p>`;

    sendHtml(
        res,
        200,
        layout({
            title: "Dictionary",
            search: { q: "" },
            body: `<main class="content">
    <h1>Dictionary</h1>
    <p class="muted">Search above, or choose a language to browse.</p>
    ${
        languages.some((lang) => lang.word_count > 0)
            ? '<p><a class="button-link" href="/dictionary/random">🎲 Random word</a></p>'
            : ""
    }
    <div class="language-grid">${cards}</div>
</main>`
        })
    );
}

function languagePage(res, language, params) {
    const letter = params.get("letter") || null;
    const page = Math.max(1, Number(params.get("page")) || 1);

    const initials = dict.listInitials(language.id);
    const { total, items } = dict.listWords(language.id, {
        letter,
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE
    });
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    const letterNav = initials.length
        ? `<nav class="letters" aria-label="Browse by initial">
        <a href="${languageUrl(language.slug)}"${letter ? "" : ' class="active"'}>All</a>
        ${initials
            .map(
                (item) =>
                    `<a href="?letter=${encodeURIComponent(item.letter)}"${
                        item.letter === letter ? ' class="active"' : ""
                    } title="${item.n} entries">${esc(item.letter.toUpperCase())}</a>`
            )
            .join("\n        ")}
    </nav>`
        : "";

    let list = "";
    let currentLetter = null;

    for (const word of items) {
        const initial = word.sort_key.charAt(0).toUpperCase();
        if (initial !== currentLetter) {
            list += `${currentLetter === null ? "" : "</ul>"}<h2 class="letter-heading">${esc(initial)}</h2><ul class="word-list">`;
            currentLetter = initial;
        }
        list += `<li>
            <a href="${entryUrl(language.slug, word.headword)}" lang="${esc(language.slug)}">${esc(
            displayHeadword(word.headword, language.is_proto)
        )}</a>
            ${word.pos ? `<span class="pos-tag">${esc(word.pos)}</span>` : ""}
            <span class="gloss">${esc(glossSnippet(word.gloss))}</span>
        </li>`;
    }
    if (currentLetter !== null) {
        list += "</ul>";
    }

    const query = (page) =>
        `?${letter ? `letter=${encodeURIComponent(letter)}&` : ""}page=${page}`;
    const pager =
        pages > 1
            ? `<nav class="pager">
        ${page > 1 ? `<a href="${query(page - 1)}">← Previous</a>` : ""}
        <span>Page ${page} of ${pages}</span>
        ${page < pages ? `<a href="${query(page + 1)}">Next →</a>` : ""}
    </nav>`
            : "";

    const wordsTab = `<p class="muted">${total} ${total === 1 ? "entry" : "entries"}${
        letter ? ` beginning with “${esc(letter.toUpperCase())}”` : ""
    }${
        initials.length
            ? ` · <a href="/dictionary/random?language=${encodeURIComponent(language.slug)}">Random word</a>`
            : ""
    }</p>
    ${letterNav}
    ${list ? `<div class="word-columns">${list}</div>` : '<p class="muted">No entries.</p>'}
    ${pager}`;

    sendHtml(res, 200, languageShell(language, "words", wordsTab));
}

// Header and tabs shared by the language page's Words and Statistics views.
function languageShell(language, activeTab, content) {
    const base = languageUrl(language.slug);

    return layout({
        title: `${language.name}${activeTab === "stats" ? " statistics" : ""} – Dictionary`,
        search: { q: "" },
        body: `<main class="content">
    <p class="crumbs"><a href="/dictionary">Dictionary</a> › ${esc(language.name)}</p>
    <h1>${esc(language.name)}${
        language.is_proto ? ' <span class="badge">reconstructed</span>' : ""
    }</h1>
    ${language.notes ? `<p class="language-notes">${renderText(language.notes, language.slug)}</p>` : ""}
    <nav class="tabs" aria-label="Language views">
        <a href="${base}"${activeTab === "words" ? ' class="active" aria-current="page"' : ""}>Words</a>
        <a href="${base}?view=stats"${activeTab === "stats" ? ' class="active" aria-current="page"' : ""}>Statistics</a>
    </nav>
    ${content}
</main>`
    });
}

function ratioText(consonants, vowels) {
    return vowels ? `${(consonants / vowels).toFixed(2)} : 1` : "–";
}

function statsPage(res, language) {
    const stats = languageStats(language.id);

    if (stats.entries === 0) {
        sendHtml(
            res,
            200,
            languageShell(language, "stats", '<p class="muted">No entries yet, so there is nothing to chart.</p>')
        );
        return;
    }

    const lettersTotal = stats.consonants + stats.vowels;
    const wordLink = (word) =>
        word
            ? `<a href="${entryUrl(language.slug, word.headword)}" lang="${esc(language.slug)}">${esc(
                  displayHeadword(word.headword, language.is_proto)
              )}</a> <span class="muted">(${word.length})</span>`
            : "–";

    const tile = (label, value, detail = "") => `<div class="stat-tile">
        <div class="stat-value">${value}</div>
        <div class="stat-label">${esc(label)}</div>
        ${detail ? `<div class="stat-detail">${detail}</div>` : ""}
    </div>`;

    const { withDefinition, withEtymology, withPronunciation } = stats.completeness;
    const n = stats.entries;

    const card = (title, body, note = "") => `<section class="chart-card">
        <h2>${esc(title)}</h2>
        ${note ? `<p class="chart-note">${note}</p>` : ""}
        ${body}
    </section>`;

    const html = `<div class="viz">
    <div class="stat-tiles">
        ${tile("Entries", stats.entries.toLocaleString("en-US"))}
        ${tile(
            "Average letters per word",
            stats.avgLength === null ? "–" : stats.avgLength.toFixed(1),
            stats.medianLength === null ? "" : `median ${stats.medianLength}`
        )}
        ${tile(
            "Consonant : vowel",
            ratioText(stats.consonants, stats.vowels),
            lettersTotal ? `${((stats.consonants / lettersTotal) * 100).toFixed(1)}% consonants` : ""
        )}
        ${tile(
            "Senses per entry",
            stats.avgSenses === null ? "–" : stats.avgSenses.toFixed(2)
        )}
        ${tile("Longest word", wordLink(stats.longest))}
        ${tile("Shortest word", wordLink(stats.shortest))}
    </div>

    <div class="chart-grid">
        ${card(
            "Parts of speech",
            charts.pieChart(stats.partsOfSpeech, { ariaLabel: `Entries in ${language.name} by part of speech` })
        )}
        ${card(
            "Consonants and vowels",
            charts.splitBar(
                { label: "consonants", count: stats.consonants },
                { label: "vowels", count: stats.vowels }
            ),
            "Latin letters only, with <em>y</em> counted as a consonant."
        )}
        ${
            stats.genders.length
                ? card(
                      "Grammatical gender",
                      charts.pieChart(stats.genders, { ariaLabel: `Entries in ${language.name} by gender` })
                  )
                : ""
        }
    </div>

    ${card(
        "Word length",
        charts.columnChart(stats.lengthHistogram, {
            ariaLabel: `Number of entries in ${language.name} by length in letters`,
            unit: "words"
        }),
        "Entries by number of letters."
    )}

    ${card(
        "Letter frequency",
        `${charts.columnChart(
            stats.letters.map((item) => ({ ...item, cls: item.vowel ? 2 : 1 })),
            { ariaLabel: `Letter frequency in ${language.name} headwords`, unit: "letters" }
        )}
        <ul class="legend legend-inline">
            <li><span class="swatch sw-1"></span><span class="legend-label">consonant or other</span></li>
            <li><span class="swatch sw-2"></span><span class="legend-label">vowel</span></li>
        </ul>`,
        "Counted across all headwords, diacritics folded, so digraphs such as <em>kh</em> count as two letters."
    )}

    <div class="chart-grid">
        ${card(
            "Descends from",
            charts.barList(
                stats.sources.map((item) => ({
                    label: item.name,
                    count: item.n,
                    href: languageUrl(item.slug)
                }))
            ),
            "Entries here with an ancestral form in each language."
        )}
        ${card(
            "Passed on to",
            charts.barList(
                stats.influence.map((item) => ({
                    label: item.name,
                    count: item.n,
                    href: languageUrl(item.slug)
                }))
            ),
            "Entries in other languages descended from entries here."
        )}
    </div>

    ${card(
        "Completeness",
        `<ul class="bar-list">
            ${charts.meter("Has a definition", withDefinition, n)}
            ${charts.meter("Has an etymology or ancestor", withEtymology, n)}
            ${charts.meter("Has a pronunciation", withPronunciation, n)}
        </ul>`
    )}
</div>`;

    sendHtml(res, 200, languageShell(language, "stats", html));
}

function renderEntry(word, language, index, multiple) {
    // With several homographs, each gets "Etymology N" and everything
    // below it drops one heading level.
    const etymologyTag = "h3";
    const innerTag = multiple ? "h4" : "h3";

    const sections = [];

    const hasEtymology = word.etymology || word.ancestors.length;
    if (multiple || hasEtymology) {
        let body = "";

        for (const ancestor of word.ancestors) {
            body += `<p>${ANCESTRY_LABELS[ancestor.kind]} ${relatedWordLink(ancestor)}${
                ancestor.note ? ` <span class="muted">(${renderText(ancestor.note, ancestor.language_slug)})</span>` : ""
            }</p>`;
        }
        if (word.etymology) {
            body += `<p>${renderText(word.etymology, language.slug)}</p>`;
        }
        if (!body) {
            body = '<p class="muted">No etymology recorded.</p>';
        }

        sections.push(
            `<${etymologyTag}>${multiple ? `Etymology ${index + 1}` : "Etymology"}</${etymologyTag}>${body}`
        );
    }

    if (word.pronunciation) {
        sections.push(
            `<${innerTag}>Pronunciation</${innerTag}><ul><li class="pronunciation">${esc(word.pronunciation)}</li></ul>`
        );
    }

    // Part of speech heading, headword line, and senses.
    const headwordLine =
        `<p class="headword-line">` +
        `<strong class="headword" lang="${esc(language.slug)}">${esc(
            displayHeadword(word.headword, language.is_proto)
        )}</strong>` +
        (word.sinographs ? ` <span class="sinographs">${esc(word.sinographs)}</span>` : "") +
        (word.gender
            ? ` <abbr class="gender" title="${esc(word.gender)}">${GENDER_ABBREVIATIONS[word.gender]}</abbr>`
            : "") +
        `</p>`;

    const senses = word.senses.length
        ? `<ol class="senses">${word.senses
              .map((definition) => `<li>${renderText(definition, language.slug)}</li>`)
              .join("")}</ol>`
        : word.variantOf.length
          ? "" // a pure variant is described by its "Variant of:" line below
          : '<p class="muted">No definition yet.</p>';

    sections.push(
        `<${innerTag}>${esc(capitalize(word.pos || "Entry"))}</${innerTag}>${headwordLine}${senses}`
    );

    if (word.variantOf.length) {
        sections.push(
            `<p class="relation"><strong>Variant of:</strong> ${word.variantOf
                .map(
                    (v) =>
                        `<a href="${entryUrl(v.language_slug, v.headword)}" lang="${esc(v.language_slug)}">${esc(
                            displayHeadword(v.headword, v.language_is_proto)
                        )}</a> <span class="muted">(${VARIANT_LABELS[v.kind]})</span>`
                )
                .join(", ")}</p>`
        );
    }

    if (word.variantForms.length) {
        sections.push(
            `<p class="relation"><strong>Variants:</strong> ${word.variantForms
                .map(
                    (v) =>
                        `<a href="${entryUrl(v.language_slug, v.headword)}" lang="${esc(v.language_slug)}">${esc(
                            displayHeadword(v.headword, v.language_is_proto)
                        )}</a> <span class="muted">(${VARIANT_LABELS[v.kind]})</span>`
                )
                .join(", ")}</p>`
        );
    }

    if (word.descendants.length) {
        sections.push(
            `<${innerTag}>Descendants</${innerTag}><ul>${word.descendants
                .map(
                    (d) =>
                        `<li>${relatedWordLink(d)} <span class="muted">(${esc(d.kind)})</span></li>`
                )
                .join("")}</ul>`
        );
    }

    return `<section class="entry">${sections.join("\n")}</section>`;
}

function entryPage(res, language, headword) {
    const words = dict.wordsByHeadword(language.id, headword);

    if (words.length === 0) {
        const suggestions = dict.suggestWords(language.id, headword);

        sendHtml(
            res,
            404,
            layout({
                title: `${headword} – ${language.name} – Dictionary`,
                search: { q: headword },
                body: `<main class="content">
    <p class="crumbs"><a href="/dictionary">Dictionary</a> › <a href="${languageUrl(language.slug)}">${esc(language.name)}</a></p>
    <h1>${esc(headword)}</h1>
    <p>There is no entry for “${esc(headword)}” in ${esc(language.name)}.</p>
    ${
        suggestions.length
            ? `<p>Did you mean: ${suggestions
                  .map(
                      (s) =>
                          `<a href="${entryUrl(language.slug, s.headword)}">${esc(s.headword)}</a>`
                  )
                  .join(", ")}?</p>`
            : ""
    }
</main>`
            })
        );
        return;
    }

    const others = dict.otherLanguagesWithHeadword(language.id, headword);
    const multiple = words.length > 1;

    sendHtml(
        res,
        200,
        layout({
            title: `${displayHeadword(headword, language.is_proto)} – ${language.name} – Dictionary`,
            search: { q: "" },
            body: `<main class="content entry-page">
    <p class="crumbs"><a href="/dictionary">Dictionary</a> › <a href="${languageUrl(language.slug)}">${esc(language.name)}</a></p>
    <h1 lang="${esc(language.slug)}">${esc(displayHeadword(headword, language.is_proto))}</h1>
    ${
        others.length
            ? `<p class="also">Also in: ${others
                  .map(
                      (o) =>
                          `<a href="${entryUrl(o.language_slug, headword)}">${esc(o.language_name)}</a>`
                  )
                  .join(" · ")}</p>`
            : ""
    }
    <h2 class="language-heading">${esc(language.name)}</h2>
    ${words.map((word, i) => renderEntry(word, language, i, multiple)).join("\n")}
</main>`
        })
    );
}

function searchPage(req, res, url) {
    const q = (url.searchParams.get("q") || "").trim();
    const languageParam = url.searchParams.get("language");
    const languageId = languageParam ? parseInteger(languageParam, "language") : null;
    const languages = dict.listLanguages();

    // Like Wiktionary, an unambiguous exact headword goes straight to its entry.
    if (q && url.searchParams.get("go") !== "0") {
        const exact = dict.exactMatches(q, languageId);
        if (exact.length === 1) {
            redirect(res, entryUrl(exact[0].language_slug, exact[0].headword));
            return;
        }
    }

    const results = q
        ? dict.searchWords(q, { languageId, limit: SEARCH_LIMIT })
        : [];

    const rows = results
        .map(
            (r) => `<li>
            <a href="${entryUrl(r.language_slug, r.headword)}" lang="${esc(r.language_slug)}">${esc(
                displayHeadword(r.headword, r.language_is_proto)
            )}</a>
            ${r.sinographs ? `<span class="sinographs">${esc(r.sinographs)}</span>` : ""}
            <span class="lang-tag">${esc(r.language_name)}</span>
            ${r.pos ? `<span class="pos-tag">${esc(r.pos)}</span>` : ""}
            <span class="gloss">${esc(glossSnippet(r.gloss))}</span>
        </li>`
        )
        .join("");

    sendHtml(
        res,
        200,
        layout({
            title: q ? `Search: ${q} – Dictionary` : "Search – Dictionary",
            search: { q },
            body: `<main class="content">
    <h1>Search</h1>
    <form class="search-filter" action="/dictionary/search" method="get">
        <input type="hidden" name="q" value="${esc(q)}">
        <input type="hidden" name="go" value="0">
        <label>Language:
            <select name="language" onchange="this.form.submit()">
                <option value="">All languages</option>
                ${languages
                    .map(
                        (l) =>
                            `<option value="${l.id}"${l.id === languageId ? " selected" : ""}>${esc(l.name)}</option>`
                    )
                    .join("")}
            </select>
        </label>
    </form>
    ${
        !q
            ? '<p class="muted">Enter a word or an English meaning.</p>'
            : results.length
              ? `<p class="muted">${results.length}${
                    results.length === SEARCH_LIMIT ? "+" : ""
                } result${results.length === 1 ? "" : "s"} for “${esc(q)}”. Matches headwords, sinographs and definitions; diacritics are ignored.</p>
    <ul class="word-list">${rows}</ul>`
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
            title: "Dictionary editor",
            active: "editor",
            body: '<main id="editor" class="editor"><p class="muted">Loading…</p></main>',
            scripts: ["/assets/dictionary/editor.js"]
        })
    );
}

module.exports = async function dictionaryPages(req, res, url) {
    const isDictionary =
        url.pathname === "/dictionary" || url.pathname.startsWith("/dictionary/");

    if (!isDictionary) {
        return false;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
        throw new HttpError(405, "Method not allowed");
    }

    // Split the raw path so an encoded "/" inside a headword stays inside its segment.
    let parts;
    try {
        parts = url.pathname
            .split("/")
            .filter(Boolean)
            .slice(1)
            .map(decodeURIComponent);
    } catch {
        throw new HttpError(400, "Bad path");
    }

    if (parts.length === 0) {
        if (url.pathname.endsWith("/")) {
            redirect(res, "/dictionary" + url.search, 301);
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

    // /dictionary/random[?language=<slug>] -> a random entry
    if (first === "random" && parts.length === 1) {
        const slug = url.searchParams.get("language");
        let languageId = null;

        if (slug) {
            const scope = dict.getLanguageBySlug(slug);
            if (!scope) {
                throw new HttpError(404, `No language “${slug}”`);
            }
            languageId = scope.id;
        }

        const word = dict.randomWord(languageId);
        // Never cache: each visit should pick a new word.
        res.setHeader("Cache-Control", "no-store");
        redirect(
            res,
            word
                ? entryUrl(word.language_slug, word.headword)
                : slug
                  ? languageUrl(slug)
                  : "/dictionary"
        );
        return true;
    }

    if (first === "search" && parts.length === 1) {
        searchPage(req, res, url);
        return true;
    }

    const language = dict.getLanguageBySlug(first);

    if (!language) {
        // Fall through to static files (none exist under /dictionary) -> 404.
        throw new HttpError(404, `No language “${first}”`);
    }

    if (parts.length === 1) {
        if (!url.pathname.endsWith("/")) {
            redirect(res, url.pathname + "/" + url.search, 301);
        } else if (url.searchParams.get("view") === "stats") {
            statsPage(res, language);
        } else {
            languagePage(res, language, url.searchParams);
        }
        return true;
    }

    if (parts.length === 2) {
        entryPage(res, language, second);
        return true;
    }

    throw new HttpError(404, "Not found");
};
