"use strict";

// Sound correspondences between a language and one that descends from it (through the
// "inherited" links between words). Each pair of linked words is turned into its sounds (from the
// languages' orthographies, or letter by letter where a language has none), the two sequences are
// lined up, and every aligned pair is counted: ancestor sound -> descendant sound, with "∅" for a
// sound that was lost (nothing on the descendant's side) or gained (nothing on the ancestor's).
//
// A sound that always becomes the same sound is a regular change; one with several outcomes is a
// split, usually conditioned by the sounds around it, and the examples show where to look.

const { db } = require("./db");
const { similarity } = require("./ipa");
const { transcribe, hasOrthography, compile } = require("./phonology");

const GAP = "∅";

const stmt = {
    pairs: db.prepare(`
        SELECT a.language_id AS from_id, w.language_id AS to_id, COUNT(*) AS links
        FROM word_ancestry wa
        JOIN words w ON w.id = wa.word_id
        JOIN words a ON a.id = wa.ancestor_id
        WHERE wa.kind = 'inherited' AND a.language_id != w.language_id
        GROUP BY a.language_id, w.language_id`),
    links: db.prepare(`
        SELECT w.headword AS to_word, a.headword AS from_word
        FROM word_ancestry wa
        JOIN words w ON w.id = wa.word_id
        JOIN words a ON a.id = wa.ancestor_id
        WHERE wa.kind = 'inherited' AND a.language_id = ? AND w.language_id = ?`)
};

// The language pairs that have inherited words, with how many.
function relatedPairs() {
    return stmt.pairs.all();
}

// A headword's sounds: from the orthography when the language has one (null if some letter is
// not covered), else its letters.
function soundsOf(languageId, headword, usesOrthography) {
    if (usesOrthography) {
        const result = transcribe(languageId, headword);
        return result.complete ? result.phonemes : null;
    }
    const letters = headword.normalize("NFC").toLowerCase().replace(/^\*/, "").match(/\p{L}\p{M}*/gu);
    return letters && letters.length ? letters : null;
}

// Lines up two sound sequences (Needleman-Wunsch): matching or alike sounds score well, a gap costs.
function align(a, b) {
    const GAP_COST = -0.8;
    const rows = a.length + 1;
    const cols = b.length + 1;
    const score = Array.from({ length: rows }, () => new Float64Array(cols));

    for (let i = 1; i < rows; i++) {
        score[i][0] = i * GAP_COST;
    }
    for (let j = 1; j < cols; j++) {
        score[0][j] = j * GAP_COST;
    }
    for (let i = 1; i < rows; i++) {
        for (let j = 1; j < cols; j++) {
            score[i][j] = Math.max(
                score[i - 1][j - 1] + similarity(a[i - 1], b[j - 1]),
                score[i - 1][j] + GAP_COST,
                score[i][j - 1] + GAP_COST
            );
        }
    }

    const pairs = [];
    let i = a.length;
    let j = b.length;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && Math.abs(score[i][j] - (score[i - 1][j - 1] + similarity(a[i - 1], b[j - 1]))) < 1e-9) {
            pairs.push([a[i - 1], b[j - 1]]);
            i--;
            j--;
        } else if (i > 0 && Math.abs(score[i][j] - (score[i - 1][j] + GAP_COST)) < 1e-9) {
            pairs.push([a[i - 1], GAP]);
            i--;
        } else {
            pairs.push([GAP, b[j - 1]]);
            j--;
        }
    }
    return pairs.reverse();
}

