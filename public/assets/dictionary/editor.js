(() => {
    "use strict";

    const root = document.getElementById("editor");
    const { hiddenField, hiddenMark, locked } = window.UI;

    // What a verb can be (kept in step with VERB_TRAITS in lib/dictionary.js).
    const VERB_TRAITS = ["transitive", "intransitive", "ditransitive", "mediopassive", "stative", "reflexive", "causative", "unaccusative"];
    const isVerb = (pos) => (pos || "").trim().toLowerCase() === "verb";
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
        templates: [],
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
    const soundsButton = h("button", {
        type: "button",
        title: "The language's phoneme inventory, and which letters stand for which sounds",
        onclick: () => openPhonologyDialog(currentLanguage())
    }, "Sounds and spelling");
    const templatesButton = h("button", {
        type: "button",
        title: "The language's inflection templates: paradigms of forms along categories such as person, number, tense and case",
        onclick: () => openTemplatesDialog(currentLanguage())
    }, "Inflection templates");
    const newLanguageButton = h("button", {
        type: "button",
        onclick: () => openLanguageDialog(null)
    }, "New language");

    const formEl = h("div", { class: "panel form-panel" });

    const sidebarEl = h("aside", { class: "panel sidebar" },
            languageSelect,
            h("div", { class: "row" }, editLanguageButton, newLanguageButton),
            h("div", { class: "row" }, soundsButton, templatesButton),
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
                `■ ${language.name}${language.is_proto ? " (reconstructed)" : ""} — ${language.word_count}${language.hidden ? " · not published" : ""}`)
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
                h("span", { class: "hw conlang" }, shown(item.headword, language), item.hidden ? hiddenMark() : null),
                h("span", { class: "sub" },
                    item.era_start_year != null ? [Icons.el("lock"), " built in · "] : "",
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

    // The language's inflection templates (for the word form's tables).
    async function loadTemplates() {
        state.templates = [];
        if (state.languageId) {
            try {
                state.templates = await api("GET", `/api/dictionary/inflection-templates?language=${state.languageId}`);
            } catch (error) {
                state.templates = [];
            }
        }
    }

    async function selectLanguage(id) {
        state.languageId = id;
        await loadTemplates();
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
            verb_traits: [],
            pronunciation: "",
            sinographs: "",
            etymology: "",
            hidden: false,
            senses: [""],
            variantOf: [],
            variantForms: [],
            ancestors: [],
            inflections: []
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
            verb_traits: word.verb_traits || [],
            pronunciation: word.pronunciation || "",
            sinographs: word.sinographs || "",
            etymology: word.etymology || "",
            hidden: Boolean(word.hidden),
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
            inflections: (word.inflections || []).map((i) => ({
                template_id: i.template_id,
                stem: i.stem || "",
                overrides: { ...i.overrides }
            })),
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
    function textField(label, name, { hint, tag = "input", list, placeholder, conlang = false, onChange } = {}) {
        const control = h(tag, {
            name,
            class: conlang ? "conlang" : undefined,
            value: state.draft[name],
            list,
            placeholder,
            autocomplete: "off",
            oninput: () => {
                state.draft[name] = control.value;
                if (onChange) {
                    onChange();
                }
                markDirty();
            }
        });

        return h("div", { class: "field" },
            h("label", {}, label, hint ? h("span", { class: "hint" }, ` — ${hint}`) : null),
            control
        );
    }

    // The pronunciation box, with a button that writes it from the headword's spelling when the
    // language has an orthography set (see "Sounds and spelling").
    function pronunciationField() {
        const field = textField("Pronunciation", "pronunciation", { hint: "optional", conlang: true });
        const input = field.querySelector("input");
        const message = h("span", { class: "hint" });
        const button = h("button", {
            type: "button",
            title: "Write the pronunciation from the headword's spelling (set the spelling under Sounds and spelling)",
            onclick: async () => {
                message.textContent = "";
                try {
                    const result = await api("GET", `/api/dictionary/transcribe?language=${state.languageId}&q=${encodeURIComponent(state.draft.headword || "")}`);
                    if (result.ipa) {
                        state.draft.pronunciation = result.ipa;
                        input.value = result.ipa;
                        markDirty();
                    } else if (!result.hasSpelling) {
                        message.textContent = " This language has no spelling set yet.";
                    } else {
                        message.textContent = ` No letter for: ${result.unknown.join(", ") || "(nothing to read)"}.`;
                    }
                } catch (error) {
                    message.textContent = ` ${error.message}`;
                }
            }
        }, "From spelling");
        field.append(h("div", { class: "row" }, button, message));
        return field;
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
        return h("button", { type: "button", class: "small-button danger", title: label, onclick }, Icons.el("close"));
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
        const importEl = h("div", { class: "import-senses" });
        const inflectionBox = inflectionSection(draft, language, markDirty);

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
                                        renderImport();
                                    }
                                })),
                        kindSelect(
                            [["inherited", "inherited from"], ["borrowed", "borrowed from"], ["areal", "areally related to"]],
                            ancestor.kind,
                            (value) => { ancestor.kind = value; renderImport(); }
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
                            renderImport();
                        })
                    )
                )
            );
        }

        // ---- Import the senses of the ancestor word(s) ----
        // One button per ancestor (inherited ones first): copies all of its senses here, skipping any
        // this word already has, so the parent language's meanings are a click away.
        function renderImport() {
            const ancestors = draft.ancestors
                .filter((a) => a.id)
                .sort((a, b) => Number(b.kind === "inherited") - Number(a.kind === "inherited"));
            importEl.replaceChildren(...ancestors.map((ancestor) => h("button", {
                type: "button",
                title: `Copy every definition of ${ancestor.label} (${ancestor.language}) into this word`,
                onclick: async (event) => {
                    const button = event.currentTarget;
                    button.disabled = true;
                    try {
                        const parent = await api("GET", `/api/dictionary/words/${ancestor.id}`);
                        const have = new Set(draft.senses.map((x) => x.trim()));
                        const fresh = parent.senses.filter((x) => x.trim() && !have.has(x.trim()));
                        if (draft.senses.length === 1 && !draft.senses[0].trim()) {
                            draft.senses = [];
                        }
                        draft.senses.push(...fresh);
                        if (!draft.senses.length) {
                            draft.senses = [""];
                        }
                        markDirty();
                        renderSenses();
                        setStatus(fresh.length ? `Imported ${fresh.length} sense${fresh.length === 1 ? "" : "s"} from ${ancestor.label}.` : `${ancestor.label} has no senses this word doesn't already have.`, fresh.length ? "ok" : "");
                    } catch (error) {
                        setStatus(error.message, "error");
                    } finally {
                        button.disabled = false;
                    }
                }
            }, `Import senses from ${ancestor.label} (${ancestor.language})`)));
        }

        renderSenses();
        renderVariants();
        renderAncestors();
        renderImport();

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

        // Tick boxes for what a verb is; they appear only while the part of speech is "verb".
        const traitsField = h("div", { class: "field verb-traits-field", hidden: !isVerb(draft.pos) },
            h("span", { class: "label" }, "Verb type", h("span", { class: "hint" }, " — optional")),
            h("div", { class: "trait-list" },
                ...VERB_TRAITS.map((trait) => {
                    const box = h("input", {
                        type: "checkbox",
                        checked: draft.verb_traits.includes(trait),
                        onchange: () => {
                            draft.verb_traits = VERB_TRAITS.filter((t) => (t === trait ? box.checked : draft.verb_traits.includes(t)));
                            markDirty();
                        }
                    });
                    return h("label", {}, box, trait);
                })));

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
                textField("Part of speech", "pos", { list: "pos-suggestions", onChange: () => { traitsField.hidden = !isVerb(state.draft.pos); } }),
                genderField
            ),
            posList,
            traitsField,

            h("div", { class: "field-grid" },
                pronunciationField(),
                textField("Sinographs", "sinographs", { hint: "optional", conlang: true })
            ),

            h("div", { class: "field" },
                h("span", { class: "label" }, "Definitions",
                    h("span", { class: "hint" }, " — one per sense. ", LINK_HINT)),
                sensesEl,
                importEl,
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
                h("span", { class: "label" }, "Inflection tables",
                    h("span", { class: "hint" }, " — the paradigms this word follows (templates are made under Inflection templates)")),
                inflectionBox
            ),

            hiddenField(draft.hidden, (value) => { draft.hidden = value; markDirty(); }).element,

            h("div", { class: "form-actions" },
                h("button", { type: "button", class: "primary", onclick: save }, "Save"),
                draft.id
                    ? h("a", {
                        href: `/dictionary/${encodeURIComponent(language.slug)}/${encodeURIComponent(draft.headword)}`,
                        target: "_blank"
                    }, "View in dictionary ", Icons.el("external"))
                    : null,
                statusEl,
                h("span", { class: "spacer" }),
                draft.id && !draft.locked ? h("button", { type: "button", class: "danger", disabled: locked("word", draft.id), onclick: removeWord }, "Delete") : null
            )
        );

        // The tables' placeholders follow the headword; the suggested templates follow the part of speech.
        formEl.querySelector("[name=headword]").addEventListener("input", () => inflectionBox.refresh());

        // A built-in entry: show everything read-only, except the etymology
        // notes (the only part that can be edited), with a pointer to the lore
        // page where the rest of its text lives.
        if (draft.locked) {
            const title = formEl.querySelector(".form-title");
            const actions = formEl.querySelector(".form-actions");

            for (const node of [...formEl.children]) {
                if (node === title || node === actions || node.querySelector("[name=etymology]")) {
                    continue; // title, buttons and the etymology field stay live
                }
                const fieldset = h("fieldset", { class: "locked-fields", disabled: true });
                node.replaceWith(fieldset);
                fieldset.append(node);
            }

            const lorePage = draft.lorePages[0];
            title.after(
                h("p", { class: "hint-block" },
                    Icons.el("lock"), " Built in: this entry is generated from the calendar's eras. Only the etymology notes can be edited here; ",
                    lorePage
                        ? ["the rest comes from its lore page: ",
                            h("a", {
                                href: `/lore/${encodeURIComponent(lorePage.category_slug)}/${encodeURIComponent(lorePage.slug)}`,
                                target: "_blank"
                            }, `${lorePage.category_name} › ${lorePage.title} `, Icons.el("external"))]
                        : "the rest comes from eras.json.")
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
            verb_traits: isVerb(draft.pos) ? draft.verb_traits : [],
            pronunciation: draft.pronunciation,
            sinographs: draft.sinographs,
            etymology: draft.etymology,
            hidden: draft.hidden,
            senses: draft.senses,
            variantOf: draft.variantOf.filter((v) => v.id).map((v) => ({ id: v.id, kind: v.kind })),
            ancestors: draft.ancestors
                .filter((a) => a.id)
                .map((a) => ({ id: a.id, kind: a.kind, note: a.note })),
            inflections: draft.inflections.map((i) => ({ template_id: i.template_id, stem: i.stem, overrides: i.overrides }))
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
        const hiddenInput = hiddenField(language && language.hidden);

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
            hiddenInput.element,
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
                            color: colorValue,
                            hidden: hiddenInput.input.checked
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
                        type: "button", class: "danger", disabled: locked("language", language.id),
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
    // Inflection templates (paradigms) and the tables words follow
    // ------------------------------------------------------

    const cellPaths = (dims) => dims.reduce((out, dim) => out.flatMap((path) => dim.values.map((_, i) => [...path, i])), [[]]);
    const cellKeyOf = (row, col) => `${row.join(".")}|${col.join(".")}`;

    // The table for a template: category values down the side and along the top, nested; renderCell(key)
    // gives the content of each cell.
    function templateGrid(template, renderCell) {
        const rowPaths = cellPaths(template.rows);
        const colPaths = cellPaths(template.cols);
        const R = template.rows.length;
        const C = template.cols.length;
        const span = (dims, level) => dims.slice(level + 1).reduce((n, dim) => n * dim.values.length, 1);

        const head = [];
        if (C === 0) {
            head.push(h("tr", {}, ...template.rows.map((d) => h("th", { class: "axis" }, d.name)), h("th", {}, "Form")));
        } else {
            for (let level = 0; level < C; level++) {
                head.push(h("tr", {},
                    level === 0 && R ? h("th", { class: "corner", rowspan: String(C), colspan: String(R) }, template.rows.map((d) => d.name).join(" / ")) : null,
                    ...colPaths
                        .filter((path) => path.slice(level + 1).every((i) => i === 0))
                        .map((path) => h("th", { colspan: String(span(template.cols, level)) }, template.cols[level].values[path[level]]))));
            }
        }

        const body = rowPaths.map((row) => h("tr", {},
            ...template.rows.map((dim, level) => (row.slice(level + 1).every((i) => i === 0)
                ? h("th", { scope: "row", rowspan: String(span(template.rows, level)) }, dim.values[row[level]])
                : null)),
            ...(colPaths.length ? colPaths : [[]]).map((col) => h("td", {}, renderCell(cellKeyOf(row, col))))));

        return h("div", { class: "inflection-scroll" }, h("table", { class: "inflection-table" },
            h("thead", {}, ...head), h("tbody", {}, ...body)));
    }

    // The stem a template gives a headword (its "stem removal": "-a" the end, "ge-" the start).
    function stemFor(template, headword) {
        const word = (headword || "").replace(/^\*/, "");
        const remove = (template.stem_remove || "").trim();
        if (!remove) {
            return word;
        }
        if (remove.startsWith("-") && word.endsWith(remove.slice(1)) && word.length > remove.length - 1) {
            return word.slice(0, word.length - (remove.length - 1));
        }
        if (remove.endsWith("-") && word.startsWith(remove.slice(0, -1)) && word.length > remove.length - 1) {
            return word.slice(remove.length - 1);
        }
        if (!remove.startsWith("-") && !remove.endsWith("-") && word.endsWith(remove) && word.length > remove.length) {
            return word.slice(0, word.length - remove.length);
        }
        return word;
    }

    // What the template gives for a cell with this stem ("" if it has no pattern, "—" for no such form).
    function formFor(template, key, stem, headword) {
        const pattern = template.cells[key];
        if (!pattern) {
            return "";
        }
        if (/^(—|–|-|n\/a)$/i.test(pattern.trim())) {
            return "—";
        }
        return pattern.replace(/\{stem\}/g, stem).replace(/\{headword\}/g, (headword || "").replace(/^\*/, ""));
    }

    // ---- the word form's tables ----

    function inflectionSection(draft, language, markDirty_) {
        const box = h("div", { class: "inflection-section" });
        const refreshers = [];

        function render() {
            refreshers.length = 0;
            const templates = state.templates;
            const used = new Set(draft.inflections.map((i) => i.template_id));
            const free = templates.filter((t) => !used.has(t.id));
            // Templates for this word's part of speech first.
            free.sort((a, b) => Number((b.pos || "").toLowerCase() === (draft.pos || "").trim().toLowerCase()) - Number((a.pos || "").toLowerCase() === (draft.pos || "").trim().toLowerCase()) || a.name.localeCompare(b.name));

            const select = h("select", {}, ...free.map((t) => h("option", { value: String(t.id) }, `${t.name}${t.pos ? ` (${t.pos})` : ""}`)));
            const add = () => {
                if (!select.value) {
                    return;
                }
                draft.inflections.push({ template_id: Number(select.value), stem: "", overrides: {} });
                markDirty_();
                render();
            };

            box.replaceChildren(
                ...draft.inflections.map((entry, index) => {
                    const template = templates.find((t) => t.id === entry.template_id);
                    if (!template) {
                        return h("p", { class: "status error" }, "A table whose template no longer exists.");
                    }
                    const stemInput = h("input", {
                        type: "text", class: "conlang", size: "14", value: entry.stem, autocomplete: "off",
                        placeholder: stemFor(template, draft.headword),
                        oninput: (event) => { entry.stem = event.target.value; markDirty_(); refresh(); }
                    });
                    const inputs = new Map();
                    const grid = templateGrid(template, (key) => {
                        const input = h("input", {
                            type: "text", class: "conlang cell-input", value: entry.overrides[key] || "", autocomplete: "off",
                            oninput: (event) => {
                                if (event.target.value.trim()) {
                                    entry.overrides[key] = event.target.value;
                                } else {
                                    delete entry.overrides[key];
                                }
                                markDirty_();
                                input.classList.toggle("own", Boolean(event.target.value.trim()));
                            }
                        });
                        input.classList.toggle("own", Boolean(entry.overrides[key]));
                        inputs.set(key, input);
                        return input;
                    });
                    function refresh() {
                        const stem = (entry.stem || "").trim() || stemFor(template, draft.headword);
                        for (const [key, input] of inputs) {
                            input.placeholder = formFor(template, key, stem, draft.headword);
                        }
                    }
                    refresh();
                    refreshers.push(() => { stemInput.placeholder = stemFor(template, draft.headword); refresh(); });

                    const change = h("select", {
                        onchange: (event) => {
                            const next = Number(event.target.value);
                            if (next !== entry.template_id) {
                                entry.template_id = next;
                                entry.overrides = {};
                                markDirty_();
                                render();
                            }
                        }
                    }, ...templates.filter((t) => t.id === entry.template_id || !used.has(t.id))
                        .map((t) => h("option", { value: String(t.id), selected: t.id === entry.template_id }, `${t.name}${t.pos ? ` (${t.pos})` : ""}`)));

                    return h("div", { class: "inflection-entry" },
                        h("div", { class: "row" },
                            change,
                            h("label", {}, "Stem ", stemInput),
                            h("span", { class: "grow" }),
                            removeButton(() => {
                                draft.inflections.splice(index, 1);
                                markDirty_();
                                render();
                            }, "Remove this table")),
                        template.description ? h("p", { class: "hint" }, template.description) : null,
                        grid,
                        h("p", { class: "hint" }, "Grey forms come from the template and the stem; type in a cell to give this word its own form there, or — for a form that doesn't exist."));
                }),
                templates.length === 0
                    ? h("p", { class: "hint" }, `${language.name} has no inflection templates yet. `,
                        h("button", { type: "button", onclick: () => openTemplatesDialog(language) }, "Make one"))
                    : free.length
                        ? h("div", { class: "row" }, select, h("button", { type: "button", onclick: add }, "Add a table"),
                            h("button", { type: "button", onclick: () => openTemplatesDialog(language) }, "Edit templates"))
                        : h("div", { class: "row" }, h("button", { type: "button", onclick: () => openTemplatesDialog(language) }, "Edit templates")));
        }

        render();
        box.refresh = () => refreshers.forEach((f) => f());
        return box;
    }

    // ---- the templates dialog ----

    const PRESETS = [
        ["Blank", { rows: [], cols: [] }],
        ["Noun: case × number", {
            rows: [{ name: "Case", values: ["nominative", "accusative", "genitive", "dative"] }],
            cols: [{ name: "Number", values: ["singular", "plural"] }]
        }],
        ["Verb: person and number × tense", {
            rows: [{ name: "Person", values: ["1st", "2nd", "3rd"] }, { name: "Number", values: ["singular", "plural"] }],
            cols: [{ name: "Tense", values: ["present", "past"] }]
        }],
        ["Adjective: gender × number", {
            rows: [{ name: "Gender", values: ["masculine", "feminine", "neuter"] }],
            cols: [{ name: "Number", values: ["singular", "plural"] }]
        }]
    ];

    // Re-addressing the cells when a category or value is added, removed or moved.
    function remapCells(cells, axis, change) {
        const out = {};
        for (const [key, pattern] of Object.entries(cells)) {
            const [r, c] = key.split("|");
            const paths = [r ? r.split(".").map(Number) : [], c ? c.split(".").map(Number) : []];
            const next = change(paths[axis]);
            if (next === null) {
                continue;
            }
            paths[axis] = next;
            out[cellKeyOf(paths[0], paths[1])] = pattern;
        }
        return out;
    }

    async function openTemplatesDialog(language) {
        if (!language) {
            return;
        }
        let templates;
        try {
            templates = await api("GET", `/api/dictionary/inflection-templates?language=${language.id}`);
        } catch (error) {
            alert(error.message);
            return;
        }

        const blank = () => ({ id: null, name: "", pos: "", description: "", stem_remove: "", rows: [], cols: [], cells: {}, words: 0 });
        const clone = (t) => JSON.parse(JSON.stringify(t));
        let draft = templates.length ? clone(templates[0]) : blank();
        let dirty = false;
        const errorEl = h("div", { class: "status error" });
        const listEl = h("div", { class: "template-list" });
        const formEl_ = h("div", { class: "template-form" });
        const touch = () => { dirty = true; };

        const select = (template) => {
            if (dirty && !confirm("Discard the changes to this template?")) {
                return;
            }
            draft = template ? clone(template) : blank();
            dirty = false;
            errorEl.textContent = "";
            render();
        };

        function renderList() {
            listEl.replaceChildren(
                ...templates.map((t) => h("button", {
                    type: "button", class: t.id === draft.id ? "active" : "",
                    onclick: () => select(t)
                }, h("strong", {}, t.name), h("small", {}, `${t.pos || "no part of speech"} · ${t.words} word${t.words === 1 ? "" : "s"}`))),
                h("button", { type: "button", class: `new${draft.id === null ? " active" : ""}`, onclick: () => select(null) }, "+ New template"));
        }

        // One axis (rows or columns): its categories and their values.
        function axisEditor(axis, label) {
            const dims = draft[axis];
            const index = axis === "rows" ? 0 : 1;
            return h("div", { class: "axis-editor" },
                h("h4", {}, label),
                ...dims.map((dim, d) => h("div", { class: "dimension" },
                    h("div", { class: "row" },
                        h("input", {
                            type: "text", value: dim.name, placeholder: "Category (Person, Case, Tense…)", size: "22", autocomplete: "off",
                            oninput: (event) => { dim.name = event.target.value; touch(); }
                        }),
                        h("button", {
                            type: "button", title: "Remove this category",
                            onclick: () => {
                                draft.cells = remapCells(draft.cells, index, (path) => (path[d] !== 0 ? null : path.filter((_, i) => i !== d)));
                                dims.splice(d, 1);
                                touch();
                                render();
                            }
                        }, "Remove category")),
                    h("div", { class: "values" }, ...dim.values.map((value, v) => h("div", { class: "value-row" },
                        h("input", {
                            type: "text", value, size: "16", autocomplete: "off",
                            oninput: (event) => { dim.values[v] = event.target.value; touch(); },
                            onchange: () => renderGridOnly()
                        }),
                        h("button", {
                            type: "button", title: "Move up", disabled: v === 0,
                            onclick: () => moveValue(index, d, dim, v, v - 1)
                        }, "↑"),
                        h("button", {
                            type: "button", title: "Move down", disabled: v === dim.values.length - 1,
                            onclick: () => moveValue(index, d, dim, v, v + 1)
                        }, "↓"),
                        h("button", {
                            type: "button", title: "Remove this value", disabled: dim.values.length === 1,
                            onclick: () => {
                                draft.cells = remapCells(draft.cells, index, (path) => (path[d] === v ? null : path.map((x, i) => (i === d && x > v ? x - 1 : x))));
                                dim.values.splice(v, 1);
                                touch();
                                render();
                            }
                        }, "×")))),
                    h("button", {
                        type: "button",
                        onclick: () => { dim.values.push(""); touch(); render(); }
                    }, "Add a value"))),
                dims.length < 3
                    ? h("button", {
                        type: "button",
                        onclick: () => {
                            draft.cells = remapCells(draft.cells, index, (path) => [...path, 0]);
                            dims.push({ name: "", values: ["value 1"] });
                            touch();
                            render();
                        }
                    }, dims.length ? "Add another category" : `Add a category ${axis === "rows" ? "down the side" : "along the top"}`)
                    : null);
        }

        function moveValue(axisIndex, d, dim, from, to) {
            draft.cells = remapCells(draft.cells, axisIndex, (path) => path.map((x, i) => {
                if (i !== d) {
                    return x;
                }
                if (x === from) {
                    return to;
                }
                return from < to ? (x > from && x <= to ? x - 1 : x) : (x >= to && x < from ? x + 1 : x);
            }));
            [dim.values[from], dim.values[to]] = [dim.values[to], dim.values[from]];
            touch();
            render();
        }

        const gridEl = h("div", { class: "template-grid" });

        // Blank names or values would make a table nobody can read: show the table only when there are none.
        function renderGridOnly() {
            const complete = [...draft.rows, ...draft.cols].every((d) => d.name.trim() && d.values.every((v) => v.trim()));
            if (!complete) {
                gridEl.replaceChildren(h("p", { class: "hint" }, "Name every category and value to see the table."));
                return;
            }
            const cellCount = cellPaths(draft.rows).length * cellPaths(draft.cols).length;
            gridEl.replaceChildren(
                h("p", { class: "hint" },
                    "Write the form in each cell. {stem} stands for the word's stem: {stem}ana, ge{stem}t, {stem}. Use — for a form that doesn't exist; leave a cell empty for nothing. ",
                    `${cellCount} cell${cellCount === 1 ? "" : "s"}.`),
                templateGrid(draft, (key) => h("input", {
                    type: "text", class: "conlang cell-input", value: draft.cells[key] || "", placeholder: "{stem}", autocomplete: "off",
                    oninput: (event) => {
                        if (event.target.value.trim()) {
                            draft.cells[key] = event.target.value;
                        } else {
                            delete draft.cells[key];
                        }
                        touch();
                    }
                })),
                h("div", { class: "row" },
                    h("button", {
                        type: "button",
                        title: "Put {stem} in every empty cell",
                        onclick: () => {
                            for (const r of cellPaths(draft.rows)) {
                                for (const c of cellPaths(draft.cols)) {
                                    const key = cellKeyOf(r, c);
                                    if (!draft.cells[key]) {
                                        draft.cells[key] = "{stem}";
                                    }
                                }
                            }
                            touch();
                            renderGridOnly();
                        }
                    }, "Fill empty cells with {stem}")));
        }

        function render() {
            renderList();
            const patternPos = h("datalist", { id: "template-pos" }, ...POS_SUGGESTIONS.map((pos) => h("option", { value: pos })));
            formEl_.replaceChildren(
                h("div", { class: "field-grid" },
                    h("div", { class: "field" }, h("label", {}, "Name"),
                        h("input", { type: "text", value: draft.name, placeholder: "e.g. Weak verbs, a-nouns, irregular", autocomplete: "off", oninput: (event) => { draft.name = event.target.value; touch(); } })),
                    h("div", { class: "field" }, h("label", {}, "Part of speech"),
                        h("input", { type: "text", value: draft.pos, list: "template-pos", autocomplete: "off", oninput: (event) => { draft.pos = event.target.value; touch(); } })),
                    h("div", { class: "field" }, h("label", {}, "Stem removal", h("span", { class: "hint" }, " — -a takes -a off the end of the headword to give the stem; ge- takes it off the start")),
                        h("input", { type: "text", value: draft.stem_remove, size: "8", autocomplete: "off", oninput: (event) => { draft.stem_remove = event.target.value; touch(); } }))),
                patternPos,
                h("div", { class: "field" }, h("label", {}, "Notes", h("span", { class: "hint" }, " — which words follow this pattern, how it differs from the others")),
                    h("textarea", { rows: "2", oninput: (event) => { draft.description = event.target.value; touch(); } }, draft.description)),
                draft.rows.length === 0 && draft.cols.length === 0 && Object.keys(draft.cells).length === 0
                    ? h("div", { class: "field" }, h("label", {}, "Start from"),
                        h("div", { class: "row" }, ...PRESETS.map(([name, preset]) => h("button", {
                            type: "button",
                            onclick: () => { draft.rows = clone(preset.rows); draft.cols = clone(preset.cols); touch(); render(); }
                        }, name))))
                    : null,
                h("div", { class: "axes" }, axisEditor("rows", "Down the side (rows)"), axisEditor("cols", "Along the top (columns)")),
                h("h4", {}, "The table"),
                gridEl);
            renderGridOnly();
        }

        async function save() {
            errorEl.textContent = "";
            try {
                const payload = { name: draft.name, pos: draft.pos, description: draft.description, stem_remove: draft.stem_remove, rows: draft.rows, cols: draft.cols, cells: draft.cells };
                const saved = draft.id
                    ? await api("PUT", `/api/dictionary/inflection-templates/${draft.id}`, payload)
                    : await api("POST", "/api/dictionary/inflection-templates", { ...payload, language_id: language.id });
                templates = await api("GET", `/api/dictionary/inflection-templates?language=${language.id}`);
                draft = clone(templates.find((t) => t.id === saved.id));
                dirty = false;
                render();
                errorEl.textContent = "";
            } catch (error) {
                errorEl.textContent = error.message;
            }
        }

        const dialog = h("dialog", { class: "templates-dialog" },
            h("h2", {}, `Inflection templates: ${language.name}`),
            h("p", { class: "hint" }, "A template is a table of forms for one part of speech, laid out along categories. A language can have several for one part of speech (word classes, irregular or worn-down patterns); each word follows the ones it needs."),
            h("div", { class: "templates-layout" }, listEl, formEl_),
            errorEl,
            h("div", { class: "form-actions" },
                h("button", { type: "button", class: "primary", onclick: save }, "Save template"),
                h("button", {
                    type: "button",
                    disabled: false,
                    title: "Start a new template from a copy of this one (for a class that differs a little)",
                    onclick: () => {
                        draft = { ...clone(draft), id: null, name: draft.name ? `${draft.name} (copy)` : "", words: 0 };
                        dirty = true;
                        errorEl.textContent = "";
                        render();
                    }
                }, "Duplicate"),
                h("button", { type: "button", onclick: () => dialog.close() }, "Close"),
                h("span", { class: "spacer" }),
                h("button", {
                    type: "button", class: "danger", disabled: locked("template", draft.id),
                    onclick: async () => {
                        if (!draft.id) {
                            select(null);
                            return;
                        }
                        const users = draft.words;
                        if (!confirm(`Delete “${draft.name}”?${users ? ` ${users} word${users === 1 ? " follows" : "s follow"} it and will lose that table.` : ""}`)) {
                            return;
                        }
                        try {
                            await api("DELETE", `/api/dictionary/inflection-templates/${draft.id}`);
                            templates = await api("GET", `/api/dictionary/inflection-templates?language=${language.id}`);
                            draft = templates.length ? clone(templates[0]) : blank();
                            dirty = false;
                            render();
                        } catch (error) {
                            errorEl.textContent = error.message;
                        }
                    }
                }, "Delete")));

        dialog.addEventListener("close", async () => {
            dialog.remove();
            await loadTemplates();
            renderForm(); // the word form's table choices
        });
        render();
        document.body.append(dialog);
        dialog.showModal();
    }

    // ------------------------------------------------------
    // Sounds and spelling (the language's phonemes and orthography)
    // ------------------------------------------------------

    // Splits IPA into inventory symbols, longest first; null if some part isn't one.
    function segmentIpa(text, symbols) {
        text = text.replace(/g/g, "ɡ"); // the IPA symbol is ɡ; the keyboard's g is taken for it
        const longest = [...symbols].sort((a, b) => b.length - a.length);
        const memo = new Map();
        const from = (at) => {
            if (at === text.length) {
                return [];
            }
            if (memo.has(at)) {
                return memo.get(at);
            }
            let found = null;
            for (const symbol of longest) {
                if (text.startsWith(symbol, at)) {
                    const rest = from(at + symbol.length);
                    if (rest) {
                        found = [symbol, ...rest];
                        break;
                    }
                }
            }
            memo.set(at, found);
            return found;
        };
        return text.length ? from(0) : null;
    }

    async function openPhonologyDialog(language) {
        if (!language) {
            return;
        }
        let chart;
        let draft;
        try {
            [chart, draft] = await Promise.all([
                api("GET", "/api/dictionary/ipa"),
                api("GET", `/api/dictionary/phonology/${language.id}`)
            ]);
        } catch (error) {
            alert(error.message);
            return;
        }

        const onChart = new Map([...chart.consonants, ...chart.vowels].map((p) => [p.ipa, p]));
        let tab = "sounds";
        const errorEl = h("div", { class: "status error" });
        const body = h("div", { class: "phonology-body" });
        const tabs = h("div", { class: "tab-row" });
        const has = (ipa) => draft.phonemes.some((p) => p.ipa === ipa);

        function toggle(symbol) {
            if (has(symbol.ipa)) {
                draft.phonemes = draft.phonemes.filter((p) => p.ipa !== symbol.ipa);
            } else {
                draft.phonemes.push({ ...symbol });
            }
            render();
        }

        const symbolButton = (symbol) => h("button", {
            type: "button",
            class: `ipa-key${has(symbol.ipa) ? " on" : ""}`,
            title: symbol.kind === "vowel"
                ? `${symbol.height}, ${symbol.backness}, ${symbol.rounded ? "rounded" : "unrounded"}`
                : `${symbol.voiced ? "voiced" : "voiceless"} ${symbol.place} ${symbol.manner}`,
            "aria-pressed": has(symbol.ipa) ? "true" : "false",
            onclick: () => toggle(symbol)
        }, symbol.ipa);

        function consonantTable() {
            return h("div", { class: "chart-scroll" }, h("table", { class: "ipa-chart" },
                h("thead", {}, h("tr", {}, h("th", {}), ...chart.places.map(([, label]) => h("th", {}, label)))),
                h("tbody", {}, ...chart.manners.map(([manner, label]) => h("tr", {},
                    h("th", {}, label),
                    ...chart.places.map(([place]) => h("td", {},
                        ...chart.consonants
                            .filter((c) => c.place === place && c.manner === manner)
                            .sort((a, b) => a.voiced - b.voiced)
                            .map(symbolButton))))))));
        }

        function vowelTable() {
            return h("div", { class: "chart-scroll" }, h("table", { class: "ipa-chart" },
                h("thead", {}, h("tr", {}, h("th", {}), ...chart.backnesses.map(([, label]) => h("th", {}, label)))),
                h("tbody", {}, ...chart.heights.map(([height, label]) => h("tr", {},
                    h("th", {}, label),
                    ...chart.backnesses.map(([backness]) => h("td", {},
                        ...chart.vowels
                            .filter((v) => v.height === height && v.backness === backness)
                            .sort((a, b) => a.rounded - b.rounded)
                            .map(symbolButton))))))));
        }

        function customSection() {
            const custom = draft.phonemes.filter((p) => !onChart.has(p.ipa) && p.kind !== "tone" && p.kind !== "stress");
            const input = h("input", { type: "text", class: "ipa-input", placeholder: "e.g. kʰ, aː, ã", size: "8", autocomplete: "off" });
            const kind = h("select", {},
                h("option", { value: "consonant" }, "consonant"),
                h("option", { value: "vowel" }, "vowel"),
                h("option", { value: "tone" }, "tone"),
                h("option", { value: "stress" }, "stress mark"));
            const label = h("input", { type: "text", size: "12", placeholder: "label (e.g. high)", autocomplete: "off" });
            // The marks that go after a symbol (length, aspiration, nasalisation, ...).
            const marks = h("span", { class: "marks" }, ...chart.modifiers.map((m) => h("button", {
                type: "button",
                title: `Add ${m}`,
                onclick: () => { input.value += m; input.focus(); }
            }, m.length === 1 && /\p{M}/u.test(m) ? `◌${m}` : m)));
            const add = () => {
                const ipa = input.value.trim().normalize("NFC");
                if (!ipa) {
                    return;
                }
                if (has(ipa)) {
                    errorEl.textContent = `/${ipa}/ is already in the inventory.`;
                    return;
                }
                errorEl.textContent = "";
                const base = onChart.get(ipa) || onChart.get([...ipa][0]);
                const given = label.value.trim();
                draft.phonemes.push({ ipa, kind: base ? base.kind : kind.value, ...(given ? { label: given } : {}) });
                render();
            };
            input.addEventListener("keydown", (event) => {
                if (event.key === "Enter") {
                    event.preventDefault();
                    add();
                }
            });
            return h("div", { class: "field" },
                h("span", { class: "label" }, "Other sounds",
                    h("span", { class: "hint" }, " — anything not on the charts: long, aspirated or nasal versions, clicks, tones…")),
                h("div", { class: "chips" }, ...custom.map((p) => h("span", { class: "chip" },
                    h("span", { class: "ipa" }, p.ipa), h("small", {}, p.label ? `${p.kind}: ${p.label}` : p.kind),
                    h("button", {
                        type: "button", title: "Remove",
                        onclick: () => { draft.phonemes = draft.phonemes.filter((q) => q !== p); render(); }
                    }, "×")))),
                h("div", { class: "row" }, input, kind, label, h("button", { type: "button", onclick: add }, "Add"), marks));
        }

        // Tones and stress marks: chosen from the usual ones or added below. They are not sounds, but
        // spelling can use them (á = a˥), and words keep them in their transcriptions.
        function prosodySection() {
            const presets = [...chart.tones, ...chart.stress];
            const others = draft.phonemes.filter((p) => (p.kind === "tone" || p.kind === "stress") && !presets.some((q) => q.ipa === p.ipa));
            return h("div", { class: "field" },
                h("h3", {}, "Tones and stress"),
                h("p", { class: "hint" }, "For tonal languages (the Chao tone letters ˥ high … ˩ low, two or three together for a contour), for pitch accent, and for stress marks. A letter in the spelling can then stand for a vowel with a tone, such as á = a˥, or for a mark on its own. Other marks go in the box below, as tone or stress."),
                h("div", { class: "prosody-keys" }, ...presets.map((symbol) => h("button", {
                    type: "button",
                    class: `ipa-key wide${has(symbol.ipa) ? " on" : ""}`,
                    title: symbol.label,
                    "aria-pressed": has(symbol.ipa) ? "true" : "false",
                    onclick: () => toggle(symbol)
                }, h("span", {}, symbol.ipa), h("small", {}, symbol.label)))),
                others.length
                    ? h("div", { class: "chips" }, ...others.map((p) => h("span", { class: "chip" },
                        h("span", { class: "ipa" }, p.ipa), h("small", {}, p.label ? `${p.kind}: ${p.label}` : p.kind),
                        h("button", {
                            type: "button", title: "Remove",
                            onclick: () => { draft.phonemes = draft.phonemes.filter((q) => q !== p); render(); }
                        }, "×"))))
                    : null);
        }

        // ---- Diphthongs: defined here, used by the spelling (a letter can stand for one) and by the
        // syllables (a diphthong is one nucleus, heavy unless set light). ----
        const diphthongs = () => {
            if (!Array.isArray(draft.prosody.diphthong_defs)) {
                draft.prosody.diphthong_defs = [];
            }
            return draft.prosody.diphthong_defs;
        };

        // How it moves, from the two vowels' heights (chart.heights runs close to open).
        function diphthongMovement(first, second) {
            const a = draft.phonemes.find((p) => p.ipa === first);
            const b = draft.phonemes.find((p) => p.ipa === second);
            const keys = chart.heights.map(([key]) => key);
            if (!a || !b || !a.height || !b.height) {
                return "";
            }
            const x = keys.indexOf(a.height);
            const y = keys.indexOf(b.height);
            if (y < x) {
                return "closing";
            }
            if (y > x) {
                return b.backness === "central" ? "centering" : "opening";
            }
            return b.backness === "central" && a.backness !== "central" ? "centering" : "level";
        }

        // A diphthong's letters in the spelling, if any rule has its two vowels side by side.
        function diphthongSpelledBy(d) {
            const symbols = draft.phonemes.map((p) => p.ipa);
            return [...new Set(draft.graphemes.filter((g) => {
                const parts = segmentIpa((g.ipa || "").normalize("NFC"), symbols) || [];
                return parts.some((x, i) => x === d.first && parts[i + 1] === d.second);
            }).map((g) => g.grapheme))];
        }

        function diphthongSection() {
            const vowels = draft.phonemes.filter((p) => p.kind === "vowel").map((p) => p.ipa);
            const list = diphthongs();
            const vowelSelect = (value, onchange) => h("select", { class: "ipa-input", onchange: (event) => onchange(event.target.value) },
                ...vowels.map((v) => h("option", { value: v, selected: v === value }, v)));
            const firstPick = vowelSelect(vowels[0], () => {});
            const secondPick = vowelSelect(vowels[1] || vowels[0], () => {});
            const defined = (a, b) => list.some((d) => d.first === a && d.second === b);

            const rows = list.map((d) => {
                const movement = h("span", { class: "hint" }, diphthongMovement(d.first, d.second));
                const written = h("span", { class: "ipa" });
                // How it is written in a transcription: the nonsyllabic vowel gets ̯ (ai̯).
                const refresh = () => {
                    movement.textContent = diphthongMovement(d.first, d.second);
                    written.textContent = d.nonsyllabic === "first" ? `${d.first}\u032f${d.second}` : d.nonsyllabic === "second" ? `${d.first}${d.second}\u032f` : `${d.first}${d.second}`;
                };
                refresh();
                const spelled = diphthongSpelledBy(d);
                return h("tr", {},
                    h("td", {}, vowelSelect(d.first, (v) => { d.first = v; refresh(); }), " ", vowelSelect(d.second, (v) => { d.second = v; refresh(); })),
                    h("td", {}, movement),
                    h("td", {}, h("select", {
                        title: "Which vowel is nonsyllabic (a glide, written with ̯ below), if either",
                        onchange: (event) => { d.nonsyllabic = event.target.value; refresh(); }
                    },
                        h("option", { value: "", selected: !d.nonsyllabic }, "neither"),
                        h("option", { value: "first", selected: d.nonsyllabic === "first" }, "the first"),
                        h("option", { value: "second", selected: d.nonsyllabic === "second" }, "the second")), " ", written),
                    h("td", {}, h("select", { onchange: (event) => { d.weight = event.target.value; } },
                        h("option", { value: "heavy", selected: d.weight !== "light" }, "heavy"),
                        h("option", { value: "light", selected: d.weight === "light" }, "light"))),
                    h("td", {}, h("input", {
                        type: "text", value: d.note || "", size: "14", placeholder: "note (optional)", autocomplete: "off",
                        oninput: (event) => { d.note = event.target.value; }
                    })),
                    h("td", {}, spelled.length
                        ? h("span", { class: "conlang" }, spelled.join(", "))
                        : h("span", { class: "hint" }, "no letter yet")),
                    h("td", { class: "row-tools" }, h("button", {
                        type: "button", title: "Remove this diphthong",
                        onclick: () => { draft.prosody.diphthong_defs = list.filter((x) => x !== d); render(); }
                    }, "×")));
            });

            // Pairs that are usually diphthongs, offered when both vowels are in the inventory.
            const common = [["a", "i"], ["a", "u"], ["e", "i"], ["e", "u"], ["o", "i"], ["o", "u"], ["ɛ", "i"], ["ɔ", "i"],
                ["i", "a"], ["u", "a"], ["i", "e"], ["u", "e"], ["i", "o"], ["u", "o"], ["a", "e"], ["a", "o"]]
                .filter(([a, b]) => vowels.includes(a) && vowels.includes(b) && !defined(a, b));

            const add = (first, second) => {
                if (defined(first, second)) {
                    errorEl.textContent = `${first}${second} is already defined.`;
                    return;
                }
                errorEl.textContent = "";
                list.push({ first, second, note: "", weight: "heavy", nonsyllabic: "" });
                render();
            };

            return h("div", { class: "field diphthongs" },
                h("h3", {}, "Diphthongs"),
                h("p", { class: "hint" }, "Two vowels spoken as one syllable. Define them here: the Spelling tab can then give a letter or digraph (ai, au) to one, and words are divided into syllables with it as a single nucleus. Vowels in a row that are not listed stay separate syllables (hiatus). A heavy diphthong makes its syllable heavy for the stress rule; set a diphthong light if yours doesn't. For a more precise transcription, mark one vowel nonsyllabic: it is then written with ̯ below (ai̯)."),
                vowels.length < 2 && !list.length
                    ? h("p", { class: "hint" }, "Add at least two vowels above first.")
                    : null,
                list.length
                    ? h("table", { class: "spelling-edit diphthong-edit" },
                        h("thead", {}, h("tr", {}, h("th", {}, "Vowels"), h("th", {}, "Movement"), h("th", {}, "Nonsyllabic vowel"), h("th", {}, "Syllable weight"), h("th", {}, "Note"), h("th", {}, "Spelled"), h("th", {}))),
                        h("tbody", {}, ...rows))
                    : null,
                vowels.length
                    ? h("div", { class: "row" }, firstPick, secondPick,
                        h("button", { type: "button", onclick: () => add(firstPick.value, secondPick.value) }, "Add diphthong"))
                    : null,
                common.length
                    ? h("div", { class: "row" }, h("span", { class: "hint" }, "Common pairs in your inventory:"),
                        ...common.map(([a, b]) => h("button", { type: "button", class: "chip-button", onclick: () => add(a, b) }, `${a}${b}`)))
                    : null);
        }

        function soundsTab() {
            const consonants = draft.phonemes.filter((p) => p.kind === "consonant").length;
            const vowels = draft.phonemes.filter((p) => p.kind === "vowel").length;
            return h("div", {},
                h("p", { class: "hint" }, `Click a symbol to add it to the inventory, and again to take it out. ${consonants} consonant${consonants === 1 ? "" : "s"}, ${vowels} vowel${vowels === 1 ? "" : "s"}.`),
                h("h3", {}, "Consonants"), consonantTable(),
                h("h3", {}, "Vowels"), vowelTable(),
                diphthongSection(),
                prosodySection(),
                customSection());
        }

        function spellingTab() {
            const symbols = draft.phonemes.map((p) => p.ipa);
            const spelledSounds = new Set();
            for (const g of draft.graphemes) {
                (segmentIpa((g.ipa || "").normalize("NFC"), symbols) || []).forEach((x) => spelledSounds.add(x));
            }
            const unspelled = symbols.filter((x) => !spelledSounds.has(x));

            const MARK = /^[ːˑʰʷʲˠˤʼ\p{M}]/u;
            const describe = (ipa) => {
                const text = (ipa || "").normalize("NFC");
                if (!text) {
                    return { cls: "", text: "" };
                }
                if (text === "∅") {
                    return { cls: "ok", text: "silent" };
                }
                if (MARK.test(text)) {
                    const joins = symbols.filter((x) => x.endsWith(text) && x !== text);
                    return joins.length || symbols.includes(text)
                        ? { cls: "ok", text: `joins the sound before it${joins.length ? ` (${joins.join(" ")})` : ""}` }
                        : { cls: "bad", text: `no sound in the inventory ends in ${text}` };
                }
                const parts = segmentIpa(text, symbols);
                if (!parts) {
                    return { cls: "bad", text: "not in the inventory" };
                }
                const isDiphthong = parts.length === 2 && diphthongs().some((d) => d.first === parts[0] && d.second === parts[1]);
                return { cls: "ok", text: `/${parts.join("")}/${isDiphthong ? " diphthong" : ""}` };
            };

            const row = (g) => {
                const state = describe(g.ipa);
                const status = h("span", { class: `spell-status ${state.cls}` }, state.text);
                const sound = h("input", {
                    type: "text", class: "ipa-input", value: g.ipa, size: "9", placeholder: "IPA, or ∅", autocomplete: "off",
                    oninput: () => {
                        g.ipa = sound.value;
                        const next = describe(sound.value);
                        status.className = `spell-status ${next.cls}`;
                        status.textContent = next.text;
                    }
                });
                const where = h("select", { onchange: () => { g.where_pos = where.value || null; } },
                    h("option", { value: "" }, "anywhere"),
                    h("option", { value: "start", selected: g.where_pos === "start" }, "word start"),
                    h("option", { value: "end", selected: g.where_pos === "end" }, "word end"));
                const condition = (key, placeholder) => h("input", {
                    type: "text", value: g[key] || "", size: "9", placeholder, autocomplete: "off",
                    oninput: (event) => { g[key] = event.target.value; }
                });
                return h("tr", {},
                    h("td", {}, h("input", {
                        type: "text", class: "conlang", value: g.grapheme, size: "4", placeholder: "letter(s)", autocomplete: "off",
                        oninput: (event) => { g.grapheme = event.target.value; }
                    })),
                    h("td", {}, sound, " ", status),
                    h("td", {}, where),
                    h("td", {}, condition("after_text", "n, m  or  !vowel")),
                    h("td", {}, condition("before_text", "i, e  or  front")),
                    h("td", {}, h("input", {
                        type: "text", value: g.note || "", size: "12", placeholder: "note", autocomplete: "off",
                        oninput: (event) => { g.note = event.target.value; }
                    })),
                    h("td", { class: "row-tools" },
                        h("button", {
                            type: "button", title: "Add another rule for this letter (for when it sounds different in some context)",
                            onclick: () => {
                                const at = draft.graphemes.indexOf(g);
                                draft.graphemes.splice(at + 1, 0, { grapheme: g.grapheme, ipa: "", note: "", where_pos: null, after_text: "", before_text: "" });
                                render();
                            }
                        }, "+"),
                        h("button", {
                            type: "button", title: "Remove this rule",
                            onclick: () => { draft.graphemes = draft.graphemes.filter((x) => x !== g); render(); }
                        }, "×")));
            };

            const classList = h("span", { class: "ipa-small" }, chart.classes.join(", "));
            return h("div", {},
                draft.phonemes.length === 0
                    ? h("p", { class: "status error" }, "Choose the language's sounds first (the Sounds tab); each letter then says which of them it stands for.")
                    : null,
                h("p", { class: "hint" }, "The spelling is taken to be phonetic: each letter (or group, such as “kh”) stands for one sound or a short run of sounds (x = ks), or ∅ for a silent letter. Longer groups win when a word is read. Matching ignores capitals but not accents, so ā and a are separate letters."),
                h("p", { class: "hint" }, "A letter can have more than one rule (the + button): the ones with a context are tried first, in the order shown, and the one with no context is used otherwise. A context can limit a rule to the start or end of a word, to after something, or to before something. Name letters, sounds or classes (", classList, "), separated by commas, and put ! first for “anything but”. A sound that begins with a mark (ʰ ʲ ː) joins the sound before it: with nʰ in the inventory, h after n reads as nʰ."),
                h("table", { class: "spelling-edit" },
                    h("thead", {}, h("tr", {}, h("th", {}, "Letters"), h("th", {}, "Sound(s)"), h("th", {}, "Where"), h("th", {}, "After"), h("th", {}, "Before"), h("th", {}, "Note"), h("th", {}))),
                    h("tbody", {}, ...draft.graphemes.map(row))),
                h("div", { class: "row" },
                    h("button", {
                        type: "button",
                        onclick: () => { draft.graphemes.push({ grapheme: "", ipa: "", note: "", where_pos: null, after_text: "", before_text: "" }); render(); }
                    }, "Add a letter"),
                    h("button", {
                        type: "button",
                        disabled: unspelled.length === 0,
                        title: "Adds a letter for each sound that has none, using the IPA symbol itself; change them to your spelling",
                        onclick: () => {
                            unspelled.forEach((x) => draft.graphemes.push({ grapheme: x, ipa: x, note: "", where_pos: null, after_text: "", before_text: "" }));
                            render();
                        }
                    }, `Add a letter for each unspelled sound (${unspelled.length})`)),
                (() => {
                    const bare = diphthongs().filter((d) => diphthongSpelledBy(d).length === 0);
                    return diphthongs().length
                        ? h("div", { class: "row" },
                            h("span", { class: "hint" }, bare.length
                                ? "Diphthongs with no letter yet (click to add one, then change it to your spelling):"
                                : "Every diphthong has a letter."),
                            ...bare.map((d) => h("button", {
                                type: "button", class: "chip-button",
                                onclick: () => { draft.graphemes.push({ grapheme: d.first + d.second, ipa: d.first + d.second, note: "", where_pos: null, after_text: "", before_text: "" }); render(); }
                            }, `${d.first}${d.second}`)))
                        : null;
                })(),
                unspelled.length
                    ? h("p", { class: "hint" }, "Sounds with no letter yet: ", ...unspelled.flatMap((x) => [h("span", { class: "ipa" }, x), " "]))
                    : null);
        }

        // The data as the server takes it.
        function payload() {
            return {
                phonemes: draft.phonemes,
                graphemes: draft.graphemes
                    .filter((g) => g.grapheme.trim() || g.ipa.trim())
                    .map((g) => ({
                        grapheme: g.grapheme, ipa: g.ipa, note: g.note,
                        where_pos: g.where_pos || null, after_text: g.after_text || null, before_text: g.before_text || null
                    })),
                prosody: draft.prosody
            };
        }

        const STRESS_RULES = [
            ["none", "None: stress is only where the spelling marks it"],
            ["initial", "The first syllable"],
            ["second", "The second syllable"],
            ["penultimate", "The second to last syllable"],
            ["antepenultimate", "The third to last syllable"],
            ["final", "The last syllable"],
            ["weight", "Second to last if heavy, otherwise third to last"]
        ];

        // ---- Pitch accent by rule: which syllables are high or low, and where the pitch goes up or down. ----
        const PITCH_WHEN = [
            ["long-or-diphthong", "a long vowel or a diphthong"], ["long", "a long vowel"], ["diphthong", "a diphthong"],
            ["heavy", "a heavy syllable"], ["closed", "a closed syllable"], ["stressed", "the stressed syllable"],
            ["first", "the first syllable"], ["last", "the last syllable"]
        ];
        const PITCH_FALLBACKS = [
            ["none", "No pitch pattern"], ["low", "All low"], ["high", "All high"], ["initial-high", "The first syllable high, the rest low"],
            ["final-high", "The last syllable high, the rest low"], ["penultimate-high", "The second to last syllable high, the rest low"]
        ];

        function pitchSection(tryWord) {
            const prosody = draft.prosody;
            const pitch = prosody.pitch = { enabled: false, anchors: [], before: "L", between: "L", after: "L", fallback: "none", mark_initial: false, ...(prosody.pitch || {}) };
            const level = (value, onchange) => h("select", { onchange: (event) => onchange(event.target.value) },
                h("option", { value: "H", selected: value === "H" }, "high"),
                h("option", { value: "L", selected: value !== "H" }, "low"));
            const change = () => { prosody.pitch = pitch; tryWord(); };

            const anchorRows = pitch.anchors.map((a) => h("div", { class: "row" },
                h("span", {}, "A syllable with"),
                h("select", { onchange: (event) => { a.when = event.target.value; change(); } },
                    ...PITCH_WHEN.map(([value, label]) => h("option", { value, selected: a.when === value }, label))),
                h("span", {}, "is"),
                level(a.pitch, (v) => { a.pitch = v; change(); }),
                h("button", { type: "button", title: "Remove this rule", onclick: () => { pitch.anchors = pitch.anchors.filter((x) => x !== a); change(); render(); } }, "×")));

            return h("div", { class: "field pitch-rules" },
                h("h3", {}, "Pitch accent"),
                h("p", { class: "hint" }, "Rule-based pitch for languages whose accent is a pattern of high and low syllables. Some syllables are pinned (a long vowel or diphthong is always high, say); the rules below say whether the syllables before, between and after the pinned ones are high or low. Where the pitch goes up the transcription marks ꜛ before the syllable, and where it goes down ꜜ. Tones written in a word's spelling take the place of these rules."),
                h("div", { class: "field check" },
                    h("input", { type: "checkbox", id: "pitch-on", checked: pitch.enabled, onchange: (event) => { pitch.enabled = event.target.checked; change(); render(); } }),
                    h("label", { for: "pitch-on" }, "This language has rule-based pitch accent")),
                pitch.enabled ? h("div", {},
                    h("p", { class: "hint" }, "Pinned syllables (the first rule that fits a syllable decides):"),
                    ...anchorRows,
                    h("div", { class: "row" }, h("button", { type: "button", onclick: () => { pitch.anchors.push({ when: "long-or-diphthong", pitch: "H" }); change(); render(); } }, "Add a rule")),
                    h("div", { class: "row" }, h("span", {}, "Syllables before the pinned ones are"), level(pitch.before, (v) => { pitch.before = v; change(); })),
                    h("div", { class: "row" }, h("span", {}, "Syllables between pinned ones are"), level(pitch.between, (v) => { pitch.between = v; change(); })),
                    h("div", { class: "row" }, h("span", {}, "Syllables after the pinned ones are"), level(pitch.after, (v) => { pitch.after = v; change(); })),
                    h("div", { class: "field" },
                        h("label", {}, "A word with no pinned syllable"),
                        h("select", { onchange: (event) => { pitch.fallback = event.target.value; change(); } },
                            ...PITCH_FALLBACKS.map(([value, label]) => h("option", { value, selected: pitch.fallback === value }, label)))),
                    h("div", { class: "field check" },
                        h("input", { type: "checkbox", id: "pitch-initial", checked: Boolean(pitch.mark_initial), onchange: (event) => { pitch.mark_initial = event.target.checked; change(); } }),
                        h("label", { for: "pitch-initial" }, "Also mark a word that begins high (ꜛ before its first syllable)")))
                    : null);
        }

        function prosodyTab() {
            const prosody = draft.prosody;
            const marks = draft.phonemes.filter((p) => p.kind === "stress" || p.kind === "tone");
            const input = (key, placeholder, size = 24) => h("input", {
                type: "text", value: prosody[key] || "", size, placeholder, autocomplete: "off",
                oninput: (event) => { prosody[key] = event.target.value; tryWord(); }
            });
            const sample = h("input", { type: "text", class: "conlang", size: "14", placeholder: "a word to try", autocomplete: "off" });
            const result = h("span", { class: "try-result" });
            let timer = null;
            function tryWord() {
                clearTimeout(timer);
                timer = setTimeout(async () => {
                    if (!sample.value.trim()) {
                        result.textContent = "";
                        return;
                    }
                    try {
                        const read = await api("POST", "/api/dictionary/phonology-preview", { data: payload(), word: sample.value });
                        result.className = `try-result ${read.ipa ? "ok" : "bad"}`;
                        result.textContent = read.ipa || (read.unknown.length ? `no letter for: ${read.unknown.join(", ")}` : "nothing to read");
                    } catch (error) {
                        result.className = "try-result bad";
                        result.textContent = error.message;
                    }
                }, 200);
            }
            sample.addEventListener("input", tryWord);

            return h("div", {},
                h("p", { class: "hint" }, "How words divide into syllables, and where stress falls when the spelling doesn't say. Stress marks written in the spelling (a letter set to ˈ) always win over the rule, so a language can have a default and mark its exceptions. Pitch-accent languages can place their accent mark by rule too: pick a tone as the mark."),
                h("div", { class: "field check" },
                    h("input", { type: "checkbox", id: "show-syllables", checked: Boolean(prosody.show_syllables), onchange: (event) => { prosody.show_syllables = event.target.checked ? 1 : 0; tryWord(); } }),
                    h("label", { for: "show-syllables" }, "Show syllable boundaries (dots) in transcriptions")),
                h("div", { class: "field" },
                    h("label", {}, "Diphthongs", h("span", { class: "hint" }, " — defined under Sounds; each is one syllable nucleus, and other vowels in a row are separate syllables")),
                    h("div", { class: "row" },
                        diphthongs().length
                            ? h("span", {}, ...diphthongs().flatMap((d) => [h("span", { class: "ipa" }, `${d.first}${d.second}`), d.weight === "light" ? h("small", { class: "hint" }, " light") : "", "  "]))
                            : h("span", { class: "hint" }, "none defined"),
                        h("button", { type: "button", onclick: () => { tab = "sounds"; render(); } }, "Define diphthongs…"))),
                h("div", { class: "field" },
                    h("label", {}, "Syllabic consonants", h("span", { class: "hint" }, " — consonants that can be a syllable on their own, when no vowel is next to them (n m l r in vlk, prst). They are written with a ̩ under them in transcriptions.")),
                    input("syllabic", "l r n m")),
                h("div", { class: "field" },
                    h("label", {}, "Onset clusters", h("span", { class: "hint" }, " — consonant clusters that may begin a syllable (pr tr kl st). Any single consonant always may. A longer cluster between vowels goes to the next syllable as far as this list allows; the rest closes the one before.")),
                    input("onsets", "pr tr kr")),
                h("div", { class: "field" },
                    h("label", {}, "Most consonants a syllable can end in"),
                    h("select", { onchange: (event) => { prosody.max_coda = event.target.value === "" ? null : Number(event.target.value); tryWord(); } },
                        h("option", { value: "" }, "no limit"),
                        ...[0, 1, 2, 3].map((n) => h("option", { value: String(n), selected: prosody.max_coda === n }, n === 0 ? "0 (open syllables only)" : String(n))))),
                h("div", { class: "field" },
                    h("label", {}, "Where stress falls", h("span", { class: "hint" }, " — in a word the spelling doesn't mark. “Heavy” means a long vowel, a diphthong, or a syllable ending in a consonant.")),
                    h("select", { onchange: (event) => { prosody.stress_rule = event.target.value; tryWord(); } },
                        ...STRESS_RULES.map(([value, label]) => h("option", { value, selected: prosody.stress_rule === value }, label)))),
                h("div", { class: "field" },
                    h("label", {}, "Mark for the stressed syllable", h("span", { class: "hint" }, " — a stress mark goes before the syllable; a tone goes after its vowel (pitch accent)")),
                    marks.length
                        ? h("select", { onchange: (event) => { prosody.stress_mark = event.target.value; tryWord(); } },
                            ...marks.map((p) => h("option", { value: p.ipa, selected: prosody.stress_mark === p.ipa }, `${p.ipa}  ${p.label || p.kind}`)))
                        : h("span", { class: "hint" }, "Add ˈ (or a tone) under Sounds, Tones and stress first.")),
                pitchSection(tryWord),
                h("div", { class: "field" },
                    h("label", {}, "Articles in inflected forms", h("span", { class: "hint" }, " — a form with a space in it (an article and a word) is read as separate words, each with its own syllables; stress goes on the word itself and the article is left unstressed")),
                    h("select", { onchange: (event) => { prosody.article_position = event.target.value; tryWord(); } },
                        h("option", { value: "before", selected: prosody.article_position !== "after" }, "The article comes before the word (the last word is stressed)"),
                        h("option", { value: "after", selected: prosody.article_position === "after" }, "The article comes after the word (the first word is stressed)"))),
                h("div", { class: "field check" },
                    h("input", { type: "checkbox", id: "skip-mono", checked: prosody.skip_monosyllables !== 0, onchange: (event) => { prosody.skip_monosyllables = event.target.checked ? 1 : 0; tryWord(); } }),
                    h("label", { for: "skip-mono" }, "Leave one-syllable words unmarked")),
                h("div", { class: "field try-box" },
                    h("label", {}, "Try a word", h("span", { class: "hint" }, " — read with the settings on every tab, as they stand now")),
                    h("div", { class: "row" }, sample, result)));
        }

        function render() {
            // A diphthong whose vowel has left the inventory goes with it.
            const vowelsNow = new Set(draft.phonemes.filter((p) => p.kind === "vowel").map((p) => p.ipa));
            diphthongs();
            draft.prosody.diphthong_defs = draft.prosody.diphthong_defs.filter((d) => vowelsNow.has(d.first) && vowelsNow.has(d.second));
            put(tabs,
                ...[["sounds", "Sounds"], ["spelling", "Spelling"], ["prosody", "Syllables and stress"]].map(([key, label]) => h("button", {
                    type: "button", class: tab === key ? "active" : "",
                    onclick: () => { tab = key; render(); }
                }, label)));
            put(body, tab === "sounds" ? soundsTab() : tab === "spelling" ? spellingTab() : prosodyTab());
        }

        function put(el, ...kids) {
            el.replaceChildren(...kids.flat());
        }

        const dialog = h("dialog", { class: "phonology-dialog" },
            h("h2", {}, `Sounds and spelling: ${language.name}`),
            tabs,
            body,
            errorEl,
            h("div", { class: "form-actions" },
                h("button", {
                    type: "button", class: "primary",
                    onclick: async () => {
                        errorEl.textContent = "";
                        try {
                            await api("PUT", `/api/dictionary/phonology/${language.id}`, payload());
                            dialog.close();
                        } catch (error) {
                            errorEl.textContent = error.message;
                        }
                    }
                }, "Save"),
                h("button", { type: "button", onclick: () => dialog.close() }, "Cancel"),
                h("span", { class: "spacer" }),
                h("a", { href: `/dictionary/${encodeURIComponent(language.slug)}/?view=phonology`, target: "_blank" }, "See the public page")));

        dialog.addEventListener("close", () => dialog.remove());
        render();
        document.body.append(dialog);
        dialog.showModal();
    }

    // ------------------------------------------------------
    // Start
    // ------------------------------------------------------

    // A red link in editor mode lands here: ?new=1&language=<slug>&headword=<word> starts that entry.
    async function followLink() {
        const params = new URLSearchParams(location.search);
        if (![...params.keys()].length) {
            return;
        }
        history.replaceState(null, "", location.pathname); // so a reload doesn't start it again

        const language = state.languages.find((l) => l.slug === params.get("language"));
        if (!language) {
            return;
        }
        if (language.id !== state.languageId) {
            await selectLanguage(language.id);
        }
        const headword = (params.get("headword") || "").trim();
        if (params.get("new") && headword) {
            state.draft = emptyDraft();
            state.draft.headword = headword;
            state.dirty = false;
            renderList();
            renderForm();
            const pos = formEl.querySelector("[name=pos]");
            if (pos) {
                pos.focus();
            }
        }
    }

    (async () => {
        try {
            await loadLanguages();
            const remembered = recall();
            const initial = state.languages.find((l) => l.id === remembered) || state.languages[0];
            await selectLanguage(initial ? initial.id : null);
            await followLink();
        } catch (error) {
            root.textContent = `Could not load the editor: ${error.message}`;
        }
    })();
})();
