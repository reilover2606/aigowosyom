"use strict";

// A small reference of IPA symbols with their features, used to lay out a language's phoneme
// inventory as consonant and vowel charts and to judge how alike two sounds are. Symbols that
// aren't here can still be added to a language (as "other" sounds); this is only a convenience.

// Consonants: columns (places) and rows (manners), as on the IPA chart.
const PLACES = [
    ["bilabial", "Bilabial"],
    ["labiodental", "Labio-dental"],
    ["dental", "Dental"],
    ["alveolar", "Alveolar"],
    ["postalveolar", "Post-alveolar"],
    ["retroflex", "Retroflex"],
    ["palatal", "Palatal"],
    ["velar", "Velar"],
    ["uvular", "Uvular"],
    ["pharyngeal", "Pharyngeal"],
    ["glottal", "Glottal"]
];

const MANNERS = [
    ["nasal", "Nasal"],
    ["plosive", "Plosive"],
    ["affricate", "Affricate"],
    ["fricative", "Fricative"],
    ["lateral fricative", "Lateral fricative"],
    ["approximant", "Approximant"],
    ["lateral approximant", "Lateral approximant"],
    ["tap", "Tap"],
    ["trill", "Trill"]
];

// [symbol, place, manner, voiced]
const CONSONANTS = [
    ["m", "bilabial", "nasal", 1], ["ɱ", "labiodental", "nasal", 1], ["n", "alveolar", "nasal", 1],
    ["ɳ", "retroflex", "nasal", 1], ["ɲ", "palatal", "nasal", 1], ["ŋ", "velar", "nasal", 1], ["ɴ", "uvular", "nasal", 1],

    ["p", "bilabial", "plosive", 0], ["b", "bilabial", "plosive", 1],
    ["t̪", "dental", "plosive", 0], ["d̪", "dental", "plosive", 1],
    ["t", "alveolar", "plosive", 0], ["d", "alveolar", "plosive", 1],
    ["ʈ", "retroflex", "plosive", 0], ["ɖ", "retroflex", "plosive", 1],
    ["c", "palatal", "plosive", 0], ["ɟ", "palatal", "plosive", 1],
    ["k", "velar", "plosive", 0], ["ɡ", "velar", "plosive", 1],
    ["q", "uvular", "plosive", 0], ["ɢ", "uvular", "plosive", 1],
    ["ʔ", "glottal", "plosive", 0],

    ["t͡s", "alveolar", "affricate", 0], ["d͡z", "alveolar", "affricate", 1],
    ["t͡ʃ", "postalveolar", "affricate", 0], ["d͡ʒ", "postalveolar", "affricate", 1],
    ["t͡ɕ", "palatal", "affricate", 0], ["d͡ʑ", "palatal", "affricate", 1],
    ["p͡f", "labiodental", "affricate", 0],

    ["ɸ", "bilabial", "fricative", 0], ["β", "bilabial", "fricative", 1],
    ["f", "labiodental", "fricative", 0], ["v", "labiodental", "fricative", 1],
    ["θ", "dental", "fricative", 0], ["ð", "dental", "fricative", 1],
    ["s", "alveolar", "fricative", 0], ["z", "alveolar", "fricative", 1],
    ["ʃ", "postalveolar", "fricative", 0], ["ʒ", "postalveolar", "fricative", 1],
    ["ʂ", "retroflex", "fricative", 0], ["ʐ", "retroflex", "fricative", 1],
    ["ɕ", "palatal", "fricative", 0], ["ʑ", "palatal", "fricative", 1],
    ["ç", "palatal", "fricative", 0], ["ʝ", "palatal", "fricative", 1],
    ["x", "velar", "fricative", 0], ["ɣ", "velar", "fricative", 1],
    ["χ", "uvular", "fricative", 0], ["ʁ", "uvular", "fricative", 1],
    ["ħ", "pharyngeal", "fricative", 0], ["ʕ", "pharyngeal", "fricative", 1],
    ["h", "glottal", "fricative", 0], ["ɦ", "glottal", "fricative", 1],

    ["ɬ", "alveolar", "lateral fricative", 0], ["ɮ", "alveolar", "lateral fricative", 1],

    ["ʋ", "labiodental", "approximant", 1], ["ɹ", "alveolar", "approximant", 1], ["ɻ", "retroflex", "approximant", 1],
    ["j", "palatal", "approximant", 1], ["ɰ", "velar", "approximant", 1],
    ["w", "velar", "approximant", 1], ["ɥ", "palatal", "approximant", 1],

    ["l", "alveolar", "lateral approximant", 1], ["ɭ", "retroflex", "lateral approximant", 1],
    ["ʎ", "palatal", "lateral approximant", 1], ["ʟ", "velar", "lateral approximant", 1],

    ["ⱱ", "labiodental", "tap", 1], ["ɾ", "alveolar", "tap", 1], ["ɽ", "retroflex", "tap", 1],

    ["ʙ", "bilabial", "trill", 1], ["r", "alveolar", "trill", 1], ["ʀ", "uvular", "trill", 1]
];

// Vowels: rows (heights) and columns (backness), as on the vowel chart.
const HEIGHTS = [
    ["close", "Close"],
    ["near-close", "Near-close"],
    ["close-mid", "Close-mid"],
    ["mid", "Mid"],
    ["open-mid", "Open-mid"],
    ["near-open", "Near-open"],
    ["open", "Open"]
];

