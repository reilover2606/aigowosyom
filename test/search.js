"use strict";

// Checks that the full-text indexes follow saves and deletes, on a throw-away database.
// Run with: node test/search.js

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "search-"));

const assert = require("node:assert");
const { db } = require("../lib/db");
const dict = require("../lib/dictionary");
const lore = require("../lib/lore");

let passed = 0;
const check = (name, fn) => {
    fn();
    passed++;
    console.log("ok  ", name);
};

check("the word index is keyed by the word's id, and follows saves, edits and deletes", () => {
    const language = dict.createLanguage({ slug: "s", name: "S" });
    const id = dict.saveWord(null, language.id, { headword: "aaa", senses: ["a pebble"] });
    assert.strictEqual(db.prepare("SELECT word_id FROM words_fts WHERE rowid = ?").get(id).word_id, id);
    assert.strictEqual(dict.searchWords("pebble", { languageId: language.id }).length, 1);

    dict.saveWord(id, null, { headword: "bbb", senses: ["a boulder"] });
    assert.strictEqual(dict.searchWords("pebble", { languageId: language.id }).length, 0, "the old text is gone");
    assert.strictEqual(dict.searchWords("boulder", { languageId: language.id }).length, 1);
    assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM words_fts").get().n, 1, "one index row per word");

    dict.deleteWord(id);
    assert.strictEqual(dict.searchWords("boulder", { languageId: language.id }).length, 0);
    assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM words_fts").get().n, 0);
});

check("the lore and note indexes are keyed the same way", () => {
    const category = lore.createCategory({ name: "Things", slug: "things" });
    const pageId = lore.savePage(null, { category_id: category.id, title: "Granite", body: "<p>grey rock</p>" });
    assert.strictEqual(db.prepare("SELECT page_id FROM lore_fts WHERE rowid = ?").get(pageId).page_id, pageId);
    lore.savePage(pageId, { category_id: category.id, title: "Granite", body: "<p>pink rock</p>" });
    assert.strictEqual(lore.searchPages("pink").length, 1);
    assert.strictEqual(lore.searchPages("grey").length, 0);

    const noteId = db.prepare("INSERT INTO notes (day, title, body, created_at, updated_at) VALUES (1, 't', 'a lantern', 0, 0)").run().lastInsertRowid;
    assert.strictEqual(db.prepare("SELECT note_id FROM notes_fts WHERE rowid = ?").get(noteId).note_id, noteId);
    db.prepare("UPDATE notes SET body = 'a candle' WHERE id = ?").run(noteId);
    assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM notes_fts WHERE notes_fts MATCH 'lantern'").get().n, 0);
    db.prepare("DELETE FROM notes WHERE id = ?").run(noteId);
    assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM notes_fts").get().n, 0);
});

console.log(`\n${passed} checks passed`);
