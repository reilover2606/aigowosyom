(() => {
    "use strict";

    const root = document.getElementById("editor");
    const { hiddenField, hiddenMark } = window.UI;

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
    const soundsButton = h("button", {
        type: "button",
        title: "The language's phoneme inventory, and which letters stand for which sounds",
        onclick: () => openPhonologyDialog(currentLanguage())
    }, "Sounds and spelling");
    const newLanguageButton = h("button", {
        type: "button",
        onclick: () => openLanguageDialog(null)
    }, "New language");

    const formEl = h("div", { class: "panel form-panel" });

    const sidebarEl = h("aside", { class: "panel sidebar" },
            languageSelect,
            h("div", { class: "row" }, editLanguageButton, newLanguageButton),
            h("div", { class: "row" }, soundsButton),
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
            hidden: false,
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
                h("span", { class: "label" }, "Inflection tables"),
                h("div", { class: "placeholder-box" }, "Declension and conjugation tables will be added here later.")
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
                draft.id && !draft.locked ? h("button", { type: "button", class: "danger", onclick: removeWord }, "Delete") : null
            )
        );

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
            pronunciation: draft.pronunciation,
            sinographs: draft.sinographs,
            etymology: draft.etymology,
            hidden: draft.hidden,
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

        function soundsTab() {
            const consonants = draft.phonemes.filter((p) => p.kind === "consonant").length;
            const vowels = draft.phonemes.filter((p) => p.kind === "vowel").length;
            return h("div", {},
                h("p", { class: "hint" }, `Click a symbol to add it to the inventory, and again to take it out. ${consonants} consonant${consonants === 1 ? "" : "s"}, ${vowels} vowel${vowels === 1 ? "" : "s"}.`),
                h("h3", {}, "Consonants"), consonantTable(),
                h("h3", {}, "Vowels"), vowelTable(),
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
                return parts ? { cls: "ok", text: `/${parts.join("")}/` } : { cls: "bad", text: "not in the inventory" };
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
                    h("label", {}, "Diphthongs", h("span", { class: "hint" }, " — vowel pairs that make one syllable, separated by spaces (ai au ei). Other vowels in a row are separate syllables.")),
                    input("diphthongs", "ai au")),
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
                h("div", { class: "field check" },
                    h("input", { type: "checkbox", id: "skip-mono", checked: prosody.skip_monosyllables !== 0, onchange: (event) => { prosody.skip_monosyllables = event.target.checked ? 1 : 0; tryWord(); } }),
                    h("label", { for: "skip-mono" }, "Leave one-syllable words unmarked")),
                h("div", { class: "field try-box" },
                    h("label", {}, "Try a word", h("span", { class: "hint" }, " — read with the settings on every tab, as they stand now")),
                    h("div", { class: "row" }, sample, result)));
        }

        function render() {
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
