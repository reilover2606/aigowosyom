"use strict";

// Elevation: land is divided into square cells (a mile on a side, by default)
// and each land cell has an elevation in feet.
//
// The grid covers the map from its bottom-left corner (row 0 is the bottom, as
// y runs up). A cell's value is feet above sea level, or NO_LAND where the cell
// isn't land. The grid is kept in step with the land shapes: when land is drawn
// or reshaped, cells that become land get a "plains" elevation (rising inland
// from the coast and levelling off, with small random fluctuations), cells that
// stop being land are cleared, and hand-edited cells elsewhere are left alone.

const zlib = require("node:zlib");
const { db } = require("./db");
const { HttpError } = require("./http");

const NO_LAND = -32768;
const MAX_FEET = 29500;
const MAX_CELLS = 2500000; // bigger maps get bigger cells

const PLAINS = { plateau: 900, rise: 70, ruggedness: 70 }; // feet, miles, feet

const stmt = {
    map: db.prepare("SELECT * FROM maps WHERE id = ?"),
    land: db.prepare("SELECT geometry FROM map_features WHERE map_id = ? AND kind = 'land'"),
    get: db.prepare("SELECT * FROM map_elevation WHERE map_id = ?"),
    save: db.prepare(`
        INSERT INTO map_elevation (map_id, cols, rows, cell, seed, data, updated_at)
        VALUES (@map_id, @cols, @rows, @cell, @seed, @data, @updated_at)
        ON CONFLICT (map_id) DO UPDATE SET cols = @cols, rows = @rows, cell = @cell, seed = @seed,
                                           data = @data, updated_at = @updated_at
    `),
    remove: db.prepare("DELETE FROM map_elevation WHERE map_id = ?"),
    meta: db.prepare("SELECT cols, rows, cell, updated_at FROM map_elevation WHERE map_id = ?")
};

// ------------------------------------------------------
// Reading and writing the grid
// ------------------------------------------------------

function load(mapId) {
    const row = stmt.get.get(mapId);
    if (!row) {
        return null;
    }
    const raw = zlib.inflateSync(row.data);
    const data = new Int16Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));
    return { cols: row.cols, rows: row.rows, cell: row.cell, seed: row.seed, updated_at: row.updated_at, data };
}

function store(mapId, grid) {
    const bytes = Buffer.from(grid.data.buffer, grid.data.byteOffset, grid.data.byteLength);
    stmt.save.run({
        map_id: mapId,
        cols: grid.cols,
        rows: grid.rows,
        cell: grid.cell,
        seed: grid.seed,
        data: zlib.deflateSync(bytes, { level: 6 }),
        updated_at: Date.now()
    });
}

// What the editor and viewer need to know about a map's elevation.
function meta(mapId, milesPerUnit) {
    const row = stmt.meta.get(mapId);
    return row ? { ...row, cell_miles: row.cell * milesPerUnit } : null;
}

// The grid as bytes (signed 16-bit, little endian), for sending.
function bytesOf(mapId) {
    const grid = load(mapId);
    return grid ? Buffer.from(grid.data.buffer, grid.data.byteOffset, grid.data.byteLength) : null;
}

// ------------------------------------------------------
// Which cells are land
// ------------------------------------------------------

