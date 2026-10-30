// Live suggestions for the public dictionary search box. The form still
// works without this script (it just submits to the results page).
(() => {
    "use strict";

    const form = document.querySelector("form[data-suggest]");
    const input = form && form.querySelector("input[name=q]");

    if (!input) {
        return;
    }

    const list = document.createElement("ul");
    list.className = "suggestions";
    list.id = "search-suggestions";
    list.setAttribute("role", "listbox");
    list.hidden = true;
    form.append(list);

    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-controls", list.id);
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("autocomplete", "off");

    let timer = null;
    let controller = null;
    let links = []; // <a> elements in display order, including "see all"
    let active = -1;

    // The same script serves the dictionary, lore and site-wide search boxes.
    const kind = ["lore", "site"].includes(form.dataset.suggest) ? form.dataset.suggest : "dictionary";
    const endpoint = {
        lore: "/api/lore/search-pages",
        site: "/api/search/suggest",
        dictionary: "/api/dictionary/search-words"
    }[kind];
    const searchPath = { lore: "/lore/search", site: "/search", dictionary: "/dictionary/search" }[kind];
    const noMatch = { lore: "No matching pages", site: "No matches", dictionary: "No matching entries" }[kind];

    function itemUrl(item) {
        if (kind === "site") {
            return item.url; // the server already built it
        }
        return kind === "lore"
            ? `/lore/${encodeURIComponent(item.category_slug)}/${encodeURIComponent(item.slug)}`
            : `/dictionary/${encodeURIComponent(item.language_slug)}/${encodeURIComponent(item.headword)}`;
    }

    function close() {
        list.hidden = true;
        input.setAttribute("aria-expanded", "false");
        input.removeAttribute("aria-activedescendant");
        active = -1;
    }

    function setActive(index) {
        links.forEach((link, i) => {
            link.classList.toggle("active", i === index);
            link.setAttribute("aria-selected", i === index ? "true" : "false");
        });
        active = index;

        if (index >= 0) {
            input.setAttribute("aria-activedescendant", links[index].id);
            links[index].scrollIntoView({ block: "nearest" });
        } else {
            input.removeAttribute("aria-activedescendant");
        }
    }

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) {
            node.className = className;
        }
        if (text) {
            node.textContent = text;
        }
        return node;
    }

    function render(query, items) {
        list.replaceChildren();
        links = [];

        for (const item of items) {
            const li = el("li");
            li.setAttribute("role", "presentation");

            const a = el("a");
            a.href = itemUrl(item);
            a.id = `sug-${links.length}`;
            a.setAttribute("role", "option");

            const main = el("span", "sug-main");
            let tag;

            if (kind === "site") {
                // Mixed results: dictionary words, lore pages and calendar notes.
                main.append(el("span", item.conlang ? "sug-hw conlang" : "sug-hw", item.title));
                if (item.extra) {
                    main.append(el("span", "sug-sino conlang", item.extra));
                }
                tag = el("span", "lang-tag", item.badge.name);
                tag.style.setProperty("--lang-bg", item.badge.color);
                tag.style.setProperty("--lang-fg", item.badge.ink);
                main.append(tag);
            } else if (kind === "lore") {
                main.append(el("span", "sug-hw", item.title));
                tag = el("span", "lang-tag", item.category_name);
                tag.style.setProperty("--lang-bg", item.category_color);
                tag.style.setProperty("--lang-fg", item.category_ink);
                main.append(tag);
            } else {
                main.append(el("span", "sug-hw conlang", item.language_is_proto ? `*${item.headword}` : item.headword));
                if (item.sinographs) {
                    main.append(el("span", "sug-sino conlang", item.sinographs));
                }
                tag = el("span", "lang-tag", item.language_name);
                tag.style.setProperty("--lang-bg", item.language_color);
                tag.style.setProperty("--lang-fg", item.language_ink);
                main.append(tag);
                if (item.pos) {
                    main.append(el("span", "pos-tag", item.pos));
                }
            }

            a.append(main);
            const detail = kind === "lore" ? item.excerpt : kind === "site" ? item.detail : item.gloss;
            if (detail) {
                a.append(el("span", "sug-gloss", detail));
            }

            li.append(a);
            list.append(li);
            links.push(a);
        }

        if (items.length === 0) {
            list.append(el("li", "sug-empty", noMatch));
        }

        const all = el("li", "sug-all");
        all.setAttribute("role", "presentation");
        const allLink = el("a", "", `Search all results for “${query}”`);
        allLink.href = `${searchPath}?q=${encodeURIComponent(query)}&go=0`;
        allLink.id = `sug-${links.length}`;
        allLink.setAttribute("role", "option");
        all.append(allLink);
        list.append(all);
        links.push(allLink);

        active = -1;
        list.hidden = false;
        input.setAttribute("aria-expanded", "true");
    }

    async function fetchSuggestions() {
        const query = input.value.trim();

        if (controller) {
            controller.abort();
        }

        if (!query) {
            close();
            return;
        }

        controller = new AbortController();

        try {
            const response = await fetch(
                `${endpoint}?q=${encodeURIComponent(query)}`,
                { signal: controller.signal }
            );
            if (!response.ok) {
                throw new Error("bad response");
            }
            const items = await response.json();

            // Ignore if the box changed while we waited.
            if (input.value.trim() === query) {
                render(query, items);
            }
        } catch (error) {
            if (error.name !== "AbortError") {
                close();
            }
        }
    }

    input.addEventListener("input", () => {
        clearTimeout(timer);
        timer = setTimeout(fetchSuggestions, 120);
    });

    input.addEventListener("keydown", (event) => {
        if (list.hidden || links.length === 0) {
            return;
        }

        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            // Positions run from -1 (back to the typed text) to the last link.
            let next = active + (event.key === "ArrowDown" ? 1 : -1);
            if (next < -1) {
                next = links.length - 1;
            } else if (next >= links.length) {
                next = -1;
            }
            setActive(next);
        } else if (event.key === "Enter" && active >= 0) {
            event.preventDefault();
            window.location.href = links[active].href;
        } else if (event.key === "Escape") {
            close();
        }
    });

    // Keep focus in the input while clicking suggestions.
    list.addEventListener("mousedown", (event) => event.preventDefault());

    input.addEventListener("focus", () => {
        if (input.value.trim() && list.children.length) {
            list.hidden = false;
            input.setAttribute("aria-expanded", "true");
        }
    });

    document.addEventListener("click", (event) => {
        if (!form.contains(event.target)) {
            close();
        }
    });
})();
