"use strict";

// Sound correspondences between a language and one that descends from it (through the "inherited"
// links between words).
//
// Each pair of linked words is turned into its sounds (from the languages' spellings, or letter by
// letter where a language has none) and the two sequences are lined up. The lining-up allows what
// real changes do: a sound can stay, change, be lost or appear, *two sounds can become one*
// (m + p > b, a coalescence) and *one can become two* (a > ia, breaking). Each column of the alignment
// is then looked at in its surroundings:
//
//  * which process(es) it is (voicing, lenition, elision, assimilation, coalescence, ...) from the
//    features that differ and the neighbouring sounds (lib/soundchange.js);
//  * for a change of several features at once, a plausible route of one-step changes through sounds
//    that exist (the intermediate forms it may have passed through);
//  * for an ancestor sound with more than one outcome, which neighbouring sound (or class of sounds)
//    best tells the outcomes apart ("k > tʃ before front vowels").
//
// This is a set of suggestions to think with, computed from the words entered; it knows nothing
// about the history of the languages beyond that.

const { db } = require("./db");
const { similarity, featuresOf } = require("./ipa");
const { transcribe, hasOrthography, compile, CLASSES } = require("./phonology");
const soundchange = require("./soundchange");

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

// A headword's sounds (stress marks left out): from the orthography when the language has one (null
// if some letter is not covered), else its letters.
function soundsOf(languageId, headword, usesOrthography) {
    if (usesOrthography) {
        const result = transcribe(languageId, headword);
        if (!result.complete) {
            return null;
        }
        const kinds = compile(languageId).kinds;
        return result.phonemes.filter((p) => kinds.get(p) !== "stress");
    }
    const letters = headword.normalize("NFC").toLowerCase().replace(/^\*/, "").match(/\p{L}\p{M}*/gu);
    return letters && letters.length ? letters : null;
}

// ---- lining up ----

const GAP_COST = -0.8;
const FUSION_COST = 0.25;

const CORE = { consonant: ["place", "manner", "voiced"], vowel: ["height", "backness", "rounded"] };

// How well `target` is explained as the blend of two neighbouring sounds `a` and `b` (two sounds
// becoming one, or one becoming two): each feature of the target should come from one of them, and each
// of them has to give something the other doesn't, or it is just a sound lost beside a changed one.
function blend(target, a, b) {
    const fa = featuresOf(a);
    const fb = featuresOf(b);
    const ft = featuresOf(target);
    if (!fa || !fb || !ft || fa.kind !== fb.kind || fa.kind !== ft.kind || !CORE[ft.kind]) {
        return -Infinity;
    }
    if (a === b) {
        // A doubled sound that becomes single (degemination), or the reverse.
        return a === target ? 0.4 : -Infinity;
    }
    const keys = CORE[ft.kind];
    let matches = 0;
    let onlyA = 0;
    let onlyB = 0;
    for (const k of keys) {
        const fromA = ft[k] === fa[k];
        const fromB = ft[k] === fb[k];
        if (fromA || fromB) {
            matches++;
        }
        if (fromA && !fromB) {
            onlyA++;
        }
        if (fromB && !fromA) {
            onlyB++;
        }
    }
    if (onlyA === 0 || onlyB === 0) {
        return -Infinity; // one of them contributes nothing: a loss plus a substitution explains it as well
    }
    return -0.5 + (matches / keys.length) * 1.4 - FUSION_COST;
}

