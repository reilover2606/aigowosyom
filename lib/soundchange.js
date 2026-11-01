"use strict";

// Working out what a sound change *is*, from a pair of aligned sounds and their surroundings:
//
//  * describe(): a sound as features (and marks such as length or aspiration);
//  * classify(): names the processes in a change (voicing, lenition, elision, coalescence, ...), using
//    the features that differ and the neighbouring sounds (a feature that now matches a neighbour is
//    assimilation);
//  * routeBetween(): a plausible chain of one-feature steps from one sound to another, through sounds
//    that exist (the "mediate forms" a two-step change may have passed through);
//  * conditioning(): for a sound with several outcomes, which neighbouring sound (or class of sound)
//    best tells them apart.
//
// All of this is suggestion: it works from the data entered, and says what might explain it.

const { CHART, featuresOf, canonical, SUFFIX_MARKS, placeStep, mannerStep } = require("./ipa");

const MARKS = { "ʰ": "aspirated", "ː": "long", "ʷ": "labialized", "ʲ": "palatalized", "ˠ": "velarized", "ˤ": "pharyngealized", "ʼ": "ejective", "̃": "nasalized" };

const FRONT_VOWELS = ["front"];
const PLACES = CHART.places.map(([key]) => key);
const HEIGHTS = CHART.heights.map(([key]) => key);
const BACKNESSES = CHART.backnesses.map(([key]) => key);

// A sound as { ipa, kind, place, manner, voiced, height, backness, rounded, marks: [...] }. `known` (a
// Map of the language's own inventory entries) wins over the chart, so custom sounds keep their features.
function describe(ipa, known = null) {
    const own = known && known.get(ipa);
    const base = canonical(ipa.normalize("NFD").replace(SUFFIX_MARKS, "")) || ipa;
    const features = (own && own.kind ? own : null) || featuresOf(ipa) || featuresOf(base) || {};
    const marks = [...ipa.normalize("NFD")].filter((c) => MARKS[c]).map((c) => MARKS[c]);
    return { ...features, ipa, base, marks, known: Boolean(features.kind) };
}

// ---- naming a change ----

const kindOfPlace = (place) => (["palatal", "postalveolar"].includes(place) ? "palatal" : place);

