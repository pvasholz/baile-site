# Baile Research Institute — static site

Plain HTML, CSS, and vanilla JS. No build step, no framework, no npm. Drop this folder
onto Netlify (or any static host) and it works. Open the files in any editor and edit
them directly — what you see is what ships.

## Files

```
web/
├── index.html              Home
├── research.html           The three programs
├── publications.html       Filterable list (vanilla JS)
├── comparison.html         Project Ariel response comparison tool
├── people.html             The team
├── about.html              About
├── support.html            Ways to help
├── story.html              "On the name" — linked from the 林 mark in the header
├── 404.html                Not-found page (Netlify serves this automatically)
├── netlify.toml            Publish dir + security headers
├── package.json            Dependency for the ratings function only (no build step)
├── robots.txt, sitemap.xml
├── css/
│   ├── colors_and_type.css Tokens — colors, type scale, spacing, motion
│   ├── website.css         Site component styles
│   ├── website.js          Mobile nav toggle
│   ├── comparison.css      Comparison tool styles (all scoped .cmp-*)
│   └── comparison.js       Comparison tool behaviour
├── data/
│   └── ariel-comparison.json   The corpus: rubric, scores, response text
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

### Moving from the 0–2 rubric to 0–4

Edit the JSON only. No code changes:

```jsonc
"rubric": {
  "scaleMax": 4,               // was 2
  "dimensions": [              // relabel / re-key freely; add or remove entries
    { "key": "closure", "label": "Closure", "blurb": "..." }
  ]
}
```

Then replace the values in `"scores"`. Keys are `"Model||Text||Condition"`. The totals,
the bar widths, the rating scale, the rubric key under "What the dimensions mean" and the
0–N figure in the limitations note all derive from `scaleMax` and `dimensions` — they
update themselves.

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

It works with no backend: while `RATING_ENDPOINT` at the top of `comparison.js` is `null`,
nothing is transmitted.

To start collecting, set it to `'/api/rate'` (the path `netlify/functions/rate.mjs`
declares). The POST body is:

```json
{ "session": "<random hex, sessionStorage only>", "model": "...", "stimulus": "...",
  "condition": "...", "rating": 6, "scale_max": 8, "rated_at": "<ISO 8601>" }
```

No IP address, no account, no free-text field. The session token is generated in the
browser and dies with the tab; it exists only so several ratings in one visit can be
grouped. The disclosure under "What your rating collects" on the page describes exactly
this — if you change the payload, change that text too.

The fetch is fire-and-forget and failures are swallowed on purpose: if the database is
cold or down, the comparison tool still works and only the rating write is lost.

### Turning the ratings function on

The function is `netlify/functions/rate.mjs`. Its one dependency, `@netlify/neon`, is
declared in `package.json`; Netlify installs it at deploy time, so there is still no
build step for the site itself. To go live:

1. **Database.** Add Netlify's Neon extension to the site (or create a Neon project and
   copy its *pooled* connection string).
2. **Schema.** The function reads `run`, `model`, `stimulus` and `condition`, and writes
   `visitor_rating (run_id, session_token, rating, scale_max, rated_at)` with a
   `UNIQUE (run_id, session_token)` constraint. The schema and the script that loads
   the corpus into it are not in this repo — they need to be created before step 4.
   Only rows with `corpus_id = 1` are matched.
3. **Environment variables** (Netlify → Site configuration → Environment variables):
   `NETLIFY_DATABASE_URL` (set automatically by the Neon extension) and `ALLOWED_ORIGIN`
   (`https://baile.institute`).
4. **Switch it on:** set `RATING_ENDPOINT = '/api/rate'` in `css/comparison.js`.

Until step 4, the deployed function exists but nothing calls it.

## Editing

- **Add a publication**: copy an `<li class="br-pub-row" data-prog="…">` block in
  `publications.html` and update the count default in the script at the bottom.
- **Change colors or type**: edit `css/colors_and_type.css` only.
- **Add a page**: copy `about.html`, swap the body, add the link to the desktop nav and
  the mobile panel in all pages, and add it to `sitemap.xml`.

## Known gaps

- The header/footer duplication is real: nine copies to keep in sync by hand. That is the
  price of no build step, and at nine pages it is still the right trade.
- Fonts load from Google Fonts. To self-host, replace the `@import` at the top of
  `colors_and_type.css` with `@font-face` blocks pointing at a local `/fonts` directory.
- `netlify.toml` sets `publish = "."`, so deploy with this folder as the base directory.
