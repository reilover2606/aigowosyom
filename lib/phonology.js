"use strict";

// A language's sounds and spelling.
//
//  * The inventory: the phonemes (IPA) the language has, as consonants and vowels.
//  * The orthography: which letters (graphemes) stand for which phonemes. The spelling is taken to
//    be phonetic, so a word's sounds follow from its letters, longest match first ("kh" before
//    "k"). That gives every word a phonemic transcription, lets the site check that every letter
//    in a headword is accounted for, and lets related languages' words be compared sound by sound
//    (lib/correspondences.js).

const { db } = require("./db");
const { HttpError } = require("./http");
const { featuresOf } = require("./ipa");

const stmt = {
    phonemes: db.prepare("SELECT * FROM language_phonemes WHERE language_id = ? ORDER BY position, id"),
    graphemes: db.prepare("SELECT * FROM language_graphemes WHERE language_id = ? ORDER BY position, id"),
    clearPhonemes: db.prepare("DELETE FROM language_phonemes WHERE language_id = ?"),
    clearGraphemes: db.prepare("DELETE FROM language_graphemes WHERE language_id = ?"),
    insertPhoneme: db.prepare(`
        INSERT INTO language_phonemes (language_id, ipa, kind, label, place, manner, voiced, height, backness, rounded, position)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    insertGrapheme: db.prepare(
        "INSERT INTO language_graphemes (language_id, grapheme, ipa, note, position) VALUES (?, ?, ?, ?, ?)"
    ),
    headwords: db.prepare("SELECT headword FROM words WHERE language_id = ?"),
    languageExists: db.prepare("SELECT id FROM languages WHERE id = ?")
};

const KINDS = ["consonant", "vowel", "tone", "stress"];

const compiled = new Map(); // languageId -> compiled orthography

const norm = (text) => String(text).normalize("NFC");

function getPhonology(languageId) {
    return {
        phonemes: stmt.phonemes.all(languageId),
        graphemes: stmt.graphemes.all(languageId)
    };
}

// Splits a string of IPA into inventory phonemes, preferring the longest symbol at each point.
// Returns the list, or null if some part isn't in the inventory.
function segment(ipa, symbols) {
    const text = norm(ipa);
    const memo = new Map();
    const longest = [...symbols].sort((a, b) => b.length - a.length);

    const from = (at) => {
        if (at === text.length) {
            return [];
        }
        if (memo.has(at)) {
            return memo.get(at);
        }
        let found = null;
        for (const symbol of longest) {
            if (text.startsWith(symbol, at)) {
                const rest = from(at + symbol.length);
                if (rest) {
                    found = [symbol, ...rest];
                    break;
                }
            }
        }
        memo.set(at, found);
        return found;
    };

    return text.length ? from(0) : null;
}

function cleanText(value, label, max, { required = false } = {}) {
    if (value === undefined || value === null || value === "") {
        if (required) {
            throw new HttpError(400, `${label} is required`);
        }
        return null;
    }
    if (typeof value !== "string") {
        throw new HttpError(400, `${label} must be text`);
    }
    const trimmed = value.trim();
    if (!trimmed && required) {
        throw new HttpError(400, `${label} is required`);
    }
    if (trimmed.length > max) {
        throw new HttpError(400, `${label} is too long`);
    }
    return trimmed || null;
}

// Replaces the language's inventory and spelling with what is given:
// { phonemes: [{ ipa, kind?, place?, ... }], graphemes: [{ grapheme, ipa, note? }] }.
function savePhonology(languageId, data) {
    if (!stmt.languageExists.get(languageId)) {
        throw new HttpError(404, "Language not found");
    }
    if (!data || typeof data !== "object" || !Array.isArray(data.phonemes) || !Array.isArray(data.graphemes)) {
        throw new HttpError(400, "Expected phonemes and graphemes");
    }
    if (data.phonemes.length > 200 || data.graphemes.length > 400) {
        throw new HttpError(400, "That is more sounds or letters than expected");
    }

    const phonemes = [];
    const seen = new Set();

    for (const item of data.phonemes) {
        const ipa = norm(cleanText(item && item.ipa, "A phoneme", 12, { required: true }));
        if (/\s/.test(ipa)) {
            throw new HttpError(400, `“${ipa}” has a space in it`);
        }
        if (seen.has(ipa)) {
            throw new HttpError(400, `The phoneme /${ipa}/ is listed twice`);
        }
        seen.add(ipa);

        const known = featuresOf(ipa) || {};
        const kind = KINDS.includes(item.kind) ? item.kind : known.kind;
        if (!kind) {
            throw new HttpError(400, `Say whether /${ipa}/ is a consonant, a vowel, a tone or a stress mark`);
        }
        const pick = (key, max = 30) => {
            const given = cleanText(item[key], key, max);
            return given !== null ? given : known.kind === kind && known[key] !== undefined ? known[key] : null;
        };
        const flag = (key) => {
            const given = item[key];
            if (given === 0 || given === 1 || given === true || given === false) {
                return given ? 1 : 0;
            }
            return known.kind === kind && known[key] !== undefined ? known[key] : null;
        };

        phonemes.push({
            ipa, kind,
            label: cleanText(item.label, "A label", 40) || (known.kind === kind && known.label) || null,
            place: kind === "consonant" ? pick("place") : null,
            manner: kind === "consonant" ? pick("manner") : null,
            voiced: kind === "consonant" ? flag("voiced") : null,
            height: kind === "vowel" ? pick("height") : null,
            backness: kind === "vowel" ? pick("backness") : null,
            rounded: kind === "vowel" ? flag("rounded") : null
        });
    }

    const symbols = phonemes.map((p) => p.ipa);
    const graphemes = [];
    const spelled = new Set();

    for (const item of data.graphemes) {
        const grapheme = norm(cleanText(item && item.grapheme, "A letter", 12, { required: true })).toLowerCase();
        if (/\s/.test(grapheme)) {
            throw new HttpError(400, `“${grapheme}” has a space in it`);
        }
        if (spelled.has(grapheme)) {
            throw new HttpError(400, `The letter “${grapheme}” is listed twice`);
        }
        spelled.add(grapheme);

        const ipa = norm(cleanText(item.ipa, `The sound for “${grapheme}”`, 40, { required: true }));
        if (!segment(ipa, symbols)) {
            throw new HttpError(
                400,
                `“${grapheme}” is spelled /${ipa}/, which isn't made of sounds in the inventory. Add the missing sound first.`
            );
        }
        graphemes.push({ grapheme, ipa, note: cleanText(item.note, "A note", 200) });
    }

    db.transaction(() => {
        stmt.clearGraphemes.run(languageId);
        stmt.clearPhonemes.run(languageId);
        phonemes.forEach((p, i) =>
            stmt.insertPhoneme.run(languageId, p.ipa, p.kind, p.label, p.place, p.manner, p.voiced, p.height, p.backness, p.rounded, i)
        );
        graphemes.forEach((g, i) => stmt.insertGrapheme.run(languageId, g.grapheme, g.ipa, g.note, i));
    })();

    compiled.delete(languageId);
    return getPhonology(languageId);
}

