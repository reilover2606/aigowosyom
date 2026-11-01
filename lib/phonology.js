"use strict";

// A language's sounds and spelling.
//
//  * The inventory: the phonemes (IPA) the language has: consonants, vowels, tones and stress marks.
//  * The orthography: which letters (graphemes) stand for which sounds. The spelling is taken to be
//    phonetic, so a word's sounds follow from its letters, longest match first ("kh" before "k").
//    A letter can have several rules, each with an optional context ("y is /j/ at the start of a word
//    but /ʲ/ after a consonant"); the first rule whose context fits is used, and a rule with no context
//    is the default.
//  * The prosody: which vowel groups are diphthongs, which consonant clusters may begin a syllable,
//    and where stress falls when the spelling doesn't say (lib/syllables.js).
//
// That gives every word a phonemic transcription with syllables and stress, lets the site check that
// every letter of a headword is accounted for, and lets related languages' words be compared sound by
// sound (lib/correspondences.js).

const { db } = require("./db");
const { HttpError } = require("./http");
const { featuresOf } = require("./ipa");
const { syllabify, render } = require("./syllables");

const stmt = {
    phonemes: db.prepare("SELECT * FROM language_phonemes WHERE language_id = ? ORDER BY position, id"),
    graphemes: db.prepare("SELECT * FROM language_graphemes WHERE language_id = ? ORDER BY position, id"),
    prosody: db.prepare("SELECT * FROM language_prosody WHERE language_id = ?"),
    clearPhonemes: db.prepare("DELETE FROM language_phonemes WHERE language_id = ?"),
    clearGraphemes: db.prepare("DELETE FROM language_graphemes WHERE language_id = ?"),
    clearProsody: db.prepare("DELETE FROM language_prosody WHERE language_id = ?"),
    insertPhoneme: db.prepare(`
        INSERT INTO language_phonemes (language_id, ipa, kind, label, place, manner, voiced, height, backness, rounded, position)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    insertGrapheme: db.prepare(`
        INSERT INTO language_graphemes (language_id, grapheme, ipa, note, where_pos, after_text, before_text, position)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    insertProsody: db.prepare(`
        INSERT INTO language_prosody (language_id, show_syllables, diphthongs, onsets, max_coda, stress_rule, stress_mark, skip_monosyllables, syllabic)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    headwords: db.prepare("SELECT headword FROM words WHERE language_id = ?"),
    languageExists: db.prepare("SELECT id FROM languages WHERE id = ?")
};

const KINDS = ["consonant", "vowel", "tone", "stress"];
const STRESS_RULES = ["none", "initial", "second", "penultimate", "antepenultimate", "final", "weight"];
const POSITIONS = ["start", "end"];

const compiled = new Map(); // languageId -> compiled data

const norm = (text) => String(text).normalize("NFC");

// A mark that goes on the sound before it (length, aspiration, palatalisation, nasalisation, ...).
const MARK_START = /^[ːˑʰʷʲˠˤʼ\p{M}]/u;

// ---- classes a context can name ("after a nasal") ----
const CLASSES = {
    consonant: (p) => p.kind === "consonant",
    vowel: (p) => p.kind === "vowel",
    nasal: (p) => p.manner === "nasal",
    plosive: (p) => p.manner === "plosive",
    stop: (p) => p.manner === "plosive" || p.manner === "affricate",
    affricate: (p) => p.manner === "affricate",
    fricative: (p) => p.manner === "fricative" || p.manner === "lateral fricative",
    approximant: (p) => p.manner === "approximant" || p.manner === "lateral approximant",
    lateral: (p) => p.manner === "lateral approximant" || p.manner === "lateral fricative",
    trill: (p) => p.manner === "trill",
    tap: (p) => p.manner === "tap",
    liquid: (p) => ["lateral approximant", "trill", "tap"].includes(p.manner) || p.ipa === "ɹ" || p.ipa === "ɻ",
    obstruent: (p) => ["plosive", "affricate", "fricative", "lateral fricative"].includes(p.manner),
    sonorant: (p) => p.kind === "vowel" || ["nasal", "approximant", "lateral approximant", "trill", "tap"].includes(p.manner),
    voiced: (p) => p.kind === "vowel" || p.voiced === 1,
    voiceless: (p) => p.kind === "consonant" && p.voiced === 0,
    labial: (p) => p.place === "bilabial" || p.place === "labiodental",
    coronal: (p) => ["dental", "alveolar", "postalveolar", "retroflex"].includes(p.place),
    palatal: (p) => p.place === "palatal",
    velar: (p) => p.place === "velar",
    front: (p) => p.backness === "front" && p.height !== "open", // not /a/: it is often central, and palatalizes nothing
    central: (p) => p.backness === "central",
    back: (p) => p.backness === "back",
    high: (p) => p.height === "close" || p.height === "near-close",
    low: (p) => p.height === "open" || p.height === "near-open",
    rounded: (p) => p.rounded === 1,
    unrounded: (p) => p.kind === "vowel" && p.rounded === 0
};

const CLASS_NAMES = Object.keys(CLASSES);

function getPhonology(languageId) {
    const prosody = stmt.prosody.get(languageId);
    return {
        phonemes: stmt.phonemes.all(languageId),
        graphemes: stmt.graphemes.all(languageId),
        prosody: prosody
            ? {
                show_syllables: prosody.show_syllables,
                diphthongs: prosody.diphthongs || "",
                onsets: prosody.onsets || "",
                max_coda: prosody.max_coda,
                stress_rule: prosody.stress_rule,
                stress_mark: prosody.stress_mark || "ˈ",
                skip_monosyllables: prosody.skip_monosyllables,
                syllabic: prosody.syllabic || ""
            }
            : { show_syllables: 0, diphthongs: "", onsets: "", max_coda: null, stress_rule: "none", stress_mark: "ˈ", skip_monosyllables: 1, syllabic: "" }
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

// "n, m" or "!consonant" -> { negate, tokens } (tokens: letters, sounds or class names).
function parseCondition(text) {
    const raw = (text || "").trim();
    const negate = raw.startsWith("!");
    const tokens = raw.replace(/^!/, "").split(/[,\s]+/).map((t) => norm(t.trim())).filter(Boolean);
    return { negate, tokens };
}

// Checks and tidies what the editor sends. Throws a 400 with a message the person can act on.
function normalize(data) {
    if (!data || typeof data !== "object" || !Array.isArray(data.phonemes) || !Array.isArray(data.graphemes)) {
        throw new HttpError(400, "Expected phonemes and graphemes");
    }
    if (data.phonemes.length > 250 || data.graphemes.length > 600) {
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
    const sounds = new Set(symbols);
    const letters = new Set();
    const rawGraphemes = [];

    for (const item of data.graphemes) {
        const grapheme = norm(cleanText(item && item.grapheme, "A letter", 12, { required: true })).toLowerCase();
        if (/\s/.test(grapheme)) {
            throw new HttpError(400, `“${grapheme}” has a space in it`);
        }
        letters.add(grapheme);
        rawGraphemes.push({ item, grapheme });
    }

    const graphemes = [];
    const seenRules = new Set();

    for (const { item, grapheme } of rawGraphemes) {
        const ipa = norm(cleanText(item.ipa, `The sound for “${grapheme}”`, 40, { required: true }));
        const silent = ipa === "∅";
        if (!silent && MARK_START.test(ipa)) {
            // A mark that joins the sound before it ("h" after n makes nʰ): something in the inventory has to end in it.
            if (!symbols.some((s) => s.endsWith(ipa) && s !== ipa) && !sounds.has(ipa)) {
                throw new HttpError(
                    400,
                    `“${grapheme}” is spelled ${ipa}, a mark that joins the sound before it, but no sound in the inventory ends in ${ipa}. Add sounds such as nʰ first.`
                );
            }
        } else if (!silent && !segment(ipa, symbols)) {
            throw new HttpError(
                400,
                `“${grapheme}” is spelled /${ipa}/, which isn't made of sounds in the inventory. Add the missing sound first.`
            );
        }

        const where = cleanText(item.where_pos, "Where", 10);
        if (where !== null && !POSITIONS.includes(where)) {
            throw new HttpError(400, `Where in the word must be start or end, not “${where}”`);
        }
        const after = cleanText(item.after_text, "After", 120);
        const before = cleanText(item.before_text, "Before", 120);

        for (const [label, text] of [["after", after], ["before", before]]) {
            for (const token of parseCondition(text).tokens) {
                if (!letters.has(token.toLowerCase()) && !sounds.has(token) && !CLASSES[token]) {
                    throw new HttpError(
                        400,
                        `For “${grapheme}”, “${token}” (${label}) isn't a letter of the spelling, a sound in the inventory or a class (${CLASS_NAMES.join(", ")})`
                    );
                }
            }
        }

        const key = [grapheme, ipa, where || "", after || "", before || ""].join("\u0000");
        if (seenRules.has(key)) {
            throw new HttpError(400, `The same rule for “${grapheme}” is listed twice`);
        }
        seenRules.add(key);
        graphemes.push({ grapheme, ipa, note: cleanText(item.note, "A note", 200), where_pos: where, after_text: after, before_text: before });
    }

    // Two plain rules for one letter would make the second unreachable.
    const plain = new Set();
    for (const g of graphemes) {
        if (!g.where_pos && !g.after_text && !g.before_text) {
            if (plain.has(g.grapheme)) {
                throw new HttpError(400, `“${g.grapheme}” has two rules with no context. Give one of them a context (or remove it).`);
            }
            plain.add(g.grapheme);
        }
    }

    return { phonemes, graphemes, prosody: normalizeProsody(data.prosody, phonemes) };
}

