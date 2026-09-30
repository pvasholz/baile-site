# Baile Research Institute — static site

Plain HTML, CSS, and vanilla JS. No build step and no framework; npm is used only to
install the ratings function's one dependency. Drop this folder
onto Netlify (or any static host) and it works. Open the files in any editor and edit
them directly — what you see is what ships.

## Files

```
./
├── index.html              Home
├── research.html           The three programs
├── digital-minds.html      Position on the status of digital minds (linked from Research, not the nav)
├── publications.html       Filterable list (vanilla JS)
├── comparison.html         Project Ariel response comparison tool
├── about.html              About
├── support.html            Ways to help
├── story.html              "On the name" — linked from the 林 mark in the header
├── 404.html                Not-found page (Netlify serves this automatically)
├── netlify.toml            Publish dir + security headers
├── package.json            Dependency for the ratings function only (no build step)
├── netlify/functions/
│   └── rate.mjs            Stores visitor ratings (POST /api/rate)
├── ariel-db/               Postgres schema, seed script and analysis queries — see its README
├── robots.txt, sitemap.xml
├── css/
│   ├── colors_and_type.css Tokens — colors, type scale, spacing, motion
│   ├── website.css         Site component styles
│   ├── website.js          Mobile nav toggle
│   ├── comparison.css      Comparison tool styles (all scoped .cmp-*)
│   └── comparison.js       Comparison tool behaviour
├── data/
│   └── ariel-comparison.json   The corpus: rubric, raters, scores, response text.
│                               The one copy — ariel-db/scripts/seed.py reads it too.
├── fonts/                  Self-hosted fonts (SIL OFL): EB Garamond, Inter Tight, and a
│                           Noto Serif SC cut down to 林白乐. Declared in colors_and_type.css.
├── papers/                 Preprint PDFs, linked from publications.html (also on Zenodo)
└── assets/
    └── logo-mark.svg       Favicon. Header/footer marks are inline SVG in the HTML.
```

## How it works

- **Header & footer** are duplicated into every page. If you change the nav or footer,
  change it in all nine files. The nav lives in two places per page: the desktop `<nav
  class="br-nav">` and the `#br-mobile-menu` panel below it. Both need the new link.
- **Active nav highlight** — `class="br-nav-link is-active"` on the matching link, in
  both the desktop nav and the mobile panel.
- **Mobile nav** appears below 900px, where the desktop nav is hidden. The toggle button
  and panel markup must be present on a page or that page has no navigation on phones.
  `css/website.js` drives it and must be loaded at the bottom of every page.
- **Publications filter** is a small `<script>` block at the bottom of
  `publications.html` — it shows/hides `<li>` rows on a `data-prog` attribute.
- **Easter egg** — the 林 mark in the header goes to `story.html`; the wordmark goes home.

## The comparison tool

`comparison.html` is markup and layout only. Everything substantive lives in
`data/ariel-comparison.json`, which `css/comparison.js` fetches at load.

### The data format

The rubric, the raters and the scores are all data. No code changes are needed to
relabel a dimension, change the scale, or add a rater:

```jsonc
"rubric":  { "scaleMax": 4, "note": "...",
             "dimensions": [ { "key": "closure", "label": "Closure", "blurb": "...",
                               "anchors": { "4": "...", "0": "..." } } ] },
"raters":  [ { "key": "Paul", "label": "Paul Vasholz", "kind": "human" }, ... ],
"scores":  { "Model||Text||Condition": { "Paul": { "closure": 4, ... }, "Opus": {...} } },
"reliability": { "all_three_agree_pct": 38.5, "per_dimension": { ... } },
"display": { "hideUnscoredModels": true }
```

Each bar shows the **mean across raters**, with a tick for each rater's own score, and
the panel head shows every rater's total. The totals, bar widths, rating scale, rubric
key and the figures in the limitations note all derive from the JSON. With
`hideUnscoredModels`, models that have no scored cell are left out of the pickers (their
responses stay in the file for the database).

When `comparison.js` or `comparison.css` changes, bump the `?v=` on their tags in
`comparison.html` so returning visitors don't pair new code with a cached old file.

