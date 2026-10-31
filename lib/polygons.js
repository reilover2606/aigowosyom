"use strict";

// Polygons for the land: joining two shapes into one, and making neighbouring
// shapes share their corners exactly so that they can be joined.
//
// A shape is a list of rings ([outline, ...holes]); a ring is a list of
// [x, y] points whose last point repeats the first. Coordinates are map units.
//
// union() cuts the outlines of both shapes wherever they cross or overlap,
// keeps the pieces that lie on the outside of the combined shape (a piece along
// which the two shapes meet, from outside, is not on its outside), and links
// those pieces back into rings: outlines, and holes (a bay the join has closed
// off).

const SCALE = 1e6; // points closer than this (1 / SCALE) are the same point

const keyOf = (x, y) => `${Math.round(x * SCALE)},${Math.round(y * SCALE)}`;

function signedArea(ring) {
    let sum = 0;
    for (let i = 0; i < ring.length - 1; i++) {
        sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    }
    return sum / 2;
}

function closeRing(ring) {
    const first = ring[0];
    const last = ring[ring.length - 1];
    return first[0] === last[0] && first[1] === last[1] ? ring : [...ring, [first[0], first[1]]];
}

// Outlines run counter-clockwise and holes clockwise, so the inside of a shape
// is always to the left of its edges.
function oriented(rings) {
    return rings.map((ring, index) => {
        const closed = closeRing(ring);
        const outline = signedArea(closed) > 0;
        return (index === 0) === outline ? closed : [...closed].reverse();
    });
}

// Is the point inside the shape? (Even-odd over all its rings, so holes are outside.)
function contains(rings, point) {
    let inside = false;
    for (const ring of rings) {
        for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i++) {
            const [xi, yi] = ring[i];
            const [xj, yj] = ring[j];
            if (yi > point[1] !== yj > point[1] && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) {
                inside = !inside;
            }
        }
    }
    return inside;
}

// ------------------------------------------------------
// Cutting the outlines
// ------------------------------------------------------

function segmentsOf(rings) {
    const segments = [];
    for (const ring of rings) {
        for (let i = 0; i < ring.length - 1; i++) {
            const [ax, ay] = ring[i];
            const [bx, by] = ring[i + 1];
            if (ax !== bx || ay !== by) {
                segments.push({
                    ax, ay, bx, by,
                    minX: Math.min(ax, bx), maxX: Math.max(ax, bx), minY: Math.min(ay, by), maxY: Math.max(ay, by),
                    cuts: []
                });
            }
        }
    }
    return segments;
}

const EPS = 1e-9;

// Notes, on each of two segments, the points where the other crosses or touches it.
function cut(s, t) {
    const rx = s.bx - s.ax;
    const ry = s.by - s.ay;
    const ux = t.bx - t.ax;
    const uy = t.by - t.ay;
    const denominator = rx * uy - ry * ux;
    const qpx = t.ax - s.ax;
    const qpy = t.ay - s.ay;
    const scale = Math.hypot(rx, ry) * Math.hypot(ux, uy);

    if (Math.abs(denominator) <= EPS * scale) {
        // Parallel. Only a shared stretch matters: each end that lies along the other splits it.
        if (Math.abs(qpx * ry - qpy * rx) > EPS * Math.hypot(rx, ry) * Math.max(1, Math.hypot(qpx, qpy))) {
            return;
        }
        for (const [point, other, along] of [[[t.ax, t.ay], s, true], [[t.bx, t.by], s, true], [[s.ax, s.ay], t, false], [[s.bx, s.by], t, false]]) {
            const target = along ? s : t;
            const dx = target.bx - target.ax;
            const dy = target.by - target.ay;
            const param = ((point[0] - target.ax) * dx + (point[1] - target.ay) * dy) / (dx * dx + dy * dy);
            const offX = target.ax + param * dx - point[0];
            const offY = target.ay + param * dy - point[1];
            if (param > EPS && param < 1 - EPS && Math.hypot(offX, offY) <= 1e-7 * Math.max(1, Math.hypot(dx, dy))) {
                target.cuts.push([point[0], point[1]]);
            }
        }
        return;
    }

    const a = (qpx * uy - qpy * ux) / denominator; // along s
    const b = (qpx * ry - qpy * rx) / denominator; // along t
    if (a < -EPS || a > 1 + EPS || b < -EPS || b > 1 + EPS) {
        return;
    }

    // One shared point; where it is an end of a segment, use that end exactly.
    let point = [s.ax + a * rx, s.ay + a * ry];
    if (a <= EPS) {
        point = [s.ax, s.ay];
    } else if (a >= 1 - EPS) {
        point = [s.bx, s.by];
    } else if (b <= EPS) {
        point = [t.ax, t.ay];
    } else if (b >= 1 - EPS) {
        point = [t.bx, t.by];
    }
    if (a > EPS && a < 1 - EPS) {
        s.cuts.push(point);
    }
    if (b > EPS && b < 1 - EPS) {
        t.cuts.push(point);
    }
}

