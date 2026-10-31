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

    function overview() {
        const states = [...bundle.states].sort((a, b) => a.name.localeCompare(b.name));
        info.replaceChildren(
            el("h2", {}, bundle.map.name),
            el("p", { class: "muted" }, "Click a state or a place on the map to read about it."),
            states.length
                ? el("ul", {},
                    states.map((s) =>
                        el("li", {},
                            el("button", { type: "button", onclick: () => choose({ type: "state", id: s.id }, true) },
                                el("span", { class: "swatch", style: `background:${s.color}` }), s.name))))
                : null
        );
    }

    function describe(selection) {
        if (selection.type === "state") {
            const s = bundle.states.find((x) => x.id === selection.id);
            return el("div", {},
                el("h2", {}, el("span", { class: "swatch", style: `background:${s.color}` }),
                    el("span", { class: `state-name${s.label_sans ? " sans conlang" : ""}` }, s.name)),
                s.page && s.page.excerpt ? el("p", {}, s.page.excerpt) : null,
                s.page ? el("p", {}, el("a", { href: s.page.url }, "Read about it →")) : null);
        }

        const p = bundle.points.find((x) => x.id === selection.id);
        return el("div", {},
            el("h2", {}, p.name),
            el("p", { class: "muted" }, p.kind),
            p.page ? el("p", {}, el("a", { href: p.page.url }, `${p.page.title} →`)) : null);
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
            el("p", {}, el("button", { type: "button", onclick: () => choose(null) }, "← All states")));

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

    fetch(`/api/maps/${mapId}`)
        .then((response) => response.json())
        .then((data) => {
            bundle = data;
            view = MapCore.create({ target, bundle, editable: false });
            overview();

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
