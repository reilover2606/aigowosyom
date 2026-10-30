"use strict";

// Language colors: stored as "#rrggbb" or null (= the default gray).

const DEFAULT_COLOR = "#6e7681";
const HEX_PATTERN = /^#[0-9a-f]{6}$/i;

// Returns a lowercase "#rrggbb", or null for an empty value. Throws a
// plain Error for anything else so callers can map it to a 400.
function parseColor(value) {
    if (value === undefined || value === null || value === "") {
        return null;
    }

    if (typeof value !== "string" || !HEX_PATTERN.test(value.trim())) {
        throw new Error("Color must look like #1a2b3c");
    }

    return value.trim().toLowerCase();
}

function luminance(hex) {
    const channel = (offset) => {
        const c = parseInt(hex.slice(offset, offset + 2), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };

    return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

// White or near-black, whichever reads better on the given background.
function inkFor(hex) {
    const L = luminance(hex);
    const withWhite = 1.05 / (L + 0.05);
    const withDark = (L + 0.05) / (luminance("#111111") + 0.05);

    return withWhite >= withDark ? "#ffffff" : "#111111";
}

// The color to actually display, plus a readable text color on top of it.
function resolveColor(color) {
    const hex = color || DEFAULT_COLOR;
    return { color: hex, ink: inkFor(hex) };
}

// Replaces a row's raw `language_color` with the resolved color and adds
// `language_ink`. Works on any row that selected `l.color AS language_color`.
function withLanguageColor(row) {
    const { color, ink } = resolveColor(row.language_color);
    row.language_color = color;
    row.language_ink = ink;
    return row;
}

module.exports = {
    DEFAULT_COLOR,
    parseColor,
    inkFor,
    resolveColor,
    withLanguageColor
};
