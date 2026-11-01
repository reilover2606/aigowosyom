"use strict";

// Server-rendered inline-SVG / HTML charts. Colors come from CSS custom
// properties (see dictionary.css), via the .fill-N / .sw-N classes.

const { esc } = require("./render");

const MAX_SLICES = 7; // named categorical slots before folding into "Other"

function percent(part, whole) {
    return whole ? `${((part / whole) * 100).toFixed(1)}%` : "0%";
}

function number(n) {
    return n.toLocaleString("en-US");
}

// Pie chart plus a legend with counts. Items: [{ label, count }],
// label === null meaning "unspecified". The biggest MAX_SLICES labelled
// items get fixed series colors in order; the rest fold into "Other".
function pieChart(items, { ariaLabel }) {
    const total = items.reduce((sum, item) => sum + item.count, 0);

    if (total === 0) {
        return '<p class="muted">No data.</p>';
    }

    const named = items.filter((item) => item.label !== null);
    const unspecified = items.find((item) => item.label === null);

    const slices = named.slice(0, MAX_SLICES).map((item, i) => ({
        label: item.label,
        count: item.count,
        cls: `${i + 1}`
    }));

    const restCount = named.slice(MAX_SLICES).reduce((sum, item) => sum + item.count, 0);
    if (restCount > 0) {
        slices.push({ label: "other", count: restCount, cls: "other" });
    }
    if (unspecified) {
        slices.push({ label: "unspecified", count: unspecified.count, cls: "none" });
    }

    const cx = 100;
    const cy = 100;
    const r = 92;
    let angle = 0;
    let paths = "";

    for (const slice of slices) {
        const sweep = (slice.count / total) * Math.PI * 2;
        const title = `<title>${esc(slice.label)}: ${number(slice.count)} (${percent(slice.count, total)})</title>`;

        if (slices.length === 1) {
            paths += `<circle class="fill-${slice.cls}" cx="${cx}" cy="${cy}" r="${r}">${title}</circle>`;
        } else {
            const x0 = cx + r * Math.sin(angle);
            const y0 = cy - r * Math.cos(angle);
            angle += sweep;
            const x1 = cx + r * Math.sin(angle);
            const y1 = cy - r * Math.cos(angle);
            const large = sweep > Math.PI ? 1 : 0;

            paths +=
                `<path class="fill-${slice.cls}" d="M${cx} ${cy} L${x0.toFixed(2)} ${y0.toFixed(2)} ` +
                `A${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z">${title}</path>`;
        }
    }

    const legend = slices
        .map(
            (slice) => `<li>
            <span class="swatch sw-${slice.cls}"></span>
            <span class="legend-label">${esc(slice.label)}</span>
            <span class="legend-value">${number(slice.count)} · ${percent(slice.count, total)}</span>
        </li>`
        )
        .join("");

    return `<div class="pie-wrap">
    <svg class="pie" viewBox="0 0 200 200" role="img" aria-label="${esc(ariaLabel)}">${paths}</svg>
    <ul class="legend">${legend}</ul>
</div>`;
}

// Smallest "nice" number (1, 2 or 5 × 10^k) at or above value.
function niceCeil(value) {
    const magnitude = 10 ** Math.floor(Math.log10(value));
    for (const step of [1, 2, 5, 10]) {
        if (step * magnitude >= value) {
            return step * magnitude;
        }
    }
    return 10 * magnitude;
}

