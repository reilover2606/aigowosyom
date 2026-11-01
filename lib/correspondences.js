"use strict";

// Sound correspondences between a language and one that descends from it (through the "inherited"
// links between words).
//
// Each pair of linked words is turned into its sounds (from the languages' spellings, or letter by
// letter where a language has none) and the two sequences are lined up. The lining-up allows what
// real changes do: a sound can stay, change, be lost or appear, *two sounds can become one*
// (m + p > b, a coalescence) and *one can become two* (a > ia, breaking). A diphthong is one sound
// here (a vowel with a glide: a nucleus, not two vowels), so ai > e is a monophthongization, not a
// vowel lost beside a vowel changed. Whole syllables that go (or appear) are one event, the loss of a
// syllable, not a string of lost sounds: that is how eroded suffixes show up.
//
// Each column of the alignment is then looked at in its surroundings:
//
//  * which process(es) it is (voicing, lenition, elision, assimilation, coalescence, ...) from the
//    features that differ and the neighbouring sounds (lib/soundchange.js);
//  * for a change of several features at once, a plausible route of one-step changes through sounds
//    that exist (the intermediate forms it may have passed through);
//  * for an ancestor sound with more than one outcome, which neighbouring sound (or class of sounds)
//    best tells the outcomes apart ("k > tʃ before front vowels");
//  * and for the words as a whole, how their number of syllables changed and why.
//
// This is a set of suggestions to think with, computed from the words entered; it knows nothing
// about the history of the languages beyond that.

const { db } = require("./db");
const { similarity, featuresOf, featureCloseness } = require("./ipa");
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

// ---- a word as sounds and syllables ----

const LETTER_VOWELS = /^[aeiouyáàâäãåāăąæœéèêëēėęíìîïīįóòôöõøōőúùûüūůűɐəɛɪɔʊʌɑɒɨʉ]/iu;

// A headword's sounds (stress marks left out), with where each syllable starts, and diphthongs as one
// sound: from the orthography when the language has one (null if some letter is not covered), else its
// letters (a vowel letter next to another is a diphthong). `diphthongs` collects token -> its two vowels.
function soundsOf(languageId, headword, usesOrthography, diphthongs) {
    const joinVowels = (first, second) => {
        const token = first + second;
        diphthongs.set(token, [first, second]);
        return token;
    };

    if (usesOrthography) {
        const result = transcribe(languageId, headword);
        if (!result.complete) {
            return null;
        }
        const kinds = compile(languageId).kinds;
        const tokens = [];
        const starts = [];
        for (const syllable of result.syllables) {
            let first = true;
            let afterVowel = false;
            for (const ipa of syllable.phonemes) {
                const kind = kinds.get(ipa);
                if (kind === "stress") {
                    continue;
                }
                if (kind === "vowel" && afterVowel) {
                    // a second vowel in the same syllable: the two are one diphthong
                    tokens.push(joinVowels(tokens.pop(), ipa));
                    continue;
                }
                tokens.push(ipa);
                starts.push(first);
                first = false;
                afterVowel = kind === "vowel";
            }
        }
        return { tokens, starts };
    }

    const letters = headword.normalize("NFC").toLowerCase().replace(/^\*/, "").match(/\p{L}\p{M}*/gu);
    if (!letters || !letters.length) {
        return null;
    }
    // Without a spelling: two vowel letters in a row are a diphthong, and a syllable begins at the
    // consonant before each vowel that follows another syllable's vowel.
    const tokens = [];
    for (const letter of letters) {
        const last = tokens[tokens.length - 1];
        if (last && last.length === 1 && LETTER_VOWELS.test(letter) && LETTER_VOWELS.test(last)) {
            tokens[tokens.length - 1] = joinVowels(last, letter);
        } else {
            tokens.push(letter);
        }
    }
    const vowel = tokens.map((t) => LETTER_VOWELS.test(t));
    const starts = tokens.map(() => false);
    let seenVowel = false;
    let pending = null; // the first consonant of a run since the last vowel
    tokens.forEach((token, i) => {
        if (vowel[i]) {
            starts[pending !== null && seenVowel ? pending : i] = true;
            if (!seenVowel) {
                starts[0] = true; // the first syllable takes everything before its vowel
                starts[i] = i === 0;
            }
            seenVowel = true;
            pending = null;
        } else if (pending === null) {
            pending = i;
        }
    });
    if (!seenVowel) {
        starts[0] = true;
    }
    return { tokens, starts };
}

