// The map editor: draw land, lakes and rivers, draw states that share their
// borders, place points, trace over images, set the scale.
//
// Everything is saved as it is done (there is no Save button for the map);
// after most changes the map is fetched again so the screen is exactly what
// the server holds.
(() => {
    "use strict";

    const ol = window.ol;
    const { h, api, hiddenField } = window.UI;
    const root = document.getElementById("mapEditor");

    const SNAP_VERTEX_PX = 10;
    const SNAP_EDGE_PX = 8;

    const state = {
        maps: [],
        mapId: null,
        bundle: null,
        view: null,
        mode: "select",
        selection: null,
        draw: null, // a state being drawn: { points, target }
        followBorders: true,
        coastSnap: true,
        landJoin: true, // new or reshaped land joins the land it touches
        elevationStyle: MapCore.savedElevationStyle(), // how elevation is drawn: { tint, relief }
        undo: [], // steps that can be undone, oldest first
        redo: [],
        lastSnapshot: null, // the map's drawing after the last step
        undoMapId: null,
        restoring: false,
        elevation: null, // the grid being edited: { cols, rows, cell, updated_at, data }
        // Elevation brushes: radius in miles; sharpness 0 (soft hills) to 1 (sharp peaks);
        // how many feet a pixel of dragging is worth; how hard smoothing works.
        brush: { radius: 40, sharpness: 0.35, feetPerPixel: 12, smoothing: 0.5 },
        multi: [], // states marked together (shift-click), for combining
        collapsed: new Set(), // superstates whose clients are folded away in the list
        layers: { tracers: true, land: true, lakes: true, rivers: true, waterNames: true, states: true, labels: true, points: true },
        interactions: []
    };

    let gapRequest = 0; // for the preview of a gap under the cursor
    let gapTimer = null;

    // ------------------------------------------------------
    // Small UI helpers
    // ------------------------------------------------------

    // replaceChildren / append that skip null and false (which the DOM would print as text).
    const present = (kids) => kids.flat(Infinity).filter((kid) => kid !== null && kid !== undefined && kid !== false);
    const put = (el, ...kids) => el.replaceChildren(...present(kids));
    const add = (el, ...kids) => el.append(...present(kids));

    const statusEl = h("div", { class: "map-status", role: "status" });

    function say(message, kind = "") {
        statusEl.textContent = message;
        statusEl.className = `map-status ${kind}`.trim();
    }

    async function guarded(task) {
        try {
            return await task();
        } catch (error) {
            say(error.message, "error");
            return undefined;
        }
    }

    // A small modal form. `fields` are { key, label, type, value, options, hint }; resolves with
    // the values (or null if cancelled).
    function ask({ title, fields = [], okLabel = "OK", extra = null, danger = false }) {
        return new Promise((resolve) => {
            const inputs = {};
            const errorEl = h("div", { class: "status error" });

            const rows = fields.map((field) => {
                let input;
                if (field.type === "select") {
                    input = h("select", {}, ...field.options.map(([value, label]) =>
                        h("option", { value, selected: String(value) === String(field.value) }, label)));
                } else if (field.type === "textarea") {
                    input = h("textarea", { value: field.value || "" });
                } else if (field.type === "checkbox") {
                    input = h("input", { type: "checkbox", checked: Boolean(field.value) });
                } else {
                    input = h("input", { type: field.type || "text", value: field.value ?? "", step: field.step, min: field.min });
                }
                inputs[field.key] = input;

                return field.type === "checkbox"
                    ? h("div", { class: "field check" }, input, h("label", {}, field.label))
                    : h("div", { class: "field" }, h("label", {}, field.label, field.hint ? h("span", { class: "hint" }, ` — ${field.hint}`) : null), input);
            });

            const dialog = h("dialog", {},
                h("h2", {}, title),
                ...rows,
                extra,
                errorEl,
                h("div", { class: "form-actions" },
                    h("button", { type: "button", class: danger ? "danger" : "primary", onclick: submit }, okLabel),
                    h("button", { type: "button", onclick: () => finish(null) }, "Cancel")));

            function value(field) {
                const input = inputs[field.key];
                return field.type === "checkbox" ? input.checked : input.value;
            }

            function submit() {
                const result = {};
                for (const field of fields) {
                    result[field.key] = value(field);
                }
                if (fields.some((f) => f.required && !String(result[f.key]).trim())) {
                    errorEl.textContent = "Please fill in the required field.";
                    return;
                }
                finish(result);
            }

            function finish(result) {
                dialog.close();
                dialog.remove();
                resolve(result);
            }

            dialog.addEventListener("cancel", () => finish(null));
            dialog.addEventListener("keydown", (event) => {
                if (event.key === "Enter" && event.target.tagName !== "TEXTAREA") {
                    event.preventDefault();
                    submit();
                }
            });
            document.body.append(dialog);
            dialog.showModal();
            const first = dialog.querySelector("input, select, textarea");
            if (first) {
                first.focus();
            }
        });
    }

    function currentMap() {
        return state.bundle ? state.bundle.map : null;
    }

    // ------------------------------------------------------
    // Loading
    // ------------------------------------------------------

    async function loadMaps(selectId) {
        state.maps = await api("GET", "/api/maps");
        if (selectId !== undefined) {
            state.mapId = selectId;
        } else if (!state.maps.some((m) => m.id === state.mapId)) {
            state.mapId = state.maps.length ? state.maps[0].id : null;
        }
        renderMapSelect();
    }

    // Fetches the map and redraws it. A new view is built only when asked (a
    // different map, or its size changed).
    async function load({ remount = false } = {}) {
        if (state.mapId === null) {
            state.bundle = null;
            mountView();
            renderAll();
            return;
        }

        state.bundle = await api("GET", `/api/maps/${state.mapId}`);

        // States may have gone (a superstate left with no clients is removed).
        const known = new Set(state.bundle.states.map((x) => x.id));
        state.multi = state.multi.filter((id) => known.has(id));
        if (state.selection && state.selection.type === "state" && !known.has(state.selection.id)) {
            state.selection = null;
        }
        if (state.selection && state.selection.type === "multi" && state.multi.length < 2) {
            state.selection = state.multi.length === 1 ? { type: "state", id: state.multi[0] } : null;
            state.multi = [];
        }

        const previousGrid = state.elevation;
        await refreshElevation();
        recordChange(snapshotOf(state.bundle), previousGrid);

        if (remount || !state.view) {
            mountView();
        } else {
            state.view.rebuild(state.bundle);
            state.view.setImages(state.bundle.images);
            state.view.setElevation(state.elevation);
        }

        state.view.select(state.selection, state.multi);
        applyLayerVisibility();
        refreshHandles();
        refreshModify();
        renderAll();
    }

    // ------------------------------------------------------
    // The map view and its permanent event handlers
    // ------------------------------------------------------

    const viewEl = h("div", { class: "map-view" });
    const sketchSource = new ol.source.Vector();
    const handleSource = new ol.source.Vector();

    function mountView() {
        stopInteractions();
        viewEl.replaceChildren();
        state.view = null;

        if (!state.bundle) {
            viewEl.append(h("p", { class: "muted", style: "padding:20px" }, "Create a map to begin."));
            return;
        }

        const view = MapCore.create({ target: viewEl, bundle: state.bundle, editable: true, fullscreen: root });
        state.view = view;
        view.setImages(state.bundle.images);
        view.setElevation(state.elevation);

        view.ol.addLayer(new ol.layer.Vector({
            source: handleSource,
            zIndex: 90,
            style: (feature) => {
                const hot = feature.get("hot");
                return new ol.style.Style({
                    image: new ol.style.RegularShape({
                        points: 4,
                        angle: Math.PI / 4,
                        radius: hot ? 7 : 5,
                        fill: new ol.style.Fill({ color: hot ? MapCore.colors.accent : "#ffffff" }),
                        stroke: new ol.style.Stroke({ color: "#222222", width: 1.5 })
                    })
                });
            }
        }));
        view.ol.addLayer(new ol.layer.Vector({ source: sketchSource, zIndex: 100, style: sketchStyle }));

        view.ol.on("click", onClick);
        view.ol.on("dblclick", onDoubleClick);
        view.ol.on("pointermove", onPointerMove);

        setMode(state.mode);
    }

    function sketchStyle(feature) {
        const accent = MapCore.colors.accent;
        const kind = feature.get("kind");

        if (kind === "brush") {
            return new ol.style.Style({
                stroke: new ol.style.Stroke({ color: accent, width: 2, lineDash: [5, 5] }),
                fill: new ol.style.Fill({ color: "rgba(212,169,0,0.10)" })
            });
        }
        if (kind === "snap") {
            return new ol.style.Style({
                image: new ol.style.Circle({
                    radius: 8,
                    stroke: new ol.style.Stroke({ color: accent, width: 3 }),
                    fill: new ol.style.Fill({ color: "rgba(255,255,255,0.5)" })
                })
            });
        }
        if (kind === "candidate") {
            const hot = feature.get("hot");
            return new ol.style.Style({
                stroke: new ol.style.Stroke({ color: accent, width: hot ? 4 : 2.5, lineDash: hot ? undefined : [8, 6] }),
                fill: new ol.style.Fill({ color: hot ? "rgba(212,169,0,0.45)" : "rgba(212,169,0,0.22)" })
            });
        }
        if (kind === "corner") {
            return new ol.style.Style({
                image: new ol.style.Circle({
                    radius: 4,
                    fill: new ol.style.Fill({ color: "#ffffff" }),
                    stroke: new ol.style.Stroke({ color: "#222222", width: 1.5 })
                })
            });
        }
        return new ol.style.Style({
            stroke: new ol.style.Stroke({ color: accent, width: 2.5, lineDash: kind === "rubber" ? [6, 6] : undefined }),
            fill: kind === "area" ? new ol.style.Fill({ color: "rgba(212,169,0,0.18)" }) : undefined
        });
    }

    function pixelsToUnits(px) {
        return px * state.view.olView.getResolution();
    }

    // ---- spatial helpers over the states' corners and edges ----

    function nearestVertex(coordinate, withinPx, skipId = null) {
        const limit = pixelsToUnits(withinPx);
        let best = null;
        for (const [id, [x, y]] of state.view.vmap) {
            if (id === skipId) {
                continue;
            }
            const d = Math.hypot(coordinate[0] - x, coordinate[1] - y);
            if (d <= limit && (!best || d < best.distance)) {
                best = { id, x, y, distance: d };
            }
        }
        return best;
    }

    function nearestEdge(coordinate, withinPx) {
        const limit = pixelsToUnits(withinPx);
        const vmap = state.view.vmap;
        let best = null;

        for (const s of state.bundle.states) {
            for (const polygon of s.polygons) {
                for (const ring of polygon) {
                    for (let i = 0; i < ring.length; i++) {
                        const a = vmap.get(ring[i]);
                        const b = vmap.get(ring[(i + 1) % ring.length]);
                        if (!a || !b) {
                            continue;
                        }
                        const dx = b[0] - a[0];
                        const dy = b[1] - a[1];
                        const lengthSquared = dx * dx + dy * dy;
                        const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((coordinate[0] - a[0]) * dx + (coordinate[1] - a[1]) * dy) / lengthSquared));
                        const x = a[0] + t * dx;
                        const y = a[1] + t * dy;
                        const d = Math.hypot(coordinate[0] - x, coordinate[1] - y);
                        if (d <= limit && (!best || d < best.distance)) {
                            best = { x, y, distance: d };
                        }
                    }
                }
            }
        }
        return best;
    }

    // ---- the coastline: the outlines of the land shapes (lakes are ignored) ----

    function coastRings() {
        return state.bundle.features
            .filter((f) => f.kind === "land")
            .flatMap((f) => f.geometry.coordinates)
            .map((ring) => {
                const points = ring.map((c) => [c[0], c[1]]);
                const last = points[points.length - 1];
                if (points.length > 1 && last[0] === points[0][0] && last[1] === points[0][1]) {
                    points.pop();
                }
                return points;
            })
            .filter((ring) => ring.length >= 3);
    }

    // The nearest point on any coastline within `withinPx`: its position and
    // where it is on the ring ({ ring, seg, t }: between corner `seg` and the
    // next one). Close to a corner of the coast it snaps to the corner.
    function nearestCoast(coordinate, withinPx) {
        const limit = pixelsToUnits(withinPx);
        const rings = coastRings();
        let best = null;

        rings.forEach((points, ring) => {
            points.forEach((a, seg) => {
                const b = points[(seg + 1) % points.length];
                const dx = b[0] - a[0];
                const dy = b[1] - a[1];
                const lengthSquared = dx * dx + dy * dy;
                const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((coordinate[0] - a[0]) * dx + (coordinate[1] - a[1]) * dy) / lengthSquared));
                const x = a[0] + t * dx;
                const y = a[1] + t * dy;
                const distance = Math.hypot(coordinate[0] - x, coordinate[1] - y);
                if (distance <= limit && (!best || distance < best.distance)) {
                    best = { x, y, distance, ring, seg, t };
                }
            });
        });

        if (best) {
            const points = rings[best.ring];
            const corner = pixelsToUnits(SNAP_VERTEX_PX * 0.7);
            const a = points[best.seg];
            const b = points[(best.seg + 1) % points.length];
            if (Math.hypot(best.x - a[0], best.y - a[1]) <= corner) {
                Object.assign(best, { x: a[0], y: a[1], t: 0 });
            } else if (Math.hypot(best.x - b[0], best.y - b[1]) <= corner) {
                Object.assign(best, { x: b[0], y: b[1], seg: (best.seg + 1) % points.length, t: 0 });
            }
        }
        return best;
    }

    // Where a position sits on the coast, if it is on it (to the last decimal).
    function coastLocation(x, y) {
        const rings = coastRings();
        for (let ring = 0; ring < rings.length; ring++) {
            const points = rings[ring];
            for (let seg = 0; seg < points.length; seg++) {
                const a = points[seg];
                const b = points[(seg + 1) % points.length];
                const dx = b[0] - a[0];
                const dy = b[1] - a[1];
                const lengthSquared = dx * dx + dy * dy;
                const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / lengthSquared));
                if (Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy)) < 1e-4) {
                    return { ring, seg, t };
                }
            }
        }
        return null;
    }

    // The corners of the coast between two places on it, the shorter way round.
    function pathAlongCoast(from, to) {
        const points = coastRings()[from.ring];
        const n = points.length;
        const at = (loc) => {
            const a = points[loc.seg];
            const b = points[(loc.seg + 1) % n];
            return [a[0] + loc.t * (b[0] - a[0]), a[1] + loc.t * (b[1] - a[1])];
        };
        const start = at(from);
        const end = at(to);

        const forward = [];
        const backward = [];
        if (to.seg !== from.seg || to.t < from.t) {
            for (let i = (from.seg + 1) % n; ; i = (i + 1) % n) {
                forward.push(points[i]);
                if (i === to.seg) {
                    break;
                }
            }
        }
        if (to.seg !== from.seg || to.t > from.t) {
            for (let i = from.seg; ; i = (i - 1 + n) % n) {
                backward.push(points[i]);
                if (i === (to.seg + 1) % n) {
                    break;
                }
            }
        }

        const length = (path) => {
            const all = [start, ...path, end];
            let total = 0;
            for (let i = 1; i < all.length; i++) {
                total += Math.hypot(all[i][0] - all[i - 1][0], all[i][1] - all[i - 1][1]);
            }
            return total;
        };

        // An empty list is the direct way (both ends on the same stretch).
        const way = length(forward) <= length(backward) ? forward : backward;
        const apart = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6;
        return way.filter((p, i) => apart(p, start) && apart(p, end) && (i === 0 || apart(p, way[i - 1])));
    }

    // What a click at this coordinate should attach to: an existing corner, a
    // point on an existing border, the coast, or open ground.
    function snapAt(coordinate) {
        const vertex = nearestVertex(coordinate, SNAP_VERTEX_PX);
        if (vertex) {
            return { kind: "vertex", id: vertex.id, x: vertex.x, y: vertex.y };
        }
        const edge = nearestEdge(coordinate, SNAP_EDGE_PX);
        if (edge) {
            return { kind: "edge", x: edge.x, y: edge.y };
        }
        if (state.coastSnap) {
            const coast = nearestCoast(coordinate, SNAP_VERTEX_PX);
            if (coast) {
                return { kind: "coast", x: coast.x, y: coast.y, coast: { ring: coast.ring, seg: coast.seg, t: coast.t } };
            }
        }
        return { kind: "free", x: coordinate[0], y: coordinate[1] };
    }

    // ------------------------------------------------------
    // Modes
    // ------------------------------------------------------

    function stopInteractions() {
        if (state.view) {
            for (const interaction of state.interactions) {
                state.view.ol.removeInteraction(interaction);
            }
        }
        state.interactions = [];
    }

    function addInteraction(interaction) {
        state.view.ol.addInteraction(interaction);
        state.interactions.push(interaction);
    }

    const HINTS = {
        select: "Click a state, shape or place to select it. Shift-click several states to combine them into a superstate. Drag to pan; scroll to zoom.",
        land: "Click to add corners; double-click to finish. Hold Shift and drag to draw freehand. Corners snap to existing land; land you draw over or against existing land joins it into one piece, and clicking two points on that land's coast follows the coast between them.",
        lake: "Click to add corners; double-click to finish. Hold Shift and drag to draw freehand.",
        river: "Click to add points along the river; double-click to finish. Hold Shift and drag for freehand.",
        ocean: "Draw a loose outline around the sea or ocean, then give it a name: the name is placed in the middle of the outline and sized to it. The outline is only shown here in the editor.",
        elevate: "Press on the land and drag UP to raise it, DOWN to lower it: the land around is pulled along. A wide, soft brush makes hills and gradual slopes; a sharp one makes mountains.",
        smooth: "Paint over the land to even out its elevation (softening ridges and valleys).",
        reshape: "Drag a corner to move it, drag an edge to add a corner, Alt-click a corner to remove it. Land, lakes and rivers snap to each other.",
        state: "Click corners. Clicking on a neighbour's border or corner shares it, and clicking on the coast snaps to it (clicking two points on the coast follows it). Enter completes the state along existing borders and the coast (if two states would fit, click the one you want); double-click or Shift+Enter closes it with a straight line. Backspace undoes a corner, Esc cancels. To fill a gap that borders and the coast already close off (between states, or a hole inside one), hold Alt over it and click.",
        borders: "Drag a corner (shared corners move for every state; it snaps to the coast). Drop a corner on another to weld them. Double-click a border to add a corner; Alt-click a corner to remove it.",
        place: "Click the map to put a place there.",
        movePlace: "Click the map to move the place to that spot.",
        scale: "Click two points whose real distance you know, then enter it in miles."
    };

    const DRAWING_MODES = ["land", "lake", "river", "ocean", "state", "place", "movePlace", "scale", "elevate", "smooth"];

    // The shape being drawn with the land, lake, river or sea tool (Esc abandons it).
    let activeDraw = null;

    function setMode(mode) {
        cancelDrawing();
        stopInteractions();
        activeDraw = null;
        state.mode = mode;
        state.scalePoints = [];
        sketchSource.clear();
        root.classList.toggle("drawing", DRAWING_MODES.includes(mode));

        const view = state.view;
        if (view) {
            handleSource.clear();
            if (mode === "borders") {
                refreshHandles();
                installVertexDrag();
            } else if (mode === "land" || mode === "lake" || mode === "river" || mode === "ocean") {
                const draw = new ol.interaction.Draw({
                    source: new ol.source.Vector(), // the shape is saved and the map redrawn, so nothing is kept here
                    type: mode === "river" ? "LineString" : "Polygon",
                    freehandCondition: ol.events.condition.shiftKeyOnly,
                    style: (feature) => sketchStyle(new ol.Feature({ kind: "line" }))
                });
                draw.on("drawend", (event) => finishShape(mode, event.feature));
                activeDraw = draw;
                addInteraction(draw);
                addInteraction(new ol.interaction.Snap({ source: view.sources.land }));
            } else if (mode === "reshape") {
                refreshModify();
            } else if (mode === "elevate" || mode === "smooth") {
                // The shading is how you see what you are doing.
                if (state.elevationStyle.tint === "none" && !state.elevationStyle.relief) {
                    state.elevationStyle = { tint: "gray", relief: false };
                    elevationControls.set(state.elevationStyle);
                    applyLayerVisibility();
                }
                installBrush(mode);
            }
        }

        renderTools();
        say(HINTS[mode] || "");
    }

    // ---- reshaping land, lakes and rivers ----

    let modify = null;

    function refreshModify() {
        if (!state.view || state.mode !== "reshape") {
            return;
        }
        if (modify) {
            state.view.ol.removeInteraction(modify);
            state.interactions = state.interactions.filter((i) => i !== modify);
        }

        const sources = state.view.sources;
        const features = new ol.Collection([
            ...sources.land.getFeatures(), ...sources.lakes.getFeatures(), ...sources.rivers.getFeatures(), ...sources.oceans.getFeatures()
        ]);

        modify = new ol.interaction.Modify({ features, pixelTolerance: 8 });
        modify.on("modifyend", (event) => {
            for (const feature of event.features.getArray()) {
                saveShapeGeometry(feature);
            }
        });
        addInteraction(modify);
        addInteraction(new ol.interaction.Snap({ features, pixelTolerance: 8 }));
    }

    async function saveShapeGeometry(feature) {
        const geometry = feature.getGeometry();
        const json = geometry.getType() === "LineString"
            ? { type: "LineString", coordinates: geometry.getCoordinates() }
            : { type: "Polygon", coordinates: geometry.getCoordinates() };

        await guarded(async () => {
            await api("PUT", `/api/map-features/${feature.get("id")}`, { geometry: json, merge: state.landJoin });
            await load(); // so that it is a step that can be undone
        });
    }

    // Land drawn against land: where two neighbouring corners both lie on the coast of the same
    // piece of land, the new shape follows that coast between them (the shorter way round), so
    // that it fits against it instead of cutting across.
    function followLandCoasts(ring) {
        const corners = ring.slice(0, -1);
        const placed = corners.map((p) => coastLocation(p[0], p[1]));
        const out = [];
        corners.forEach((corner, i) => {
            out.push(corner);
            const from = placed[i];
            const to = placed[(i + 1) % corners.length];
            if (from && to && from.ring === to.ring) {
                for (const [x, y] of pathAlongCoast(from, to)) {
                    out.push([x, y]);
                }
            }
        });
        out.push([out[0][0], out[0][1]]);
        return out;
    }

    async function finishShape(kind, feature) {
        const geometry = feature.getGeometry();
        let coordinates = geometry.getCoordinates();
        if (kind === "land" && state.landJoin) {
            coordinates = coordinates.map((ring, index) => (index === 0 ? followLandCoasts(ring) : ring));
        }
        const json = kind === "river"
            ? { type: "LineString", coordinates }
            : { type: "Polygon", coordinates };

        let name;
        if (kind === "ocean") {
            const answer = await ask({ title: "Name this sea or ocean", okLabel: "Add name", fields: [{ key: "name", label: "Name", required: true }] });
            if (!answer) {
                return; // cancelled: nothing is saved
            }
            name = answer.name;
        }

        await guarded(async () => {
            const created = await api("POST", `/api/maps/${state.mapId}/features`, { kind, geometry: json, name, merge: kind === "land" ? state.landJoin : undefined });
            state.nextLabel = created.joined ? "Add land onto land" : null; // a step that changes an existing shape
            await load();
            selectObject({ type: "feature", id: created.id });
            say(kind === "ocean" ? "Named." : created.joined ? `Joined the land it touches (${created.joined} piece${created.joined === 1 ? "" : "s"}) into one.` : "Saved. Name it in the panel (optional), or keep drawing.");
        });
    }

    // ---- dragging corners of states ----

    let dragging = null;
    let redrawQueued = false;

    function queueStateRedraw() {
        if (!redrawQueued) {
            redrawQueued = true;
            requestAnimationFrame(() => {
                redrawQueued = false;
                state.view.rebuildStates();
            });
        }
    }

    function refreshHandles() {
        handleSource.clear();
        if (!state.view || state.mode !== "borders") {
            return;
        }
        for (const [id, [x, y]] of state.view.vmap) {
            const feature = new ol.Feature({ geometry: new ol.geom.Point([x, y]), vertexId: id });
            feature.setId(`v${id}`);
            handleSource.addFeature(feature);
        }
    }

    function installVertexDrag() {
        const pointer = new ol.interaction.Pointer({
            handleDownEvent(event) {
                if (event.originalEvent.altKey) {
                    return false;
                }
                const vertex = nearestVertex(event.coordinate, SNAP_VERTEX_PX);
                if (!vertex) {
                    return false;
                }
                dragging = { id: vertex.id, from: [vertex.x, vertex.y], moved: false };
                return true;
            },
            handleDragEvent(event) {
                if (!dragging) {
                    return;
                }
                dragging.moved = true;

                // It snaps onto another corner (to be welded) or onto the coast.
                let at = [event.coordinate[0], event.coordinate[1]];
                const other = nearestVertex(event.coordinate, SNAP_VERTEX_PX, dragging.id);
                if (other) {
                    at = [other.x, other.y];
                } else if (state.coastSnap) {
                    const coast = nearestCoast(event.coordinate, SNAP_VERTEX_PX);
                    if (coast) {
                        at = [coast.x, coast.y];
                    }
                }

                state.view.vmap.set(dragging.id, at);
                const feature = handleSource.getFeatureById(`v${dragging.id}`);
                if (feature) {
                    feature.getGeometry().setCoordinates(at);
                }
                queueStateRedraw();
            },
            handleUpEvent(event) {
                const drag = dragging;
                dragging = null;
                if (!drag || !drag.moved) {
                    return false;
                }

                const onto = nearestVertex(event.coordinate, SNAP_VERTEX_PX, drag.id);
                (async () => {
                    try {
                        if (onto) {
                            await api("POST", `/api/map-vertices/${drag.id}/merge`, { into: onto.id });
                            say("Corners welded together.");
                        } else {
                            const [x, y] = state.view.vmap.get(drag.id);
                            await api("POST", `/api/maps/${state.mapId}/vertices/move`, [{ id: drag.id, x, y }]);
                            say("Moved.");
                        }
                    } catch (error) {
                        say(error.message, "error");
                    }
                    await load(); // either way, show exactly what the server holds
                })();
                return false;
            },
            handleMoveEvent(event) {
                if (dragging) {
                    return;
                }
                const near = nearestVertex(event.coordinate, SNAP_VERTEX_PX);
                for (const feature of handleSource.getFeatures()) {
                    const hot = Boolean(near && feature.get("vertexId") === near.id);
                    if (feature.get("hot") !== hot) {
                        feature.set("hot", hot);
                    }
                }
            }
        });
        addInteraction(pointer);
    }

    // ---- clicks ----

    function onClick(event) {
        if (!state.view) {
            return;
        }
        const alt = event.originalEvent.altKey;

        switch (state.mode) {
            case "select": {
                const picked = state.view.pick(event.pixel);
                if (event.originalEvent.shiftKey && picked && picked.type === "state") {
                    toggleMarked(picked.id);
                } else {
                    selectObject(picked);
                }
                break;
            }
            case "reshape":
                break;
            case "state":
                if (state.choosing) {
                    chooseCandidate(event.coordinate);
                    break;
                }
                if (event.originalEvent.altKey && !(state.draw && state.draw.points.length)) {
                    queueDraw(() => fillGap(event.coordinate));
                    break;
                }
                queueDraw(() => addDrawPoint(event.coordinate));
                break;
            case "borders":
                if (alt) {
                    removeCorner(event.coordinate);
                }
                break;
            case "place":
                createPlace(event.coordinate);
                break;
            case "movePlace":
                movePlace(event.coordinate);
                break;
            case "scale":
                measure(event.coordinate);
                break;
            default:
                break;
        }
    }

    function onDoubleClick(event) {
        if (state.mode === "state") {
            event.preventDefault();
            if (!state.choosing) {
                finishState();
            }
        } else if (state.mode === "borders") {
            event.preventDefault();
            addCorner(event.coordinate);
        }
    }

    function onPointerMove(event) {
        if (!state.view || event.dragging) {
            return;
        }
        if (state.mode === "state" && state.choosing) {
            hoverCandidate(event.coordinate);
        } else if (state.mode === "state" && event.originalEvent.altKey && !(state.draw && state.draw.points.length)) {
            previewGap(event.coordinate);
        } else if (state.mode === "state" || state.mode === "scale") {
            updateRubber(event.coordinate);
        } else if (state.mode === "elevate" || state.mode === "smooth") {
            showBrush(event.coordinate);
        } else if (state.mode === "select") {
            viewEl.querySelector(".ol-viewport").style.cursor = state.view.pick(event.pixel) ? "pointer" : "";
        }
    }

    // ------------------------------------------------------
    // Drawing a state
    // ------------------------------------------------------

    // Between two corners that sit on the same state's border, the way along
    // that border (the shorter way round), so a shared border is followed
    // without clicking every corner on it.
    function pathAlongBorder(fromId, toId) {
        const vmap = state.view.vmap;
        let best = null;

        const length = (ids) => {
            let total = 0;
            for (let i = 1; i < ids.length; i++) {
                const a = vmap.get(ids[i - 1]);
                const b = vmap.get(ids[i]);
                total += Math.hypot(a[0] - b[0], a[1] - b[1]);
            }
            return total;
        };

        for (const s of state.bundle.states) {
            for (const polygon of s.polygons) {
                for (const ring of polygon) {
                    const i = ring.indexOf(fromId);
                    const j = ring.indexOf(toId);
                    if (i < 0 || j < 0) {
                        continue;
                    }
                    const walk = (step) => {
                        const ids = [fromId];
                        for (let k = i; k !== j;) {
                            k = (k + step + ring.length) % ring.length;
                            ids.push(ring[k]);
                        }
                        return ids;
                    };
                    for (const ids of [walk(1), walk(-1)]) {
                        const l = length(ids);
                        if (!best || l < best.length) {
                            best = { length: l, ids };
                        }
                    }
                }
            }
        }
        return best ? best.ids.slice(1, -1) : [];
    }

    function cancelDrawing() {
        closeChoosing();
        const touched = state.draw && state.draw.touched;
        state.draw = null;
        sketchSource.clear();
        if (touched) {
            load(); // corners added on a neighbour's border while drawing are a step of their own
        }
    }

    async function addDrawPoint(coordinate) {
        if (!state.draw) {
            state.draw = { points: [], target: state.drawTarget || null };
        }
        const draw = state.draw;
        const snap = snapAt(coordinate);

        // Closing: clicking the first corner again finishes the shape.
        if (draw.points.length >= 3 && snap.kind === "vertex" && draw.points[0].id === snap.id) {
            finishState();
            return;
        }

        let point = { x: snap.x, y: snap.y };

        if (snap.kind === "coast") {
            point.coast = snap.coast;
        } else if (snap.kind === "vertex") {
            point.id = snap.id;
        } else if (snap.kind === "edge") {
            // A corner on a neighbour's border has to exist on both sides, so make it now.
            const made = await guarded(() => api("POST", `/api/maps/${state.mapId}/vertices`, { x: snap.x, y: snap.y, snapEdge: true }));
            if (!made) {
                return;
            }
            point = { id: made.id, x: made.x, y: made.y };
            draw.touched = true;
            await load();
        }

        const previous = draw.points[draw.points.length - 1];
        if (previous && previous.x === point.x && previous.y === point.y) {
            return; // the second click of a double-click
        }

        if (state.followBorders && previous && previous.id && point.id && previous.id !== point.id) {
            for (const id of pathAlongBorder(previous.id, point.id)) {
                const [x, y] = state.view.vmap.get(id);
                draw.points.push({ id, x, y });
            }
        }

        // Between two places on the coast (and not along a shared border), follow the coast.
        if (state.coastSnap && previous && !(previous.id && point.id)) {
            const from = previous.coast || coastLocation(previous.x, previous.y);
            const to = point.coast || coastLocation(point.x, point.y);
            if ((previous.coast || point.coast) && from && to && from.ring === to.ring) {
                for (const [x, y] of pathAlongCoast(from, to)) {
                    draw.points.push({ x, y });
                }
            }
        }

        draw.points.push(point);
        renderSketch(null);
    }

    function updateRubber(coordinate) {
        if (state.mode === "scale") {
            renderScaleSketch(coordinate);
            return;
        }
        renderSketch(coordinate);
    }

    function renderSketch(cursor) {
        gapRequest++; // a pending gap preview is out of date
        clearTimeout(gapTimer);
        sketchSource.clear();
        const points = state.draw ? state.draw.points : [];
        const snap = cursor ? snapAt(cursor) : null;

        if (points.length >= 1) {
            const path = points.map((p) => [p.x, p.y]);
            if (points.length >= 3) {
                sketchSource.addFeature(new ol.Feature({ geometry: new ol.geom.Polygon([[...path, path[0]]]), kind: "area" }));
            }
            sketchSource.addFeature(new ol.Feature({ geometry: new ol.geom.LineString(path), kind: "line" }));
            if (snap) {
                sketchSource.addFeature(new ol.Feature({
                    geometry: new ol.geom.LineString([path[path.length - 1], [snap.x, snap.y]]), kind: "rubber"
                }));
            }
            for (const p of points) {
                sketchSource.addFeature(new ol.Feature({ geometry: new ol.geom.Point([p.x, p.y]), kind: "corner" }));
            }
        }

        if (snap && snap.kind !== "free") {
            sketchSource.addFeature(new ol.Feature({ geometry: new ol.geom.Point([snap.x, snap.y]), kind: "snap" }));
        }
    }

    // A point is inside a ring (used to find which piece a new hole belongs to).
    function insideRing(point, ring) {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [xi, yi] = ring[i];
            const [xj, yj] = ring[j];
            if (yi > point[1] !== yj > point[1] && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) {
                inside = !inside;
            }
        }
        return inside;
    }

    // Clicks are handled one after another: a click on a border has to be saved
    // before the next click (or the double-click that finishes) is looked at.
    let drawQueue = Promise.resolve();

    function queueDraw(task) {
        drawQueue = drawQueue.then(task).catch((error) => say(error.message, "error"));
        return drawQueue;
    }

    function finishState() {
        return queueDraw(() => finishStateNow());
    }

    // ---- autocomplete ----
    // Enter closes the line the user drew by following existing borders and the coast. When the
    // line splits the open ground into two possible states, both are outlined and the user
    // clicks the one they mean.

    function autocompleteState() {
        return queueDraw(async () => {
            const draw = state.draw;
            if (!draw || draw.points.length < 2) {
                await finishStateNow();
                return;
            }
            const points = draw.points.map((p) => ({ x: p.x, y: p.y, id: p.id }));
            const result = await api("POST", `/api/maps/${state.mapId}/complete`, { points });
            const found = result.candidates || [];

            if (!found.length) {
                if (draw.points.length >= 3) {
                    await finishStateNow(); // nothing to complete: close it with a straight line
                } else {
                    say(result.message || "Nothing to complete from that line.", "error");
                }
                return;
            }
            if (found.length === 1) {
                await finishStateNow(found[0]);
                return;
            }
            openChoosing(found);
        });
    }

    // A gap is free land that existing borders and the coast already close off (between states,
    // or a hole inside one): Alt-click it to make it a state, with no line to draw.
    async function fillGap(coordinate) {
        const result = await api("POST", `/api/maps/${state.mapId}/complete`, { at: [coordinate[0], coordinate[1]] });
        if (!result.candidates || !result.candidates.length) {
            say(result.message || "That isn't a gap.", "error");
            return;
        }
        if (!state.draw) {
            state.draw = { points: [], target: state.drawTarget || null };
        }
        await finishStateNow(result.candidates[0]);
    }

    // Holding Alt over a gap outlines it.
    function previewGap(coordinate) {
        const ticket = ++gapRequest;
        clearTimeout(gapTimer);
        gapTimer = setTimeout(async () => {
            try {
                const result = await api("POST", `/api/maps/${state.mapId}/complete`, { at: [coordinate[0], coordinate[1]] });
                if (ticket !== gapRequest || state.mode !== "state" || (state.draw && state.draw.points.length) || state.choosing) {
                    return;
                }
                sketchSource.clear();
                for (const c of result.candidates || []) {
                    sketchSource.addFeature(new ol.Feature({ geometry: new ol.geom.Polygon([c.outline]), kind: "candidate", hot: true }));
                }
            } catch (error) {
                // a preview only
            }
        }, 80);
    }

    function openChoosing(candidates) {
        closeChoosing();
        const dialog = h("dialog", { class: "choosing" },
            h("h3", {}, "Two states fit"),
            h("p", {}, "That line could close either of the outlined areas. Click the one you want."),
            h("div", { class: "actions" },
                h("button", { type: "button", onclick: () => { closeChoosing(); renderSketch(null); } }, "Keep drawing")));
        root.append(dialog); // inside the editor, so it also shows in full screen
        dialog.show();
        state.choosing = { candidates, dialog, hot: null };
        renderChoosing(null);
        say("Click the area you want the state to cover.");
    }

    function closeChoosing() {
        if (state.choosing) {
            state.choosing.dialog.remove();
            state.choosing = null;
        }
    }

    function candidateAt(coordinate) {
        return state.choosing.candidates.find((c) => insideRing(coordinate, c.outline)) || null;
    }

    function renderChoosing(hot) {
        sketchSource.clear();
        const path = state.draw.points.map((p) => [p.x, p.y]);
        for (const c of state.choosing.candidates) {
            sketchSource.addFeature(new ol.Feature({ geometry: new ol.geom.Polygon([c.outline]), kind: "candidate", hot: c === hot }));
        }
        sketchSource.addFeature(new ol.Feature({ geometry: new ol.geom.LineString(path), kind: "line" }));
    }

    function hoverCandidate(coordinate) {
        const hot = candidateAt(coordinate);
        if (hot !== state.choosing.hot) {
            state.choosing.hot = hot;
            renderChoosing(hot);
        }
        viewEl.querySelector(".ol-viewport").style.cursor = hot ? "pointer" : "";
    }

    function chooseCandidate(coordinate) {
        const picked = candidateAt(coordinate);
        if (!picked) {
            say("Click inside one of the outlined areas.", "error");
            return;
        }
        viewEl.querySelector(".ol-viewport").style.cursor = "";
        closeChoosing();
        queueDraw(() => finishStateNow(picked));
    }

    async function finishStateNow(completed = null) {
        const draw = state.draw;
        if (!draw) {
            return;
        }

        // Drop a repeated last corner (a double-click).
        let points = draw.points.filter((p, i) => i === 0 || !(p.x === draw.points[i - 1].x && p.y === draw.points[i - 1].y));
        if (!completed && points.length < 3) {
            say("A state needs at least three corners.", "error");
            return;
        }

        let ring = points.map((p) => (p.id ? { id: p.id } : { x: p.x, y: p.y }));
        if (completed) {
            // Autocompleted: the server worked out every corner, along existing borders and the coast.
            ring = completed.ring;
            points = completed.outline.slice(0, -1).map(([x, y]) => ({ x, y }));
        }
        const target = draw.target;
        // Corners added on a neighbour's border while drawing become part of this one step
        // (unless the state ends up not being made).
        const touched = draw.touched;
        draw.touched = false;
        cancelDrawing();
        state.drawTarget = null;

        if (target) {
            await guarded(async () => {
                const existing = state.bundle.states.find((s) => s.id === target.stateId);
                const polygons = existing.polygons.map((polygon) => polygon.map((r) => r.map((id) => ({ id }))));

                if (target.role === "piece") {
                    polygons.push([ring]);
                } else {
                    const first = [points[0].x, points[0].y];
                    const vmap = state.view.vmap;
                    const home = existing.polygons.findIndex((polygon) => insideRing(first, polygon[0].map((id) => vmap.get(id))));
                    if (home < 0) {
                        throw new Error("A hole has to start inside one of the state's pieces.");
                    }
                    polygons[home].push(ring);
                }

                await api("PUT", `/api/map-states/${target.stateId}`, { polygons });
                await load();
                selectObject({ type: "state", id: target.stateId });
                setMode("select");
                say(target.role === "piece" ? "Piece added." : "Hole added.");
            });
            return;
        }

        const answer = await ask({
            title: "New state",
            okLabel: "Create state",
            fields: [{ key: "name", label: "Name", required: true }]
        });

        if (!answer) {
            if (touched) {
                await load(); // nothing is made, but the corners it added are there
            }
            return;
        }

        await guarded(async () => {
            const created = await api("POST", `/api/maps/${state.mapId}/states`, { name: answer.name, polygons: [[ring]] });
            await load();
            selectObject({ type: "state", id: created.id });
            say(`“${created.name}” created, with its page in the States lore category.`);
        });
    }

    // ---- editing corners ----

    async function addCorner(coordinate) {
        if (nearestVertex(coordinate, SNAP_VERTEX_PX)) {
            return;
        }
        const edge = nearestEdge(coordinate, SNAP_EDGE_PX);
        if (!edge) {
            return;
        }
        await guarded(async () => {
            await api("POST", `/api/maps/${state.mapId}/vertices`, { x: edge.x, y: edge.y, snapEdge: true });
            await load();
            say("Corner added.");
        });
    }

    async function removeCorner(coordinate) {
        const vertex = nearestVertex(coordinate, SNAP_VERTEX_PX);
        if (!vertex) {
            return;
        }
        await guarded(async () => {
            await api("DELETE", `/api/map-vertices/${vertex.id}`);
            await load();
            say("Corner removed.");
        });
    }

    // ------------------------------------------------------
    // Places
    // ------------------------------------------------------

    async function createPlace(coordinate) {
        const answer = await ask({
            title: "New place",
            okLabel: "Add place",
            fields: [
                { key: "name", label: "Name", required: true },
                { key: "kind", label: "Kind", type: "select", value: "city", options: PLACE_KINDS.map((k) => [k, k]) }
            ]
        });
        if (!answer) {
            return;
        }
        await guarded(async () => {
            const created = await api("POST", `/api/maps/${state.mapId}/points`, { ...answer, x: coordinate[0], y: coordinate[1] });
            await load();
            selectObject({ type: "point", id: created.id });
            setMode("select");
        });
    }

    const PLACE_KINDS = ["capital", "city", "town", "village", "fortress", "port", "ruin", "landmark", "other"];

    async function movePlace(coordinate) {
        const selection = state.selection;
        if (!selection || selection.type !== "point") {
            setMode("select");
            return;
        }
        await guarded(async () => {
            await api("PUT", `/api/map-points/${selection.id}`, { x: coordinate[0], y: coordinate[1] });
            await load();
            setMode("select");
            say("Moved.");
        });
    }

    // ------------------------------------------------------
    // Scale
    // ------------------------------------------------------

    function renderScaleSketch(cursor) {
        sketchSource.clear();
        const points = state.scalePoints || [];
        const all = cursor && points.length === 1 ? [...points, cursor] : points;
        if (all.length === 2) {
            sketchSource.addFeature(new ol.Feature({ geometry: new ol.geom.LineString(all), kind: "line" }));
        }
        for (const p of points) {
            sketchSource.addFeature(new ol.Feature({ geometry: new ol.geom.Point(p), kind: "corner" }));
        }
    }

    async function measure(coordinate) {
        state.scalePoints = [...(state.scalePoints || []), coordinate];
        renderScaleSketch(null);

        if (state.scalePoints.length < 2) {
            return;
        }

        const [a, b] = state.scalePoints;
        const units = Math.hypot(a[0] - b[0], a[1] - b[1]);
        const map = currentMap();

        const answer = await ask({
            title: "Set the scale",
            okLabel: "Set scale",
            fields: [{
                key: "miles",
                label: "Real distance between the two points, in miles",
                type: "number", step: "any", min: "0", required: true,
                hint: `currently ${(units * map.miles_per_unit).toLocaleString(undefined, { maximumFractionDigits: 2 })} mi`
            }]
        });

        state.scalePoints = [];
        sketchSource.clear();

        const miles = answer ? Number(answer.miles) : 0;
        if (!(miles > 0)) {
            return;
        }

        await guarded(async () => {
            await api("PUT", `/api/maps/${map.id}`, { ...map, miles_per_unit: miles / units });
            await load();
            setMode("select");
            say(`Scale set: one map unit is ${(miles / units).toPrecision(4)} miles.`);
        });
    }

    // ------------------------------------------------------
    // Selection and the inspector
    // ------------------------------------------------------

    function selectObject(selection, multi = []) {
        state.selection = selection;
        state.multi = multi;
        if (state.view) {
            state.view.select(selection, multi);
        }
        renderInspector();
        renderStatesTree();
    }

    // Shift-click: add a state to (or take it from) the states marked together.
    function toggleMarked(id) {
        const marked = state.multi.length
            ? [...state.multi]
            : state.selection && state.selection.type === "state" ? [state.selection.id] : [];
        const at = marked.indexOf(id);
        if (at >= 0) {
            marked.splice(at, 1);
        } else {
            marked.push(id);
        }

        if (marked.length === 0) {
            selectObject(null);
        } else if (marked.length === 1) {
            selectObject({ type: "state", id: marked[0] });
        } else {
            selectObject({ type: "multi" }, marked);
        }
    }

    const statesEl = h("div", { class: "box" });

    // All the states as a tree, a superstate with its clients below it.
    function renderStatesTree() {
        const bundle = state.bundle;
        const marked = new Set(state.multi.length ? state.multi : state.selection && state.selection.type === "state" ? [state.selection.id] : []);

        const list = (nodes) => h("ul", { class: "states-tree" }, ...nodes.map((s) =>
            h("li", {},
              h("div", { class: "tree-row" },
                s.kids.length
                    ? h("button", {
                        type: "button",
                        class: "fold",
                        title: state.collapsed.has(s.id) ? `Show its ${s.kids.length} states` : "Fold its states away",
                        "aria-expanded": state.collapsed.has(s.id) ? "false" : "true",
                        onclick: () => {
                            state.collapsed.has(s.id) ? state.collapsed.delete(s.id) : state.collapsed.add(s.id);
                            renderStatesTree();
                        }
                    }, state.collapsed.has(s.id) ? "▸" : "▾")
                    : h("span", { class: "fold-spacer" }),
                h("button", {
                    type: "button",
                    class: `${marked.has(s.id) ? "active" : ""} ${s.polygons.length === 0 ? "group" : ""}`.trim(),
                    title: s.polygons.length === 0 ? "A superstate (made of the states below it)" : "",
                    onclick: (event) => {
                        if (event.shiftKey || event.ctrlKey || event.metaKey) {
                            toggleMarked(s.id);
                        } else {
                            selectObject({ type: "state", id: s.id });
                        }
                    }
                }, h("span", { class: "swatch", style: `background:${s.color}` }), s.name, s.status === "capital" ? " (capital)" : "", s.hidden ? " ·" : "", s.kids.length && state.collapsed.has(s.id) ? ` (${s.kids.length})` : "")),
                s.kids.length && !state.collapsed.has(s.id) ? list(s.kids) : null)));

        const tree = bundle ? MapCore.stateTree(bundle.states) : [];
        put(statesEl,
            h("h3", {}, "States"),
            tree.length
                ? list(tree)
                : h("p", { class: "hint" }, "No states yet. Use Draw state."),
            tree.length ? h("p", { class: "hint" }, "Shift-click (or Ctrl-click) to mark several; then combine them into a superstate.") : null);
    }

    const inspectorEl = h("div", { class: "box" });

    async function chooseLorePage(current) {
        // A small search over lore pages.
        return new Promise((resolve) => {
            const results = h("ul", { class: "picker-results" });
            const input = h("input", { type: "search", placeholder: "Search lore pages…" });
            const dialog = h("dialog", {},
                h("h2", {}, "Link to a lore page"),
                input,
                results,
                h("div", { class: "form-actions" },
                    current ? h("button", { type: "button", onclick: () => done({ id: null }) }, "Remove the link") : null,
                    h("button", { type: "button", onclick: () => done(null) }, "Cancel")));

            function done(value) {
                dialog.close();
                dialog.remove();
                resolve(value);
            }

            let timer = null;
            input.addEventListener("input", () => {
                clearTimeout(timer);
                timer = setTimeout(async () => {
                    const found = await api("GET", `/api/lore/search-pages?q=${encodeURIComponent(input.value)}`).catch(() => []);
                    results.replaceChildren(...found.map((page) =>
                        h("li", { onclick: () => done({ id: page.id, title: page.title }) },
                            h("strong", {}, page.title), " ", h("span", { class: "sub" }, page.category_name))));
                }, 200);
            });
            dialog.addEventListener("cancel", () => done(null));
            document.body.append(dialog);
            dialog.showModal();
            input.focus();
        });
    }

    function field(label, input) {
        return h("div", { class: "field" }, h("label", {}, label), input);
    }

    // Saves one property when the field loses focus or changes.
    function bindSave(input, save) {
        input.addEventListener("change", () => guarded(async () => {
            await save(input.type === "checkbox" ? input.checked : input.value);
            await load();
            say("Saved.");
        }));
        return input;
    }

    function renderInspector() {
        const selection = state.selection;
        const bundle = state.bundle;
        put(inspectorEl);

        if (!selection || !bundle) {
            add(inspectorEl, h("h3", {}, "Selection"), h("p", { class: "hint" }, "Nothing selected. Choose Select, then click a state, shape or place."));
            return;
        }

        if (selection.type === "multi") {
            const chosen = state.multi.map((id) => bundle.states.find((x) => x.id === id)).filter(Boolean);
            add(inspectorEl,
                h("h3", {}, `${chosen.length} states marked`),
                h("p", {}, chosen.map((c) => c.name).join(", ")),
                h("div", { class: "row" },
                    h("button", { type: "button", class: "primary", onclick: () => combineMarked(chosen) }, "Combine into a new state…"),
                    h("button", { type: "button", onclick: () => addMarkedToGroup(chosen) }, "Add to a superstate…"),
                    chosen.some((c) => c.parent_id)
                        ? h("button", { type: "button", onclick: () => takeOut(chosen) }, "Take out of their superstate")
                        : null,
                    h("button", { type: "button", onclick: () => selectObject(null) }, "Clear")),
                h("p", { class: "hint" }, "Combining keeps every state as it is; the new state is made of them, and exists only while it has some."));
            return;
        }

        if (selection.type === "state") {
            const s = bundle.states.find((x) => x.id === selection.id);
            if (!s) {
                return;
            }
            const isGroup = s.polygons.length === 0;
            const parent = s.parent_id ? bundle.states.find((x) => x.id === s.parent_id) : null;
            const clients = bundle.states.filter((x) => x.parent_id === s.id).sort((a, b) => a.name.localeCompare(b.name));
            const colorInput = bindSave(h("input", { type: "color", value: s.color }), (value) => api("PUT", `/api/map-states/${s.id}`, { color: value }));
            const hiddenInput = hiddenField(s.hidden, (value) => guarded(async () => { await api("PUT", `/api/map-states/${s.id}`, { hidden: value }); await load(); }));

            add(inspectorEl,
                h("h3", {}, isGroup ? "Superstate" : "State"),
                field("Name", bindSave(h("input", { type: "text", value: s.name }), (value) => api("PUT", `/api/map-states/${s.id}`, { name: value }))),
                field("Color", colorInput),
                hiddenInput.element,
                parent
                    ? h("p", {},
                        "Part of ",
                        h("a", { href: "#", onclick: (event) => { event.preventDefault(); selectObject({ type: "state", id: parent.id }); } }, parent.name),
                        " ",
                        h("button", { type: "button", onclick: () => takeOut([s]) }, "Take out"))
                    : null,
                parent
                    ? field(`Status in ${parent.name}`, bindSave(
                        h("select", {}, ...Object.entries(MapCore.STATUS_NAMES).map(([key, label]) =>
                            h("option", { value: key, selected: (s.status || "province") === key }, label))),
                        (value) => api("PUT", `/api/map-states/${s.id}`, { status: value })))
                    : null,
                statsBlock(s),
                isGroup
                    ? h("details", { class: "clients", open: "" },
                        h("summary", {}, `Made of ${clients.length} state${clients.length === 1 ? "" : "s"} (shown on its lore page automatically)`),
                        h("ul", { class: "states-tree" }, ...clients.map((c) =>
                            h("li", {}, h("button", { type: "button", onclick: () => selectObject({ type: "state", id: c.id }) },
                                h("span", { class: "swatch", style: `background:${c.color}` }), c.name)))))
                    : null,
                s.page ? h("p", {}, h("a", { href: s.page.url, target: "_blank" }, "Open its lore page ↗")) : h("p", { class: "hint" }, "Its lore page has been detached."),
                h("div", { class: "row" },
                    h("button", { type: "button", onclick: () => zoomTo(s.id) }, "Zoom to"),
                    isGroup ? null : h("button", { type: "button", onclick: () => setMode("borders") }, "Edit borders"),
                    isGroup ? null : h("button", { type: "button", onclick: () => drawInto(s.id, "piece") }, "Add island"),
                    isGroup ? null : h("button", { type: "button", onclick: () => drawInto(s.id, "hole") }, "Add hole"),
                    h("button", { type: "button", class: "danger", onclick: () => deleteState(s, isGroup) }, isGroup ? "Dissolve" : "Delete")));
            return;
        }

        if (selection.type === "feature") {
            const f = bundle.features.find((x) => x.id === selection.id);
            if (!f) {
                return;
            }
            const kindInput = f.kind === "river" || f.kind === "ocean"
                ? null
                : bindSave(h("select", {},
                    h("option", { value: "land", selected: f.kind === "land" }, "Land"),
                    h("option", { value: "lake", selected: f.kind === "lake" }, "Lake")),
                (value) => api("PUT", `/api/map-features/${f.id}`, { kind: value }));
            const hiddenInput = hiddenField(f.hidden, (value) => guarded(async () => { await api("PUT", `/api/map-features/${f.id}`, { hidden: value }); await load(); }));

            add(inspectorEl, 
                h("h3", {}, { river: "River", lake: "Lake", ocean: "Sea or ocean name", land: "Land" }[f.kind]),
                field(f.kind === "ocean" ? "Name" : "Name (optional)", bindSave(h("input", { type: "text", value: f.name || "" }), (value) => api("PUT", `/api/map-features/${f.id}`, { name: value }))),
                kindInput ? field("Kind", kindInput) : null,
                f.kind === "ocean" ? h("p", { class: "hint" }, "The name sits in the middle of this outline and is sized to it. Reshape the outline to move or resize the name.") : null,
                hiddenInput.element,
                h("div", { class: "row" },
                    h("button", { type: "button", onclick: () => setMode("reshape") }, "Reshape"),
                    h("button", { type: "button", class: "danger", onclick: () => deleteFeature(f) }, "Delete")));
            return;
        }

        if (selection.type === "point") {
            const p = bundle.points.find((x) => x.id === selection.id);
            if (!p) {
                return;
            }
            const hiddenInput = hiddenField(p.hidden, (value) => guarded(async () => { await api("PUT", `/api/map-points/${p.id}`, { hidden: value }); await load(); }));
            add(inspectorEl, 
                h("h3", {}, "Place"),
                field("Name", bindSave(h("input", { type: "text", value: p.name }), (value) => api("PUT", `/api/map-points/${p.id}`, { name: value }))),
                field("Kind", bindSave(h("select", {}, ...PLACE_KINDS.map((k) => h("option", { value: k, selected: k === p.kind }, k))), (value) => api("PUT", `/api/map-points/${p.id}`, { kind: value }))),
                h("p", {},
                    p.page ? h("a", { href: p.page.url, target: "_blank" }, `${p.page.title} ↗`) : h("span", { class: "hint" }, "No lore page linked."),
                    " ",
                    h("button", { type: "button", onclick: () => linkPlace(p) }, p.page ? "Change link" : "Link a page…")),
                hiddenInput.element,
                h("div", { class: "row" },
                    h("button", { type: "button", onclick: () => setMovePlace() }, "Move"),
                    h("button", { type: "button", class: "danger", onclick: () => deletePlace(p) }, "Delete")));
        }
    }

    // Area, border length and neighbours, from the shapes as drawn.
    function statsBlock(s) {
        const stats = s.stats;
        if (!stats || stats.area_sq_mi <= 0) {
            return null;
        }
        return h("div", { class: "stats" },
            h("h4", {}, "Statistics (approximate)"),
            h("p", {}, `Area about ${MapCore.approx(stats.area_sq_mi)} sq mi`),
            h("p", {}, `Border about ${MapCore.approx(stats.perimeter_mi)} mi long`),
            stats.neighbors.length
                ? h("div", {}, h("p", { class: "hint" }, "Neighbours, with the border shared:"),
                    h("ul", { class: "states-tree" }, ...stats.neighbors.map((n) =>
                        h("li", {}, h("button", { type: "button", onclick: () => selectObject({ type: "state", id: n.id }) },
                            `${n.name} · ${MapCore.approx(n.border_mi)} mi`)))))
                : h("p", { class: "hint" }, "No neighbouring state shares a border with it."));
    }

    function zoomTo(stateId) {
        const box = state.view.stateExtent(stateId);
        if (box) {
            state.view.fit(box, { animate: true });
        }
    }

    function drawInto(stateId, role) {
        setMode("state");
        state.drawTarget = { stateId, role };
        say(role === "piece"
            ? "Draw the separate piece (an island, say). Double-click to finish."
            : "Draw the hole inside the state, starting inside it. Double-click to finish.");
    }

    function setMovePlace() {
        const keep = state.selection;
        setMode("movePlace");
        state.selection = keep;
        state.view.select(keep);
    }

    // Says which superstates disappeared because their last client left.
    function reportRemoved(result, fallback) {
        const removed = (result && result.removed) || [];
        say(removed.length
            ? `${fallback} ${removed.map((n) => `“${n}”`).join(", ")} had no states left, so ${removed.length === 1 ? "it was" : "they were"} removed (the lore ${removed.length === 1 ? "page is" : "pages are"} kept).`
            : fallback);
    }

    async function deleteState(s, isGroup = false) {
        const answer = await ask({
            title: isGroup ? `Dissolve “${s.name}”?` : `Delete “${s.name}”?`,
            okLabel: isGroup ? "Dissolve" : "Delete state",
            danger: true,
            extra: isGroup ? h("p", { class: "hint" }, "Its states are kept and stand on their own (or join its own superstate). Only the grouping is removed.") : null,
            fields: [{ key: "deletePage", type: "checkbox", label: "Also delete its lore page (otherwise the page is kept, as an ordinary page)", value: false }]
        });
        if (!answer) {
            return;
        }
        await guarded(async () => {
            const result = await api("DELETE", `/api/map-states/${s.id}${answer.deletePage ? "?deletePage=1" : ""}`);
            selectObject(null);
            await load();
            reportRemoved(result, isGroup ? "Dissolved." : "State deleted.");
        });
    }

    // ---- superstates ----

    async function combineMarked(chosen) {
        const answer = await ask({
            title: "Combine into a new state",
            okLabel: "Combine",
            fields: [{ key: "name", label: `Name of the new state made of ${chosen.map((c) => c.name).join(", ")}`, required: true }]
        });
        if (!answer) {
            return;
        }
        await guarded(async () => {
            const result = await api("POST", `/api/maps/${state.mapId}/states/group`, { ids: chosen.map((c) => c.id), name: answer.name });
            await load();
            selectObject({ type: "state", id: result.state.id });
            reportRemoved(result, `“${answer.name}” created, with its page in the States lore category.`);
        });
    }

    async function addMarkedToGroup(chosen) {
        const ids = new Set(chosen.map((c) => c.id));
        const groups = state.bundle.states.filter((s) => s.polygons.length === 0 && !ids.has(s.id));
        if (groups.length === 0) {
            say("There is no superstate to add them to yet. Combine some states first.", "error");
            return;
        }
        const answer = await ask({
            title: "Add to a superstate",
            okLabel: "Add",
            fields: [{ key: "group", label: "Superstate", type: "select", value: groups[0].id, options: groups.map((g) => [g.id, g.name]) }]
        });
        if (!answer) {
            return;
        }
        await guarded(async () => {
            const result = await api("POST", `/api/map-states/${answer.group}/members`, { ids: chosen.map((c) => c.id) });
            await load();
            selectObject({ type: "state", id: Number(answer.group) });
            reportRemoved(result, "Added.");
        });
    }

    async function takeOut(chosen) {
        await guarded(async () => {
            const result = await api("POST", `/api/maps/${state.mapId}/states/ungroup`, { ids: chosen.map((c) => c.id) });
            await load();
            selectObject(chosen.length === 1 ? { type: "state", id: chosen[0].id } : null);
            reportRemoved(result, "Taken out of their superstate.");
        });
    }

    async function deleteFeature(f) {
        if (!confirm("Delete this shape?")) {
            return;
        }
        await guarded(async () => {
            await api("DELETE", `/api/map-features/${f.id}`);
            selectObject(null);
            await load();
        });
    }

    async function deletePlace(p) {
        if (!confirm(`Delete the place “${p.name}”?`)) {
            return;
        }
        await guarded(async () => {
            await api("DELETE", `/api/map-points/${p.id}`);
            selectObject(null);
            await load();
        });
    }

    async function linkPlace(p) {
        const choice = await chooseLorePage(p.page);
        if (!choice) {
            return;
        }
        await guarded(async () => {
            await api("PUT", `/api/map-points/${p.id}`, { page_id: choice.id });
            await load();
        });
    }

    // ------------------------------------------------------
    // Maps: choosing, creating, settings
    // ------------------------------------------------------

    const mapSelect = h("select", { "aria-label": "Map", onchange: async () => {
        state.mapId = Number(mapSelect.value);
        selectObject(null);
        await guarded(() => load({ remount: true }));
    } });

    function renderMapSelect() {
        mapSelect.replaceChildren(...state.maps.map((m) =>
            h("option", { value: m.id, selected: m.id === state.mapId }, `${m.name}${m.hidden ? " · not published" : ""}`)));
        mapSelect.disabled = state.maps.length === 0;
    }

    async function mapDialog(existing) {
        const answer = await ask({
            title: existing ? `Edit ${existing.name}` : "New map",
            okLabel: existing ? "Save" : "Create map",
            fields: [
                { key: "name", label: "Name", value: existing ? existing.name : "", required: true },
                { key: "slug", label: "Slug", value: existing ? existing.slug : "", hint: "used in the address; leave empty to make one" },
                { key: "description", label: "Description", type: "textarea", value: existing ? existing.description : "" },
                { key: "width", label: "Width (map units)", type: "number", value: existing ? existing.width : 2000, min: "10" },
                { key: "height", label: "Height (map units)", type: "number", value: existing ? existing.height : 1500, min: "10" },
                { key: "miles_per_unit", label: "Miles per map unit", type: "number", step: "any", value: existing ? existing.miles_per_unit : 1, hint: "or use Set scale to measure it" },
                { key: "hidden", label: "Do not publish this map", type: "checkbox", value: existing ? existing.hidden : false }
            ]
        });
        if (!answer) {
            return;
        }

        await guarded(async () => {
            const data = { ...answer, width: Number(answer.width), height: Number(answer.height), miles_per_unit: Number(answer.miles_per_unit), slug: answer.slug || undefined };
            if (existing) {
                const resized = existing.width !== data.width || existing.height !== data.height;
                await api("PUT", `/api/maps/${existing.id}`, data);
                await loadMaps(existing.id);
                await load({ remount: resized });
            } else {
                const created = await api("POST", "/api/maps", data);
                await loadMaps(created.id);
                selectObject(null);
                await load({ remount: true });
            }
        });
    }

    async function deleteMap() {
        const map = currentMap();
        const answer = await ask({
            title: `Delete the map “${map.name}”?`,
            okLabel: "Delete map",
            danger: true,
            fields: [{ key: "deletePages", type: "checkbox", label: "Also delete the lore pages of its states (otherwise they are kept)", value: false }]
        });
        if (!answer) {
            return;
        }
        await guarded(async () => {
            await api("DELETE", `/api/maps/${map.id}${answer.deletePages ? "?deletePages=1" : ""}`);
            selectObject(null);
            await loadMaps();
            await load({ remount: true });
        });
    }

    // ------------------------------------------------------
    // Tracer images
    // ------------------------------------------------------

    const tracersEl = h("div", { class: "box" });
    const fileInput = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp", hidden: true });

    fileInput.addEventListener("change", async () => {
        const file = fileInput.files[0];
        fileInput.value = "";
        if (!file) {
            return;
        }
        say(`Uploading ${file.name}…`);
        await guarded(async () => {
            const response = await fetch(`/api/maps/${state.mapId}/images?name=${encodeURIComponent(file.name)}`, {
                method: "POST",
                headers: { "Content-Type": file.type },
                body: file
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(payload.error || `Upload failed (${response.status})`);
            }
            // The first image of an empty map resizes the map to fit it.
            const before = currentMap();
            await load({ remount: true });
            say("Tracer added. Trace over it with the drawing tools; it is never published.");
            if (before) {
                state.view.fit();
            }
        });
    });

    function renderTracers() {
        put(tracersEl, 
            h("h3", {}, "Tracer images"),
            h("div", { class: "row" },
                h("button", { type: "button", disabled: !state.bundle, onclick: () => fileInput.click() }, "Upload a tracer…"),
                h("span", { class: "hint" }, "PNG, JPEG or WebP; editor only")),
            fileInput);

        for (const image of state.bundle ? state.bundle.images : []) {
            const save = (changes) => guarded(async () => {
                await api("PUT", `/api/map-images/${image.id}`, changes);
                Object.assign(image, changes);
                state.view.setImages(state.bundle.images);
                applyLayerVisibility();
            });
            const number = (key, label) => {
                const input = h("input", { type: "number", step: "any", value: Math.round(image[key] * 100) / 100 });
                input.addEventListener("change", () => save({ [key]: Number(input.value) }));
                return h("div", {}, h("label", {}, label), input);
            };

            add(tracersEl, h("div", { class: "tracer" },
                h("div", { class: "row" },
                    h("input", { type: "checkbox", checked: Boolean(image.visible), "aria-label": "Show", onchange: (event) => save({ visible: event.target.checked }) }),
                    h("strong", {}, image.name),
                    h("span", { class: "grow" }),
                    h("button", { type: "button", class: "danger", onclick: async () => {
                        if (confirm(`Remove the tracer “${image.name}”?`)) {
                            await guarded(async () => { await api("DELETE", `/api/map-images/${image.id}`); await load(); });
                        }
                    } }, "Remove")),
                h("div", { class: "field" },
                    h("label", {}, "Opacity"),
                    h("input", { type: "range", min: "0", max: "1", step: "0.05", value: image.opacity, oninput: (event) => {
                        image.opacity = Number(event.target.value);
                        const layer = state.view.imageLayers[state.bundle.images.indexOf(image)];
                        if (layer) {
                            layer.setOpacity(image.opacity);
                        }
                    }, onchange: (event) => save({ opacity: Number(event.target.value) }) })),
                h("div", { class: "grid" }, number("x", "x"), number("y", "y"), number("width", "width"), number("height", "height"))));
        }
    }

    // ------------------------------------------------------
    // Layers
    // ------------------------------------------------------

    function applyLayerVisibility() {
        const view = state.view;
        if (!view) {
            return;
        }
        for (const name of ["land", "lakes", "rivers", "states", "labels", "points"]) {
            view.show(name, state.layers[name]);
        }
        view.setElevationStyle(state.elevationStyle);
        view.show("oceans", state.layers.waterNames);
        view.show("waterLabels", state.layers.waterNames);
        view.setWaterNames(state.layers.waterNames);
        let tracing = false;
        view.imageLayers.forEach((layer, index) => {
            const shown = state.layers.tracers && Boolean(state.bundle.images[index].visible);
            layer.setVisible(shown);
            tracing = tracing || shown;
        });
        view.setTracing(tracing);
    }

    const layersEl = h("div", { class: "box" });

    // How elevation is drawn (the same control as on the public map).
    const elevationControls = MapCore.elevationControls(state.elevationStyle, (style) => {
        state.elevationStyle = style;
        applyLayerVisibility();
    });

    function renderLayers() {
        const names = [["tracers", "Tracer images"], ["land", "Land"], ["lakes", "Lakes"], ["rivers", "Rivers"], ["waterNames", "River, lake and sea names"], ["states", "States"], ["labels", "State names"], ["points", "Places"]];
        put(layersEl, 
            h("h3", {}, "Layers"),
            ...names.map(([key, label]) => h("div", { class: "field check" },
                h("input", { type: "checkbox", id: `layer-${key}`, checked: state.layers[key], onchange: (event) => {
                    state.layers[key] = event.target.checked;
                    applyLayerVisibility();
                } }),
                h("label", { for: `layer-${key}` }, label))),
            h("div", { class: "field elevation-field" }, elevationControls.element),
            state.view ? h("div", { class: "field" }, MapCore.rendererControl(state.view)) : null);
    }

    // ------------------------------------------------------
    // The tool palette and the page
    // ------------------------------------------------------

    const toolsEl = h("div", { class: "box" });

    // ------------------------------------------------------
    // Undo and redo
    // ------------------------------------------------------
    //
    // After every load the map's drawing (shapes, corners, states, places) is
    // compared with how it was; if it changed, that is one undoable step, and
    // undoing it asks the server to put the earlier snapshot back. Brush
    // strokes on the elevation are steps of their own (the cells they changed).
    // Not covered: map settings, tracer images, and making or deleting maps.

    const UNDO_DEPTH = 40;

    function snapshotOf(bundle) {
        return {
            features: bundle.features.map((f) => ({ id: f.id, kind: f.kind, name: f.name, geometry: f.geometry, hidden: f.hidden, created_at: f.created_at })),
            vertices: bundle.vertices,
            states: bundle.states.map((s) => ({
                id: s.id, name: s.name, color: s.color, label_sans: s.label_sans, hidden: s.hidden,
                parent_id: s.parent_id, status: s.status, polygons: s.polygons, created_at: s.created_at
            })),
            points: bundle.points.map((p) => ({ id: p.id, name: p.name, kind: p.kind, x: p.x, y: p.y, page_id: p.page_id, hidden: p.hidden, created_at: p.created_at }))
        };
    }

    function same(a, b) {
        if (a === b) {
            return true;
        }
        if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
            return false;
        }
        if (Array.isArray(a) !== Array.isArray(b)) {
            return false;
        }
        const keys = Object.keys(a);
        if (keys.length !== Object.keys(b).length) {
            return false;
        }
        return keys.every((key) => same(a[key], b[key]));
    }

    // A few words for what changed between two snapshots.
    function describeChange(before, after) {
        const byId = (list) => new Map(list.map((x) => [x.id, x]));
        const quote = (name) => `“${name}”`;

        const statesA = byId(before.states);
        const statesB = byId(after.states);
        const addedState = after.states.find((s) => !statesA.has(s.id));
        if (addedState) {
            return addedState.polygons.length ? `Draw state ${quote(addedState.name)}` : `Combine into ${quote(addedState.name)}`;
        }
        const removedState = before.states.find((s) => !statesB.has(s.id));
        if (removedState) {
            return removedState.polygons.length ? `Delete state ${quote(removedState.name)}` : `Dissolve ${quote(removedState.name)}`;
        }

        const featuresA = byId(before.features);
        const featuresB = byId(after.features);
        const addedFeature = after.features.find((f) => !featuresA.has(f.id));
        if (addedFeature) {
            return `Draw ${addedFeature.kind === "ocean" ? "sea name" : addedFeature.kind}`;
        }
        const removedFeature = before.features.find((f) => !featuresB.has(f.id));
        // Land that has swallowed other land: the shapes are fewer and one of them has changed.
        if (removedFeature && removedFeature.kind === "land" && after.features.some((f) => f.kind === "land" && !same(f.geometry, (featuresA.get(f.id) || {}).geometry))) {
            return "Join land";
        }
        if (removedFeature) {
            return `Delete ${removedFeature.kind === "ocean" ? "sea name" : removedFeature.kind}`;
        }
        const changedFeature = after.features.find((f) => !same(f, featuresA.get(f.id)));
        if (changedFeature && state.nextLabel) {
            const label = state.nextLabel;
            state.nextLabel = null;
            return label;
        }
        if (changedFeature) {
            return same(changedFeature.geometry, featuresA.get(changedFeature.id).geometry)
                ? `Edit ${changedFeature.kind === "ocean" ? "sea name" : changedFeature.kind}`
                : `Reshape ${changedFeature.kind === "ocean" ? "sea name" : changedFeature.kind}`;
        }

        const pointsA = byId(before.points);
        const pointsB = byId(after.points);
        const addedPoint = after.points.find((p) => !pointsA.has(p.id));
        if (addedPoint) {
            return `Add place ${quote(addedPoint.name)}`;
        }
        const removedPoint = before.points.find((p) => !pointsB.has(p.id));
        if (removedPoint) {
            return `Delete place ${quote(removedPoint.name)}`;
        }
        const changedPoint = after.points.find((p) => !same(p, pointsA.get(p.id)));
        if (changedPoint) {
            const old = pointsA.get(changedPoint.id);
            return old.x !== changedPoint.x || old.y !== changedPoint.y ? `Move place ${quote(changedPoint.name)}` : `Edit place ${quote(changedPoint.name)}`;
        }

        const changedState = after.states.find((s) => !same(s, statesA.get(s.id)));
        if (changedState) {
            const old = statesA.get(changedState.id);
            if (old.parent_id !== changedState.parent_id) {
                return "Change grouping";
            }
            if (old.status !== changedState.status) {
                return "Change status";
            }
            if (!same(old.polygons, changedState.polygons)) {
                return `Reshape state ${quote(changedState.name)}`;
            }
            return `Edit state ${quote(changedState.name)}`;
        }

        if (after.vertices.length !== before.vertices.length) {
            return after.vertices.length > before.vertices.length ? "Add corner" : "Remove corner";
        }
        return "Move corner";
    }

    const landOf = (snapshot) => snapshot.features.filter((f) => f.kind === "land").map((f) => [f.id, f.geometry]);

    function pushUndo(entry) {
        state.undo.push(entry);
        if (state.undo.length > UNDO_DEPTH) {
            state.undo.shift();
        }
        state.redo = [];
        renderUndo();
    }

    // Called by load() with the map as it now is.
    function recordChange(snapshot, previousGrid) {
        if (state.undoMapId !== state.mapId) {
            state.undo = [];
            state.redo = [];
            state.lastSnapshot = null;
            state.undoMapId = state.mapId;
        }

        if (state.restoring || state.draw) {
            // An undo is not itself a step; while a state is being drawn its steps wait for the end.
            if (state.restoring) {
                state.lastSnapshot = snapshot;
            }
            return;
        }

        const before = state.lastSnapshot;
        state.lastSnapshot = snapshot;

        if (before && !same(before, snapshot)) {
            const landChanged = !same(landOf(before), landOf(snapshot));
            pushUndo({
                kind: "map",
                label: describeChange(before, snapshot),
                before,
                after: snapshot,
                // Reshaping land changes which cells exist: keep the elevation as it was, too.
                gridBefore: landChanged && previousGrid ? previousGrid.data : null,
                gridAfter: landChanged && state.elevation ? state.elevation.data.slice() : null
            });
        }
        renderUndo();
    }

    // Puts a whole grid back (cells that aren't land are left alone by the server).
    async function putGrid(data) {
        const grid = state.elevation;
        if (!data || !grid || data.length !== grid.cols * grid.rows) {
            return;
        }
        await putCells({ x: 0, y: 0, w: grid.cols, h: grid.rows }, data);
    }

    async function putCells(rect, values) {
        const response = await fetch(`/api/maps/${state.mapId}/elevation/patch?x=${rect.x}&y=${rect.y}&w=${rect.w}&h=${rect.h}`, {
            method: "PUT",
            headers: { "Content-Type": "application/octet-stream" },
            body: values
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(payload.error || `Could not save the elevation (${response.status})`);
        }
        return payload;
    }

    async function step(from, to, verb) {
        const entry = from.pop();
        if (!entry) {
            return;
        }
        state.restoring = true;
        await guarded(async () => {
            if (entry.kind === "elevation") {
                const values = verb === "Undid" ? entry.before : entry.after;
                const grid = state.elevation;
                for (let row = 0; row < entry.rect.h; row++) {
                    for (let col = 0; col < entry.rect.w; col++) {
                        const at = (entry.rect.y + row) * grid.cols + entry.rect.x + col;
                        if (grid.data[at] !== MapCore.NO_LAND) {
                            grid.data[at] = values[row * entry.rect.w + col];
                        }
                    }
                }
                state.view.paintElevation(entry.rect);
                const payload = await putCells(entry.rect, values);
                grid.updated_at = payload.updated_at;
            } else {
                const snapshot = verb === "Undid" ? entry.before : entry.after;
                const response = await fetch(`/api/maps/${state.mapId}/restore`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(snapshot)
                });
                const payload = await response.json().catch(() => ({}));
                if (!response.ok) {
                    throw new Error(payload.error || `Could not ${verb === "Undid" ? "undo" : "redo"} (${response.status})`);
                }
                // The grid follows the land: take its new shape before putting heights back.
                state.bundle = await api("GET", `/api/maps/${state.mapId}`);
                await refreshElevation();
                await putGrid(verb === "Undid" ? entry.gridBefore : entry.gridAfter);
                await load();
            }
            to.push(entry);
            say(`${verb}: ${entry.label}.`);
        });
        state.restoring = false;
        renderUndo();
    }

    const undo = () => step(state.undo, state.redo, "Undid");
    const redo = () => step(state.redo, state.undo, "Redid");

    const undoEl = h("div", { class: "row undo-row" });

    function renderUndo() {
        const last = state.undo[state.undo.length - 1];
        const next = state.redo[state.redo.length - 1];
        put(undoEl,
            h("button", { type: "button", disabled: !last, title: last ? `Undo: ${last.label} (Ctrl+Z)` : "Nothing to undo", onclick: undo }, "↶ Undo"),
            h("button", { type: "button", disabled: !next, title: next ? `Redo: ${next.label} (Ctrl+Shift+Z)` : "Nothing to redo", onclick: redo }, "↷ Redo"),
            h("span", { class: "hint" }, last ? `last: ${last.label}` : ""));
    }

    // ------------------------------------------------------
    // Elevation
    // ------------------------------------------------------

    // Fetches the grid when the server's copy is newer than ours.
    async function refreshElevation() {
        const meta = state.bundle ? state.bundle.elevation : null;
        if (!meta) {
            state.elevation = null;
        } else if (!state.elevation || state.elevation.updated_at !== meta.updated_at || state.elevation.cols !== meta.cols) {
            state.elevation = await MapCore.loadElevation(meta, state.mapId);
        }
    }

    // How strongly a cell at `d` (0 at the centre of the brush, 1 at its edge)
    // is moved: soft hills (a broad, smooth bump) at one end, sharp peaks (a
    // narrow spike with steep sides) at the other.
    function brushWeight(d, sharpness) {
        if (d >= 1) {
            return 0;
        }
        const soft = (1 - d * d) ** 2;
        const sharp = (1 - d) ** 2.6;
        return soft * (1 - sharpness) + sharp * sharpness;
    }

    function brushGeometry(coordinate) {
        const grid = state.elevation;
        const milesPerCell = grid.cell * currentMap().miles_per_unit;
        const radius = Math.max(1, state.brush.radius / milesPerCell);
        const centre = state.view.elevationCell(coordinate);
        return { grid, radius, centre };
    }

    function showBrush(coordinate) {
        sketchSource.clear();
        if (!state.elevation) {
            return;
        }
        const radiusUnits = state.brush.radius / currentMap().miles_per_unit;
        sketchSource.addFeature(new ol.Feature({ geometry: new ol.geom.Circle(coordinate, radiusUnits), kind: "brush" }));
    }

    // Sends the changed rectangle of cells to the server.
    async function saveElevation(rect) {
        const grid = state.elevation;
        const values = new Int16Array(rect.w * rect.h);
        for (let row = 0; row < rect.h; row++) {
            for (let col = 0; col < rect.w; col++) {
                values[row * rect.w + col] = grid.data[(rect.y + row) * grid.cols + rect.x + col];
            }
        }
        await guarded(async () => {
            const response = await fetch(`/api/maps/${state.mapId}/elevation/patch?x=${rect.x}&y=${rect.y}&w=${rect.w}&h=${rect.h}`, {
                method: "PUT",
                headers: { "Content-Type": "application/octet-stream" },
                body: values
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(payload.error || `Could not save the elevation (${response.status})`);
            }
            grid.updated_at = payload.updated_at;
        });
    }

    function installBrush(mode) {
        let stroke = null;

        const regionOf = (centre, radius) => {
            const grid = state.elevation;
            const x = Math.max(0, Math.floor(centre[0] - radius));
            const y = Math.max(0, Math.floor(centre[1] - radius));
            return {
                x, y,
                w: Math.min(grid.cols, Math.ceil(centre[0] + radius) + 1) - x,
                h: Math.min(grid.rows, Math.ceil(centre[1] + radius) + 1) - y
            };
        };

        const pointer = new ol.interaction.Pointer({
            handleDownEvent(event) {
                if (!state.elevation) {
                    say("There is no land to shape yet: draw some land first (its elevation is made with it).", "error");
                    return false;
                }
                const { grid, radius, centre } = brushGeometry(event.coordinate);
                if (!centre || grid.data[centre[1] * grid.cols + centre[0]] === MapCore.NO_LAND) {
                    return false; // the sea: the map pans instead
                }

                stroke = { mode, radius, startY: event.pixel[1], dirty: null, original: grid.data.slice() };

                if (mode === "elevate") {
                    stroke.centre = centre;
                    stroke.region = regionOf(centre, radius);
                    // The cells as they were when the drag began: each move is worked out from these.
                    stroke.before = new Int16Array(grid.data.buffer.slice(0));
                    stroke.peak = grid.data[centre[1] * grid.cols + centre[0]];
                } else {
                    smoothAt(event.coordinate);
                }
                return true;
            },
            handleDragEvent(event) {
                if (!stroke) {
                    return;
                }
                showBrush(event.coordinate);
                if (stroke.mode === "elevate") {
                    raiseTo((stroke.startY - event.pixel[1]) * state.brush.feetPerPixel);
                } else {
                    smoothAt(event.coordinate);
                }
            },
            handleUpEvent() {
                const done = stroke;
                stroke = null;
                if (done && done.dirty) {
                    const rect = done.dirty;
                    const grid = state.elevation;
                    const cells = (source) => {
                        const out = new Int16Array(rect.w * rect.h);
                        for (let row = 0; row < rect.h; row++) {
                            for (let col = 0; col < rect.w; col++) {
                                out[row * rect.w + col] = source[(rect.y + row) * grid.cols + rect.x + col];
                            }
                        }
                        return out;
                    };
                    pushUndo({
                        kind: "elevation",
                        label: done.mode === "elevate" ? "Raise or lower land" : "Smooth land",
                        rect,
                        before: cells(done.original),
                        after: cells(grid.data)
                    });
                    saveElevation(rect).then(() => say("Saved."));
                }
                return false;
            },
            handleMoveEvent(event) {
                showBrush(event.coordinate);
            }
        });
        addInteraction(pointer);

        // Pull the land around the grabbed point up (or down) by `delta` feet at the centre.
        function raiseTo(delta) {
            const grid = state.elevation;
            const { centre, radius, region, before } = stroke;
            for (let row = region.y; row < region.y + region.h; row++) {
                for (let col = region.x; col < region.x + region.w; col++) {
                    const at = row * grid.cols + col;
                    if (before[at] === MapCore.NO_LAND) {
                        continue;
                    }
                    const d = Math.hypot(col - centre[0], row - centre[1]) / radius;
                    grid.data[at] = Math.max(0, Math.min(29500, Math.round(before[at] + delta * brushWeight(d, state.brush.sharpness))));
                }
            }
            stroke.dirty = region;
            state.view.paintElevation(region);
            const peak = grid.data[centre[1] * grid.cols + centre[0]];
            say(`Elevation at the grabbed point: ${MapCore.feetText(peak)} (${delta >= 0 ? "+" : "−"}${Math.abs(Math.round(delta)).toLocaleString()} ft)`);
        }

        // One pass of smoothing under the brush: each cell moves toward the average of its neighbours.
        function smoothAt(coordinate) {
            const grid = state.elevation;
            const { radius, centre } = brushGeometry(coordinate);
            if (!centre) {
                return;
            }
            const region = regionOf(centre, radius);
            const copy = grid.data.slice();
            for (let row = region.y; row < region.y + region.h; row++) {
                for (let col = region.x; col < region.x + region.w; col++) {
                    const at = row * grid.cols + col;
                    if (copy[at] === MapCore.NO_LAND) {
                        continue;
                    }
                    const d = Math.hypot(col - centre[0], row - centre[1]) / radius;
                    if (d >= 1) {
                        continue;
                    }
                    let sum = 0;
                    let count = 0;
                    for (let dy = -2; dy <= 2; dy++) {
                        for (let dx = -2; dx <= 2; dx++) {
                            const r = row + dy;
                            const c = col + dx;
                            if (r < 0 || c < 0 || r >= grid.rows || c >= grid.cols) {
                                continue;
                            }
                            const value = copy[r * grid.cols + c];
                            if (value !== MapCore.NO_LAND) {
                                sum += value;
                                count++;
                            }
                        }
                    }
                    const strength = state.brush.smoothing * brushWeight(d, 0);
                    grid.data[at] = Math.round(copy[at] + (sum / count - copy[at]) * strength);
                }
            }
            const merged = stroke.dirty
                ? {
                    x: Math.min(stroke.dirty.x, region.x),
                    y: Math.min(stroke.dirty.y, region.y),
                    w: Math.max(stroke.dirty.x + stroke.dirty.w, region.x + region.w) - Math.min(stroke.dirty.x, region.x),
                    h: Math.max(stroke.dirty.y + stroke.dirty.h, region.y + region.h) - Math.min(stroke.dirty.y, region.y)
                }
                : region;
            stroke.dirty = merged;
            state.view.paintElevation(region);
        }
    }

    // Starts all the land over as plains (hand edits are lost).
    async function regeneratePlains() {
        const answer = await ask({
            title: "Start the land over as plains",
            okLabel: "Regenerate",
            danger: true,
            extra: h("p", { class: "hint" }, "Every land cell is set again: it rises from the coast and levels off. Anything you have raised or lowered by hand is lost."),
            fields: [
                { key: "plateau", label: "Height of the plains inland (feet)", type: "number", value: 900, min: "0" },
                { key: "rise", label: "Distance inland over which it rises (miles)", type: "number", value: 70, min: "1" },
                { key: "ruggedness", label: "Size of the small ups and downs (feet)", type: "number", value: 70, min: "0" }
            ]
        });
        if (!answer) {
            return;
        }
        await guarded(async () => {
            await api("POST", `/api/maps/${state.mapId}/elevation/regenerate`, {
                plateau: Number(answer.plateau), rise: Number(answer.rise), ruggedness: Number(answer.ruggedness)
            });
            await load();
            say("Plains regenerated.");
        });
    }

    // Brush controls, shown while an elevation tool is chosen.
    function brushControls() {
        const grid = state.elevation;
        const map = currentMap();
        const slider = (label, key, min, max, step, format) => {
            const value = h("span", { class: "hint" }, format(state.brush[key]));
            const input = h("input", {
                type: "range", min, max, step, value: state.brush[key],
                oninput: (event) => {
                    state.brush[key] = Number(event.target.value);
                    value.textContent = format(state.brush[key]);
                }
            });
            return h("div", { class: "field" }, h("label", {}, label, " ", value), input);
        };

        return h("div", { class: "brush" },
            slider("Brush size", "radius", 3, 250, 1, (v) => `${v} mi`),
            state.mode === "elevate"
                ? slider("Sharpness", "sharpness", 0, 1, 0.05, (v) => (v < 0.25 ? "soft hills" : v > 0.7 ? "sharp mountains" : "ridges"))
                : null,
            state.mode === "elevate"
                ? slider("Drag sensitivity", "feetPerPixel", 1, 100, 1, (v) => `${v} ft per pixel`)
                : slider("Smoothing strength", "smoothing", 0.1, 1, 0.05, (v) => `${Math.round(v * 100)}%`),
            grid
                ? h("p", { class: "hint" }, `Elevation grid: ${grid.cols} × ${grid.rows} cells of ${Number((grid.cell * map.miles_per_unit).toPrecision(3))} mile${grid.cell * map.miles_per_unit === 1 ? "" : "s"}.`)
                : h("p", { class: "hint" }, "No elevation yet: it is made when land is drawn."),
            h("div", { class: "row" },
                h("button", { type: "button", disabled: !grid, onclick: regeneratePlains }, "Start over as plains…")));
    }

    // The tools, in groups: geography on one side, states and borders on the other.
    const TOOL_GROUPS = [
        ["General", [["select", "Select"], ["place", "Add place"], ["scale", "Set scale"]]],
        ["Geography", [
            ["land", "Draw land"], ["lake", "Draw lake"], ["river", "Draw river"], ["ocean", "Name a sea"],
            ["reshape", "Reshape shapes"], ["elevate", "Raise / lower"], ["smooth", "Smooth"]
        ]],
        ["States & borders", [["state", "Draw state"], ["borders", "Edit borders"]]]
    ];

    function renderTools() {
        const map = currentMap();
        put(toolsEl,
            h("h3", {}, "Tools"),
            undoEl,
            ...TOOL_GROUPS.map(([title, tools]) => h("div", { class: "tool-group" },
                h("h4", {}, title),
                h("div", { class: "tool-grid" }, ...tools.map(([mode, label]) =>
                    h("button", {
                        type: "button",
                        class: state.mode === mode ? "active" : "",
                        disabled: !map,
                        onclick: () => { state.drawTarget = null; setMode(mode); }
                    }, label))))),
            state.mode === "elevate" || state.mode === "smooth" ? brushControls() : null,
            state.mode === "state" || state.mode === "borders"
                ? h("div", { class: "field check" },
                    h("input", { type: "checkbox", id: "follow", checked: state.followBorders, onchange: (event) => { state.followBorders = event.target.checked; } }),
                    h("label", { for: "follow" }, "Follow a neighbour's border between two shared corners"))
                : null,
            state.mode === "state" || state.mode === "borders"
                ? h("div", { class: "field check" },
                    h("input", { type: "checkbox", id: "coast", checked: state.coastSnap, onchange: (event) => { state.coastSnap = event.target.checked; } }),
                    h("label", { for: "coast" }, "Snap to the coastline (and follow it between two points)"))
                : null,
            state.mode === "land" || state.mode === "reshape"
                ? h("div", { class: "field check" },
                    h("input", { type: "checkbox", id: "landjoin", checked: state.landJoin, onchange: (event) => { state.landJoin = event.target.checked; } }),
                    h("label", { for: "landjoin" }, "Join land that overlaps or touches other land into one piece"))
                : null,
            h("p", { class: "hint" }, HINTS[state.mode] || ""));
    }

    const mapBoxEl = h("div", { class: "box" });

    function renderMapBox() {
        const map = currentMap();
        put(mapBoxEl, 
            h("h3", {}, "Map"),
            h("div", { class: "field" }, mapSelect),
            h("div", { class: "row" },
                h("button", { type: "button", class: "primary", onclick: () => mapDialog(null) }, "New map"),
                h("button", { type: "button", disabled: !map, onclick: () => mapDialog(map) }, "Map settings"),
                map ? h("a", { href: `/maps/${encodeURIComponent(map.slug)}`, target: "_blank" }, "View ↗") : null),
            map ? h("p", { class: "hint" },
                `${map.width} × ${map.height} map units · 1 unit = ${Number(map.miles_per_unit.toPrecision(4))} mi · about ${Math.round(map.width * map.miles_per_unit).toLocaleString()} mi wide`) : null,
            map ? h("div", { class: "row" }, h("button", { type: "button", class: "danger", onclick: deleteMap }, "Delete this map")) : null);
    }

    function renderAll() {
        renderMapBox();
        renderTools();
        renderLayers();
        renderTracers();
        renderInspector();
        renderStatesTree();
    }

    root.replaceChildren(
        h("div", { class: "map-side" }, mapBoxEl, toolsEl, inspectorEl, statesEl, layersEl, tracersEl),
        h("div", { class: "map-main" }, viewEl, statusEl));

    // Ctrl+Z undoes, Ctrl+Shift+Z or Ctrl+Y redoes (a state being drawn takes Ctrl+Z as "take back a corner").
    document.addEventListener("keydown", (event) => {
        const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName) || event.target.isContentEditable;
        if (typing || document.querySelector("dialog[open]:not(.choosing)") || state.choosing || !(event.ctrlKey || event.metaKey)) {
            return;
        }
        const key = event.key.toLowerCase();
        if (key === "z" && !event.shiftKey) {
            event.preventDefault();
            if (state.draw && state.draw.points.length) {
                state.draw.points.pop();
                renderSketch(null);
            } else {
                undo();
            }
        } else if ((key === "z" && event.shiftKey) || key === "y") {
            event.preventDefault();
            redo();
        }
    });

    // Esc abandons whatever is being drawn: a piece of land, lake, river or sea outline, a state
    // (or the island or hole about to be added to one), or a distance being measured.
    document.addEventListener("keydown", (event) => {
        if (event.key !== "Escape" || document.querySelector("dialog[open]:not(.choosing)")) {
            return;
        }
        if (state.choosing) {
            closeChoosing();
            renderSketch(null);
            say("Back to drawing the line.");
        } else if (["land", "lake", "river", "ocean"].includes(state.mode) && activeDraw) {
            activeDraw.abortDrawing();
            say("Cancelled.");
        } else if (state.mode === "state" && state.draw) {
            cancelDrawing();
            state.drawTarget = null;
            say("Cancelled.");
        } else if (state.mode === "state" && state.drawTarget) {
            setMode("select");
            say("Cancelled.");
        } else if (state.mode === "scale" && (state.scalePoints || []).length) {
            state.scalePoints = [];
            sketchSource.clear();
            say("Cancelled.");
        }
    });

    document.addEventListener("keydown", (event) => {
        if (state.mode !== "state" || !state.draw || ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName)) {
            return;
        }
        if (state.choosing) {
            return;
        }
        if (event.key === "Enter") {
            event.preventDefault();
            if (event.shiftKey) {
                finishState();
            } else {
                autocompleteState();
            }
        } else if (event.key === "Backspace") {
            event.preventDefault();
            state.draw.points.pop();
            renderSketch(null);
        }
    });

    renderUndo();

    window.addEventListener("beforeunload", () => sketchSource.clear());

    root.editorState = state; // for tests

    loadMaps()
        .then(() => load({ remount: true }))
        .catch((error) => say(error.message, "error"));
})();
