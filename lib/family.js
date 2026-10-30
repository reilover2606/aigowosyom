"use strict";

// Language family graph: languages as nodes, cross-language ancestry
// links as edges. Laid out in layers (ancestors above descendants) and
// rendered as inline SVG.

const { db } = require("./db");
const { esc, languageUrl } = require("./render");
const { resolveColor } = require("./color");

const NODE_W = 176;
const NODE_H = 58;
const GAP_X = 40;
const GAP_Y = 100;
const PAD = 28;
const LABEL_ROW = 26; // space for the "not linked" caption

const EDGE_INK = "#52514e";
const KIND_STYLE = {
    inherited: { dash: "", label: "inherited" },
    borrowed: { dash: "8 5", label: "borrowed" },
    areal: { dash: "1 5", label: "areal" }
};

const stmt = {
    languages: db.prepare(`
        SELECT l.id, l.slug, l.name, l.color, l.is_proto,
               (SELECT COUNT(*) FROM words WHERE language_id = l.id) AS word_count
        FROM languages l
        ORDER BY l.name COLLATE NOCASE
    `),
    // Distinct words per (ancestor language, descendant language, kind).
    links: db.prepare(`
        SELECT anc.language_id AS from_id, w.language_id AS to_id, a.kind,
               COUNT(DISTINCT a.word_id) AS n
        FROM word_ancestry a
        JOIN words w ON w.id = a.word_id
        JOIN words anc ON anc.id = a.ancestor_id
        WHERE anc.language_id != w.language_id
        GROUP BY from_id, to_id, a.kind
    `)
};

