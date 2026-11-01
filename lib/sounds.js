"use strict";

// Letter-pair ("sound pattern") counts for a language's headwords: how often
// each letter is immediately followed by each other letter, plus word edges.
// This is orthographic, so a digraph like "kh" counts as the letters k, h.

const { db } = require("./db");
const { fold } = require("./dictionary");
const { CHART } = require("./ipa");
const phonology = require("./phonology");

const EDGE = "#"; // word boundary
const VOWELS = ["a", "e", "i", "o", "u"]; // y counts as a consonant
const GROUP = { vowel: 0, consonant: 1, other: 2 };

const stmt = db.prepare("SELECT headword FROM words WHERE language_id = ?");

function groupOf(unit) {
    const base = fold(unit).charAt(0);

    if (VOWELS.includes(base)) {
        return GROUP.vowel;
    }
    return /[a-z]/.test(base) ? GROUP.consonant : GROUP.other;
}

// Vowels first (a e i o u), then consonants, then everything else; accented
// variants sit right after their plain letter.
function compareUnits(a, b) {
    const ga = groupOf(a);
    const gb = groupOf(b);

    if (ga !== gb) {
        return ga - gb;
    }

    const ba = fold(a);
    const bb = fold(b);

    if (ba !== bb) {
        return ga === GROUP.vowel
            ? VOWELS.indexOf(ba.charAt(0)) - VOWELS.indexOf(bb.charAt(0)) || ba.localeCompare(bb)
            : ba.localeCompare(bb);
    }

    return a.localeCompare(b);
}

// The sound pairs of a language with a spelling set (see lib/phonology.js): the same grid, but
// of sounds, so a digraph is one sound and "k" and "kʰ" are different. Tones and stress marks are
// not segments and are left out of the grid. Words whose spelling isn't fully covered are skipped
// (`skipped` counts them).
function phonemePatterns(languageId) {
    const { phonemes, kinds } = phonology.compile(languageId);
    const index = new Map(phonemes.map((p, i) => [p.ipa, i]));
    const order = (list) => new Map(list.map(([key], i) => [key, i]));
    const manner = order(CHART.manners);
    const place = order(CHART.places);
    const height = order(CHART.heights);
    const backness = order(CHART.backnesses);
    const byIpa = new Map(phonemes.map((p) => [p.ipa, p]));

    // Vowels from close to open and front to back; consonants by manner, then place, voiceless first.
    const rank = (unit) => {
        const p = byIpa.get(unit);
        if (!p) {
            return [9, 0, 0, 0];
        }
        if (p.kind === "vowel") {
            return [0, height.get(p.height) ?? 99, backness.get(p.backness) ?? 9, p.rounded || 0];
        }
        return [1, manner.get(p.manner) ?? 99, place.get(p.place) ?? 99, p.voiced || 0];
    };
    const compare = (a, b) => {
        const ra = rank(a);
        const rb = rank(b);
        for (let i = 0; i < 4; i++) {
            if (ra[i] !== rb[i]) {
                return ra[i] - rb[i];
            }
        }
        return (index.get(a) ?? 0) - (index.get(b) ?? 0);
    };

    const sequences = [];
    let skipped = 0;
    for (const { headword } of stmt.all(languageId)) {
        const result = phonology.transcribe(languageId, headword);
        if (!result.complete) {
            skipped++;
            continue;
        }
        const segments = result.phonemes.filter((p) => kinds.get(p) === "consonant" || kinds.get(p) === "vowel");
        if (segments.length) {
            sequences.push(segments);
        }
    }

    const groupFor = (unit) => (kinds.get(unit) === "vowel" ? GROUP.vowel : GROUP.consonant);
    return { ...tabulate(sequences, compare, groupFor), skipped, mode: "sounds" };
}

// keepMarks: treat accented letters (ō) as distinct from plain ones (o).
// With mode "sounds" (and a spelling set for the language) the grid is of sounds, not letters.
function soundPatterns(languageId, { keepMarks = false, mode = "letters" } = {}) {
    if (mode === "sounds" && phonology.hasOrthography(languageId)) {
        return phonemePatterns(languageId);
    }
    const sequences = [];
    const owners = [];

    for (const [entry, row] of stmt.all(languageId).entries()) {
        const text = keepMarks ? row.headword.normalize("NFC").toLowerCase() : fold(row.headword);
        // Hyphens, spaces and other non-letters split a headword into parts.
        for (const part of text.split(/[^\p{L}\p{M}]+/u)) {
            const units = part.match(/\p{L}\p{M}*/gu);
            if (units) {
                sequences.push(units);
                owners.push(entry);
            }
        }
    }
    return { ...tabulate(sequences, compareUnits, groupOf, owners), skipped: 0, mode: "letters" };
}

// Counts how often each unit follows each other one (and begins and ends sequences).
// `owners` (optional, one per sequence: the entry it came from) lets an entry with several parts
// (a hyphenated headword) count as one word.
function tabulate(sequences, compareUnits, groupOf, owners = null) {
    const counts = new Map(); // "from\u0000to" -> count
    const letterSet = new Set();

    const bump = (from, to) => {
        const key = `${from}\u0000${to}`;
        counts.set(key, (counts.get(key) || 0) + 1);
    };

    sequences.forEach((units) => {
        units.forEach((unit) => letterSet.add(unit));
        const sequence = [EDGE, ...units, EDGE];
        for (let k = 0; k < sequence.length - 1; k++) {
            bump(sequence[k], sequence[k + 1]);
        }
    });
    const wordCount = owners ? new Set(owners).size : sequences.length;

    const letters = [...letterSet].sort(compareUnits);
    const rows = [EDGE, ...letters]; // what comes first
    const cols = [...letters, EDGE]; // what follows

    const cells = rows.map((from) =>
        cols.map((to) => counts.get(`${from}\u0000${to}`) || 0)
    );

    const vowelCount = letters.filter((l) => groupOf(l) === GROUP.vowel).length;
    const consonantCount = letters.filter((l) => groupOf(l) === GROUP.consonant).length;

    // Letter-to-letter pairs only (edges excluded) for the summary figures.
    let max = 0;
    let possible = 0;
    let unattested = 0;
    const pairs = [];

    cells.forEach((line, r) => {
        line.forEach((n, c) => {
            max = Math.max(max, n);

            if (r > 0 && c < letters.length) {
                possible++;
                if (n === 0) {
                    unattested++;
                } else {
                    pairs.push({ from: rows[r], to: cols[c], count: n });
                }
            }
        });
    });

    pairs.sort((a, b) => b.count - a.count || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

    return {
        wordCount,
        letters,
        rows,
        cols,
        cells,
        max,
        vowelCount,
        consonantCount,
        possible,
        unattested,
        topPairs: pairs.slice(0, 12),
        neverInitial: letters.filter((_, i) => cells[0][i] === 0),
        neverFinal: letters.filter((_, i) => cells[i + 1][cols.length - 1] === 0)
    };
}

module.exports = { soundPatterns, EDGE };
