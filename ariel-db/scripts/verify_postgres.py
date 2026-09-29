#!/usr/bin/env python3
"""
Run the schema, the seed and all twelve queries against a real Postgres
server, and write a report.

    pip install 'psycopg[binary]'
    export DATABASE_URL='postgresql://...'          # pooled Neon string
    python3 scripts/verify_postgres.py [--wipe-ratings]

Writes build/postgres-report.txt. Every query runs in its own
transaction, so one failure does not hide the others — the point is to
find all the dialect problems in one pass, not the first one.

Nothing here is destructive to anything but this database: it drops and
recreates the Ariel tables, and touches nothing else. Because that
includes visitor_rating, it refuses to run while the table holds live
ratings unless --wipe-ratings is given — point it at a Neon branch.
"""

from __future__ import annotations

import os
import re
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SQL = ROOT / "sql"
OUT = ROOT / "build" / "postgres-report.txt"

QUERY_NAMES = [
    "Q1  coverage",
    "Q2  frontier rank ordering",
    "Q3  dimension profile",
    "Q4  G-rate by arm",
    "Q5  inter-rater kappa",
    "Q6  disagreement direction",
    "Q7  length vs grounding",
    "Q8  arm ranking",
    "Q9  visitor ratings",
    "Q10 integrity checks",
    "Q11 frontier inter-rater spread",
    "Q12 frontier rater severity",
]


def split_statements(sql: str) -> list[str]:
    """Split the query file on the blank-line-separated comment banners."""
    out = []
    for chunk in re.split(r";\s*\n(?=\s*(?:--|SELECT|WITH))", sql):
        body = "\n".join(
            line for line in chunk.splitlines() if not line.strip().startswith("--")
        ).strip().rstrip(";")
        if body:
            out.append(body)
    return out


def fmt_table(cols, rows, limit=40) -> str:
    if not rows:
        return "    (no rows)\n"
    widths = [len(str(c)) for c in cols]
    shown = rows[:limit]
    for r in shown:
        for i, v in enumerate(r):
            widths[i] = max(widths[i], len("NULL" if v is None else str(v)))
    widths = [min(w, 40) for w in widths]

    def line(vals):
        cells = []
        for i, v in enumerate(vals):
            s = "NULL" if v is None else str(v)
            cells.append(s[: widths[i]].ljust(widths[i]))
        return "    " + " | ".join(cells)

    parts = [line(cols), "    " + "-+-".join("-" * w for w in widths)]
    parts += [line(r) for r in shown]
    if len(rows) > limit:
        parts.append(f"    ... {len(rows) - limit} more rows")
    return "\n".join(parts) + "\n"


def check_dsn(dsn: str) -> str | None:
    """
    Catch the obvious ways a connection string arrives wrong, so the user
    gets a sentence instead of an IDNA traceback from deep inside socket.
    Returns a description of the problem, or None if it looks plausible.
    """
    from urllib.parse import urlsplit

    s = dsn.strip()
    if s != dsn:
        return "it has leading or trailing whitespace"
    if s.startswith(("'", '"')) or s.endswith(("'", '"')):
        return "the quotes were included in the value itself"
    if not s.startswith(("postgresql://", "postgres://")):
        return "it does not start with postgresql://"

    try:
        parts = urlsplit(s)
        host = parts.hostname
    except Exception as exc:
        return f"it could not be parsed as a URL ({exc})"

    if not host:
        return "there is no hostname"
    if ".." in host or host.strip(".") == "":
        # the classic: the placeholder from the docs was pasted verbatim
        return f"the hostname is {host!r} — that looks like the literal '...' placeholder"
    local = host in ("localhost", "127.0.0.1", "::1")
    if "." not in host and not local:
        return f"the hostname {host!r} has no domain part"
    if not parts.password and not local:
        return "there is no password in the string (copy the full connection string)"
    return None