function normalizeProsody(input, phonemes) {
    const prosody = input && typeof input === "object" ? input : {};
    const byKind = (kind) => phonemes.filter((p) => p.kind === kind).map((p) => p.ipa);

    // Lists of clusters, each checked against the inventory: "pr, tr" -> [["p","r"], ["t","r"]].
    const clusters = (text, label, kind) => {
        const out = [];
        for (const word of (cleanText(text, label, 400) || "").split(/[,;\s]+/).filter(Boolean)) {
            const parts = segment(word, byKind(kind));
            if (!parts || parts.length < 2) {
                throw new HttpError(400, `${label}: “${word}” isn't two or more ${kind}s from the inventory`);
            }
            out.push(parts);
        }
        return out;
    };

    const diphthongs = clusters(prosody.diphthongs, "Diphthongs", "vowel");
    for (const d of diphthongs) {
        if (d.length !== 2) {
            throw new HttpError(400, `Diphthongs: “${d.join("")}” should be two vowels`);
        }
    }
    const onsets = clusters(prosody.onsets, "Onset clusters", "consonant");

    // Consonants that can be a syllable by themselves: each one has to be a consonant of the inventory.
    const syllabic = [];
    for (const word of (cleanText(prosody.syllabic, "Syllabic consonants", 200) || "").split(/[,;\s]+/).filter(Boolean)) {
        const symbol = norm(word);
        const found = phonemes.find((p) => p.ipa === symbol);
        if (!found || found.kind !== "consonant") {
            throw new HttpError(400, `Syllabic consonants: “${word}” isn't a consonant in the inventory`);
        }
        if (!syllabic.includes(symbol)) {
            syllabic.push(symbol);
        }
    }

    const rule = prosody.stress_rule || "none";
    if (!STRESS_RULES.includes(rule)) {
        throw new HttpError(400, "Unknown stress rule");
    }
    const mark = norm(cleanText(prosody.stress_mark, "The stress mark", 8) || "ˈ");
    if (rule !== "none") {
        const found = phonemes.find((p) => p.ipa === mark);
        if (!found || (found.kind !== "stress" && found.kind !== "tone")) {
            throw new HttpError(400, `Stress is placed with ${mark}, which needs to be in the inventory as a stress mark or a tone (see Sounds, Tones and stress).`);
        }
    }

    let maxCoda = null;
    if (prosody.max_coda !== null && prosody.max_coda !== undefined && prosody.max_coda !== "") {
        maxCoda = Number(prosody.max_coda);
        if (!Number.isInteger(maxCoda) || maxCoda < 0 || maxCoda > 6) {
            throw new HttpError(400, "The longest syllable ending must be a whole number from 0 to 6, or left empty");
        }
    }

    return {
        show_syllables: prosody.show_syllables ? 1 : 0,
        diphthongs: diphthongs.map((d) => d.join("")).join(" ") || null,
        onsets: onsets.map((o) => o.join("")).join(" ") || null,
        syllabic: syllabic.join(" ") || null,
        max_coda: maxCoda,
        stress_rule: rule,
        stress_mark: mark,
        skip_monosyllables: prosody.skip_monosyllables === 0 || prosody.skip_monosyllables === false ? 0 : 1
    };
}