// ---- lining up ----

const GAP_COST = -0.8;
const SYLLABLE_COST = -0.95; // a whole syllable lost or gained, whatever its length
const FUSION_COST = 0.25;
const DIPHTHONG_COST = 0.15;

const heightIndex = (h) => ["close", "near-close", "close-mid", "mid", "open-mid", "near-open", "open"].indexOf(h);
const backIndex = (b) => ["front", "central", "back"].indexOf(b);

// Weak sounds go more easily than others (h-dropping, loss of a glottal stop), so losing one costs less.
function gapCost(token) {
    const f = featuresOf(token);
    return f && f.kind === "consonant" && f.place === "glottal" ? -0.5 : GAP_COST;
}

// How well a single vowel `mono` stands for the diphthong `parts` (a monophthongization), or the other
// way round: each feature should be one of the two vowels' or lie between them (ai > e: e is mid-height
// between a and i).
function monophthongScore(mono, parts) {
    const fm = featuresOf(mono);
    const fp = parts.map((p) => featuresOf(p));
    if (!fm || fp.some((f) => !f) || fm.kind !== "vowel" || fp.some((f) => f.kind !== "vowel")) {
        return -1;
    }
    const between = (value, scale) => {
        const [x, y] = fp.map((f) => scale(f));
        return Math.min(x, y) <= scale(value) && scale(value) <= Math.max(x, y);
    };
    let matches = 0;
    if (between(fm.height, (v) => heightIndex(v.height || v))) {
        matches++;
    }
    if (between(fm.backness, (v) => backIndex(v.backness || v))) {
        matches++;
    }
    if (fp.some((f) => f.rounded === fm.rounded)) {
        matches++;
    }
    return -0.5 + (matches / 3) * 1.4 - DIPHTHONG_COST;
}

// The similarity of two tokens (sounds, or diphthongs given in `diph`: token -> [first, second]).
function makeSimilarity(diph) {
    const sim = (x, y) => {
        const px = diph.get(x);
        const py = diph.get(y);
        if (!px && !py) {
            return similarity(x, y);
        }
        if (px && py) {
            return x === y ? 1 : (sim(px[0], py[0]) + sim(px[1], py[1])) / 2 - 0.05;
        }
        return px ? monophthongScore(y, px) : monophthongScore(x, py);
    };
    return sim;
}

// How well `target` is explained as the blend of two neighbouring sounds `a` and `b` (two sounds
// becoming one, or one becoming two). Mergers are only the kinds that really happen:
//   a nasal and the consonant after it (mp > b, nt > d, nk > g),
//   a consonant and a following j (tj > tʃ, sj > ʃ: palatalization),
//   two vowels (ai > e, a + i > e), and a doubled sound that becomes single.
// Each of the two has to give something the other doesn't (voicing from the nasal, manner from the
// stop...), or it is just one sound lost beside another that changed; features count partly when
// they are a step away (a labiodental is close to a bilabial). A diphthong against its own two vowels
// is a diphthong formed (or split into hiatus).
function makeBlend(diph) {
    return (target, a, b) => {
        const parts = diph.get(target);
        if (parts && parts[0] === a && parts[1] === b) {
            return 0.45;
        }
        if (diph.has(a) || diph.has(b) || diph.has(target)) {
            return -Infinity;
        }
        const fa = featuresOf(a);
        const fb = featuresOf(b);
        const ft = featuresOf(target);
        if (!fa || !fb || !ft || ft.kind !== fa.kind && ft.kind !== fb.kind) {
            return -Infinity;
        }
        if (a === b) {
            // A doubled sound that becomes single (degemination, or two identical vowels contracting).
            return a === target ? 0.4 : -Infinity;
        }

        if (fa.kind === "vowel" && fb.kind === "vowel" && ft.kind === "vowel") {
            const same = (f) => ["height", "backness", "rounded"].every((k) => f[k] === ft[k]);
            if (same(fa) || same(fb)) {
                return -Infinity; // it is one of them: the other was lost
            }
            return monophthongScore(target, [a, b]) - FUSION_COST + DIPHTHONG_COST;
        }

        const nasalStop = fa.kind === "consonant" && fb.kind === "consonant" && fa.manner === "nasal" && fb.manner !== "nasal";
        const palatalizing = fa.kind === "consonant" && fb.kind === "consonant" && fb.manner === "approximant" && fb.place === "palatal" && fa.manner !== "nasal";
        if (!(nasalStop || palatalizing) || ft.kind !== "consonant") {
            return -Infinity;
        }

        const keys = ["place", "manner", "voiced"];
        let total = 0;
        let onlyA = 0;
        let onlyB = 0;
        for (const k of keys) {
            const ca = featureCloseness(k, ft[k], fa[k]);
            const cb = featureCloseness(k, ft[k], fb[k]);
            total += Math.max(ca, cb);
            if (ca >= 0.5 && ca > cb) {
                onlyA++;
            }
            if (cb >= 0.5 && cb > ca) {
                onlyB++;
            }
        }
        if (onlyA === 0 || onlyB === 0) {
            return -Infinity; // one of them contributes nothing: a loss plus a substitution explains it as well
        }
        return -0.5 + (total / keys.length) * 1.4 - FUSION_COST;
    };
}

