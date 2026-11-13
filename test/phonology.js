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
const soundchange = require("../lib/soundchange");

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

check("diphthongs are defined one by one: they make one nucleus, can be light, and spelling can name them", () => {
    const lang = dict.createLanguage({ slug: "dph", name: "Dph" });
    const inventory = ["t", "k", "n", "a", "i", "u", "e", "ˈ"].map((ipa) => ({ ipa }));
    const graphemes = [["t", "t"], ["k", "k"], ["n", "n"], ["a", "a"], ["i", "i"], ["u", "u"], ["e", "e"], ["ai", "ai"]]
        .map(([grapheme, ipa]) => ({ grapheme, ipa }));
    const save = (defs, extra = {}) => phon.savePhonology(lang.id, {
        phonemes: inventory, graphemes, prosody: { diphthong_defs: defs, show_syllables: true, ...extra }
    });

    const saved = save([{ first: "a", second: "i", note: "as in ai", weight: "heavy" }, { first: "a", second: "u" }]);
    assert.deepStrictEqual(saved.prosody.diphthong_defs.map((d) => d.first + d.second), ["ai", "au"]);
    assert.strictEqual(saved.prosody.diphthongs, "ai au", "the plain list stays in step for everything that reads it");
    assert.strictEqual(phon.transcribe(lang.id, "kaita").surface, "/kai.ta/", "ai is one nucleus");
    assert.strictEqual(phon.transcribe(lang.id, "kaena").surface, "/ka.e.na/", "ae isn't defined: hiatus");

    // weight: the stress rule counts a heavy diphthong, not a light one
    const stress = (weight) => {
        save([{ first: "a", second: "i", weight }], { stress_rule: "weight", stress_mark: "ˈ" });
        return phon.transcribe(lang.id, "takaina").surface;
    };
    assert.strictEqual(stress("heavy"), "/taˈkai.na/", "a heavy diphthong makes the second-to-last syllable heavy");
    assert.strictEqual(stress("light"), "/ˈta.kai.na/", "a light one doesn't: stress moves to the third to last");

    // the report: movement, spelling and use
    save([{ first: "a", second: "i" }, { first: "a", second: "u" }]);
    dict.saveWord(null, lang.id, { headword: "kaita", senses: ["x"] });
    const report = phon.analyze(lang.id);
    const ai = report.diphthongStats.find((d) => d.ipa === "ai");
    assert.deepStrictEqual([ai.type, ai.weight, ai.spelledBy, ai.count], ["closing", "heavy", ["ai"], 1]);
    assert.deepStrictEqual(report.diphthongStats.find((d) => d.ipa === "au").spelledBy, [], "no letter spells au yet");

    throws(() => save([{ first: "a", second: "k" }]), "isn't a vowel");
    throws(() => save([{ first: "a", second: "i" }, { first: "a", second: "i" }]), "listed twice");
    throws(() => save([{ first: "a", second: "i", weight: "huge" }]), "heavy or light");
});

check("a diphthong can have a nonsyllabic vowel, written with a ̯ in the transcription", () => {
    const lang = dict.createLanguage({ slug: "nsy", name: "Nsy" });
    const phonemes = ["t", "k", "a", "i"].map((ipa) => ({ ipa }));
    const graphemes = ["t", "k", "a", "i"].map((x) => ({ grapheme: x, ipa: x }));
    const save = (nonsyllabic) => phon.savePhonology(lang.id, {
        phonemes, graphemes, prosody: { diphthong_defs: [{ first: "a", second: "i", nonsyllabic }], show_syllables: true }
    });
    save("second");
    assert.strictEqual(phon.transcribe(lang.id, "kaita").surface, "/kai̯.ta/");
    assert.deepStrictEqual(phon.transcribe(lang.id, "kaita").phonemes, ["k", "a", "i", "t", "a"], "the sounds themselves are unchanged");
    save("first");
    assert.strictEqual(phon.transcribe(lang.id, "kaita").surface, "/ka̯i.ta/");
    save("");
    assert.strictEqual(phon.transcribe(lang.id, "kaita").surface, "/kai.ta/");
    throws(() => save("both"), "first or the second");
});

