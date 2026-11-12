"use strict";

// Checks the language statistics, on a throw-away database.
// Run with: node test/stats.js

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "stats-"));

const assert = require("node:assert");
const dict = require("../lib/dictionary");
const { languageStats } = require("../lib/stats");
const charts = require("../lib/charts");

let passed = 0;
const check = (name, fn) => {
    fn();
    passed++;
    console.log("ok  ", name);
};

check("entries with no part of speech are counted (after named ones on ties) and don't break the statistics", () => {
    const language = dict.createLanguage({ slug: "stats", name: "Stats" });
    for (const [headword, pos] of [["aa", ""], ["bb", "noun"], ["cc", "verb"], ["dd", ""]]) {
        dict.saveWord(null, language.id, { headword, pos, senses: ["x"] });
    }
    const stats = languageStats(language.id);
    assert.deepStrictEqual(stats.partsOfSpeech, [
        { label: null, count: 2 },
        { label: "noun", count: 1 },
        { label: "verb", count: 1 }
    ]);
    assert.ok(charts.pieChart(stats.partsOfSpeech, { ariaLabel: "x" }).length > 0, "the chart draws an unspecified slice");

    // a tie between the unspecified entries and a named part of speech: the named one comes first
    dict.saveWord(null, language.id, { headword: "ee", pos: "noun", senses: ["x"] });
    assert.deepStrictEqual(languageStats(language.id).partsOfSpeech.map((x) => x.label), ["noun", null, "verb"]);
});

console.log(`\n${passed} checks passed`);