// The pieces of every segment after cutting: [{ from, to, fromKey, toKey }].
function pieces(segments) {
    const out = [];
    for (const s of segments) {
        const dx = s.bx - s.ax;
        const dy = s.by - s.ay;
        const along = (p) => ((p[0] - s.ax) * dx + (p[1] - s.ay) * dy) / (dx * dx + dy * dy);
        const points = [[s.ax, s.ay], ...s.cuts.sort((p, q) => along(p) - along(q)), [s.bx, s.by]];
        for (let i = 0; i < points.length - 1; i++) {
            const from = points[i];
            const to = points[i + 1];
            const fromKey = keyOf(from[0], from[1]);
            const toKey = keyOf(to[0], to[1]);
            if (fromKey !== toKey) {
                out.push({ from, to, fromKey, toKey });
            }
        }
    }
    return out;
}

// ------------------------------------------------------
// The union
// ------------------------------------------------------

// Joins two shapes. Returns a list of shapes: one if they overlap or share a
// stretch of border, two (each unchanged) if they are apart or only touch at a
// point.
function union(shapeA, shapeB) {
    const A = oriented(shapeA);
    const B = oriented(shapeB);
    const segmentsA = segmentsOf(A);
    const segmentsB = segmentsOf(B);

    for (const s of segmentsA) {
        for (const t of segmentsB) {
            if (s.maxX < t.minX - EPS || t.maxX < s.minX - EPS || s.maxY < t.minY - EPS || t.maxY < s.minY - EPS) {
                continue;
            }
            cut(s, t);
        }
    }

    const piecesA = pieces(segmentsA);
    const piecesB = pieces(segmentsB);
    const undirected = (p) => (p.fromKey < p.toKey ? `${p.fromKey}|${p.toKey}` : `${p.toKey}|${p.fromKey}`);
    const byKeyA = new Map(piecesA.map((p) => [undirected(p), p]));
    const byKeyB = new Map(piecesB.map((p) => [undirected(p), p]));

    const kept = [];
    for (const p of piecesA) {
        const other = byKeyB.get(undirected(p));
        if (other) {
            // The shapes share this stretch: on the outside of both if they lie on the same side of it.
            if (other.fromKey === p.fromKey) {
                kept.push(p);
            }
        } else if (!contains(B, [(p.from[0] + p.to[0]) / 2, (p.from[1] + p.to[1]) / 2])) {
            kept.push(p);
        }
    }
    for (const p of piecesB) {
        if (!byKeyA.has(undirected(p)) && !contains(A, [(p.from[0] + p.to[0]) / 2, (p.from[1] + p.to[1]) / 2])) {
            kept.push(p);
        }
    }

    // Link the pieces into rings. Where several leave a point, take the leftmost turn,
    // which keeps shapes that only touch at a point apart.
    const leaving = new Map();
    for (const p of kept) {
        if (!leaving.has(p.fromKey)) {
            leaving.set(p.fromKey, []);
        }
        leaving.get(p.fromKey).push(p);
    }

    const used = new Set();
    const rings = [];
    for (const start of kept) {
        if (used.has(start)) {
            continue;
        }
        const ring = [start.from];
        let piece = start;
        let broken = false;

        for (let guard = 0; guard <= kept.length; guard++) {
            used.add(piece);
            ring.push(piece.to);
            if (piece.toKey === start.fromKey) {
                break;
            }
            const options = (leaving.get(piece.toKey) || []).filter((p) => !used.has(p));
            if (options.length === 0) {
                broken = true;
                break;
            }
            const heading = Math.atan2(piece.to[1] - piece.from[1], piece.to[0] - piece.from[0]);
            let best = options[0];
            let bestTurn = -Infinity;
            for (const option of options) {
                let turn = Math.atan2(option.to[1] - option.from[1], option.to[0] - option.from[0]) - heading;
                while (turn > Math.PI) {
                    turn -= 2 * Math.PI;
                }
                while (turn <= -Math.PI) {
                    turn += 2 * Math.PI;
                }
                if (turn > bestTurn) {
                    best = option;
                    bestTurn = turn;
                }
            }
            piece = best;
        }

        if (!broken && ring.length >= 4) {
            rings.push(ring);
        }
    }

    // Outlines run counter-clockwise, holes clockwise; each hole belongs to the smallest outline round it.
    const outlines = rings.filter((r) => signedArea(r) > 1e-9).map((r) => ({ ring: r, area: signedArea(r), holes: [] }));
    for (const hole of rings.filter((r) => signedArea(r) < -1e-9)) {
        let home = null;
        for (const outline of outlines) {
            if ((!home || outline.area < home.area) && contains([outline.ring], hole[0])) {
                home = outline;
            }
        }
        if (home) {
            home.holes.push(hole);
        }
    }

    return outlines.map((o) => [o.ring, ...o.holes]);
}