// Fills the cells whose centres lie inside the land shapes (even-odd, so
// holes work; separate shapes are joined).
function rasterize(polygons, cols, rows, cell) {
    const mask = new Uint8Array(cols * rows);

    for (const polygon of polygons) {
        const edges = [];
        for (const ring of polygon) {
            for (let i = 0; i < ring.length - 1; i++) {
                const [x0, y0] = ring[i];
                const [x1, y1] = ring[i + 1];
                if (y0 !== y1) {
                    edges.push(y0 < y1 ? [x0, y0, x1, y1] : [x1, y1, x0, y0]);
                }
            }
        }
        if (edges.length === 0) {
            continue;
        }

        let low = Infinity;
        let high = -Infinity;
        for (const e of edges) {
            low = Math.min(low, e[1]);
            high = Math.max(high, e[3]);
        }

        const first = Math.max(0, Math.ceil(low / cell - 0.5));
        const last = Math.min(rows - 1, Math.floor(high / cell - 0.5));

        for (let row = first; row <= last; row++) {
            const y = (row + 0.5) * cell;
            const crossings = [];
            for (const [x0, y0, x1, y1] of edges) {
                if (y0 <= y && y < y1) {
                    crossings.push(x0 + ((y - y0) * (x1 - x0)) / (y1 - y0));
                }
            }
            crossings.sort((a, b) => a - b);

            for (let k = 0; k + 1 < crossings.length; k += 2) {
                const from = Math.max(0, Math.ceil(crossings[k] / cell - 0.5));
                const to = Math.min(cols - 1, Math.floor(crossings[k + 1] / cell - 0.5));
                for (let col = from; col <= to; col++) {
                    mask[row * cols + col] = 1;
                }
            }
        }
    }

    return mask;
}

// Distance (in cells) from each land cell to the nearest cell that isn't land,
// by the exact squared-distance transform. Land touching the edge of the map
// isn't coast: where there is no sea at all the distances are huge.
function distanceToSea(mask, cols, rows) {
    const INF = 1e12;
    const grid = new Float64Array(cols * rows);
    for (let i = 0; i < grid.length; i++) {
        grid[i] = mask[i] ? INF : 0;
    }

    const size = Math.max(cols, rows);
    const f = new Float64Array(size);
    const d = new Float64Array(size);
    const v = new Int32Array(size);
    const z = new Float64Array(size + 1);

    const transform = (n) => {
        let k = 0;
        v[0] = 0;
        z[0] = -INF;
        z[1] = INF;
        for (let q = 1; q < n; q++) {
            let s;
            for (;;) {
                const p = v[k];
                s = (f[q] + q * q - (f[p] + p * p)) / (2 * q - 2 * p);
                if (s <= z[k] && k > 0) {
                    k--;
                } else {
                    break;
                }
            }
            k++;
            v[k] = q;
            z[k] = s;
            z[k + 1] = INF;
        }
        k = 0;
        for (let q = 0; q < n; q++) {
            while (z[k + 1] < q) {
                k++;
            }
            d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
        }
    };

    for (let col = 0; col < cols; col++) {
        for (let row = 0; row < rows; row++) {
            f[row] = grid[row * cols + col];
        }
        transform(rows);
        for (let row = 0; row < rows; row++) {
            grid[row * cols + col] = d[row];
        }
    }
    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            f[col] = grid[row * cols + col];
        }
        transform(cols);
        for (let col = 0; col < cols; col++) {
            grid[row * cols + col] = Math.sqrt(d[col]);
        }
    }

    return grid;
}

// ------------------------------------------------------
// Plains
// ------------------------------------------------------

function hash(i, j, seed) {
    let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(seed, 144665)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function valueNoise(x, y, seed) {
    const i = Math.floor(x);
    const j = Math.floor(y);
    const fx = x - i;
    const fy = y - j;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const a = hash(i, j, seed);
    const b = hash(i + 1, j, seed);
    const c = hash(i, j + 1, seed);
    const e = hash(i + 1, j + 1, seed);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + e) * sx * sy;
}

// Four octaves, 0..1.
function fbm(x, y, seed) {
    let total = 0;
    let amplitude = 0.5;
    let sum = 0;
    for (let octave = 0; octave < 4; octave++) {
        total += amplitude * valueNoise(x, y, seed + octave * 101);
        sum += amplitude;
        x *= 2;
        y *= 2;
        amplitude /= 2;
    }
    return total / sum;
}

// A plains landscape: from the sea the land rises (quickly at first, then ever
// more slowly) to a plateau, with gentle undulations that grow with distance
// from the coast.
function plainsFeet(distanceMiles, col, row, cellMiles, seed, params) {
    const base = params.plateau * (1 - Math.exp(-distanceMiles / params.rise));
    const undulation = (fbm((col * cellMiles) / 55, (row * cellMiles) / 55, seed) - 0.5) * 2;
    const ruggedness = params.ruggedness * Math.min(1, distanceMiles / 15);
    return Math.max(0, Math.min(MAX_FEET, Math.round(base + undulation * ruggedness)));
}

