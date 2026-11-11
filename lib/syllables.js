"use strict";

// Syllables and stress for a word's sounds.
//
// Input: the word's phonemes in order, each as { ipa, kind } (kind: consonant, vowel, tone, stress),
// and the language's settings:
//   diphthongs   [[ "a", "i" ], ...]   vowel pairs that make one syllable nucleus (others are in hiatus);
//                a pair may carry a third item, { light, nonsyllabic }: light for a diphthong that doesn't make
//                its syllable heavy, nonsyllabic ("first" or "second") for the vowel written with ̯ (ai̯)
//   pitch        { anchors: [{ when, pitch }], before, between, after, fallback, markInitial } or null: pitch
//                accent by rule (see assignPitch); the changes are marked ꜛ (up) and ꜜ (down) before a syllable
//   onsets       [[ "p", "r" ], ...]   consonant clusters allowed to begin a syllable (any single consonant may)
//   maxCoda      number | null         most consonants a syllable may end in (null: no limit)
//   syllabic     ["n", "l", ...]       consonants that can be a syllable of their own
//   stressRule   none | initial | second | penultimate | antepenultimate | final | weight
//   stressMark   the symbol put on the stressed syllable (a stress mark goes before it; a tone mark after its vowel)
//   skipMono     leave one-syllable words unmarked
//
// Between two vowels the consonants are shared out by the maximal-onset principle: as many as may begin
// a syllable go with the next one, the rest close the one before. Stress marks already written in the
// spelling stay on the syllable they precede (they take priority, so a language can have a default
// rule and still mark the exceptions); the rule only places stress in a word that has none.

function syllabify(items, settings = {}) {
    const {
        diphthongs = [], onsets = [], maxCoda = null, syllabic = [],
        stressRule = "none", stressMark = "ˈ", skipMono = true, pitch = null
    } = settings;

    // 1. Pull out the stress marks (each belongs to the next sound, or the last if none follows) and let tones
    //    stay with the sound they follow.
    const segments = []; // { ipa, kind, tones: [], marks: [] }
    let pendingMarks = [];
    for (const item of items) {
        if (item.kind === "stress") {
            pendingMarks.push(item.ipa);
        } else if (item.kind === "tone") {
            if (segments.length) {
                segments[segments.length - 1].tones.push(item.ipa);
            }
        } else {
            segments.push({ ipa: item.ipa, kind: item.kind, tones: [], marks: pendingMarks });
            pendingMarks = [];
        }
    }
    if (pendingMarks.length && segments.length) {
        segments[segments.length - 1].marks.push(...pendingMarks);
    }

    if (segments.length === 0) {
        return { syllables: [], stressed: -1, explicit: false };
    }

    // 2. Nuclei: each vowel, or a diphthong's two vowels together, or a listed consonant with no vowel
    //    next to it (vlk, prst): it can't begin a syllable of a vowel or end one, so it carries one itself.
    //    (Of two listed consonants side by side only the first does.)
    const nuclei = []; // [start, end] segment indexes, end exclusive
    for (let i = 0; i < segments.length; i++) {
        const here = segments[i];
        if (here.kind === "consonant" && syllabic.includes(here.ipa)) {
            const before = segments[i - 1];
            const after = segments[i + 1];
            if (!(before && before.kind === "vowel") && !(after && after.kind === "vowel") && !(before && before.syllabic)) {
                here.syllabic = true;
                nuclei.push([i, i + 1]);
            }
            continue;
        }
        if (segments[i].kind !== "vowel") {
            continue;
        }
        const next = segments[i + 1];
        const pair = next && next.kind === "vowel" && diphthongs.find(([a, b]) => a === segments[i].ipa && b === next.ipa);
        if (pair) {
            const options = pair[2] || {};
            nuclei.push([i, i + 2, Boolean(options.light)]);
            if (options.nonsyllabic === "first") {
                segments[i].nonsyllabic = true;
            } else if (options.nonsyllabic === "second") {
                segments[i + 1].nonsyllabic = true;
            }
            i++;
        } else {
            nuclei.push([i, i + 1]);
        }
    }

    // 3. Boundaries: where each syllable starts.
    const starts = [0];
    for (let n = 0; n + 1 < nuclei.length; n++) {
        const clusterStart = nuclei[n][1];
        const clusterEnd = nuclei[n + 1][0];
        const cluster = segments.slice(clusterStart, clusterEnd).map((s) => s.ipa);

        // The longest ending of the cluster that may begin a syllable (one consonant always may).
        let onsetLength = cluster.length === 0 ? 0 : 1;
        for (let length = cluster.length; length >= 2; length--) {
            const tail = cluster.slice(cluster.length - length);
            if (onsets.some((o) => o.length === length && o.every((x, k) => x === tail[k]))) {
                onsetLength = length;
                break;
            }
        }
        // Too many left over for a coda: let the next syllable have more.
        if (maxCoda !== null && cluster.length - onsetLength > maxCoda) {
            onsetLength = cluster.length - maxCoda;
        }
        starts.push(clusterEnd - onsetLength);
    }

    const syllables = starts.map((start, i) => {
        const end = i + 1 < starts.length ? starts[i + 1] : segments.length;
        const parts = segments.slice(start, end);
        const nucleus = nuclei[i] || [start, start];
        const shape = parts.map((s, k) => (s.kind === "vowel" ? "V" : s.syllabic ? "C\u0329" : "C")).join("");
        const long = parts.some((s) => s.kind === "vowel" && s.ipa.includes("ː"));
        const diphthong = nucleus[1] - nucleus[0] > 1;
        const closed = end > nucleus[1];
        return {
            segments: parts,
            shape,
            marks: parts.flatMap((s) => s.marks),
            // The two vowels of a diphthong nucleus, or null.
            diphthong: diphthong ? [segments[nucleus[0]].ipa, segments[nucleus[0] + 1].ipa] : null,
            long,
            closed,
            heavy: closed || long || (diphthong && !nucleus[2])
        };
    });

    // 4. Stress: marks in the spelling win; otherwise the language's rule.
    let stressed = syllables.findIndex((s) => s.marks.includes("ˈ"));
    const explicit = syllables.some((s) => s.marks.length > 0);
    if (stressed < 0 && explicit) {
        stressed = syllables.findIndex((s) => s.marks.length > 0);
    }
    let placed = null;
    if (!explicit && stressRule !== "none" && !(skipMono && syllables.length === 1)) {
        const n = syllables.length;
        const choice = {
            initial: 0,
            second: 1,
            penultimate: n - 2,
            antepenultimate: n - 3,
            final: n - 1,
            weight: n >= 3 ? (syllables[n - 2].heavy ? n - 2 : n - 3) : 0
        }[stressRule];
        if (choice !== undefined) {
            stressed = Math.max(0, Math.min(n - 1, choice));
            placed = stressMark;
        }
    }

    // 5. Pitch accent by rule, unless the spelling writes tones itself.
    const written = segments.some((s) => s.tones.length > 0);
    const pitches = pitch && !written && !(skipMono && syllables.length === 1) ? assignPitch(syllables, stressed, pitch) : null;
    const pitchMarks = pitches ? pitchChanges(pitches, Boolean(pitch.markInitial)) : null;

    return { syllables, stressed, explicit, placed, pitches, pitchMarks };
}

