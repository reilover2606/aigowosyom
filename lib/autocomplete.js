"use strict";

// State autocomplete: from a line the person has drawn from one border (or
// coast) to another, find the states it could close off.
//
// All the borders between states and all the coastlines make a graph (corners
// joined by edges). The drawn line runs through open ground from one point of
// that graph to another, so it cuts the region it runs through in two: the
// region on its left and the one on its right. Each of those, if it is a
// bounded piece of land that no state already covers, is a state that could be
// made: the line, and then the way back along existing borders and coast.
//
// Pure geometry on plain data, so it can be tested without a database.

const { contains } = require("./polygons");

const SCALE = 1e6;
function onOutline(ring, point, tolerance) {
    for (let i = 0; i < ring.length - 1; i++) {
        const dx = ring[i + 1][0] - ring[i][0];
        const dy = ring[i + 1][1] - ring[i][1];
        const lengthSquared = dx * dx + dy * dy;
        const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((point[0] - ring[i][0]) * dx + (point[1] - ring[i][1]) * dy) / lengthSquared));
        if (Math.hypot(point[0] - ring[i][0] - t * dx, point[1] - ring[i][1] - t * dy) <= tolerance) {
            return true;
        }
    }
    return false;
}

const keyOf = (x, y) => `${Math.round(x * SCALE)},${Math.round(y * SCALE)}`;
const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

function signedArea(points) {
    let sum = 0;
    for (let i = 0; i < points.length; i++) {
        const [ax, ay] = points[i];
        const [bx, by] = points[(i + 1) % points.length];
        sum += ax * by - bx * ay;
    }
    return sum / 2;
}

// Where segment p->q meets segment r->s: { t, u } along each, or null.
function meet(p, q, r, s) {
    const rx = q[0] - p[0];
    const ry = q[1] - p[1];
    const sx = s[0] - r[0];
    const sy = s[1] - r[1];
    const denominator = rx * sy - ry * sx;
    if (Math.abs(denominator) < 1e-12 * Math.hypot(rx, ry) * Math.hypot(sx, sy)) {
        return null; // parallel: handled by the caller where it matters
    }
    const t = ((r[0] - p[0]) * sy - (r[1] - p[1]) * sx) / denominator;
    const u = ((r[0] - p[0]) * ry - (r[1] - p[1]) * rx) / denominator;
    return t >= -1e-9 && t <= 1 + 1e-9 && u >= -1e-9 && u <= 1 + 1e-9 ? { t, u } : null;
}

function distanceToSegment(point, a, b) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSquared));
    const x = a[0] + t * dx;
    const y = a[1] + t * dy;
    return { distance: Math.hypot(point[0] - x, point[1] - y), t, x, y };
}

