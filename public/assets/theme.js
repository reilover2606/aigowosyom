// Theme switcher. Load this in <head> (before the page paints): it puts the
// saved theme on <html data-theme="..."> straight away, then fills in the
// theme picker in the slim top bar once the page has loaded.
//
// To add a theme: add it to THEMES, write its stylesheet under
// /assets/themes/ scoped to html[data-theme="<id>"], and link that stylesheet
// where the others are linked (lib/render.js layout(), public/index.html and
// public/calendar/index.html).
(function () {
    "use strict";

    var THEMES = [
        ["default", "Default"],
        ["neumorph", "Neumorphic"]
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
        document.documentElement.setAttribute("data-theme", id);
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
