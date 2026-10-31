// The Settings page: where the public site lives, and the Publish button.
(() => {
    "use strict";

    const { api } = window.UI;
    const $ = (id) => document.getElementById(id);

    const form = $("settingsForm");
    const urlInput = $("publishUrl");
    const tokenInput = $("publishToken");
    const tokenState = $("tokenState");
    const saveStatus = $("settingsStatus");
    const publishButton = $("publishButton");
    const publishStatus = $("publishStatus");
    const summary = $("publishSummary");

    function say(el, message, kind = "") {
        el.textContent = message;
        el.className = `status ${kind}`.trim();
    }

    function plural(n, one, many) {
        return `${n} ${n === 1 ? one : many}`;
    }

    function showSettings(data) {
        urlInput.value = data.publishUrl || "";
        tokenInput.value = "";
        tokenState.textContent = data.tokenSet ? "— a token is saved" : "— none saved yet";
        publishButton.disabled = !(data.publishUrl && data.tokenSet);
        publishButton.title = publishButton.disabled ? "Save the address and a token first" : "";
    }

    // "Left out: 2 notes, 1 lore page ..." (hiding a category or language
    // takes the pages or words inside it along).
    function describe(counts) {
        const parts = [
            [counts.languages, "language", "languages"],
            [counts.words, "dictionary entry", "dictionary entries"],
            [counts.loreCategories, "lore category", "lore categories"],
            [counts.lorePages, "lore page", "lore pages"],
            [counts.notes, "calendar note", "calendar notes"]
        ].filter(([n]) => n > 0).map(([n, one, many]) => plural(n, one, many));

        return parts.length
            ? `Marked “Do not publish” and left out: ${parts.join(", ")}.`
            : "Nothing is marked “Do not publish”, so everything will be published.";
    }

    async function refreshSummary() {
        try {
            summary.textContent = describe(await api("GET", "/api/publish/summary"));
        } catch (error) {
            summary.textContent = "";
        }
    }

    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        say(saveStatus, "Saving…");

        try {
            const data = { publishUrl: urlInput.value };
            if (tokenInput.value.trim()) {
                data.token = tokenInput.value;
            }
            showSettings(await api("PUT", "/api/settings", data));
            say(saveStatus, "Saved.", "ok");
        } catch (error) {
            say(saveStatus, error.message, "error");
        }
    });

    $("tokenGenerate").addEventListener("click", () => {
        const bytes = crypto.getRandomValues(new Uint8Array(32));
        tokenInput.value = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
        tokenInput.type = "text"; // shown so it can be copied to the public site
        $("tokenShow").textContent = "Hide";
        say(saveStatus, "New token made. Save settings to keep it, and copy it to the public site.");
    });

    $("tokenShow").addEventListener("click", (event) => {
        const showing = tokenInput.type === "text";
        tokenInput.type = showing ? "password" : "text";
        event.currentTarget.textContent = showing ? "Show" : "Hide";
    });

    publishButton.addEventListener("click", async () => {
        publishButton.disabled = true;
        say(publishStatus, "Publishing…");

        try {
            const result = await api("POST", "/api/publish");
            const kb = Math.max(1, Math.round(result.bytes / 1024));
            say(publishStatus, `Published (${kb} KB sent) at ${new Date(result.publishedAt).toLocaleTimeString()}. The public site restarts for a moment.`, "ok");
        } catch (error) {
            say(publishStatus, error.message, "error");
        } finally {
            publishButton.disabled = false;
            refreshSummary();
        }
    });

    api("GET", "/api/settings").then(showSettings).catch((error) => say(saveStatus, error.message, "error"));
    refreshSummary();
})();
