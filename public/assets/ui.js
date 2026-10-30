// Small shared helpers for the editors (exposed as window.UI).
(() => {
    "use strict";

    const DEFAULT_COLOR = "#6e7681";
    const PROPERTY_ATTRS = new Set(["value", "checked", "disabled", "hidden", "selected"]);

    // Tiny DOM builder: h("div", { class: "x", onclick: fn }, child, "text", ...)
    function h(tag, attrs, ...children) {
        const el = document.createElement(tag);

        for (const [key, value] of Object.entries(attrs || {})) {
            if (value === undefined || value === null || (value === false && !PROPERTY_ATTRS.has(key))) {
                continue;
            }
            if (key.startsWith("on")) {
                el.addEventListener(key.slice(2), value);
            } else if (key === "class") {
                el.className = value;
            } else if (PROPERTY_ATTRS.has(key)) {
                el[key] = value;
            } else {
                el.setAttribute(key, value);
            }
        }

        for (const child of children.flat()) {
            if (child === null || child === undefined || child === false) {
                continue;
            }
            el.append(child);
        }

        return el;
    }

    async function api(method, url, data) {
        const options = { method, headers: {} };

        if (data !== undefined) {
            options.headers["Content-Type"] = "application/json";
            options.body = JSON.stringify(data);
        }

        const response = await fetch(url, options);
        const payload = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(payload.error || `Request failed (${response.status})`);
        }

        return payload;
    }

    // "The Fall of Kyōra!" -> "the-fall-of-kyora" (same rule as the server).
    function slugify(text) {
        return String(text)
            .normalize("NFD")
            .replace(/[̀-ͯ]/g, "")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 80)
            .replace(/-+$/g, "");
    }

    // White or near-black, whichever reads better on the background.
    function inkFor(hex) {
        const channel = (offset) => {
            const c = parseInt(hex.slice(offset, offset + 2), 16) / 255;
            return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        };
        const L = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
        return 1.05 / (L + 0.05) >= (L + 0.05) / (0.0056 + 0.05) ? "#ffffff" : "#111111";
    }

    function badge(name, color, ink) {
        return h("span", {
            class: "lang-tag",
            style: `--lang-bg:${color || DEFAULT_COLOR};--lang-fg:${ink || "#ffffff"}`
        }, name);
    }

    function formatWhen(timestamp) {
        return new Date(timestamp).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
    }

    window.UI = { DEFAULT_COLOR, h, api, slugify, inkFor, badge, formatWhen };
})();