check("rule-based pitch accent: long vowels and diphthongs are pinned high, the rest follow, and changes are marked ꜛ ꜜ", () => {
    const lang = dict.createLanguage({ slug: "pit", name: "Pit" });
    const phonemes = ["t", "k", "n", "a", "aː", "i", "u"].map((ipa) => ({ ipa }));
    const graphemes = [["t", "t"], ["k", "k"], ["n", "n"], ["a", "a"], ["ā", "aː"], ["i", "i"], ["u", "u"]].map(([grapheme, ipa]) => ({ grapheme, ipa }));
    const rules = { enabled: true, anchors: [{ when: "long-or-diphthong", pitch: "H" }], before: "L", between: "L", after: "L", fallback: "none" };
    const save = (changes) => phon.savePhonology(lang.id, {
        phonemes, graphemes, prosody: { show_syllables: true, diphthong_defs: [{ first: "a", second: "i" }], pitch: { ...rules, ...changes } }
    });
    const pitches = (word) => phon.transcribe(lang.id, word).syllables.map((s) => s.pitch).join("");
    const surface = (word) => phon.transcribe(lang.id, word).surface;

    save({});
    assert.strictEqual(pitches("takātana"), "LHLL", "the long syllable is high; before and after are low");
    assert.strictEqual(surface("takātana"), "/ta.ꜛkaː.ꜜta.na/", "a rise is marked ꜛ and a fall ꜜ, before the syllable");
    assert.strictEqual(pitches("kaitanaka"), "HLLL", "a diphthong is pinned high too");
    assert.strictEqual(surface("kaitanaka"), "/kai.ꜜta.na.ka/", "a word that starts high has nothing to mark at its start");
    save({ before: "H", after: "H" });
    assert.strictEqual(surface("takātana"), "/ta.kaː.ta.na/", "all high: no change to mark");
    save({ before: "L", after: "H" });
    assert.strictEqual(surface("takātana"), "/ta.ꜛkaː.ta.na/");

    // between two pinned syllables
    save({ between: "L" });
    assert.strictEqual(surface("tākatāna"), "/taː.ꜜka.ꜛtaː.ꜜna/");
    save({ between: "H" });
    assert.strictEqual(surface("tākatāna"), "/taː.ka.taː.ꜜna/");

    save({ mark_initial: true });
    assert.strictEqual(surface("kaitanaka"), "/ꜛkai.ꜜta.na.ka/", "unless asked to mark a high start");

    // no pinned syllable: the fallback decides
    save({ fallback: "none" });
    assert.strictEqual(surface("tanaka"), "/ta.na.ka/");
    save({ fallback: "initial-high" });
    assert.strictEqual(surface("tanaka"), "/ta.ꜜna.ka/");
    save({ fallback: "final-high" });
    assert.strictEqual(surface("tanaka"), "/ta.na.ꜛka/");

    // a one-syllable word has nothing to mark; a disabled rule does nothing
    assert.strictEqual(surface("ta"), "/ta/");
    save({ enabled: false });
    assert.strictEqual(surface("takātana"), "/ta.kaː.ta.na/");
    throws(() => save({ anchors: [{ when: "nowhere", pitch: "H" }] }), "pins");
    throws(() => save({ before: "X" }), "high or low");

    // the report counts the patterns
    save({ enabled: true });
    dict.saveWord(null, lang.id, { headword: "takātana", senses: ["x"] });
    assert.deepStrictEqual(phon.analyze(lang.id).pitchPatterns, [{ pattern: "LHLL", count: 1 }]);
});

check("a language saved with the older plain list of diphthongs reads it as definitions", () => {
    const lang = dict.createLanguage({ slug: "old-dph", name: "OldDph" });
    const phonemes = ["k", "a", "i", "u"].map((ipa) => ({ ipa }));
    phon.savePhonology(lang.id, { phonemes, graphemes: [], prosody: { diphthongs: "ai au" } });
    const got = phon.getPhonology(lang.id).prosody;
    assert.deepStrictEqual(got.diphthong_defs.map((d) => [d.first, d.second, d.weight]), [["a", "i", "heavy"], ["a", "u", "heavy"]]);
});

