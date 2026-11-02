// The public map page: pan and zoom, click a state or a place to read about it.
(() => {
    "use strict";

    const target = document.getElementById("map");
    const info = document.getElementById("mapInfo");
    const mapId = target.dataset.mapId;

    function el(tag, props, ...children) {
        const node = document.createElement(tag);
        for (const [key, value] of Object.entries(props || {})) {
            if (key === "class") {
                node.className = value;
            } else if (key.startsWith("on")) {
                node.addEventListener(key.slice(2), value);
            } else if (value !== undefined && value !== null) {
                node.setAttribute(key, value);
            }
        }
        for (const child of children.flat()) {
            if (child !== null && child !== undefined && child !== false) {
                node.append(child);
            }
        }
        return node;
    }

    let view = null;
    let bundle = null;

    // The states as a tree: a superstate with its clients indented below it.
    const expanded = new Set(); // superstates whose clients are shown in the list (closed until opened)

    function stateList(nodes) {
        return el("ul", {},
            nodes.map((s) =>
                el("li", {},
                    el("div", { class: "tree-row" },
                        s.kids.length
                            ? el("button", {
                                type: "button",
                                class: "fold",
                                title: expanded.has(s.id) ? "Fold its states away" : `Show its ${s.kids.length} states`,
                                "aria-expanded": expanded.has(s.id) ? "true" : "false",
                                onclick: () => {
                                    expanded.has(s.id) ? expanded.delete(s.id) : expanded.add(s.id);
                                    overview();
                                }
                            }, Icons.el(expanded.has(s.id) ? "chevrondown" : "chevronright"))
                            : el("span", { class: "fold-spacer" }),
                        el("button", { type: "button", onclick: () => choose({ type: "state", id: s.id }, true) },
                            el("span", { class: "swatch", style: `background:${s.color}` }), s.name,
                            s.kids.length && !expanded.has(s.id) ? ` (${s.kids.length})` : "")),
                    s.kids.length && expanded.has(s.id) ? stateList(s.kids) : null)));
    }

    function overview() {
        const tree = MapCore.stateTree(bundle.states);
        info.replaceChildren(
            el("h2", {}, bundle.map.name),
            el("p", { class: "muted" }, "Click a state or a place on the map to read about it."),
            tree.length ? stateList(tree) : null
        );
    }

    // The flora and fauna found in a state, and for a superstate those of its clients too, each with how rare it is
    // there (and, for a superstate, in which state).
    function speciesBlock(s) {
        const merged = new Map();
        const entry = (sp) => {
            if (!merged.has(sp.id)) {
                merged.set(sp.id, { ...sp, found: [] });
            }
            return merged.get(sp.id);
        };
        for (const sp of s.species || []) {
            entry(sp).found.push({ name: s.name, rarity: sp.rarity, label: sp.rarity_label });
        }
        for (const sp of s.species_clients || []) {
            for (const f of sp.found) {
                entry(sp).found.push({ name: f.state_name, rarity: f.rarity, label: f.rarity_label });
            }
        }
        if (!merged.size) {
            return null;
        }
        const aggregated = (s.species_clients || []).length > 0 || bundle.states.some((x) => x.parent_id === s.id);
        const list = (kind, title) => {
            const items = [...merged.values()]
                .filter((sp) => sp.kind === kind)
                .sort((a, b) => Math.min(...a.found.map((f) => f.rarity)) - Math.min(...b.found.map((f) => f.rarity)) || a.title.localeCompare(b.title));
            return items.length
                ? el("div", {}, el("p", { class: "muted" }, `${title}:`),
                    el("ul", { class: "species-lines" }, items.map((sp) => el("li", {},
                        el("a", { href: sp.url }, sp.title), " ",
                        el("span", { class: "muted" }, `— ${aggregated ? sp.found.map((f) => `${f.name}: ${f.label}`).join(" · ") : sp.found[0].label}`)))))
                : null;
        };
        return el("div", { class: "species" },
            el("h3", {}, "Flora and fauna"),
            list("flora", "Flora"),
            list("fauna", "Fauna"));
    }

    function describe(selection) {
        if (selection.type === "state") {
            const s = bundle.states.find((x) => x.id === selection.id);
            const parent = s.parent_id ? bundle.states.find((x) => x.id === s.parent_id) : null;
            const clients = bundle.states.filter((x) => x.parent_id === s.id)
                .sort((a, b) => (b.status === "capital") - (a.status === "capital") || a.name.localeCompare(b.name));
            const statusOf = (x) => MapCore.STATUS_NAMES[x.status || "province"];
            const stats = s.stats && s.stats.area_sq_mi > 0 ? s.stats : null;
            return el("div", {},
                el("h2", {}, el("span", { class: "swatch", style: `background:${s.color}` }),
                    el("span", { class: "state-name" }, s.name)),
                parent
                    ? el("p", { class: "muted" }, `${statusOf(s)} of `,
                        el("a", { href: "#", onclick: (event) => { event.preventDefault(); choose({ type: "state", id: parent.id }, true); } }, parent.name))
                    : null,
                s.page && s.page.excerpt ? el("p", {}, s.page.excerpt) : null,
                s.page ? el("p", {}, el("a", { href: s.page.url }, "Read about it ", Icons.el("arrowright"))) : null,
                stats
                    ? el("div", { class: "stats" },
                        el("h3", {}, "Statistics (approximate)"),
                        el("p", {}, `Area about ${MapCore.approx(stats.area_sq_mi)} sq mi`),
                        el("p", {}, `Border about ${MapCore.approx(stats.perimeter_mi)} mi long`),
                        stats.neighbors.length
                            ? el("div", {}, el("p", { class: "muted" }, "Neighbours:"),
                                el("ul", {}, stats.neighbors.map((n) =>
                                    el("li", {}, el("button", { type: "button", onclick: () => choose({ type: "state", id: n.id }, true) },
                                        `${n.name} · ${MapCore.approx(n.border_mi)} mi`)))))
                            : null)
                    : null,
                clients.length
                    ? el("details", { class: "clients" }, el("summary", { class: "muted" }, `Made up of ${clients.length} state${clients.length === 1 ? "" : "s"}`),
                        el("ul", {}, clients.map((c) =>
                            el("li", {}, el("button", { type: "button", onclick: () => choose({ type: "state", id: c.id }, true) },
                                el("span", { class: "swatch", style: `background:${c.color}` }), `${c.name} (${statusOf(c).toLowerCase()})`)))))
                    : null,
                speciesBlock(s));
        }

        const p = bundle.points.find((x) => x.id === selection.id);
        return el("div", {},
            el("h2", {}, p.name),
            el("p", { class: "muted" }, p.kind),
            p.page ? el("p", {}, el("a", { href: p.page.url }, `${p.page.title} `, Icons.el("arrowright"))) : null);
    }

    function choose(selection, zoom) {
        view.select(selection);

        if (!selection) {
            overview();
            history.replaceState(null, "", location.pathname);
            return;
        }

        info.replaceChildren(
            describe(selection),
            el("p", {}, el("button", { type: "button", onclick: () => choose(null) }, Icons.el("arrowleft"), " All states")));

        if (selection.type === "state") {
            history.replaceState(null, "", `${location.pathname}?state=${selection.id}`);
            if (zoom) {
                const box = view.stateExtent(selection.id);
                if (box) {
                    view.fit(box, { animate: true });
                }
            }
        }
    }

    // Elevation: shown on request, as a tint (grayscale or colours) and/or relief shading.
    // Above the map: how it is drawn (standard or WebGL) and, if the map has elevation, how that is shown.
    function addOptions() {
        const options = el("div", { class: "map-options" }, MapCore.rendererControl(view));
        document.querySelector(".map-layout").before(options);

        if (!bundle.elevation) {
            return;
        }

        let loaded = null;
        const apply = async (style) => {
            if ((style.tint !== "none" || style.relief) && !loaded) {
                loaded = MapCore.loadElevation(bundle.elevation, bundle.map.id);
                view.setElevation(await loaded);
            }
            view.setElevationStyle(style);
        };

        const initial = MapCore.savedElevationStyle();
        const controls = MapCore.elevationControls(initial, apply);
        options.append(" · ", controls.element, el("span", { class: "muted" }, " · point at the land for its height"));

        if (initial.tint !== "none" || initial.relief) {
            apply(initial);
        }
    }

    fetch(`/api/maps/${mapId}`)
        .then((response) => response.json())
        .then((data) => {
            bundle = data;
            view = MapCore.create({ target, bundle, editable: false, fullscreen: document.querySelector(".map-layout") });
            overview();
            addOptions();

            view.ol.on("singleclick", (event) => choose(view.pick(event.pixel), false));
            view.ol.on("pointermove", (event) => {
                target.querySelector(".ol-viewport").style.cursor = view.pick(event.pixel) ? "pointer" : "";
            });

            const wanted = Number(new URLSearchParams(location.search).get("state"));
            if (bundle.states.some((s) => s.id === wanted)) {
                setTimeout(() => choose({ type: "state", id: wanted }, true), 100);
            }
        })
        .catch(() => {
            info.textContent = "Could not load the map.";
        });
})();
