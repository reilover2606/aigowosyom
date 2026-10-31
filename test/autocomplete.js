"use strict";

// Checks lib/autocomplete.js on small maps whose answers are easy to see.
// Run with: node test/autocomplete.js

const { complete } = require("../lib/autocomplete");
const assert = require("node:assert");

const square = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const area = (outline) => {
    let sum = 0;
    for (let i = 0; i < outline.length - 1; i++) {
        sum += outline[i][0] * outline[i + 1][1] - outline[i + 1][0] * outline[i][1];
    }
    return Math.abs(sum / 2);
};

// A square island 0..100, and one state, A, down its west side (x 0..30).
const vertices = new Map([[1, [0, 0]], [2, [30, 0]], [3, [30, 100]], [4, [0, 100]]]);
const states = [{ id: 1, polygons: [[[1, 2, 3, 4]]] }];
const land = [[square(0, 0, 100, 100)]];
const eps = 1e-4;
const base = { vertices, states, land, eps };

let passed = 0;
const check = (name, fn) => {
    fn();
    passed++;
    console.log("ok  ", name);
};

check("a line across free land gives the space on each side", () => {
    // From the south coast (60, 0) to the north coast (60, 100): west of it, between A and the line; east of it, the rest.
    const r = complete({ ...base, points: [{ x: 60, y: 0 }, { x: 60, y: 100 }] });
    assert.strictEqual(r.candidates.length, 2, r.message);
    const areas = r.candidates.map((c) => Math.round(area(c.outline))).sort((a, b) => a - b);
    assert.deepStrictEqual(areas, [3000, 4000]); // x 30..60 and x 60..100, each 100 tall
    const west = r.candidates.find((c) => Math.round(area(c.outline)) === 3000);
    assert.ok(west.ring.some((item) => item.id === 2) && west.ring.some((item) => item.id === 3), "the west space uses A's corners (shared border)");
});

check("starting on a state's border (an existing corner) and ending on the coast", () => {
    // From A's corner at (30, 100) across to the south coast at (70, 0): the two spaces are east of A.
    const r = complete({ ...base, points: [{ x: 30, y: 100, id: 3 }, { x: 50, y: 50 }, { x: 70, y: 0 }] });
    assert.strictEqual(r.candidates.length, 2, r.message);
    assert.ok(r.candidates.every((c) => area(c.outline) > 100));
});

check("an end in the middle of a border is made a corner on it", () => {
    const r = complete({ ...base, points: [{ x: 30, y: 50 }, { x: 60, y: 50 }, { x: 100, y: 50 }] });
    assert.strictEqual(r.candidates.length, 2, r.message);
    const hasEdge = r.candidates.every((c) => c.ring.some((item) => item.snapEdge && item.x === 30 && item.y === 50));
    assert.ok(hasEdge, "(30, 50) is a new corner on A's east border");
});

check("a line inside a state, border to border, makes nothing (it is already covered)", () => {
    const r = complete({ ...base, points: [{ x: 0, y: 50 }, { x: 15, y: 40 }, { x: 30, y: 50 }] });
    assert.strictEqual(r.candidates.length, 0);
    assert.ok(r.message);
});

check("a line that crosses a border is refused", () => {
    const r = complete({ ...base, points: [{ x: 0, y: 50 }, { x: 50, y: 80 }, { x: 100, y: 80 }] });
    assert.strictEqual(r.candidates.length, 0);
    assert.match(r.message, /crosses|touches|along/);
});

check("a line that does not start on a border is refused", () => {
    const r = complete({ ...base, points: [{ x: 50, y: 50 }, { x: 60, y: 60 }, { x: 100, y: 60 }] });
    assert.strictEqual(r.candidates.length, 0);
    assert.match(r.message, /Start and end/);
});

check("a line along an existing border has nothing to complete", () => {
    const r = complete({ ...base, points: [{ x: 30, y: 0, id: 2 }, { x: 30, y: 100, id: 3 }] });
    assert.strictEqual(r.candidates.length, 0);
});

check("a line that begins by following a border still completes", () => {
    // Along A's east border from (30, 0) up to (30, 100) then out across to (100, 100)? That runs along the coast too: use a cut instead.
    const r = complete({ ...base, points: [{ x: 30, y: 0, id: 2 }, { x: 30, y: 40 }, { x: 70, y: 70 }, { x: 100, y: 70 }] });
    assert.ok(r.candidates.length >= 1, r.message);
});

check("with no land drawn, a line across a single state's gap still works from border to border", () => {
    // Two states with a gap between them and no coasts: a line from one to the other closes the gap on each side.
    const v = new Map([[1, [0, 0]], [2, [10, 0]], [3, [10, 100]], [4, [0, 100]], [5, [40, 0]], [6, [50, 0]], [7, [50, 100]], [8, [40, 100]]]);
    const r = complete({
        vertices: v,
        states: [{ id: 1, polygons: [[[1, 2, 3, 4]]] }, { id: 2, polygons: [[[5, 6, 7, 8]]] }],
        land: [],
        eps,
        points: [{ x: 10, y: 20, id: undefined }, { x: 25, y: 20 }, { x: 40, y: 20 }]
    });
    // The two sides are both unbounded (the gap is open to the north and south), so nothing is closed off.
    assert.strictEqual(r.candidates.length, 0);
});

check("a space that would surround another state is not offered", () => {
    // A small state B floats in the middle of the east part of the island, touching nothing.
    const v = new Map([...vertices, [11, [70, 40]], [12, [80, 40]], [13, [80, 60]], [14, [70, 60]]]);
    const withB = [...states, { id: 2, polygons: [[[11, 12, 13, 14]]] }];
    // A line from the south coast (60, 0) to the north coast (60, 100): the east side surrounds B, the west side does not.
    const r = complete({ vertices: v, states: withB, land, eps, points: [{ x: 60, y: 0 }, { x: 60, y: 100 }] });
    assert.strictEqual(r.candidates.length, 1, r.message);
    assert.strictEqual(Math.round(area(r.candidates[0].outline)), 3000);
});

console.log(`\n${passed} checks passed`);
