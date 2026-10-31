"use strict";

// Server-rendered map pages: the list of maps, a map's viewer, and the
// editor shell (the editor itself is in public/assets/maps/).

const maps = require("../lib/maps");
const config = require("../lib/config");
const { HttpError, sendHtml } = require("../lib/http");
const { esc, ifEditing, layout } = require("../lib/render");
const { excerpt } = require("../lib/html");

const OPENLAYERS = ["/vendor/ol/ol.js"];
const STYLES = ["/vendor/ol/ol.css", "/assets/maps/maps.css"];

function listPage() {
    const all = maps.listMaps();

    const cards = all
        .map(
            (m) => `<a class="language-card" href="/maps/${encodeURIComponent(m.slug)}" style="--lang-color:#2e86c1">
            <span class="language-card-name">${esc(m.name)}</span>
            <span class="language-card-meta">${m.states} ${m.states === 1 ? "state" : "states"} · ${m.points} ${m.points === 1 ? "place" : "places"}</span>
            ${m.description ? `<span class="category-blurb">${esc(excerpt(m.description, 120))}</span>` : ""}
        </a>`
        )
        .join("\n");

    return layout({
        title: "Maps",
        section: "maps",
        bar: "maps",
        styles: ["/assets/lore/lore.css"],
        body: `<main class="content">
    <h1>Maps</h1>
    ${all.length
        ? `<p class="muted">Choose a map. Click a state or a place on it to read about it.</p>
    <div class="language-grid">${cards}</div>`
        : `<p class="muted">No maps yet.${ifEditing(' Create one in the <a href="/maps/editor">editor</a>.')}</p>`}
</main>`
    });
}

function viewerPage(map) {
    return layout({
        title: map.name,
        section: "maps",
        bar: "maps",
        styles: STYLES,
        scripts: [...OPENLAYERS, "/assets/maps/map-webgl.js", "/assets/maps/map-core.js", "/assets/maps/map-viewer.js"],
        body: `<main class="map-page">
    <p class="crumbs"><a href="/maps">Maps</a> › ${esc(map.name)}</p>
    <h1>${esc(map.name)}</h1>
    ${map.description ? `<p class="muted map-description">${esc(map.description)}</p>` : ""}
    <div class="map-layout">
        <div id="map" class="map-view" data-map-id="${map.id}" role="application" aria-label="Map of ${esc(map.name)}"></div>
        <aside id="mapInfo" class="map-info" aria-live="polite"></aside>
    </div>
    <noscript><p>This map needs JavaScript.</p></noscript>
</main>`
    });
}

function editorPage() {
    return layout({
        title: "Map editor",
        section: "maps",
        active: "editor",
        bar: "maps",
        styles: [...STYLES, "/assets/dictionary/editor.css"],
        scripts: ["/assets/ui.js", ...OPENLAYERS, "/assets/maps/map-webgl.js", "/assets/maps/map-core.js", "/assets/maps/map-editor.js"],
        body: `<main class="map-editor" id="mapEditor"><p class="muted">Loading…</p></main>`
    });
}

module.exports = async function mapsPages(req, res, url) {
    const { pathname } = url;

    if (pathname !== "/maps" && !pathname.startsWith("/maps/")) {
        return false;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
        throw new HttpError(405, "Method not allowed");
    }

    const parts = pathname.split("/").filter(Boolean); // ["maps", slug?]

    if (parts.length === 1) {
        sendHtml(res, 200, listPage());
        return true;
    }

    if (parts.length === 2 && parts[1] === "editor") {
        if (config.PUBLIC) {
            throw new HttpError(404, "Not found");
        }
        sendHtml(res, 200, editorPage());
        return true;
    }

    if (parts.length === 2) {
        const map = maps.getMapBySlug(decodeURIComponent(parts[1]));
        if (!map) {
            throw new HttpError(404, "There is no such map");
        }
        sendHtml(res, 200, viewerPage(map));
        return true;
    }

    throw new HttpError(404, "Not found");
};