// Column chart. Items: [{ label, count, cls? }] where cls picks the series
// color (default 1). Only the tallest bar carries a printed value; all
// bars have hover titles.
function columnChart(items, { ariaLabel, unit = "words", conlangLabels = false }) {
    if (items.length === 0) {
        return '<p class="muted">No data.</p>';
    }

    const max = Math.max(...items.map((item) => item.count));
    const top = niceCeil(Math.max(max, 1));

    const slot = Math.min(44, Math.floor(640 / items.length));
    const barWidth = Math.max(4, Math.round(slot * 0.7));
    const left = 34;
    const plotHeight = 150;
    const topPad = 16;
    const baseline = topPad + plotHeight;
    const width = left + items.length * slot + 6;
    const height = baseline + 22;
    const radius = Math.min(4, barWidth / 2);

    let grid = "";
    for (const tick of [0, top / 2, top]) {
        const y = baseline - (tick / top) * plotHeight;
        grid +=
            `<line class="grid" x1="${left}" x2="${width}" y1="${y}" y2="${y}"/>` +
            `<text class="axis" x="${left - 6}" y="${y + 4}" text-anchor="end">${number(tick)}</text>`;
    }

    const tallest = items.findIndex((item) => item.count === max);
    let bars = "";

    items.forEach((item, i) => {
        const x = left + i * slot + (slot - barWidth) / 2;
        const h = (item.count / top) * plotHeight;
        const y = baseline - h;
        const title = `<title>${esc(item.label)}: ${number(item.count)} ${unit}</title>`;

        if (item.count > 0) {
            const r = Math.min(radius, h);
            bars +=
                `<path class="fill-${item.cls || 1}" d="M${x} ${baseline} V${y + r} ` +
                `Q${x} ${y} ${x + r} ${y} H${x + barWidth - r} ` +
                `Q${x + barWidth} ${y} ${x + barWidth} ${y + r} V${baseline} Z"/>`;
        }

        // Full-height transparent hit target carrying the tooltip.
        bars += `<rect class="hit" x="${left + i * slot}" y="${topPad}" width="${slot}" height="${plotHeight}">${title}</rect>`;
        bars += `<text class="axis${conlangLabels ? " conlang" : ""}" x="${left + i * slot + slot / 2}" y="${baseline + 15}" text-anchor="middle">${esc(item.label)}</text>`;

        if (i === tallest && item.count > 0) {
            bars += `<text class="value" x="${x + barWidth / 2}" y="${y - 4}" text-anchor="middle">${number(item.count)}</text>`;
        }
    });

    return `<svg class="columns" viewBox="0 0 ${width} ${height}" style="max-width:${width * 1.5}px" role="img" aria-label="${esc(ariaLabel)}">
    ${grid}
    <line class="baseline" x1="${left}" x2="${width}" y1="${baseline}" y2="${baseline}"/>
    ${bars}
</svg>`;
}

// Horizontal bars as HTML. Items: [{ label, count, href? }].
function barList(items) {
    if (items.length === 0) {
        return '<p class="muted">None yet.</p>';
    }

    const max = Math.max(...items.map((item) => item.count));

    return `<ul class="bar-list">${items
        .map((item) => {
            const label = item.href
                ? `<a href="${esc(item.href)}">${esc(item.label)}</a>`
                : esc(item.label);
            return `<li>
            <span class="bar-label${item.conlang ? " conlang" : ""}">${label}</span>
            <span class="bar-track"><span class="bar-fill" style="width:${((item.count / max) * 100).toFixed(1)}%${item.color ? `;--bar:${item.color}` : ""}"></span></span>
            <span class="bar-value">${number(item.count)}</span>
        </li>`;
        })
        .join("")}</ul>`;
}

// A two-segment proportion bar (e.g. consonants vs vowels) with a legend.
function splitBar(first, second) {
    const total = first.count + second.count;

    if (total === 0) {
        return '<p class="muted">No data.</p>';
    }

    const segment = (part, cls) =>
        part.count
            ? `<span class="split-segment sw-${cls}" style="flex:${part.count}" title="${esc(part.label)}: ${number(part.count)} (${percent(part.count, total)})"></span>`
            : "";

    return `<div class="split-bar" role="img" aria-label="${esc(first.label)} ${percent(first.count, total)}, ${esc(second.label)} ${percent(second.count, total)}">
    ${segment(first, 1)}${segment(second, 2)}
</div>
<ul class="legend legend-inline">
    <li><span class="swatch sw-1"></span><span class="legend-label">${esc(first.label)}</span><span class="legend-value">${number(first.count)} · ${percent(first.count, total)}</span></li>
    <li><span class="swatch sw-2"></span><span class="legend-label">${esc(second.label)}</span><span class="legend-value">${number(second.count)} · ${percent(second.count, total)}</span></li>
</ul>`;
}

// A single progress meter: part of whole.
function meter(label, part, whole) {
    const pct = whole ? (part / whole) * 100 : 0;

    return `<li>
        <span class="bar-label">${esc(label)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${pct.toFixed(1)}%"></span></span>
        <span class="bar-value">${number(part)} / ${number(whole)} · ${pct.toFixed(0)}%</span>
    </li>`;
}

module.exports = { pieChart, columnChart, barList, splitBar, meter };

// ------------------------------------------------------
// Heatmap (letter-pair matrix)
// ------------------------------------------------------

