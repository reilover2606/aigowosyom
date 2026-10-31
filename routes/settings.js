"use strict";

// Settings and publishing. Editor instances get the Settings page and the
// Publish button; a public instance only accepts uploads (when it has a
// PUBLISH_TOKEN).

const config = require("../lib/config");
const publisher = require("../lib/publish");
const settings = require("../lib/settings");
const { HttpError, sendJson, sendHtml, readJson } = require("../lib/http");
const { esc, layout } = require("../lib/render");

function page() {
    const body = `<main class="content settings-page">
    <h1>Settings</h1>

    <section class="panel settings-section">
        <h2>Publish to the public site</h2>
        <p class="muted">The public site is a second, read-only copy of this program running on another machine.
            Publishing sends it a copy of this database, without anything marked <strong>Do not publish</strong>.
            Nothing here changes while you publish, and publishing again replaces what is online.</p>

        <form id="settingsForm" autocomplete="off">
            <div class="field">
                <label for="publishUrl">Public site address</label>
                <input id="publishUrl" type="url" placeholder="https://example.org" spellcheck="false">
            </div>
            <div class="field">
                <label for="publishToken">Shared secret token <span class="hint" id="tokenState"></span></label>
                <div class="row">
                    <input id="publishToken" type="password" spellcheck="false" autocomplete="new-password">
                    <button type="button" id="tokenGenerate" title="Make a new random token">Generate</button>
                    <button type="button" id="tokenShow">Show</button>
                </div>
                <p class="hint-block">Use the same token on the public site, as its <code>PUBLISH_TOKEN</code> setting.
                    The token itself is never sent; uploads are signed with it. Leave the box empty to keep the saved token.</p>
            </div>
            <div class="form-actions">
                <button type="submit" id="settingsSave">Save settings</button>
                <span class="status" id="settingsStatus" role="status"></span>
            </div>
        </form>

        <h3>Publish</h3>
        <p id="publishSummary" class="muted">Checking what would be left out…</p>
        <div class="form-actions">
            <button type="button" class="primary" id="publishButton">Publish now</button>
            <span class="status" id="publishStatus" role="status"></span>
        </div>
    </section>
</main>`;

    return layout({
        title: "Settings",
        section: "site",
        bar: "settings",
        body,
        search: { q: "" },
        styles: ["/assets/dictionary/editor.css", "/assets/settings.css"],
        scripts: ["/assets/ui.js", "/assets/settings.js"]
    });
}

module.exports = async function settingsRoutes(req, res, url) {
    const { pathname } = url;

    // A public instance: uploads only.
    if (pathname === "/api/publish/receive") {
        if (!config.PUBLIC || req.method !== "POST") {
            throw new HttpError(config.PUBLIC ? 405 : 404, config.PUBLIC ? "Method not allowed" : "Not found");
        }
        await publisher.receive(req, res, sendJson);
        return true;
    }

    const mine = pathname === "/settings" || pathname === "/api/settings" || pathname.startsWith("/api/publish");
    if (!mine) {
        return false;
    }
    if (config.PUBLIC) {
        throw new HttpError(404, "Not found");
    }

    if (pathname === "/settings" && req.method === "GET") {
        sendHtml(res, 200, page());
        return true;
    }

    if (pathname === "/api/settings") {
        if (req.method === "GET") {
            sendJson(res, 200, settings.publicView());
            return true;
        }
        if (req.method === "PUT") {
            sendJson(res, 200, settings.save(await readJson(req)));
            return true;
        }
    }

    // What a publish would leave out right now.
    if (pathname === "/api/publish/summary" && req.method === "GET") {
        sendJson(res, 200, publisher.hiddenSummary());
        return true;
    }

    if (pathname === "/api/publish" && req.method === "POST") {
        sendJson(res, 200, await publisher.publish());
        return true;
    }

    throw new HttpError(405, "Method not allowed");
};