// `env`: { left, right } as descriptions (or null at a word edge), `position`: initial | medial | final.
function classifySubstitution(a, b, env) {
    const processes = [];
    const left = env.left;
    const right = env.right;

    // Marks (length, aspiration, ...)
    const gained = b.marks.filter((m) => !a.marks.includes(m));
    const lost = a.marks.filter((m) => !b.marks.includes(m));
    const MARK_NAMES = {
        aspirated: ["aspiration", "deaspiration"], long: ["lengthening", "shortening"], labialized: ["labialization", "delabialization"],
        palatalized: ["palatalization", "depalatalization"], velarized: ["velarization", "develarization"],
        nasalized: ["nasalization", "denasalization"], ejective: ["ejectivization", "deejectivization"], pharyngealized: ["pharyngealization", "depharyngealization"]
    };
    gained.forEach((m) => processes.push(MARK_NAMES[m][0]));
    lost.forEach((m) => processes.push(MARK_NAMES[m][1]));

    if (a.base === b.base && (gained.length || lost.length)) {
        return processes;
    }
    if (!a.kind || !b.kind) {
        return processes.length ? processes : ["change"];
    }
    if (a.kind === "tone" || b.kind === "tone") {
        return ["tone change"];
    }

    if (a.kind !== b.kind) {
        if (a.kind === "vowel" && b.kind === "consonant") {
            processes.push(b.manner === "approximant" ? "glide formation (consonantalization)" : "consonantalization");
        } else {
            processes.push("vocalization");
        }
        return processes;
    }

    if (a.kind === "consonant") {
        // Voicing
        if (a.voiced !== b.voiced && a.voiced !== null && b.voiced !== null) {
            const voicing = b.voiced === 1;
            const neighbours = [["preceding", left], ["following", right]];
            const matched = neighbours.find(([, n]) => n && n.kind === "consonant" && n.voiced === b.voiced);
            if (left && right && left.kind === "vowel" && right.kind === "vowel") {
                processes.push(voicing ? "intervocalic voicing" : "intervocalic devoicing");
            } else if (matched) {
                processes.push(`${voicing ? "voicing" : "devoicing"} assimilation (to the ${matched[0]} sound)`);
            } else if (!right && !voicing) {
                processes.push("final devoicing");
            } else {
                processes.push(voicing ? "voicing" : "devoicing");
            }
        }

        // Manner
        if (a.manner !== b.manner) {
            const key = `${a.manner}>${b.manner}`;
            const named = {
                "plosive>fricative": "spirantization (lenition)",
                "plosive>affricate": "affrication",
                "affricate>fricative": "deaffrication (lenition)",
                "fricative>plosive": "stopping (fortition)",
                "fricative>affricate": "affrication (fortition)",
                "affricate>plosive": "deaffrication (fortition)",
                "fricative>approximant": "approximantization (lenition)",
                "plosive>approximant": "approximantization (lenition)",
                "approximant>fricative": "fricativization (fortition)",
                "approximant>plosive": "fortition",
                "plosive>tap": "flapping (lenition)",
                "fricative>tap": "rhotacism",
                "approximant>tap": "tapping",
                "tap>approximant": "approximantization",
                "tap>trill": "trilling (fortition)",
                "trill>tap": "tapping (lenition)",
                "lateral approximant>approximant": "delateralization",
                "approximant>lateral approximant": "lateralization",
                "lateral approximant>tap": "rhotacism",
                "tap>lateral approximant": "lambdacism",
                "lateral approximant>trill": "rhotacism",
                "trill>lateral approximant": "lambdacism"
            }[key];
            if (a.manner === "nasal" && b.manner !== "nasal") {
                processes.push("denasalization");
            } else if (b.manner === "nasal") {
                const nasalNeighbour = [left, right].find((n) => n && n.manner === "nasal");
                processes.push(nasalNeighbour ? "nasal assimilation" : "nasalization");
            } else if (b.place === "glottal" && a.place !== "glottal") {
                processes.push("debuccalization (lenition)");
            } else {
                processes.push(named || `manner change (${a.manner} → ${b.manner})`);
            }
        }

        // Place
        if (a.place !== b.place) {
            const neighbour = [["preceding", left], ["following", right]].find(([, n]) => n && n.kind === "consonant" && n.place === b.place);
            const frontNext = right && ((right.kind === "vowel" && FRONT_VOWELS.includes(right.backness)) || right.place === "palatal");
            if (neighbour) {
                processes.push(`place assimilation (to the ${neighbour[0]} sound)`);
            } else if (kindOfPlace(b.place) === "palatal" && !["palatal", "postalveolar"].includes(a.place) && frontNext) {
                processes.push("palatalization");
            } else if (kindOfPlace(b.place) === "palatal" && !["palatal", "postalveolar"].includes(a.place)) {
                processes.push("palatalization");
            } else {
                const dorsal = (place) => ["palatal", "velar", "uvular", "pharyngeal", "glottal"].includes(place);
                const from = PLACES.indexOf(a.place);
                const to = PLACES.indexOf(b.place);
                if (dorsal(a.place) && dorsal(b.place) && from >= 0 && to >= 0) {
                    processes.push(to < from ? `fronting (${a.place} → ${b.place})` : `backing (${a.place} → ${b.place})`);
                } else {
                    processes.push(`place shift (${a.place} → ${b.place})`);
                }
            }
        }
        return processes.length ? processes : ["change"];
    }

    // Vowels (a larger index in HEIGHTS is lower)
    if (a.height !== b.height && a.height && b.height) {
        processes.push(HEIGHTS.indexOf(b.height) > HEIGHTS.indexOf(a.height) ? "lowering" : "raising");
    }
    if (a.backness !== b.backness && a.backness && b.backness) {
        processes.push(BACKNESSES.indexOf(b.backness) < BACKNESSES.indexOf(a.backness) ? "fronting" : "backing");
    }
    if (a.rounded !== b.rounded && a.rounded !== null && b.rounded !== null) {
        processes.push(b.rounded ? "rounding" : "unrounding");
    }
    return processes.length ? processes : ["change"];
}

