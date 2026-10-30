"use strict";

// Minimal HTML sanitizer for lore page bodies (no dependencies).
//
// The visual editor produces HTML. Everything stored goes through
// sanitizeHtml, which keeps only a small allowlist of tags and attributes,
// rewrites a few synonyms, balances tags and escapes text.

const ALLOWED = new Set([
    "p", "br", "h2", "h3", "h4", "strong", "em", "u", "s", "ul", "ol", "li",
    "blockquote", "hr", "a", "code", "pre", "table", "thead", "tbody", "tr",
    "th", "td", "sup", "sub"
]);

const VOID = new Set(["br", "hr"]);
const INLINE = new Set(["strong", "em", "u", "s", "a", "code", "sup", "sub"]);

// Opening one of these ends an open <p> (HTML's implied end tags).
const ENDS_PARAGRAPH = new Set(["p", "h2", "h3", "h4", "ul", "ol", "blockquote", "pre", "table", "hr"]);

// Tags whose entire contents are discarded.
const DROP_WITH_CONTENT = new Set([
    "script", "style", "iframe", "object", "embed", "noscript", "template",
    "textarea", "select", "svg", "math", "head", "title"
]);

// Synonyms and out-of-range tags mapped onto allowed ones.
const REWRITE = {
    b: "strong",
    i: "em",
    strike: "s",
    del: "s",
    div: "p",
    h1: "h2",
    h5: "h4",
    h6: "h4"
};

const TOKEN = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>|[^<]+|</g;
const ATTRIBUTE = /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function decodeEntities(text) {
    const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

    return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
        if (entity[0] === "#") {
            const code = entity[1].toLowerCase() === "x"
                ? parseInt(entity.slice(2), 16)
                : parseInt(entity.slice(1), 10);
            return Number.isFinite(code) && code > 0 && code < 0x110000
                ? String.fromCodePoint(code)
                : "";
        }
        return named[entity.toLowerCase()] ?? match;
    });
}

