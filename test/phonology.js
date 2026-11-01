"use strict";

// Checks the phoneme / spelling model and the sound correspondences, on a throw-away database.
// Run with: node test/phonology.js

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "phonology-"));

const assert = require("node:assert");
const dict = require("../lib/dictionary");
const phon = require("../lib/phonology");
const { correspond, align, GAP } = require("../lib/correspondences");

let passed = 0;
const check = (name, fn) => {
    fn();
    passed++;
    console.log("ok  ", name);
};
const throws = (fn, text) => assert.throws(fn, (error) => error.message.includes(text), `expected an error containing “${text}”`);

const proto = dict.createLanguage({ slug: "proto", name: "Proto", is_proto: true });
const daughter = dict.createLanguage({ slug: "daughter", name: "Daughter" });

check("saving an inventory fills in what is known about each symbol", () => {
    const saved = phon.savePhonology(proto.id, {
        phonemes: [{ ipa: "k" }, { ipa: "a" }, { ipa: "t" }, { ipa: "kʰ" }, { ipa: "aː" }, { ipa: "x", kind: "consonant" }],
        graphemes: []
    });
    const k = saved.phonemes.find((p) => p.ipa === "k");
    assert.deepStrictEqual([k.kind, k.place, k.manner, k.voiced], ["consonant", "velar", "plosive", 0]);
    const long = saved.phonemes.find((p) => p.ipa === "aː");
    assert.deepStrictEqual([long.kind, long.height, long.backness], ["vowel", "open", "front"]);
});

check("a symbol it doesn't know needs to be said to be a consonant, a vowel, a tone or a stress mark", () => {
    throws(() => phon.savePhonology(proto.id, { phonemes: [{ ipa: "§" }], graphemes: [] }), "consonant, a vowel");
});

check("spelling is matched longest letters first, and each letter maps to inventory sounds", () => {
    phon.savePhonology(proto.id, {
        phonemes: [{ ipa: "k" }, { ipa: "kʰ" }, { ipa: "a" }, { ipa: "aː" }, { ipa: "t" }, { ipa: "s" }],
        graphemes: [
            { grapheme: "k", ipa: "k" }, { grapheme: "kh", ipa: "kʰ" }, { grapheme: "a", ipa: "a" },
            { grapheme: "ā", ipa: "aː" }, { grapheme: "t", ipa: "t" }, { grapheme: "x", ipa: "ks" }
        ]
    });
    const word = phon.transcribe(proto.id, "khāta");
    assert.deepStrictEqual(word.phonemes, ["kʰ", "aː", "t", "a"]);
    assert.ok(word.complete);
    assert.deepStrictEqual(phon.transcribe(proto.id, "ax").phonemes, ["a", "k", "s"]);
    const bad = phon.transcribe(proto.id, "kaqa");
    assert.deepStrictEqual(bad.unknown, ["q"]);
    assert.ok(!bad.complete);
});

check("a spelling using a sound that isn't in the inventory is refused", () => {
    throws(() => phon.savePhonology(proto.id, {
        phonemes: [{ ipa: "k" }], graphemes: [{ grapheme: "q", ipa: "χ" }]
    }), "inventory");
    throws(() => phon.savePhonology(proto.id, {
        phonemes: [{ ipa: "k" }], graphemes: [{ grapheme: "c", ipa: "k" }, { grapheme: "c", ipa: "k" }]
    }), "twice");
});

check("tones and stress are kept as marks of their own, not as consonants or vowels", () => {
    const tonal = dict.createLanguage({ slug: "tonal", name: "Tonal" });
    const saved = phon.savePhonology(tonal.id, {
        phonemes: [{ ipa: "m" }, { ipa: "a" }, { ipa: "˥" }, { ipa: "˩" }, { ipa: "ˈ" }, { ipa: "ꜛ", kind: "tone", label: "upstep" }],
        graphemes: [
            { grapheme: "m", ipa: "m" }, { grapheme: "a", ipa: "a" },
            { grapheme: "á", ipa: "a˥" }, { grapheme: "à", ipa: "a˩" }, { grapheme: "'", ipa: "ˈ" }
        ]
    });
    assert.deepStrictEqual(saved.phonemes.map((p) => p.kind), ["consonant", "vowel", "tone", "tone", "stress", "tone"]);
    assert.strictEqual(saved.phonemes.find((p) => p.ipa === "˥").label, "high");
    assert.strictEqual(saved.phonemes.find((p) => p.ipa === "ꜛ").label, "upstep");
    assert.deepStrictEqual(phon.transcribe(tonal.id, "máma").phonemes, ["m", "a", "˥", "m", "a"]);
    const report = phon.analyze(tonal.id);
    assert.strictEqual(report.consonants + report.vowels, report.totalPhonemes - report.tones - report.stresses);
});