// Lines up two sound sequences (Needleman-Wunsch, with two-for-one and one-for-two steps). Returns
// columns { from: [sounds], to: [sounds] } with 0, 1 or 2 sounds on a side.
function align(a, b) {
    const rows = a.length + 1;
    const cols = b.length + 1;
    const score = Array.from({ length: rows }, () => new Float64Array(cols).fill(-Infinity));
    const how = Array.from({ length: rows }, () => new Array(cols).fill(null));
    score[0][0] = 0;

    const consider = (i, j, value, op) => {
        if (value > score[i][j] + 1e-12) {
            score[i][j] = value;
            how[i][j] = op;
        }
    };

    for (let i = 0; i < rows; i++) {
        for (let j = 0; j < cols; j++) {
            if (i === 0 && j === 0) {
                continue;
            }
            // Earlier lines win ties.
            if (i > 0 && j > 0) {
                consider(i, j, score[i - 1][j - 1] + similarity(a[i - 1], b[j - 1]), "one-one");
            }
            if (i > 1 && j > 0) {
                consider(i, j, score[i - 2][j - 1] + blend(b[j - 1], a[i - 2], a[i - 1]), "two-one");
            }
            if (i > 0 && j > 1) {
                consider(i, j, score[i - 1][j - 2] + blend(a[i - 1], b[j - 2], b[j - 1]), "one-two");
            }
            if (i > 0) {
                consider(i, j, score[i - 1][j] + GAP_COST, "delete");
            }
            if (j > 0) {
                consider(i, j, score[i][j - 1] + GAP_COST, "insert");
            }
        }
    }

    const columns = [];
    let i = a.length;
    let j = b.length;
    while (i > 0 || j > 0) {
        const op = how[i][j];
        if (op === "one-one") {
            columns.push({ from: [a[i - 1]], to: [b[j - 1]] });
            i--;
            j--;
        } else if (op === "two-one") {
            columns.push({ from: [a[i - 2], a[i - 1]], to: [b[j - 1]] });
            i -= 2;
            j--;
        } else if (op === "one-two") {
            columns.push({ from: [a[i - 1]], to: [b[j - 2], b[j - 1]] });
            i--;
            j -= 2;
        } else if (op === "delete") {
            columns.push({ from: [a[i - 1]], to: [] });
            i--;
        } else {
            columns.push({ from: [], to: [b[j - 1]] });
            j--;
        }
    }
    return columns.reverse();
}

const labelOf = (parts) => (parts.length ? parts.join("") : GAP);

// ---- the whole comparison ----