// Replaces the language's inventory, spelling and prosody with what is given.
function savePhonology(languageId, data) {
    if (!stmt.languageExists.get(languageId)) {
        throw new HttpError(404, "Language not found");
    }
    const { phonemes, graphemes, prosody } = normalize(data);

    db.transaction(() => {
        stmt.clearGraphemes.run(languageId);
        stmt.clearPhonemes.run(languageId);
        stmt.clearProsody.run(languageId);
        phonemes.forEach((p, i) =>
            stmt.insertPhoneme.run(languageId, p.ipa, p.kind, p.label, p.place, p.manner, p.voiced, p.height, p.backness, p.rounded, i)
        );
        graphemes.forEach((g, i) =>
            stmt.insertGrapheme.run(languageId, g.grapheme, g.ipa, g.note, g.where_pos, g.after_text, g.before_text, i)
        );
        stmt.insertProsody.run(
            languageId, prosody.show_syllables, prosody.diphthongs, prosody.onsets, prosody.max_coda,
            prosody.stress_rule, prosody.stress_mark, prosody.skip_monosyllables, prosody.syllabic
        );
    })();

    compiled.delete(languageId);
    return getPhonology(languageId);
}

// ---- compiling: the data ready for reading words ----

function build({ phonemes, graphemes, prosody }) {
    const symbols = phonemes.map((p) => p.ipa);
    const byIpa = new Map(phonemes.map((p) => [p.ipa, p]));

    const rules = graphemes.map((g, index) => {
        const silent = g.ipa === "∅";
        const attach = !silent && MARK_START.test(g.ipa);
        return {
            index,
            grapheme: g.grapheme,
            ipa: g.ipa,
            note: g.note || null,
            silent,
            attach,
            phonemes: silent ? [] : attach ? [g.ipa] : segment(g.ipa, symbols) || [g.ipa],
            where: g.where_pos || null,
            after: g.after_text ? parseCondition(g.after_text) : null,
            before: g.before_text ? parseCondition(g.before_text) : null,
            conditioned: Boolean(g.where_pos || g.after_text || g.before_text)
        };
    });

    // Per letter: rules with a context first (in the order given), the plain one last.
    const byGrapheme = new Map();
    for (const rule of rules) {
        if (!byGrapheme.has(rule.grapheme)) {
            byGrapheme.set(rule.grapheme, []);
        }
        byGrapheme.get(rule.grapheme).push(rule);
    }
    for (const list of byGrapheme.values()) {
        list.sort((a, b) => Number(a.conditioned === false) - Number(b.conditioned === false) || a.index - b.index);
    }
    const letters = [...byGrapheme.keys()].sort((a, b) => b.length - a.length);

    const ofKind = (kind) => phonemes.filter((p) => p.kind === kind).map((p) => p.ipa);
    const clusterList = (text, kindSymbols) => (text || "").split(" ").filter(Boolean).map((word) => segment(word, kindSymbols) || []);

    return {
        symbols,
        phonemes,
        rules,
        byGrapheme,
        letters,
        byIpa,
        kinds: new Map(phonemes.map((p) => [p.ipa, p.kind])),
        prosody: {
            showSyllables: Boolean(prosody.show_syllables),
            diphthongs: clusterList(prosody.diphthongs, ofKind("vowel")),
            onsets: clusterList(prosody.onsets, ofKind("consonant")),
            syllabic: (prosody.syllabic || "").split(" ").filter(Boolean),
            maxCoda: prosody.max_coda === null || prosody.max_coda === undefined ? null : Number(prosody.max_coda),
            stressRule: prosody.stress_rule || "none",
            stressMark: prosody.stress_mark || "ˈ",
            skipMono: prosody.skip_monosyllables !== 0
        }
    };
}