// Names the process(es) in a change from `from` sounds to `to` sounds (each 0, 1 or 2 symbols).
// env: { left, right } (neighbouring sounds in the ancestor, or "#"), position: initial | medial | final.
function classify(fromParts, toParts, env, known = null, info = {}) {
    const d = (symbol) => (symbol && symbol !== "#" ? describe(symbol, known) : null);
    const near = { left: d(env.left), right: d(env.right) };
    const from = fromParts.map((s) => describe(s, known));
    const to = toParts.map((s) => describe(s, known));

    if (info.metathesis) {
        return { processes: [`metathesis (${fromParts.join("")} → ${toParts.join("")}: two neighbouring sounds swap places)`], route: null };
    }

    if (from.length === 1 && to.length === 1) {
        if (from[0].ipa === to[0].ipa) {
            return { processes: ["unchanged"], route: null };
        }
        if (from[0].diphthong || to[0].diphthong) {
            return { processes: classifyDiphthong(from[0], to[0], near, known), route: null };
        }
        const processes = classifySubstitution(from[0], to[0], near);
        return { processes, route: null };
    }

    if (to.length === 0 && from.length >= 1) {
        const first = from[0];
        const initial = env.left === "#";
        const final = env.right === "#";
        if (info.syllables) {
            const text = from.map((f) => f.ipa).join("");
            return {
                processes: [initial ? `loss of an initial syllable (${text}-: a prefix wears away)` : final ? `loss of a final syllable (-${text}: suffix erosion)` : `loss of a medial syllable (${text}: haplology or a whole syllable syncopated)`],
                route: null
            };
        }
        if (first.kind === "tone") {
            return { processes: ["loss of a tone"], route: null };
        }
        if (first.kind === "vowel") {
            return { processes: [initial ? "aphaeresis (loss of an initial vowel)" : final ? "apocope (loss of a final vowel)" : "syncope (loss of a medial vowel)"], route: null };
        }
        if (first.place === "glottal") {
            return { processes: ["h-dropping (loss of a glottal consonant)"], route: null };
        }
        const cluster = (near.left && near.left.kind === "consonant") || (near.right && near.right.kind === "consonant");
        return {
            processes: [initial ? "loss of an initial consonant" : final ? "loss of a final consonant" : cluster ? "cluster simplification (elision)" : "elision (loss of a consonant)"],
            route: null
        };
    }

    if (from.length === 0 && to.length >= 1) {
        const first = to[0];
        const initial = env.left === "#";
        const final = env.right === "#";
        if (info.syllables) {
            const text = to.map((f) => f.ipa).join("");
            return { processes: [initial ? `a new initial syllable (${text}-)` : final ? `a new final syllable (-${text}: an added suffix)` : `a new medial syllable (${text})`], route: null };
        }
        if (first.kind === "tone") {
            return { processes: ["a tone appears"], route: null };
        }
        const name = initial ? "prothesis" : final ? "paragoge" : "epenthesis";
        return { processes: [`${name} (a ${first.kind === "vowel" ? "vowel" : "consonant"} appears)`], route: null };
    }

    if (from.length === 2 && to.length === 1) {
        const [a, b] = from;
        const t = to[0];
        if (t.diphthong && t.parts[0] === a.ipa && t.parts[1] === b.ipa) {
            return { processes: ["diphthong formation (two vowels become one syllable)"], route: null };
        }
        if (a.ipa === b.ipa && a.ipa === t.ipa) {
            return { processes: [a.kind === "vowel" ? "contraction (two identical vowels become one)" : "degemination (a doubled sound becomes single)"], route: null };
        }
        if (a.kind === "vowel" && b.kind === "vowel") {
            return { processes: ["monophthongization / vowel coalescence"], route: null };
        }
        const keys = a.kind === "vowel" ? ["height", "backness", "rounded"] : ["place", "manner", "voiced"];
        const label = { place: "place", manner: "manner", voiced: "voicing", height: "height", backness: "backness", rounded: "rounding" };
        const sources = keys.map((k) => {
            const fromA = t[k] === a[k];
            const fromB = t[k] === b[k];
            return fromA && fromB ? null : fromA ? `${label[k]} from ${a.ipa}` : fromB ? `${label[k]} from ${b.ipa}` : null;
        }).filter(Boolean);
        const nasalStop = (a.manner === "nasal" && b.manner !== "nasal") || (b.manner === "nasal" && a.manner !== "nasal");
        return {
            processes: [`coalescence${nasalStop ? " (nasal + stop)" : ""}${sources.length ? `: ${sources.join(", ")}` : ""}`],
            route: null
        };
    }

    if (from.length === 1 && to.length === 2) {
        const [x, y] = to;
        if (from[0].diphthong && from[0].parts[0] === x.ipa && from[0].parts[1] === y.ipa) {
            return { processes: ["hiatus (a diphthong splits into two syllables)"], route: null };
        }
        return {
            processes: [from[0].kind === "vowel" && x.kind === "vowel" && y.kind === "vowel" ? "diphthongization / breaking" : "splitting into two sounds"],
            route: null
        };
    }

    return { processes: ["rearrangement"], route: null };
}

