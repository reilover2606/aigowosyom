"use strict";

// How this instance runs, from environment variables:
//
//   MODE=editor (default)  read-write: the editors, the full API, and the
//                          Settings page with the Publish button.
//   MODE=public            read-only: no editor pages, no write endpoints; it
//                          only receives published databases (see
//                          lib/publish.js) when PUBLISH_TOKEN is set.
//   PORT, HOST             where to listen (HOST defaults to 127.0.0.1; put a
//                          public instance behind an HTTPS reverse proxy).
//   DATA_DIR               where the database and settings live (./data).
//   PUBLISH_TOKEN          the shared secret a public instance accepts.

const path = require("node:path");

const PUBLIC = process.env.MODE === "public";

module.exports = {
    PUBLIC,
    MODE: PUBLIC ? "public" : "editor",
    PORT: Number(process.env.PORT) || 3000,
    HOST: process.env.HOST || "127.0.0.1",
    DATA_DIR: path.resolve(process.env.DATA_DIR || path.join(__dirname, "..", "data")),
    PUBLISH_TOKEN: process.env.PUBLISH_TOKEN || ""
};