// { from, to: ids } -> the counted correspondences.
function correspond(fromId, toId, { examplesPer = 4 } = {}) {
    const fromOrthography = hasOrthography(fromId);
    const toOrthography = hasOrthography(toId);
    const kinds = new Map([...compile(fromId).kinds, ...compile(toId).kinds]);

    const flows = new Map(); // "a\u0000d" -> { from, to, count, examples }
    const seen = new Set();
    let used = 0;
    let skipped = 0;

    for (const link of stmt.links.all(fromId, toId)) {
        const key = `${link.from_word}\u0000${link.to_word}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);

        const a = soundsOf(fromId, link.from_word, fromOrthography);
        const b = soundsOf(toId, link.to_word, toOrthography);
        if (!a || !b) {
            skipped++;
            continue;
        }
        used++;

        for (const [x, y] of align(a, b)) {
            const id = `${x}\u0000${y}`;
            let flow = flows.get(id);
            if (!flow) {
                flow = { from: x, to: y, count: 0, examples: [] };
                flows.set(id, flow);
            }
            flow.count++;
            if (flow.examples.length < examplesPer && !flow.examples.some((e) => e.from === link.from_word && e.to === link.to_word)) {
                flow.examples.push({ from: link.from_word, to: link.to_word });
            }
        }
    }

    const list = [...flows.values()].sort((p, q) => q.count - p.count || p.from.localeCompare(q.from) || p.to.localeCompare(q.to));

    const totals = (side) => {
        const map = new Map();
        for (const f of list) {
            map.set(f[side], (map.get(f[side]) || 0) + f.count);
        }
        return map;
    };

    return {
        fromOrthography,
        toOrthography,
        used,
        skipped,
        flows: list,
        fromTotals: totals("from"),
        toTotals: totals("to"),
        kindOf: (symbol) => kinds.get(symbol) || null
    };
}

// ---- the diagram: ancestor sounds on the left, descendant sounds on the right ----

const esc = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function renderFlow(result, { fromName, toName }) {
    const { flows, fromTotals, toTotals, kindOf } = result;
    if (flows.length === 0) {
        return "";
    }

    const width = 760;
    const nodeW = 34;
    const left = 130;
    const right = width - 130 - nodeW;
    const gap = 7;
    const top = 34;

    const leftSymbols = [...fromTotals.keys()];
    const rightSymbols = [...toTotals.keys()];

    // Biggest first, with the gap marker last; the right-hand side is then ordered by where its
    // flows come from, so ribbons cross as little as they can.
    const bySize = (totals) => (a, b) => (a === GAP) - (b === GAP) || totals.get(b) - totals.get(a) || a.localeCompare(b);
    leftSymbols.sort(bySize(fromTotals));

    const leftRank = new Map(leftSymbols.map((s, i) => [s, i]));
    const pull = new Map();
    for (const f of flows) {
        const entry = pull.get(f.to) || { sum: 0, weight: 0 };
        entry.sum += (f.from === GAP ? leftSymbols.length : leftRank.get(f.from)) * f.count;
        entry.weight += f.count;
        pull.set(f.to, entry);
    }
    rightSymbols.sort((a, b) => (a === GAP) - (b === GAP) || pull.get(a).sum / pull.get(a).weight - pull.get(b).sum / pull.get(b).weight || a.localeCompare(b));

    const total = Math.max(
        [...fromTotals.values()].reduce((s, n) => s + n, 0),
        [...toTotals.values()].reduce((s, n) => s + n, 0)
    );
    const available = Math.max(300, Math.min(900, Math.max(leftSymbols.length, rightSymbols.length) * 26));
    const scale = (available - gap * Math.max(leftSymbols.length, rightSymbols.length)) / total;

    const place = (symbols, totals) => {
        const at = new Map();
        let y = top;
        for (const s of symbols) {
            const h = Math.max(2, totals.get(s) * scale);
            at.set(s, { y, h, used: 0 });
            y += h + gap;
        }
        return { at, bottom: y };
    };
    const L = place(leftSymbols, fromTotals);
    const R = place(rightSymbols, toTotals);
    const height = Math.max(L.bottom, R.bottom) + 10;

    const ribbons = [];
    // Stack each node's ribbons in a stable order: by the other end's position.
    const ordered = [...flows].sort((p, q) => {
        const rp = rightSymbols.indexOf(p.to);
        const rq = rightSymbols.indexOf(q.to);
        return rp - rq || leftSymbols.indexOf(p.from) - leftSymbols.indexOf(q.from);
    });
    for (const f of ordered) {
        const a = L.at.get(f.from);
        const b = R.at.get(f.to);
        const h = Math.max(f.count * scale, 0.8);
        const y0 = a.y + a.used;
        const y1 = b.y + b.used;
        a.used += f.count * scale;
        b.used += f.count * scale;
        const x0 = left + nodeW;
        const x1 = right;
        const mid = (x0 + x1) / 2;
        const kind = f.from === GAP ? "gain" : f.to === GAP ? "loss" : f.from === f.to ? "same" : "change";
        const title = `${f.from} → ${f.to}: ${f.count} time${f.count === 1 ? "" : "s"}${f.examples.length ? ` (e.g. ${f.examples.map((e) => `${e.from} → ${e.to}`).join(", ")})` : ""}`;
        ribbons.push(
            `<path class="flow flow-${kind}" d="M${x0},${y0} C${mid},${y0} ${mid},${y1} ${x1},${y1} L${x1},${y1 + h} C${mid},${y1 + h} ${mid},${y0 + h} ${x0},${y0 + h} Z"><title>${esc(title)}</title></path>`
        );
    }

    const node = (symbol, geometry, x, side) => {
        const cls = symbol === GAP ? "gap" : kindOf(symbol) || "unknown";
        const labelX = side === "left" ? x - 8 : x + nodeW + 8;
        const anchor = side === "left" ? "end" : "start";
        return `<g class="flow-node flow-${cls}"><rect x="${x}" y="${geometry.y}" width="${nodeW}" height="${Math.max(geometry.h, 2)}" rx="2"/>` +
            `<text class="flow-label conlang" x="${labelX}" y="${geometry.y + Math.max(geometry.h, 2) / 2}" text-anchor="${anchor}" dominant-baseline="middle">${esc(symbol)}</text></g>`;
    };

    return `<svg class="flow-diagram" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(`Sounds of ${fromName} and the sounds they became in ${toName}`)}">
    <text class="flow-heading" x="${left + nodeW}" y="16" text-anchor="end">${esc(fromName)}</text>
    <text class="flow-heading" x="${right}" y="16">${esc(toName)}</text>
    ${ribbons.join("\n    ")}
    ${leftSymbols.map((s) => node(s, L.at.get(s), left, "left")).join("\n    ")}
    ${rightSymbols.map((s) => node(s, R.at.get(s), right, "right")).join("\n    ")}
</svg>`;
}

module.exports = { relatedPairs, correspond, renderFlow, align, GAP };