// A change that involves a diphthong (a vowel plus a glide, one nucleus).
function classifyDiphthong(a, b, near, known) {
    if (a.diphthong && !b.diphthong) {
        if (b.kind !== "vowel") {
            return ["loss of the vowel (a diphthong becomes a consonant)"];
        }
        const [first, second] = a.parts;
        const kept = b.ipa === first ? `keeps the first vowel: ${a.ipa} → ${b.ipa}` : b.ipa === second ? `keeps the second vowel: ${a.ipa} → ${b.ipa}` : `a vowel between the two: ${a.ipa} → ${b.ipa}`;
        return [`monophthongization (${kept})`];
    }
    if (!a.diphthong && b.diphthong) {
        return [`diphthongization (${a.ipa} → ${b.ipa})`];
    }
    // diphthong to diphthong: what happened to each element
    const names = [];
    ["first", "second"].forEach((which, i) => {
        const x = describe(a.parts[i], known);
        const y = describe(b.parts[i], known);
        if (x.ipa !== y.ipa) {
            for (const name of classifySubstitution(x, y, { left: near.left, right: near.right })) {
                names.push(`${name} of the ${which} element`);
            }
        }
    });
    return names.length ? names : ["change"];
}

// ---- a route of one-feature steps ----

function neighbours(a, b) {
    if (a.kind !== b.kind) {
        return false;
    }
    if (a.kind === "consonant") {
        const place = a.place !== b.place;
        const manner = a.manner !== b.manner;
        const voiced = a.voiced !== b.voiced;
        if (place + manner + voiced !== 1) {
            return false;
        }
        if (place) {
            return placeStep(a.place, b.place);
        }
        if (manner) {
            return mannerStep(a.manner, b.manner);
        }
        return true;
    }
    const height = a.height !== b.height;
    const backness = a.backness !== b.backness;
    const rounded = a.rounded !== b.rounded;
    if (height + backness + rounded !== 1) {
        return false;
    }
    if (height) {
        return Math.abs(HEIGHTS.indexOf(a.height) - HEIGHTS.indexOf(b.height)) <= 1;
    }
    if (backness) {
        return Math.abs(BACKNESSES.indexOf(a.backness) - BACKNESSES.indexOf(b.backness)) <= 1;
    }
    return true;
}