check("varieties of the spelling: a variety replaces the standard's rules for the letters it lists, the rest read as standard", () => {
    const lang = dict.createLanguage({ slug: "var", name: "Var" });
    const phonemes = ["k", "g", "t", "a", "i", "e", "ʃ", "s"].map((ipa) => ({ ipa }));
    const graphemes = [["k", "k"], ["t", "t"], ["a", "a"], ["i", "i"], ["e", "e"], ["s", "s"], ["g", "ɡ"]].map(([grapheme, ipa]) => ({ grapheme, ipa }));
    const save = (varieties) => phon.savePhonology(lang.id, { phonemes, graphemes, varieties, prosody: { show_syllables: true } });

    const saved = save([
        { time: "late", place: "", graphemes: [{ grapheme: "k", ipa: "g" }] },
        { time: "", place: "north", graphemes: [{ grapheme: "s", ipa: "ʃ" }, { grapheme: "t", ipa: "s", before_text: "i" }] },
        { time: "early", place: "west", graphemes: [] }
    ]);
    assert.deepStrictEqual(saved.varieties.map((v) => v.label), ["Early · West", "Late", "North"], "ordered by time, then place");

    assert.strictEqual(phon.transcribe(lang.id, "kati").surface, "/ka.ti/", "the standard is unchanged");
    const all = phon.transcribeVarieties(lang.id, "kasti");
    const by = (label) => all.find((v) => v.label === label).surface;
    assert.strictEqual(by("Late"), "/ɡas.ti/", "late: k is g");
    assert.strictEqual(by("North"), "/kaʃ.si/", "north: s is ʃ, and t before i is s");
    assert.strictEqual(by("Early · West"), "/kas.ti/", "an empty variety reads as the standard");

    // a variety that gives a letter only context rules changes just those places: elsewhere the standard applies
    const north = (word) => (phon.transcribeVarieties(lang.id, word).find((v) => v.label === "North") || {}).surface;
    assert.strictEqual(north("kasta"), "/kaʃ.ta/", "t before a has no North rule, so it is read as in the standard");
    assert.strictEqual(north("kati"), "/ka.si/", "t before i has one");
    // a rule with no context replaces the letter altogether
    assert.strictEqual((phon.transcribeVarieties(lang.id, "kati").find((v) => v.label === "Late") || {}).surface, "/ɡa.ti/");

    // the standard is kept when the page of a variety is saved without varieties being mentioned
    phon.savePhonology(lang.id, { phonemes, graphemes, prosody: {} });
    assert.strictEqual(phon.getPhonology(lang.id).varieties.length, 3, "leaving varieties out leaves them alone");
    save([]);
    assert.strictEqual(phon.getPhonology(lang.id).varieties.length, 0, "an empty list removes them");

    throws(() => save([{ time: "", place: "", graphemes: [] }]), "a time, a place, or both");
    throws(() => save([{ time: "someday", graphemes: [] }]), "time must be");
    throws(() => save([{ time: "early", graphemes: [] }, { time: "early", graphemes: [] }]), "two varieties");
    throws(() => save([{ place: "east", graphemes: [{ grapheme: "k", ipa: "§" }] }]), "East: ");
    // a variety's context can name the standard's letters
    save([{ place: "south", graphemes: [{ grapheme: "k", ipa: "g", after_text: "a, i" }, { grapheme: "k", ipa: "k" }] }]);
    // read with unsaved data
    const data = { phonemes, graphemes, varieties: [{ place: "east", graphemes: [{ grapheme: "a", ipa: "e" }] }], prosody: {} };
    assert.deepStrictEqual(phon.preview(data, "kat", 0).phonemes, ["k", "e", "t"]);
    assert.deepStrictEqual(phon.preview(data, "kat").phonemes, ["k", "a", "t"]);
});

