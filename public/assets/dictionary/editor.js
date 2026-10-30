(() => {
    "use strict";

    const root = document.getElementById("editor");

    const POS_SUGGESTIONS = [
        "noun", "verb", "adjective", "adverb", "pronoun", "numeral",
        "particle", "preposition", "postposition", "conjunction",
        "interjection", "determiner", "affix", "prefix", "suffix",
        "phrase", "proper noun", "personal name", "family name", "toponym", "classifier"
    ];

    const LINK_HINT = "Link to other entries with [[word]] (same language), " +
        "[[lang:word]] or [[lang:word|display text]], where lang is the language's slug.";

    const state = {
        languages: [],
        languageId: null,
        items: [],
        total: 0,
        filter: "",
        sort: recallSort(),
        draft: null,
        dirty: false
    };

    // ------------------------------------------------------
    // Helpers
    // ------------------------------------------------------

    const PROPERTY_ATTRS = new Set(["value", "checked", "disabled", "hidden", "selected"]);

    // Tiny DOM builder: h("div", { class: "x", onclick: fn }, child, "text", ...)
    function h(tag, attrs, ...children) {
        const el = document.createElement(tag);

        for (const [key, value] of Object.entries(attrs || {})) {
            if (value === undefined || value === null || value === false && !PROPERTY_ATTRS.has(key)) {
                continue;
            }
            if (key.startsWith("on")) {
                el.addEventListener(key.slice(2), value);
            } else if (key === "class") {
                el.className = value;
            } else if (PROPERTY_ATTRS.has(key)) {
                el[key] = value;
            } else {
                el.setAttribute(key, value);
            }
        }

        for (const child of children.flat()) {
            if (child === null || child === undefined || child === false) {
                continue;
            }
            el.append(child);
        }

        return el;
    }

    async function api(method, url, data) {
        const options = { method, headers: {} };

        if (data !== undefined) {
            options.headers["Content-Type"] = "application/json";
            options.body = JSON.stringify(data);
        }

        const response = await fetch(url, options);
        const payload = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(payload.error || `Request failed (${response.status})`);
        }

        return payload;
    }

    function currentLanguage() {
        return state.languages.find((l) => l.id === state.languageId) || null;
    }

    function shown(headword, language) {
        return language && language.is_proto ? `*${headword}` : headword;
    }

    function formatWhen(timestamp) {
        return new Date(timestamp).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
    }

    const DEFAULT_COLOR = "#6e7681";

    // White or near-black, whichever reads better on the background.
    function inkFor(hex) {
        const channel = (offset) => {
            const c = parseInt(hex.slice(offset, offset + 2), 16) / 255;
            return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        };
        const L = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
        const dark = (0.0056 + 0.05);
        return 1.05 / (L + 0.05) >= (L + 0.05) / dark ? "#ffffff" : "#111111";
    }

    function langBadge(name, color, ink) {
        return h("span", {
            class: "lang-tag",
            style: `--lang-bg:${color || DEFAULT_COLOR};--lang-fg:${ink || "#ffffff"}`
        }, name);
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

    function slugify(name) {
        return name
            .toLowerCase()
            .normalize("NFD")
            .replace(/[̀-ͯ]/g, "")
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "");
    }

    function remember(languageId) {
        try {
            localStorage.setItem("dictionary.languageId", String(languageId));
        } catch { /* storage unavailable */ }
    }

    function rememberSort(sort) {
        try {
            localStorage.setItem("dictionary.sort", sort);
        } catch { /* storage unavailable */ }
    }

    function recallSort() {
        try {
            return localStorage.getItem("dictionary.sort") === "updated" ? "updated" : "alpha";
        } catch {
            return "alpha";
        }
    }

    function recall() {
        try {
            return Number(localStorage.getItem("dictionary.languageId")) || null;
        } catch {
            return null;
        }
    }

    // ------------------------------------------------------
    // Word picker (autocomplete over existing entries)
    // ------------------------------------------------------

    function createPicker({ languageId, placeholder, onSelect, extraParams = {} }) {
        const input = h("input", { type: "text", placeholder, autocomplete: "off" });
        const results = h("ul", { class: "picker-results", hidden: true });
        let timer = null;
        let token = 0;
        let items = [];
        let active = -1;

        function close() {
            results.hidden = true;
            active = -1;
        }

        function choose(item) {
            close();
            onSelect(item);
        }

        function renderResults(searched) {
            results.replaceChildren();

            if (items.length === 0) {
                results.append(h("li", { class: "none" }, searched ? "No matches" : "…"));
            }

            items.forEach((item, i) => {
                const detail = [item.pos, item.gloss].filter(Boolean).join(" · ");

                results.append(
                    h("li", {
                        class: i === active ? "active" : "",
                        // mousedown so the input doesn't blur (and close) first
                        onmousedown: (event) => {
                            event.preventDefault();
                            choose(item);
                        }
                    },
                    h("strong", { class: "conlang" }, shown(item.headword, { is_proto: item.language_is_proto })),
                    h("span", { class: "sub" },
                        langBadge(item.language_name, item.language_color, item.language_ink),
                        ` ${detail}`))
                );
            });

            results.hidden = false;
        }

        async function search() {
            const q = input.value.trim();
            const mine = ++token;

            if (!q) {
                close();
                return;
            }

            const params = new URLSearchParams({ q, ...extraParams });
            if (languageId) {
                params.set("language", languageId);
            }

            try {
                const found = await api("GET", `/api/dictionary/search-words?${params}`);
                if (mine === token) {
                    items = found;
                    active = -1;
                    renderResults(true);
                }
            } catch {
                close();
            }
        }

        input.addEventListener("input", () => {
            clearTimeout(timer);
            timer = setTimeout(search, 150);
        });

        input.addEventListener("blur", close);

        input.addEventListener("keydown", (event) => {
            if (results.hidden || items.length === 0) {
                return;
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                active = (active + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
                renderResults(true);
            } else if (event.key === "Enter" && active >= 0) {
                event.preventDefault();
                choose(items[active]);
            } else if (event.key === "Escape") {
                close();
            }
        });

        return h("div", { class: "picker" }, input, results);
    }

    // ------------------------------------------------------
    // Layout
    // ------------------------------------------------------

    const languageSelect = h("select", {
        "aria-label": "Language",
        onchange: () => {
            if (!confirmDiscard()) {
                languageSelect.value = state.languageId;
                return;
            }
            selectLanguage(Number(languageSelect.value));
        }
    });

    const filterInput = h("input", {
        type: "search",
        placeholder: "Search this language…",
        "aria-label": "Search this language",
        oninput: () => {
            clearTimeout(filterInput._timer);
            filterInput._timer = setTimeout(() => {
                state.filter = filterInput.value.trim();
                loadList();
            }, 200);
        }
    });

    const sortSelect = h("select", {
        "aria-label": "Sort words",
        onchange: () => {
            state.sort = sortSelect.value;
            rememberSort(state.sort);
            loadList();
        }
    },
    h("option", { value: "alpha", selected: state.sort === "alpha" }, "Sort: alphabetical"),
    h("option", { value: "updated", selected: state.sort === "updated" }, "Sort: last updated"));

    const listEl = h("ul", { class: "word-items" });
    const listFooter = h("div", { class: "list-footer" });
    const newWordButton = h("button", { class: "primary", type: "button", onclick: newWord }, "New word");
    const editLanguageButton = h("button", {
        type: "button",
        onclick: () => openLanguageDialog(currentLanguage())
    }, "Edit language");
    const newLanguageButton = h("button", {
        type: "button",
        onclick: () => openLanguageDialog(null)
    }, "New language");

    const formEl = h("div", { class: "panel form-panel" });

    const sidebarEl = h("aside", { class: "panel sidebar" },
            languageSelect,
            h("div", { class: "row" }, editLanguageButton, newLanguageButton),
            filterInput,
            sortSelect,
            newWordButton,
            listEl,
            listFooter
        );

    root.replaceChildren(sidebarEl, formEl);

    // ------------------------------------------------------
    // Sidebar
    // ------------------------------------------------------

    function renderLanguageSelect() {
        languageSelect.replaceChildren(
            ...state.languages.map((language) =>
                h("option", {
                    value: language.id,
                    selected: language.id === state.languageId,
                    style: `color:${language.display_color}`
                },
                `■ ${language.name}${language.is_proto ? " (reconstructed)" : ""} — ${language.word_count}`)
            )
        );

        const accent = currentLanguage() ? currentLanguage().display_color : DEFAULT_COLOR;
        sidebarEl.style.setProperty("--lang-color", accent);
        formEl.style.setProperty("--lang-color", accent);
        languageSelect.value = state.languageId ?? "";
        languageSelect.disabled = state.languages.length === 0;
        editLanguageButton.disabled = !currentLanguage();
        newWordButton.disabled = !currentLanguage();
        filterInput.disabled = !currentLanguage();
        sortSelect.disabled = !currentLanguage();
    }

    function renderList() {
        const language = currentLanguage();
        listEl.replaceChildren(
            ...state.items.map((item) =>
                h("li", {
                    class: item.id === (state.draft && state.draft.id) ? "selected" : "",
                    onclick: () => openWord(item.id)
                },
                h("span", { class: "hw conlang" }, shown(item.headword, language)),
                h("span", { class: "sub" },
                    item.era_start_year != null ? "🔒 built in · " : "",
                    [item.pos, item.gloss].filter(Boolean).join(" · ")),
                state.sort === "updated"
                    ? h("span", { class: "sub when" }, `updated ${formatWhen(item.updated_at)}`)
                    : null)
            )
        );

        if (state.items.length === 0) {
            listEl.append(h("li", { class: "muted" }, state.filter ? "No matches." : "No words yet."));
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
        if (!state.languageId) {
            state.items = [];
            state.total = 0;
            renderList();
            return;
        }

        const mine = ++listRequest;
        const params = new URLSearchParams({
            language: state.languageId,
            offset: append ? state.items.length : 0,
            sort: state.sort
        });
        if (state.filter) {
            params.set("q", state.filter);
        }

        try {
            const page = await api("GET", `/api/dictionary/words?${params}`);
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

    async function loadLanguages() {
        state.languages = await api("GET", "/api/dictionary/languages");
        renderLanguageSelect();
    }

    async function selectLanguage(id) {
        state.languageId = id;
        state.filter = "";
        filterInput.value = "";
        state.draft = null;
        state.dirty = false;
        remember(id);
        renderLanguageSelect();
        renderForm();
        await loadList();
    }

    // ------------------------------------------------------
    // Word form
    // ------------------------------------------------------

    function emptyDraft() {
        return {
            id: null,
            headword: "",
            pos: "",
            gender: "",
            pronunciation: "",
            sinographs: "",
            etymology: "",
            senses: [""],
            variantOf: [],
            variantForms: [],
            ancestors: []
        };
    }

    function draftFromWord(word) {
        return {
            // Built-in entries generated from the calendar's eras are read-only.
            locked: word.era_start_year !== null && word.era_start_year !== undefined,
            lorePages: word.lore_pages || [],
            id: word.id,
            headword: word.headword,
            pos: word.pos || "",
            gender: word.gender || "",
            pronunciation: word.pronunciation || "",
            sinographs: word.sinographs || "",
            etymology: word.etymology || "",
            senses: word.senses.length ? word.senses.slice() : [""],
            variantOf: word.variantOf.map((v) => ({
                id: v.id,
                kind: v.kind,
                label: shown(v.headword, { is_proto: v.language_is_proto }),
                language: v.language_name
            })),
            // Words that are variants of this one: this word is a base word
            // and so can't itself become a variant.
            variantForms: word.variantForms.map((v) => v.headword),
            ancestors: word.ancestors.map((a) => ({
                id: a.id,
                kind: a.kind,
                note: a.note || "",
                label: shown(a.headword, { is_proto: a.language_is_proto }),
                language: a.language_name,
                color: a.language_color,
                ink: a.language_ink
            }))
        };
    }

    function newWord() {
        if (!confirmDiscard()) {
            return;
        }
        state.draft = emptyDraft();
        state.dirty = false;
        renderList();
        renderForm();
        formEl.querySelector("[name=headword]").focus();
    }

    async function openWord(id) {
        if (state.draft && state.draft.id === id) {
            return;
        }
        if (!confirmDiscard()) {
            return;
        }

        try {
            state.draft = draftFromWord(await api("GET", `/api/dictionary/words/${id}`));
            state.dirty = false;
            renderList();
            renderForm();
        } catch (error) {
            setStatus(error.message, "error");
        }
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

    // A labelled text field bound to a draft property.
    // `conlang` marks fields that hold words of the language (sans-serif).
    function textField(label, name, { hint, tag = "input", list, placeholder, conlang = false } = {}) {
        const control = h(tag, {
            name,
            class: conlang ? "conlang" : undefined,
            value: state.draft[name],
            list,
            placeholder,
            autocomplete: "off",
            oninput: () => {
                state.draft[name] = control.value;
                markDirty();
            }
        });

        return h("div", { class: "field" },
            h("label", {}, label, hint ? h("span", { class: "hint" }, ` — ${hint}`) : null),
            control
        );
    }

    function kindSelect(options, value, onchange) {
        const select = h("select", {
            onchange: () => {
                onchange(select.value);
                markDirty();
            }
        }, ...options.map(([val, text]) => h("option", { value: val, selected: val === value }, text)));
        return select;
    }

    function removeButton(onclick, label = "Remove") {
        return h("button", { type: "button", class: "small-button danger", title: label, onclick }, "✕");
    }

    function renderForm() {
        const language = currentLanguage();
        const draft = state.draft;
        statusEl = null;

        if (!language) {
            formEl.replaceChildren(
                h("div", { class: "empty-state" },
                    h("p", {}, "No languages yet."),
                    h("button", { class: "primary", type: "button", onclick: () => openLanguageDialog(null) },
                        "Create a language"))
            );
            return;
        }

        if (!draft) {
            formEl.replaceChildren(
                h("div", { class: "empty-state" },
                    `Select a word on the left, or click “New word” to add one to ${language.name}.`)
            );
            return;
        }

        const sensesEl = h("div", { class: "list-rows" });
        const variantsEl = h("div", { class: "list-rows" });
        const ancestorsEl = h("div", { class: "list-rows" });

        // ---- Senses ----
        function renderSenses() {
            sensesEl.replaceChildren(
                ...draft.senses.map((sense, i) => {
                    const area = h("textarea", {
                        value: sense,
                        placeholder: "English definition",
                        oninput: () => {
                            draft.senses[i] = area.value;
                            markDirty();
                        }
                    });

                    const move = (delta) => {
                        const j = i + delta;
                        [draft.senses[i], draft.senses[j]] = [draft.senses[j], draft.senses[i]];
                        markDirty();
                        renderSenses();
                    };

                    return h("div", { class: "list-row" },
                        h("span", { class: "sense-number" }, `${i + 1}.`),
                        h("div", { class: "grow" }, area),
                        h("button", {
                            type: "button", class: "small-button", title: "Move up",
                            disabled: i === 0, onclick: () => move(-1)
                        }, "↑"),
                        h("button", {
                            type: "button", class: "small-button", title: "Move down",
                            disabled: i === draft.senses.length - 1, onclick: () => move(1)
                        }, "↓"),
                        removeButton(() => {
                            draft.senses.splice(i, 1);
                            markDirty();
                            renderSenses();
                        }, "Remove sense")
                    );
                })
            );
        }

        // ---- Variants (same language only) ----
        function renderVariants() {
            variantsEl.replaceChildren(
                ...draft.variantOf.map((variant, i) =>
                    h("div", { class: "list-row" },
                        h("div", { class: "grow" },
                            variant.id
                                ? h("div", { class: "picked conlang" }, variant.label)
                                : createPicker({
                                    languageId: language.id,
                                    placeholder: `Find a base word in ${language.name}…`,
                                    // Only base words (not variants themselves) can be parents.
                                    extraParams: {
                                        variantParents: "1",
                                        ...(draft.id ? { exclude: draft.id } : {})
                                    },
                                    onSelect: (item) => {
                                        if (item.id === draft.id) {
                                            setStatus("A word cannot be a variant of itself.", "error");
                                            return;
                                        }
                                        Object.assign(variant, {
                                            id: item.id,
                                            label: shown(item.headword, language),
                                            language: item.language_name
                                        });
                                        markDirty();
                                        renderVariants();
                                    }
                                })),
                        kindSelect(
                            [["dialectal", "dialectal variant"], ["spelling", "spelling variant"]],
                            variant.kind,
                            (value) => { variant.kind = value; }
                        ),
                        removeButton(() => {
                            draft.variantOf.splice(i, 1);
                            markDirty();
                            renderVariants();
                        })
                    )
                )
            );
        }

        // ---- Ancestors (any language) ----
        function renderAncestors() {
            ancestorsEl.replaceChildren(
                ...draft.ancestors.map((ancestor, i) =>
                    h("div", { class: "list-row" },
                        h("div", { class: "grow" },
                            ancestor.id
                                ? h("div", { class: "picked" },
                                    h("span", { class: "conlang" }, ancestor.label), " ",
                                    langBadge(ancestor.language, ancestor.color, ancestor.ink))
                                : createPicker({
                                    languageId: null,
                                    placeholder: "Find a word in any language…",
                                    onSelect: (item) => {
                                        if (item.id === draft.id) {
                                            setStatus("A word cannot be its own ancestor.", "error");
                                            return;
                                        }
                                        Object.assign(ancestor, {
                                            id: item.id,
                                            label: shown(item.headword, { is_proto: item.language_is_proto }),
                                            language: item.language_name,
                                            color: item.language_color,
                                            ink: item.language_ink
                                        });
                                        markDirty();
                                        renderAncestors();
                                    }
                                })),
                        kindSelect(
                            [["inherited", "inherited from"], ["borrowed", "borrowed from"], ["areal", "areally related to"]],
                            ancestor.kind,
                            (value) => { ancestor.kind = value; }
                        ),
                        h("input", {
                            type: "text",
                            placeholder: "Note (optional)",
                            value: ancestor.note,
                            oninput: (event) => {
                                ancestor.note = event.target.value;
                                markDirty();
                            }
                        }),
                        removeButton(() => {
                            draft.ancestors.splice(i, 1);
                            markDirty();
                            renderAncestors();
                        })
                    )
                )
            );
        }

        renderSenses();
        renderVariants();
        renderAncestors();

        const posList = h("datalist", { id: "pos-suggestions" },
            ...POS_SUGGESTIONS.map((pos) => h("option", { value: pos })));

        const genderField = language.has_gender
            ? h("div", { class: "field" },
                h("label", {}, "Gender"),
                (() => {
                    const select = h("select", {
                        name: "gender",
                        onchange: () => {
                            draft.gender = select.value;
                            markDirty();
                        }
                    },
                    ...[["", "—"], ["masculine", "masculine"], ["feminine", "feminine"], ["neuter", "neuter"]]
                        .map(([val, text]) => h("option", { value: val, selected: val === draft.gender }, text)));
                    return select;
                })())
            : null;

        statusEl = h("span", { class: "status" });

        formEl.replaceChildren(
            h("h2", { class: "form-title" },
                draft.id
                    ? ["Edit: ", h("span", { class: "conlang" }, shown(draft.headword, language))]
                    : "New word",
                " ",
                langBadge(language.name, language.display_color, language.ink)),

            h("div", { class: "field-grid" },
                textField("Headword", "headword", { conlang: true }),
                textField("Part of speech", "pos", { list: "pos-suggestions" }),
                genderField
            ),
            posList,

            h("div", { class: "field-grid" },
                textField("Pronunciation", "pronunciation", { hint: "optional", conlang: true }),
                textField("Sinographs", "sinographs", { hint: "optional", conlang: true })
            ),

            h("div", { class: "field" },
                h("span", { class: "label" }, "Definitions",
                    h("span", { class: "hint" }, " — one per sense. ", LINK_HINT)),
                sensesEl,
                h("div", {}, h("button", {
                    type: "button",
                    onclick: () => {
                        draft.senses.push("");
                        markDirty();
                        renderSenses();
                        const areas = sensesEl.querySelectorAll("textarea");
                        areas[areas.length - 1].focus();
                    }
                }, "Add sense"))
            ),

            textField("Etymology notes", "etymology", { tag: "textarea", hint: LINK_HINT }),

            h("div", { class: "field" },
                h("span", { class: "label" }, "Ancestral / areal forms",
                    h("span", { class: "hint" }, " — words (in any language) this one descends from")),
                ancestorsEl,
                h("div", {}, h("button", {
                    type: "button",
                    onclick: () => {
                        draft.ancestors.push({ id: null, kind: "inherited", note: "", label: "", language: "" });
                        renderAncestors();
                        const pickers = ancestorsEl.querySelectorAll(".picker input");
                        pickers[pickers.length - 1].focus();
                    }
                }, "Add ancestor"))
            ),

            h("div", { class: "field" },
                h("span", { class: "label" }, "Variant of",
                    h("span", { class: "hint" },
                        ` — dialectal or spelling variant of a base word in ${language.name}. ` +
                        "Only base words can have variants; a variant can't be given variants.")),
                variantsEl,
                draft.variantForms.length && draft.variantOf.length === 0
                    ? h("p", { class: "hint-block" },
                        `This word is the base word of ${draft.variantForms.join(", ")}, ` +
                        "so it can't itself be a variant of another word.")
                    : h("div", {}, h("button", {
                        type: "button",
                        onclick: () => {
                            draft.variantOf.push({ id: null, kind: "dialectal", label: "", language: "" });
                            renderVariants();
                            const pickers = variantsEl.querySelectorAll(".picker input");
                            pickers[pickers.length - 1].focus();
                        }
                    }, "Add variant"))
            ),

            h("div", { class: "field" },
                h("span", { class: "label" }, "Inflection tables"),
                h("div", { class: "placeholder-box" }, "Declension and conjugation tables will be added here later.")
            ),

            h("div", { class: "form-actions" },
                draft.locked ? null : h("button", { type: "button", class: "primary", onclick: save }, "Save"),
                draft.id
                    ? h("a", {
                        href: `/dictionary/${encodeURIComponent(language.slug)}/${encodeURIComponent(draft.headword)}`,
                        target: "_blank"
                    }, "View in dictionary ↗")
                    : null,
                statusEl,
                h("span", { class: "spacer" }),
                draft.id && !draft.locked ? h("button", { type: "button", class: "danger", onclick: removeWord }, "Delete") : null
            )
        );

        // A built-in entry: show everything, but read-only, with a pointer to
        // the lore page where its text can be edited.
        if (draft.locked) {
            const title = formEl.querySelector(".form-title");
            const actions = formEl.querySelector(".form-actions");
            const fieldset = h("fieldset", { class: "locked-fields", disabled: true });

            for (const node of [...formEl.children]) {
                if (node !== title && node !== actions) {
                    fieldset.append(node);
                }
            }

            const lorePage = draft.lorePages[0];
            title.after(
                h("p", { class: "hint-block" },
                    "🔒 Built in: this entry is generated from the calendar's eras and can't be edited or deleted here. ",
                    lorePage
                        ? ["Edit its lore page instead: ",
                            h("a", {
                                href: `/lore/${encodeURIComponent(lorePage.category_slug)}/${encodeURIComponent(lorePage.slug)}`,
                                target: "_blank"
                            }, `${lorePage.category_name} › ${lorePage.title} ↗`)]
                        : "Its name and sinographs come from eras.json."),
                fieldset
            );
        }
    }

    async function save() {
        const draft = state.draft;
        const language = currentLanguage();

        const payload = {
            headword: draft.headword,
            pos: draft.pos,
            gender: draft.gender,
            pronunciation: draft.pronunciation,
            sinographs: draft.sinographs,
            etymology: draft.etymology,
            senses: draft.senses,
            variantOf: draft.variantOf.filter((v) => v.id).map((v) => ({ id: v.id, kind: v.kind })),
            ancestors: draft.ancestors
                .filter((a) => a.id)
                .map((a) => ({ id: a.id, kind: a.kind, note: a.note }))
        };

        try {
            const saved = draft.id
                ? await api("PUT", `/api/dictionary/words/${draft.id}`, payload)
                : await api("POST", "/api/dictionary/words", { ...payload, language_id: language.id });

            state.draft = draftFromWord(saved);
            state.dirty = false;
            await loadLanguages(); // word counts
            await loadList();
            renderForm();
            setStatus("Saved.", "ok");
        } catch (error) {
            setStatus(error.message, "error");
        }
    }

    async function removeWord() {
        const draft = state.draft;

        if (!confirm(`Delete “${draft.headword}”? Links to it from other entries will be removed.`)) {
            return;
        }

        try {
            await api("DELETE", `/api/dictionary/words/${draft.id}`);
            state.draft = null;
            state.dirty = false;
            await loadLanguages();
            await loadList();
            renderForm();
        } catch (error) {
            setStatus(error.message, "error");
        }
    }

    // ------------------------------------------------------
    // Language dialog
    // ------------------------------------------------------

    function openLanguageDialog(language) {
        const editing = Boolean(language);
        let slugTouched = editing;

        const nameInput = h("input", {
            type: "text", value: language ? language.name : "",
            oninput: () => {
                if (!slugTouched) {
                    slugInput.value = slugify(nameInput.value);
                }
            }
        });
        const slugInput = h("input", {
            type: "text", value: language ? language.slug : "",
            oninput: () => { slugTouched = true; }
        });
        const protoInput = h("input", { type: "checkbox", checked: language ? Boolean(language.is_proto) : false });
        const genderInput = h("input", { type: "checkbox", checked: language ? Boolean(language.has_gender) : false });
        const notesInput = h("textarea", { value: language && language.notes ? language.notes : "" });

        // null = no color assigned (shown as the default gray).
        let colorValue = language && language.color ? language.color : null;
        const preview = h("span", { class: "lang-tag" });
        const colorInput = h("input", {
            type: "color",
            value: colorValue || DEFAULT_COLOR,
            "aria-label": "Language color",
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
            const shownColor = colorValue || DEFAULT_COLOR;
            preview.textContent = nameInput.value.trim() || "Badge preview";
            preview.style.setProperty("--lang-bg", shownColor);
            preview.style.setProperty("--lang-fg", inkFor(shownColor));
            colorNote.textContent = colorValue ? colorValue : "default (gray)";
            clearColor.disabled = colorValue === null;
        }
        const errorEl = h("div", { class: "status error" });

        const dialog = h("dialog", {},
            h("h2", {}, editing ? `Edit ${language.name}` : "New language"),
            h("div", { class: "field" }, h("label", {}, "Name"), nameInput),
            h("div", { class: "field" },
                h("label", {}, "Slug", h("span", { class: "hint" }, " — used in URLs and [[slug:word]] links")),
                slugInput),
            h("div", { class: "field check" }, protoInput, h("label", {}, "Reconstructed / proto-language")),
            h("div", { class: "field check" }, genderInput, h("label", {}, "Has grammatical gender")),
            h("div", { class: "field" },
                h("label", {}, "Color", h("span", { class: "hint" }, " — used for this language's badges and pages")),
                h("div", { class: "row" }, colorInput, clearColor, colorNote, h("span", { class: "grow" }), preview)),
            h("div", { class: "field" }, h("label", {}, "Notes"), notesInput),
            errorEl,
            h("div", { class: "form-actions" },
                h("button", {
                    type: "button", class: "primary",
                    onclick: async () => {
                        const payload = {
                            name: nameInput.value,
                            slug: slugInput.value,
                            is_proto: protoInput.checked,
                            has_gender: genderInput.checked,
                            notes: notesInput.value,
                            color: colorValue
                        };

                        try {
                            const saved = editing
                                ? await api("PUT", `/api/dictionary/languages/${language.id}`, payload)
                                : await api("POST", "/api/dictionary/languages", payload);

                            await loadLanguages();
                            dialog.close();

                            if (!editing || saved.id !== state.languageId) {
                                await selectLanguage(saved.id);
                            } else {
                                renderLanguageSelect();
                                renderList();
                                renderForm();
                            }
                        } catch (error) {
                            errorEl.textContent = error.message;
                        }
                    }
                }, "Save"),
                h("button", { type: "button", onclick: () => dialog.close() }, "Cancel"),
                h("span", { class: "spacer" }),
                editing && !language.system_key
                    ? h("button", {
                        type: "button", class: "danger",
                        onclick: async () => {
                            if (!confirm(`Delete the language “${language.name}”?`)) {
                                return;
                            }
                            try {
                                await api("DELETE", `/api/dictionary/languages/${language.id}`);
                                await loadLanguages();
                                dialog.close();
                                await selectLanguage(state.languages.length ? state.languages[0].id : null);
                            } catch (error) {
                                errorEl.textContent = error.message;
                            }
                        }
                    }, "Delete")
                    : null
            )
        );

        nameInput.addEventListener("input", refreshColor);
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
            await loadLanguages();
            const remembered = recall();
            const initial = state.languages.find((l) => l.id === remembered) || state.languages[0];
            await selectLanguage(initial ? initial.id : null);
        } catch (error) {
            root.textContent = `Could not load the editor: ${error.message}`;
        }
    })();
})();
