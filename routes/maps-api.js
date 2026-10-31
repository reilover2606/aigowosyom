"use strict";

// Maps API. Reads are public; everything that writes is refused on a public
// instance before it gets here (see server.js).

const fs = require("node:fs");
const maps = require("../lib/maps");
const config = require("../lib/config");
const { HttpError, sendJson, readJson, readBuffer, parseInteger } = require("../lib/http");

const MAX_IMAGE_BYTES = 120 * 1024 * 1024;

module.exports = async function mapsApi(req, res, url) {
    const parts = url.pathname.split("/").filter(Boolean); // ["api", "maps", ...]
    if (parts[0] !== "api" || !["maps", "map-features", "map-vertices", "map-states", "map-points", "map-images"].includes(parts[1])) {
        return false;
    }

    const method = req.method;
    const [, resource, rawId, sub, rawSub] = parts;
    const id = rawId === undefined ? null : parseInteger(rawId, "id");

    const send = (status, data) => {
        sendJson(res, status, data);
        return true;
    };

    // ---- Maps -------------------------------------------------------
    if (resource === "maps") {
        if (parts.length === 2) {
            if (method === "GET") {
                return send(200, maps.listMaps());
            }
            if (method === "POST") {
                return send(201, maps.createMap(await readJson(req)));
            }
        }

        if (parts.length === 3) {
            if (method === "GET") {
                return send(200, maps.bundle(id, { editor: !config.PUBLIC }));
            }
            if (method === "PUT") {
                return send(200, maps.updateMap(id, await readJson(req)));
            }
            if (method === "DELETE") {
                maps.deleteMap(id, { deletePages: url.searchParams.get("deletePages") === "1" });
                return send(200, { ok: true });
            }
        }

        if (parts.length >= 4 && method === "POST") {
            if (sub === "features" && parts.length === 4) {
                return send(201, maps.createFeature(id, await readJson(req)));
            }
            if (sub === "states" && parts.length === 4) {
                return send(201, maps.createState(id, await readJson(req)));
            }
            if (sub === "states" && rawSub === "group" && parts.length === 5) {
                return send(201, maps.groupStates(id, await readJson(req)));
            }
            if (sub === "states" && rawSub === "ungroup" && parts.length === 5) {
                const data = await readJson(req);
                return send(200, maps.ungroupStates(id, data && data.ids));
            }
            if (sub === "points" && parts.length === 4) {
                return send(201, maps.createPoint(id, await readJson(req)));
            }
            if (sub === "vertices" && parts.length === 4) {
                return send(201, maps.addVertex(id, await readJson(req)));
            }
            if (sub === "vertices" && rawSub === "move" && parts.length === 5) {
                maps.moveVertices(id, await readJson(req));
                return send(200, { ok: true });
            }
            if (sub === "images" && parts.length === 4) {
                const mime = String(req.headers["content-type"] || "").split(";")[0].trim();
                const buffer = await readBuffer(req, MAX_IMAGE_BYTES);
                return send(201, maps.addImage(id, buffer, mime, url.searchParams.get("name")));
            }
        }
    }

    // ---- Shapes, corners, states, points, images ------------------------
    if (parts.length === 3) {
        const handlers = {
            "map-features": { PUT: (d) => maps.updateFeature(id, d), DELETE: () => maps.deleteFeature(id) },
            "map-vertices": { DELETE: () => maps.deleteVertex(id) },
            "map-states": {
                PUT: (d) => maps.updateState(id, d),
                DELETE: () => maps.deleteState(id, { deletePage: url.searchParams.get("deletePage") === "1" })
            },
            "map-points": { PUT: (d) => maps.updatePoint(id, d), DELETE: () => maps.deletePoint(id) },
            "map-images": { PUT: (d) => maps.updateImage(id, d), DELETE: () => maps.deleteImage(id) }
        }[resource];

        if (handlers && handlers[method]) {
            const result = await handlers[method](method === "PUT" ? await readJson(req) : undefined);
            return send(200, result === undefined ? { ok: true } : result);
        }
    }

    // POST /api/map-states/:id/members  { ids }  (add states to a superstate)
    if (resource === "map-states" && sub === "members" && parts.length === 4 && method === "POST") {
        const data = await readJson(req);
        return send(200, maps.addToGroup(id, data && data.ids));
    }

    // POST /api/map-vertices/:id/merge  { into }
    if (resource === "map-vertices" && sub === "merge" && parts.length === 4 && method === "POST") {
        const data = await readJson(req);
        maps.mergeVertices(id, parseInteger(data && data.into, "corner"));
        return send(200, { ok: true });
    }

    // GET /api/map-images/:id/file (the tracer image itself; editor only)
    if (resource === "map-images" && sub === "file" && parts.length === 4 && method === "GET") {
        const file = config.PUBLIC ? null : maps.imageFile(id);
        if (!file || !fs.existsSync(file.path)) {
            throw new HttpError(404, "Not found");
        }
        res.writeHead(200, { "Content-Type": file.mime, "Cache-Control": "private, max-age=60" });
        fs.createReadStream(file.path).pipe(res);
        return true;
    }

    throw new HttpError(405, "Method not allowed");
};