let graph = null;

function chartGraph() {
    if (!graph) {
        const nodes = [...CHART.consonants, ...CHART.vowels];
        graph = new Map(nodes.map((n) => [n.ipa, { node: n, next: [] }]));
        for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
                if (neighbours(nodes[i], nodes[j])) {
                    graph.get(nodes[i].ipa).next.push(nodes[j].ipa);
                    graph.get(nodes[j].ipa).next.push(nodes[i].ipa);
                }
            }
        }
    }
    return graph;
}

// A chain of sounds from `from` to `to`, each step changing one feature by one step on the charts,
// preferring sounds the languages actually have (`inventory`, a Set). Null if there's no sensible chain
// (one end isn't on the chart) or it needs only the one step.
function routeBetween(from, to, inventory = new Set()) {
    const strip = (symbol) => canonical(symbol.normalize("NFD").replace(SUFFIX_MARKS, ""));
    const start = strip(from);
    const end = strip(to);
    const g = chartGraph();
    if (!g.has(start) || !g.has(end) || start === end) {
        return null;
    }
    // Dijkstra over a small graph; a sound neither language has costs a little more to pass through.
    const cost = new Map([[start, 0]]);
    const previous = new Map();
    const open = new Set([start]);
    while (open.size) {
        let best = null;
        for (const key of open) {
            if (best === null || cost.get(key) < cost.get(best)) {
                best = key;
            }
        }
        open.delete(best);
        if (best === end) {
            break;
        }
        for (const next of g.get(best).next) {
            const step = 1 + (inventory.has(next) || next === end ? 0 : 0.25);
            const total = cost.get(best) + step;
            if (!cost.has(next) || total < cost.get(next) - 1e-9) {
                cost.set(next, total);
                previous.set(next, best);
                open.add(next);
            }
        }
    }
    if (!previous.has(end)) {
        return null;
    }
    const path = [end];
    while (path[0] !== start) {
        path.unshift(previous.get(path[0]));
    }
    return path.length >= 3 && path.length <= 7 ? path : null;
}

// ---- what conditions a change ----

// The predicates a neighbouring sound can satisfy: a word edge, a particular sound, or a class.
function predicates(neighbour, classes, known) {
    const edge = neighbour === "#";
    const sound = edge ? null : { ...describe(neighbour, known), ipa: neighbour };
    return {
        edge,
        symbol: edge ? null : neighbour,
        classes: sound ? Object.keys(classes).filter((name) => classes[name](sound)) : []
    };
}

const CLASS_WORDS = {
    consonant: "a consonant", vowel: "a vowel", nasal: "a nasal", plosive: "a plosive", stop: "a stop", affricate: "an affricate",
    fricative: "a fricative", approximant: "an approximant", lateral: "a lateral", trill: "a trill", tap: "a tap", liquid: "a liquid",
    obstruent: "an obstruent", sonorant: "a sonorant", voiced: "a voiced sound", voiceless: "a voiceless sound", labial: "a labial",
    coronal: "a coronal", palatal: "a palatal", velar: "a velar", front: "a front vowel", central: "a central vowel",
    back: "a back vowel", high: "a high vowel", low: "a low vowel", rounded: "a rounded vowel", unrounded: "an unrounded vowel"
};

