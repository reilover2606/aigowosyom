"use strict";

// Maps: land, lakes and rivers (independent shapes), political states that
// share their borders, points of interest, and tracer images. See the table
// comments in lib/db.js for how the borders are stored.
//
// Every state has a page in the built-in "States" lore category, created with
// it and kept in step (like the Eras pages), so the lore and the map agree.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { db } = require("./db");
const { DATA_DIR } = require("./config");
const lore = require("./lore");
const { applyHidden } = require("./visibility");
const { parseColor } = require("./color");
const { excerpt } = require("./html");
const { HttpError } = require("./http");

const CATEGORY_KEY = "states"; // lore_categories.system_key
const CATEGORY_SLUG = "states";
const IMAGE_DIR = path.join(DATA_DIR, "map-images");
const RESERVED_SLUGS = ["editor", "new"];
const MAX_POINTS = 200000;

// A pleasant default color for each new state, cycling.
const STATE_COLORS = ["#c0392b", "#2e86c1", "#28b463", "#d68910", "#8e44ad", "#17a589", "#ba4a00", "#566573"];

const stmt = {
    maps: db.prepare("SELECT * FROM maps ORDER BY name COLLATE NOCASE"),
    mapById: db.prepare("SELECT * FROM maps WHERE id = ?"),
    mapBySlug: db.prepare("SELECT * FROM maps WHERE slug = ?"),
    mapSlugTaken: db.prepare("SELECT id FROM maps WHERE slug = ?"),
    mapInsert: db.prepare(`
        INSERT INTO maps (slug, name, description, width, height, miles_per_unit, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    mapUpdate: db.prepare(`
        UPDATE maps SET slug = ?, name = ?, description = ?, width = ?, height = ?, miles_per_unit = ?,
                        updated_at = ?
        WHERE id = ?
    `),
    mapDelete: db.prepare("DELETE FROM maps WHERE id = ?"),
    mapCounts: db.prepare(`
        SELECT (SELECT COUNT(*) FROM map_states WHERE map_id = @id) AS states,
               (SELECT COUNT(*) FROM map_points WHERE map_id = @id) AS points
    `),

    features: db.prepare("SELECT * FROM map_features WHERE map_id = ? ORDER BY id"),
    featureById: db.prepare("SELECT * FROM map_features WHERE id = ?"),
    featureInsert: db.prepare(
        "INSERT INTO map_features (map_id, kind, name, geometry, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ),
    featureUpdate: db.prepare(
        "UPDATE map_features SET kind = ?, name = ?, geometry = ?, updated_at = ? WHERE id = ?"
    ),
    featureDelete: db.prepare("DELETE FROM map_features WHERE id = ?"),

    vertices: db.prepare("SELECT id, x, y FROM map_vertices WHERE map_id = ?"),
    vertexById: db.prepare("SELECT * FROM map_vertices WHERE id = ?"),
    vertexInsert: db.prepare("INSERT INTO map_vertices (map_id, x, y) VALUES (?, ?, ?)"),
    vertexMove: db.prepare("UPDATE map_vertices SET x = ?, y = ? WHERE id = ? AND map_id = ?"),
    vertexDelete: db.prepare("DELETE FROM map_vertices WHERE id = ?"),

    states: db.prepare("SELECT * FROM map_states WHERE map_id = ? ORDER BY id"),
    stateById: db.prepare("SELECT * FROM map_states WHERE id = ?"),
    stateInsert: db.prepare(`
        INSERT INTO map_states (map_id, name, color, label_sans, geometry, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    stateUpdate: db.prepare(
        "UPDATE map_states SET name = ?, color = ?, label_sans = ?, geometry = ?, updated_at = ? WHERE id = ?"
    ),
    stateGeometry: db.prepare("UPDATE map_states SET geometry = ?, updated_at = ? WHERE id = ?"),
    stateDelete: db.prepare("DELETE FROM map_states WHERE id = ?"),
    groupInsert: db.prepare(`
        INSERT INTO map_states (map_id, name, color, label_sans, geometry, created_at, updated_at)
        VALUES (?, ?, ?, ?, '[]', ?, ?)
    `),
    setParent: db.prepare("UPDATE map_states SET parent_id = ?, updated_at = ? WHERE id = ?"),
    clients: db.prepare("SELECT id, name FROM map_states WHERE parent_id = ? ORDER BY name COLLATE NOCASE"),
    emptyGroups: db.prepare(`
        SELECT id, name FROM map_states
        WHERE map_id = ? AND geometry = '[]' AND id NOT IN (SELECT parent_id FROM map_states WHERE parent_id IS NOT NULL)
    `),
    pageUrl: db.prepare(`
        SELECT p.slug, c.slug AS category_slug FROM lore_pages p JOIN lore_categories c ON c.id = p.category_id
        WHERE p.map_state_id = ?
    `),
    stateCount: db.prepare("SELECT COUNT(*) AS n FROM map_states WHERE map_id = ?"),

    points: db.prepare(`
        SELECT pt.*, p.title AS page_title, p.slug AS page_slug, c.slug AS page_category_slug
        FROM map_points pt
        LEFT JOIN lore_pages p ON p.id = pt.page_id
        LEFT JOIN lore_categories c ON c.id = p.category_id
        WHERE pt.map_id = ? ORDER BY pt.id
    `),
    pointById: db.prepare("SELECT * FROM map_points WHERE id = ?"),
    pointInsert: db.prepare(`
        INSERT INTO map_points (map_id, name, kind, x, y, page_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    pointUpdate: db.prepare(
        "UPDATE map_points SET name = ?, kind = ?, x = ?, y = ?, page_id = ?, updated_at = ? WHERE id = ?"
    ),
    pointDelete: db.prepare("DELETE FROM map_points WHERE id = ?"),

    images: db.prepare("SELECT * FROM map_images WHERE map_id = ? ORDER BY id"),
    imageById: db.prepare("SELECT * FROM map_images WHERE id = ?"),
    imageInsert: db.prepare(`
        INSERT INTO map_images (map_id, name, file, mime, x, y, width, height, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    imageUpdate: db.prepare(
        "UPDATE map_images SET name = ?, x = ?, y = ?, width = ?, height = ?, opacity = ?, visible = ? WHERE id = ?"
    ),
    imageDelete: db.prepare("DELETE FROM map_images WHERE id = ?"),
    imageCount: db.prepare("SELECT COUNT(*) AS n FROM map_images WHERE map_id = ?"),

    pageForState: db.prepare("SELECT id FROM lore_pages WHERE map_state_id = ?"),
    pageAttach: db.prepare("UPDATE lore_pages SET map_state_id = ? WHERE id = ?"),
    pageDetach: db.prepare("UPDATE lore_pages SET map_state_id = NULL WHERE map_state_id = ?"),
    pageRetitle: db.prepare("UPDATE lore_pages SET title = ?, sort_key = ?, updated_at = ? WHERE id = ?"),
    pageExists: db.prepare("SELECT id FROM lore_pages WHERE id = ?"),
    statePages: db.prepare(`
        SELECT p.map_state_id AS state_id, p.id, p.title, p.slug, p.body_text, c.slug AS category_slug
        FROM lore_pages p JOIN lore_categories c ON c.id = p.category_id
        WHERE p.map_state_id IN (SELECT id FROM map_states WHERE map_id = ?)
    `),

    categoryByKey: db.prepare("SELECT * FROM lore_categories WHERE system_key = ?"),
    categoryBySlug: db.prepare("SELECT * FROM lore_categories WHERE slug = ?"),
    categoryAdopt: db.prepare("UPDATE lore_categories SET system_key = ? WHERE id = ?"),
    categoryInsert: db.prepare(`
        INSERT INTO lore_categories (slug, name, description, color, system_key, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
};

// ------------------------------------------------------
// Small validators
// ------------------------------------------------------

function text(value, label, max, { required = false } = {}) {
    if (value === undefined || value === null) {
        if (required) {
            throw new HttpError(400, `${label} is required`);
        }
        return null;
    }
    if (typeof value !== "string") {
        throw new HttpError(400, `${label} must be text`);
    }
    const trimmed = value.trim();
    if (required && !trimmed) {
        throw new HttpError(400, `${label} is required`);
    }
    if (trimmed.length > max) {
        throw new HttpError(400, `${label} is too long`);
    }
    return trimmed || null;
}

function num(value, label, { min = -1e9, max = 1e9 } = {}) {
    const n = typeof value === "string" && value.trim() === "" ? NaN : Number(value);
    if (!Number.isFinite(n) || n < min || n > max) {
        throw new HttpError(400, `${label} must be a number${min > -1e9 ? ` of at least ${min}` : ""}`);
    }
    return n;
}

function color(value) {
    try {
        return parseColor(value);
    } catch (error) {
        throw new HttpError(400, error.message);
    }
}

// ------------------------------------------------------
// Maps
// ------------------------------------------------------

function freeMapSlug(base, exceptId = null) {
    const root = base && !RESERVED_SLUGS.includes(base) ? base : "map";
    let candidate = root;
    for (let n = 2; ; n++) {
        const taken = stmt.mapSlugTaken.get(candidate);
        if (!taken || taken.id === exceptId) {
            return candidate;
        }
        candidate = `${root}-${n}`;
    }
}

function parseMap(data, existing) {
    if (!data || typeof data !== "object") {
        throw new HttpError(400, "Invalid map");
    }

    const name = text(data.name, "Name", 100, { required: true });
    const given = text(data.slug, "Slug", 80);

    if (given && (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(given) || RESERVED_SLUGS.includes(given))) {
        throw new HttpError(400, "Slug must use lowercase letters, digits and hyphens, and not be a reserved word");
    }
    if (given) {
        const taken = stmt.mapSlugTaken.get(given);
        if (taken && (!existing || taken.id !== existing.id)) {
            throw new HttpError(409, "Another map already uses that slug");
        }
    }

    return {
        name,
        slug: given || (existing ? existing.slug : freeMapSlug(lore.slugify(name))),
        description: text(data.description, "Description", 5000),
        width: data.width === undefined ? (existing ? existing.width : 2000) : num(data.width, "Width", { min: 10, max: 1e6 }),
        height: data.height === undefined ? (existing ? existing.height : 1500) : num(data.height, "Height", { min: 10, max: 1e6 }),
        milesPerUnit: data.miles_per_unit === undefined
            ? (existing ? existing.miles_per_unit : 1)
            : num(data.miles_per_unit, "Miles per map unit", { min: 1e-6, max: 1e6 })
    };
}

function listMaps() {
    return stmt.maps.all().map((map) => ({ ...map, ...stmt.mapCounts.get({ id: map.id }) }));
}

const getMap = (id) => stmt.mapById.get(id) || null;
const getMapBySlug = (slug) => stmt.mapBySlug.get(slug) || null;

function requireMap(id) {
    const map = getMap(id);
    if (!map) {
        throw new HttpError(404, "Map not found");
    }
    return map;
}

function createMap(data) {
    const m = parseMap(data, null);
    const now = Date.now();
    const id = stmt.mapInsert.run(m.slug, m.name, m.description, m.width, m.height, m.milesPerUnit, now, now)
        .lastInsertRowid;
    applyHidden("maps", id, data);
    return getMap(id);
}

function updateMap(id, data) {
    const existing = requireMap(id);
    const m = parseMap(data, existing);
    stmt.mapUpdate.run(m.slug, m.name, m.description, m.width, m.height, m.milesPerUnit, Date.now(), id);
    applyHidden("maps", id, data);
    return getMap(id);
}

// Deleting a map deletes its shapes, states and points. The lore pages of its
// states are kept (just detached from the states) unless `deletePages`.
const deleteMap = db.transaction((id, { deletePages = false } = {}) => {
    const map = requireMap(id);
    const images = stmt.images.all(id);

    for (const state of stmt.states.all(id)) {
        releasePage(state.id, deletePages);
    }

    stmt.mapDelete.run(id);

    for (const image of images) {
        fs.rmSync(path.join(IMAGE_DIR, image.file), { force: true });
    }
    return map;
});

// ------------------------------------------------------
// Everything a map needs, for the viewer and the editor
// ------------------------------------------------------

function bundle(id, { editor = false } = {}) {
    const map = requireMap(id);
    const pages = new Map(stmt.statePages.all(id).map((p) => [p.state_id, p]));

    return {
        map,
        features: stmt.features.all(id).map((f) => ({ ...f, geometry: JSON.parse(f.geometry) })),
        vertices: stmt.vertices.all(id).map((v) => [v.id, v.x, v.y]),
        states: stmt.states.all(id).map((s) => {
            const page = pages.get(s.id);
            return {
                ...s,
                geometry: undefined,
                polygons: JSON.parse(s.geometry),
                page: page
                    ? {
                          id: page.id,
                          title: page.title,
                          url: `/lore/${encodeURIComponent(page.category_slug)}/${encodeURIComponent(page.slug)}`,
                          excerpt: excerpt(page.body_text, 400)
                      }
                    : null
            };
        }),
        points: stmt.points.all(id).map((p) => ({
            ...p,
            page_title: undefined,
            page_slug: undefined,
            page_category_slug: undefined,
            page: p.page_id
                ? {
                      title: p.page_title,
                      url: `/lore/${encodeURIComponent(p.page_category_slug)}/${encodeURIComponent(p.page_slug)}`
                  }
                : null
        })),
        images: editor ? stmt.images.all(id).map((i) => ({ ...i, file: undefined })) : []
    };
}

// ------------------------------------------------------
// Land, lakes and rivers
// ------------------------------------------------------

function checkCoordinates(value, depth) {
    if (depth === 0) {
        if (!Array.isArray(value) || value.length < 2 || !value.slice(0, 2).every(Number.isFinite)) {
            throw new HttpError(400, "Invalid coordinates");
        }
        return 1;
    }
    if (!Array.isArray(value)) {
        throw new HttpError(400, "Invalid coordinates");
    }
    let count = 0;
    for (const item of value) {
        count += checkCoordinates(item, depth - 1);
    }
    return count;
}

function parseFeature(data) {
    if (!data || typeof data !== "object") {
        throw new HttpError(400, "Invalid shape");
    }
    const kind = data.kind;
    if (!["land", "lake", "river"].includes(kind)) {
        throw new HttpError(400, "Kind must be land, lake or river");
    }

    const geometry = data.geometry;
    const wanted = kind === "river" ? "LineString" : "Polygon";
    if (!geometry || geometry.type !== wanted) {
        throw new HttpError(400, `A ${kind} must be a ${wanted}`);
    }

    const count = checkCoordinates(geometry.coordinates, wanted === "Polygon" ? 2 : 1);
    if (count > MAX_POINTS || count < (wanted === "Polygon" ? 3 : 2)) {
        throw new HttpError(400, "That shape has too few or too many points");
    }

    return {
        kind,
        name: text(data.name, "Name", 100),
        geometry: JSON.stringify({ type: geometry.type, coordinates: geometry.coordinates })
    };
}

function createFeature(mapId, data) {
    requireMap(mapId);
    const f = parseFeature(data);
    const now = Date.now();
    const id = stmt.featureInsert.run(mapId, f.kind, f.name, f.geometry, now, now).lastInsertRowid;
    applyHidden("map_features", id, data);
    return getFeature(id);
}

function getFeature(id) {
    const row = stmt.featureById.get(id);
    return row ? { ...row, geometry: JSON.parse(row.geometry) } : null;
}

function updateFeature(id, data) {
    const existing = stmt.featureById.get(id);
    if (!existing) {
        throw new HttpError(404, "Shape not found");
    }
    // Land and lakes can be swapped; a river stays a river.
    const swappable = existing.kind !== "river" && data && (data.kind === "land" || data.kind === "lake");
    const f = parseFeature({
        name: existing.name,
        geometry: JSON.parse(existing.geometry),
        ...data,
        kind: swappable ? data.kind : existing.kind
    });
    stmt.featureUpdate.run(f.kind, f.name, f.geometry, Date.now(), id);
    applyHidden("map_features", id, data);
    return getFeature(id);
}

function deleteFeature(id) {
    if (stmt.featureDelete.run(id).changes === 0) {
        throw new HttpError(404, "Shape not found");
    }
}

// ------------------------------------------------------
// Vertices and the borders of states
// ------------------------------------------------------

// Rings are lists of vertex ids; each state has [ [outer, ...holes], ... ].
function eachRing(geometry, fn) {
    geometry.forEach((polygon) => polygon.forEach((ring) => fn(ring)));
}

function readStates(mapId) {
    return stmt.states.all(mapId).map((s) => ({ id: s.id, geometry: JSON.parse(s.geometry) }));
}

function saveGeometry(state) {
    stmt.stateGeometry.run(JSON.stringify(state.geometry), Date.now(), state.id);
}

function distanceToSegment(p, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared));
    const x = a.x + t * dx;
    const y = a.y + t * dy;
    return { distance: Math.hypot(p.x - x, p.y - y), x, y };
}

// The closest edge of any state on the map to a point: { a, b, distance, x, y }.
function nearestEdge(mapId, point) {
    const vertices = new Map(stmt.vertices.all(mapId).map((v) => [v.id, v]));
    let best = null;

    for (const state of readStates(mapId)) {
        eachRing(state.geometry, (ring) => {
            for (let i = 0; i < ring.length; i++) {
                const a = vertices.get(ring[i]);
                const b = vertices.get(ring[(i + 1) % ring.length]);
                if (!a || !b) {
                    continue;
                }
                const hit = distanceToSegment(point, a, b);
                if (!best || hit.distance < best.distance) {
                    best = { a: a.id, b: b.id, ...hit };
                }
            }
        });
    }

    return best;
}

// Puts vertex `id` between a and b in every ring that has that edge.
function spliceIntoEdge(mapId, a, b, id) {
    for (const state of readStates(mapId)) {
        let changed = false;
        eachRing(state.geometry, (ring) => {
            for (let i = 0; i < ring.length; i++) {
                const u = ring[i];
                const v = ring[(i + 1) % ring.length];
                if ((u === a && v === b) || (u === b && v === a)) {
                    ring.splice(i + 1, 0, id);
                    changed = true;
                    break;
                }
            }
        });
        if (changed) {
            saveGeometry(state);
        }
    }
}

// How close (in map units) a point must be to an edge to count as on it.
const ON_EDGE = 1e-3;

// Adds a vertex. With `snapEdge` it must lie on an existing border and is
// spliced into that border for every state that has it.
const addVertex = db.transaction((mapId, data) => {
    requireMap(mapId);
    const x = num(data && data.x, "x");
    const y = num(data && data.y, "y");

    if (data.snapEdge) {
        const edge = nearestEdge(mapId, { x, y });
        if (edge && edge.distance <= Math.max(ON_EDGE, 1e-6 * Math.abs(x + y))) {
            const id = stmt.vertexInsert.run(mapId, edge.x, edge.y).lastInsertRowid;
            spliceIntoEdge(mapId, edge.a, edge.b, id);
            return { id, x: edge.x, y: edge.y };
        }
    }

    const id = stmt.vertexInsert.run(mapId, x, y).lastInsertRowid;
    return { id, x, y };
});

const moveVertices = db.transaction((mapId, moves) => {
    requireMap(mapId);
    if (!Array.isArray(moves) || moves.length === 0 || moves.length > 1000) {
        throw new HttpError(400, "Nothing to move");
    }
    for (const move of moves) {
        const info = stmt.vertexMove.run(num(move.x, "x"), num(move.y, "y"), Number(move.id), mapId);
        if (info.changes === 0) {
            throw new HttpError(404, "Corner not found");
        }
    }
});

// Removes consecutive repeats; a ring needs three distinct corners.
function tidyRing(ring) {
    const out = [];
    for (const id of ring) {
        if (out[out.length - 1] !== id) {
            out.push(id);
        }
    }
    while (out.length > 1 && out[0] === out[out.length - 1]) {
        out.pop();
    }
    return out;
}

// Replaces vertex `from` by `into` everywhere (or removes it, with into=null),
// then forgets corners no ring uses. Refuses if a shape would collapse.
function rewriteVertex(mapId, from, into) {
    for (const state of readStates(mapId)) {
        let changed = false;
        const polygons = [];

        for (const polygon of state.geometry) {
            const rings = [];
            for (const [index, ring] of polygon.entries()) {
                if (!ring.includes(from)) {
                    rings.push(ring);
                    continue;
                }
                changed = true;
                const next = tidyRing(into === null ? ring.filter((id) => id !== from) : ring.map((id) => (id === from ? into : id)));
                if (next.length < 3) {
                    if (index === 0) {
                        throw new HttpError(409, "That would leave a state with a shape of fewer than three corners.");
                    }
                    continue; // a hole that collapsed just disappears
                }
                rings.push(next);
            }
            polygons.push(rings);
        }

        if (changed) {
            state.geometry = polygons;
            saveGeometry(state);
        }
    }
}

const deleteVertex = db.transaction((id) => {
    const vertex = stmt.vertexById.get(id);
    if (!vertex) {
        throw new HttpError(404, "Corner not found");
    }
    rewriteVertex(vertex.map_id, id, null);
    stmt.vertexDelete.run(id);
});

// Welds corner `id` onto corner `into` (dragging one corner onto another).
const mergeVertices = db.transaction((id, into) => {
    const a = stmt.vertexById.get(id);
    const b = stmt.vertexById.get(into);
    if (!a || !b || a.map_id !== b.map_id || a.id === b.id) {
        throw new HttpError(400, "Choose two different corners on the same map");
    }
    rewriteVertex(a.map_id, a.id, b.id);
    stmt.vertexDelete.run(a.id);
});

function forgetUnusedVertices(mapId) {
    const used = new Set();
    for (const state of readStates(mapId)) {
        eachRing(state.geometry, (ring) => ring.forEach((id) => used.add(id)));
    }
    for (const { id } of stmt.vertices.all(mapId)) {
        if (!used.has(id)) {
            stmt.vertexDelete.run(id);
        }
    }
}

// ------------------------------------------------------
// States and their lore pages
// ------------------------------------------------------

function ensureStatesCategory() {
    let category = stmt.categoryByKey.get(CATEGORY_KEY);

    if (!category) {
        category = stmt.categoryBySlug.get(CATEGORY_SLUG);

        if (category) {
            stmt.categoryAdopt.run(CATEGORY_KEY, category.id);
        } else {
            const now = Date.now();
            const id = stmt.categoryInsert.run(
                CATEGORY_SLUG,
                "States",
                "The political states drawn on the maps. Each page is created with its state and named after " +
                    "it; write the lore here and see the state on its map.",
                "#7c3aed",
                CATEGORY_KEY,
                now,
                now
            ).lastInsertRowid;
            category = { id };
        }
    }

    return category;
}

function createStatePage(stateId, name) {
    const category = ensureStatesCategory();
    const pageId = lore.savePage(null, { category_id: category.id, title: name, body: "" });
    stmt.pageAttach.run(stateId, pageId);
    return pageId;
}

// Detaches the page of a state, or deletes it.
function releasePage(stateId, deletePage) {
    const page = stmt.pageForState.get(stateId);
    stmt.pageDetach.run(stateId);
    if (page && deletePage) {
        lore.deletePage(page.id);
    }
}

// A ring item is { id } for an existing corner, or { x, y, snapEdge? } for a
// new one. Returns the vertex ids.
function resolveRing(mapId, ring) {
    if (!Array.isArray(ring)) {
        throw new HttpError(400, "A ring must be a list of corners");
    }

    const ids = ring.map((item) => {
        if (item && item.id !== undefined) {
            const vertex = stmt.vertexById.get(Number(item.id));
            if (!vertex || vertex.map_id !== mapId) {
                throw new HttpError(400, "A corner does not exist on this map");
            }
            return vertex.id;
        }
        return Number(addVertex(mapId, item).id);
    });

    const tidy = tidyRing(ids);
    if (new Set(tidy).size < 3) {
        throw new HttpError(400, "A shape needs at least three different corners");
    }
    return tidy;
}

function resolvePolygons(mapId, polygons) {
    if (!Array.isArray(polygons) || polygons.length === 0) {
        throw new HttpError(400, "A state needs a shape");
    }
    return polygons.map((polygon) => {
        if (!Array.isArray(polygon) || polygon.length === 0) {
            throw new HttpError(400, "A state's shape needs an outline");
        }
        return polygon.map((ring) => resolveRing(mapId, ring));
    });
}

const createState = db.transaction((mapId, data) => {
    requireMap(mapId);
    const name = text(data && data.name, "Name", 100, { required: true });
    const count = stmt.stateCount.get(mapId).n;
    const polygons = resolvePolygons(mapId, data.polygons);
    const now = Date.now();

    const id = stmt.stateInsert.run(
        mapId,
        name,
        color(data.color) || STATE_COLORS[count % STATE_COLORS.length],
        data.label_sans ? 1 : 0,
        JSON.stringify(polygons),
        now,
        now
    ).lastInsertRowid;

    applyHidden("map_states", id, data);
    createStatePage(id, name);
    return getState(id);
});

function getState(id) {
    const row = stmt.stateById.get(id);
    return row ? { ...row, geometry: undefined, polygons: JSON.parse(row.geometry) } : null;
}

const updateState = db.transaction((id, data) => {
    const existing = stmt.stateById.get(id);
    if (!existing) {
        throw new HttpError(404, "State not found");
    }

    const name = data && data.name !== undefined ? text(data.name, "Name", 100, { required: true }) : existing.name;
    if (data && data.polygons !== undefined && isGroup(existing)) {
        throw new HttpError(400, "A state made of other states has no shape of its own.");
    }
    const polygons = data && data.polygons !== undefined
        ? resolvePolygons(existing.map_id, data.polygons)
        : JSON.parse(existing.geometry);

    stmt.stateUpdate.run(
        name,
        data && data.color !== undefined ? color(data.color) : existing.color,
        data && data.label_sans !== undefined ? (data.label_sans ? 1 : 0) : existing.label_sans,
        JSON.stringify(polygons),
        Date.now(),
        id
    );

    applyHidden("map_states", id, data);

    // The page is named after its state.
    if (name !== existing.name) {
        const page = stmt.pageForState.get(id);
        if (page) {
            stmt.pageRetitle.run(name, lore.fold(name), Date.now(), page.id);
            lore.indexPage(page.id);
        }
    }

    forgetUnusedVertices(existing.map_id);
    return getState(id);
});

// Deleting a state that is made of other states only dissolves the grouping:
// its clients stay (moving up to its own parent, if it has one).
const deleteState = db.transaction((id, { deletePage = false } = {}) => {
    const existing = stmt.stateById.get(id);
    if (!existing) {
        throw new HttpError(404, "State not found");
    }

    for (const client of stmt.clients.all(id)) {
        stmt.setParent.run(existing.parent_id, Date.now(), client.id);
    }

    releasePage(id, deletePage);
    stmt.stateDelete.run(id);
    const removed = pruneEmptyGroups(existing.map_id);
    forgetUnusedVertices(existing.map_id);
    return { removed };
});

// ------------------------------------------------------
// Superstates: states grouped into larger states
// ------------------------------------------------------

const isGroup = (row) => row.geometry === "[]";

// A state made of other states only exists while it has some. Removes any
// that have none left (their lore pages are kept, as ordinary pages) and
// returns their names.
function pruneEmptyGroups(mapId) {
    const removed = [];
    for (;;) {
        const empty = stmt.emptyGroups.all(mapId);
        if (empty.length === 0) {
            return removed;
        }
        for (const group of empty) {
            releasePage(group.id, false);
            stmt.stateDelete.run(group.id);
            removed.push(group.name);
        }
    }
}

function memberIds(mapId, ids, minimum) {
    if (!Array.isArray(ids)) {
        throw new HttpError(400, "Choose some states");
    }
    const unique = [...new Set(ids.map(Number))];
    if (unique.length < minimum) {
        throw new HttpError(400, minimum > 1 ? "Choose at least two states to combine" : "Choose some states");
    }
    for (const id of unique) {
        const row = Number.isSafeInteger(id) ? stmt.stateById.get(id) : null;
        if (!row || row.map_id !== mapId) {
            throw new HttpError(400, "A chosen state does not exist on this map");
        }
    }
    return unique;
}

// Combines states into a new state that has them as its clients. The states
// keep existing (and keep their own shapes and pages).
const groupStates = db.transaction((mapId, data) => {
    requireMap(mapId);
    const ids = memberIds(mapId, data && data.ids, 2);
    const name = text(data && data.name, "Name", 100, { required: true });
    const count = stmt.stateCount.get(mapId).n;
    const now = Date.now();

    const id = stmt.groupInsert.run(
        mapId, name, color(data.color) || STATE_COLORS[count % STATE_COLORS.length], data.label_sans ? 1 : 0, now, now
    ).lastInsertRowid;

    applyHidden("map_states", id, data);
    createStatePage(id, name);

    for (const clientId of ids) {
        stmt.setParent.run(id, now, clientId);
    }

    const removed = pruneEmptyGroups(mapId); // a former group may have been emptied
    return { state: getState(id), removed };
});

// Adds states to an existing superstate (moving them out of any other).
const addToGroup = db.transaction((groupId, ids) => {
    const group = stmt.stateById.get(groupId);
    if (!group || !isGroup(group)) {
        throw new HttpError(400, "Choose a state that is made of other states");
    }
    const members = memberIds(group.map_id, ids, 1);

    // Never inside itself: the group must not be one of them, or sit below one.
    for (let at = group; at; at = at.parent_id ? stmt.stateById.get(at.parent_id) : null) {
        if (members.includes(at.id)) {
            throw new HttpError(400, "A state can't be put inside itself.");
        }
    }

    const now = Date.now();
    for (const id of members) {
        stmt.setParent.run(groupId, now, id);
    }
    return { removed: pruneEmptyGroups(group.map_id) };
});

// Takes states out of their superstate (to stand on their own).
const ungroupStates = db.transaction((mapId, ids) => {
    requireMap(mapId);
    const members = memberIds(mapId, ids, 1);
    const now = Date.now();
    for (const id of members) {
        stmt.setParent.run(null, now, id);
    }
    return { removed: pruneEmptyGroups(mapId) };
});

function pageUrlOf(stateId) {
    const row = stmt.pageUrl.get(stateId);
    return row ? `/lore/${encodeURIComponent(row.category_slug)}/${encodeURIComponent(row.slug)}` : null;
}

// The clients of a superstate, and theirs in turn: [{ id, name, url, clients }].
function clientTree(stateId, depth = 0) {
    if (depth > 20) {
        return [];
    }
    return stmt.clients.all(stateId).map((c) => ({
        id: c.id,
        name: c.name,
        url: pageUrlOf(c.id),
        clients: clientTree(c.id, depth + 1)
    }));
}

// ------------------------------------------------------
// Points of interest
// ------------------------------------------------------

function parsePoint(data, existing) {
    if (!data || typeof data !== "object") {
        throw new HttpError(400, "Invalid point");
    }

    let pageId = existing ? existing.page_id : null;
    if (data.page_id !== undefined) {
        pageId = data.page_id === null || data.page_id === "" ? null : Number(data.page_id);
        if (pageId !== null && (!Number.isSafeInteger(pageId) || !stmt.pageExists.get(pageId))) {
            throw new HttpError(400, "That lore page does not exist");
        }
    }

    return {
        name: data.name === undefined && existing ? existing.name : text(data.name, "Name", 100, { required: true }),
        kind: data.kind === undefined && existing ? existing.kind : (text(data.kind, "Kind", 40) || "city"),
        x: data.x === undefined && existing ? existing.x : num(data.x, "x"),
        y: data.y === undefined && existing ? existing.y : num(data.y, "y"),
        pageId
    };
}

function getPoint(id) {
    return stmt.pointById.get(id) || null;
}

function createPoint(mapId, data) {
    requireMap(mapId);
    const p = parsePoint(data, null);
    const now = Date.now();
    const id = stmt.pointInsert.run(mapId, p.name, p.kind, p.x, p.y, p.pageId, now, now).lastInsertRowid;
    applyHidden("map_points", id, data);
    return getPoint(id);
}

function updatePoint(id, data) {
    const existing = getPoint(id);
    if (!existing) {
        throw new HttpError(404, "Point not found");
    }
    const p = parsePoint(data, existing);
    stmt.pointUpdate.run(p.name, p.kind, p.x, p.y, p.pageId, Date.now(), id);
    applyHidden("map_points", id, data);
    return getPoint(id);
}

function deletePoint(id) {
    if (stmt.pointDelete.run(id).changes === 0) {
        throw new HttpError(404, "Point not found");
    }
}

// ------------------------------------------------------
// Tracer images (editor only, never published)
// ------------------------------------------------------

const IMAGE_TYPES = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp"
};

// Pixel size from the file header.
function imageSize(buffer, mime) {
    if (mime === "image/png" && buffer.length > 24 && buffer.toString("latin1", 1, 4) === "PNG") {
        return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }

    if (mime === "image/jpeg" && buffer[0] === 0xff && buffer[1] === 0xd8) {
        let offset = 2;
        while (offset + 9 < buffer.length) {
            if (buffer[offset] !== 0xff) {
                offset++;
                continue;
            }
            const marker = buffer[offset + 1];
            const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
            if (isFrame) {
                return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
            }
            offset += 2 + buffer.readUInt16BE(offset + 2);
        }
    }

    if (mime === "image/webp" && buffer.toString("latin1", 0, 4) === "RIFF" && buffer.toString("latin1", 8, 12) === "WEBP") {
        const kind = buffer.toString("latin1", 12, 16);
        if (kind === "VP8X") {
            return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
        }
        if (kind === "VP8L") {
            const bits = buffer.readUInt32LE(21);
            return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
        }
        if (kind === "VP8 ") {
            return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
        }
    }

    throw new HttpError(400, "That doesn't look like a valid PNG, JPEG or WebP image");
}

function addImage(mapId, buffer, mime, name) {
    const map = requireMap(mapId);
    const extension = IMAGE_TYPES[mime];
    if (!extension) {
        throw new HttpError(415, "Tracer images must be PNG, JPEG or WebP");
    }

    const size = imageSize(buffer, mime);
    const file = `${crypto.randomUUID()}${extension}`;
    fs.mkdirSync(IMAGE_DIR, { recursive: true });
    fs.writeFileSync(path.join(IMAGE_DIR, file), buffer);

    // The first image of an empty map sets the size of the map.
    const first = stmt.imageCount.get(mapId).n === 0;
    if (first && stmt.stateCount.get(mapId).n === 0 && stmt.features.all(mapId).length === 0) {
        stmt.mapUpdate.run(map.slug, map.name, map.description, size.width, size.height, map.miles_per_unit, Date.now(), mapId);
    }

    const id = stmt.imageInsert.run(
        mapId, text(name, "Name", 100) || `Tracer ${stmt.imageCount.get(mapId).n + 1}`,
        file, mime, 0, 0, size.width, size.height, Date.now()
    ).lastInsertRowid;

    return { ...stmt.imageById.get(id), file: undefined };
}

function updateImage(id, data) {
    const existing = stmt.imageById.get(id);
    if (!existing) {
        throw new HttpError(404, "Image not found");
    }
    stmt.imageUpdate.run(
        data.name === undefined ? existing.name : text(data.name, "Name", 100, { required: true }),
        data.x === undefined ? existing.x : num(data.x, "x"),
        data.y === undefined ? existing.y : num(data.y, "y"),
        data.width === undefined ? existing.width : num(data.width, "Width", { min: 1 }),
        data.height === undefined ? existing.height : num(data.height, "Height", { min: 1 }),
        data.opacity === undefined ? existing.opacity : num(data.opacity, "Opacity", { min: 0, max: 1 }),
        data.visible === undefined ? existing.visible : (data.visible ? 1 : 0),
        id
    );
    return { ...stmt.imageById.get(id), file: undefined };
}

function deleteImage(id) {
    const existing = stmt.imageById.get(id);
    if (!existing) {
        throw new HttpError(404, "Image not found");
    }
    stmt.imageDelete.run(id);
    fs.rmSync(path.join(IMAGE_DIR, existing.file), { force: true });
}

// The file itself: { path, mime }.
function imageFile(id) {
    const existing = stmt.imageById.get(id);
    return existing ? { path: path.join(IMAGE_DIR, existing.file), mime: existing.mime } : null;
}

// Where a state is, for its lore page: { id, name, map_id, map_name, map_slug }.
function stateInfo(stateId) {
    const row = db
        .prepare(`
            SELECT s.id, s.name, s.parent_id, s.geometry, m.id AS map_id, m.name AS map_name, m.slug AS map_slug
            FROM map_states s JOIN maps m ON m.id = s.map_id WHERE s.id = ?
        `)
        .get(stateId);

    if (!row) {
        return null;
    }

    const parent = row.parent_id ? stmt.stateById.get(row.parent_id) : null;
    const { geometry, parent_id: parentId, ...info } = row;
    return {
        ...info,
        is_group: geometry === "[]",
        parent: parent ? { id: parent.id, name: parent.name, url: pageUrlOf(parent.id) } : null,
        clients: geometry === "[]" ? clientTree(stateId) : []
    };
}

module.exports = {
    stateInfo,
    CATEGORY_KEY,
    RESERVED_SLUGS,
    listMaps,
    getMap,
    getMapBySlug,
    createMap,
    updateMap,
    deleteMap,
    bundle,
    createFeature,
    updateFeature,
    deleteFeature,
    addVertex,
    moveVertices,
    deleteVertex,
    mergeVertices,
    createState,
    updateState,
    deleteState,
    groupStates,
    addToGroup,
    ungroupStates,
    createPoint,
    updatePoint,
    deletePoint,
    addImage,
    updateImage,
    deleteImage,
    imageFile
};