def main() -> int:
    wipe = "--wipe-ratings" in sys.argv
    argv = [a for a in sys.argv[1:] if a != "--wipe-ratings"]
    dsn = os.environ.get("DATABASE_URL") or (argv[0] if argv else None)
    if not dsn:
        sys.exit("set DATABASE_URL, or pass the connection string as an argument")

    problem = check_dsn(dsn)
    if problem:
        sys.exit(
            f"DATABASE_URL looks wrong: {problem}\n\n"
            "Expected the pooled connection string from the Neon console, e.g.\n"
            "  postgresql://USER:PASSWORD@ep-xxxx-pooler.REGION.aws.neon.tech"
            "/neondb?sslmode=require\n\n"
            "Quote it with single quotes so the shell does not eat characters\n"
            "in the password."
        )

    try:
        import psycopg
    except ImportError:
        sys.exit("pip install 'psycopg[binary]'")

    sys.path.insert(0, str(ROOT / "scripts"))
    import seed as seed_mod

    with psycopg.connect(dsn) as conn:
        seed_mod.refuse_if_ratings(conn, wipe)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    report: list[str] = []
    failures = 0

    def say(s=""):
        print(s)
        report.append(s)

    say("Ariel database — Postgres verification")
    say(f"run at {datetime.now(timezone.utc).isoformat(timespec='seconds')}")
    say("=" * 68)
    say()

    # --- server identity -------------------------------------------------
    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT version(), current_database()")
            v, dbname = cur.fetchone()
        say(f"server   : {v.split(',')[0]}")
        say(f"database : {dbname}")
        say()

    # --- schema ----------------------------------------------------------
    say("-" * 68)
    say("SCHEMA  (sql/01_schema.sql)")
    say("-" * 68)
    try:
        with psycopg.connect(dsn) as conn:
            conn.execute((SQL / "01_schema.sql").read_text(encoding="utf-8"))
            conn.commit()
        say("    applied cleanly")
    except Exception:
        failures += 1
        say("    FAILED")
        say(textwrap_indent(traceback.format_exc()))
        say()
        say("Stopping: nothing downstream can run without the schema.")
        OUT.write_text("\n".join(report), encoding="utf-8")
        return 1
    say()

    # --- seed ------------------------------------------------------------
    say("-" * 68)
    say("SEED  (scripts/seed.py --postgres)")
    say("-" * 68)
    try:
        with psycopg.connect(dsn) as conn:
            db = seed_mod.Db("postgres", conn)
            for row in seed_mod.CORPORA:
                db.exec(
                    "INSERT INTO corpus (corpus_id, code, label, description)"
                    " VALUES (?, ?, ?, ?)",
                    row,
                )
            counts: dict = {}
            seed_mod.load_frontier(db, counts)
            seed_mod.load_memory(db, counts)
            db.commit()
        for k in ("frontier_runs", "frontier_scores", "memory_runs", "memory_scores"):
            say(f"    {k:18} {counts[k]}")
        expected = {"frontier_runs": 41, "frontier_scores": 288,
                    "memory_runs": 39, "memory_scores": 234}
        if counts == expected:
            say("    counts match the SQLite run exactly")
        else:
            failures += 1
            say(f"    MISMATCH — expected {expected}")
    except Exception:
        failures += 1
        say("    FAILED")
        say(textwrap_indent(traceback.format_exc()))
    say()

    # --- queries ---------------------------------------------------------
    statements = split_statements((SQL / "02_queries.sql").read_text(encoding="utf-8"))
    names = QUERY_NAMES + [f"Q{i}" for i in range(len(QUERY_NAMES) + 1, len(statements) + 1)]

    for name, stmt in zip(names, statements):
        say("-" * 68)
        say(name)
        say("-" * 68)
        try:
            with psycopg.connect(dsn) as conn:
                with conn.cursor() as cur:
                    cur.execute(stmt)
                    cols = [d.name for d in cur.description]
                    rows = cur.fetchall()
            say(fmt_table(cols, rows))
        except Exception as exc:
            failures += 1
            say(f"    FAILED: {type(exc).__name__}: {exc}")
            say()

    say("=" * 68)
    say(f"{len(statements)} queries run, {failures} failure(s)")
    if failures == 0:
        say("All clean. The Postgres-only constructs — FILTER, NTILE,")
        say("STRING_AGG(... ORDER BY ...), STDDEV_SAMP, BOOL_OR — all executed.")

    OUT.write_text("\n".join(report) + "\n", encoding="utf-8")
    print(f"\nreport written to {OUT}")
    return 1 if failures else 0


def textwrap_indent(s: str) -> str:
    return "\n".join("    " + ln for ln in s.strip().splitlines())


if __name__ == "__main__":
    raise SystemExit(main())