function compile(languageId) {
    let entry = compiled.get(languageId);
    if (!entry) {
        entry = build(getPhonology(languageId));
        compiled.set(languageId, entry);
    }
    return entry;
}

function hasOrthography(languageId) {
    return compile(languageId).rules.length > 0;
}

// ---- reading a word ----

const isLetter = (char) => /[\p{L}\p{M}\p{N}]/u.test(char);

// Does a context token ("n", "ʃ", "nasal") fit this sound (and the letter it was written with)?
function tokenFits(token, sound, letter) {
    if (!sound && !letter) {
        return false;
    }
    if (letter && letter === token.toLowerCase()) {
        return true;
    }
    if (sound && sound.ipa === token) {
        return true;
    }
    return Boolean(sound && CLASSES[token] && CLASSES[token](sound));
}

function conditionFits(condition, sound, letter) {
    const fits = condition.tokens.some((token) => tokenFits(token, sound, letter));
    return condition.negate ? !fits : fits;
}

// What the letter at `at` would be, taking its plain rule (or the first), for "before" contexts.
function peek(data, text, at) {
    for (const g of data.letters) {
        if (text.startsWith(g, at)) {
            const rules = data.byGrapheme.get(g);
            const rule = rules.find((r) => !r.conditioned) || rules[0];
            const phoneme = rule.phonemes.length ? data.byIpa.get(rule.phonemes[0]) : null;
            return { letter: g, sound: phoneme };
        }
    }
    return null;
}

