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

check("a symbol it doesn't know needs to be said to be a consonant or a vowel", () => {
    throws(() => phon.savePhonology(proto.id, { phonemes: [{ ipa: "§" }], graphemes: [] }), "consonant or a vowel");
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