// Which syllables a pitch rule can pin ("when").
const PITCH_CONDITIONS = {
    long: (s) => s.long,
    diphthong: (s) => Boolean(s.diphthong),
    "long-or-diphthong": (s) => s.long || Boolean(s.diphthong),
    heavy: (s) => s.heavy,
    closed: (s) => s.closed,
    stressed: (s, i, n, stressed) => i === stressed,
    first: (s, i) => i === 0,
    last: (s, i, n) => i === n - 1
};

// High or low for each syllable. Syllables that match an anchor rule are pinned to its pitch (the
// first rule that matches decides). The others are set by where they stand: before the first pinned
// one, between pinned ones, or after the last. A word with no pinned syllable follows `fallback`:
// none (no pitch marking), low, high, initial-high, final-high, penultimate-high.
function assignPitch(syllables, stressed, rules) {
    const n = syllables.length;
    const pinned = syllables.map((s, i) => {
        const rule = (rules.anchors || []).find((r) => PITCH_CONDITIONS[r.when] && PITCH_CONDITIONS[r.when](s, i, n, stressed));
        return rule ? rule.pitch : null;
    });
    const firstPinned = pinned.findIndex((p) => p !== null);

    if (firstPinned < 0) {
        const mode = rules.fallback || "none";
        const high = { low: [], high: [...Array(n).keys()], "initial-high": [0], "final-high": [n - 1], "penultimate-high": [Math.max(0, n - 2)] }[mode];
        return high ? syllables.map((s, i) => (high.includes(i) ? "H" : "L")) : null;
    }

    const lastPinned = pinned.length - 1 - [...pinned].reverse().findIndex((p) => p !== null);
    return pinned.map((p, i) => p || (i < firstPinned ? rules.before : i > lastPinned ? rules.after : rules.between) || "L");
}

// ꜛ before a syllable that is higher than the one before it, ꜜ before one that is lower. The first
// syllable has nothing before it, so it is only marked (ꜛ, when high) if `markInitial`.
function pitchChanges(pitches, markInitial) {
    return pitches.map((pitch, i) => {
        if (i === 0) {
            return markInitial && pitch === "H" ? "ꜛ" : "";
        }
        return pitch === pitches[i - 1] ? "" : pitch === "H" ? "ꜛ" : "ꜜ";
    });
}

// The IPA string for a syllabified word: syllables joined with dots (when asked), stress marks before
// the syllable they fall on, a tone-type accent mark after its first vowel.
function render({ syllables, stressed, explicit, placed, pitchMarks }, { dots = false, accentIsTone = false } = {}) {
    const text = syllables.map((s, index) => {
        let body = "";
        let accentDone = false;
        const rule = !explicit && index === stressed && placed;
        for (const seg of s.segments) {
            // ̩ marks a syllabic consonant, ̯ a nonsyllabic vowel (the second part of ai̯)
            body += seg.ipa + (seg.syllabic ? "\u0329" : "") + (seg.nonsyllabic ? "\u032f" : "") + seg.tones.join("");
            if (rule && accentIsTone && !accentDone && seg.kind === "vowel") {
                body += placed;
                accentDone = true;
            }
        }
        const lead = rule && !accentIsTone ? placed : "";
        const written = s.segments.flatMap((seg) => seg.marks).join("");
        return { lead: lead || written, body, pitch: (pitchMarks && pitchMarks[index]) || "" };
    });

    let out = "";
    text.forEach((s, i) => {
        if (i > 0 && dots && !s.lead) {
            out += ".";
        }
        out += s.lead + s.pitch + s.body;
    });
    return out;
}

module.exports = { syllabify, render, PITCH_CONDITIONS };
