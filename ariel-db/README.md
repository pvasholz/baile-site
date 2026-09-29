# Ariel scoring database

Postgres schema, seed script, and analytical queries for the Baile Research
Institute scoring corpora — the frontier comparison runs and the memory
retrieval runs, under one schema.

```
ariel-db/
├── sql/
│   ├── 01_schema.sql     DDL — tables, constraints, indexes, two views
│   └── 02_queries.sql    Ten analytical queries, Q1–Q10
├── scripts/
│   ├── seed.py               Loads both corpora into SQLite or Postgres
│   └── verify_postgres.py    Runs schema + seed + all queries, writes a report
└── data/
    ├── ariel-comparison.json      frontier corpus (same file the site serves)
    └── ariel_memory_D2_scores.csv memory corpus
```

## Quick start

```bash
# local, no server, nothing to install
python3 scripts/seed.py --sqlite build/ariel.db
sqlite3 build/ariel.db < sql/02_queries.sql

# Postgres (Neon, or local)
pip install 'psycopg[binary]'
python3 scripts/seed.py --postgres "$DATABASE_URL"
psql "$DATABASE_URL" -f sql/02_queries.sql
```

Seeding is idempotent — it drops and recreates, so run it as often as you like.

Expected result: 80 runs (41 frontier, 39 memory), 522 scores (288 frontier from
three raters across 24 cells, 234 memory from two raters across 39 runs).

## Why the schema looks like this

Two corpora with different condition vocabularies, different dimension sets,
different scales and different rater counts could easily have become two
schemas. They did not, because all four of those differences are *data*:

- `rubric` owns the scale, so moving the frontier corpus from 0–2 to 0–4 is an
  `UPDATE` of one row, not a migration.
- `dimension` owns the dimension set, so the memory corpus's three dimensions
  and the frontier corpus's four coexist without a nullable column each.
- `condition` owns the vocabulary — `unconstrained`/`ariel` alongside the eight
  memory arms.
- `score` carries a `rater_id` on every row, so one-rater and two-rater corpora
  are the same shape and inter-rater agreement is one query rather than a
  special case.

Adding a third corpus should require inserts, not DDL. That was the test.

The one deliberate asymmetry is `score.grounded`, which carries the memory
corpus's G/N judgment. It attaches to a single dimension (D2) rather than to the
run, so it lives on the score row and is NULL wherever a rubric does not use it.
Q10 asserts both facts.

## What the queries are for

| | |
|---|---|
| **Q1** | Coverage — which cells exist, which are scored, which are neither. Run this first; the grid is ragged and a later `AVG()` would hide it. |
| **Q2** | Frontier rank ordering, with n attached |
| **Q3** | Dimension profile per model — where a total hides its shape |
| **Q4** | G-rate by arm, per rater |
| **Q5** | Inter-rater agreement with Cohen's kappa |
| **Q6** | Direction of rater disagreement — systematic vs. noisy |
| **Q7** | Response length against grounding — the confound check |
| **Q8** | Arm ranking by mean D2, with spread |
| **Q9** | Visitor ratings against the house rubric (empty until the site collects some) |
| **Q10** | Integrity checks — every row should return zero |
| **Q11** | Frontier inter-rater spread per dimension |
| **Q12** | Frontier rater severity |

### Frontier reliability (Q11, Q12)

| dimension | all three agree | max spread | range used |
|---|---|---|---|
| D1 closure | 41.7% | 1 | 3–4 |
| D2 uncertainty | 45.8% | 4 | 0–4 |
| D3 substitution | 29.2% | 3 | 1–4 |
| D4 self-assessment | 37.5% | 3 | 1–4 |

Two separate problems. **D3 is unreliable** — three raters agree exactly under a
third of the time. **D1 is inert** — it never takes a value below 3, so it is not
discriminating between responses at all; the high agreement there is agreement
that everything is fine, which is not the same as the dimension working.

Rater severity (Q12): Paul 14.29, Opus 14.08, MiMo 12.96 out of 16. MiMo is
consistently stricter, which is a calibration offset and could be corrected for.
The D3 disagreement is not an offset and cannot.

### Two results worth knowing before you write them up

**Q5 — kappa is 0.357.** Raw agreement on G/N is 66.7% (26 of 39, matching the
`GN_agree` column in the CSV), but the marginals are lopsided: `opus` says G 54%
of the time, `mimo` 26%. Chance agreement is therefore 48.1%, and kappa lands at
0.357 — conventionally "fair", well short of good. Quoting the raw 66.7% would
overstate how much the two raters actually concur.

**Q7 — length looks like a real confound.** G-rate by response-length quartile:

| quartile | chars | n | G-rate |
|---|---|---|---|
| 1 | 836–953 | 10 | 30.0% |
| 2 | 993–1153 | 10 | 20.0% |
| 3 | 1220–1656 | 10 | 90.0% |
| 4 | 1693–2168 | 9 | 77.8% |

The jump between quartile 2 and quartile 3 is large. Some of it is presumably
real — a grounded refusal takes more words than a bare one, because it has to
state the reason. But it means an arm that merely produces longer output will
score better on D2 without being better, and the arm ranking in Q8 cannot be
read independently of this. Worth a length control before the arm comparison
carries any weight.

