"use strict";

// Letter-pair ("sound pattern") counts for a language's headwords: how often
// each letter is immediately followed by each other letter, plus word edges.
// This is orthographic, so a digraph like "kh" counts as the letters k, h.

const { db } = require("./db");
const { fold } = require("./dictionary");

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

// keepMarks: treat accented letters (ō) as distinct from plain ones (o).
function soundPatterns(languageId, { keepMarks = false } = {}) {
    const counts = new Map(); // "from\u0000to" -> count
    const letterSet = new Set();
    let wordCount = 0;

    const bump = (from, to) => {
        const key = `${from}\u0000${to}`;
        counts.set(key, (counts.get(key) || 0) + 1);
    };

    for (const row of stmt.all(languageId)) {
        const text = keepMarks ? row.headword.normalize("NFC").toLowerCase() : fold(row.headword);
        let counted = false;

        // Hyphens, spaces and other non-letters split a headword into parts.
        for (const part of text.split(/[^\p{L}\p{M}]+/u)) {
            const units = part.match(/\p{L}\p{M}*/gu);

            if (!units) {
                continue;
            }

            counted = true;
            const sequence = [EDGE, ...units, EDGE];
            units.forEach((unit) => letterSet.add(unit));

            for (let i = 0; i < sequence.length - 1; i++) {
                bump(sequence[i], sequence[i + 1]);
            }
        }

        wordCount += counted ? 1 : 0;
    }

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