### Ragged cells are deliberate

Not every model has every run. The tool distinguishes three states and says which is
which, rather than showing a zero:

| Situation | What the visitor sees |
|---|---|
| Run exists, rubric-scored | Bars and a total |
| Run exists, never scored (all unconstrained runs) | Response text, `—` bars, "Not scored under the rubric" |
| Run never collected | "This run was not collected…" and no bars |

### Rating collection

The widget invites a visitor to score a response themselves. **Rubric scores are always
visible — nothing is gated behind a rating.** The prompt sits above the response text, and
"No thanks" dismisses it. If a visitor does answer, their number is shown next to the
rubric total.

`RATING_ENDPOINT` at the top of `comparison.js` is `'/api/rate'`, the path
`netlify/functions/rate.mjs` declares. Set it to `null` to stop transmitting; the widget
keeps working. The POST body is:

```json
{ "session": "<random hex, sessionStorage only>", "model": "...", "stimulus": "...",
  "condition": "...", "rating": 12, "scale_max": 16, "rated_at": "<ISO 8601>" }
```

No IP address, no account, no free-text field. The session token is generated in the
browser and dies with the tab; it exists only so several ratings in one visit can be
grouped. The disclosure under "What your rating collects" on the page describes exactly
this — if you change the payload, change that text too.

The fetch is fire-and-forget and failures are swallowed on purpose: if the database is
cold or down, the comparison tool still works and only the rating write is lost.

### Turning the ratings function on

The function is `netlify/functions/rate.mjs`. Its one dependency,
`@neondatabase/serverless`, is declared in `package.json`; Netlify installs it at deploy
time, so there is still no build step for the site itself. Until the database is
configured, the function answers `503` and the page carries on as normal.

1. **Database.** A Neon project, used directly rather than through Netlify DB (see
   `ariel-db/README.md` for why). Copy its *pooled* connection string.
2. **Load it.** From `ariel-db/`: `python3 scripts/seed.py --postgres "$DATABASE_URL"`.
   This creates the tables and loads `data/ariel-comparison.json` plus the memory corpus.
3. **Environment variables** (Netlify → Site configuration → Environment variables):
   `DATABASE_URL` (the same connection string) and `ALLOWED_ORIGIN`
   (`https://baile.institute`). Redeploy so the function picks them up.
4. **Check it.** Rate a response on the live site, then run Q9 from
   `ariel-db/sql/02_queries.sql` to see it arrive.

**Re-seeding deletes visitor ratings**, because the seed drops and recreates every table.
Both scripts in `ariel-db/scripts/` therefore refuse to run while `visitor_rating` holds
any rows. When the corpus changes, seed a Neon branch, or pass `--wipe-ratings` only if
losing the collected ratings is really intended.

The function matches a rating to a run by model name, text and condition, so a cell
the site shows must exist in the database. Re-seed after changing the JSON.

## Editing

- **Add a publication**: put the PDF in `papers/` and a 600×400 WebP thumbnail in
  `assets/thumbs/`, then copy an `<li class="br-pub-row" data-prog="…">` block in
  `publications.html`. The item count updates itself. Blur anything identifying (licence
  plates, faces) in photos before adding them.
- **Change colors or type**: edit `css/colors_and_type.css` only. Headings use
  `--font-display` (EB Garamond), text uses `--font-sans` (Inter Tight); the 林 mark uses
  `--mark` (small) and `--mark-large` (large). After changing a stylesheet, bump its `?v=`
  in the page `<link>` tags so returning visitors don't keep the cached copy.
- **Using another Chinese character**: the bundled Noto Serif SC only contains 林白乐.
  Anything else falls back to the visitor's system font unless you regenerate the subset.
- **Add a page**: copy `about.html`, swap the body, add the link to the desktop nav and
  the mobile panel in all pages, and add it to `sitemap.xml`.

## Known gaps

- The header/footer duplication is real: nine copies to keep in sync by hand. That is the
  price of no build step, and at nine pages it is still the right trade.
- `netlify.toml` sets `publish = "."`, so deploy with this folder as the base directory.
