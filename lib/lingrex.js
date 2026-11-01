"use strict";

// An optional second opinion from LingRex (https://github.com/lingpy/lingrex; List 2019, "Automatic
// inference of sound correspondence patterns across multiple languages"), a Python package.
//
// The site's own comparison (lib/correspondences.js) lines the words up and names the changes. LingRex
// does something different: it looks at every sound position in every cognate set and groups positions
// that behave alike into *correspondence patterns*, by where in the word they are (initial consonant,
// medial, final, vowel), then marks patterns backed by only one cognate set as irregular and says
// which regular pattern they are most like. It is a check on regularity: a way to see which
// correspondences the data supports more than once.
//
// This needs Python with the `lingrex` package (`pip install lingrex`), found as $LINGREX_PYTHON or
// python3 / python on the PATH. Nothing else in the site needs it. The work is done by
// tools/lingrex_bridge.py, which is given the site's own alignments (so both analyses look at the same
// lining-up) and prints the patterns as JSON.

const { spawn } = require("node:child_process");
const path = require("node:path");

const BRIDGE = path.join(__dirname, "..", "tools", "lingrex_bridge.py");
const MARK = "@@LINGREX@@";
const TIMEOUT_MS = 45_000;

const candidates = () =>
    process.env.LINGREX_PYTHON ? [process.env.LINGREX_PYTHON] : process.platform === "win32" ? ["python", "py"] : ["python3", "python"];

let running = false;

// Runs a Python program, feeding it `input`; resolves { code, out, err } (or { missing: true } if the
// program doesn't exist).
function run(python, args, input = null) {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(python, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        } catch (error) {
            resolve({ missing: true, err: error.message });
            return;
        }
        let out = "";
        let err = "";
        const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
        child.stdout.on("data", (chunk) => { out += chunk; });
        child.stderr.on("data", (chunk) => { err = (err + chunk).slice(-2000); });
        child.on("error", (error) => {
            clearTimeout(timer);
            resolve({ missing: error.code === "ENOENT", err: error.message });
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            resolve({ code, out, err });
        });
        child.stdin.on("error", () => {});
        child.stdin.end(input);
    });
}

// Which Python can import lingrex, or null.
let found;
async function findPython() {
    if (found && Date.now() - found.at < 60_000) {
        return found.python;
    }
    let python = null;
    for (const candidate of candidates()) {
        const result = await run(candidate, ["-I", "-c", "import lingrex"]);
        if (!result.missing && result.code === 0) {
            python = candidate;
            break;
        }
    }
    found = { python, at: Date.now() };
    return python;
}

// The prosodic position LingRex groups by: i initial consonant, m medial, c final, v vowel.
function tagColumns(columns, isVowel) {
    const vowelAt = columns.map((c) => isVowel((c.from[0] || c.to[0] || "")));
    const first = vowelAt.indexOf(true);
    const last = vowelAt.lastIndexOf(true);
    return columns.map((c, i) => ({
        a: c.from.join(""),
        b: c.to.join(""),
        tag: vowelAt[i] ? "v" : first < 0 || i < first ? "i" : i > last ? "c" : "m"
    }));
}

// result: what correspondences.correspond() returned. Resolves { patterns } or { error }.
async function analyze(result, names) {
    if (running) {
        return { error: "LingRex is already running; try again in a moment." };
    }
    const python = await findPython();
    if (!python) {
        return {
            error: "LingRex isn't available: it needs Python with the lingrex package. Install it with “pip install lingrex” (in a virtual environment if you like) and, if that Python isn't the one called python3 or python, set the LINGREX_PYTHON environment variable to it."
        };
    }
    const pairs = result.alignments
        .map((pair, index) => ({
            id: index + 1,
            concept: pair.from,
            columns: tagColumns(pair.columns, (symbol) => result.kindOfSound(symbol) === "vowel")
        }))
        .filter((pair) => pair.columns.length);
    if (pairs.length === 0) {
        return { error: "There are no word pairs to give LingRex." };
    }

    running = true;
    try {
        const reply = await run(python, ["-I", BRIDGE], JSON.stringify({ ancestor: names.from, descendant: names.to, pairs }));
        const at = reply.out.lastIndexOf(MARK);
        if (at < 0) {
            return { error: `LingRex didn't answer${reply.code ? ` (exit ${reply.code})` : ""}. ${reply.err.trim().split("\n").slice(-2).join(" ")}`.trim() };
        }
        const data = JSON.parse(reply.out.slice(at + MARK.length));
        if (data.error) {
            return { error: data.error };
        }
        return { ...summarize(data.patterns, pairs), version: data.version };
    } catch (error) {
        return { error: `Couldn't read LingRex's answer: ${error.message}` };
    } finally {
        running = false;
    }
}

const POSITIONS = { i: "word-initial consonant", m: "medial consonant", c: "word-final consonant", v: "vowel" };

// Patterns are given per word position; fold them to ancestor sound -> descendant sound, keeping where.
function summarize(patterns, pairs) {
    const concepts = new Map(pairs.map((p) => [String(p.id), p.concept]));
    const byPair = new Map();
    for (const p of patterns) {
        const key = `${p.ancestor}\u0000${p.descendant}`;
        if (!byPair.has(key)) {
            byPair.set(key, { ancestor: p.ancestor, descendant: p.descendant, support: 0, positions: [], cognates: new Set(), variantOf: null });
        }
        const entry = byPair.get(key);
        entry.support += p.support;
        entry.positions.push({ position: POSITIONS[p.structure] || p.structure, support: p.support });
        p.cognates.forEach((c) => entry.cognates.add(concepts.get(c) || c));
        // "irregular variant of" matters when the outcome differs from the regular pattern's.
        if (p.irregular_of && p.irregular_of.descendant !== p.descendant) {
            entry.variantOf = p.irregular_of;
        }
    }
    // An ancestor sound with two outcomes that are each regular in the same word position: position
    // alone doesn't tell them apart, so something else (usually a neighbouring sound) must.
    const competing = [];
    const byAncestor = new Map();
    for (const p of patterns) {
        if (p.support < 2) {
            continue;
        }
        const key = `${p.ancestor}\u0000${p.structure}`;
        if (!byAncestor.has(key)) {
            byAncestor.set(key, { ancestor: p.ancestor, position: POSITIONS[p.structure] || p.structure, outcomes: [] });
        }
        byAncestor.get(key).outcomes.push(p.descendant);
    }
    for (const entry of byAncestor.values()) {
        if (new Set(entry.outcomes).size > 1) {
            competing.push({ ...entry, outcomes: [...new Set(entry.outcomes)] });
        }
    }

    const list = [...byPair.values()]
        .map((e) => ({ ...e, cognates: [...e.cognates].slice(0, 6), regular: e.support >= 2 }))
        .sort((a, b) => b.support - a.support || a.ancestor.localeCompare(b.ancestor));
    return { patterns: list, competing };
}

module.exports = { analyze, findPython };
