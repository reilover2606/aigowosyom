// The map itself, shared by the public viewer and the editor (window.MapCore).
//
// A map is a flat plane of "map units" (not a geographic projection):
// x runs right and y runs up, over [0, width] x [0, height]. The bundle from
// /api/maps/:id says what is on it. Colors come from CSS variables
// (--map-*, see maps.css), so every theme restyles the map; labels use the
// site's serif and sans fonts.
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
    // Building a map view
    // ------------------------------------------------------

    function create({ target, bundle, editable = false }) {
        const view = { editable, bundle: null, vmap: null, selected: null, marked: new Set(), children: new Map(), listeners: {} };
        const map = bundle.map;
        let extent = [0, 0, map.width, map.height];

        const projection = new ol.proj.Projection({ code: `map-${map.id}`, units: "pixels", extent: [-1e7, -1e7, 1e7, 1e7] });

        const sources = {
            sea: new ol.source.Vector(),
            land: new ol.source.Vector(),
            lakes: new ol.source.Vector(),
            rivers: new ol.source.Vector(),
            states: new ol.source.Vector(),
            borders: new ol.source.Vector(),
            outlines: new ol.source.Vector(),
            labels: new ol.source.Vector(),
            points: new ol.source.Vector()
        };
        view.sources = sources;

        const selectedIs = (type, id) => view.selected && view.selected.type === type && view.selected.id === id;

        // ---- styles ----
        const seaStyle = () => new ol.style.Style({ fill: new ol.style.Fill({ color: colors.sea }) });
        // While a tracer image is showing (editor), land and lakes let it show through.
        const fillOf = (color) => (view.tracing ? hexAlpha(color, 0.4) : color);
        const landStyle = (feature) => new ol.style.Style({
            fill: new ol.style.Fill({ color: fillOf(colors.land) }),
            stroke: new ol.style.Stroke({
                color: selectedIs("feature", feature.get("id")) ? colors.accent : colors.coast,
                width: selectedIs("feature", feature.get("id")) ? 3 : 1.5,
                lineJoin: "round"
            })
        });
        const lakeStyle = (feature) => new ol.style.Style({
            fill: new ol.style.Fill({ color: fillOf(colors.lake) }),
            stroke: new ol.style.Stroke({
                color: selectedIs("feature", feature.get("id")) ? colors.accent : colors.coast,
                width: selectedIs("feature", feature.get("id")) ? 3 : 1,
                lineJoin: "round"
            })
        });
        const riverStyle = (feature) => new ol.style.Style({
            stroke: new ol.style.Stroke({
                color: selectedIs("feature", feature.get("id")) ? colors.accent : colors.river,
                width: selectedIs("feature", feature.get("id")) ? 4 : 2.5,
                lineCap: "round",
                lineJoin: "round"
            })
        });
        const stateStyle = (feature) => new ol.style.Style({
            fill: new ol.style.Fill({ color: hexAlpha(feature.get("color"), view.marked.has(feature.get("id")) ? 0.42 : 0.2) })
        });
        // The outline of a superstate, heavier than the dots between its clients.
        const outlineStyle = (feature) => new ol.style.Style({
            stroke: new ol.style.Stroke({
                color: hexAlpha(feature.get("color"), 0.95),
                width: selectedIs("state", feature.get("groupId")) ? 6 : Math.max(2.5, 4.5 - feature.get("depth") * 1.5),
                lineJoin: "round",
                lineCap: "round"
            })
        });
        const borderStyle = () => new ol.style.Style({
            stroke: new ol.style.Stroke({
                color: colors.border,
                width: 2,
                lineDash: [0.5, 6], // round dots
                lineCap: "round"
            })
        });
        const labelStyle = (feature, resolution) => {
            const name = feature.get("name");
            const onScreen = feature.get("span") / resolution;

            // A superstate's name is for the wider view: it gives way once the
            // map is zoomed in far enough to be showing its clients.
            if (feature.get("group")) {
                if (onScreen < name.length * 6 || onScreen > 1100) {
                    return null;
                }
                return new ol.style.Style({
                    zIndex: 10,
                    text: new ol.style.Text({
                        text: name.toUpperCase(),
                        font: `bold 19px ${feature.get("sans") ? colors.sans : colors.serif}`,
                        fill: new ol.style.Fill({ color: colors.label }),
                        stroke: new ol.style.Stroke({ color: colors.halo, width: 5 }),
                        overflow: true
                    })
                });
            }

            // Hide the name of a state too small on screen to hold it.
            if (onScreen < name.length * 5) {
                return null;
            }
            return new ol.style.Style({
                text: new ol.style.Text({
                    text: name,
                    font: `bold 15px ${feature.get("sans") ? colors.sans : colors.serif}`,
                    fill: new ol.style.Fill({ color: colors.label }),
                    stroke: new ol.style.Stroke({ color: colors.halo, width: 4 }),
                    overflow: true
                })
            });
        };
        const pointStyle = (feature) => {
            const chosen = selectedIs("point", feature.get("id"));
            return new ol.style.Style({
                image: new ol.style.Circle({
                    radius: chosen ? 8 : 5.5,
                    fill: new ol.style.Fill({ color: chosen ? colors.accent : colors.point }),
                    stroke: new ol.style.Stroke({ color: "#ffffff", width: 2 })
                }),
                text: new ol.style.Text({
                    text: feature.get("name"),
                    font: `13px ${colors.serif}`,
                    offsetY: -16,
                    fill: new ol.style.Fill({ color: colors.label }),
                    stroke: new ol.style.Stroke({ color: colors.halo, width: 4 }),
                    overflow: false
                })
            });
        };

        // Bottom to top: sea, tracer images (z-index 1), land, lakes, rivers, states, borders, names, places.
        const layer = (source, style, zIndex, extra = {}) => new ol.layer.Vector({ source, style, zIndex, ...extra });
        view.layers = {
            sea: layer(sources.sea, seaStyle, 0),
            land: layer(sources.land, landStyle, 2),
            lakes: layer(sources.lakes, lakeStyle, 3),
            rivers: layer(sources.rivers, riverStyle, 4),
            states: layer(sources.states, stateStyle, 5),
            borders: layer(sources.borders, borderStyle, 6),
            outlines: layer(sources.outlines, outlineStyle, 6.5),
            labels: layer(sources.labels, labelStyle, 7, { declutter: true }),
            points: layer(sources.points, pointStyle, 8, { declutter: true })
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
            interactions: editable
                ? ol.interaction.defaults.defaults({ doubleClickZoom: false, altShiftDragRotate: false, pinchRotate: false })
                : ol.interaction.defaults.defaults({ altShiftDragRotate: false, pinchRotate: false })
        });
        view.ol = olMap;
        view.olView = olView;
        view.projection = projection;

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
                const target = f.kind === "land" ? sources.land : f.kind === "lake" ? sources.lakes : sources.rivers;
                const feature = new ol.Feature({ geometry: geometryOf(f.geometry), id: f.id, kind: f.kind, name: f.name });
                feature.setId(`feature-${f.id}`);
                target.addFeature(feature);
            }

            rebuildStates();

            for (const p of next.points) {
                const feature = new ol.Feature({ geometry: new ol.geom.Point([p.x, p.y]), id: p.id, name: p.name, kind: p.kind });
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
                const feature = new ol.Feature({ geometry, id: s.id, name: s.name, color: s.color, sans: s.label_sans });
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
                    id: s.id, name: s.name, sans: s.label_sans, span: box[2] - box[0]
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
                        id: group.id, name: group.name, sans: group.label_sans, span: box[2] - box[0], group: true
                    }));
                }
            }
        }

        function repaint() {
            for (const l of Object.values(view.layers)) {
                l.changed();
            }
        }

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
            let found = null;
            olMap.forEachFeatureAtPixel(
                pixel,
                (feature, source) => {
                    if (feature.get("id") === undefined || found) {
                        return;
                    }
                    const layerKind = source === view.layers.points ? "point"
                        : source === view.layers.states ? "state"
                        : (source === view.layers.land || source === view.layers.lakes || source === view.layers.rivers) ? "feature" : null;
                    if (layerKind) {
                        found = { type: layerKind, id: feature.get("id") };
                    }
                },
                { hitTolerance: 4, layerFilter: (l) => l === view.layers.points || (editable ? true : l === view.layers.states) }
            );
            return found;
        };

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

        view.show = (name, visible) => view.layers[name].setVisible(visible);

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

    window.MapCore = { create, colors, readColors, hexAlpha, stateCoordinates, vertexMap, stateTree };
})();
