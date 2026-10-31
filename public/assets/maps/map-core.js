// The map itself, shared by the public viewer and the editor (window.MapCore).
//
// A map is a flat plane of "map units" (not a geographic projection):
// x runs right and y runs up, over [0, width] x [0, height]. The bundle from
// /api/maps/:id says what is on it. Colors come from CSS variables
// (--map-*, see maps.css), so every theme restyles the map; labels use the
// site's serif font.
(() => {
    "use strict";

    const ol = window.ol;

    // ------------------------------------------------------
    // Colors and fonts, read from the page's CSS
    // ------------------------------------------------------

    const colors = {};

    function readColors() {
        const style = getComputedStyle(document.documentElement);
        const get = (name, fallback) => style.getPropertyValue(name).trim() || fallback;

        colors.sea = get("--map-sea", "#cfe3ee");
        colors.land = get("--map-land", "#efe6cf");
        colors.coast = get("--map-coast", "#8a7a55");
        colors.lake = get("--map-lake", "#cfe3ee");
        colors.river = get("--map-river", "#6d9bc3");
        colors.border = get("--map-border", "#4a3f2a");
        colors.label = get("--map-label", "#2b2b2b");
        colors.halo = get("--map-label-halo", "rgba(255,255,255,0.8)");
        colors.point = get("--map-point", "#7a1f1f");
        colors.water = get("--map-water-label", "#35566f");
        colors.accent = get("--map-accent", "#d4a900");
        colors.serif = get("--font-serif", "serif");
        colors.sans = get("--font-sans", "sans-serif");
    }

    readColors();

    function hexAlpha(hex, alpha) {
        const n = parseInt((hex || "#6e7681").slice(1), 16);
        return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
    }

    // ------------------------------------------------------
    // Shapes from the bundle
    // ------------------------------------------------------

    function vertexMap(bundle) {
        return new Map(bundle.vertices.map(([id, x, y]) => [id, [x, y]]));
    }

    // A state's pieces as polygon coordinates (rings closed, holes included).
    function stateCoordinates(polygons, vmap) {
        return polygons.map((polygon) =>
            polygon.map((ring) => {
                const points = ring.map((id) => vmap.get(id)).filter(Boolean);
                points.push(points[0]);
                return points;
            })
        );
    }

    // Every distinct border edge between corners, with the leaf states (those
    // with a shape) that have it on their outline. An edge is drawn once
    // however many states use it.
    function borderEdges(states) {
        const edges = new Map();

        for (const state of states) {
            for (const polygon of state.polygons) {
                for (const ring of polygon) {
                    ring.forEach((a, i) => {
                        const b = ring[(i + 1) % ring.length];
                        const key = a < b ? `${a},${b}` : `${b},${a}`;
                        if (!edges.has(key)) {
                            edges.set(key, { a, b, owners: new Set() });
                        }
                        edges.get(key).owners.add(state.id);
                    });
                }
            }
        }

        return [...edges.values()];
    }

    // Joins edges into long polylines, so dotted lines run smoothly. Edges are
    // joined while they have the same `signature`; a line also stops at any
    // corner where more or fewer than two of the edges meet.
    function chainEdges(edgeList, vmap, signatureOf) {
        const edges = new Map(edgeList.map((e) => [`${e.a},${e.b}`, { ...e, signature: signatureOf(e) }]));
        const adjacent = new Map();

        for (const [key, edge] of edges) {
            for (const v of [edge.a, edge.b]) {
                if (!adjacent.has(v)) {
                    adjacent.set(v, []);
                }
                adjacent.get(v).push(key);
            }
        }

        const seen = new Set();
        const chains = [];

        const walk = (start, firstKey) => {
            const path = [start];
            let at = start;
            let key = firstKey;

            for (;;) {
                const edge = edges.get(key);
                seen.add(key);
                const next = edge.a === at ? edge.b : edge.a;
                path.push(next);
                const list = adjacent.get(next);
                if (list.length !== 2) {
                    break;
                }
                const following = list[0] === key ? list[1] : list[0];
                if (seen.has(following) || edges.get(following).signature !== edge.signature) {
                    break;
                }
                at = next;
                key = following;
            }

            return path;
        };

        for (const [key, edge] of edges) {
            if (seen.has(key)) {
                continue;
            }
            const forward = walk(edge.a, key);
            let backward = [];
            const list = adjacent.get(edge.a);
            if (list.length === 2) {
                const other = list[0] === key ? list[1] : list[0];
                if (!seen.has(other) && edges.get(other).signature === edge.signature) {
                    backward = walk(edge.a, other).reverse();
                }
            }
            const ids = backward.concat(forward.slice(backward.length ? 1 : 0));
            chains.push(ids.map((id) => vmap.get(id)).filter(Boolean));
        }

        return chains;
    }

    // The borders between states, cut where the states on either side change.
    function borderChains(states, vmap) {
        return chainEdges(borderEdges(states), vmap, (e) => [...e.owners].sort((x, y) => x - y).join(","));
    }

    // The outline of a superstate: the edges that have exactly one of its
    // leaf states on them (so not the borders between its own clients).
    function outlineChains(edgeList, leaves, vmap) {
        const outline = edgeList.filter((e) => [...e.owners].filter((id) => leaves.has(id)).length === 1);
        return chainEdges(outline, vmap, () => "outline");
    }

    // ------------------------------------------------------
    // The scale bar: miles, following the zoom
    // ------------------------------------------------------

    function niceMiles(target) {
        const power = 10 ** Math.floor(Math.log10(target));
        let best = power;
        for (const step of [1, 2, 5, 10]) {
            if (step * power <= target) {
                best = step * power;
            }
        }
        return best;
    }

    function formatMiles(miles) {
        if (miles < 1) {
            return `${Math.round(miles * 5280).toLocaleString()} ft`;
        }
        return `${miles.toLocaleString(undefined, { maximumFractionDigits: 1 })} mi`;
    }

    // ------------------------------------------------------
    // Names on the map: sized to what they name, faded as you zoom in
    // ------------------------------------------------------
    //
    // A name is given a size in map units from the width of what it names
    // (so a big state or sea gets a big name, and the name grows and shrinks
    // with the map as you zoom). Too small on screen and it is left out; once
    // zooming in has made it large it fades out, in proportion, until it is
    // gone, so that it never gets in the way of the land it names.

    const NAME_SMALLEST = 8; // px: below this it isn't drawn
    const NAME_CLEAR = 13; // px: fully visible from here...
    const NAME_FADE_FROM = 24; // ...until it starts to fade
    const NAME_GONE = 64; // px: not drawn from here on

    function nameOpacity(px) {
        let opacity;
        if (px < NAME_SMALLEST || px >= NAME_GONE) {
            opacity = 0;
        } else if (px < NAME_CLEAR) {
            opacity = (px - NAME_SMALLEST) / (NAME_CLEAR - NAME_SMALLEST);
        } else if (px <= NAME_FADE_FROM) {
            opacity = 1;
        } else {
            opacity = 1 - (px - NAME_FADE_FROM) / (NAME_GONE - NAME_FADE_FROM);
        }
        // So faint it can't be read: leave it out, so it doesn't push other names aside.
        return opacity < 0.12 ? 0 : opacity;
    }

    // The size, in map units, of a name `length` letters long that is to sit
    // within something `span` units wide: a fraction `share` of the width
    // (so a bigger place gets a bigger name), but never so big that the name
    // wouldn't fit across it. By the time you have zoomed in until the place
    // fills the screen, its name is large enough to have faded away.
    function nameSize(span, length, share = 0.075) {
        return Math.min(span * share, span / Math.max(length, 4));
    }

    // A CSS color with its opacity scaled (hex or rgb[a]).
    function withOpacity(css, k) {
        if (css.startsWith("#")) {
            return hexAlpha(css, k);
        }
        const match = css.match(/rgba?\(([^)]+)\)/);
        if (!match) {
            return css;
        }
        const [r, g, b, a = 1] = match[1].split(",").map(Number);
        return `rgba(${r}, ${g}, ${b}, ${a * k})`;
    }

    // Spaced-out capitals, the way seas are lettered.
    const lettered = (name) => name.toUpperCase().split("").join("\u2009");

    // ------------------------------------------------------
    // Elevation
    // ------------------------------------------------------

    const NO_LAND = -32768;

    // Lighter is higher. The scale bends so that plains (a few hundred feet)
    // still show variation next to mountains (thousands).
    function elevationShade(feet) {
        const t = Math.pow(Math.min(1, Math.max(0, feet) / 8000), 0.55);
        return Math.round(28 + t * 215);
    }

    // The colour ramp: lowland green, through yellow and tan, to brown, then
    // grey rock and white at the top.
    const RAMP = [
        [0, [84, 138, 72]], [300, [138, 168, 88]], [900, [196, 186, 108]], [2200, [186, 148, 92]],
        [4500, [148, 108, 80]], [8500, [198, 192, 186]], [14000, [250, 250, 250]]
    ];

    function rampColor(feet) {
        if (feet <= RAMP[0][0]) {
            return RAMP[0][1];
        }
        for (let i = 1; i < RAMP.length; i++) {
            if (feet <= RAMP[i][0]) {
                const [f0, c0] = RAMP[i - 1];
                const [f1, c1] = RAMP[i];
                const t = (feet - f0) / (f1 - f0);
                return c0.map((v, k) => Math.round(v + (c1[k] - v) * t));
            }
        }
        return RAMP[RAMP.length - 1][1];
    }

    // CSS gradients showing what the shading looks like, low to high.
    const elevationKey = {
        gray: "linear-gradient(to right, #1c1c1c, #7a7a7a 35%, #f3f3f3)",
        colors: `linear-gradient(to right, ${RAMP.map(([feet, c]) => `rgb(${c.join(",")}) ${Math.round((feet / 14000) * 100)}%`).join(", ")})`
    };

    const feetText = (feet) => `${Math.round(feet).toLocaleString()} ft`;

    // ------------------------------------------------------
    // Building a map view
    // ------------------------------------------------------

    // Keys that move the map: not with a modifier held, not while typing, not behind a dialog.
    const mapKeys = ol.events.condition.all(
        ol.events.condition.noModifierKeys,
        ol.events.condition.targetNotEditable,
        () => !document.querySelector("dialog[open]:not(.choosing)")
    );

    // The arrow keys pan the map, wherever the page's focus is (so clicking outside the map doesn't
    // hand them to the page, which would scroll it). The movement is eased: it speeds up while a key
    // is held and slows to a stop when it is released, and doesn't wait for the keyboard's repeat.
    // They are left alone while typing in a field, using a slider or a list, or with a dialog open.
    const PAN_SPEED = 950; // px per second at full speed
    const PAN_RAMP_UP = 0.22; // seconds from rest to full speed
    const PAN_RAMP_DOWN = 0.16; // ...and from full speed to rest
    const PAN_KEYS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
    const PAN_OWNERS = ["INPUT", "TEXTAREA", "SELECT"];

    function panAllowed(event) {
        if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
            return false;
        }
        const target = event.target;
        if (target && (PAN_OWNERS.includes(target.tagName) || target.isContentEditable)) {
            // A checkbox, radio or button has no use for the arrow keys; text, number, range and select do.
            const type = target.type || "";
            if (!["checkbox", "radio", "button", "submit", "reset", "file", "color"].includes(type) || target.tagName !== "INPUT") {
                return false;
            }
        }
        return !document.querySelector("dialog[open]:not(.choosing)");
    }

    // One set of key listeners for the page; they steer the map made last (an editor makes a new one per map).
    let panning = null;

    function keyboardPan(olView, olMap) {
        if (panning) {
            panning.olView = olView;
            panning.olMap = olMap;
            panning.velocity = [0, 0];
            panning.held.clear();
            return;
        }
        const p = (panning = { olView, olMap, held: new Set(), velocity: [0, 0], frame: null, last: 0 });

        const step = (now) => {
            const dt = Math.min((now - p.last) / 1000, 0.05);
            p.last = now;
            let wanted = [0, 0];
            for (const key of p.held) {
                wanted = [wanted[0] + PAN_KEYS[key][0], wanted[1] + PAN_KEYS[key][1]];
            }
            const length = Math.hypot(wanted[0], wanted[1]);
            if (length > 0) {
                wanted = [(wanted[0] / length) * PAN_SPEED, (wanted[1] / length) * PAN_SPEED];
            }
            p.velocity = p.velocity.map((v, i) => {
                const rate = (wanted[i] === 0 ? PAN_SPEED / PAN_RAMP_DOWN : PAN_SPEED / PAN_RAMP_UP) * dt;
                return Math.abs(wanted[i] - v) <= rate ? wanted[i] : v + Math.sign(wanted[i] - v) * rate;
            });

            if (p.velocity[0] !== 0 || p.velocity[1] !== 0) {
                const center = p.olView.getCenter();
                const resolution = p.olView.getResolution();
                p.olView.setCenter([center[0] + p.velocity[0] * dt * resolution, center[1] + p.velocity[1] * dt * resolution]);
            }
            p.frame = p.held.size || p.velocity[0] !== 0 || p.velocity[1] !== 0 ? requestAnimationFrame(step) : null;
        };

        // In the capture phase, so the page never gets the key (and doesn't scroll).
        document.addEventListener("keydown", (event) => {
            const element = p.olMap.getTargetElement();
            if (PAN_KEYS[event.key] && element && document.contains(element) && panAllowed(event)) {
                event.preventDefault();
                p.held.add(event.key);
                if (p.frame === null) {
                    p.last = performance.now();
                    p.frame = requestAnimationFrame(step);
                }
            }
        }, true);
        document.addEventListener("keyup", (event) => {
            if (p.held.delete(event.key)) {
                event.preventDefault();
            }
        }, true);
        window.addEventListener("blur", () => p.held.clear());
    }

    function create({ target, bundle, editable = false, fullscreen = null }) {
        const view = { editable, bundle: null, vmap: null, selected: null, marked: new Set(), children: new Map(), waterNames: true, listeners: {} };
        const map = bundle.map;
        let extent = [0, 0, map.width, map.height];

        const projection = new ol.proj.Projection({ code: `map-${map.id}`, units: "pixels", extent: [-1e7, -1e7, 1e7, 1e7] });

        const sources = {
            sea: new ol.source.Vector(),
            land: new ol.source.Vector(),
            lakes: new ol.source.Vector(),
            rivers: new ol.source.Vector(),
            oceans: new ol.source.Vector(),
            waterLabels: new ol.source.Vector(),
            states: new ol.source.Vector(),
            borders: new ol.source.Vector(),
            outlines: new ol.source.Vector(),
            labels: new ol.source.Vector(),
            points: new ol.source.Vector()
        };
        view.sources = sources;

        const selectedIs = (type, id) => view.selected && view.selected.type === type && view.selected.id === id;

        // ---- styles ----
        // Styles are made once per look and reused (a pan or zoom asks for a style per shape per frame).
        const styleCache = new Map();
        const cached = (key, make) => {
            let style = styleCache.get(key);
            if (!style) {
                if (styleCache.size > 3000) {
                    styleCache.clear();
                }
                style = make();
                styleCache.set(key, style);
            }
            return style;
        };

        const seaStyle = () => cached(`sea|${colors.sea}`, () => new ol.style.Style({ fill: new ol.style.Fill({ color: colors.sea }) }));
        // While a tracer image is showing (editor), land and lakes let it show through.
        const fillOf = (color) => (view.tracing ? hexAlpha(color, 0.4) : color);
        const landStyle = (feature) => {
            const chosen = selectedIs("feature", feature.get("id"));
            return cached(`land|${fillOf(colors.land)}|${chosen}|${colors.accent}|${colors.coast}`, () => new ol.style.Style({
                fill: new ol.style.Fill({ color: fillOf(colors.land) }),
                stroke: new ol.style.Stroke({ color: chosen ? colors.accent : colors.coast, width: chosen ? 3 : 1.5, lineJoin: "round" })
            }));
        };
        const lakeStyle = (feature) => {
            const chosen = selectedIs("feature", feature.get("id"));
            return cached(`lake|${fillOf(colors.lake)}|${chosen}|${colors.accent}|${colors.coast}`, () => new ol.style.Style({
                fill: new ol.style.Fill({ color: fillOf(colors.lake) }),
                stroke: new ol.style.Stroke({ color: chosen ? colors.accent : colors.coast, width: chosen ? 3 : 1, lineJoin: "round" })
            }));
        };
        // ---- names (see nameOpacity) ----
        const nameStyles = new Map();
        function nameText({ text, px, alpha, weight = "bold", family, color, halo, zIndex = 0, placement, offsetY = 0, star = false }) {
            const size = Math.round(px);
            const fade = Math.round(alpha * 20) / 20;
            const key = [text, size, fade, weight, family, color, halo, zIndex, placement || "", Math.round(offsetY), star].join("|");
            let style = nameStyles.get(key);
            if (!style) {
                const radius = size * 0.5;
                style = new ol.style.Style({
                    zIndex,
                    image: star
                        ? new ol.style.RegularShape({
                            points: 5,
                            radius,
                            radius2: radius * 0.45,
                            fill: new ol.style.Fill({ color: withOpacity(color, fade) }),
                            stroke: new ol.style.Stroke({ color: withOpacity(halo, fade), width: 1.5 })
                        })
                        : undefined,
                    text: new ol.style.Text({
                        text,
                        font: `${weight} ${size}px ${family}`,
                        fill: new ol.style.Fill({ color: withOpacity(color, fade) }),
                        stroke: new ol.style.Stroke({ color: withOpacity(halo, fade), width: Math.max(3, size / 4) }),
                        offsetY: star ? offsetY + radius + size * 0.7 : offsetY,
                        placement,
                        maxAngle: Math.PI / 5,
                        overflow: true
                    })
                });
                if (nameStyles.size > 900) {
                    nameStyles.clear();
                }
                nameStyles.set(key, style);
            }
            return style;
        }

        const riverStyle = (feature, resolution) => {
            const chosen = selectedIs("feature", feature.get("id"));
            // (With the WebGL drawer the river itself is drawn there; only its name is drawn here.)
            const styles = view.renderer === "webgl" ? [] : [new ol.style.Style({
                stroke: new ol.style.Stroke({
                    color: chosen ? colors.accent : colors.river,
                    width: chosen ? 4 : 2.5,
                    lineCap: "round",
                    lineJoin: "round"
                })
            })];

            const name = feature.get("name");
            if (name && view.waterNames) {
                // The name runs along the river, sized to its length.
                const px = nameSize(feature.get("length") * 0.55, name.length, 0.12) / resolution;
                const alpha = nameOpacity(px);
                if (alpha > 0) {
                    styles.push(nameText({ text: name, px, alpha, weight: "italic", family: colors.serif, color: colors.water, halo: colors.halo, placement: "line", offsetY: -px * 0.6 }));
                }
            }
            return styles;
        };

        // The outline of a sea or ocean is only for the editor (it is what the name is sized to).
        const oceanStyle = (feature) => {
            if (!editable) {
                return null;
            }
            const chosen = selectedIs("feature", feature.get("id"));
            return new ol.style.Style({
                stroke: new ol.style.Stroke({ color: chosen ? colors.accent : withOpacity(colors.river, 0.7), width: chosen ? 3 : 1.5, lineDash: [8, 6] })
            });
        };

        const waterLabelStyle = (feature, resolution) => {
            if (!view.waterNames) {
                return null;
            }
            const sea = feature.get("kind") === "ocean";
            const shown = sea ? lettered(feature.get("name")) : feature.get("name");
            // A sea's name is spread out across it; a lake's fills more of its lake.
            const px = (sea ? nameSize(feature.get("span"), shown.length * 0.85, 0.035) : nameSize(feature.get("span"), shown.length, 0.1)) / resolution;
            const alpha = nameOpacity(px);
            return alpha > 0
                ? nameText({ text: shown, px, alpha, weight: "italic", family: colors.serif, color: colors.water, halo: colors.halo, zIndex: sea ? 1 : 2 })
                : null;
        };
        const stateStyle = (feature) => {
            const marked = view.marked.has(feature.get("id"));
            return cached(`state|${feature.get("color")}|${marked}`, () => new ol.style.Style({
                fill: new ol.style.Fill({ color: hexAlpha(feature.get("color"), marked ? 0.42 : 0.2) })
            }));
        };
        // The outline of a superstate, heavier than the dots between its clients.
        const outlineStyle = (feature) => {
            const width = selectedIs("state", feature.get("groupId")) ? 6 : Math.max(2.5, 4.5 - feature.get("depth") * 1.5);
            return cached(`outline|${feature.get("color")}|${width}`, () => new ol.style.Style({
                stroke: new ol.style.Stroke({ color: hexAlpha(feature.get("color"), 0.95), width, lineJoin: "round", lineCap: "round" })
            }));
        };
        // The dotted borders are the costliest thing to draw, so while the map is being moved
        // they are drawn as a plain thin line and dotted again once it stops.
        let moving = false;
        const borderStyle = () => moving
            ? cached(`border-plain|${colors.border}`, () => new ol.style.Style({
                stroke: new ol.style.Stroke({ color: withOpacity(colors.border, 0.7), width: 1 })
            }))
            : cached(`border|${colors.border}`, () => new ol.style.Style({
            stroke: new ol.style.Stroke({
                color: colors.border,
                width: 2,
                lineDash: [0.5, 6], // round dots
                lineCap: "round"
            })
        }));
        const labelStyle = (feature, resolution) => {
            const group = feature.get("group");
            const text = group ? feature.get("name").toUpperCase() : feature.get("name");
            const px = nameSize(feature.get("span"), text.length, 0.075) / resolution;
            const alpha = nameOpacity(px);
            if (alpha === 0) {
                return null;
            }
            // A superstate's name is placed first, so it takes the place of its clients' names.
            return nameText({
                text, px, alpha,
                family: colors.serif, // state names are proper nouns, set like the rest of the text
                color: colors.label,
                halo: colors.halo,
                zIndex: group ? 10 : 5, // where names collide, the higher z-index keeps its place (and, level, the one drawn first)
                star: Boolean(feature.get("capital"))
            });
        };
        // A place's name stays small at every zoom (a capital's a little larger than a village's),
        // and is only shown, fading in, once the state that holds the place fills most of the
        // screen: from PLACE_SHOW_FROM of it to PLACE_SHOW_FULL. A selected place always shows.
        const PLACE_FONT = { capital: 14, city: 13, port: 12, fortress: 12, town: 12, landmark: 12, ruin: 11, village: 11, other: 11 };
        const PLACE_SHOW_FROM = 0.6;
        const PLACE_SHOW_FULL = 0.8;
        const pointStyle = (feature, resolution) => {
            const chosen = selectedIs("point", feature.get("id"));
            const size = PLACE_FONT[feature.get("kind")] || 11;
            let alpha = 0;
            const screen = view.ol && view.ol.getSize();
            const home = feature.get("home"); // [width, height] in map units of the state holding it
            if (screen && home) {
                const share = Math.max(home[0] / (screen[0] * resolution), home[1] / (screen[1] * resolution));
                alpha = Math.min(1, Math.max(0, (share - PLACE_SHOW_FROM) / (PLACE_SHOW_FULL - PLACE_SHOW_FROM)));
            }
            if (chosen) {
                alpha = 1;
            }
            const fade = Math.round(alpha * 10) / 10;
            const name = fade > 0 ? feature.get("name") : "";
            return cached(`point|${chosen}|${size}|${fade}|${name}|${colors.accent}|${colors.point}|${colors.label}|${colors.halo}|${colors.serif}`, () => new ol.style.Style({
                image: new ol.style.Circle({
                    radius: chosen ? 8 : 5.5,
                    fill: new ol.style.Fill({ color: chosen ? colors.accent : colors.point }),
                    stroke: new ol.style.Stroke({ color: "#ffffff", width: 2 })
                }),
                text: fade > 0
                    ? new ol.style.Text({
                        text: feature.get("name"),
                        font: `${size}px ${colors.serif}`,
                        offsetY: -(10 + size * 0.7),
                        fill: new ol.style.Fill({ color: withOpacity(colors.label, fade) }),
                        stroke: new ol.style.Stroke({ color: withOpacity(colors.halo, fade), width: 3.5 }),
                        overflow: false
                    })
                    : undefined
            }));
        };

        const byRank = (a, b) => (b.get("rank") || 0) - (a.get("rank") || 0);

        // Bottom to top: sea, tracer images (z-index 1), land, lakes, rivers, states, borders, names, places.
        // Shapes keep being drawn while the map is dragged or zoomed, with a wide margin around the
        // screen, so new ground appears as you pan instead of after you let go. Names and places
        // (which are laid out against each other, the costly part) keep their last layout meanwhile.
        const layer = (source, style, zIndex, extra = {}) => new ol.layer.Vector({
            source, style, zIndex,
            renderBuffer: 400,
            updateWhileInteracting: !extra.declutter,
            updateWhileAnimating: !extra.declutter,
            ...extra
        });
        view.layers = {
            sea: layer(sources.sea, seaStyle, 0),
            land: layer(sources.land, landStyle, 2),
            lakes: layer(sources.lakes, lakeStyle, 3),
            rivers: layer(sources.rivers, riverStyle, 4),
            oceans: layer(sources.oceans, oceanStyle, 1.5),
            elevation: new ol.layer.Image({ zIndex: 2.5, visible: false, opacity: 0.7 }),
            states: layer(sources.states, stateStyle, 5),
            borders: layer(sources.borders, borderStyle, 6),
            outlines: layer(sources.outlines, outlineStyle, 6.5),
            // Where names collide the bigger one wins, so a superstate's name takes
            // the place of its clients' names until they are big enough to show.
            waterLabels: layer(sources.waterLabels, waterLabelStyle, 6.8, { declutter: "names", renderOrder: byRank }),
            labels: layer(sources.labels, labelStyle, 7, { declutter: "names", renderOrder: byRank }),
            points: layer(sources.points, pointStyle, 8, { declutter: "places" })
        };

        view.imageLayers = [];

        const olView = new ol.View({
            projection,
            center: [map.width / 2, map.height / 2],
            resolution: Math.max(map.width, map.height) / 600,
            minResolution: 0.02,
            maxResolution: Math.max(map.width, map.height) * 2,
            smoothResolutionConstraint: true,
            constrainResolution: false
        });

        const olMap = new ol.Map({
            target,
            view: olView,
            layers: Object.values(view.layers),
            controls: ol.control.defaults.defaults({ attribution: false, rotate: false }),
            // The arrow keys pan (and + and - zoom) wherever the page's focus is, except while typing
            // in a field, using a slider, or with a dialog open.
            keyboardEventTarget: document,
            interactions: ol.interaction.defaults
                .defaults(
                    editable
                        ? { doubleClickZoom: false, altShiftDragRotate: false, pinchRotate: false, keyboard: false }
                        : { altShiftDragRotate: false, pinchRotate: false, keyboard: false }
                )
                .extend([
                    new ol.interaction.KeyboardZoom({ condition: mapKeys })
                ])
        });
        view.ol = olMap;
        keyboardPan(olView, olMap);
        olMap.on("movestart", () => {
            moving = true;
            view.layers.borders.changed();
        });
        olMap.on("moveend", () => {
            moving = false;
            view.layers.borders.changed();
        });
        view.olView = olView;
        view.projection = projection;

        // Full screen: the map together with its side column (`fullscreen` is the element holding both).
        if (fullscreen && document.fullscreenEnabled) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "map-fullscreen";
            const sync = () => {
                const on = document.fullscreenElement === fullscreen;
                button.replaceChildren(Icons.el(on ? "minimize" : "maximize"));
                button.title = on ? "Leave full screen" : "Full screen";
                button.setAttribute("aria-label", button.title);
                olMap.updateSize();
            };
            button.addEventListener("click", () => {
                if (document.fullscreenElement) {
                    document.exitFullscreen();
                } else {
                    fullscreen.requestFullscreen().catch(() => {});
                }
            });
            document.addEventListener("fullscreenchange", sync);
            olMap.addControl(new ol.control.Control({ element: button }));
            sync();
        }

        // ---- (re)building the content ----
        function rebuild(next) {
            view.bundle = next;
            view.vmap = vertexMap(next);
            const m = next.map;
            extent = [0, 0, m.width, m.height];
            for (const source of Object.values(sources)) {
                source.clear(true);
            }

            sources.sea.addFeature(new ol.Feature(ol.geom.Polygon.fromExtent(extent)));

            for (const f of next.features) {
                const target = { land: sources.land, lake: sources.lakes, river: sources.rivers, ocean: sources.oceans }[f.kind];
                const geometry = geometryOf(f.geometry);
                const feature = new ol.Feature({ geometry, id: f.id, kind: f.kind, name: f.name });
                feature.setId(`feature-${f.id}`);

                if (f.kind === "river") {
                    feature.set("length", geometry.getLength());
                }
                target.addFeature(feature);

                // A named lake or sea has its name in the middle of it.
                if (f.name && (f.kind === "lake" || f.kind === "ocean")) {
                    const box = geometry.getExtent();
                    sources.waterLabels.addFeature(new ol.Feature({
                        geometry: new ol.geom.Point(geometry.getInteriorPoint().getCoordinates().slice(0, 2)),
                        name: f.name, kind: f.kind, span: box[2] - box[0], rank: f.kind === "ocean" ? 0 : box[2] - box[0]
                    }));
                }
            }

            rebuildStates();

            // The state that holds each place (the smallest, if shapes overlap), for when its name shows.
            const shapes = next.states.filter((st) => st.polygons.length).map((st) => {
                const polygons = stateCoordinates(st.polygons, view.vmap).map((coordinates) => new ol.geom.Polygon(coordinates));
                const box = ol.extent.createEmpty();
                polygons.forEach((polygon) => ol.extent.extend(box, polygon.getExtent()));
                return { polygons, size: [box[2] - box[0], box[3] - box[1]] };
            });

            for (const p of next.points) {
                const holder = shapes
                    .filter((shape) => shape.polygons.some((polygon) => polygon.intersectsCoordinate([p.x, p.y])))
                    .sort((a, b) => a.size[0] * a.size[1] - b.size[0] * b.size[1])[0];
                const feature = new ol.Feature({
                    geometry: new ol.geom.Point([p.x, p.y]), id: p.id, name: p.name, kind: p.kind,
                    home: holder ? holder.size : null
                });
                feature.setId(`point-${p.id}`);
                sources.points.addFeature(feature);
            }

            updateScale();
        }

        function geometryOf(geojson) {
            return geojson.type === "LineString"
                ? new ol.geom.LineString(geojson.coordinates)
                : new ol.geom.Polygon(geojson.coordinates);
        }

        // States, their dotted borders and their names. Cheap enough to redo
        // while a corner is being dragged.
        function rebuildStates() {
            sources.states.clear(true);
            sources.borders.clear(true);
            sources.outlines.clear(true);
            sources.labels.clear(true);

            const all = view.bundle.states;
            view.byId = new Map(all.map((s) => [s.id, s]));
            view.children = new Map();
            for (const s of all) {
                if (s.parent_id && view.byId.has(s.parent_id)) {
                    if (!view.children.has(s.parent_id)) {
                        view.children.set(s.parent_id, []);
                    }
                    view.children.get(s.parent_id).push(s.id);
                }
            }

            const leaves = all.filter((s) => s.polygons.length > 0);

            for (const s of leaves) {
                const coordinates = stateCoordinates(s.polygons, view.vmap);
                if (!coordinates.length || coordinates.some((p) => p[0].length < 4)) {
                    continue;
                }
                const geometry = new ol.geom.MultiPolygon(coordinates);
                const feature = new ol.Feature({ geometry, id: s.id, name: s.name, color: s.color });
                feature.setId(`state-${s.id}`);
                sources.states.addFeature(feature);

                // The name sits at the middle of the biggest piece.
                let biggest = null;
                for (const polygon of geometry.getPolygons()) {
                    if (!biggest || polygon.getArea() > biggest.getArea()) {
                        biggest = polygon;
                    }
                }
                const box = biggest.getExtent();
                const label = new ol.Feature({
                    geometry: new ol.geom.Point(biggest.getInteriorPoint().getCoordinates().slice(0, 2)),
                    id: s.id, name: s.name, span: box[2] - box[0], capital: s.status === "capital",
                    rank: nameSize(box[2] - box[0], s.name.length)
                });
                sources.labels.addFeature(label);
            }

            for (const chain of borderChains(leaves, view.vmap)) {
                if (chain.length > 1) {
                    sources.borders.addFeature(new ol.Feature(new ol.geom.LineString(chain)));
                }
            }

            // Superstates: an outline around their clients, and a name over them.
            const edges = borderEdges(leaves);
            const depthOf = (s) => {
                let depth = 0;
                for (let at = s; at && at.parent_id && depth < 20; depth++) {
                    at = view.byId.get(at.parent_id);
                }
                return depth;
            };
            // A state with no superstate (independent) has a solid outline in its colour too, like a
            // superstate; the dotted line stays for the borders between a superstate's clients.
            for (const s of leaves) {
                if (s.parent_id && view.byId.has(s.parent_id)) {
                    continue;
                }
                for (const chain of outlineChains(edges, new Set([s.id]), view.vmap)) {
                    if (chain.length > 1) {
                        sources.outlines.addFeature(new ol.Feature({ geometry: new ol.geom.LineString(chain), color: s.color, groupId: s.id, depth: 0 }));
                    }
                }
            }

            // Outer superstates first, so the inner ones are drawn over them (thinner).
            const groups = all.filter((s) => s.polygons.length === 0).sort((a, b) => depthOf(a) - depthOf(b));
            for (const group of groups) {
                const members = new Set(view.leafIds(group.id));
                if (members.size === 0) {
                    continue;
                }

                for (const chain of outlineChains(edges, members, view.vmap)) {
                    if (chain.length > 1) {
                        const line = new ol.Feature({ geometry: new ol.geom.LineString(chain), color: group.color, groupId: group.id, depth: depthOf(group) });
                        sources.outlines.addFeature(line);
                    }
                }

                const box = view.stateExtent(group.id);
                if (box) {
                    sources.labels.addFeature(new ol.Feature({
                        geometry: new ol.geom.Point([(box[0] + box[2]) / 2, (box[1] + box[3]) / 2]),
                        id: group.id, name: group.name, span: box[2] - box[0], group: true,
                        rank: nameSize(box[2] - box[0], group.name.length) * 1.5
                    }));
                }
            }
        }

        function repaint() {
            for (const l of Object.values(view.layers)) {
                l.changed();
            }
            if (glDrawer) {
                glDrawer.changed();
            }
        }

        // ---- the two drawers: OpenLayers' own canvas drawing, or the WebGL drawer (map-webgl.js) ----
        // With WebGL the shapes (land, lakes, rivers, states, borders, outlines) are drawn there and the
        // matching OpenLayers layers are hidden; names, places, elevation and tracer images stay as they are.
        let glDrawer = null;
        const GL_DRAWS = ["land", "lakes", "states", "borders", "outlines"];
        view.renderer = "canvas";
        view.shown = {};

        function applyShown() {
            const webgl = view.renderer === "webgl";
            for (const name of Object.keys(view.layers)) {
                if (name === "elevation") {
                    continue;
                }
                const wanted = view.shown[name] !== false;
                if (webgl && GL_DRAWS.includes(name)) {
                    view.layers[name].setVisible(false);
                } else if (view.shown[name] !== undefined || GL_DRAWS.includes(name)) {
                    view.layers[name].setVisible(wanted);
                }
            }
            if (glDrawer) {
                glDrawer.layers.forEach((l) => l.setVisible(webgl));
                glDrawer.setShown({
                    land: view.shown.land,
                    lakes: view.shown.lakes,
                    rivers: view.shown.rivers,
                    states: view.shown.states
                });
            }
        }

        // Chooses the drawer: "canvas" or "webgl". Returns the one now in use (WebGL falls back to
        // the canvas drawer when this browser can't do it).
        view.setRenderer = (name) => {
            if (name === "webgl" && !glDrawer && window.MapGL && MapGL.supported()) {
                const drawer = MapGL.create({ ol, sources, colors, selectedIs, fillOf, hexAlpha, marked: () => view.marked });
                if (drawer.working) {
                    glDrawer = drawer;
                    drawer.layers.forEach((l) => olMap.addLayer(l));
                }
            }
            view.renderer = name === "webgl" && glDrawer ? "webgl" : "canvas";
            applyShown();
            repaint();
            return view.renderer;
        };

        // ---- the scale bar ----
        const scale = document.createElement("div");
        scale.className = "map-scale";
        scale.innerHTML = '<div class="map-scale-label"></div><div class="map-scale-bar"></div>';
        olMap.getViewport().appendChild(scale);

        function updateScale() {
            const milesPerUnit = view.bundle ? view.bundle.map.miles_per_unit : 1;
            const milesPerPixel = olView.getResolution() * milesPerUnit;
            const miles = niceMiles(milesPerPixel * 110);
            scale.querySelector(".map-scale-bar").style.width = `${Math.max(8, miles / milesPerPixel)}px`;
            scale.querySelector(".map-scale-label").textContent = formatMiles(miles);
        }
        olView.on("change:resolution", updateScale);

        // ---- public helpers ----
        view.rebuild = rebuild;
        view.rebuildStates = rebuildStates;
        view.repaint = repaint;
        view.updateScale = updateScale;

        // ---- elevation: a shaded cell for every land cell ----
        // view.elevation = { cols, rows, cell, data: Int16Array } (row 0 at the
        // bottom of the map, -32768 where there is no land).
        const readout = document.createElement("div");
        readout.className = "map-readout";
        readout.hidden = true;
        olMap.getViewport().appendChild(readout);

        let shade = null; // an offscreen canvas, one pixel per cell
        let shadeContext = null;

        const elevationSource = new ol.source.ImageCanvas({
            projection,
            ratio: 1,
            canvasFunction(extentWanted, resolution, pixelRatio, size) {
                const canvas = document.createElement("canvas");
                canvas.width = size[0];
                canvas.height = size[1];
                if (shade && view.elevation) {
                    const context = canvas.getContext("2d");
                    const { cols, rows, cell } = view.elevation;
                    context.imageSmoothingEnabled = false;
                    // The grid covers [0, cols*cell] x [0, rows*cell]; canvas y runs down.
                    context.drawImage(
                        shade, 0, 0, cols, rows,
                        (0 - extentWanted[0]) / resolution * pixelRatio,
                        (extentWanted[3] - rows * cell) / resolution * pixelRatio,
                        (cols * cell) / resolution * pixelRatio,
                        (rows * cell) / resolution * pixelRatio
                    );
                }
                return canvas;
            }
        });
        view.layers.elevation.setSource(elevationSource);

        // How the elevation is drawn: a tint ("none", "gray" or "colors") and/or
        // relief shading (light falling from the north-west on the slopes).
        view.elevationStyle = { tint: "none", relief: false };

        // Relief: how much light a cell catches, 1 on flat ground, from the slope toward its neighbours.
        const LIGHT = [-0.5, 0.5, Math.SQRT1_2]; // from the north-west, 45 degrees up
        const EXAGGERATION = 4; // slopes are gentle at a mile a cell, so they are stretched
        function relief(grid, col, row, cellFeet) {
            const at = (c, r) => {
                const value = grid.data[Math.max(0, Math.min(grid.rows - 1, r)) * grid.cols + Math.max(0, Math.min(grid.cols - 1, c))];
                return value === NO_LAND ? grid.data[row * grid.cols + col] : value; // no cliff at the coast
            };
            const dx = ((at(col + 1, row) - at(col - 1, row)) / (2 * cellFeet)) * EXAGGERATION;
            const dy = ((at(col, row + 1) - at(col, row - 1)) / (2 * cellFeet)) * EXAGGERATION;
            const length = Math.hypot(dx, dy, 1);
            const lit = (-dx * LIGHT[0] - dy * LIGHT[1] + LIGHT[2]) / length;
            return Math.max(0.3, Math.min(1.45, lit / Math.SQRT1_2));
        }

        // Paints cells (all of them, or the rectangle { x, y, w, h }) into the shading.
        view.paintElevation = (rect) => {
            const grid = view.elevation;
            if (!grid) {
                return;
            }
            const { tint, relief: shaded } = view.elevationStyle;
            const cellFeet = grid.cell * (view.bundle ? view.bundle.map.miles_per_unit : 1) * 5280;

            // Relief looks at the neighbours, so a changed cell changes the ones around it too.
            let { x, y, w, h } = rect || { x: 0, y: 0, w: grid.cols, h: grid.rows };
            if (shaded) {
                const x1 = Math.min(grid.cols, x + w + 1);
                const y1 = Math.min(grid.rows, y + h + 1);
                x = Math.max(0, x - 1);
                y = Math.max(0, y - 1);
                w = x1 - x;
                h = y1 - y;
            }

            const image = shadeContext.createImageData(w, h);
            for (let row = 0; row < h; row++) {
                for (let col = 0; col < w; col++) {
                    const feet = grid.data[(y + row) * grid.cols + x + col];
                    // Row 0 of the grid is the bottom of the picture.
                    const at = ((h - 1 - row) * w + col) * 4;
                    if (feet === NO_LAND) {
                        image.data[at + 3] = 0;
                        continue;
                    }
                    let color;
                    if (tint === "colors") {
                        color = rampColor(feet);
                    } else if (tint === "gray") {
                        const gray = elevationShade(feet);
                        color = [gray, gray, gray];
                    } else {
                        color = [200, 200, 200]; // relief alone: a neutral surface to light
                    }
                    const light = shaded ? relief(grid, x + col, y + row, cellFeet) : 1;
                    image.data[at] = Math.min(255, color[0] * light);
                    image.data[at + 1] = Math.min(255, color[1] * light);
                    image.data[at + 2] = Math.min(255, color[2] * light);
                    image.data[at + 3] = 255;
                }
            }
            shadeContext.putImageData(image, x, grid.rows - y - h);
            elevationSource.changed();
        };

        // { tint, relief }: any combination; both off hides the layer.
        view.setElevationStyle = (style) => {
            view.elevationStyle = { tint: style.tint || "none", relief: Boolean(style.relief) };
            const on = view.elevationStyle.tint !== "none" || view.elevationStyle.relief;
            view.layers.elevation.setVisible(on);
            if (!on) {
                readout.hidden = true;
            } else {
                view.paintElevation();
            }
        };

        // Sets (or clears, with null) the elevation grid to show.
        view.setElevation = (grid) => {
            view.elevation = grid;
            if (!grid) {
                shade = null;
                elevationSource.changed();
                return;
            }
            if (!shade || shade.width !== grid.cols || shade.height !== grid.rows) {
                shade = document.createElement("canvas");
                shade.width = grid.cols;
                shade.height = grid.rows;
                shadeContext = shade.getContext("2d", { willReadFrequently: true });
            }
            view.paintElevation();
        };

        // The cell under a map position: [col, row], or null off the grid.
        view.elevationCell = (coordinate) => {
            const grid = view.elevation;
            if (!grid) {
                return null;
            }
            const col = Math.floor(coordinate[0] / grid.cell);
            const row = Math.floor(coordinate[1] / grid.cell);
            return col >= 0 && row >= 0 && col < grid.cols && row < grid.rows ? [col, row] : null;
        };

        // Feet above the sea at a position, or null where it isn't land.
        view.elevationAt = (coordinate) => {
            const at = view.elevationCell(coordinate);
            if (!at) {
                return null;
            }
            const feet = view.elevation.data[at[1] * view.elevation.cols + at[0]];
            return feet === NO_LAND ? null : feet;
        };

        // Elevation under the pointer, while the shading is on.
        olMap.on("pointermove", (event) => {
            if (event.dragging || !view.layers.elevation.getVisible() || !view.elevation) {
                return;
            }
            const feet = view.elevationAt(event.coordinate);
            readout.hidden = feet === null;
            if (feet !== null) {
                readout.textContent = `Elevation ${feetText(feet)}`;
            }
        });
        olMap.getViewport().addEventListener("mouseleave", () => { readout.hidden = true; });

        view.fit = (box, options = {}) => {
            olView.fit(box || extent, { padding: [30, 30, 30, 30], duration: options.animate ? 400 : 0, maxResolution: undefined, ...options });
        };

        // The states with a shape that make up a state: itself, or (for a
        // superstate) all its clients, however deep.
        view.leafIds = (id) => {
            const state = view.byId && view.byId.get(id);
            if (!state) {
                return [];
            }
            if (state.polygons.length > 0) {
                return [id];
            }
            return (view.children.get(id) || []).flatMap((child) => view.leafIds(child));
        };

        // Where a state (or all of a superstate) is on the map.
        view.stateExtent = (id) => {
            const box = ol.extent.createEmpty();
            let any = false;
            for (const leaf of view.leafIds(id)) {
                const feature = sources.states.getFeatureById(`state-${leaf}`);
                if (feature) {
                    ol.extent.extend(box, feature.getGeometry().getExtent());
                    any = true;
                }
            }
            return any ? box : null;
        };

        // `selection` is what the panel shows; `more` are further states (or
        // superstates) marked along with it, for combining. A superstate marks
        // all its clients.
        view.select = (selection, more = []) => {
            view.selected = selection;
            view.marked = new Set();
            const ids = [...more];
            if (selection && selection.type === "state") {
                ids.push(selection.id);
            }
            for (const id of ids) {
                for (const leaf of view.leafIds(id)) {
                    view.marked.add(leaf);
                }
            }
            repaint();
        };

        // The shapes under a pixel: points first, then states.
        view.pick = (pixel) => {
            if (view.renderer === "webgl") {
                return pickFromSources(pixel);
            }
            let found = null;
            olMap.forEachFeatureAtPixel(
                pixel,
                (feature, source) => {
                    if (feature.get("id") === undefined || found) {
                        return;
                    }
                    const layerKind = source === view.layers.points ? "point"
                        : source === view.layers.states ? "state"
                        : (source === view.layers.land || source === view.layers.lakes || source === view.layers.rivers || source === view.layers.oceans) ? "feature" : null;
                    if (layerKind) {
                        found = { type: layerKind, id: feature.get("id") };
                    }
                },
                { hitTolerance: 4, layerFilter: (l) => l === view.layers.points || (editable ? true : l === view.layers.states) }
            );
            return found;
        };

        // The same answer as above when the OpenLayers layers aren't drawn (so can't be hit-tested):
        // places through their layer, then, top to bottom, states, rivers, lakes, land and sea outlines.
        function pickFromSources(pixel) {
            let found = null;
            olMap.forEachFeatureAtPixel(
                pixel,
                (feature) => {
                    if (feature.get("id") !== undefined && !found) {
                        found = { type: "point", id: feature.get("id") };
                    }
                },
                { hitTolerance: 4, layerFilter: (l) => l === view.layers.points }
            );
            if (found) {
                return found;
            }

            const coordinate = olMap.getCoordinateFromPixel(pixel);
            const tolerance = 4 * olView.getResolution();
            const near = ol.extent.buffer([coordinate[0], coordinate[1], coordinate[0], coordinate[1]], tolerance);
            const shown = (name) => view.shown[name] !== false;
            const onLine = (geometry) => {
                const closest = geometry.getClosestPoint(coordinate);
                return Math.hypot(closest[0] - coordinate[0], closest[1] - coordinate[1]) <= tolerance;
            };
            const first = (source, test, type) => {
                const features = source.getFeaturesInExtent(near).filter((f) => f.get("id") !== undefined && test(f.getGeometry()));
                const feature = features[features.length - 1]; // the one drawn last is on top
                return feature ? { type, id: feature.get("id") } : null;
            };

            if (shown("states")) {
                found = first(sources.states, (g) => g.intersectsCoordinate(coordinate), "state");
            }
            if (!found && editable) {
                if (shown("rivers")) {
                    found = first(sources.rivers, onLine, "feature");
                }
                if (!found && shown("lakes")) {
                    found = first(sources.lakes, (g) => g.intersectsCoordinate(coordinate) || onLine(g), "feature");
                }
                if (!found && shown("land")) {
                    found = first(sources.land, (g) => g.intersectsCoordinate(coordinate) || onLine(g), "feature");
                }
                if (!found && shown("oceans")) {
                    found = first(sources.oceans, onLine, "feature");
                }
            }
            return found;
        }

        // Tracer images (editor), each under everything else.
        view.setImages = (images) => {
            for (const l of view.imageLayers) {
                olMap.removeLayer(l);
            }
            view.imageLayers = images.map((image) => {
                const l = new ol.layer.Image({
                    zIndex: 1,
                    opacity: image.opacity,
                    visible: Boolean(image.visible),
                    source: new ol.source.ImageStatic({
                        url: `/api/map-images/${image.id}/file`,
                        imageExtent: [image.x, image.y, image.x + image.width, image.y + image.height],
                        projection
                    })
                });
                olMap.addLayer(l);
                return l;
            });
        };

        view.show = (name, visible) => {
            view.shown[name] = visible;
            applyShown();
        };

        // River, lake and sea names on or off.
        view.setWaterNames = (on) => {
            view.waterNames = on;
            view.layers.rivers.changed();
            view.layers.waterLabels.changed();
        };

        view.setTracing = (on) => {
            if (view.tracing !== on) {
                view.tracing = on;
                view.layers.land.changed();
                view.layers.lakes.changed();
            }
        };

        // Follow theme changes (the colors come from CSS).
        new MutationObserver(() => {
            readColors();
            repaint();
        }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-mode"] });

        rebuild(bundle);
        if (savedRenderer() === "webgl") {
            view.setRenderer("webgl");
        }
        // The fit needs the element's size.
        requestAnimationFrame(() => {
            olMap.updateSize();
            view.fit(extent);
        });

        return view;
    }

    // States as a tree: [{ ...state, kids: [...] }], each level in name order.
    function stateTree(states) {
        const nodes = new Map(states.map((s) => [s.id, { ...s, kids: [] }]));
        const roots = [];
        for (const node of nodes.values()) {
            const parent = node.parent_id ? nodes.get(node.parent_id) : null;
            (parent ? parent.kids : roots).push(node);
        }
        const sort = (list) => {
            list.sort((a, b) => a.name.localeCompare(b.name));
            list.forEach((n) => sort(n.kids));
        };
        sort(roots);
        return roots;
    }

    // "About 45,000": two significant figures for the big numbers (these are
    // measured off a drawn map, so more digits would only pretend).
    function approx(n) {
        if (!(n > 0)) {
            return "0";
        }
        if (n >= 100) {
            const step = 10 ** (Math.floor(Math.log10(n)) - 1);
            return (Math.round(n / step) * step).toLocaleString();
        }
        if (n >= 10) {
            return String(Math.round(n));
        }
        return n.toLocaleString(undefined, { maximumFractionDigits: n >= 1 ? 1 : 2 });
    }

    // Capital, province, region, vassal, march, territory (the status of a state within a superstate).
    const STATUS_NAMES = {
        capital: "Capital state", province: "Province", region: "Region", vassal: "Vassal", march: "March", territory: "Territory"
    };

    // Which drawer the maps use: "canvas" (OpenLayers' own) or "webgl" (map-webgl.js).
    const RENDERER_KEY = "mapRenderer";

    function savedRenderer() {
        try {
            const saved = localStorage.getItem(RENDERER_KEY);
            if (saved === "webgl" || saved === "canvas") {
                return saved;
            }
        } catch (error) {
            // not remembered
        }
        // WebGL unless the browser can't (or the user chose otherwise).
        return window.MapGL && MapGL.supported() ? "webgl" : "canvas";
    }

    // A small "Drawing: standard / WebGL" choice for a view (shared by the viewer and the editor).
    function rendererControl(view) {
        const select = document.createElement("select");
        const options = [["canvas", "Standard"], ["webgl", window.MapGL && MapGL.supported() ? "WebGL (faster on big maps)" : "WebGL (not available here)"]];
        for (const [value, label] of options) {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = label;
            if (value === "webgl" && !(window.MapGL && MapGL.supported())) {
                option.disabled = true;
            }
            select.append(option);
        }
        select.value = view.renderer;
        select.addEventListener("change", () => {
            select.value = view.setRenderer(select.value);
            try {
                localStorage.setItem(RENDERER_KEY, select.value);
            } catch (error) {
                // not remembered
            }
        });
        const label = document.createElement("label");
        label.className = "renderer-choice";
        label.append("Drawing: ", select);
        return label;
    }

    // Fetches a map's elevation grid ({ cols, rows, cell, data }), or null if it has none.
    async function loadElevation(meta, mapId) {
        if (!meta) {
            return null;
        }
        const response = await fetch(`/api/maps/${mapId}/elevation`);
        if (!response.ok) {
            return null;
        }
        const buffer = await response.arrayBuffer();
        return { cols: meta.cols, rows: meta.rows, cell: meta.cell, updated_at: meta.updated_at, data: new Int16Array(buffer) };
    }

    // The controls for how elevation is drawn: a tint (off, grayscale or
    // colours) and relief shading, with a key. The choice is remembered.
    const ELEVATION_KEY = "aigowosyom.maps.elevation";

    function savedElevationStyle() {
        try {
            const saved = JSON.parse(localStorage.getItem(ELEVATION_KEY));
            if (saved && ["none", "gray", "colors"].includes(saved.tint)) {
                return { tint: saved.tint, relief: Boolean(saved.relief) };
            }
        } catch { /* nothing saved, or storage blocked */ }
        return { tint: "none", relief: false };
    }

    // Returns { element, get(), set(style) }; `onChange(style)` runs when the person changes it.
    function elevationControls(initial, onChange) {
        let style = { ...initial };
        const id = `relief-${Math.random().toString(36).slice(2)}`;

        const wrap = document.createElement("span");
        wrap.className = "elevation-controls";
        wrap.innerHTML = `<label>Elevation <select>
                <option value="none">off</option>
                <option value="gray">grayscale</option>
                <option value="colors">colours</option>
            </select></label>
            <span class="elevation-key" hidden>low<span class="map-elevation-key"></span>high</span>
            <input type="checkbox" id="${id}"> <label for="${id}">Relief shading</label>`;

        const select = wrap.querySelector("select");
        const relief = wrap.querySelector("input");
        const key = wrap.querySelector(".elevation-key");
        const bar = wrap.querySelector(".map-elevation-key");

        const show = () => {
            select.value = style.tint;
            relief.checked = style.relief;
            key.hidden = style.tint === "none";
            bar.style.background = style.tint === "none" ? "" : elevationKey[style.tint];
        };

        const changed = () => {
            style = { tint: select.value, relief: relief.checked };
            show();
            try {
                localStorage.setItem(ELEVATION_KEY, JSON.stringify(style));
            } catch { /* not remembered */ }
            onChange({ ...style });
        };

        select.addEventListener("change", changed);
        relief.addEventListener("change", changed);
        show();

        return {
            element: wrap,
            get: () => ({ ...style }),
            set(next) {
                style = { ...next };
                show();
            }
        };
    }

    window.MapCore = {
        elevationControls, savedElevationStyle,
        create, savedRenderer, rendererControl, colors, readColors, hexAlpha, stateCoordinates, vertexMap, stateTree, approx, STATUS_NAMES,
        loadElevation, elevationShade, elevationKey, NO_LAND, feetText
    };
})();