// A single-hue sequential ramp (light to dark) for counts; zero is blank.
const HEAT_STEPS = [
    { fill: "#b7d3f6", ink: "#0b0b0b" },
    { fill: "#86b6ef", ink: "#0b0b0b" },
    { fill: "#5598e7", ink: "#0b0b0b" },
    { fill: "#2a78d6", ink: "#ffffff" },
    { fill: "#1c5cab", ink: "#ffffff" },
    { fill: "#104281", ink: "#ffffff" },
    { fill: "#0d366b", ink: "#ffffff" }
];
const HEAT_BLANK = "#f3f2ee";

// Counts are heavy-tailed, so steps follow the square root of the share
// of the maximum.
function heatStep(count, max) {
    const t = Math.sqrt(count / max);
    return Math.min(HEAT_STEPS.length - 1, Math.floor(t * HEAT_STEPS.length));
}

function compact(n) {
    return n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

// rows/cols: labels; cells[r][c]: counts; edge: the boundary label.
// rowBreaks/colBreaks: indexes after which to draw a heavier divider.
function heatmap({ rows, cols, cells, max, edge, rowBreaks = [], colBreaks = [], ariaLabel, labelClass: fontClass = "conlang" }) {
    if (max === 0) {
        return '<p class="muted">No data.</p>';
    }

    const size = Math.max(18, Math.min(32, Math.floor(720 / cols.length)));
    const longest = Math.max(...rows.map((label) => [...label].length), 1);
    const left = Math.max(36, 14 + longest * 9);
    const top = 30;
    const width = left + cols.length * size + 4;
    const height = top + rows.length * size + 4;
    const showCounts = size >= 24;

    const name = (label, side) =>
        label === edge ? (side === "from" ? "word start" : "word end") : label;

    let body = "";

    cells.forEach((line, r) => {
        line.forEach((count, c) => {
            const x = left + c * size;
            const y = top + r * size;
            const title = `${name(rows[r], "from")} → ${name(cols[c], "to")}: ${
                count ? `${count.toLocaleString("en-US")} ${count === 1 ? "time" : "times"}` : "never occurs"
            }`;

            if (count === 0) {
                body += `<rect class="hm-cell hm-blank" x="${x}" y="${y}" width="${size}" height="${size}" fill="${HEAT_BLANK}"><title>${esc(title)}</title></rect>`;
                return;
            }

            const step = HEAT_STEPS[heatStep(count, max)];
            body += `<g class="hm-cell"><title>${esc(title)}</title><rect x="${x}" y="${y}" width="${size}" height="${size}" fill="${step.fill}"/>${
                showCounts
                    ? `<text x="${x + size / 2}" y="${y + size / 2 + 3.5}" text-anchor="middle" fill="${step.ink}">${compact(count)}</text>`
                    : ""
            }</g>`;
        });
    });

    const labelClass = (label) => (label === edge ? "hm-label hm-edge" : `hm-label ${fontClass}`);

    const colLabels = cols
        .map((label, c) => `<text class="${labelClass(label)}" x="${left + c * size + size / 2}" y="${top - 8}" text-anchor="middle">${esc(label)}</text>`)
        .join("");
    const rowLabels = rows
        .map((label, r) => `<text class="${labelClass(label)}" x="${left - 8}" y="${top + r * size + size / 2 + 4}" text-anchor="end">${esc(label)}</text>`)
        .join("");

    const dividers =
        rowBreaks.map((i) => `<line class="hm-divider" x1="${left}" x2="${left + cols.length * size}" y1="${top + i * size}" y2="${top + i * size}"/>`).join("") +
        colBreaks.map((i) => `<line class="hm-divider" y1="${top}" y2="${top + rows.length * size}" x1="${left + i * size}" x2="${left + i * size}"/>`).join("");

    return `<div class="heatmap-scroll"><svg class="heatmap" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${esc(ariaLabel)}">
${colLabels}${rowLabels}${body}${dividers}
</svg></div>`;
}

// Legend for the heat ramp: swatches with the lowest count in each step.
function heatLegend(max) {
    const steps = HEAT_STEPS.map((step, i) => {
        const low = i === 0 ? 1 : Math.max(1, Math.ceil(max * (i / HEAT_STEPS.length) ** 2));
        return `<span class="heat-step"><span class="swatch" style="background:${step.fill}"></span>${number(low)}+</span>`;
    }).join("");

    return `<p class="heat-legend"><span class="heat-step"><span class="swatch heat-blank-swatch"></span>never</span>${steps}</p>`;
}

module.exports.heatmap = heatmap;
module.exports.heatLegend = heatLegend;