// input: {
//   vertices: Map(id -> [x, y]), states: [{ id, polygons: [[ring of vertex ids, ...holes]] }],
//   land: [ [ring of [x, y], ...] ]  (a polygon's rings, closed),
//   points: [{ x, y, id? }]  the line drawn, from its first click to its last,
//   eps: how close counts as "on" a border
// }
// Returns { candidates: [{ side, ring: [items], outline: [[x, y]] }], message? }
// where an item is { id } (an existing corner), { x, y, snapEdge: true } (a new
// corner on an existing border) or { x, y } (a new free corner).
function complete(input) {
    const { vertices, states, land, points, eps } = input;
    const fail = (message) => ({ candidates: [], message });

    if (!Array.isArray(points) || points.length < 2) {
        return fail("Draw a line from one border or coast to another first.");
    }

    // ---- the graph of borders and coasts ----
    const nodes = new Map(); // key -> { key, x, y, stateId, nb: Set(key), onStateEdge }
    const edges = new Map(); // pairKey -> { a, b, state }

    const node = (x, y, stateId = null) => {
        const key = keyOf(x, y);
        let n = nodes.get(key);
        if (!n) {
            n = { key, x, y, stateId: null, nb: new Set(), onStateEdge: false };
            nodes.set(key, n);
        }
        if (stateId !== null && n.stateId === null) {
            n.stateId = stateId;
        }
        return n;
    };

    const connect = (a, b, state) => {
        if (a === b) {
            return;
        }
        a.nb.add(b.key);
        b.nb.add(a.key);
        const key = pairKey(a.key, b.key);
        const old = edges.get(key);
        edges.set(key, { a: a.key, b: b.key, state: state || Boolean(old && old.state) });
    };

    // State borders.
    const stateCorners = [];
    for (const state of states) {
        for (const polygon of state.polygons) {
            for (const ring of polygon) {
                ring.forEach((id, i) => {
                    const [x, y] = vertices.get(id);
                    const a = node(x, y, id);
                    stateCorners.push(a);
                    const [bx, by] = vertices.get(ring[(i + 1) % ring.length]);
                    connect(a, node(bx, by, ring[(i + 1) % ring.length]), true);
                });
            }
        }
    }

    // Coasts. A state corner that lies on a stretch of coast is made a corner of the coast too.
    const cornerList = [...new Map(stateCorners.map((n) => [n.key, n])).values()];
    for (const polygon of land) {
        for (const ring of polygon) {
            for (let i = 0; i < ring.length - 1; i++) {
                const a = node(ring[i][0], ring[i][1]);
                const b = node(ring[i + 1][0], ring[i + 1][1]);
                if (a === b) {
                    continue;
                }
                const along = [];
                const minX = Math.min(a.x, b.x) - eps;
                const maxX = Math.max(a.x, b.x) + eps;
                const minY = Math.min(a.y, b.y) - eps;
                const maxY = Math.max(a.y, b.y) + eps;
                for (const corner of cornerList) {
                    if (corner === a || corner === b || corner.x < minX || corner.x > maxX || corner.y < minY || corner.y > maxY) {
                        continue;
                    }
                    const hit = distanceToSegment([corner.x, corner.y], [a.x, a.y], [b.x, b.y]);
                    if (hit.distance <= eps && hit.t > 0 && hit.t < 1) {
                        along.push({ corner, t: hit.t });
                    }
                }
                along.sort((p, q) => p.t - q.t);
                let previous = a;
                for (const { corner } of along) {
                    connect(previous, corner, false);
                    previous = corner;
                }
                connect(previous, b, false);
            }
        }
    }

    // ---- the drawn line ----
    const pts = points.map((p) => [Number(p.x), Number(p.y)]);
    if (!pts.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))) {
        return fail("The line has a bad point in it.");
    }

    const edgeList = () => [...edges.values()].map((e) => ({ e, a: nodes.get(e.a), b: nodes.get(e.b) }));
    const nearestEdge = (point) => {
        let best = null;
        for (const item of edgeList()) {
            const hit = distanceToSegment(point, [item.a.x, item.a.y], [item.b.x, item.b.y]);
            if (hit.distance <= eps && (!best || hit.distance < best.distance)) {
                best = { ...item, ...hit };
            }
        }
        return best;
    };
    const onBorder = (point) => {
        for (const n of nodes.values()) {
            if (Math.abs(n.x - point[0]) <= eps && Math.abs(n.y - point[1]) <= eps) {
                return true;
            }
        }
        return Boolean(nearestEdge(point));
    };

    // Only the stretch of the line that runs through open ground matters: the
    // line may start or end by following borders that are already there.
    const open = [];
    for (let i = 0; i < pts.length - 1; i++) {
        const mid = [(pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2];
        // Along a border: both ends on the borders, and the middle too.
        open.push(!(onBorder(pts[i]) && onBorder(pts[i + 1]) && nearestEdge(mid)));
    }
    const first = open.indexOf(true);
    const last = open.lastIndexOf(true);
    if (first < 0) {
        return fail("That line only follows borders that are already there. Draw across open ground between them.");
    }
    if (open.slice(first, last + 1).some((o) => !o)) {
        return fail("The line runs along a border in the middle. Draw it from border to border across open ground.");
    }
    const line = pts.slice(first, last + 2);
    if (!onBorder(line[0]) || !onBorder(line[line.length - 1])) {
        return fail("Start and end the line on a border or on the coast.");
    }

    // It must not touch the borders or itself except at its two ends.
    for (let i = 0; i < line.length - 1; i++) {
        for (const item of edgeList()) {
            const a = [item.a.x, item.a.y];
            const b = [item.b.x, item.b.y];
            const hit = meet(line[i], line[i + 1], a, b);
            if (hit) {
                const x = line[i][0] + hit.t * (line[i + 1][0] - line[i][0]);
                const y = line[i][1] + hit.t * (line[i + 1][1] - line[i][1]);
                const atStart = i === 0 && Math.hypot(x - line[0][0], y - line[0][1]) <= eps * 2;
                const atEnd = i === line.length - 2 && Math.hypot(x - line[line.length - 1][0], y - line[line.length - 1][1]) <= eps * 2;
                if (!atStart && !atEnd) {
                    return fail("The line crosses or touches a border or the coast before its end. Draw it through open ground.");
                }
            }
            // A stretch along a border (parallel and touching).
            const mid = [(line[i][0] + line[i + 1][0]) / 2, (line[i][1] + line[i + 1][1]) / 2];
            if (distanceToSegment(mid, a, b).distance <= eps) {
                return fail("The line runs along a border before its end. Draw it through open ground.");
            }
        }
        for (let j = i + 2; j < line.length - 1; j++) {
            if (meet(line[i], line[i + 1], line[j], line[j + 1])) {
                return fail("The line crosses itself.");
            }
        }
    }

    // Join the line's two ends into the graph (splitting a border where an end is on one).
    const attach = (point) => {
        for (const n of nodes.values()) {
            if (Math.abs(n.x - point[0]) <= eps && Math.abs(n.y - point[1]) <= eps) {
                return n;
            }
        }
        const hit = nearestEdge(point);
        if (!hit) {
            return null;
        }
        const split = node(hit.x, hit.y);
        if (hit.e.state) {
            split.onStateEdge = true;
        }
        edges.delete(pairKey(hit.a.key, hit.b.key));
        hit.a.nb.delete(hit.b.key);
        hit.b.nb.delete(hit.a.key);
        connect(hit.a, split, hit.e.state);
        connect(split, hit.b, hit.e.state);
        return split;
    };

    const start = attach(line[0]);
    const end = attach(line[line.length - 1]);
    if (!start || !end || start === end) {
        return fail(start === end && start ? "The line starts and ends at the same place." : "Start and end the line on a border or on the coast.");
    }

    // The line's own corners, between its ends.
    const path = [start];
    for (let i = 1; i < line.length - 1; i++) {
        const n = { key: `line${i}`, x: line[i][0], y: line[i][1], stateId: null, nb: new Set(), onStateEdge: false, free: true };
        nodes.set(n.key, n);
        path.push(n);
    }
    path.push(end);
    for (let i = 0; i < path.length - 1; i++) {
        connect(path[i], path[i + 1], false);
    }
    // ---- the regions either side of the line ----
    // Walks round the region on the left of the step from -> to, turning as far left as
    // possible at every corner, until it is back at the first step.
    const face = (from, to) => {
        const ring = [from];
        let previous = from;
        let current = to;
        const limit = edges.size * 2 + 10;

        for (let step = 0; step < limit; step++) {
            ring.push(current);
            const heading = Math.atan2(current.y - previous.y, current.x - previous.x);
            let next = null;
            let best = -Infinity;

            for (const key of current.nb) {
                const candidate = nodes.get(key);
                if (candidate === previous) {
                    continue;
                }
                let turn = Math.atan2(candidate.y - current.y, candidate.x - current.x) - heading;
                while (turn > Math.PI) {
                    turn -= 2 * Math.PI;
                }
                while (turn <= -Math.PI) {
                    turn += 2 * Math.PI;
                }
                if (turn > best) {
                    best = turn;
                    next = candidate;
                }
            }

            next = next || previous; // a dead end: turn back
            previous = current;
            current = next;

            if (previous === from && current === to) {
                ring.pop(); // the walk has come back round: `from` is at the end again
                return ring;
            }
        }
        return null;
    };

    const leftRing = face(path[0], path[1]);
    const rightRing = face(path[path.length - 1], path[path.length - 2]);

    // Already covered by a state, or open sea?
    const stateShapes = states.flatMap((s) => s.polygons.map((polygon) => polygon.map((ring) => {
        const coordinates = ring.map((id) => vertices.get(id));
        coordinates.push(coordinates[0]);
        return coordinates;
    })));
    const insideState = (p) => stateShapes.some((rings) => contains(rings, p));
    const onLand = (p) => land.length === 0 || land.some((rings) => contains(rings, p));

    const probe = (side) => {
        const a = side === "left" ? line[0] : line[line.length - 1];
        const b = side === "left" ? line[1] : line[line.length - 2];
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const length = Math.hypot(dx, dy);
        const offset = Math.min(length * 0.05, eps * 50);
        return [(a[0] + b[0]) / 2 - (dy / length) * offset, (a[1] + b[1]) / 2 + (dx / length) * offset];
    };

    const candidates = [];
    const seen = new Set();
    for (const [side, ring] of [["left", leftRing], ["right", rightRing]]) {
        if (!ring || ring.length < 3) {
            continue;
        }
        const outline = ring.map((n) => [n.x, n.y]);
        if (signedArea(outline) <= 1e-9) {
            continue; // the outside of the map, not a bounded region
        }
        const signature = ring.map((n) => n.key).sort().join(";");
        if (seen.has(signature)) {
            continue;
        }
        seen.add(signature);

        const sample = probe(side);
        if (insideState(sample) || !onLand(sample)) {
            continue;
        }

        // A state somewhere inside the space (not touching its edge) would be overlapped.
        const closed = [...outline, outline[0]];
        let swallows = false;
        for (const [x, y] of vertices.values()) {
            if (contains([closed], [x, y]) && !onOutline(closed, [x, y], eps * 10)) {
                swallows = true;
                break;
            }
        }
        if (swallows) {
            continue;
        }

        candidates.push({
            side,
            area: signedArea(outline),
            outline: [...outline, outline[0]],
            ring: ring.map((n) =>
                n.stateId !== null
                    ? { id: n.stateId }
                    : n.onStateEdge
                      ? { x: n.x, y: n.y, snapEdge: true }
                      : { x: n.x, y: n.y }
            )
        });
    }

    if (candidates.length === 0) {
        return fail("That line doesn't close off any free land: the space it makes is already covered by a state, or is open sea. Run it from a border or the coast across unclaimed land to another.");
    }
    return { candidates };
}

module.exports = { complete };
