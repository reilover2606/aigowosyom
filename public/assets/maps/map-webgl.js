// A WebGL drawer for the map's shapes, written for this project (no map library's projections).
//
// The map's content still lives in OpenLayers vector sources: they keep the shapes, take the
// clicks and run the editing tools. This file only *draws* the shapes (land, lakes, rivers, state
// fills, dotted borders and superstate outlines) on the graphics card, as OpenLayers custom
// layers, so the rest of the page (names, places, elevation, tracer images, the sketch of what is
// being drawn) is unchanged. Map-core.js decides which of the two drawers is used.
//
//  * Fills: no triangulation. Each shape's outline is drawn as a fan of triangles into the stencil
//    buffer with "invert" (so holes and overlaps come out right by even-odd counting), then one
//    rectangle over the shape's bounding box is painted where the stencil is set.
//  * Lines: each segment is one instanced rectangle; the fragment shader works out the distance to
//    the segment, which gives round caps and joins, anti-aliasing and (for the borders) round dots
//    placed by the distance along the line.
(() => {
    "use strict";

    function supported() {
        try {
            const canvas = document.createElement("canvas");
            return Boolean(canvas.getContext("webgl2", { stencil: true }));
        } catch (error) {
            return false;
        }
    }

    // ---- colors: any CSS color to premultiplied floats ----
    const colorCache = new Map();
    let probe = null;

    function rgba(css) {
        let value = colorCache.get(css);
        if (value) {
            return value;
        }
        if (!probe) {
            probe = document.createElement("canvas");
            probe.width = probe.height = 1;
            probe = probe.getContext("2d", { willReadFrequently: true });
        }
        probe.clearRect(0, 0, 1, 1);
        probe.fillStyle = "#000";
        probe.fillStyle = css;
        probe.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
        const alpha = a / 255;
        // getImageData returns un-premultiplied bytes; the blending here is premultiplied.
        value = [(r / 255) * alpha, (g / 255) * alpha, (b / 255) * alpha, alpha];
        if (colorCache.size > 500) {
            colorCache.clear();
        }
        colorCache.set(css, value);
        return value;
    }

    // ---- shaders ----
    const FILL_VS = `#version 300 es
in vec2 aPos;
uniform vec2 uCenter;
uniform float uRes;
uniform vec2 uSize;
void main() {
    gl_Position = vec4((aPos - uCenter) / uRes * 2.0 / uSize, 0.0, 1.0);
}`;

    const FILL_FS = `#version 300 es
precision highp float;
uniform vec4 uColor;
out vec4 outColor;
void main() {
    outColor = uColor;
}`;

    // One instance per segment: aSeg = (x0, y0, x1, y1) in map units, aDist = length of the line
    // before this segment. The quad is wider than the line (half the width plus a pixel to
    // anti-alias in) and grows past both ends by the same amount, for the round caps.
    const LINE_VS = `#version 300 es
in vec2 aCorner;
in vec4 aSeg;
in float aDist;
uniform vec2 uCenter;
uniform float uRes;
uniform vec2 uSize;
uniform float uWidth;
out vec2 vAlong;      // x: distance along the segment (px), y: across it (px)
out float vLength;    // the segment's length (px)
out float vStart;     // the line's length before the segment (px)
void main() {
    vec2 a = (aSeg.xy - uCenter) / uRes;
    vec2 b = (aSeg.zw - uCenter) / uRes;
    vec2 delta = b - a;
    float len = length(delta);
    vec2 dir = len > 0.0001 ? delta / len : vec2(1.0, 0.0);
    vec2 normal = vec2(-dir.y, dir.x);
    float reach = uWidth * 0.5 + 1.0;
    float t = (aCorner.x + 1.0) * 0.5;
    vec2 pos = mix(a, b, t) + dir * aCorner.x * reach + normal * aCorner.y * reach;
    vAlong = vec2(dot(pos - a, dir), dot(pos - a, normal));
    vLength = len;
    vStart = aDist / uRes;
    gl_Position = vec4(pos * 2.0 / uSize, 0.0, 1.0);
}`;

    const LINE_FS = `#version 300 es
precision highp float;
in vec2 vAlong;
in float vLength;
in float vStart;
uniform float uWidth;
uniform vec4 uColor;
uniform vec2 uDots;   // spacing and radius of round dots in px, or (0, 0) for a solid line
out vec4 outColor;
void main() {
    float coverage;
    if (uDots.x > 0.0) {
        float local = mod(vStart + vAlong.x, uDots.x);
        float near = local > uDots.x * 0.5 ? local - uDots.x : local;
        float d = length(vec2(near, vAlong.y));
        coverage = clamp(uDots.y - d + 0.5, 0.0, 1.0);
    } else {
        float x = vAlong.x < 0.0 ? -vAlong.x : (vAlong.x > vLength ? vAlong.x - vLength : 0.0);
        float d = length(vec2(x, vAlong.y));
        coverage = clamp(uWidth * 0.5 - d + 0.5, 0.0, 1.0);
    }
    if (coverage <= 0.0) {
        discard;
    }
    outColor = uColor * coverage;
}`;

    function compile(gl, type, source) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            throw new Error(gl.getShaderInfoLog(shader));
        }
        return shader;
    }

    function program(gl, vs, fs) {
        const p = gl.createProgram();
        gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
        gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
            throw new Error(gl.getProgramInfoLog(p));
        }
        const uniforms = {};
        const count = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
        for (let i = 0; i < count; i++) {
            const name = gl.getActiveUniform(p, i).name;
            uniforms[name] = gl.getUniformLocation(p, name);
        }
        return { p, uniforms, attribute: (name) => gl.getAttribLocation(p, name) };
    }

    // ---- one drawing surface, with its groups of shapes ----
    // groups: [{ name, source, fills: Boolean, strokes: Boolean, style(feature) -> { fill?, stroke?: { color, width, dots? } } }]
    const stats = { renders: 0, milliseconds: 0 };

    class Surface {
        constructor(groups) {
            this.groups = groups.map((g) => ({ ...g, revision: -1, entries: [], enabled: true, fanBuffer: null, lineBuffer: null }));
            this.canvas = document.createElement("canvas");
            this.canvas.style.position = "absolute";
            this.canvas.style.left = "0";
            this.canvas.style.top = "0";
            this.canvas.style.pointerEvents = "none";
            this.gl = this.canvas.getContext("webgl2", { stencil: true, antialias: true, alpha: true, premultipliedAlpha: true });
            this.lost = !this.gl;
            if (this.lost) {
                return;
            }
            const gl = this.gl;
            this.fill = program(gl, FILL_VS, FILL_FS);
            this.line = program(gl, LINE_VS, LINE_FS);

            this.corners = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, this.corners);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

            this.canvas.addEventListener("webglcontextlost", (event) => {
                event.preventDefault();
                this.lost = true;
            });
            this.canvas.addEventListener("webglcontextrestored", () => {
                this.lost = false;
                for (const g of this.groups) {
                    g.revision = -1;
                }
                this.fill = program(gl, FILL_VS, FILL_FS);
                this.line = program(gl, LINE_VS, LINE_FS);
                this.corners = gl.createBuffer();
                gl.bindBuffer(gl.ARRAY_BUFFER, this.corners);
                gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
            });
        }

        // Reads a group's shapes from its OpenLayers source into buffers.
        build(group) {
            const gl = this.gl;
            const fan = [];
            const segs = [];
            const entries = [];

            const polygonsOf = (geometry) => {
                const type = geometry.getType();
                if (type === "Polygon") {
                    return [geometry.getCoordinates()];
                }
                return type === "MultiPolygon" ? geometry.getCoordinates() : [];
            };

            const addChain = (chain, box) => {
                let dist = 0;
                for (let i = 0; i < chain.length - 1; i++) {
                    const [x0, y0] = chain[i];
                    const [x1, y1] = chain[i + 1];
                    segs.push(x0, y0, x1, y1, dist);
                    dist += Math.hypot(x1 - x0, y1 - y0);
                    box[0] = Math.min(box[0], x0, x1);
                    box[1] = Math.min(box[1], y0, y1);
                    box[2] = Math.max(box[2], x0, x1);
                    box[3] = Math.max(box[3], y0, y1);
                }
            };

            for (const feature of group.source.getFeatures()) {
                const geometry = feature.getGeometry();
                if (!geometry) {
                    continue;
                }
                const box = [Infinity, Infinity, -Infinity, -Infinity];
                const entry = { feature, box, fanStart: 0, fanCount: 0, coverStart: 0, segStart: segs.length / 5, segCount: 0 };

                const polygons = polygonsOf(geometry);
                if (polygons.length) {
                    entry.fanStart = fan.length / 2;
                    for (const rings of polygons) {
                        const origin = rings[0][0];
                        for (const ring of rings) {
                            for (let i = 0; i < ring.length - 1; i++) {
                                fan.push(origin[0], origin[1], ring[i][0], ring[i][1], ring[i + 1][0], ring[i + 1][1]);
                            }
                            for (const [x, y] of ring) {
                                box[0] = Math.min(box[0], x);
                                box[1] = Math.min(box[1], y);
                                box[2] = Math.max(box[2], x);
                                box[3] = Math.max(box[3], y);
                            }
                            if (group.strokes) {
                                addChain(ring, box);
                            }
                        }
                    }
                    entry.fanCount = fan.length / 2 - entry.fanStart;
                    entry.coverStart = fan.length / 2;
                    fan.push(box[0], box[1], box[2], box[1], box[0], box[3], box[2], box[1], box[2], box[3], box[0], box[3]);
                } else if (geometry.getType() === "LineString") {
                    addChain(geometry.getCoordinates(), box);
                } else if (geometry.getType() === "MultiLineString") {
                    for (const chain of geometry.getCoordinates()) {
                        addChain(chain, box);
                    }
                } else {
                    continue;
                }
                entry.segCount = segs.length / 5 - entry.segStart;
                entries.push(entry);
            }

            if (!group.fanBuffer) {
                group.fanBuffer = gl.createBuffer();
                group.lineBuffer = gl.createBuffer();
            }
            gl.bindBuffer(gl.ARRAY_BUFFER, group.fanBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(fan), gl.STATIC_DRAW);
            gl.bindBuffer(gl.ARRAY_BUFFER, group.lineBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(segs), gl.STATIC_DRAW);
            group.entries = entries;
            group.revision = group.source.getRevision();
        }

        drawFill(group, entry, color, view) {
            const gl = this.gl;
            const f = this.fill;
            gl.useProgram(f.p);
            gl.uniform2f(f.uniforms.uCenter, view.center[0], view.center[1]);
            gl.uniform1f(f.uniforms.uRes, view.resolution);
            gl.uniform2f(f.uniforms.uSize, view.size[0], view.size[1]);
            gl.bindBuffer(gl.ARRAY_BUFFER, group.fanBuffer);
            const at = f.attribute("aPos");
            gl.enableVertexAttribArray(at);
            gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0);
            gl.vertexAttribDivisor(at, 0);

            // 1. Count, in the stencil buffer, how often each pixel is inside the outline.
            gl.enable(gl.STENCIL_TEST);
            gl.colorMask(false, false, false, false);
            gl.stencilFunc(gl.ALWAYS, 0, 1);
            gl.stencilOp(gl.KEEP, gl.KEEP, gl.INVERT);
            gl.drawArrays(gl.TRIANGLES, entry.fanStart, entry.fanCount);

            // 2. Paint the bounding box where the count is odd, and reset the stencil as it goes.
            gl.colorMask(true, true, true, true);
            gl.stencilFunc(gl.NOTEQUAL, 0, 1);
            gl.stencilOp(gl.ZERO, gl.ZERO, gl.ZERO);
            gl.uniform4fv(f.uniforms.uColor, color);
            gl.drawArrays(gl.TRIANGLES, entry.coverStart, 6);
            gl.disable(gl.STENCIL_TEST);
        }

        drawLines(group, entry, stroke, view) {
            const gl = this.gl;
            const l = this.line;
            gl.useProgram(l.p);
            gl.uniform2f(l.uniforms.uCenter, view.center[0], view.center[1]);
            gl.uniform1f(l.uniforms.uRes, view.resolution);
            gl.uniform2f(l.uniforms.uSize, view.size[0], view.size[1]);
            gl.uniform1f(l.uniforms.uWidth, stroke.width);
            gl.uniform4fv(l.uniforms.uColor, rgba(stroke.color));
            gl.uniform2f(l.uniforms.uDots, stroke.dots ? stroke.dots[0] : 0, stroke.dots ? stroke.dots[1] : 0);

            const corner = l.attribute("aCorner");
            gl.bindBuffer(gl.ARRAY_BUFFER, this.corners);
            gl.enableVertexAttribArray(corner);
            gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);
            gl.vertexAttribDivisor(corner, 0);

            const seg = l.attribute("aSeg");
            const dist = l.attribute("aDist");
            gl.bindBuffer(gl.ARRAY_BUFFER, group.lineBuffer);
            const stride = 20;
            const base = entry.segStart * stride;
            gl.enableVertexAttribArray(seg);
            gl.vertexAttribPointer(seg, 4, gl.FLOAT, false, stride, base);
            gl.vertexAttribDivisor(seg, 1);
            gl.enableVertexAttribArray(dist);
            gl.vertexAttribPointer(dist, 1, gl.FLOAT, false, stride, base + 16);
            gl.vertexAttribDivisor(dist, 1);
            gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, entry.segCount);
            gl.vertexAttribDivisor(seg, 0);
            gl.vertexAttribDivisor(dist, 0);
        }

        // The OpenLayers layer's render function.
        render(frameState) {
            const began = performance.now();
            const [width, height] = frameState.size;
            const ratio = frameState.pixelRatio || 1;
            const canvas = this.canvas;
            if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
                canvas.width = Math.round(width * ratio);
                canvas.height = Math.round(height * ratio);
                canvas.style.width = `${width}px`;
                canvas.style.height = `${height}px`;
            }
            if (this.lost) {
                return canvas;
            }

            const gl = this.gl;
            gl.viewport(0, 0, canvas.width, canvas.height);
            gl.clearColor(0, 0, 0, 0);
            gl.clearStencil(0);
            gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

            const view = { center: frameState.viewState.center, resolution: frameState.viewState.resolution, size: [width, height] };
            const half = [(width * view.resolution) / 2, (height * view.resolution) / 2];
            const seen = [view.center[0] - half[0], view.center[1] - half[1], view.center[0] + half[0], view.center[1] + half[1]];

            for (const group of this.groups) {
                if (!group.enabled) {
                    continue;
                }
                if (group.revision !== group.source.getRevision()) {
                    this.build(group);
                }
                for (const entry of group.entries) {
                    const style = group.style(entry.feature);
                    if (!style) {
                        continue;
                    }
                    // Left out when it is wholly off screen (with room for a thick line).
                    const margin = (style.stroke ? style.stroke.width : 0) * view.resolution;
                    const box = entry.box;
                    if (box[2] + margin < seen[0] || box[0] - margin > seen[2] || box[3] + margin < seen[1] || box[1] - margin > seen[3]) {
                        continue;
                    }
                    if (style.fill && entry.fanCount > 0) {
                        this.drawFill(group, entry, rgba(style.fill), view);
                    }
                    if (style.stroke && entry.segCount > 0) {
                        this.drawLines(group, entry, style.stroke, view);
                    }
                }
            }
            stats.renders++;
            stats.milliseconds += performance.now() - began; // time spent issuing the drawing (not the card's)
            return canvas;
        }
    }

    // The three layers (bottom to top: land, lakes, then rivers + states + borders + outlines), so the
    // elevation image can sit between the land and the lakes as it does with the other drawer.
    // `deps`: { ol, sources, colors, selectedIs, fillOf, hexAlpha, marked() }.
    function create(deps) {
        const { ol, sources, colors, selectedIs, fillOf, hexAlpha, marked } = deps;

        const surfaces = {
            land: new Surface([{
                name: "land", source: sources.land, fills: true, strokes: true,
                style: (feature) => {
                    const chosen = selectedIs("feature", feature.get("id"));
                    return { fill: fillOf(colors.land), stroke: { color: chosen ? colors.accent : colors.coast, width: chosen ? 3 : 1.5 } };
                }
            }]),
            lakes: new Surface([{
                name: "lakes", source: sources.lakes, fills: true, strokes: true,
                style: (feature) => {
                    const chosen = selectedIs("feature", feature.get("id"));
                    return { fill: fillOf(colors.lake), stroke: { color: chosen ? colors.accent : colors.coast, width: chosen ? 3 : 1 } };
                }
            }]),
            shapes: new Surface([
                {
                    name: "rivers", source: sources.rivers, fills: false, strokes: true,
                    style: (feature) => {
                        const chosen = selectedIs("feature", feature.get("id"));
                        return { stroke: { color: chosen ? colors.accent : colors.river, width: chosen ? 4 : 2.5 } };
                    }
                },
                {
                    name: "states", source: sources.states, fills: true, strokes: false,
                    style: (feature) => ({ fill: hexAlpha(feature.get("color"), marked().has(feature.get("id")) ? 0.42 : 0.2) })
                },
                {
                    name: "borders", source: sources.borders, fills: false, strokes: true,
                    style: () => ({ stroke: { color: colors.border, width: 2.5, dots: [6.5, 1.25] } })
                },
                {
                    name: "outlines", source: sources.outlines, fills: false, strokes: true,
                    style: (feature) => ({
                        stroke: {
                            color: hexAlpha(feature.get("color"), 0.95),
                            width: selectedIs("state", feature.get("groupId")) ? 6 : Math.max(2.5, 4.5 - feature.get("depth") * 1.5)
                        }
                    })
                }
            ])
        };

        const zIndexes = { land: 2, lakes: 3, shapes: 3.9 };
        const layers = Object.entries(surfaces).map(([name, surface]) => new ol.layer.Layer({
            zIndex: zIndexes[name],
            render: (frameState) => surface.render(frameState)
        }));

        // The first context that fails to start means WebGL is not usable here.
        const working = Object.values(surfaces).every((s) => !s.lost);

        const groupOf = new Map();
        for (const surface of Object.values(surfaces)) {
            for (const group of surface.groups) {
                groupOf.set(group.name, group);
            }
        }

        return {
            layers,
            working,
            // Which shapes are drawn (by group name): all, or only those given.
            setShown(shown) {
                for (const [name, group] of groupOf) {
                    group.enabled = shown[name] !== false;
                }
            },
            changed() {
                layers.forEach((l) => l.changed());
            }
        };
    }

    window.MapGL = { supported, create, stats };
})();
