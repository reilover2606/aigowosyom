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
function columnChart(items, { ariaLabel, unit = "words" }) {
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
        bars += `<text class="axis" x="${left + i * slot + slot / 2}" y="${baseline + 15}" text-anchor="middle">${esc(item.label)}</text>`;

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
            <span class="bar-label">${label}</span>
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
