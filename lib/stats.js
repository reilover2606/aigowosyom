"use strict";

// Per-language statistics for the dictionary's Statistics tab.

const { db } = require("./db");
const { fold } = require("./dictionary");

const LETTER = /\p{L}/u;
const LATIN = /[a-z]/;
const VOWELS = new Set(["a", "e", "i", "o", "u"]); // y counts as a consonant

const stmt = {
    words: db.prepare(`
        SELECT w.headword, w.pos, w.gender, w.pronunciation, w.etymology,
               (SELECT COUNT(*) FROM senses s WHERE s.word_id = w.id) AS sense_count,
               EXISTS (SELECT 1 FROM word_ancestry a WHERE a.word_id = w.id) AS has_ancestor
        FROM words w
        WHERE w.language_id = ?
    `),
    // Languages that words of this language descend from.
    sources: db.prepare(`
        SELECT l.slug, l.name, l.color, COUNT(DISTINCT a.word_id) AS n
        FROM word_ancestry a
        JOIN words w ON w.id = a.word_id
        JOIN words anc ON anc.id = a.ancestor_id
        JOIN languages l ON l.id = anc.language_id
        WHERE w.language_id = ?
        GROUP BY l.id
        ORDER BY n DESC, l.name COLLATE NOCASE
    `),
    // Other languages with words that descend from words of this language.
    influence: db.prepare(`
        SELECT l.slug, l.name, l.color, COUNT(DISTINCT a.word_id) AS n
        FROM word_ancestry a
        JOIN words anc ON anc.id = a.ancestor_id
        JOIN words w ON w.id = a.word_id
        JOIN languages l ON l.id = w.language_id
        WHERE anc.language_id = ? AND w.language_id != ?
        GROUP BY l.id
        ORDER BY n DESC, l.name COLLATE NOCASE
    `)
};

function median(sortedValues) {
    const n = sortedValues.length;

    if (n === 0) {
        return null;
    }

    const mid = Math.floor(n / 2);
    return n % 2 ? sortedValues[mid] : (sortedValues[mid - 1] + sortedValues[mid]) / 2;
}

function tally(map, key, by = 1) {
    map.set(key, (map.get(key) || 0) + by);
}

function byCount(map) {
    return [...map.entries()]
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

// "Letters" are the Unicode letters of the diacritic-folded headword, so
// digraphs like "kh" count as two letters. Consonant/vowel counts cover
// Latin letters only.
function languageStats(languageId) {
    const rows = stmt.words.all(languageId);

    const lengthCounts = new Map();
    const letterCounts = new Map();
    const posCounts = new Map();
    const genderCounts = new Map();
    const lengths = [];

    let letterTotal = 0;
    let vowels = 0;
    let consonants = 0;
    let senseTotal = 0;
    let withDefinition = 0;
    let withEtymology = 0;
    let withPronunciation = 0;
    let longest = null;
    let shortest = null;

    for (const row of rows) {
        let length = 0;

        for (const ch of fold(row.headword)) {
            if (!LETTER.test(ch)) {
                continue;
            }

            length++;
            tally(letterCounts, ch);

            if (LATIN.test(ch)) {
                if (VOWELS.has(ch)) {
                    vowels++;
                } else {
                    consonants++;
                }
            }
        }

        if (length > 0) {
            lengths.push(length);
            letterTotal += length;
            tally(lengthCounts, length);

            if (!longest || length > longest.length) {
                longest = { headword: row.headword, length };
            }
            if (!shortest || length < shortest.length) {
                shortest = { headword: row.headword, length };
            }
        }

        tally(posCounts, row.pos ? row.pos.toLowerCase() : null);
        if (row.gender) {
            tally(genderCounts, row.gender);
        }

        senseTotal += row.sense_count;
        withDefinition += row.sense_count > 0 ? 1 : 0;
        withEtymology += row.etymology || row.has_ancestor ? 1 : 0;
        withPronunciation += row.pronunciation ? 1 : 0;
    }

    lengths.sort((a, b) => a - b);

    // Histogram with no gaps between the shortest and longest length.
    const histogram = [];
    if (lengths.length) {
        for (let n = lengths[0]; n <= lengths[lengths.length - 1]; n++) {
            histogram.push({ label: String(n), count: lengthCounts.get(n) || 0 });
        }
    }

    const entries = rows.length;

    return {
        entries,
        avgLength: lengths.length ? letterTotal / lengths.length : null,
        medianLength: median(lengths),
        longest,
        shortest,
        vowels,
        consonants,
        avgSenses: entries ? senseTotal / entries : null,
        partsOfSpeech: byCount(posCounts), // label null = unspecified
        lengthHistogram: histogram,
        letters: byCount(letterCounts).map((item) => ({
            ...item,
            vowel: VOWELS.has(item.label)
        })),
        genders: byCount(genderCounts),
        completeness: { withDefinition, withEtymology, withPronunciation },
        sources: stmt.sources.all(languageId),
        influence: stmt.influence.all(languageId, languageId)
    };
}

module.exports = { languageStats };