// A headword read letter by letter, with its syllables and stress.
//  units     { grapheme, rule } for each letter read (rule: index into the language's rules)
//  unknown   the letters nothing covers
//  phonemes  the sounds, as the spelling gives them (stress marks and tones written in it included)
//  syllables [{ phonemes, heavy }] when complete
//  surface   the transcription with syllable boundaries and stress, between slashes, when complete
function readWith(data, headword) {
    const text = norm(headword).toLowerCase().replace(/^\*/, "");
    const units = [];
    const unknown = [];
    const out = []; // { ipa, unit }
    let previous = null; // the last letter in this word: { grapheme, sound }

    let at = 0;
    while (at < text.length) {
        const boundaryBefore = at === 0 || !isLetter(text[at - 1]);
        if (boundaryBefore) {
            previous = null;
        }

        let used = null;
        for (const g of data.letters) {
            if (!text.startsWith(g, at)) {
                continue;
            }
            const end = at + g.length;
            const boundaryAfter = end >= text.length || !isLetter(text[end]);
            const next = boundaryAfter ? null : peek(data, text, end);

            const rule = data.byGrapheme.get(g).find((r) => {
                if (r.where === "start" && !boundaryBefore) {
                    return false;
                }
                if (r.where === "end" && !boundaryAfter) {
                    return false;
                }
                if (r.after && !conditionFits(r.after, previous && previous.sound, previous && previous.grapheme)) {
                    return false;
                }
                if (r.before && !conditionFits(r.before, next && next.sound, next && next.letter)) {
                    return false;
                }
                return true;
            });
            if (rule) {
                used = { rule, g };
                break;
            }
        }

        if (!used) {
            const char = String.fromCodePoint(text.codePointAt(at));
            at += char.length;
            if (isLetter(char)) {
                unknown.push(char);
            }
            continue;
        }

        const { rule, g } = used;
        at += g.length;
        const unit = { grapheme: g, rule: rule.index };
        units.push(unit);

        if (rule.attach) {
            // Joins the sound before it: n + ʰ = nʰ (which has to be in the inventory), or stands alone if it is.
            const last = out.length ? out[out.length - 1] : null;
            const joined = last ? last.ipa + rule.ipa : null;
            if (joined && data.byIpa.has(joined)) {
                last.ipa = joined;
            } else if (data.byIpa.has(rule.ipa)) {
                out.push({ ipa: rule.ipa, unit });
            } else {
                unknown.push(g);
            }
        } else {
            for (const ipa of rule.phonemes) {
                out.push({ ipa, unit });
            }
        }

        // For the next letter's "after": the last consonant or vowel of this word.
        const lastSegment = [...out].reverse().find((o) => ["consonant", "vowel"].includes((data.byIpa.get(o.ipa) || {}).kind));
        previous = { grapheme: g, sound: lastSegment ? data.byIpa.get(lastSegment.ipa) : null };
    }

    const phonemes = out.map((o) => o.ipa);
    const complete = data.rules.length > 0 && unknown.length === 0 && units.length > 0;

    let syllables = [];
    let surface = null;
    let stressedIndex = -1;
    if (complete) {
        const items = phonemes.map((ipa) => ({ ipa, kind: (data.byIpa.get(ipa) || {}).kind || "consonant" }));
        const p = data.prosody;
        const markKind = (data.byIpa.get(p.stressMark) || {}).kind;
        const result = syllabify(items, {
            diphthongs: p.diphthongs, onsets: p.onsets, maxCoda: p.maxCoda, syllabic: p.syllabic,
            stressRule: p.stressRule, stressMark: p.stressMark, skipMono: p.skipMono
        });
        syllables = result.syllables.map((s) => ({
            phonemes: s.segments.flatMap((seg) => [seg.ipa, ...seg.tones]),
            shape: s.shape,
            heavy: s.heavy
        }));
        stressedIndex = result.stressed;
        surface = `/${render(result, { dots: p.showSyllables, accentIsTone: markKind === "tone" })}/`;
    }

    return { units, unknown, phonemes, complete, syllables, stressedIndex, surface };
}