// The orthography ready for matching: letters longest first, each with its phonemes.
function compile(languageId) {
    let entry = compiled.get(languageId);
    if (!entry) {
        const { phonemes, graphemes } = getPhonology(languageId);
        const symbols = phonemes.map((p) => p.ipa);
        const rules = graphemes
            .map((g) => ({ grapheme: g.grapheme, ipa: g.ipa, phonemes: segment(g.ipa, symbols) || [g.ipa] }))
            .sort((a, b) => b.grapheme.length - a.grapheme.length);
        entry = { symbols, phonemes, rules, kinds: new Map(phonemes.map((p) => [p.ipa, p.kind])) };
        compiled.set(languageId, entry);
    }
    return entry;
}

function hasOrthography(languageId) {
    return compile(languageId).rules.length > 0;
}

// A headword read letter by letter. `units` are { grapheme, phonemes }; `unknown` the letters no
// rule covers. Spaces, hyphens and apostrophes only separate parts; they are not sounds.
function transcribe(languageId, headword) {
    const { rules } = compile(languageId);
    const text = norm(headword).toLowerCase().replace(/^\*/, "");
    const units = [];
    const unknown = [];

    let at = 0;
    while (at < text.length) {
        const rule = rules.find((r) => text.startsWith(r.grapheme, at));
        if (rule) {
            units.push({ grapheme: rule.grapheme, phonemes: rule.phonemes });
            at += rule.grapheme.length;
            continue;
        }
        const char = String.fromCodePoint(text.codePointAt(at));
        at += char.length;
        if (/[\p{L}\p{M}\p{N}]/u.test(char)) {
            unknown.push(char);
        }
    }

    return {
        units,
        unknown,
        phonemes: units.flatMap((u) => u.phonemes),
        complete: rules.length > 0 && unknown.length === 0 && units.length > 0
    };
}

