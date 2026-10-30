(() => {
    "use strict";

    const { h, api, slugify, inkFor, badge, formatWhen, DEFAULT_COLOR } = window.UI;
    const root = document.getElementById("editor");

    const state = {
        categories: [],
        categoryId: null,
        items: [],
        total: 0,
        filter: "",
        sort: recallSort(),
        draft: null,
        dirty: false
    };

    // ------------------------------------------------------
    // Small helpers
    // ------------------------------------------------------

    function currentCategory() {
        return state.categories.find((c) => c.id === state.categoryId) || null;
    }

    function markDirty() {
        state.dirty = true;
    }

    function confirmDiscard() {
        return !state.dirty || confirm("Discard unsaved changes?");
    }

    window.addEventListener("beforeunload", (event) => {
        if (state.dirty) {
            event.preventDefault();
        }
    });

    function store(key, value) {
        try {
            localStorage.setItem(key, String(value));
        } catch { /* storage unavailable */ }
    }

    function load(key) {
        try {
            return localStorage.getItem(key);
        } catch {
            return null;
        }
    }

    function recallSort() {
        return load("lore.sort") === "updated" ? "updated" : "alpha";
    }

    let statusEl = null;

    function setStatus(message, kind = "") {
        if (statusEl) {
            statusEl.textContent = message;
            statusEl.className = `status ${kind}`;
        } else if (kind === "error") {
            alert(message);
        }
    }

    // A small modal that asks for one line of text. Resolves to the text,
    // or null if cancelled.
    function ask({ title, label, value = "", placeholder = "", okLabel = "OK" }) {
        return new Promise((resolve) => {
            let finished = false;
            const input = h("input", { type: "text", value, placeholder });

            const done = (result) => {
                if (finished) {
                    return;
                }
                finished = true;
                dialog.close();
                dialog.remove();
                resolve(result);
            };

            const dialog = h("dialog", {},
                h("h2", {}, title),
                h("form", {
                    onsubmit: (event) => {
                        event.preventDefault();
                        done(input.value.trim() || null);
                    }
                },
                h("div", { class: "field" }, h("label", {}, label), input),
                h("div", { class: "form-actions" },
                    h("button", { type: "submit", class: "primary" }, okLabel),
                    h("button", { type: "button", onclick: () => done(null) }, "Cancel")))
            );

            dialog.addEventListener("cancel", () => done(null));
            document.body.append(dialog);
            dialog.showModal();
            input.focus();
            input.select();
        });
    }

    // ------------------------------------------------------
    // Visual (rich-text) editor
    // ------------------------------------------------------

    const CLEAN_ALLOWED = new Set([
        "p", "br", "h2", "h3", "h4", "strong", "em", "u", "s", "ul", "ol", "li", "blockquote",
        "hr", "a", "code", "pre", "table", "thead", "tbody", "tr", "th", "td", "sup", "sub"
    ]);
    const CLEAN_REWRITE = { b: "strong", i: "em", strike: "s", del: "s", div: "p", h1: "h2", h5: "h4", h6: "h4" };
    const CLEAN_DROP = new Set(["script", "style", "iframe", "object", "embed", "noscript", "template", "svg", "head", "title"]);

    // Reduces pasted HTML to the formatting the page body supports. (The
    // server sanitizes again on save; this just keeps the editor tidy.)
    function cleanPastedHtml(html) {
        const doc = new DOMParser().parseFromString(html, "text/html");
        const out = document.createElement("div");

        const walk = (node, parent) => {
            for (const child of node.childNodes) {
                if (child.nodeType === Node.TEXT_NODE) {
                    parent.append(child.textContent);
                    continue;
                }
                if (child.nodeType !== Node.ELEMENT_NODE) {
                    continue;
                }

                const tag = child.tagName.toLowerCase();
                if (CLEAN_DROP.has(tag)) {
                    continue;
                }

                const name = CLEAN_REWRITE[tag] || tag;
                if (!CLEAN_ALLOWED.has(name)) {
                    walk(child, parent); // unwrap
                    continue;
                }

                const copy = document.createElement(name);
                if (name === "a") {
                    const href = child.getAttribute("href") || "";
                    if (/^(https?:|mailto:|\/|#)/i.test(href.trim())) {
                        copy.setAttribute("href", href.trim());
                    }
                }
                if (name !== "br" && name !== "hr") {
                    walk(child, copy);
                }
                parent.append(copy);
            }
        };

        walk(doc.body, out);
        return out.innerHTML;
    }

    function escapeHtml(text) {
        return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    function createRichEditor({ onInput, pickLink }) {
        const area = h("div", {
            class: "rich-area lore-body",
            contenteditable: "true",
            role: "textbox",
            "aria-multiline": "true",
            "aria-label": "Page body",
            spellcheck: "true"
        });

        let lastRange = null;
        const stateButtons = {};
        const tableTools = h("span", { class: "tool-group table-tools", hidden: true });
        const blockSelect = h("select", {
            "aria-label": "Paragraph style",
            title: "Paragraph style",
            onchange: () => {
                // The editor's own selection survives focusing the dropdown,
                // so don't overwrite it with a possibly stale saved range.
                if (!liveRange()) {
                    restoreRange();
                }
                run("formatBlock", blockSelect.value);
            }
        },
        h("option", { value: "p" }, "Paragraph"),
        h("option", { value: "h2" }, "Heading 2"),
        h("option", { value: "h3" }, "Heading 3"),
        h("option", { value: "h4" }, "Heading 4"),
        h("option", { value: "blockquote" }, "Quote"));

        // The selection as it is right now, if it is inside the editor.
        function liveRange() {
            const selection = window.getSelection();
            return selection.rangeCount && area.contains(selection.anchorNode)
                ? selection.getRangeAt(0).cloneRange()
                : null;
        }

        // Live selection, else the last one seen (focus may have moved to a dialog).
        const currentRange = () => liveRange() || lastRange;

        function restoreRange() {
            area.focus();
            if (lastRange) {
                const selection = window.getSelection();
                selection.removeAllRanges();
                selection.addRange(lastRange);
            }
        }

        // Browsers' editing commands sometimes leave invalid structure behind
        // (a <p> holding lists or other <p>s, a list directly inside a list,
        // style spans). Tidy it up so later commands behave. Nodes are moved,
        // not recreated, so the caret stays where it was.
        const BLOCKS_IN_P = ":scope > ul, :scope > ol, :scope > p, :scope > table, :scope > h2, :scope > h3, :scope > h4, :scope > blockquote, :scope > hr, :scope > pre";

        function normalize() {
            for (const paragraph of [...area.querySelectorAll("p")]) {
                if (paragraph.querySelector(BLOCKS_IN_P)) {
                    while (paragraph.firstChild) {
                        paragraph.before(paragraph.firstChild);
                    }
                    paragraph.remove();
                }
            }

            for (const list of [...area.querySelectorAll("ul > ul, ul > ol, ol > ul, ol > ol")]) {
                const previous = list.previousElementSibling;
                if (previous && previous.tagName === "LI") {
                    previous.append(list);
                } else {
                    const item = document.createElement("li");
                    list.before(item);
                    item.append(list);
                }
            }

            for (const node of [...area.querySelectorAll("[style]")]) {
                node.removeAttribute("style");
                if (node.tagName === "SPAN" && !node.attributes.length) {
                    while (node.firstChild) {
                        node.before(node.firstChild);
                    }
                    node.remove();
                }
            }
        }

        function run(command, value = null) {
            area.focus();
            normalize();
            document.execCommand(command, false, value);
            normalize();
            onInput();
            refresh();
        }

        // ---- toolbar state ----
        function currentCell() {
            const node = lastRange && lastRange.startContainer;
            const element = node && (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);
            const cell = element && element.closest("td, th");
            return cell && area.contains(cell) ? cell : null;
        }

        function refresh() {
            for (const [command, button] of Object.entries(stateButtons)) {
                let active = false;
                try {
                    active = document.queryCommandState(command);
                } catch { /* unsupported */ }
                button.classList.toggle("active", active);
            }

            let block = "p";
            try {
                block = (document.queryCommandValue("formatBlock") || "p").toLowerCase().replace(/[<>]/g, "");
            } catch { /* unsupported */ }
            blockSelect.value = ["h2", "h3", "h4", "blockquote"].includes(block) ? block : "p";

            tableTools.hidden = !currentCell();
        }

        document.addEventListener("selectionchange", () => {
            const selection = window.getSelection();
            if (selection.rangeCount && area.contains(selection.anchorNode)) {
                lastRange = selection.getRangeAt(0).cloneRange();
                refresh();
            }
        });

        // ---- toolbar buttons ----
        const keep = (event) => event.preventDefault(); // keep the text selection

        function button(label, title, onclick, { command = null, extraClass = "" } = {}) {
            const el = h("button", {
                type: "button",
                class: `tool ${extraClass}`.trim(),
                title,
                "aria-label": title,
                onmousedown: keep,
                onclick
            }, label);
            if (command) {
                stateButtons[command] = el;
            }
            return el;
        }

        const command = (label, title, name, value, extraClass) =>
            button(label, title, () => run(name, value), { command: ["bold", "italic", "underline", "strikeThrough", "insertUnorderedList", "insertOrderedList"].includes(name) ? name : null, extraClass });

        async function insertLink() {
            const saved = currentRange();
            const url = await ask({
                title: "Link",
                label: "Web address (https://…) or a site path (/lore/…)",
                placeholder: "https://",
                okLabel: "Insert link"
            });

            lastRange = saved;
            restoreRange();

            if (!url) {
                return;
            }

            if (saved && saved.collapsed) {
                run("insertHTML", `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`);
            } else {
                run("createLink", url);
            }
        }

        async function insertWikiLink() {
            const saved = currentRange();
            const selected = saved && !saved.collapsed ? saved.toString() : "";
            const text = await pickLink(selected);

            lastRange = saved;
            restoreRange();

            if (text) {
                run("insertText", text);
            }
        }

        async function insertTable() {
            const saved = currentRange();
            const answer = await ask({
                title: "Insert table",
                label: "Rows × columns (the first row is a header)",
                value: "3x3",
                okLabel: "Insert"
            });

            lastRange = saved;
            restoreRange();

            const match = answer && /^(\d{1,2})\s*[x×,]\s*(\d{1,2})$/i.exec(answer);
            if (!match) {
                return;
            }

            const rows = Math.min(30, Math.max(1, Number(match[1])));
            const cols = Math.min(12, Math.max(1, Number(match[2])));
            const cell = (tag) => `<${tag}><br></${tag}>`;
            const body = Array.from({ length: rows }, (_, r) =>
                `<tr>${Array.from({ length: cols }, () => cell(r === 0 ? "th" : "td")).join("")}</tr>`
            ).join("");

            run("insertHTML", `<table><tbody>${body}</tbody></table><p><br></p>`);
        }

        // ---- table editing (acts on the cell holding the caret) ----
        function tableAction(fn) {
            return () => {
                const cell = currentCell();
                if (cell) {
                    fn(cell);
                    onInput();
                    lastRange = null;
                    tableTools.hidden = true;
                }
            };
        }

        const newCell = (tag) => {
            const el = document.createElement(tag);
            el.append(document.createElement("br"));
            return el;
        };

        const tableButtons = [
            button("+row", "Add a row below", tableAction((cell) => {
                const row = cell.closest("tr");
                const copy = document.createElement("tr");
                for (const c of row.cells) {
                    copy.append(newCell(c.tagName.toLowerCase() === "th" && row.parentElement.tagName !== "TBODY" ? "th" : "td"));
                }
                row.after(copy);
            }), { extraClass: "wide" }),
            button("+col", "Add a column to the right", tableAction((cell) => {
                const index = cell.cellIndex;
                for (const row of cell.closest("table").rows) {
                    const reference = row.cells[index];
                    if (reference) {
                        reference.after(newCell(reference.tagName.toLowerCase()));
                    }
                }
            }), { extraClass: "wide" }),
            button("−row", "Delete this row", tableAction((cell) => {
                const table = cell.closest("table");
                cell.closest("tr").remove();
                if (!table.rows.length) {
                    table.remove();
                }
            }), { extraClass: "wide" }),
            button("−col", "Delete this column", tableAction((cell) => {
                const table = cell.closest("table");
                const index = cell.cellIndex;
                for (const row of table.rows) {
                    if (row.cells[index]) {
                        row.cells[index].remove();
                    }
                }
                if (![...table.rows].some((row) => row.cells.length)) {
                    table.remove();
                }
            }), { extraClass: "wide" }),
            button("✕ table", "Delete the whole table", tableAction((cell) => cell.closest("table").remove()), { extraClass: "wide" })
        ];
        tableTools.append(...tableButtons);

        const toolbar = h("div", { class: "rich-toolbar", role: "toolbar", "aria-label": "Formatting" },
            h("span", { class: "tool-group" }, blockSelect),
            h("span", { class: "tool-group" },
                command("B", "Bold (Ctrl+B)", "bold", null, "bold"),
                command("I", "Italic (Ctrl+I)", "italic", null, "italic"),
                command("U", "Underline (Ctrl+U)", "underline", null, "underline"),
                command("S", "Strikethrough", "strikeThrough", null, "strike")),
            h("span", { class: "tool-group" },
                command("• List", "Bulleted list", "insertUnorderedList", null, "wide"),
                command("1. List", "Numbered list", "insertOrderedList", null, "wide"),
                command("⇥", "Indent (nest a list item)", "indent"),
                command("⇤", "Outdent", "outdent")),
            h("span", { class: "tool-group" },
                button("Link", "Add a web link (Ctrl+K)", insertLink, { extraClass: "wide" }),
                command("Unlink", "Remove link", "unlink", null, "wide"),
                button("[[ ]]", "Link to a lore page, category or dictionary word", insertWikiLink, { extraClass: "wide" })),
            h("span", { class: "tool-group" },
                command("―", "Horizontal rule", "insertHorizontalRule"),
                button("Table", "Insert a table", insertTable, { extraClass: "wide" }),
                command("Clear", "Clear formatting", "removeFormat", null, "wide")),
            h("span", { class: "tool-group" },
                command("↶", "Undo", "undo"),
                command("↷", "Redo", "redo")),
            tableTools
        );

        // ---- events ----
        area.addEventListener("input", () => {
            normalize();
            onInput();
            refresh();
        });

        area.addEventListener("keydown", (event) => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
                event.preventDefault();
                insertLink();
            }
        });

        area.addEventListener("paste", (event) => {
            const data = event.clipboardData;
            if (!data) {
                return;
            }
            event.preventDefault();

            const html = data.getData("text/html");
            if (html) {
                document.execCommand("insertHTML", false, cleanPastedHtml(html));
            } else {
                document.execCommand("insertText", false, data.getData("text/plain"));
            }
            normalize();
            onInput();
        });

        // Images aren't supported yet; don't let a dropped file navigate away.
        area.addEventListener("dragover", (event) => event.preventDefault());
        area.addEventListener("drop", (event) => {
            if (event.dataTransfer && event.dataTransfer.files.length) {
                event.preventDefault();
            }
        });

        try {
            document.execCommand("defaultParagraphSeparator", false, "p");
        } catch { /* unsupported */ }

        return {
            element: h("div", { class: "rich-editor" }, toolbar, area),
            focus: () => area.focus(),
            setHtml(html) {
                area.innerHTML = html || "<p><br></p>";
                lastRange = null;
            },
            getHtml() {
                const hasContent = area.textContent.trim() || area.querySelector("hr, table");
                return hasContent ? area.innerHTML : "";
            }
        };
    }

    // ------------------------------------------------------
    // [[link]] picker: lore pages, categories and dictionary words
    // ------------------------------------------------------

    function pickLink(selectedText) {
        return new Promise((resolve) => {
            let finished = false;
            let timer = null;
            let token = 0;

            const input = h("input", {
                type: "search",
                placeholder: "Search pages, categories and dictionary words…",
                autocomplete: "off",
                oninput: () => {
                    clearTimeout(timer);
                    timer = setTimeout(search, 150);
                }
            });
            const results = h("div", { class: "picker-groups" });

            const done = (text) => {
                if (finished) {
                    return;
                }
                finished = true;
                dialog.close();
                dialog.remove();
                resolve(text);
            };

            const display = (title) =>
                selectedText && selectedText.trim() && selectedText.trim() !== title ? `|${selectedText.trim()}` : "";

            const row = (main, tag, sub, text) =>
                h("button", { type: "button", class: "pick-row", onclick: () => done(text) },
                    h("span", { class: "pick-main" }, main, " ", tag),
                    sub ? h("span", { class: "sub" }, sub) : null,
                    h("code", { class: "pick-code" }, text));

            const group = (title, rows) =>
                rows.length ? h("div", { class: "pick-group" }, h("h3", {}, title), ...rows) : null;

            async function search() {
                const q = input.value.trim();
                const mine = ++token;
                const needle = slugify(q);

                const categoryRows = state.categories
                    .filter((c) => !needle || slugify(c.name).includes(needle) || c.slug.includes(needle))
                    .slice(0, 8)
                    .map((c) => row(c.name, badge("category", c.display_color, c.ink), `${c.page_count} pages`, `[[${c.slug}]]`));

                let pageRows = [];
                let wordRows = [];

                if (q) {
                    const [pages, words] = await Promise.all([
                        api("GET", `/api/lore/search-pages?q=${encodeURIComponent(q)}`).catch(() => []),
                        api("GET", `/api/dictionary/search-words?q=${encodeURIComponent(q)}`).catch(() => [])
                    ]);

                    if (mine !== token) {
                        return;
                    }

                    pageRows = pages.map((p) =>
                        row(p.title, badge(p.category_name, p.category_color, p.category_ink), p.excerpt,
                            `[[${p.category_slug}|${p.title}${display(p.title)}]]`));
                    wordRows = words.map((w) =>
                        row(w.headword, badge(w.language_name, w.language_color, w.language_ink), w.gloss,
                            `[[${w.language_slug}:${w.headword}${display(w.headword)}]]`));
                }

                const groups = [
                    group("Pages", pageRows),
                    group("Categories", categoryRows),
                    group("Dictionary words", wordRows)
                ].filter(Boolean);

                results.replaceChildren(...(groups.length ? groups : [h("p", { class: "muted" }, "No matches.")]));
            }

            const dialog = h("dialog", { class: "wide-dialog" },
                h("h2", {}, "Insert a [[link]]"),
                selectedText && selectedText.trim()
                    ? h("p", { class: "hint-block" }, `Your selected text “${selectedText.trim()}” will be used as the link's display text.`)
                    : null,
                input,
                results,
                h("div", { class: "form-actions" }, h("button", { type: "button", onclick: () => done(null) }, "Cancel"))
            );

            dialog.addEventListener("cancel", () => done(null));
            document.body.append(dialog);
            dialog.showModal();
            input.focus();
            search();
        });
    }

    // ------------------------------------------------------
    // Layout: sidebar (categories + page list) and page form
    // ------------------------------------------------------

    const categorySelect = h("select", {
        "aria-label": "Category",
        onchange: () => {
            if (!confirmDiscard()) {
                categorySelect.value = state.categoryId;
                return;
            }
            selectCategory(Number(categorySelect.value));
        }
    });

    const filterInput = h("input", {
        type: "search",
        placeholder: "Search this category…",
        "aria-label": "Search this category",
        oninput: () => {
            clearTimeout(filterInput._timer);
            filterInput._timer = setTimeout(() => {
                state.filter = filterInput.value.trim();
                loadList();
            }, 200);
        }
    });

    const sortSelect = h("select", {
        "aria-label": "Sort pages",
        onchange: () => {
            state.sort = sortSelect.value;
            store("lore.sort", state.sort);
            loadList();
        }
    },
    h("option", { value: "alpha", selected: state.sort === "alpha" }, "Sort: alphabetical"),
    h("option", { value: "updated", selected: state.sort === "updated" }, "Sort: last updated"));

    const listEl = h("ul", { class: "word-items" });
    const listFooter = h("div", { class: "list-footer" });
    const newPageButton = h("button", { class: "primary", type: "button", onclick: newPage }, "New page");
    const editCategoryButton = h("button", { type: "button", onclick: () => openCategoryDialog(currentCategory()) }, "Edit category");
    const newCategoryButton = h("button", { type: "button", onclick: () => openCategoryDialog(null) }, "New category");

    const sidebarEl = h("aside", { class: "panel sidebar" },
        categorySelect,
        h("div", { class: "row" }, editCategoryButton, newCategoryButton),
        filterInput,
        sortSelect,
        newPageButton,
        listEl,
        listFooter
    );
    const formEl = h("div", { class: "panel form-panel" });

    root.replaceChildren(sidebarEl, formEl);

    // ---- sidebar ----
    function renderCategorySelect() {
        categorySelect.replaceChildren(
            ...state.categories.map((c) =>
                h("option", {
                    value: c.id,
                    selected: c.id === state.categoryId,
                    style: `color:${c.display_color}`
                }, `■ ${c.name} — ${c.page_count}`)
            )
        );

        const category = currentCategory();
        const accent = category ? category.display_color : DEFAULT_COLOR;
        sidebarEl.style.setProperty("--lang-color", accent);
        formEl.style.setProperty("--lang-color", accent);

        categorySelect.value = state.categoryId ?? "";
        for (const control of [categorySelect, filterInput, sortSelect, newPageButton, editCategoryButton]) {
            control.disabled = state.categories.length === 0 || (control !== categorySelect && !category);
        }
    }

    function renderList() {
        listEl.replaceChildren(
            ...state.items.map((item) =>
                h("li", {
                    class: item.id === (state.draft && state.draft.id) ? "selected" : "",
                    onclick: () => openPage(item.id)
                },
                h("span", { class: "hw" }, item.title),
                h("span", { class: "sub" }, item.excerpt || "(empty)"),
                state.sort === "updated" ? h("span", { class: "sub when" }, `updated ${formatWhen(item.updated_at)}`) : null)
            )
        );

        if (state.items.length === 0) {
            listEl.append(h("li", { class: "muted" }, state.filter ? "No matches." : "No pages yet."));
        }

        const more = !state.filter && state.items.length < state.total;
        listFooter.replaceChildren(
            h("span", {}, state.filter
                ? `${state.items.length} match${state.items.length === 1 ? "" : "es"}`
                : `${state.items.length} of ${state.total}`)
        );
        if (more) {
            listFooter.append(h("button", { type: "button", onclick: () => loadList(true) }, "Load more"));
        }
    }

    let listRequest = 0;

    async function loadList(append = false) {
        if (!state.categoryId) {
            state.items = [];
            state.total = 0;
            renderList();
            return;
        }

        const mine = ++listRequest;
        const params = new URLSearchParams({
            category: state.categoryId,
            offset: append ? state.items.length : 0,
            sort: state.sort
        });
        if (state.filter) {
            params.set("q", state.filter);
        }

        try {
            const page = await api("GET", `/api/lore/pages?${params}`);
            if (mine !== listRequest) {
                return;
            }
            state.items = append ? state.items.concat(page.items) : page.items;
            state.total = page.total;
            renderList();
        } catch (error) {
            setStatus(error.message, "error");
        }
    }

    async function loadCategories() {
        state.categories = await api("GET", "/api/lore/categories");
        renderCategorySelect();
    }

    async function selectCategory(id) {
        state.categoryId = id;
        state.filter = "";
        filterInput.value = "";
        state.draft = null;
        state.dirty = false;
        store("lore.categoryId", id);
        renderCategorySelect();
        renderForm();
        await loadList();
    }

    // ---- page form ----
    function emptyDraft() {
        return {
            id: null,
            title: "",
            slug: "",
            slugTouched: false,
            categoryId: state.categoryId,
            body: "",
            isEra: false,
            era: null
        };
    }

    function draftFromPage(page) {
        return {
            id: page.id,
            title: page.title,
            slug: page.slug,
            slugTouched: true,
            categoryId: page.category_id,
            body: page.body,
            isEra: Boolean(page.is_era),
            era: page.era || null
        };
    }

    function newPage() {
        if (!confirmDiscard()) {
            return;
        }
        state.draft = emptyDraft();
        state.dirty = false;
        renderList();
        renderForm();
        formEl.querySelector("[name=title]").focus();
    }

    async function openPage(id) {
        if (state.draft && state.draft.id === id) {
            return;
        }
        if (!confirmDiscard()) {
            return;
        }

        try {
            state.draft = draftFromPage(await api("GET", `/api/lore/pages/${id}`));
            state.dirty = false;
            renderList();
            renderForm();
        } catch (error) {
            setStatus(error.message, "error");
        }
    }

    let editor = null;

    function renderForm() {
        const category = currentCategory();
        const draft = state.draft;
        statusEl = null;
        editor = null;

        if (!category) {
            formEl.replaceChildren(
                h("div", { class: "empty-state" },
                    h("p", {}, "No categories yet. Every page lives in a category."),
                    h("button", { class: "primary", type: "button", onclick: () => openCategoryDialog(null) }, "Create a category"))
            );
            return;
        }

        if (!draft) {
            formEl.replaceChildren(
                h("div", { class: "empty-state" },
                    `Select a page on the left, or click “New page” to add one to ${category.name}.`)
            );
            return;
        }

        const draftCategory = state.categories.find((c) => c.id === draft.categoryId) || category;

        const slugInput = h("input", {
            type: "text",
            name: "slug",
            value: draft.slug,
            disabled: draft.isEra,
            autocomplete: "off",
            placeholder: "generated from the title",
            oninput: () => {
                draft.slug = slugInput.value;
                draft.slugTouched = true;
                markDirty();
                updateUrl();
            }
        });
        const urlPreview = h("span", { class: "hint" });

        const updateUrl = () => {
            const slug = draft.slug || slugify(draft.title) || "…";
            urlPreview.textContent = ` — /lore/${(state.categories.find((c) => c.id === draft.categoryId) || category).slug}/${slug}`;
        };

        const titleInput = h("input", {
            type: "text",
            name: "title",
            value: draft.title,
            disabled: draft.isEra,
            autocomplete: "off",
            maxlength: "200",
            oninput: () => {
                draft.title = titleInput.value;
                if (!draft.slugTouched) {
                    draft.slug = slugify(draft.title);
                    slugInput.value = draft.slug;
                }
                markDirty();
                updateUrl();
            }
        });

        const moveSelect = h("select", {
            "aria-label": "Category of this page",
            disabled: draft.isEra,
            onchange: () => {
                draft.categoryId = Number(moveSelect.value);
                markDirty();
                updateUrl();
            }
        }, ...state.categories.map((c) => h("option", { value: c.id, selected: c.id === draft.categoryId }, c.name)));

        editor = createRichEditor({
            onInput: markDirty,
            pickLink
        });
        editor.setHtml(draft.body);

        statusEl = h("span", { class: "status" });
        updateUrl();

        formEl.replaceChildren(
            h("h2", { class: "form-title" },
                draft.id ? `Edit: ${draft.title}` : "New page",
                " ",
                badge(draftCategory.name, draftCategory.display_color, draftCategory.ink)),

            h("div", { class: "field-grid" },
                h("div", { class: "field" },
                    h("label", {}, "Title", draft.isEra ? h("span", { class: "hint" }, " — comes from the calendar's eras.json") : null),
                    titleInput),
                h("div", { class: "field" }, h("label", {}, "Category"), moveSelect)
            ),
            h("div", { class: "field" },
                h("label", {}, "URL name (slug)", urlPreview),
                slugInput),

            h("div", { class: "field" },
                h("span", { class: "label" }, "Body",
                    h("span", { class: "hint" }, " — link with [[category|Page]], [[category]] or [[language:word]]; use the [[ ]] button to search")),
                editor.element
            ),

            draft.era ? eraNotesPanel(draft.era) : null,

            h("div", { class: "form-actions" },
                h("button", { type: "button", class: "primary", onclick: save }, "Save"),
                draft.id
                    ? h("a", {
                        href: `/lore/${encodeURIComponent(draftCategory.slug)}/${encodeURIComponent(draft.slug)}`,
                        target: "_blank"
                    }, "View page ↗")
                    : null,
                statusEl,
                h("span", { class: "spacer" }),
                draft.id && !draft.isEra ? h("button", { type: "button", class: "danger", onclick: removePage }, "Delete") : null
            )
        );
    }

    // Read-only list of the calendar notes inside an era, by year.
    function eraNotesPanel(era) {
        const range = era.endYear === null
            ? `from year ${era.startYear} on`
            : `universal years ${era.startYear}–${era.endYear}`;

        return h("div", { class: "field era-notes-panel" },
            h("span", { class: "label" }, "Calendar notes in this era",
                h("span", { class: "hint" }, ` — ${range}, in date order. Read-only here: edit them in the calendar.`)),
            era.groups.length === 0
                ? h("p", { class: "hint-block" }, "No calendar notes fall within this era yet.")
                : era.groups.flatMap((group) => [
                    h("h4", { class: "era-year" },
                        h("a", { href: `/calendar/?year=${group.year}`, target: "_blank" }, `Year ${group.year}`)),
                    h("ul", { class: "era-note-list" },
                        ...group.notes.map((note) =>
                            h("li", {},
                                h("div", { class: "era-note-date" },
                                    h("a", { class: "conlang", href: `/calendar/?year=${group.year}`, target: "_blank" },
                                        `${note.monthName} ${note.dayInMonth}`),
                                    h("span", { class: "muted" }, ` · ${note.gregorian}`)),
                                note.title ? h("div", { class: "era-note-title" }, note.title) : null,
                                h("div", { class: "era-note-body" }, note.body))))
                ])
        );
    }

    async function save() {
        const draft = state.draft;

        const payload = {
            category_id: draft.categoryId,
            title: draft.title,
            slug: draft.slug,
            body: editor.getHtml()
        };

        try {
            const saved = draft.id
                ? await api("PUT", `/api/lore/pages/${draft.id}`, payload)
                : await api("POST", "/api/lore/pages", payload);

            state.draft = draftFromPage(saved);
            state.dirty = false;
            state.categoryId = saved.category_id; // follow the page if it moved
            store("lore.categoryId", state.categoryId);
            state.filter = "";
            filterInput.value = "";
            await loadCategories(); // page counts
            await loadList();
            renderForm();
            setStatus("Saved.", "ok");
        } catch (error) {
            setStatus(error.message, "error");
        }
    }

    async function removePage() {
        const draft = state.draft;

        if (!confirm(`Delete “${draft.title}”? This can't be undone.`)) {
            return;
        }

        try {
            await api("DELETE", `/api/lore/pages/${draft.id}`);
            state.draft = null;
            state.dirty = false;
            await loadCategories();
            await loadList();
            renderForm();
        } catch (error) {
            setStatus(error.message, "error");
        }
    }

    // ------------------------------------------------------
    // Category dialog
    // ------------------------------------------------------

    function openCategoryDialog(category) {
        const editing = Boolean(category);
        const builtIn = Boolean(category && category.system_key);
        let slugTouched = editing;

        const nameInput = h("input", {
            type: "text",
            disabled: builtIn,
            value: category ? category.name : "",
            oninput: () => {
                if (!slugTouched) {
                    slugInput.value = slugify(nameInput.value);
                }
                refreshColor();
            }
        });
        const slugInput = h("input", {
            type: "text",
            disabled: builtIn,
            value: category ? category.slug : "",
            oninput: () => { slugTouched = true; }
        });
        const descriptionInput = h("textarea", { value: category && category.description ? category.description : "" });
        const errorEl = h("div", { class: "status error" });

        // null = no color assigned (shown as the default gray).
        let colorValue = category && category.color ? category.color : null;
        const preview = h("span", { class: "lang-tag" });
        const colorInput = h("input", {
            type: "color",
            value: colorValue || DEFAULT_COLOR,
            "aria-label": "Category color",
            oninput: () => {
                colorValue = colorInput.value;
                refreshColor();
            }
        });
        const clearColor = h("button", {
            type: "button",
            onclick: () => {
                colorValue = null;
                colorInput.value = DEFAULT_COLOR;
                refreshColor();
            }
        }, "Use default gray");
        const colorNote = h("span", { class: "hint" });

        function refreshColor() {
            const shown = colorValue || DEFAULT_COLOR;
            preview.textContent = nameInput.value.trim() || "Badge preview";
            preview.style.setProperty("--lang-bg", shown);
            preview.style.setProperty("--lang-fg", inkFor(shown));
            colorNote.textContent = colorValue ? colorValue : "default (gray)";
            clearColor.disabled = colorValue === null;
        }

        const dialog = h("dialog", {},
            h("h2", {}, editing ? `Edit ${category.name}` : "New category"),
            builtIn
                ? h("p", { class: "hint-block" }, "A built-in category: its name and slug can't be changed and it can't be deleted. You can still change its color and description.")
                : null,
            h("div", { class: "field" }, h("label", {}, "Name"), nameInput),
            h("div", { class: "field" },
                h("label", {}, "Slug", h("span", { class: "hint" }, " — used in URLs and [[slug|Page]] links")),
                slugInput),
            h("div", { class: "field" },
                h("label", {}, "Color", h("span", { class: "hint" }, " — used for this category's badges and pages")),
                h("div", { class: "row" }, colorInput, clearColor, colorNote, h("span", { class: "grow" }), preview)),
            h("div", { class: "field" },
                h("label", {}, "Description", h("span", { class: "hint" }, " — shown at the top of the category page")),
                descriptionInput),
            errorEl,
            h("div", { class: "form-actions" },
                h("button", {
                    type: "button",
                    class: "primary",
                    onclick: async () => {
                        const payload = {
                            name: nameInput.value,
                            slug: slugInput.value,
                            color: colorValue,
                            description: descriptionInput.value
                        };

                        try {
                            const saved = editing
                                ? await api("PUT", `/api/lore/categories/${category.id}`, payload)
                                : await api("POST", "/api/lore/categories", payload);

                            await loadCategories();
                            dialog.close();

                            if (!editing || saved.id !== state.categoryId) {
                                await selectCategory(saved.id);
                            } else {
                                renderCategorySelect();
                                renderForm();
                            }
                        } catch (error) {
                            errorEl.textContent = error.message;
                        }
                    }
                }, "Save"),
                h("button", { type: "button", onclick: () => dialog.close() }, "Cancel"),
                h("span", { class: "spacer" }),
                editing && !builtIn
                    ? h("button", {
                        type: "button",
                        class: "danger",
                        onclick: async () => {
                            if (!confirm(`Delete the category “${category.name}”?`)) {
                                return;
                            }
                            try {
                                await api("DELETE", `/api/lore/categories/${category.id}`);
                                await loadCategories();
                                dialog.close();
                                await selectCategory(state.categories.length ? state.categories[0].id : null);
                            } catch (error) {
                                errorEl.textContent = error.message;
                            }
                        }
                    }, "Delete")
                    : null
            )
        );

        refreshColor();
        dialog.addEventListener("close", () => dialog.remove());
        document.body.append(dialog);
        dialog.showModal();
        nameInput.focus();
    }

    // ------------------------------------------------------
    // Start
    // ------------------------------------------------------

    (async () => {
        try {
            await loadCategories();
            const remembered = Number(load("lore.categoryId")) || null;
            const initial = state.categories.find((c) => c.id === remembered) || state.categories[0];
            await selectCategory(initial ? initial.id : null);
        } catch (error) {
            root.textContent = `Could not load the editor: ${error.message}`;
        }
    })();
})();
