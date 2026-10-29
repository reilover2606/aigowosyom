# aigowosyom

Worldbuilding data suite. Currently: the Tanakōdeyam calendar with per-day notes.

## Run

```bash
npm install   # first time only
npm start
```

Then open <http://localhost:3000> (set `PORT` to change it). The server only listens on localhost.

## Data

Notes live in a single SQLite file, `data/worldbuilding.db` (created on first run, git-ignored). Back it up by copying that file while the server is stopped (or copy the `-wal`/`-shm` files alongside it if the server is running).

Notes are keyed by civil day number (days since 1970-01-01 UTC), so they stay attached to the same real day even if the calendar's parameters are later recalibrated.
