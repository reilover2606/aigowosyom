# aigowosyom

Worldbuilding data suite. Everything runs locally from one Node server.

| URL | What |
| --- | --- |
| `/` | Landing page |
| `/search?q=` | Site-wide search: dictionary, lore and calendar notes |
| `/calendar` | Tanakōdeyam calendar with per-day notes |
| `/lore` | Lore encyclopedia: categories, pages, search |
| `/lore/editor` | Lore editor (categories and pages, visual rich-text editor) |
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
- **Sound patterns:** a third language tab (`?view=sounds`) with a letter-pair heatmap. Each cell counts how often one letter is immediately followed by another in headwords; the `#` row and column show which letters begin and end words, and blank cells never occur. Vowels come first, then consonants (`y` counts as a consonant), so the vowel/consonant structure shows up as quadrants. It is based on spelling (a digraph like `kh` is k then h). Accented letters can be merged with plain ones or kept distinct (`&marks=keep`). Also shows the share of letter pairs that never occur, letters that never begin or end a word, and a ranked list of the most common pairs.
- **Sorting the Words tab:** alphabetical (with an initial-letter filter) or by part of speech (grouped, alphabetical within each group, with a part-of-speech filter). The sort and filter are kept while paging.
- **Parts of speech** are free text with suggestions in the editor, including *proper noun*, *personal name*, *family name* and *toponym*.
- **Random word** is also available on every entry page (a random word in that entry's language, never the same word again if there is another).
- **Typography:** words of the constructed languages are always sans-serif; everything else is serif; level-1 headings are exempt and use the sans stack. Mark a language word in markup with `class="conlang"`. The fonts live in `public/assets/site.css` (`--font-serif`, `--font-sans`).
- **Editor word list** can be sorted alphabetically or by last updated (your choice is remembered).
- **Alphabetical order** is by headword with diacritics folded and lowercased.
- **Reserved slugs:** `editor`, `search`, `random`, `family`, `api`.
- **Random word:** `/dictionary/random` (any language) or `/dictionary/random?language=<slug>`, linked from the dictionary home and each language page.
- **Proto-languages** are ordinary languages flagged "reconstructed"; their headwords display with a leading `*`.
- **Gender** (masculine/feminine/neuter) is only offered for languages flagged "has grammatical gender".

## Lore notes

- **Structure:** categories are the backbone; every page belongs to exactly one category. URLs are `/lore/<category-slug>/` and `/lore/<category-slug>/<page-slug>`. Pages are created and edited from a category's view in the editor, and can be moved to another category from the page form.
- **Page slugs** are generated from the title (accents and punctuation removed, e.g. "The Fall of Kyōra" becomes `the-fall-of-kyora`, with `-2`, `-3`… added if taken) and can be edited. Renaming a page keeps its URL unless you change the slug. Category slugs reserve `editor`, `search`, `random` and `api`.
- **Visual editor:** page bodies are written in a rich-text editor (headings 2–4, bold/italic/underline/strike, bulleted and numbered lists with nesting, quotes, links, horizontal rules, tables with row/column tools, undo/redo). Bodies are stored as sanitized HTML: the server keeps only an allowlist of tags and attributes and drops scripts, event handlers, `javascript:` links and the like, no matter what the editor sent. Pasted content is reduced to the same allowed formatting. Images are not supported yet.
- **Links:** `[[category]]` links a category, `[[category|Page Title]]` a page (matched by title or slug), and `[[category|Page Title|display text]]` adds display text. Dictionary links work in lore text too (`[[tanako:moin]]`, `[[tanako:moin|display]]`), and lore links work in dictionary text. Where a dictionary-style `[[word|text]]` link starts with the slug of an existing lore category, it is read as a lore link. The editor's `[[ ]]` button searches pages, categories and dictionary words and inserts the link for you; selected text becomes the display text. Links to pages that don't exist yet are shown in red.
- **Search:** a search box with live suggestions (titles and body text, diacritics ignored); an exact title goes straight to its page. `/lore/random` (optionally `?category=<slug>`) goes to a random page; random buttons are on the lore home, category pages and article pages.
- **Cross-links with the dictionary:** when a lore page has the same name as a dictionary entry, each links to the other: lore pages show "In the dictionary: …" and dictionary entries show "In the lore: …". Matching ignores case and diacritics (so *Kyōra* matches *kyora*) and also tries "headword + sinographs", so an era page titled "Niwosara 新雨" matches the entry *Niwosara* whose sinographs are 新雨.
- **Eras:** `public/calendar/eras.json` (the file the calendar reads) lists each era as `{ "name": "Niwosara", "sinographs": "新雨", "startYear": 1591 }`. The calendar shows name and sinographs together; everywhere else (lore pages, dictionary headwords) the name stands alone and the sinographs go in the dictionary's sinographs field. (An older file with the gloss glued to the name is split automatically.) A built-in **Eras** category holds one page per era, in chronological order; "Later …" entries (e.g. Later Kemairyom) get no page or entry. Pages are created automatically on startup and whenever `eras.json` changes, with the text "An era succeeding X and preceding Y, lasting a total of N years." (an era lasts until the year the next era in the file begins). The body is editable, and your edits are never overwritten by later syncs. Era titles come from `eras.json`, the slug and category are locked, era pages can't be deleted, and the Eras category can't be renamed or deleted (its color and description can be edited). If an era disappears from `eras.json`, its page becomes an ordinary page.
- **Era entries in the dictionary:** each era also gets a dictionary entry (proper noun) in the language *Tanakōdeyam*: the headword is the era name, the sinographs field holds the gloss, and its definition links to the era's lore page (it also gets the automatic "In the lore" link, since the names match). These entries are read-only in the editor and API and can't be deleted, except for their **etymology notes**, which you can edit (a re-sync from `eras.json` never overwrites them). The language is created automatically (slug `tanakodeyam`); if you already have a language with that slug or named "Tanakōdeyam" it is used instead, and it can't be deleted.
- **Calendar notes on era pages:** below the body (on the public page, and read-only below the editor) each era page lists every calendar note that falls within it, in date order, grouped by year (years without notes are skipped). Years are labelled the way the calendar counts them within the era, e.g. "Kemairyom 34" (hover for the universal year), and the page shows the era's span as "Kemairyom years 1–34". Each note shows its date as the English month name ("Second month 5") — except the two intercalary periods, which keep their native names (Hiūnmoin, Newōsēpreya) — with the Gregorian date faded beside it. A year shared by two eras (the year one ends and the next begins) appears in both, labelled with each page's own era. The calendar's date arithmetic is mirrored on the server in `lib/calendar.js`; keep it in step with `public/calendar/index.html`. The calendar also opens a given year via `/calendar/?year=2026`.
- **Books:** a built-in **Books** category (created automatically, like Eras: its name and slug are fixed and it can't be deleted; its color and description can be edited). Each page in it is a book — create them in the lore editor like any other page (the buttons say "New book"). A book's own text is optional and blank by default; a blank book shows nothing above its notes. Calendar notes are assigned to a book from the calendar: the note form has an optional **Book** dropdown (a note belongs to at most one book; "— none —" by default), and a note that has a book shows a 📖 link to it. A book's page lists its notes below its text exactly like an era page's notes: grouped by year (years without notes are skipped) in date order, with era-name-and-year headings ("Niwosara 10", or "Year N" before the first era), English month names, and the Gregorian date faded. The editor shows the same list read-only under the body. Era pages show a 📖 link on notes that belong to a book. Deleting a book, or moving its page to another category, keeps the notes in the calendar but unassigns them. API: `GET /api/lore/books` lists the books; `book_id` (or `null`) on `POST`/`PUT /api/notes` assigns a note, and leaving it out of an update leaves the assignment unchanged.
- **Category colors** work like language colors: a color picker in the category dialog (gray by default) tints badges, cards and the accent band on that category's pages.

## Site-wide features

- **Top bar:** a slim bar along the top of every page links to the top page of each section (Calendar, Lore, Dictionary) and home, highlighting the section you are in. It is hidden when printing. Pages rendered by the server get it from `siteBar()` in `lib/render.js`; the home page and the calendar page (hand-written HTML) carry a copy of the same markup.
- **Site-wide search:** a search box under the section cards on the home page searches the dictionary (headwords, sinographs, definitions), the lore (titles and text) and the calendar's notes (titles and text), ignoring case and diacritics. Live suggestions show a mixed list as you type (arrow keys and Enter work); submitting opens `/search?q=…`, which groups results by section with a "See all →" link into each section's own search. Calendar-note hits show their era and year (e.g. "Kemairyom 10"), month and Gregorian date, and link to that year in the calendar. Notes are indexed by an FTS5 table kept in step with the `notes` table by database triggers.

## Layout

```
server.js               entry point, request dispatch
lib/                    db schema, dictionary and lore data access, HTML sanitizer, rendering, static files
routes/                 calendar API, dictionary and lore APIs, dictionary and lore pages
public/                 landing page, calendar app, dictionary editor assets
```