## Hosting the live database

The site's architecture keeps the corpus static and puts **only visitor ratings**
behind a database. If the database is cold or down, the comparison tool still
works and only the rating write is lost. That failure mode is what makes the
free tier viable.

### Recommendation: Neon

Neon's free tier gives 0.5 GB per project across up to 100 projects, and 100
CU-hours per month. Compute scales to zero after five minutes idle and **resumes
automatically on the next query**, typically in a few hundred milliseconds.

Sporadic traffic is precisely the case it is designed for, which matters for a
research site that may go quiet for a fortnight between visitors.

### Why not Supabase

Supabase's free tier pauses a project after **7 days of low activity**, and
restoring it is a manual click — *Resume project* in the dashboard. There is no
automatic wake on query. For a site that might see no traffic for two weeks, the
first visitor after a lull hits a dead database, and you find out when somebody
tells you. Supabase's own docs say a few requests a day are needed to stay
active. That is a keep-alive cron you would be maintaining forever.

Its REST API is genuinely convenient — you could write from the browser with no
backend at all. But given you want something to show for the SQL, writing the
forty-line function is arguably the point.

### Why not Netlify DB

Tempting, since the site deploys to Netlify and it is Neon underneath. But
Netlify DB is on credit-based plans, and free database storage ended 1 July
2026. Going to Neon directly keeps it free and keeps you on plain Postgres
rather than a wrapper.

### Why not SQLite at the edge

Turso and Cloudflare D1 both have generous free tiers (D1: 5 GB, 5M row reads
and 100k row writes per day, no cold start). Either would carry this workload
easily. The reason to pass is the job motive — postings ask for Postgres far
more often than for SQLite, and `01_schema.sql` is written in Postgres for that
reason. Keep SQLite for local analysis, where `seed.py --sqlite` already puts it.

### Setup

1. Create a Neon project. Copy the **pooled** connection string.
2. `python3 scripts/seed.py --postgres "$DATABASE_URL"`
3. In Netlify: set `DATABASE_URL` and `ALLOWED_ORIGIN` as environment variables.
4. `npm i @netlify/neon` in the site directory.
5. In `web/css/comparison.js`, set `RATING_ENDPOINT = '/api/rate'`.

The function is `web/netlify/functions/rate.mjs`. It can only insert into
`visitor_rating`, cannot read ratings back, and rejects any cell triple that
does not resolve to a real run.

### A note on the ratings as data

Visitor ratings are human-subjects data, informally. The design keeps them
anonymous by construction — a browser-generated session token that dies with the
tab, no IP column, no user agent, no free-text field — and the page carries a
plain-language description of exactly what is stored. Doing that from the start
is the difference between data you can eventually publish from and data you
cannot touch.

If you ever change the payload, change the disclosure text on `comparison.html`
in the same commit.

## Verification

Verified end to end against **PostgreSQL 18.4 on Neon**: schema applied cleanly,
seed produced 61 runs and 290 scores matching the source files exactly, and all
ten queries ran with zero failures. `FILTER`, `NTILE`, `STRING_AGG(... ORDER BY
...)`, `BOOL_OR` and `STDDEV_SAMP` all executed natively.

Q10 returns zero violations on all six checks against seeded data — including
the assertion that `grounded` is true exactly when D2 >= 3, which is how the G/N
column was confirmed derivable rather than independent.

One column is more trustworthy on Postgres than it was locally: Q6's `which`
list uses `STRING_AGG(letter ORDER BY letter)`, and SQLite's `GROUP_CONCAT`
silently ignores `ORDER BY`. The letter ordering in a Postgres run is the
correct one.

### What the native Postgres run caught

Development testing ran on SQLite, which is more permissive than Postgres in one
way that mattered: it accepts `1` and `0` for a `BOOLEAN` column. The seed was
binding integers to `score.grounded`, and Postgres refused with
`DatatypeMismatch`. Fixed by binding real Python bools.

The lesson generalises — SQLite cannot catch this class of bug by construction,
so a native run is not optional. There is a guard for it now: the type check in
the development harness asserts that all four BOOLEAN columns (`grounded`,
`is_blind`, `is_constrained`, `is_local`) receive a bool or NULL.

Q5 also raised `DivisionByZero` against the empty table left behind by the
failed seed. `NULLIF` guards now make it return a row of NULLs instead, which is
the right answer for "no data yet" and matters for Q9 too.

### Running the verification

```bash
pip install 'psycopg[binary]'
export DATABASE_URL='postgresql://...'      # pooled connection string
python3 scripts/verify_postgres.py
```

It applies the schema, seeds, and runs all ten queries — each in its own
transaction, so one dialect failure does not mask the rest — then writes
`build/postgres-report.txt`. The report records the server version and database
name but never the connection string, so it is safe to read and share. `build/`
is gitignored anyway.

### Use a branch

Neon's branches are copy-on-write clones, which suits this well: seed and verify
on a `dev` branch first, and only point the production connection string at
`main` once the report is clean. A wrong seed then costs a branch delete rather
than a restore.