check("a letter can have rules with a context: the first that fits wins, the plain one is the default", () => {
    const lang = dict.createLanguage({ slug: "ctx", name: "Context" });
    phon.savePhonology(lang.id, {
        phonemes: ["p", "n", "m", "nʰ", "mʰ", "pʲ", "h", "j", "a", "i"].map((ipa) => ({ ipa })),
        graphemes: [
            { grapheme: "p", ipa: "p" }, { grapheme: "n", ipa: "n" }, { grapheme: "m", ipa: "m" },
            { grapheme: "a", ipa: "a" }, { grapheme: "i", ipa: "i" },
            { grapheme: "h", ipa: "h" },
            { grapheme: "h", ipa: "ʰ", after_text: "n, m" },
            { grapheme: "y", ipa: "j", where_pos: "start" },
            { grapheme: "y", ipa: "ʲ", after_text: "consonant" }
        ]
    });
    assert.deepStrictEqual(phon.transcribe(lang.id, "yapa").phonemes, ["j", "a", "p", "a"]);
    assert.deepStrictEqual(phon.transcribe(lang.id, "apya").phonemes, ["a", "pʲ", "a"]);
    assert.deepStrictEqual(phon.transcribe(lang.id, "any").unknown, ["y"], "nʲ isn't in the inventory, so y can't join n");
    assert.deepStrictEqual(phon.transcribe(lang.id, "anhi").phonemes, ["a", "nʰ", "i"]);
    assert.deepStrictEqual(phon.transcribe(lang.id, "amhi").phonemes, ["a", "mʰ", "i"]);
    assert.deepStrictEqual(phon.transcribe(lang.id, "ahi").phonemes, ["a", "h", "i"]);
    assert.deepStrictEqual(phon.transcribe(lang.id, "pyi").phonemes, ["pʲ", "i"]);
    // "not": h anywhere but after a nasal
    assert.deepStrictEqual(phon.preview({
        phonemes: [{ ipa: "h" }, { ipa: "a" }, { ipa: "n" }],
        graphemes: [{ grapheme: "h", ipa: "h", after_text: "!nasal" }, { grapheme: "a", ipa: "a" }, { grapheme: "n", ipa: "n" }, { grapheme: "h", ipa: "∅", after_text: "nasal" }]
    }, "ahnh").phonemes, ["a", "h", "n"]);
});

check("rules are checked: a context must name a letter, sound or class; two plain rules clash", () => {
    const base = { phonemes: [{ ipa: "k" }, { ipa: "a" }] };
    throws(() => phon.preview({ ...base, graphemes: [{ grapheme: "k", ipa: "k", after_text: "zzz" }] }, "k"), "isn't a letter");
    throws(() => phon.preview({ ...base, graphemes: [{ grapheme: "k", ipa: "k" }, { grapheme: "k", ipa: "a" }] }, "k"), "no context");
    throws(() => phon.preview({ ...base, graphemes: [{ grapheme: "h", ipa: "ʰ" }] }, "k"), "joins the sound before");
});

check("syllables: maximal onset with the allowed clusters, and a limit on codas", () => {
    const lang = dict.createLanguage({ slug: "syl", name: "Syl" });
    const inventory = ["p", "r", "t", "k", "s", "a", "i", "u", "ˈ"].map((ipa) => ({ ipa }));
    const graphemes = ["p", "r", "t", "k", "s", "a", "i", "u"].map((x) => ({ grapheme: x, ipa: x }));
    const set = (prosody) => phon.savePhonology(lang.id, { phonemes: inventory, graphemes, prosody });
    set({ show_syllables: true, onsets: "pr tr", max_coda: 1 });
    assert.strictEqual(phon.transcribe(lang.id, "kapra").surface, "/ka.pra/");
    assert.strictEqual(phon.transcribe(lang.id, "kasta").surface, "/kas.ta/", "st isn't an onset, so s closes the first syllable");
    assert.strictEqual(phon.transcribe(lang.id, "kaia").surface, "/ka.i.a/", "vowels in a row are separate unless a diphthong");
    set({ show_syllables: true, diphthongs: "ai", max_coda: 1 });
    assert.strictEqual(phon.transcribe(lang.id, "kaita").surface, "/kai.ta/");
    set({ show_syllables: true, max_coda: 0 });
    assert.strictEqual(phon.transcribe(lang.id, "kasta").surface, "/ka.sta/", "no codas: the whole cluster moves on");
});