function escapeText(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(text) {
    return escapeText(text).replace(/"/g, "&quot;");
}

// Allows web links, mail links, and site-relative or in-page links.
function safeHref(raw) {
    const href = decodeEntities(raw).trim();
    // Browsers ignore whitespace and control characters inside a scheme.
    const compact = href.replace(/[\u0000- \u007f-\u009f]+/g, "");

    if (!compact) {
        return null;
    }
    if (/^(https?:|mailto:)/i.test(compact) || /^[/#]/.test(compact) && !compact.startsWith("//")) {
        return href;
    }
    // Relative paths such as "page" or "../page" (no scheme).
    if (!/^[a-z][a-z0-9+.-]*:/i.test(compact)) {
        return compact.startsWith("//") ? null : href;
    }
    return null;
}

function parseAttributes(source) {
    const attributes = {};

    for (const match of source.matchAll(ATTRIBUTE)) {
        const name = match[1].toLowerCase();
        attributes[name] = match[2] ?? match[3] ?? match[4] ?? "";
    }

    return attributes;
}

function sanitizeHtml(input) {
    const html = String(input ?? "");
    const output = [];
    const stack = []; // open allowed tags
    let dropping = null; // name of a DROP_WITH_CONTENT tag we are inside
    let dropDepth = 0;

    const closeDownTo = (index) => {
        while (stack.length > index) {
            output.push(`</${stack.pop()}>`);
        }
    };

    // Closes the nearest open <p> if only inline tags sit above it.
    const closeParagraph = () => {
        let i = stack.length - 1;
        while (i >= 0 && INLINE.has(stack[i])) {
            i--;
        }
        if (i >= 0 && stack[i] === "p") {
            closeDownTo(i);
        }
    };

    // Closes an open sibling (e.g. a previous <li>) unless a stop tag intervenes.
    const closeSibling = (names, stops) => {
        for (let i = stack.length - 1; i >= 0; i--) {
            if (stops.includes(stack[i])) {
                return;
            }
            if (names.includes(stack[i])) {
                closeDownTo(i);
                return;
            }
        }
    };

    for (const match of html.matchAll(TOKEN)) {
        const [token, closing, rawName, attributeSource] = match;

        if (token.startsWith("<!--")) {
            continue;
        }

        // Text (or a stray "<").
        if (rawName === undefined) {
            if (!dropping) {
                const text = token === "<" ? "&lt;" : escapeText(decodeEntities(token));
                output.push(text);
            }
            continue;
        }

        const lower = rawName.toLowerCase();

        if (dropping) {
            if (lower === dropping) {
                dropDepth += closing ? -1 : 1;
                if (dropDepth === 0) {
                    dropping = null;
                }
            }
            continue;
        }

        if (DROP_WITH_CONTENT.has(lower)) {
            if (!closing && !attributeSource.trimEnd().endsWith("/")) {
                dropping = lower;
                dropDepth = 1;
            }
            continue;
        }

        const name = REWRITE[lower] || lower;

        if (!ALLOWED.has(name)) {
            continue; // unwrap: drop the tag, keep its text
        }

        if (closing) {
            const index = stack.lastIndexOf(name);
            if (index !== -1) {
                while (stack.length > index) {
                    output.push(`</${stack.pop()}>`);
                }
            }
            continue;
        }

        if (VOID.has(name)) {
            if (name === "hr") {
                closeParagraph();
            }
            output.push(`<${name}>`);
            continue;
        }

        let attributes = "";

        if (name === "a") {
            const href = safeHref(parseAttributes(attributeSource).href ?? "");
            if (href) {
                attributes = ` href="${escapeAttribute(href)}"`;
                if (/^https?:/i.test(href)) {
                    attributes += ' rel="noopener noreferrer"';
                }
            }
        } else if (name === "th" || name === "td") {
            const attrs = parseAttributes(attributeSource);
            for (const key of ["colspan", "rowspan"]) {
                const value = parseInt(attrs[key], 10);
                if (value > 1 && value <= 50) {
                    attributes += ` ${key}="${value}"`;
                }
            }
        }

        if (ENDS_PARAGRAPH.has(name)) {
            closeParagraph();
        }
        // Browsers' editors emit a list directly inside a list (<ul><li>a</li><ul>..</ul></ul>).
        // Nest it inside the previous item instead, as valid HTML requires.
        if ((name === "ul" || name === "ol") && (stack.at(-1) === "ul" || stack.at(-1) === "ol")) {
            if (output.at(-1) === "</li>") {
                output.pop();
            } else {
                output.push("<li>");
            }
            stack.push("li");
        }
        if (name === "li") {
            closeSibling(["li"], ["ul", "ol"]);
        } else if (name === "td" || name === "th") {
            closeSibling(["td", "th"], ["tr"]);
        } else if (name === "tr") {
            closeSibling(["tr"], ["table"]);
        }

        stack.push(name);
        output.push(`<${name}${attributes}>`);
    }

    while (stack.length) {
        output.push(`</${stack.pop()}>`);
    }

    return tidy(output.join(""));
}

// Removes empty paragraphs and collapses stray whitespace left by editing.
function tidy(html) {
    return html
        .replace(/<p>(?:\s|<br>|&nbsp;)*<\/p>/g, "")
        .replace(/<(strong|em|u|s)>\s*<\/\1>/g, "")
        .replace(/<li>(?:\s|<br>|&nbsp;)*<\/li>/g, "")
        .replace(/<(ul|ol)>\s*<\/\1>/g, "")
        .trim();
}

// Plain text of sanitized HTML, for search and excerpts.
function htmlToText(html) {
    return decodeEntities(
        String(html ?? "")
            .replace(/<\/?(p|h[1-6]|li|tr|blockquote|pre|ul|ol|table)>|<br>|<hr>/g, " \n")
            .replace(/<\/(td|th)>/g, " ")
            .replace(/<[^>]*>/g, "")
    )
        .replace(/[ \t]+/g, " ")
        .replace(/ ?\n ?/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

// "[[history|The Fall|the fall]]" -> "the fall": shows what a reader of the
// rendered page would see (display text, else the page or word itself).
function stripLinkSyntax(text) {
    return String(text ?? "").replace(/\[\[([^\[\]]+?)\]\]/g, (match, inner) => {
        const parts = inner.split("|").map((part) => part.trim());
        const target = parts[0].includes(":") ? parts[0].slice(parts[0].indexOf(":") + 1).trim() : parts[0];
        return parts[2] || parts[1] || target;
    });
}

function excerpt(text, max = 150) {
    const flat = stripLinkSyntax(text).replace(/\s+/g, " ").trim();
    return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat;
}

module.exports = { sanitizeHtml, htmlToText, excerpt, stripLinkSyntax, decodeEntities, escapeText };