// occurrences: [{ to, left, right }] for one ancestor sound. Returns the clearest explanations of
// outcomes that differ: { to, side, what, hits, of, exceptions, elsewhere } sorted best first.
function conditioning(occurrences, classes, known = null) {
    const total = occurrences.length;
    if (total < 3) {
        return [];
    }
    const outcomes = new Map();
    for (const o of occurrences) {
        outcomes.set(o.to, (outcomes.get(o.to) || 0) + 1);
    }
    if (outcomes.size < 2) {
        return [];
    }

    const facts = occurrences.map((o) => ({ to: o.to, left: predicates(o.left, classes, known), right: predicates(o.right, classes, known) }));

    // The candidate tests: for each side, the edge, each sound seen there, each class seen there.
    const candidates = [];
    for (const side of ["left", "right"]) {
        const symbols = new Set();
        const names = new Set();
        let edge = false;
        for (const f of facts) {
            edge = edge || f[side].edge;
            if (f[side].symbol) {
                symbols.add(f[side].symbol);
            }
            f[side].classes.forEach((c) => names.add(c));
        }
        if (edge) {
            candidates.push({ side, edge: true, label: side === "left" ? "the start of a word" : "the end of a word", test: (f) => f[side].edge, rank: 1 });
        }
        for (const name of names) {
            candidates.push({ side, label: CLASS_WORDS[name] || name, test: (f) => f[side].classes.includes(name), rank: 0 });
        }
        for (const symbol of symbols) {
            candidates.push({ side, label: `/${symbol}/`, test: (f) => f[side].symbol === symbol, rank: 2 });
        }
    }

    // Both sides at once: between vowels, between a nasal and a vowel, ... (a change that needs
    // both neighbours, such as intervocalic voicing, is not found by either side alone).
    const BOTH = ["vowel", "consonant", "nasal", "voiced", "voiceless"];
    for (const x of BOTH) {
        for (const y of BOTH) {
            const label = x === y && (x === "vowel" || x === "consonant") ? `between ${x}s` : `between ${CLASS_WORDS[x]} and ${CLASS_WORDS[y]}`;
            candidates.push({ side: "both", label, test: (f) => f.left.classes.includes(x) && f.right.classes.includes(y), rank: 3 });
        }
    }

    const found = [];
    for (const [to, count] of outcomes) {
        if (count < 2) {
            continue;
        }
        const baseline = Math.max(count, total - count) / total;
        let best = null;
        for (const c of candidates) {
            let tp = 0;
            let fp = 0;
            let fn = 0;
            for (const f of facts) {
                const hit = c.test(f);
                if (hit && f.to === to) {
                    tp++;
                } else if (hit) {
                    fp++;
                } else if (f.to === to) {
                    fn++;
                }
            }
            const accuracy = (tp + (total - tp - fp - fn)) / total;
            if (tp < 2 || accuracy <= baseline || fp + fn > Math.floor(total * 0.2)) {
                continue;
            }
            const score = accuracy - 0.01 * c.rank - 0.001 * (fp + fn);
            if (!best || score > best.score) {
                best = { ...c, tp, fp, fn, accuracy, score };
            }
        }
        if (best) {
            const rest = {};
            for (const f of facts) {
                if (!best.test(f)) {
                    rest[f.to] = (rest[f.to] || 0) + 1;
                }
            }
            const elsewhere = Object.entries(rest).sort((p, q) => q[1] - p[1])[0] || null;
            found.push({
                to,
                side: best.side,
                what: best.label,
                edge: Boolean(best.edge),
                hits: best.tp,
                of: best.tp + best.fp,
                exceptions: best.fp + best.fn,
                elsewhere: elsewhere ? { to: elsewhere[0], count: elsewhere[1], of: total - best.tp - best.fp } : null,
                accuracy: best.accuracy
            });
        }
    }
    return found.sort((p, q) => q.accuracy - p.accuracy || q.hits - p.hits);
}

// How many of the main features differ between two sounds (Infinity if they can't be compared).
function featureDistance(x, y, known = null) {
    const a = describe(x, known);
    const b = describe(y, known);
    if (!a.kind || a.kind !== b.kind || a.kind === "tone" || a.kind === "stress") {
        return Infinity;
    }
    const keys = a.kind === "vowel" ? ["height", "backness", "rounded"] : ["place", "manner", "voiced"];
    return keys.filter((k) => a[k] !== b[k]).length;
}

module.exports = { describe, classify, routeBetween, conditioning, featureDistance };