function slashed(phonemes) {
    return `/${phonemes.join("")}/`;
}

// A report on how the language's words use its sounds and letters.
function analyze(languageId) {
    const { phonemes, rules, kinds } = compile(languageId);
    const words = stmt.headwords.all(languageId);

    const phonemeCount = new Map();
    const phonemeWords = new Map();
    const letterCount = new Map();
    const letterExample = new Map();
    const problems = [];
    let transcribed = 0;
    let totalPhonemes = 0;
    let consonants = 0;
    let vowels = 0;
    let tones = 0;
    let stresses = 0;

    for (const { headword } of words) {
        const result = transcribe(languageId, headword);

        if (result.unknown.length) {
            problems.push({ headword, unknown: [...new Set(result.unknown)] });
        }
        for (const unit of result.units) {
            letterCount.set(unit.grapheme, (letterCount.get(unit.grapheme) || 0) + 1);
            if (!letterExample.has(unit.grapheme) || headword.length < letterExample.get(unit.grapheme).length) {
                letterExample.set(unit.grapheme, headword);
            }
        }
        const inWord = new Set();
        for (const p of result.phonemes) {
            phonemeCount.set(p, (phonemeCount.get(p) || 0) + 1);
            inWord.add(p);
            totalPhonemes++;
            const kind = kinds.get(p);
            if (kind === "vowel") {
                vowels++;
            } else if (kind === "consonant") {
                consonants++;
            } else if (kind === "tone") {
                tones++;
            } else if (kind === "stress") {
                stresses++;
            }
        }
        for (const p of inWord) {
            phonemeWords.set(p, (phonemeWords.get(p) || 0) + 1);
        }
        if (result.complete) {
            transcribed++;
        }
    }

    const spelledPhonemes = new Set(rules.flatMap((r) => r.phonemes));

    return {
        wordCount: words.length,
        transcribed,
        problems: problems.sort((a, b) => a.headword.localeCompare(b.headword)),
        totalPhonemes,
        consonants,
        vowels,
        tones,
        stresses,
        phonemeStats: phonemes.map((p) => ({
            ipa: p.ipa,
            kind: p.kind,
            count: phonemeCount.get(p.ipa) || 0,
            words: phonemeWords.get(p.ipa) || 0,
            spelled: spelledPhonemes.has(p.ipa)
        })),
        letterStats: rules.map((r) => ({
            grapheme: r.grapheme,
            ipa: r.ipa,
            count: letterCount.get(r.grapheme) || 0,
            example: letterExample.get(r.grapheme) || null
        })),
        unspelled: phonemes.filter((p) => !spelledPhonemes.has(p.ipa)).map((p) => p.ipa)
    };
}

module.exports = { getPhonology, savePhonology, segment, transcribe, hasOrthography, analyze, slashed, compile };