check("a variety can use sounds that are not in the standard inventory", () => {
    const lang = dict.createLanguage({ slug: "newsounds", name: "NewSounds" });
    const phonemes = ["k", "t", "n", "a", "i"].map((ipa) => ({ ipa }));
    const graphemes = ["k", "t", "n", "a", "i", "h", "c"].map((x) => ({ grapheme: x, ipa: x === "h" ? "ʰ" : x === "c" ? "t" : x })).filter((g) => g.grapheme !== "h" && g.grapheme !== "c");
    const varieties = [{
        place: "east",
        graphemes: [
            { grapheme: "n", ipa: "ŋ", before_text: "k" },            // a sound the standard lacks, in a context
            { grapheme: "a", ipa: "ɛ" },                              // a vowel it lacks
            { grapheme: "c", ipa: "t͡ʃ" },                            // an affricate, with a tie bar
            { grapheme: "h", ipa: "ʰ" }                               // a mark joining the sound before it: kʰ
        ]
    }];
    phon.savePhonology(lang.id, { phonemes, graphemes, varieties, prosody: { show_syllables: true } });

    assert.deepStrictEqual(phon.getPhonology(lang.id).phonemes.map((p) => p.ipa), ["k", "t", "n", "a", "i"], "the standard inventory is untouched");
    const east = (word) => phon.transcribeVarieties(lang.id, word).map((v) => v.surface)[0];
    assert.strictEqual(east("tanka"), "/tɛŋ.kɛ/", "the new sounds read, and syllables treat ɛ as a vowel");
    assert.strictEqual(east("cika"), "/t͡ʃi.kɛ/");
    assert.strictEqual(east("khi"), "/kʰi/", "h joins the k before it");
    assert.strictEqual(phon.transcribe(lang.id, "tanka").surface, "/tan.ka/", "the standard doesn't read them");
    assert.strictEqual(phon.transcribe(lang.id, "cika").surface, null, "c has no letter in the standard, so it isn't complete there");

    // a context in a variety may name one of its own new sounds
    phon.savePhonology(lang.id, { phonemes, graphemes, varieties: [{ time: "late", graphemes: [{ grapheme: "n", ipa: "ŋ" }, { grapheme: "t", ipa: "d", after_text: "ŋ" }, { grapheme: "t", ipa: "t" }] }], prosody: {} });
    assert.strictEqual(phon.transcribeVarieties(lang.id, "tanta")[0].surface, "/taŋda/", "a context can name the variety's own new sound");
    throws(() => phon.savePhonology(lang.id, { phonemes, graphemes, varieties: [{ time: "late", graphemes: [{ grapheme: "n", ipa: "12" }] }], prosody: {} }), "isn't a sound");
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

const cols = (columns) => columns.map((c) => [c.from.join(""), c.to.join("")]);

check("alignment lines up like sounds, marks losses and gains, and can merge or split sounds", () => {
    assert.deepStrictEqual(cols(align(["k", "a", "t"], ["k", "a", "t"])), [["k", "k"], ["a", "a"], ["t", "t"]]);
    assert.deepStrictEqual(cols(align(["k", "a", "t", "a"], ["ɡ", "a", "t"])), [["k", "ɡ"], ["a", "a"], ["t", "t"], ["a", ""]]);
    assert.deepStrictEqual(cols(align(["s", "k", "a"], ["k", "a"])), [["s", ""], ["k", "k"], ["a", "a"]]);
    // m + p > b: one sound from two (voicing from the nasal, stop manner from the plosive), not "m > b, p lost"
    assert.deepStrictEqual(cols(align(["a", "m", "p", "a"], ["a", "b", "a"])), [["a", "a"], ["mp", "b"], ["a", "a"]]);
    // and the other way: one sound becoming two
    assert.deepStrictEqual(cols(align(["a", "b", "a"], ["a", "m", "p", "a"])), [["a", "a"], ["b", "mp"], ["a", "a"]]);
    // a sound that just disappears next to an unrelated one is still a loss, not a merger
    assert.deepStrictEqual(cols(align(["a", "t", "s", "a"], ["a", "t", "a"])).filter(([f, t]) => f !== t), [["s", ""]]);
});

check("changes are named from the features that differ and the neighbours", () => {
    const named = (from, to, left, right) => soundchange.classify(from, to, { left, right }).processes;
    assert.deepStrictEqual(named(["p"], ["b"], "a", "a"), ["intervocalic voicing"]);
    assert.deepStrictEqual(named(["t"], ["d"], "n", "a"), ["voicing assimilation (to the preceding sound)"]);
    assert.deepStrictEqual(named(["b"], ["β"], "a", "a"), ["spirantization (lenition)"]);
    assert.deepStrictEqual(named(["s"], [], "a", "#"), ["loss of a final consonant"]);
    assert.deepStrictEqual(named(["a"], [], "k", "t"), ["syncope (loss of a medial vowel)"]);
    assert.deepStrictEqual(named([], ["ə"], "k", "t"), ["epenthesis (a vowel appears)"]);
    assert.deepStrictEqual(named(["k"], ["t͡ʃ"], "#", "i"), ["affrication", "palatalization"]);
    assert.deepStrictEqual(named(["e"], ["i"], "k", "t"), ["raising"]);
    assert.ok(named(["m", "p"], ["b"], "a", "a")[0].startsWith("coalescence (nasal + stop): m gives voicing; p gives manner; both give place"));
    assert.deepStrictEqual(named(["a"], ["aː"], "k", "t"), ["lengthening"]);
});

check("a route of one-feature steps through sounds that exist", () => {
    assert.deepStrictEqual(soundchange.routeBetween("p", "v", new Set(["b", "β"])), ["p", "b", "β", "v"]);
    assert.strictEqual(soundchange.routeBetween("p", "b"), null, "one step needs no route");
    assert.strictEqual(soundchange.routeBetween("p", "§"), null);
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

check("a sound with two outcomes is explained by what is next to it", () => {
    const a = dict.createLanguage({ slug: "cond-a", name: "CondA" });
    const b = dict.createLanguage({ slug: "cond-b", name: "CondB" });
    const letters = (list, extra = []) => ({
        phonemes: list.map((ipa) => ({ ipa })),
        graphemes: [...list.map((x) => ({ grapheme: x, ipa: x })), ...extra]
    });
    phon.savePhonology(a.id, letters(["k", "t", "i", "e", "u", "o"]));
    phon.savePhonology(b.id, letters(["k", "t", "t͡ʃ", "i", "e", "u", "o"], [{ grapheme: "c", ipa: "t͡ʃ" }]));
    const word = (languageId, headword, ancestorIds = []) => dict.saveWord(null, languageId, {
        headword, senses: ["x"], ancestors: ancestorIds.map((id) => ({ id, kind: "inherited" }))
    });
    for (const [old, young] of [["kiti", "citi"], ["keti", "ceti"], ["kitu", "citu"], ["kuti", "kuti"], ["koti", "koti"], ["kuku", "kuku"]]) {
        word(b.id, young, [word(a.id, old)]);
    }
    const result = correspond(a.id, b.id);
    const found = result.conditions.find((c) => c.from === "k" && c.to === "t͡ʃ");
    assert.ok(found, "k > tʃ is conditioned");
    assert.strictEqual(found.side, "right");
    assert.strictEqual(found.what, "a front vowel");
    assert.deepStrictEqual([found.hits, found.of, found.exceptions], [3, 3, 0]);
    assert.ok(!result.conditions.some((c) => c.what === "/i/"), "the class explains it better than one vowel");
    assert.deepStrictEqual(found.elsewhere && found.elsewhere.to, "k");
    const flow = result.flows.find((f) => f.from === "k" && f.to === "t͡ʃ");
    assert.deepStrictEqual(flow.processes, ["affrication", "palatalization"]);
    assert.ok(flow.route && flow.route[0] === "k" && flow.route[flow.route.length - 1] === "t͡ʃ", "a route of intermediate sounds is offered");
});

check("diphthongs are single sounds, whole syllables that go are one event, and swapped sounds are a metathesis", () => {
    const a = dict.createLanguage({ slug: "dip-a", name: "DipA" });
    const b = dict.createLanguage({ slug: "dip-b", name: "DipB" });
    const inv = (list, diphthongs) => ({
        phonemes: list.map((ipa) => ({ ipa })),
        graphemes: list.map((x) => ({ grapheme: x, ipa: x })),
        prosody: { diphthongs, show_syllables: true }
    });
    phon.savePhonology(a.id, inv(["k", "t", "s", "n", "r", "a", "e", "i", "u", "o"], "ai au"));
    phon.savePhonology(b.id, inv(["k", "t", "s", "n", "r", "a", "e", "i", "u", "o"], ""));
    const word = (languageId, headword, ancestorIds = []) => dict.saveWord(null, languageId, {
        headword, senses: ["x"], ancestors: ancestorIds.map((id) => ({ id, kind: "inherited" }))
    });
    const pairs = [["kaita", "keta"], ["kausa", "kosa"], ["kasana", "kasa"], ["tukana", "tuka"], ["kartu", "katru"]];
    for (const [old, young] of pairs) {
        word(b.id, young, [word(a.id, old)]);
    }
    const result = correspond(a.id, b.id);
    const find = (from, to) => result.flows.find((f) => f.from === from && f.to === to);

    const mono = find("ai", "e");
    assert.ok(mono, "ai > e is one correspondence, not a lost vowel beside a changed one");
    assert.ok(mono.processes[0].startsWith("monophthongization"), mono.processes[0]);
    assert.ok(find("au", "o"));
    assert.ok(!result.flows.some((f) => f.processes.some((p) => p.includes("syncope")) ), "no vowel is reported lost");

    const lost = find("na", "∅");
    assert.ok(lost && lost.count === 2, "the lost suffix is one event");
    assert.ok(lost.processes[0].startsWith("loss of a final syllable"));
    assert.deepStrictEqual(result.shape.lostSyllables.map((x) => [x.position, x.text, x.count]), [["final", "na", 2]]);
    assert.strictEqual(result.shape.shorter, 2, "only the two suffix words got shorter by a syllable");

    const swap = find("rt", "tr");
    assert.ok(swap && swap.processes[0].startsWith("metathesis"));
});

check("a form with a space is read word by word: the article is unstressed and the spaces stay", () => {
    const lang = dict.createLanguage({ slug: "art", name: "Art" });
    const inv = ["k", "t", "l", "s", "a", "i", "o", "ˈ"];
    const set = (prosody) => phon.savePhonology(lang.id, {
        phonemes: inv.map((ipa) => ({ ipa })),
        graphemes: [...inv.filter((x) => x !== "ˈ").map((x) => ({ grapheme: x, ipa: x })), { grapheme: "'", ipa: "ˈ" }],
        prosody: { show_syllables: true, stress_rule: "penultimate", ...prosody }
    });
    set({});
    assert.strictEqual(phon.transcribe(lang.id, "kasita").surface, "/kaˈsi.ta/");
    assert.strictEqual(phon.transcribe(lang.id, "la kasita").surface, "/la kaˈsi.ta/", "the article gets no stress, though it has two syllables");
    assert.strictEqual(phon.transcribe(lang.id, "ta lo kasita").surface, "/ta lo kaˈsi.ta/");
    assert.strictEqual(phon.transcribe(lang.id, "la ka'sita").surface, "/la kaˈsi.ta/", "stress written in the spelling still counts");
    assert.ok(!phon.transcribe(lang.id, "la kazita").complete, "an uncovered letter makes the whole form incomplete");
    set({ article_position: "after" });
    assert.strictEqual(phon.transcribe(lang.id, "kasita la").surface, "/kaˈsi.ta la/", "an article after the word: the first word is the stressed one");
});

console.log(`\n${passed} checks passed`);
