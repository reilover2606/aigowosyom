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
- **Live suggestions:** the search box in the top bar shows matching entries (with their language) as you type; arrow keys and Enter work, and without JavaScript it still submits to the results page.
- **Statistics:** each language page has a Words / Statistics tab (`/dictionary/<slug>/?view=stats`): average and median letters per word, consonant : vowel ratio (Latin letters only, `y` counts as a consonant), parts-of-speech pie, word-length histogram, letter frequency, gender split, etymological sources and influence on other languages, and entry completeness. Letters are counted on the diacritic-folded headword, so digraphs like `kh` count as two.
- **Language colors:** each language can be given a color in the editor's language settings (a color picker with a "use default gray" button). The color is used for its badges everywhere (search results, suggestions, ancestor links, the family graph), for the accent band and heading chip on its pages and entries, and for the editor's accents. Languages without a color are gray; text on the badge switches between white and near-black for readability.
- **Language family tree:** `/dictionary/family` draws languages as nodes, ancestors above descendants. Generations follow *inherited* links; a language with no inherited parent sits below the languages it *borrows* from; other borrowed links and *areal* links are drawn as cross-links (solid, dashed and dotted lines respectively). Numbers and line thickness show how many words are linked. A relationships table below the graph lists the same data.
- **Variants** are one level deep: only a base word can be given variants, so a variant can't be chosen as a parent and a word that already has variants can't itself become a variant. This makes variant loops impossible. (Links created before this rule existed are left alone.)
- **Editor word list** can be sorted alphabetically or by last updated (your choice is remembered).
- **Alphabetical order** is by headword with diacritics folded and lowercased.
- **Reserved slugs:** `editor`, `search`, `random`, `family`, `api`.
- **Random word:** `/dictionary/random` (any language) or `/dictionary/random?language=<slug>`, linked from the dictionary home and each language page.
- **Proto-languages** are ordinary languages flagged "reconstructed"; their headwords display with a leading `*`.
- **Gender** (masculine/feminine/neuter) is only offered for languages flagged "has grammatical gender".

## Layout

```
server.js               entry point, request dispatch
lib/                    db schema, dictionary data access, rendering, static files
routes/                 calendar API, dictionary API, dictionary pages
public/                 landing page, calendar app, dictionary editor assets
```
