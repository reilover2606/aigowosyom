// Theme switcher. Load this in <head> (before the page paints): it puts the
// saved theme on <html data-theme="..."> straight away, then fills in the
// theme picker in the slim top bar once the page has loaded.
//
// To add a theme: add it to THEMES, write its stylesheet under
// /assets/themes/ scoped to html[data-theme="<look>"], and link that stylesheet
// where the others are linked (lib/render.js layout(), public/index.html and
// public/calendar/index.html).
(function () {
    "use strict";

    // [id, label, look, mode]: the look is the data-theme and the mode the
    // data-mode on <html>. Dark modes live in /assets/themes/dark.css.
    var THEMES = [
        ["default", "Default", "default", "light"],
        ["default-dark", "Default (dark)", "default", "dark"],
        ["neumorph", "Neumorphic", "neumorph", "light"],
        ["neumorph-dark", "Neumorphic (dark)", "neumorph", "dark"]
    ];
    var KEY = "aigowosyom.theme";

    function isTheme(id) {
        return THEMES.some(function (theme) { return theme[0] === id; });
    }

    function saved() {
        try {
            return localStorage.getItem(KEY);
        } catch (error) {
            return null; // storage blocked: just use the default
        }
    }

    function apply(id) {
        var theme = THEMES.filter(function (t) { return t[0] === id; })[0] || THEMES[0];

        document.documentElement.setAttribute("data-theme", theme[2]);
        document.documentElement.setAttribute("data-mode", theme[3]);
    }

    var current = isTheme(saved()) ? saved() : "default";
    apply(current);

    document.addEventListener("DOMContentLoaded", function () {
        var select = document.getElementById("themeSelect");

        if (!select) {
            return;
        }

        THEMES.forEach(function (theme) {
            select.appendChild(new Option(theme[1], theme[0]));
        });
        select.value = current;

        select.addEventListener("change", function () {
            current = isTheme(select.value) ? select.value : "default";
            apply(current);

            try {
                localStorage.setItem(KEY, current);
            } catch (error) { /* not saved, but it still applies to this page */ }
        });
    });

    // Another tab changed the theme: follow it.
    window.addEventListener("storage", function (event) {
        if (event.key === KEY && isTheme(event.newValue)) {
            current = event.newValue;
            apply(current);

            var select = document.getElementById("themeSelect");
            if (select) {
                select.value = current;
            }
        }
    });
})();