const BACKNESSES = [
    ["front", "Front"],
    ["central", "Central"],
    ["back", "Back"]
];

// [symbol, height, backness, rounded]
const VOWELS = [
    ["i", "close", "front", 0], ["y", "close", "front", 1], ["ɨ", "close", "central", 0], ["ʉ", "close", "central", 1],
    ["ɯ", "close", "back", 0], ["u", "close", "back", 1],
    ["ɪ", "near-close", "front", 0], ["ʏ", "near-close", "front", 1], ["ʊ", "near-close", "back", 1],
    ["e", "close-mid", "front", 0], ["ø", "close-mid", "front", 1], ["ɘ", "close-mid", "central", 0],
    ["ɵ", "close-mid", "central", 1], ["ɤ", "close-mid", "back", 0], ["o", "close-mid", "back", 1],
    ["ə", "mid", "central", 0],
    ["ɛ", "open-mid", "front", 0], ["œ", "open-mid", "front", 1], ["ɜ", "open-mid", "central", 0],
    ["ɞ", "open-mid", "central", 1], ["ʌ", "open-mid", "back", 0], ["ɔ", "open-mid", "back", 1],
    ["æ", "near-open", "front", 0], ["ɐ", "near-open", "central", 0],
    ["a", "open", "front", 0], ["ɶ", "open", "front", 1], ["ɑ", "open", "back", 0], ["ɒ", "open", "back", 1]
];

// Tones and stress. Tones are written with Chao tone letters (˥ high ... ˩ low; two or three in a
// row for a contour) or any mark the language uses; "stress" marks go before the syllable they fall on.
// They are not sounds: they are kept out of the consonant/vowel counts and the sound-pair grid.
const TONES = [
    ["˥", "high"], ["˦", "mid-high"], ["˧", "mid"], ["˨", "mid-low"], ["˩", "low"],
    ["˧˥", "rising"], ["˩˥", "low rising"], ["˥˩", "falling"], ["˥˧", "high falling"], ["˧˩", "low falling"],
    ["˨˩˦", "dipping"], ["˧˥˧", "peaking"]
];
const STRESS = [["ˈ", "primary stress"], ["ˌ", "secondary stress"]];

// Suffix marks that can follow a base symbol (long, aspirated, nasalised, ...).
const MODIFIERS = ["ː", "ˑ", "ʰ", "ʷ", "ʲ", "ˠ", "ˤ", "ʼ", "̃", "̥", "̤", "̰", "̚", "̪"];

const consonantBySymbol = new Map(CONSONANTS.map(([ipa, place, manner, voiced]) => [ipa, { kind: "consonant", place, manner, voiced }]));
const vowelBySymbol = new Map(VOWELS.map(([ipa, height, backness, rounded]) => [ipa, { kind: "vowel", height, backness, rounded }]));

// What is known about a symbol: itself if it is on the chart, else its first character with
// marks (length, aspiration, ...) stripped, else null.
function featuresOf(ipa) {
    const tone = TONES.find(([symbol]) => symbol === ipa);
    if (tone) {
        return { kind: "tone", label: tone[1] };
    }
    const stress = STRESS.find(([symbol]) => symbol === ipa);
    if (stress) {
        return { kind: "stress", label: stress[1] };
    }
    const direct = consonantBySymbol.get(ipa) || vowelBySymbol.get(ipa);
    if (direct) {
        return { ...direct };
    }
    const base = ipa.normalize("NFD").replace(/[ːˑʰʷʲˠˤʼ̀-͛͝-͢͠-ͯ]/g, "");
    const known = consonantBySymbol.get(base) || vowelBySymbol.get(base)
        || consonantBySymbol.get(base.normalize("NFC")) || vowelBySymbol.get(base.normalize("NFC"));
    return known ? { ...known } : null;
}

// How alike two sounds are, from -1 (nothing in common) to 1 (identical features).
// Used to line up the sounds of related words.
function similarity(a, b) {
    if (a === b) {
        return 1;
    }
    const fa = featuresOf(a);
    const fb = featuresOf(b);
    if (!fa || !fb) {
        return -0.6;
    }
    if (fa.kind !== fb.kind) {
        return -1;
    }
    if (fa.kind === "tone" || fa.kind === "stress") {
        return -0.3; // different tones: the same sort of thing, but not alike
    }
    const keys = fa.kind === "vowel" ? ["height", "backness", "rounded"] : ["place", "manner", "voiced"];
    const same = keys.filter((k) => fa[k] === fb[k]).length;
    return -0.5 + (same / keys.length) * 1.4; // 0.9 at most for sounds that differ only by a mark
}

// The chart layouts, for the editor and the public pages.
const CHART = {
    places: PLACES,
    manners: MANNERS,
    heights: HEIGHTS,
    backnesses: BACKNESSES,
    consonants: CONSONANTS.map(([ipa, place, manner, voiced]) => ({ ipa, kind: "consonant", place, manner, voiced })),
    vowels: VOWELS.map(([ipa, height, backness, rounded]) => ({ ipa, kind: "vowel", height, backness, rounded })),
    tones: TONES.map(([ipa, label]) => ({ ipa, kind: "tone", label })),
    stress: STRESS.map(([ipa, label]) => ({ ipa, kind: "stress", label })),
    modifiers: MODIFIERS
};

module.exports = { CHART, featuresOf, similarity };
