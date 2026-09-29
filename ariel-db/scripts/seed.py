#!/usr/bin/env python3
"""
Seed the Ariel scoring database from the source files.

    python scripts/seed.py --sqlite build/ariel.db        # local, no server
    python scripts/seed.py --postgres "$DATABASE_URL"     # Neon, Supabase, local

Idempotent: it drops and recreates everything, so running it twice is
safe and produces byte-identical contents.

Sources
    data/ariel-comparison.json      frontier corpus — the same file the
                                    website loads, so the site and the
                                    database cannot drift apart
    data/ariel_memory_D2_scores.csv memory corpus — two raters, 39 runs
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
SQL = ROOT / "sql"

FRONTIER_JSON = DATA / "ariel-comparison.json"
MEMORY_CSV = DATA / "ariel_memory_D2_scores.csv"


# ---------------------------------------------------------------------
# Dialect shim — the same INSERTs run on both backends
# ---------------------------------------------------------------------

class Db:
    """Thin wrapper so seeding logic is written once."""

    def __init__(self, kind, conn):
        self.kind = kind
        self.conn = conn
        self.cur = conn.cursor()

    @property
    def ph(self):
        return "%s" if self.kind == "postgres" else "?"

    def exec(self, sql, args=()):
        self.cur.execute(sql.replace("?", self.ph) if self.kind == "postgres" else sql, args)
        return self.cur

    def insert_returning_id(self, table, cols, args, pk):
        placeholders = ", ".join([self.ph] * len(args))
        collist = ", ".join(cols)
        if self.kind == "postgres":
            self.cur.execute(
                f"INSERT INTO {table} ({collist}) VALUES ({placeholders}) RETURNING {pk}", args
            )
            return self.cur.fetchone()[0]
        self.cur.execute(f"INSERT INTO {table} ({collist}) VALUES ({placeholders})", args)
        return self.cur.lastrowid

    def script(self, sql):
        if self.kind == "sqlite":
            self.conn.executescript(sql)
        else:
            self.cur.execute(sql)

    def commit(self):
        self.conn.commit()


def postgres_to_sqlite(ddl: str) -> str:
    """
    Translate the Postgres schema for local SQLite use.

    The Postgres file is the canonical artifact; this exists so the same
    schema can be exercised without a server. It is a narrow translation
    of the constructs actually used, not a general transpiler.
    """
    s = ddl
    s = re.sub(r"\bBIGSERIAL\s+PRIMARY KEY\b", "INTEGER PRIMARY KEY AUTOINCREMENT", s)
    s = re.sub(r"\bSERIAL\s+PRIMARY KEY\b", "INTEGER PRIMARY KEY AUTOINCREMENT", s)
    s = re.sub(r"\bSMALLINT\s+PRIMARY KEY\b", "INTEGER PRIMARY KEY", s)
    s = re.sub(r"\bTIMESTAMPTZ\b", "TEXT", s)
    s = re.sub(r"\bBOOLEAN\b", "INTEGER", s)
    s = re.sub(r"\bSMALLINT\b", "INTEGER", s)
    s = re.sub(r"\bnow\(\)", "CURRENT_TIMESTAMP", s)
    s = re.sub(r"\bchar_length\(", "length(", s)
    s = re.sub(r"\bDEFAULT FALSE\b", "DEFAULT 0", s)
    s = re.sub(r"\bDEFAULT TRUE\b", "DEFAULT 1", s)
    s = re.sub(r"\s+CASCADE;", ";", s)          # DROP TABLE ... CASCADE
    s = s.replace("BEGIN;", "").replace("COMMIT;", "")
    return s


# ---------------------------------------------------------------------
# Reference data
# ---------------------------------------------------------------------

CORPORA = [
    (1, "frontier", "Frontier comparison",
     "Frontier models on two literary scenarios, constrained and unconstrained. "
     "Revised rubric, three raters per scored cell."),
    (2, "memory", "Memory retrieval",
     "One model across eight retrieval arms, five replicates each, two raters."),
]

# Memory corpus arms, in the order they appear in the source.
MEMORY_ARMS = [
    ("CRT",    "Contextual retrieval",        True),
    ("MMR",    "Maximal marginal relevance",  True),
    ("WRAPa",  "Wrapped context (variant a)", True),
    ("dir3p",  "Direct, three passages",      True),
    ("MEM",    "Memory system",               True),
    ("DILUTE", "Diluted context",             True),
    ("rawmem", "Raw memory dump",             True),
    ("DIR",    "Direct retrieval",            True),
]

MEMORY_DIMS = [
    ("D1", "Closure", 1,
     "Does the response stop where its grounds stop?"),
    ("D2", "Grounded uncertainty", 2,
     "When it declines to settle, is a reason given, or is the uncertainty merely named?"),
    ("D3", "Evasive substitution", 3,
     "Does it answer the question asked rather than an easier one?"),
]

MEMORY_RATERS = [
    ("opus", "Opus 4.8 (blind)", "model", True),
    ("mimo", "MiMo (blind)", "model", True),
]


def load_frontier(db, ids):
    """Frontier corpus, straight from the file the website serves."""
    doc = json.loads(FRONTIER_JSON.read_text(encoding="utf-8"))
    rub = doc["rubric"]

    rubric_id = db.insert_returning_id(
        "rubric",
        ["corpus_id", "code", "version", "scale_min", "scale_max", "description"],
        (1, rub.get("code", "ariel_frontier"), rub.get("code", "v1"),
         rub.get("scaleMin", 0), rub["scaleMax"],
         rub.get("label", "Ariel frontier rubric")),
        "rubric_id",
    )

    dim_ids = {}
    for i, d in enumerate(rub["dimensions"], start=1):
        dim_ids[d["key"]] = db.insert_returning_id(
            "dimension",
            ["rubric_id", "code", "label", "ordinal", "blurb"],
            (rubric_id, d["key"], d["label"], i, d.get("blurb")),
            "dimension_id",
        )

    # Three raters now, declared in the JSON. Each scores every cell, which is
    # what makes the frontier corpus support an agreement query at all.
    rater_ids = {}
    for r in doc.get("raters", [{"key": "house", "label": "Institute rater", "kind": "model"}]):
        rater_ids[r["key"]] = db.insert_returning_id(
            "rater", ["code", "label", "kind", "is_blind"],
            (r["key"], r["label"], r["kind"], False),
            "rater_id",
        )

    model_ids = {}
    for name in doc["models"]:
        model_ids[name] = db.insert_returning_id(
            "model", ["name", "is_local"], (name, False), "model_id")

    stim_ids = {}
    for label in doc["texts"]:
        code = re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_")
        stim_ids[label] = db.insert_returning_id(
            "stimulus", ["corpus_id", "code", "label", "source_work"],
            (1, code, label, label), "stimulus_id")

    cond_ids = {}
    for c in doc["conditions"]:
        cond_ids[c["key"]] = db.insert_returning_id(
            "condition", ["corpus_id", "code", "label", "is_constrained"],
            (1, c["key"].lower(), c["label"], c["key"] != "Unconstrained"),
            "condition_id")

    # Runs come from RESPONSES, which is the superset: some runs exist
    # with no score, and that raggedness is the point.
    run_ids = {}
    for key, segments in doc["responses"].items():
        model, stim, cond = key.split("||")
        run_id = db.insert_returning_id(
            "run",
            ["corpus_id", "model_id", "stimulus_id", "condition_id", "replicate"],
            (1, model_ids[model], stim_ids[stim], cond_ids[cond], 1),
            "run_id",
        )
        run_ids[key] = run_id
        for i, seg in enumerate(segments, start=1):
            db.exec(
                "INSERT INTO response_segment (run_id, ordinal, segment_type, body)"
                " VALUES (?, ?, ?, ?)",
                (run_id, i, seg["type"], seg["text"]),
            )
        # first prompt segment becomes the stimulus prompt text
        for seg in segments:
            if seg["type"] == "prompt":
                db.exec(
                    "UPDATE stimulus SET prompt_text = ? WHERE stimulus_id = ?"
                    " AND prompt_text IS NULL",
                    (seg["text"], stim_ids[stim]),
                )
                break

    # A scored cell may legitimately have no transcript — the run happened and
    # was rated, the text just is not in the published set. Create the run so
    # the scores have somewhere to live.
    n_scores = 0
    for key, by_rater in doc["scores"].items():
        if key not in run_ids:
            model, stim, cond = key.split("||")
            run_ids[key] = db.insert_returning_id(
                "run",
                ["corpus_id", "model_id", "stimulus_id", "condition_id", "replicate"],
                (1, model_ids[model], stim_ids[stim], cond_ids[cond], 1),
                "run_id",
            )
        for rater_key, values in by_rater.items():
            for dim_key, val in values.items():
                db.exec(
                    "INSERT INTO score (run_id, rater_id, dimension_id, value)"
                    " VALUES (?, ?, ?, ?)",
                    (run_ids[key], rater_ids[rater_key], dim_ids[dim_key], val),
                )
                n_scores += 1

    ids["frontier_runs"] = len(run_ids)
    ids["frontier_scores"] = n_scores


def load_memory(db, ids):
    """Memory corpus. Two raters, three dimensions, G/N on D2."""
    rubric_id = db.insert_returning_id(
        "rubric",
        ["corpus_id", "code", "version", "scale_min", "scale_max", "description"],
        (2, "ariel_memory", "0-4", 0, 4,
         "Three-dimension rubric with a grounded/named judgment on D2."),
        "rubric_id",
    )

    dim_ids = {}
    for code, label, ordinal, blurb in MEMORY_DIMS:
        dim_ids[code] = db.insert_returning_id(
            "dimension", ["rubric_id", "code", "label", "ordinal", "blurb"],
            (rubric_id, code, label, ordinal, blurb), "dimension_id")

    rater_ids = {}
    for code, label, kind, blind in MEMORY_RATERS:
        rater_ids[code] = db.insert_returning_id(
            "rater", ["code", "label", "kind", "is_blind"],
            (code, label, kind, blind), "rater_id")

    model_id = db.insert_returning_id(
        "model", ["name", "is_local"], ("Ariel local run", True), "model_id")

    stim_id = db.insert_returning_id(
        "stimulus", ["corpus_id", "code", "label"],
        (2, "recall_probe", "Memory recall probe"), "stimulus_id")

    cond_ids = {}
    for code, label, constrained in MEMORY_ARMS:
        cond_ids[code] = db.insert_returning_id(
            "condition", ["corpus_id", "code", "label", "is_constrained"],
            (2, code, label, constrained), "condition_id")

    rows = list(csv.DictReader(MEMORY_CSV.open(encoding="utf-8")))
    n_scores = 0
    for row in rows:
        arm = row["arm"]
        if arm not in cond_ids:
            raise SystemExit(f"unknown arm in CSV: {arm}")
        run_id = db.insert_returning_id(
            "run",
            ["corpus_id", "model_id", "stimulus_id", "condition_id",
             "replicate", "letter", "resp_chars", "source_file"],
            (2, model_id, stim_id, cond_ids[arm], int(row["replicate"]),
             row["letter"], int(row["resp_chars"]), row["source_file"]),
            "run_id",
        )
        for rater in ("opus", "mimo"):
            gn = row[f"{rater}_GN"]
            for dim in ("D1", "D2", "D3"):
                # The G/N judgment attaches to D2 only.
                # Must be a real Python bool, not 1/0: `grounded` is BOOLEAN,
                # and Postgres will not coerce smallint to boolean the way
                # SQLite silently does.
                grounded = (gn == "G") if dim == "D2" else None
                db.exec(
                    "INSERT INTO score (run_id, rater_id, dimension_id, value, grounded)"
                    " VALUES (?, ?, ?, ?, ?)",
                    (run_id, rater_ids[rater], dim_ids[dim],
                     int(row[f"{rater}_{dim}"]), grounded),
                )
                n_scores += 1

    ids["memory_runs"] = len(rows)
    ids["memory_scores"] = n_scores


# ---------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--sqlite", metavar="PATH", help="path to a SQLite file to create")
    g.add_argument("--postgres", metavar="DSN",
                   help="Postgres connection string (or set DATABASE_URL)")
    args = ap.parse_args()

    ddl = (SQL / "01_schema.sql").read_text(encoding="utf-8")

    if args.sqlite:
        import sqlite3
        path = Path(args.sqlite)
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists():
            path.unlink()
        conn = sqlite3.connect(path)
        conn.execute("PRAGMA foreign_keys = ON")
        db = Db("sqlite", conn)
        db.script(postgres_to_sqlite(ddl))
    else:
        try:
            import psycopg
        except ImportError:
            sys.exit("pip install 'psycopg[binary]' to seed Postgres")
        dsn = args.postgres or os.environ.get("DATABASE_URL")
        conn = psycopg.connect(dsn)
        db = Db("postgres", conn)
        db.script(ddl)

    for row in CORPORA:
        db.exec("INSERT INTO corpus (corpus_id, code, label, description)"
                " VALUES (?, ?, ?, ?)", row)

    counts = {}
    load_frontier(db, counts)
    load_memory(db, counts)
    db.commit()

    print("seeded:")
    for k in ("frontier_runs", "frontier_scores", "memory_runs", "memory_scores"):
        print(f"  {k:18} {counts[k]}")


if __name__ == "__main__":
    main()
