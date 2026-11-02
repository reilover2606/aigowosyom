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

check("a species made from a state's menu is found in that state at once, with its page and its rarity there", () => {
    const oak = species.createSpecies("flora", "Silver oak", 2, north.id);
    assert.strictEqual(oak.title, "Silver oak");
    assert.strictEqual(oak.kind, "flora");
    const here = species.speciesIn(north.id);
    assert.deepStrictEqual(here.map((s) => [s.title, s.rarity, s.rarity_label]), [["Silver oak", 2, "fairly common"]]);
    assert.deepStrictEqual(species.statesOf(oak.id).map((s) => [s.name, s.rarity]), [["North", 2]]);
    assert.strictEqual(lore.getPage(oak.id).category_slug, "flora");
});

check("rarity is per state: the same species can be common in one and rare in another", () => {
    const wolf = species.createSpecies("fauna", "Frost wolf", 4, north.id);
    const oak = species.listSpecies().find((s) => s.title === "Silver oak");
    species.addToState(oak.id, south.id, 5);
    species.addToState(oak.id, south.id, 5); // twice is harmless
    assert.deepStrictEqual(species.statesOf(oak.id).map((s) => [s.name, s.rarity]), [["North", 2], ["South", 5]]);
    assert.deepStrictEqual(species.speciesIn(north.id).map((s) => s.title), ["Silver oak", "Frost wolf"], "flora first");
    species.setRarity(oak.id, south.id, 1);
    assert.deepStrictEqual(species.statesOf(oak.id).map((s) => [s.name, s.rarity_label]), [["North", "fairly common"], ["South", "common"]]);
    species.removeFromState(oak.id, north.id);
    assert.deepStrictEqual(species.statesOf(oak.id).map((s) => s.name), ["South"]);
    assert.strictEqual(species.listSpecies().find((s) => s.id === wolf.id).states, 1);
    species.addToState(oak.id, north.id, 2);
});

check("rarity is 1 to 5; only species can be found in states", () => {
    const oak = species.listSpecies().find((s) => s.title === "Silver oak");
    throws(() => species.setRarity(oak.id, south.id, 6), "1 (common) to 5");
    throws(() => species.setRarity(oak.id, south.id, "often"), "1 (common) to 5");
    throws(() => species.addToState(oak.id, south.id, 0), "1 (common) to 5");
    const wolf = species.listSpecies().find((s) => s.title === "Frost wolf");
    throws(() => species.setRarity(wolf.id, south.id, 2), "isn't found in this state");
    const ordinary = lore.savePage(null, { category_id: lore.listCategories().find((c) => c.slug !== "flora" && c.slug !== "fauna").id, title: "Not a species", body: "" });
    throws(() => species.addToState(ordinary, north.id, 2), "Species not found");
    throws(() => species.createSpecies("fungi", "x", 1, north.id), "flora or fauna");
});

check("a superstate gathers its clients' flora and fauna, state by state, to any depth", () => {
    const group = maps.groupStates(map.id, { name: "Union", ids: [north.id, south.id] }).state;
    const west = maps.createState(map.id, { name: "West", polygons: square(30, 0) });
    const outer = maps.groupStates(map.id, { name: "Empire", ids: [group.id, west.id] }).state;
    const moss = species.createSpecies("flora", "Moss", 1, west.id);
    const gathered = species.speciesInClients(outer.id);
    assert.deepStrictEqual(gathered.map((s) => s.title).sort(), ["Frost wolf", "Moss", "Silver oak"]);
    const oak = gathered.find((s) => s.title === "Silver oak");
    assert.deepStrictEqual(oak.found.map((f) => [f.state_name, f.rarity]).sort(), [["North", 2], ["South", 1]]);
    assert.deepStrictEqual(species.speciesInClients(group.id).map((s) => s.title).sort(), ["Frost wolf", "Silver oak"], "one level down");
    assert.deepStrictEqual(species.speciesInClients(north.id), [], "a state with no clients has none");
    assert.deepStrictEqual(species.speciesIn(outer.id), [], "its own list is its own");
    species.addToState(moss.id, outer.id, 4);
    assert.deepStrictEqual(species.speciesIn(outer.id).map((s) => [s.title, s.rarity]), [["Moss", 4]]);
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

check("a name can be used by only one species in Flora or Fauna", () => {
    species.createSpecies("flora", "Dune grass", 1, south.id);
    throws(() => species.createSpecies("flora", "dune GRASS", 2, south.id), "each species has one page");
    throws(() => species.createSpecies("flora", "Dúne grass", 2, south.id), "each species has one page");
    const flora = lore.listCategories().find((c) => c.slug === "flora");
    throws(() => lore.savePage(null, { category_id: flora.id, title: "Dune grass", body: "" }), "each species has one page");
    // renaming a page to a taken name is refused too, but keeping its own name is fine
    const other = species.createSpecies("flora", "Sea kale", 3, south.id);
    throws(() => lore.savePage(other.id, { title: "Dune grass", body: "" }), "each species has one page");
    lore.savePage(other.id, { title: "Sea kale", body: "new text" });
    // a plant and an animal may share a name; other categories are not restricted
    species.createSpecies("fauna", "Dune grass", 3, south.id);
    const places = lore.listCategories().find((c) => c.slug !== "flora" && c.slug !== "fauna");
    lore.savePage(null, { category_id: places.id, title: "Same", body: "" });
    lore.savePage(null, { category_id: places.id, title: "Same", body: "" });
});

check("species can be searched by name, names that start with the text first, leaving out those already in a state", () => {
    species.createSpecies("fauna", "Grass snake", 2, south.id);
    const names = (found) => found.map((s) => `${s.title}:${s.kind}`);
    assert.deepStrictEqual(names(species.searchSpecies("grass")), ["Grass snake:fauna", "Dune grass:flora", "Dune grass:fauna"]);
    assert.deepStrictEqual(names(species.searchSpecies("DÚNE")), ["Dune grass:flora", "Dune grass:fauna"], "accents and case are ignored");
    assert.strictEqual(species.searchSpecies("").length >= 4, true, "no text lists them all");
    assert.deepStrictEqual(species.searchSpecies("zzz"), []);
    assert.deepStrictEqual(species.searchSpecies("100%"), [], "% and _ are plain characters");
    assert.deepStrictEqual(species.searchSpecies("grass", { exceptState: south.id }), []);
    assert.strictEqual(species.searchSpecies("", { limit: 2 }).length, 2);
});

console.log(`\n${passed} checks passed`);
