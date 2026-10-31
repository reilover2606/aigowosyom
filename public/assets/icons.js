// Small inline SVG icons, used instead of symbol and emoji characters that
// older systems have no font for. They take the text color and size of
// their surroundings. This file works in the browser (window.Icons) and on
// the server (require), so both draw the same icons.
//
//   Icons.svg("undo")  -> an SVG string
//   Icons.el("undo")   -> an SVG element (browser only)
(function (root, factory) {
    var icons = factory();

    if (typeof module === "object" && module.exports) {
        module.exports = icons;
    } else {
        root.Icons = icons;
    }
})(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    // Drawn on a 24 x 24 grid with 2px round strokes.
    var PATHS = {
        undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
        redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
        indent: '<path d="M3 5h18M11 10h10M11 15h10M3 20h18"/><path d="m3 9 4 3-4 3"/>',
        outdent: '<path d="M3 5h18M11 10h10M11 15h10M3 20h18"/><path d="m7 9-4 3 4 3"/>',
        close: '<path d="M6 6l12 12M18 6 6 18"/>',
        menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
        rule: '<path d="M3 12h18"/>',
        dice: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 8h.01M16 8h.01M12 12h.01M8 16h.01M16 16h.01"/>',
        book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M20 17v4H6.5A2.5 2.5 0 0 1 4 18.5"/>',
        lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
        external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'
    };

    function svg(name) {
        return '<svg class="icon" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor"'
            + ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"'
            + ' style="vertical-align:-0.15em">' + (PATHS[name] || "") + "</svg>";
    }

    function el(name) {
        var template = document.createElement("template");
        template.innerHTML = svg(name);
        return template.content.firstElementChild;
    }

    return { svg: svg, el: el };
});