check("stress: a rule places it where the spelling doesn't, and marks in the spelling win", () => {
    const lang = dict.createLanguage({ slug: "str", name: "Str" });
    const inventory = ["t", "k", "n", "a", "aː", "ˈ"].map((ipa) => ({ ipa }));
    const graphemes = [
        { grapheme: "t", ipa: "t" }, { grapheme: "k", ipa: "k" }, { grapheme: "n", ipa: "n" },
        { grapheme: "a", ipa: "a" }, { grapheme: "ā", ipa: "aː" }, { grapheme: "'", ipa: "ˈ" }
    ];
    const set = (rule) => phon.savePhonology(lang.id, { phonemes: inventory, graphemes, prosody: { show_syllables: true, stress_rule: rule } });
    set("penultimate");
    assert.strictEqual(phon.transcribe(lang.id, "katana").surface, "/kaˈta.na/");
    assert.strictEqual(phon.transcribe(lang.id, "kata").surface, "/ˈka.ta/");
    assert.strictEqual(phon.transcribe(lang.id, "ka").surface, "/ka/", "one-syllable words are left alone");
    assert.strictEqual(phon.transcribe(lang.id, "kat'ana").surface, "/kaˈta.na/", "a mark before t puts stress on the syllable it begins");
    assert.strictEqual(phon.transcribe(lang.id, "kanat'a").surface, "/ka.naˈta/", "a written mark beats the rule");
    set("initial");
    assert.strictEqual(phon.transcribe(lang.id, "katana").surface, "/ˈka.ta.na/");
    set("final");
    assert.strictEqual(phon.transcribe(lang.id, "katana").surface, "/ka.taˈna/");
    set("weight");
    assert.strictEqual(phon.transcribe(lang.id, "katāna").surface, "/kaˈtaː.na/", "a long penult is stressed");
    assert.strictEqual(phon.transcribe(lang.id, "katana").surface, "/ˈka.ta.na/", "otherwise the third from the end");
});

check("syllabic consonants carry a syllable when no vowel is next to them", () => {
    const lang = dict.createLanguage({ slug: "syc", name: "Syc" });
    const symbols = ["v", "l", "r", "k", "p", "s", "t", "a"];
    const set = (prosody) => phon.savePhonology(lang.id, {
        phonemes: symbols.map((ipa) => ({ ipa })),
        graphemes: symbols.map((x) => ({ grapheme: x, ipa: x })),
        prosody: { show_syllables: true, ...prosody }
    });
    set({ syllabic: "l r" });
    assert.strictEqual(phon.transcribe(lang.id, "vlk").surface, "/vl\u0329k/");
    assert.strictEqual(phon.transcribe(lang.id, "prst").surface, "/pr\u0329st/");
    assert.strictEqual(phon.transcribe(lang.id, "trla").surface, "/tr\u0329.la/");
    assert.strictEqual(phon.transcribe(lang.id, "kalk").surface, "/kalk/", "after a vowel it is a coda, not a syllable");
    assert.strictEqual(phon.transcribe(lang.id, "plat").surface, "/plat/", "before a vowel it is an onset");
    assert.strictEqual(phon.transcribe(lang.id, "vlkra").surface, "/vl\u0329k.ra/");
    set({});
    assert.strictEqual(phon.transcribe(lang.id, "vlk").surface, "/vlk/", "without the setting a word with no vowel is one syllable anyway");
    assert.deepStrictEqual(phon.transcribe(lang.id, "vlk").syllables.length, 1);
});

check("alignment lines up like sounds and marks losses and gains", () => {
    assert.deepStrictEqual(align(["k", "a", "t"], ["k", "a", "t"]), [["k", "k"], ["a", "a"], ["t", "t"]]);
    assert.deepStrictEqual(align(["k", "a", "t", "a"], ["g", "a", "t"]), [["k", "g"], ["a", "a"], ["t", "t"], ["a", GAP]]);
    assert.deepStrictEqual(align(["s", "k", "a"], ["k", "a"]), [["s", GAP], ["k", "k"], ["a", "a"]]);
});

check("correspondences between a language and its descendant are counted", () => {
    phon.savePhonology(proto.id, {
        phonemes: [{ ipa: "k" }, { ipa: "a" }, { ipa: "t" }, { ipa: "p" }],
        graphemes: [{ grapheme: "k", ipa: "k" }, { grapheme: "a", ipa: "a" }, { grapheme: "t", ipa: "t" }, { grapheme: "p", ipa: "p" }]
    });
    phon.savePhonology(daughter.id, {
        phonemes: [{ ipa: "ɡ" }, { ipa: "a" }, { ipa: "t" }, { ipa: "p" }],
        graphemes: [{ grapheme: "g", ipa: "ɡ" }, { grapheme: "a", ipa: "a" }, { grapheme: "t", ipa: "t" }, { grapheme: "p", ipa: "p" }]
    });
    const word = (languageId, headword, ancestorIds = []) => dict.saveWord(null, languageId, {
        headword, senses: ["x"], ancestors: ancestorIds.map((id) => ({ id, kind: "inherited" }))
    });
    const a1 = word(proto.id, "kata");
    const a2 = word(proto.id, "kapa");
    const a3 = word(proto.id, "tak");
    word(daughter.id, "gata", [a1]);
    word(daughter.id, "gapa", [a2]);
    word(daughter.id, "tag", [a3]);

    const result = correspond(proto.id, daughter.id);
    assert.strictEqual(result.used, 3);
    const kg = result.flows.find((f) => f.from === "k" && f.to === "ɡ");
    assert.strictEqual(kg.count, 3);
    assert.strictEqual(result.flows.find((f) => f.from === "t" && f.to === "t").count, 2);
    assert.ok(!result.flows.some((f) => f.from === "k" && f.to === "k"), "k always became g");
});

console.log(`\n${passed} checks passed`);