// ------------------------------------------------------
// Keeping the grid in step with the land
// ------------------------------------------------------

// The side of a cell in map units: a mile, or more on a map so big that a
// mile grid would be too large.
function chooseCell(map) {
    const cells = map.width * map.miles_per_unit * (map.height * map.miles_per_unit);
    const miles = Math.max(1, Math.ceil(Math.sqrt(cells / MAX_CELLS)));
    return miles / map.miles_per_unit;
}

function landPolygons(mapId) {
    return stmt.land.all(mapId).map((row) => JSON.parse(row.geometry).coordinates);
}

// Brings the map's grid up to date with its land: creates it when there is
// land and no grid, resizes it with the map, and fills in plains where land is
// new. `params` (plateau, rise, ruggedness) and `reset` (start every land cell
// again) are for regenerating.
function sync(mapId, { reset = false, params = PLAINS } = {}) {
    const map = stmt.map.get(mapId);
    if (!map) {
        return;
    }

    const polygons = landPolygons(mapId);
    let grid = load(mapId);

    if (polygons.length === 0) {
        if (grid) {
            stmt.remove.run(mapId);
        }
        return;
    }

    const cell = reset || !grid ? chooseCell(map) : grid.cell;
    const cols = Math.max(1, Math.ceil(map.width / cell));
    const rows = Math.max(1, Math.ceil(map.height / cell));

    // Resize with the map (the corner at 0, 0 stays put).
    let data;
    if (grid && !reset && grid.cols === cols && grid.rows === rows) {
        data = grid.data;
    } else {
        data = new Int16Array(cols * rows).fill(NO_LAND);
        if (grid && !reset) {
            for (let row = 0; row < Math.min(rows, grid.rows); row++) {
                for (let col = 0; col < Math.min(cols, grid.cols); col++) {
                    data[row * cols + col] = grid.data[row * grid.cols + col];
                }
            }
        }
    }

    const mask = rasterize(polygons, cols, rows, cell);
    const cellMiles = cell * map.miles_per_unit;
    const seed = grid ? grid.seed : map.id * 7919 + 13;
    let distance = null;

    for (let i = 0; i < data.length; i++) {
        if (!mask[i]) {
            data[i] = NO_LAND;
        } else if (data[i] === NO_LAND) {
            distance = distance || distanceToSea(mask, cols, rows);
            const row = Math.floor(i / cols);
            data[i] = plainsFeet(distance[i] * cellMiles, i - row * cols, row, cellMiles, seed, params);
        }
    }

    store(mapId, { cols, rows, cell, seed, data });
}

// ------------------------------------------------------
// Edits
// ------------------------------------------------------

// Writes a rectangle of heights (signed 16-bit little endian, row by row from
// the bottom) into the grid. Cells that aren't land stay as they are.
function patch(mapId, x, y, w, h, bytes) {
    const grid = load(mapId);
    if (!grid) {
        throw new HttpError(404, "This map has no elevation yet.");
    }
    const ints = [x, y, w, h];
    if (!ints.every(Number.isSafeInteger) || w < 1 || h < 1 || x < 0 || y < 0 || x + w > grid.cols || y + h > grid.rows) {
        throw new HttpError(400, "That area is outside the elevation grid");
    }
    if (bytes.length !== w * h * 2) {
        throw new HttpError(400, "The heights don't match the size of the area");
    }

    const values = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
    for (let row = 0; row < h; row++) {
        for (let col = 0; col < w; col++) {
            const at = (y + row) * grid.cols + x + col;
            if (grid.data[at] !== NO_LAND) {
                grid.data[at] = Math.max(0, Math.min(MAX_FEET, values[row * w + col]));
            }
        }
    }
    store(mapId, grid);
}

module.exports = { NO_LAND, MAX_FEET, PLAINS, meta, bytesOf, sync, patch, rasterize, distanceToSea, plainsFeet };
