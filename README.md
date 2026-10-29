# aigowosyom

Worldbuilding data suite. Everything runs locally from one Node server.

| URL | What |
| --- | --- |
| `/` | Landing page |
| `/calendar` | Tanakōdeyam calendar with per-day notes |
| `/dictionary` | Public dictionary: browse languages, entry pages, search |
| `/dictionary/editor` | Dictionary editor (languages and words) |

## Run

```bash
npm install   # first time only
npm start
```

Then open <http://localhost:3000> (set `PORT` to change it). The server only listens on localhost.

## Data

Everything lives in one SQLite file, `data/worldbuilding.db` (created on first run, git-ignored). Back it up by copying that file while the server is stopped (or copy the `-wal`/`-shm` files alongside it if the server is running).

- **Calendar notes** are keyed by civil day number (days since 1970-01-01 UTC), so they stay attached to the same real day even if the calendar's parameters are later recalibrated.
- **Dictionary:** a `languages` table and a single `words` table (with `language_id`), plus `senses`, `word_variants` (same-language dialectal/spelling variants), `word_ancestry` (links to words in any language) and an FTS5 search index. Created/updated timestamps are stored but not shown.

## Dictionary notes

- **Public pages** are rendered by the server from the database on every request, so edits in the editor appear immediately.
- **Entry URLs:** `/dictionary/<language-slug>/<headword>`. Homographs (same spelling, same language) share one page as "Etymology 1, 2, …".
- **Links in text:** in definitions, etymology notes and ancestry notes, write `[[word]]` (same language), `[[slug:word]]`, or `[[slug:word|display text]]`. Links to entries that don't exist yet are shown in red.
- **Search** matches headwords, sinographs and English definitions, ignores diacritics (`o` finds `ō`) and matches prefixes. An unambiguous exact headword match goes straight to its entry.
- **Alphabetical order** is by headword with diacritics folded and lowercased.
- **Reserved slugs:** `editor`, `search`, `api`.
- **Proto-languages** are ordinary languages flagged "reconstructed"; their headwords display with a leading `*`.
- **Gender** (masculine/feminine/neuter) is only offered for languages flagged "has grammatical gender".

## Layout

```
server.js               entry point, request dispatch
lib/                    db schema, dictionary data access, rendering, static files
routes/                 calendar API, dictionary API, dictionary pages
public/                 landing page, calendar app, dictionary editor assets
```
