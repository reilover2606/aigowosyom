"use strict";

// Checks flora and fauna on a throw-away database. Run with: node test/species.js

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "species-"));

const assert = require("node:assert");
const maps = require("../lib/maps");
const lore = require("../lib/lore");
const species = require("../lib/species");

let passed = 0;
const check = (name, fn) => {
    fn();
    passed++;
    console.log("ok  ", name);
};
const throws = (fn, text) => assert.throws(fn, (error) => error.message.includes(text), `expected an error containing “${text}”`);

const map = maps.createMap({ name: "Test", width: 100, height: 100 });
const square = (x, y) => [[[{ x, y }, { x: x + 10, y }, { x: x + 10, y: y + 10 }, { x, y: y + 10 }]]];
const north = maps.createState(map.id, { name: "North", polygons: square(0, 0) });
const south = maps.createState(map.id, { name: "South", polygons: square(0, 20) });

species.ensureCategories();

check("the Flora and Fauna categories are built in", () => {
    const categories = lore.listCategories();
    assert.ok(categories.some((c) => c.slug === "flora" && c.system_key === "flora"));
    assert.ok(categories.some((c) => c.slug === "fauna" && c.system_key === "fauna"));
    const flora = categories.find((c) => c.slug === "flora");
    throws(() => lore.deleteCategory(flora.id), "built in");
});

check("a species made from a state's menu is found in that state at once, with its page and rarity", () => {
    const oak = species.createSpecies("flora", "Silver oak", 2, north.id);
    assert.strictEqual(oak.title, "Silver oak");
    assert.strictEqual(oak.kind, "flora");
    assert.strictEqual(oak.rarity, 2);
    assert.strictEqual(oak.rarity_label, "fairly common");
    assert.deepStrictEqual(species.speciesIn(north.id).map((s) => s.title), ["Silver oak"]);
    assert.deepStrictEqual(species.statesOf(oak.id).map((s) => s.name), ["North"]);
    assert.strictEqual(lore.getPage(oak.id).category_slug, "flora");
});

check("an existing species can be added to another state, and taken out again", () => {
    const wolf = species.createSpecies("fauna", "Frost wolf", 4, north.id);
    const oak = species.listSpecies().find((s) => s.title === "Silver oak");
    species.addToState(oak.id, south.id);
    species.addToState(oak.id, south.id); // twice is harmless
    assert.deepStrictEqual(species.statesOf(oak.id).map((s) => s.name), ["North", "South"]);
    assert.deepStrictEqual(species.speciesIn(north.id).map((s) => s.title), ["Silver oak", "Frost wolf"], "flora first");
    species.removeFromState(oak.id, north.id);
    assert.deepStrictEqual(species.statesOf(oak.id).map((s) => s.name), ["South"]);
    assert.strictEqual(species.listSpecies().find((s) => s.id === wolf.id).states, 1);
});

check("rarity is 1 to 5, and only species have one", () => {
    const oak = species.listSpecies().find((s) => s.title === "Silver oak");
    assert.strictEqual(species.setRarity(oak.id, 5).rarity_label, "extremely rare");
    throws(() => species.setRarity(oak.id, 6), "1 (common) to 5");
    throws(() => species.setRarity(oak.id, "often"), "1 (common) to 5");
    const ordinary = lore.savePage(null, { category_id: lore.listCategories().find((c) => c.slug !== "flora" && c.slug !== "fauna").id, title: "Not a species", body: "" });
    throws(() => species.setRarity(ordinary, 2), "Species not found");
    throws(() => species.addToState(ordinary, north.id), "Species not found");
    throws(() => species.createSpecies("fungi", "x", 1, north.id), "flora or fauna");
});

check("a page saved in Flora gets a default rarity, and keeps one it has", () => {
    const flora = lore.listCategories().find((c) => c.slug === "flora");
    const id = lore.savePage(null, { category_id: flora.id, title: "Moss", body: "" });
    species.afterPageSaved(id, {});
    assert.strictEqual(species.getSpecies(id).rarity, 3);
    species.afterPageSaved(id, { rarity: 1 });
    assert.strictEqual(species.getSpecies(id).rarity, 1);
    species.afterPageSaved(id, {});
    assert.strictEqual(species.getSpecies(id).rarity, 1, "an edit that doesn't mention it leaves it");
});

check("deleting a state or a species page removes the links, not the other", () => {
    const wolf = species.listSpecies().find((s) => s.title === "Frost wolf");
    maps.deleteState(north.id, { deletePage: true });
    assert.deepStrictEqual(species.statesOf(wolf.id), []);
    assert.ok(species.getSpecies(wolf.id), "the species remains");
    const oak = species.listSpecies().find((s) => s.title === "Silver oak");
    lore.deletePage(oak.id);
    assert.deepStrictEqual(species.speciesIn(south.id), []);
});

console.log(`\n${passed} checks passed`);