function transcribe(languageId, headword) {
    return readWith(compile(languageId), headword);
}

// Reads a word with data that isn't saved (the editor's "try a word"), after the same checks as saving.
function preview(data, headword) {
    return readWith(build(normalize(data)), headword);
}

function slashed(phonemes) {
    return `/${phonemes.join("")}/`;
}

// A report on how the language's words use its sounds and letters.
function analyze(languageId) {
    const data = compile(languageId);
    const { phonemes, rules, kinds } = data;
    const words = stmt.headwords.all(languageId);

    const phonemeCount = new Map();
    const phonemeWords = new Map();
    const ruleCount = new Map();
    const ruleExample = new Map();
    const shapes = new Map();
    const stressAt = new Map();
    const syllableCounts = new Map();
    const problems = [];
    let transcribed = 0;
    let totalPhonemes = 0;
    let consonants = 0;
    let vowels = 0;
    let tones = 0;
    let stresses = 0;

    for (const { headword } of words) {
        const result = readWith(data, headword);

        if (result.unknown.length) {
            problems.push({ headword, unknown: [...new Set(result.unknown)] });
        }
        for (const unit of result.units) {
            ruleCount.set(unit.rule, (ruleCount.get(unit.rule) || 0) + 1);
            if (!ruleExample.has(unit.rule) || headword.length < ruleExample.get(unit.rule).length) {
                ruleExample.set(unit.rule, headword);
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
            const n = result.syllables.length;
            syllableCounts.set(n, (syllableCounts.get(n) || 0) + 1);
            for (const s of result.syllables) {
                const shape = s.shape;
                shapes.set(shape, (shapes.get(shape) || 0) + 1);
            }
            if (n > 0 && result.stressedIndex >= 0) {
                const fromEnd = n - 1 - result.stressedIndex; // 0 = last syllable
                const label = n === 1 ? "only syllable" : fromEnd === 0 ? "last syllable" : fromEnd === 1 ? "second to last" : fromEnd === 2 ? "third to last" : "earlier";
                stressAt.set(label, (stressAt.get(label) || 0) + 1);
            }
        }
    }

    // A sound is "spelled" if some rule gives it, or a joining mark makes it (nʰ from n + h).
    const spelledPhonemes = new Set(rules.flatMap((r) => r.phonemes));
    for (const rule of rules) {
        if (rule.attach) {
            for (const p of phonemes) {
                if (p.ipa.endsWith(rule.ipa)) {
                    spelledPhonemes.add(p.ipa);
                }
            }
        }
    }

    const describe = (condition) => (condition ? `${condition.negate ? "not " : ""}${condition.tokens.join(", ")}` : null);

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
        // One row per spelling rule, in the order they were given.
        letterStats: rules.map((r) => ({
            grapheme: r.grapheme,
            ipa: r.ipa,
            where: r.where,
            after: describe(r.after),
            before: describe(r.before),
            note: r.note,
            count: ruleCount.get(r.index) || 0,
            example: ruleExample.get(r.index) || null
        })),
        syllableShapes: [...shapes].map(([shape, count]) => ({ shape, count })).sort((a, b) => b.count - a.count).slice(0, 14),
        syllableCounts: [...syllableCounts].map(([syllables, count]) => ({ syllables, count })).sort((a, b) => a.syllables - b.syllables),
        stressPositions: [...stressAt].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count),
        unspelled: phonemes.filter((p) => !spelledPhonemes.has(p.ipa)).map((p) => p.ipa)
    };
}

module.exports = {
    getPhonology, savePhonology, preview, segment, transcribe, hasOrthography, analyze, slashed, compile,
    CLASS_NAMES, CLASSES, STRESS_RULES
};