function correspond(fromId, toId, { examplesPer = 4 } = {}) {
    const fromOrthography = hasOrthography(fromId);
    const toOrthography = hasOrthography(toId);
    const fromData = compile(fromId);
    const toData = compile(toId);
    const kinds = new Map([...fromData.kinds, ...toData.kinds]);
    const known = new Map([...fromData.byIpa, ...toData.byIpa]);
    const inventory = new Set([...fromData.symbols, ...toData.symbols]);

    const flows = new Map(); // "from\u0000to" -> flow
    const alignments = []; // each linked pair as aligned columns (for lib/lingrex.js)
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

        const columns = align(a, b);
        alignments.push({ from: link.from_word, to: link.to_word, columns });

        columns.forEach((column, index) => {
            // The ancestor sounds either side of the column (a word edge is "#").
            let left = "#";
            for (let k = index - 1; k >= 0; k--) {
                if (columns[k].from.length) {
                    left = columns[k].from[columns[k].from.length - 1];
                    break;
                }
            }
            let right = "#";
            for (let k = index + 1; k < columns.length; k++) {
                if (columns[k].from.length) {
                    right = columns[k].from[0];
                    break;
                }
            }
            const position = left === "#" ? "initial" : right === "#" ? "final" : "medial";

            const from = labelOf(column.from);
            const to = labelOf(column.to);
            const id = `${from}\u0000${to}`;
            let flow = flows.get(id);
            if (!flow) {
                flow = { from, to, fromParts: column.from, toParts: column.to, count: 0, examples: [], occurrences: [] };
                flows.set(id, flow);
            }
            flow.count++;
            flow.occurrences.push({ left, right, position, from: link.from_word, to: link.to_word });
            if (flow.examples.length < examplesPer && !flow.examples.some((e) => e.from === link.from_word && e.to === link.to_word)) {
                flow.examples.push({ from: link.from_word, to: link.to_word });
            }
        });
    }

    // Name each correspondence: the process most of its occurrences show (assimilation and the like
    // depend on the neighbours), and a route of one-step changes for a change of several features.
    for (const flow of flows.values()) {
        const tally = new Map();
        for (const o of flow.occurrences) {
            const { processes } = soundchange.classify(flow.fromParts, flow.toParts, { left: o.left, right: o.right, position: o.position }, known);
            for (const name of new Set(processes)) {
                tally.set(name, (tally.get(name) || 0) + 1);
            }
        }
        const ranked = [...tally].sort((p, q) => q[1] - p[1]);
        flow.processes = ranked.filter(([, n]) => n * 2 >= flow.count).map(([name]) => name);
        if (!flow.processes.length && ranked.length) {
            flow.processes = [ranked[0][0]];
        }
        // "voicing" beside "intervocalic voicing" is the same thing named twice: keep the specific one.
        flow.processes = flow.processes.filter((name) => !flow.processes.some((other) => other !== name && other.includes(name)));
        flow.route = null;
        if (flow.fromParts.length === 1 && flow.toParts.length === 1 && soundchange.featureDistance(flow.from, flow.to, known) >= 2) {
            flow.route = soundchange.routeBetween(flow.from, flow.to, inventory);
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

    // For each ancestor sound with more than one outcome: what tells the outcomes apart.
    const conditions = [];
    const bySound = new Map();
    for (const f of list) {
        if (f.from === GAP) {
            continue;
        }
        if (!bySound.has(f.from)) {
            bySound.set(f.from, []);
        }
        for (const o of f.occurrences) {
            bySound.get(f.from).push({ to: f.to, left: o.left, right: o.right });
        }
    }
    for (const [from, occurrences] of bySound) {
        for (const c of soundchange.conditioning(occurrences, CLASSES, known)) {
            conditions.push({ from, ...c, total: occurrences.length });
        }
    }

    // "k > c before front vowels, elsewhere k stays" says it all: drop the mirror-image second line.
    for (let i = conditions.length - 1; i >= 0; i--) {
        const c = conditions[i];
        if (conditions.some((d, k) => k < i && d.from === c.from && d.elsewhere && d.elsewhere.to === c.to)) {
            conditions.splice(i, 1);
        }
    }

    const kindByLabel = new Map();
    for (const f of list) {
        for (const [label, parts] of [[f.from, f.fromParts], [f.to, f.toParts]]) {
            if (parts.length && !kindByLabel.has(label)) {
                kindByLabel.set(label, kinds.get(parts[0]) || (featuresOf(parts[0]) || {}).kind || null);
            }
        }
    }

    return {
        fromOrthography,
        toOrthography,
        used,
        skipped,
        flows: list,
        alignments,
        conditions,
        fromTotals: totals("from"),
        toTotals: totals("to"),
        kindOf: (label) => kindByLabel.get(label) || null,
        kindOfSound: (symbol) => kinds.get(symbol) || (featuresOf(symbol) || {}).kind || null
    };
}

// ---- the diagram: ancestor sounds on the left, descendant sounds on the right ----

const esc = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function flowKind(f) {
    if (f.from === GAP) {
        return "gain";
    }
    if (f.to === GAP) {
        return "loss";
    }
    if (f.fromParts.length === 2 && f.toParts.length === 1) {
        return "merge";
    }
    if (f.fromParts.length === 1 && f.toParts.length === 2) {
        return "split";
    }
    return f.from === f.to ? "same" : "change";
}

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
        const what = f.processes && f.processes.length && f.processes[0] !== "unchanged" ? ` — ${f.processes.join("; ")}` : "";
        const title = `${f.from} → ${f.to}: ${f.count} time${f.count === 1 ? "" : "s"}${what}${f.examples.length ? ` (e.g. ${f.examples.map((e) => `${e.from} → ${e.to}`).join(", ")})` : ""}`;
        ribbons.push(
            `<path class="flow flow-${flowKind(f)}" d="M${x0},${y0} C${mid},${y0} ${mid},${y1} ${x1},${y1} L${x1},${y1 + h} C${mid},${y1 + h} ${mid},${y0 + h} ${x0},${y0 + h} Z"><title>${esc(title)}</title></path>`
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

module.exports = { relatedPairs, correspond, renderFlow, align, flowKind, GAP };
