"use strict";

// Checks inflection templates and the tables words get from them, on a throw-away database.
// Run with: node test/inflection.js

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "inflection-"));

const assert = require("node:assert");
const dict = require("../lib/dictionary");
const inflection = require("../lib/inflection");

let passed = 0;
const check = (name, fn) => {
    fn();
    passed++;
    console.log("ok  ", name);
};
const throws = (fn, text) => assert.throws(fn, (error) => error.message.includes(text), `expected an error containing “${text}”`);

const lang = dict.createLanguage({ slug: "infl", name: "Infl" });
const other = dict.createLanguage({ slug: "other", name: "Other" });

const verbs = {
    name: "Weak verbs", pos: "verb", stem_remove: "-a",
    rows: [{ name: "Person", values: ["1st", "2nd", "3rd"] }, { name: "Number", values: ["singular", "plural"] }],
    cols: [{ name: "Tense", values: ["present", "past"] }],
    cells: { "0.0|0": "{stem}o", "0.0|1": "{stem}ai", "0.1|0": "{stem}omu", "2.1|1": "—", "9.9|0": "stray" }
};

check("a template keeps the cells that fit its layout and drops the rest", () => {
    const t = inflection.createTemplate(lang.id, verbs);
    assert.deepStrictEqual(Object.keys(t.cells).sort(), ["0.0|0", "0.0|1", "0.1|0", "2.1|1"]);
    assert.deepStrictEqual(inflection.paths(t.rows).length, 6);
    assert.strictEqual(inflection.listTemplates(lang.id).length, 1);
    assert.strictEqual(inflection.listTemplates(other.id).length, 0);
});

check("categories need names and distinct values, and tables can't be absurd", () => {
    const base = { name: "x", rows: [], cols: [], cells: {} };
    throws(() => inflection.createTemplate(lang.id, { ...base, rows: [{ name: "", values: ["a"] }] }), "category name");
    throws(() => inflection.createTemplate(lang.id, { ...base, rows: [{ name: "Case", values: ["a", "A"] }] }), "twice");
    throws(() => inflection.createTemplate(lang.id, { ...base, rows: [{ name: "Case", values: [] }] }), "between 1 and");
    throws(() => inflection.createTemplate(lang.id, { ...base, rows: [1, 2, 3, 4].map((n) => ({ name: `d${n}`, values: ["a"] })) }), "at most 3");
    throws(() => inflection.createTemplate(lang.id, { name: "", rows: [], cols: [], cells: {} }), "Name is required");
    const values = Array.from({ length: 40 }, (_, i) => `v${i}`);
    throws(() => inflection.createTemplate(lang.id, { ...base, rows: [{ name: "A", values }, { name: "B", values }], cols: [{ name: "C", values }] }), "cells");
});

check("a stem is the headword less the template's stem removal", () => {
    const t = inflection.listTemplates(lang.id)[0];
    assert.strictEqual(inflection.defaultStem(t, "kata"), "kat");
    assert.strictEqual(inflection.defaultStem(t, "kat"), "kat", "it only comes off if it is there");
    assert.strictEqual(inflection.defaultStem({ stem_remove: "ge-" }, "gekata"), "kata");
    assert.strictEqual(inflection.defaultStem({ stem_remove: "" }, "*kata"), "kata");
});

check("a word's table: the template's patterns, the word's stem, its own forms where it is irregular", () => {
    const t = inflection.listTemplates(lang.id)[0];
    const id = dict.saveWord(null, lang.id, {
        headword: "kata", senses: ["to x"], pos: "verb",
        inflections: [{ template_id: t.id, stem: "", overrides: { "0.0|0": "keto", "1.0|0": "kuta", "8|8": "junk" } }]
    });
    const word = dict.loadWord(id);
    assert.strictEqual(word.inflections.length, 1);
    assert.deepStrictEqual(word.inflections[0].overrides, { "0.0|0": "keto", "1.0|0": "kuta" });

    const table = inflection.tableFor(word.inflections[0].template, { headword: word.headword, stem: word.inflections[0].stem, overrides: word.inflections[0].overrides });
    const form = (r, c) => table.rows[r].cells[c].form;
    assert.strictEqual(table.stem, "kat");
    assert.strictEqual(form(0, 0), "keto", "its own form wins");
    assert.strictEqual(table.rows[0].cells[0].source, "own");
    assert.strictEqual(form(0, 1), "katai", "otherwise the pattern with the stem");
    assert.strictEqual(form(1, 0), "katomu");
    assert.strictEqual(form(2, 0), "kuta", "an override in a cell the template leaves empty");
    assert.strictEqual(form(5, 1), null, "— is a form that doesn't exist");
    assert.strictEqual(table.rows[3].labels.join(" "), "2nd plural");
});

check("saving without mentioning inflections leaves a word's tables alone; a template of another language is refused", () => {
    const t = inflection.listTemplates(lang.id)[0];
    const id = dict.saveWord(null, lang.id, { headword: "tema", senses: ["x"], inflections: [{ template_id: t.id }] });
    dict.saveWord(id, lang.id, { headword: "tema", senses: ["y"] });
    assert.strictEqual(dict.loadWord(id).inflections.length, 1);
    const foreign = inflection.createTemplate(other.id, { name: "Other", rows: [], cols: [], cells: {} });
    throws(() => dict.saveWord(id, lang.id, { headword: "tema", senses: ["y"], inflections: [{ template_id: foreign.id }] }), "doesn't belong");
    dict.saveWord(id, lang.id, { headword: "tema", senses: ["y"], inflections: [] });
    assert.strictEqual(dict.loadWord(id).inflections.length, 0);
});

check("a language can have several templates for one part of speech, and deleting one takes its tables with it", () => {
    const second = inflection.createTemplate(lang.id, { name: "Eroded verbs", pos: "verb", rows: [{ name: "Person", values: ["1st", "2nd"] }], cols: [], cells: { "0|": "{stem}", "1|": "{stem}s" } });
    assert.strictEqual(inflection.listTemplates(lang.id).filter((t) => t.pos === "verb").length, 2);
    const id = dict.saveWord(null, lang.id, { headword: "sora", senses: ["x"], pos: "verb", inflections: [{ template_id: second.id }] });
    const table = inflection.tableFor(second, { headword: "sora", stem: "", overrides: {} });
    assert.deepStrictEqual(table.rows.map((r) => r.cells[0].form), ["sora", "soras"]);
    assert.strictEqual(inflection.listTemplates(lang.id).find((t) => t.id === second.id).words, 1);
    inflection.deleteTemplate(second.id);
    assert.strictEqual(dict.loadWord(id).inflections.length, 0);
});

console.log(`\n${passed} checks passed`);