// Lines up two sound sequences (Needleman-Wunsch, with two-for-one and one-for-two steps, and whole
// syllables lost or gained at a flat cost). Returns columns { from: [sounds], to: [sounds] } with 0, 1
// or 2 sounds on a side. `diph` (optional) names the diphthong tokens in the sequences; `startsA` and
// `startsB` say where each word's syllables begin.
function align(a, b, diph = new Map(), startsA = null, startsB = null) {
    const sim = makeSimilarity(diph);
    const blend = makeBlend(diph);
    const rows = a.length + 1;
    const cols = b.length + 1;
    const score = Array.from({ length: rows }, () => new Float64Array(cols).fill(-Infinity));
    const how = Array.from({ length: rows }, () => new Array(cols).fill(null));
    const back = Array.from({ length: rows }, () => new Array(cols).fill(0));
    score[0][0] = 0;

    // Where the syllable that ends at position i began (null if one doesn't end there).
    const syllableStart = (starts, i, length) => {
        if (!starts || i === 0 || !(i === length || starts[i])) {
            return null;
        }
        let s = i - 1;
        while (s > 0 && !starts[s]) {
            s--;
        }
        return starts[s] ? s : null;
    };

    const consider = (i, j, value, op, from = 0) => {
        if (value > score[i][j] + 1e-12) {
            score[i][j] = value;
            how[i][j] = op;
            back[i][j] = from;
        }
    };

    for (let i = 0; i < rows; i++) {
        for (let j = 0; j < cols; j++) {
            if (i === 0 && j === 0) {
                continue;
            }
            // Earlier lines win ties.
            if (i > 0 && j > 0) {
                consider(i, j, score[i - 1][j - 1] + sim(a[i - 1], b[j - 1]), "one-one");
            }
            if (i > 1 && j > 0) {
                consider(i, j, score[i - 2][j - 1] + blend(b[j - 1], a[i - 2], a[i - 1]), "two-one");
            }
            if (i > 0 && j > 1) {
                consider(i, j, score[i - 1][j - 2] + blend(a[i - 1], b[j - 2], b[j - 1]), "one-two");
            }
            if (i > 0) {
                const s = syllableStart(startsA, i, a.length);
                if (s !== null && i - s >= 2) {
                    consider(i, j, score[s][j] + SYLLABLE_COST, "syllable-delete", s);
                }
                consider(i, j, score[i - 1][j] + gapCost(a[i - 1]), "delete");
            }
            if (j > 0) {
                const s = syllableStart(startsB, j, b.length);
                if (s !== null && j - s >= 2) {
                    consider(i, j, score[i][s] + SYLLABLE_COST, "syllable-insert", s);
                }
                consider(i, j, score[i][j - 1] + gapCost(b[j - 1]), "insert");
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
        } else if (op === "syllable-delete") {
            for (let k = i; k > back[i][j]; k--) {
                columns.push({ from: [a[k - 1]], to: [] });
            }
            i = back[i][j];
        } else if (op === "syllable-insert") {
            for (let k = j; k > back[i][j]; k--) {
                columns.push({ from: [], to: [b[k - 1]] });
            }
            j = back[i][j];
        } else if (op === "delete") {
            columns.push({ from: [a[i - 1]], to: [] });
            i--;
        } else {
            columns.push({ from: [], to: [b[j - 1]] });
            j--;
        }
    }
    return swapNeighbours(columns.reverse());
}

// Two neighbouring sounds that trade places (rt > tr) are one metathesis, not two substitutions.
function swapNeighbours(columns) {
    const out = [];
    for (let i = 0; i < columns.length; i++) {
        const c = columns[i];
        const d = columns[i + 1];
        if (d && c.from.length === 1 && c.to.length === 1 && d.from.length === 1 && d.to.length === 1
            && c.from[0] !== c.to[0] && c.from[0] === d.to[0] && c.to[0] === d.from[0]) {
            out.push({ from: [c.from[0], d.from[0]], to: [c.to[0], d.to[0]], metathesis: true });
            i++;
        } else {
            out.push(c);
        }
    }
    return out;
}

const labelOf = (parts) => (parts.length ? parts.join("") : GAP);

// Runs of lost (or gained) sounds that make up whole syllables become one column: the syllable is what
// went, not the sounds in it one by one. `startsFrom` / `startsTo`: where syllables begin in each word.
function collapseSyllables(columns, startsFrom, startsTo) {
    const out = [];
    let fromAt = 0;
    let toAt = 0;
    let i = 0;
    while (i < columns.length) {
        const column = columns[i];
        const lost = column.to.length === 0 && column.from.length > 0;
        const gained = column.from.length === 0 && column.to.length > 0;
        if (lost || gained) {
            // the whole run of lost (or gained) columns
            let k = i;
            const run = { from: [], to: [] };
            const startFrom = fromAt;
            const startTo = toAt;
            while (k < columns.length && (lost ? columns[k].to.length === 0 && columns[k].from.length > 0 : columns[k].from.length === 0 && columns[k].to.length > 0)) {
                run.from.push(...columns[k].from);
                run.to.push(...columns[k].to);
                k++;
            }
            const starts = lost ? startsFrom : startsTo;
            const begin = lost ? startFrom : startTo;
            const length = lost ? run.from.length : run.to.length;
            const wholeSyllables = starts[begin] && (begin + length >= starts.length || starts[begin + length]);
            // A glottal (h) with one vowel is a lost h and a lost vowel, not a syllable that wore away.
            const tokens = (lost ? run.from : run.to).filter((t) => (featuresOf(t) || {}).place !== "glottal");
            let syllables = 0;
            for (let t = begin; t < begin + length; t++) {
                if (starts[t]) {
                    syllables++;
                }
            }
            if (wholeSyllables && syllables > 0 && tokens.length >= 2) {
                out.push({ from: run.from, to: run.to, syllables });
                fromAt += run.from.length;
                toAt += run.to.length;
                i = k;
                continue;
            }
        }
        out.push(column);
        fromAt += column.from.length;
        toAt += column.to.length;
        i++;
    }
    return out;
}

// ---- the whole comparison ----

function correspond(fromId, toId, { examplesPer = 4 } = {}) {
    const fromOrthography = hasOrthography(fromId);
    const toOrthography = hasOrthography(toId);
    const fromData = compile(fromId);
    const toData = compile(toId);
    const kinds = new Map([...fromData.kinds, ...toData.kinds]);
    const known = new Map([...fromData.byIpa, ...toData.byIpa]);
    const inventory = new Set([...fromData.symbols, ...toData.symbols]);
    const diphthongs = new Map(); // token -> its two vowels, for every diphthong met in the words

    const flows = new Map(); // "from\u0000to" -> flow
    const alignments = []; // each linked pair as aligned columns (for lib/lingrex.js)
    const pairsInfo = []; // per word pair: syllables and what happened
    const seen = new Set();
    let used = 0;
    let skipped = 0;

    for (const link of stmt.links.all(fromId, toId)) {
        const key = `${link.from_word}\u0000${link.to_word}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);

        const a = soundsOf(fromId, link.from_word, fromOrthography, diphthongs);
        const b = soundsOf(toId, link.to_word, toOrthography, diphthongs);
        if (!a || !b) {
            skipped++;
            continue;
        }
        used++;

        // The diphthongs are features-bearing sounds for the classifier too.
        for (const [token, parts] of diphthongs) {
            if (!known.has(token)) {
                const first = featuresOf(parts[0]) || {};
                const second = featuresOf(parts[1]) || {};
                known.set(token, { ...first, kind: "vowel", diphthong: true, parts, glide: second });
                kinds.set(token, "vowel");
            }
        }

        const columns = collapseSyllables(align(a.tokens, b.tokens, diphthongs, a.starts, b.starts), a.starts, b.starts);
        alignments.push({ from: link.from_word, to: link.to_word, columns });

        const fromSyllables = a.starts.filter(Boolean).length;
        const toSyllables = b.starts.filter(Boolean).length;
        const tags = new Set();

        columns.forEach((column, index) => {
            // The ancestor sounds either side of the column (a word edge is "#"). A lost h or glottal stop
            // is looked through, since losing it is what puts its neighbours side by side.
            const lostGlottal = (c) => c.to.length === 0 && c.from.length === 1 && (featuresOf(c.from[0]) || {}).place === "glottal";
            let left = "#";
            for (let k = index - 1; k >= 0; k--) {
                if (columns[k].from.length && !lostGlottal(columns[k])) {
                    left = columns[k].from[columns[k].from.length - 1];
                    break;
                }
            }
            let right = "#";
            for (let k = index + 1; k < columns.length; k++) {
                if (columns[k].from.length && !lostGlottal(columns[k])) {
                    right = columns[k].from[0];
                    break;
                }
            }
            const position = left === "#" ? "initial" : right === "#" ? "final" : "medial";

            const from = labelOf(column.from);
            const to = labelOf(column.to);
            const { processes } = soundchange.classify(column.from, column.to, { left, right, position }, known, { syllables: column.syllables || 0, metathesis: Boolean(column.metathesis) });
            processes.forEach((name) => tags.add(name));

            const id = `${from}\u0000${to}`;
            let flow = flows.get(id);
            if (!flow) {
                flow = { from, to, fromParts: column.from, toParts: column.to, syllables: column.syllables || 0, count: 0, examples: [], occurrences: [] };
                flows.set(id, flow);
            }
            flow.count++;
            flow.occurrences.push({ left, right, position, processes, from: link.from_word, to: link.to_word });
            if (flow.examples.length < examplesPer && !flow.examples.some((e) => e.from === link.from_word && e.to === link.to_word)) {
                flow.examples.push({ from: link.from_word, to: link.to_word });
            }
        });

        pairsInfo.push({ from: link.from_word, to: link.to_word, fromSyllables, toSyllables, tags: [...tags], columns });
    }

    // Name each correspondence: the process most of its occurrences show (assimilation and the like
    // depend on the neighbours), and a route of one-step changes for a change of several features.
    for (const flow of flows.values()) {
        const tally = new Map();
        for (const o of flow.occurrences) {
            for (const name of new Set(o.processes)) {
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
        const diphthong = (label) => diphthongs.has(label);
        if (flow.fromParts.length === 1 && flow.toParts.length === 1 && !diphthong(flow.from) && !diphthong(flow.to) && soundchange.featureDistance(flow.from, flow.to, known) >= 2) {
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
        if (f.from === GAP || f.syllables) {
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
    // "k > c before front vowels, elsewhere k stays" says it all: drop the mirror-image second line, and
    // prefer to explain the change over the sound staying as it was.
    conditions.sort((p, q) => Number(q.to !== q.from) - Number(p.to !== p.from) || q.accuracy - p.accuracy || q.hits - p.hits);
    for (let i = conditions.length - 1; i >= 0; i--) {
        const c = conditions[i];
        if (conditions.some((d, k) => k < i && d.from === c.from && d.elsewhere && d.elsewhere.to === c.to)) {
            conditions.splice(i, 1);
        }
    }

    const kindByLabel = new Map();
    const kindOfToken = (token) => (diphthongs.has(token) ? "vowel" : kinds.get(token) || (featuresOf(token) || {}).kind || null);
    for (const f of list) {
        for (const [label, parts] of [[f.from, f.fromParts], [f.to, f.toParts]]) {
            if (parts.length && !kindByLabel.has(label)) {
                kindByLabel.set(label, kindOfToken(parts[0]));
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
        shape: wordShape(pairsInfo),
        fromTotals: totals("from"),
        toTotals: totals("to"),
        kindOf: (label) => kindByLabel.get(label) || null,
        kindOfSound: kindOfToken
    };
}

// ---- how the words changed in length ----

// Syllables before and after, and why the words got shorter or longer: whole syllables lost (an eroded
// suffix, a lost prefix), vowels lost, vowels run together, or sounds added.
function wordShape(pairs) {
    const crosstab = new Map();
    const lostSyllables = new Map(); // "final|na" -> { position, text, count, examples }
    const gainedSyllables = new Map();
    const reasons = { shorter: new Map(), longer: new Map() };
    let shorter = 0;
    let longer = 0;
    let same = 0;

    const bump = (map, key, make, example) => {
        if (!map.has(key)) {
            map.set(key, { ...make, count: 0, examples: [] });
        }
        const entry = map.get(key);
        entry.count++;
        if (entry.examples.length < 3) {
            entry.examples.push(example);
        }
    };

    for (const pair of pairs) {
        const key = `${pair.fromSyllables}\u0000${pair.toSyllables}`;
        crosstab.set(key, (crosstab.get(key) || 0) + 1);
        const example = { from: pair.from, to: pair.to };

        // Whole-syllable events, with where in the word.
        pair.columns.forEach((column, index) => {
            if (!column.syllables) {
                return;
            }
            const before = pair.columns.slice(0, index).some((c) => c.from.length);
            const after = pair.columns.slice(index + 1).some((c) => c.from.length || c.to.length);
            const position = !before ? "initial" : !after ? "final" : "medial";
            if (column.to.length === 0) {
                bump(lostSyllables, `${position}|${column.from.join("")}`, { position, text: column.from.join("") }, example);
            } else {
                bump(gainedSyllables, `${position}|${column.to.join("")}`, { position, text: column.to.join("") }, example);
            }
        });

        const delta = pair.toSyllables - pair.fromSyllables;
        if (delta === 0) {
            same++;
            continue;
        }
        const side = delta < 0 ? "shorter" : "longer";
        delta < 0 ? shorter++ : longer++;

        const causes = new Set();
        for (const tag of pair.tags) {
            if (/syllable/.test(tag)) {
                causes.add(delta < 0 ? "a whole syllable was lost" : "a whole syllable was added");
            } else if (/syncope|apocope|aphaeresis|loss of a final consonant|loss of an initial consonant|elision/.test(tag) && delta < 0) {
                causes.add("a vowel was lost");
            } else if (/monophthong|coalescence|diphthong formation/.test(tag) && delta < 0) {
                causes.add("vowels ran together");
            } else if (/epenthesis|prothesis|paragoge|a vowel appears/.test(tag) && delta > 0) {
                causes.add("a vowel was added");
            } else if (/hiatus|diphthongization|breaking/.test(tag) && delta > 0) {
                causes.add("a diphthong split in two");
            }
        }
        if (!causes.size) {
            causes.add("something else");
        }
        for (const cause of causes) {
            bump(reasons[side], cause, { cause }, example);
        }
    }

    const list = (map) => [...map.values()].sort((p, q) => q.count - p.count);
    return {
        pairs: pairs.length,
        same,
        shorter,
        longer,
        crosstab: [...crosstab].map(([key, count]) => {
            const [from, to] = key.split("\u0000").map(Number);
            return { from, to, count };
        }).sort((p, q) => p.from - q.from || p.to - q.to),
        lostSyllables: list(lostSyllables),
        gainedSyllables: list(gainedSyllables),
        whyShorter: list(reasons.shorter),
        whyLonger: list(reasons.longer)
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
    if (f.fromParts.length === 2 && f.toParts.length === 2 && f.processes && f.processes.some((p) => p.startsWith("metathesis"))) {
        return "swap";
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
