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
        layers: { tracers: true, land: true, lakes: true, rivers: true, states: true, labels: true, points: true },
        interactions: []
    };

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

        if (remount || !state.view) {
            mountView();
        } else {
            state.view.rebuild(state.bundle);
            state.view.setImages(state.bundle.images);
        }

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

        const view = MapCore.create({ target: viewEl, bundle: state.bundle, editable: true });
        state.view = view;
        view.setImages(state.bundle.images);

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

        if (kind === "snap") {
            return new ol.style.Style({
                image: new ol.style.Circle({
                    radius: 8,
                    stroke: new ol.style.Stroke({ color: accent, width: 3 }),
                    fill: new ol.style.Fill({ color: "rgba(255,255,255,0.5)" })
                })
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

    // What a click at this coordinate should attach to: an existing corner, a
    // point on an existing border, or open ground.
    function snapAt(coordinate) {
        const vertex = nearestVertex(coordinate, SNAP_VERTEX_PX);
        if (vertex) {
            return { kind: "vertex", id: vertex.id, x: vertex.x, y: vertex.y };
        }
        const edge = nearestEdge(coordinate, SNAP_EDGE_PX);
        if (edge) {
            return { kind: "edge", x: edge.x, y: edge.y };
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
        select: "Click a state, shape or place to select it. Drag to pan; scroll to zoom.",
        land: "Click to add corners; double-click to finish. Hold Shift and drag to draw freehand.",
        lake: "Click to add corners; double-click to finish. Hold Shift and drag to draw freehand.",
        river: "Click to add points along the river; double-click to finish. Hold Shift and drag for freehand.",
        reshape: "Drag a corner to move it, drag an edge to add a corner, Alt-click a corner to remove it. Land, lakes and rivers snap to each other.",
        state: "Click corners. Clicking on a neighbour's border or corner shares it. Double-click or Enter to finish, Backspace to undo a corner, Esc to cancel.",
        borders: "Drag a corner (shared corners move for every state). Drop a corner on another to weld them. Double-click a border to add a corner; Alt-click a corner to remove it.",
        place: "Click the map to put a place there.",
        movePlace: "Click the map to move the place to that spot.",
        scale: "Click two points whose real distance you know, then enter it in miles."
    };

    const DRAWING_MODES = ["land", "lake", "river", "state", "place", "movePlace", "scale"];

    function setMode(mode) {
        cancelDrawing();
        stopInteractions();
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
            } else if (mode === "land" || mode === "lake" || mode === "river") {
                const draw = new ol.interaction.Draw({
                    source: new ol.source.Vector(), // the shape is saved and the map redrawn, so nothing is kept here
                    type: mode === "river" ? "LineString" : "Polygon",
                    freehandCondition: ol.events.condition.shiftKeyOnly,
                    style: (feature) => sketchStyle(new ol.Feature({ kind: "line" }))
                });
                draw.on("drawend", (event) => finishShape(mode, event.feature));
                addInteraction(draw);
                addInteraction(new ol.interaction.Snap({ source: view.sources.land }));
            } else if (mode === "reshape") {
                refreshModify();
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
            ...sources.land.getFeatures(), ...sources.lakes.getFeatures(), ...sources.rivers.getFeatures()
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
            await api("PUT", `/api/map-features/${feature.get("id")}`, { geometry: json });
            const stored = state.bundle.features.find((f) => f.id === feature.get("id"));
            if (stored) {
                stored.geometry = json;
            }
        });
    }

    async function finishShape(kind, feature) {
        const geometry = feature.getGeometry();
        const json = kind === "river"
            ? { type: "LineString", coordinates: geometry.getCoordinates() }
            : { type: "Polygon", coordinates: geometry.getCoordinates() };

        await guarded(async () => {
            const created = await api("POST", `/api/maps/${state.mapId}/features`, { kind, geometry: json });
            await load();
            selectObject({ type: "feature", id: created.id });
            say("Saved. Name it in the panel, or keep drawing.");
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
                state.view.vmap.set(dragging.id, [event.coordinate[0], event.coordinate[1]]);
                const feature = handleSource.getFeatureById(`v${dragging.id}`);
                if (feature) {
                    feature.getGeometry().setCoordinates(event.coordinate);
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
            case "select":
                selectObject(state.view.pick(event.pixel));
                break;
            case "reshape":
                break;
            case "state":
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
            finishState();
        } else if (state.mode === "borders") {
            event.preventDefault();
            addCorner(event.coordinate);
        }
    }

    function onPointerMove(event) {
        if (!state.view || event.dragging) {
            return;
        }
        if (state.mode === "state" || state.mode === "scale") {
            updateRubber(event.coordinate);
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
        state.draw = null;
        sketchSource.clear();
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

        if (snap.kind === "vertex") {
            point.id = snap.id;
        } else if (snap.kind === "edge") {
            // A corner on a neighbour's border has to exist on both sides, so make it now.
            const made = await guarded(() => api("POST", `/api/maps/${state.mapId}/vertices`, { x: snap.x, y: snap.y, snapEdge: true }));
            if (!made) {
                return;
            }
            point = { id: made.id, x: made.x, y: made.y };
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
        return queueDraw(finishStateNow);
    }

    async function finishStateNow() {
        const draw = state.draw;
        if (!draw) {
            return;
        }

        // Drop a repeated last corner (a double-click).
        const points = draw.points.filter((p, i) => i === 0 || !(p.x === draw.points[i - 1].x && p.y === draw.points[i - 1].y));
        if (points.length < 3) {
            say("A state needs at least three corners.", "error");
            return;
        }

        const ring = points.map((p) => (p.id ? { id: p.id } : { x: p.x, y: p.y }));
        const target = draw.target;
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
            return; // cancelled: nothing is saved
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

    function selectObject(selection) {
        state.selection = selection;
        if (state.view) {
            state.view.select(selection);
        }
        renderInspector();
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

        if (selection.type === "state") {
            const s = bundle.states.find((x) => x.id === selection.id);
            if (!s) {
                return;
            }
            const colorInput = bindSave(h("input", { type: "color", value: s.color }), (value) => api("PUT", `/api/map-states/${s.id}`, { color: value }));
            const sansInput = bindSave(h("input", { type: "checkbox", checked: Boolean(s.label_sans) }), (value) => api("PUT", `/api/map-states/${s.id}`, { label_sans: value }));
            const hiddenInput = hiddenField(s.hidden, (value) => guarded(async () => { await api("PUT", `/api/map-states/${s.id}`, { hidden: value }); await load(); }));

            add(inspectorEl, 
                h("h3", {}, "State"),
                field("Name", bindSave(h("input", { type: "text", value: s.name }), (value) => api("PUT", `/api/map-states/${s.id}`, { name: value }))),
                field("Color", colorInput),
                h("div", { class: "field check" }, sansInput, h("label", {}, "Name is a language word (sans-serif label)")),
                hiddenInput.element,
                s.page ? h("p", {}, h("a", { href: s.page.url, target: "_blank" }, "Open its lore page ↗")) : h("p", { class: "hint" }, "Its lore page has been detached."),
                h("div", { class: "row" },
                    h("button", { type: "button", onclick: () => zoomTo(s.id) }, "Zoom to"),
                    h("button", { type: "button", onclick: () => setMode("borders") }, "Edit borders"),
                    h("button", { type: "button", onclick: () => drawInto(s.id, "piece") }, "Add island"),
                    h("button", { type: "button", onclick: () => drawInto(s.id, "hole") }, "Add hole"),
                    h("button", { type: "button", class: "danger", onclick: () => deleteState(s) }, "Delete")));
            return;
        }

        if (selection.type === "feature") {
            const f = bundle.features.find((x) => x.id === selection.id);
            if (!f) {
                return;
            }
            const kindInput = f.kind === "river"
                ? null
                : bindSave(h("select", {},
                    h("option", { value: "land", selected: f.kind === "land" }, "Land"),
                    h("option", { value: "lake", selected: f.kind === "lake" }, "Lake")),
                (value) => api("PUT", `/api/map-features/${f.id}`, { kind: value }));
            const hiddenInput = hiddenField(f.hidden, (value) => guarded(async () => { await api("PUT", `/api/map-features/${f.id}`, { hidden: value }); await load(); }));

            add(inspectorEl, 
                h("h3", {}, f.kind === "river" ? "River" : f.kind === "lake" ? "Lake" : "Land"),
                field("Name (optional)", bindSave(h("input", { type: "text", value: f.name || "" }), (value) => api("PUT", `/api/map-features/${f.id}`, { name: value }))),
                kindInput ? field("Kind", kindInput) : null,
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

    async function deleteState(s) {
        const answer = await ask({
            title: `Delete “${s.name}”?`,
            okLabel: "Delete state",
            danger: true,
            fields: [{ key: "deletePage", type: "checkbox", label: "Also delete its lore page (otherwise the page is kept, as an ordinary page)", value: false }]
        });
        if (!answer) {
            return;
        }
        await guarded(async () => {
            await api("DELETE", `/api/map-states/${s.id}${answer.deletePage ? "?deletePage=1" : ""}`);
            selectObject(null);
            await load();
            say("State deleted.");
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
        let tracing = false;
        view.imageLayers.forEach((layer, index) => {
            const shown = state.layers.tracers && Boolean(state.bundle.images[index].visible);
            layer.setVisible(shown);
            tracing = tracing || shown;
        });
        view.setTracing(tracing);
    }

    const layersEl = h("div", { class: "box" });

    function renderLayers() {
        const names = [["tracers", "Tracer images"], ["land", "Land"], ["lakes", "Lakes"], ["rivers", "Rivers"], ["states", "States"], ["labels", "State names"], ["points", "Places"]];
        put(layersEl, 
            h("h3", {}, "Layers"),
            ...names.map(([key, label]) => h("div", { class: "field check" },
                h("input", { type: "checkbox", id: `layer-${key}`, checked: state.layers[key], onchange: (event) => {
                    state.layers[key] = event.target.checked;
                    applyLayerVisibility();
                } }),
                h("label", { for: `layer-${key}` }, label))));
    }

    // ------------------------------------------------------
    // The tool palette and the page
    // ------------------------------------------------------

    const toolsEl = h("div", { class: "box" });

    const TOOLS = [
        ["select", "Select"],
        ["land", "Draw land"],
        ["lake", "Draw lake"],
        ["river", "Draw river"],
        ["reshape", "Reshape shapes"],
        ["state", "Draw state"],
        ["borders", "Edit borders"],
        ["place", "Add place"],
        ["scale", "Set scale"]
    ];

    function renderTools() {
        const map = currentMap();
        put(toolsEl,
            h("h3", {}, "Tools"),
            h("div", { class: "tool-grid" }, ...TOOLS.map(([mode, label]) =>
                h("button", {
                    type: "button",
                    class: state.mode === mode ? "active" : "",
                    disabled: !map,
                    onclick: () => { state.drawTarget = null; setMode(mode); }
                }, label))),
            state.mode === "state" || state.mode === "borders"
                ? h("div", { class: "field check" },
                    h("input", { type: "checkbox", id: "follow", checked: state.followBorders, onchange: (event) => { state.followBorders = event.target.checked; } }),
                    h("label", { for: "follow" }, "Follow a neighbour's border between two shared corners"))
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
    }

    root.replaceChildren(
        h("div", { class: "map-side" }, mapBoxEl, toolsEl, layersEl, tracersEl, inspectorEl),
        h("div", { class: "map-main" }, viewEl, statusEl));

    document.addEventListener("keydown", (event) => {
        if (state.mode !== "state" || !state.draw || ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName)) {
            return;
        }
        if (event.key === "Enter") {
            event.preventDefault();
            finishState();
        } else if (event.key === "Escape") {
            cancelDrawing();
            say("Cancelled.");
        } else if (event.key === "Backspace") {
            event.preventDefault();
            state.draw.points.pop();
            renderSketch(null);
        }
    });

    window.addEventListener("beforeunload", () => sketchSource.clear());

    root.editorState = state; // for tests

    loadMaps()
        .then(() => load({ remount: true }))
        .catch((error) => say(error.message, "error"));
})();