// ------------------------------------------------------
// Making neighbours share corners
// ------------------------------------------------------

const copyRings = (rings) => rings.map((ring) => ring.map((p) => [p[0], p[1]]));

function nearestOnEdges(rings, point, eps) {
    let best = null;
    for (const ring of rings) {
        for (let i = 0; i < ring.length - 1; i++) {
            const [ax, ay] = ring[i];
            const [bx, by] = ring[i + 1];
            if (point[0] < Math.min(ax, bx) - eps || point[0] > Math.max(ax, bx) + eps || point[1] < Math.min(ay, by) - eps || point[1] > Math.max(ay, by) + eps) {
                continue;
            }
            const dx = bx - ax;
            const dy = by - ay;
            const lengthSquared = dx * dx + dy * dy;
            const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((point[0] - ax) * dx + (point[1] - ay) * dy) / lengthSquared));
            const x = ax + t * dx;
            const y = ay + t * dy;
            const distance = Math.hypot(point[0] - x, point[1] - y);
            if (distance <= eps && (!best || distance < best.distance)) {
                best = { ring, index: i, t, x, y, distance };
            }
        }
    }
    return best;
}

// Drawn corners that are (to within `eps`) on a neighbour's corner or border are
// put exactly on it, and the neighbour gets a corner there (and the other way
// round), so two shapes that meet along a border have the same corners along it.
// Returns copies: { shape, neighbours }.
function weld(shape, neighbours, eps) {
    const subject = copyRings(shape);
    const others = neighbours.map(copyRings);

    // The subject's corners onto the neighbours.
    for (const ring of subject) {
        for (let i = 0; i < ring.length - 1; i++) {
            const point = ring[i];
            let moved = false;

            for (const other of others) {
                for (const otherRing of other) {
                    for (const q of otherRing) {
                        if (Math.abs(q[0] - point[0]) <= eps && Math.abs(q[1] - point[1]) <= eps) {
                            point[0] = q[0];
                            point[1] = q[1];
                            moved = true;
                            break;
                        }
                    }
                    if (moved) {
                        break;
                    }
                }
                if (moved) {
                    break;
                }
            }
            if (moved) {
                continue;
            }

            for (const other of others) {
                const hit = nearestOnEdges(other, point, eps);
                if (hit) {
                    point[0] = hit.x;
                    point[1] = hit.y;
                    hit.ring.splice(hit.index + 1, 0, [hit.x, hit.y]);
                    break;
                }
            }
        }
        ring[ring.length - 1] = [ring[0][0], ring[0][1]];
    }

    // The neighbours' corners that lie along the subject's borders.
    for (const other of others) {
        for (const otherRing of other) {
            for (let k = 0; k < otherRing.length - 1; k++) {
                const hit = nearestOnEdges(subject, otherRing[k], eps);
                if (hit && (hit.t > 0 && hit.t < 1) && Math.hypot(hit.x - hit.ring[hit.index][0], hit.y - hit.ring[hit.index][1]) > 0 && Math.hypot(hit.x - hit.ring[hit.index + 1][0], hit.y - hit.ring[hit.index + 1][1]) > 0) {
                    hit.ring.splice(hit.index + 1, 0, [otherRing[k][0], otherRing[k][1]]);
                }
            }
        }
    }

    return { shape: subject, neighbours: others };
}

module.exports = { union, weld, contains, signedArea };