function truncate(text, max) {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// ------------------------------------------------------
// Layout
// ------------------------------------------------------

// Drops edges that close a cycle (found by DFS from the roots), so the
// remaining directed edges form a DAG that can be layered.
function acyclicEdges(languages, pairs) {
    const out = new Map(languages.map((l) => [l.id, []]));
    const hasIncoming = new Set();

    for (const [from, to] of pairs) {
        out.get(from).push(to);
        hasIncoming.add(to);
    }

    // Roots first (proto-languages ahead of the rest), then anything left.
    const starts = [...languages]
        .sort((a, b) =>
            (hasIncoming.has(a.id) ? 1 : 0) - (hasIncoming.has(b.id) ? 1 : 0) ||
            b.is_proto - a.is_proto ||
            a.name.localeCompare(b.name)
        )
        .map((l) => l.id);

    const state = new Map(); // 1 = on the DFS stack, 2 = finished
    const kept = [];

    function visit(u) {
        state.set(u, 1);
        for (const v of out.get(u)) {
            if (state.get(v) === 1) {
                continue; // back edge: would make a cycle
            }
            kept.push([u, v]);
            if (!state.has(v)) {
                visit(v);
            }
        }
        state.set(u, 2);
    }

    for (const id of starts) {
        if (!state.has(id)) {
            visit(id);
        }
    }

    return kept;
}

// Reorders each layer by the average position of its neighbors, a few
// sweeps down and up, to cut down edge crossings.
function orderLayers(layers, dag) {
    const preds = new Map();
    const succs = new Map();

    for (const [u, v] of dag) {
        (preds.get(v) || preds.set(v, []).get(v)).push(u);
        (succs.get(u) || succs.set(u, []).get(u)).push(v);
    }

    const fraction = new Map();

    function recordPositions() {
        for (const layer of layers) {
            layer.forEach((id, i) => fraction.set(id, layer.length > 1 ? i / (layer.length - 1) : 0.5));
        }
    }

    function sweep(layer, neighbors) {
        const keyed = layer.map((id, i) => {
            const near = neighbors.get(id);
            const bary = near && near.length
                ? near.reduce((sum, n) => sum + fraction.get(n), 0) / near.length
                : fraction.get(id);
            return { id, bary, i };
        });

        keyed.sort((a, b) => a.bary - b.bary || a.i - b.i);
        layer.splice(0, layer.length, ...keyed.map((k) => k.id));
        recordPositions();
    }

    recordPositions();

    for (let pass = 0; pass < 6; pass++) {
        for (let L = 1; L < layers.length; L++) {
            sweep(layers[L], preds);
        }
        for (let L = layers.length - 2; L >= 0; L--) {
            sweep(layers[L], succs);
        }
    }
}

function layoutFamily(languages, links) {
    const byId = new Map(languages.map((l) => [l.id, l]));

    const linkedIds = new Set();
    for (const link of links) {
        linkedIds.add(link.from_id);
        linkedIds.add(link.to_id);
    }

    // Generations follow inheritance. A language with no inherited parent
    // is placed below the languages it borrows from instead. Other
    // borrowed links and areal links are drawn as cross-links and don't
    // make one language "older" than another.
    const inheritedTargets = new Set(
        links.filter((l) => l.kind === "inherited").map((l) => l.to_id)
    );
    const pairs = new Map();
    for (const link of links) {
        const shapesLayers =
            link.kind === "inherited" ||
            (link.kind === "borrowed" && !inheritedTargets.has(link.to_id));

        if (shapesLayers) {
            pairs.set(`${link.from_id}>${link.to_id}`, [link.from_id, link.to_id]);
        }
    }

    const connected = languages.filter((l) => linkedIds.has(l.id));
    const unconnected = languages.filter((l) => !linkedIds.has(l.id));
    const dag = acyclicEdges(connected, [...pairs.values()]);

    const preds = new Map(connected.map((l) => [l.id, []]));
    for (const [u, v] of dag) {
        preds.get(v).push(u);
    }

    const layerOf = new Map();
    function depth(id) {
        if (!layerOf.has(id)) {
            const parents = preds.get(id);
            layerOf.set(id, parents.length ? 1 + Math.max(...parents.map(depth)) : 0);
        }
        return layerOf.get(id);
    }
    connected.forEach((l) => depth(l.id));

    const layers = [];
    for (const l of connected) {
        (layers[layerOf.get(l.id)] ||= []).push(l.id);
    }
    orderLayers(layers, dag);

    // Coordinates: each layer is centered; unconnected languages get a
    // captioned row of their own at the bottom.
    const rows = layers.map((ids) => ({ ids, caption: null }));
    if (unconnected.length) {
        rows.push({
            ids: unconnected.map((l) => l.id),
            caption: connected.length ? "Not linked to any other language" : null
        });
    }

    const widest = Math.max(1, ...rows.map((r) => r.ids.length));
    const innerWidth = widest * NODE_W + (widest - 1) * GAP_X;
    const width = innerWidth + PAD * 2;

    const pos = new Map();
    let y = PAD;
    const captions = [];

    rows.forEach((row, index) => {
        if (row.caption) {
            captions.push({ text: row.caption, y: y + 14 });
            y += LABEL_ROW;
        }

        const rowWidth = row.ids.length * NODE_W + (row.ids.length - 1) * GAP_X;
        const startX = PAD + (innerWidth - rowWidth) / 2;

        row.ids.forEach((id, i) => {
            pos.set(id, { x: startX + i * (NODE_W + GAP_X), y, layer: row.caption ? -1 : index });
        });

        y += NODE_H + GAP_Y;
    });

    const height = y - GAP_Y + PAD;

    return { byId, links, pos, width, height, captions };
}

// ------------------------------------------------------
// Rendering
// ------------------------------------------------------

function bezierPoint(p0, p1, p2, p3, t = 0.5) {
    const u = 1 - t;
    return u ** 3 * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t ** 3 * p3;
}

function edgeGeometry(a, b, dx) {
    const x1 = a.x + NODE_W / 2 + dx;
    const x2 = b.x + NODE_W / 2 + dx;
    let y1;
    let y2;
    let c1;
    let c2;

    if (a.layer < b.layer) {
        // Downward: bottom of the ancestor to top of the descendant.
        y1 = a.y + NODE_H;
        y2 = b.y;
        const c = Math.max(30, (y2 - y1) / 2);
        c1 = y1 + c;
        c2 = y2 - c;
    } else if (a.layer > b.layer) {
        // Upward (a borrowing from a "younger" language): top to bottom.
        y1 = a.y;
        y2 = b.y + NODE_H;
        const c = Math.max(30, (y1 - y2) / 2);
        c1 = y1 - c;
        c2 = y2 + c;
    } else {
        // Same row: arc over the top of the nodes in between.
        y1 = a.y;
        y2 = b.y;
        const lift = 46 + Math.min(70, Math.abs(x2 - x1) * 0.12);
        c1 = y1 - lift;
        c2 = y2 - lift;
    }

    return {
        d: `M${x1.toFixed(1)} ${y1.toFixed(1)} C${x1.toFixed(1)} ${c1.toFixed(1)}, ${x2.toFixed(1)} ${c2.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`,
        pointAt: (t) => ({
            x: bezierPoint(x1, x1, x2, x2, t),
            y: bezierPoint(y1, c1, c2, y2, t)
        })
    };
}

const LABEL_W = 26;
const LABEL_H = 18;

function overlaps(a, b, margin = 3) {
    return !(
        a.x2 + margin < b.x1 ||
        b.x2 + margin < a.x1 ||
        a.y2 + margin < b.y1 ||
        b.y2 + margin < a.y1
    );
}

// Picks a spot along the edge for its count label that is clear of every
// node and of labels placed so far (the middle if nothing fits).
function placeLabel(pointAt, obstacles) {
    const box = (p) => ({
        x1: p.x - LABEL_W / 2,
        x2: p.x + LABEL_W / 2,
        y1: p.y - LABEL_H / 2,
        y2: p.y + LABEL_H / 2
    });

    for (const t of [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.18, 0.82]) {
        const point = pointAt(t);
        const rect = box(point);

        if (!obstacles.some((o) => overlaps(rect, o))) {
            obstacles.push(rect);
            return point;
        }
    }

    const fallback = pointAt(0.5);
    obstacles.push(box(fallback));
    return fallback;
}

function renderFamilySvg(layout) {
    const { byId, links, pos, width, height, captions } = layout;
    const maxN = Math.max(1, ...links.map((l) => l.n));

    // Spread parallel links between the same two languages sideways.
    const groups = new Map();
    for (const link of links) {
        const key = [link.from_id, link.to_id].sort((x, y) => x - y).join("-");
        (groups.get(key) || groups.set(key, []).get(key)).push(link);
    }

    let edges = "";
    let labels = "";

    const obstacles = [...pos.values()].map((p) => ({
        x1: p.x,
        x2: p.x + NODE_W,
        y1: p.y,
        y2: p.y + NODE_H
    }));

    for (const group of groups.values()) {
        group.sort((a, b) => a.kind.localeCompare(b.kind) || a.from_id - b.from_id);

        group.forEach((link, i) => {
            const from = byId.get(link.from_id);
            const to = byId.get(link.to_id);
            const dx = (i - (group.length - 1) / 2) * 14;
            const { d, pointAt } = edgeGeometry(pos.get(link.from_id), pos.get(link.to_id), dx);
            const mid = placeLabel(pointAt, obstacles);
            const style = KIND_STYLE[link.kind];
            const strokeWidth = (1.5 + 3.5 * Math.sqrt(link.n / maxN)).toFixed(2);
            const title = `${from.name} → ${to.name} · ${style.label}: ${link.n} ${link.n === 1 ? "word" : "words"}`;

            edges += `<g class="family-edge">
    <title>${esc(title)}</title>
    <path class="edge-hit" d="${d}"/>
    <path class="edge-line" d="${d}" stroke-width="${strokeWidth}"${
        style.dash ? ` stroke-dasharray="${style.dash}"` : ""
    }${link.kind === "areal" ? "" : ' marker-end="url(#family-arrow)"'}/>
</g>`;

            labels += `<g class="edge-label" transform="translate(${mid.x.toFixed(1)} ${mid.y.toFixed(1)})">
    <rect x="-13" y="-9" width="26" height="18" rx="9"/>
    <text y="4" text-anchor="middle">${link.n}</text>
</g>`;
        });
    }

    let nodes = "";
    for (const [id, p] of pos) {
        const language = byId.get(id);
        const { color, ink } = resolveColor(language.color);
        const sub = `${language.word_count} ${language.word_count === 1 ? "entry" : "entries"}${
            language.is_proto ? " · reconstructed" : ""
        }`;

        nodes += `<a href="${esc(languageUrl(language.slug))}" class="family-node">
    <title>${esc(language.name)}: ${esc(sub)}</title>
    <rect x="${p.x}" y="${p.y}" width="${NODE_W}" height="${NODE_H}" rx="10" fill="${color}"/>
    <text x="${p.x + NODE_W / 2}" y="${p.y + 25}" text-anchor="middle" class="node-name" fill="${ink}">${esc(truncate(language.name, 20))}</text>
    <text x="${p.x + NODE_W / 2}" y="${p.y + 44}" text-anchor="middle" class="node-sub" fill="${ink}">${esc(sub)}</text>
</a>`;
    }

    const captionText = captions
        .map((c) => `<text class="family-caption" x="${PAD}" y="${c.y}">${esc(c.text)}</text>`)
        .join("");

    return `<svg class="family-graph" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Language family graph. A table of the same relationships follows.">
<defs>
    <marker id="family-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="12" markerHeight="12" orient="auto">
        <path d="M0 1 L10 5 L0 9 z" fill="${EDGE_INK}"/>
    </marker>
</defs>
${captionText}
${edges}
${nodes}
${labels}
</svg>`;
}

// The graph, plus the same relationships as a list for accessibility.
function familyView() {
    const languages = stmt.languages.all();

    if (languages.length === 0) {
        return { svg: "", relations: [], empty: true };
    }

    const layout = layoutFamily(languages, stmt.links.all());
    const byId = layout.byId;

    const relations = layout.links
        .map((link) => ({
            from: byId.get(link.from_id),
            to: byId.get(link.to_id),
            kind: link.kind,
            n: link.n
        }))
        .sort(
            (a, b) =>
                a.from.name.localeCompare(b.from.name) ||
                a.to.name.localeCompare(b.to.name) ||
                a.kind.localeCompare(b.kind)
        );

    return {
        svg: renderFamilySvg(layout),
        relations,
        empty: false,
        hasLinks: layout.links.length > 0
    };
}

module.exports = { familyView, layoutFamily, KIND_STYLE };
