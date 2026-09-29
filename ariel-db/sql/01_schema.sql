-- =====================================================================
--  Baile Research Institute — Ariel scoring database
--  PostgreSQL 15+
-- ---------------------------------------------------------------------
--  One schema serves two corpora that share a spine:
--
--    frontier  seven models answer two literary scenarios, with and
--              without the Ariel constraint. One rater, four dimensions,
--              0–2 (moving to 0–4).
--    memory    one model across eight retrieval arms, five replicates
--              each. Two raters, three dimensions, 0–4, plus a binary
--              grounded/named judgment.
--
--  They differ in condition vocabulary, dimension set, scale, and rater
--  count. Rather than two schemas, all four of those are data:
--  `rubric` owns the scale, `dimension` owns the dimension set,
--  `condition` owns the vocabulary, and `score` carries a rater on
--  every row. Adding a third corpus should require inserts, not DDL.
-- =====================================================================

BEGIN;

DROP TABLE IF EXISTS visitor_rating   CASCADE;
DROP TABLE IF EXISTS score            CASCADE;
DROP TABLE IF EXISTS response_segment CASCADE;
DROP TABLE IF EXISTS run              CASCADE;
DROP TABLE IF EXISTS dimension        CASCADE;
DROP TABLE IF EXISTS rubric           CASCADE;
DROP TABLE IF EXISTS rater            CASCADE;
DROP TABLE IF EXISTS condition        CASCADE;
DROP TABLE IF EXISTS stimulus         CASCADE;
DROP TABLE IF EXISTS model            CASCADE;
DROP TABLE IF EXISTS corpus           CASCADE;


-- ---------------------------------------------------------------------
-- Reference tables
-- ---------------------------------------------------------------------

CREATE TABLE corpus (
    corpus_id    SMALLINT     PRIMARY KEY,
    code         TEXT         NOT NULL UNIQUE,
    label        TEXT         NOT NULL,
    description  TEXT
);

CREATE TABLE model (
    model_id     SERIAL       PRIMARY KEY,
    name         TEXT         NOT NULL UNIQUE,
    family       TEXT,
    param_note   TEXT,
    is_local     BOOLEAN      NOT NULL DEFAULT FALSE
);

-- The thing the model was asked to respond to. In the frontier corpus a
-- literary scenario; in the memory corpus the fixed recall probe.
CREATE TABLE stimulus (
    stimulus_id  SERIAL       PRIMARY KEY,
    corpus_id    SMALLINT     NOT NULL REFERENCES corpus(corpus_id),
    code         TEXT         NOT NULL,
    label        TEXT         NOT NULL,
    source_work  TEXT,
    prompt_text  TEXT,
    UNIQUE (corpus_id, code)
);

-- The experimental manipulation. Frontier: unconstrained / ariel.
-- Memory: the eight retrieval arms (CRT, MMR, WRAPa, dir3p, MEM,
-- DILUTE, rawmem, DIR).
CREATE TABLE condition (
    condition_id   SERIAL     PRIMARY KEY,
    corpus_id      SMALLINT   NOT NULL REFERENCES corpus(corpus_id),
    code           TEXT       NOT NULL,
    label          TEXT       NOT NULL,
    is_constrained BOOLEAN    NOT NULL DEFAULT TRUE,
    notes          TEXT,
    UNIQUE (corpus_id, code)
);

-- Anyone or anything that produces a score. Kept deliberately wide:
-- model raters and human raters sit in the same table so that
-- inter-rater agreement is one query, not two.
CREATE TABLE rater (
    rater_id     SERIAL       PRIMARY KEY,
    code         TEXT         NOT NULL UNIQUE,
    label        TEXT         NOT NULL,
    kind         TEXT         NOT NULL
                 CHECK (kind IN ('model', 'human', 'visitor')),
    is_blind     BOOLEAN      NOT NULL DEFAULT FALSE,
    notes        TEXT
);

-- The scale lives here, not in application code. Changing the frontier
-- rubric from 0–2 to 0–4 is an UPDATE on one row.
CREATE TABLE rubric (
    rubric_id    SERIAL       PRIMARY KEY,
    corpus_id    SMALLINT     NOT NULL REFERENCES corpus(corpus_id),
    code         TEXT         NOT NULL UNIQUE,
    version      TEXT         NOT NULL,
    scale_min    SMALLINT     NOT NULL DEFAULT 0,
    scale_max    SMALLINT     NOT NULL,
    description  TEXT,
    CHECK (scale_max > scale_min)
);

CREATE TABLE dimension (
    dimension_id SERIAL       PRIMARY KEY,
    rubric_id    INTEGER      NOT NULL REFERENCES rubric(rubric_id) ON DELETE CASCADE,
    code         TEXT         NOT NULL,
    label        TEXT         NOT NULL,
    ordinal      SMALLINT     NOT NULL,
    blurb        TEXT,
    UNIQUE (rubric_id, code),
    UNIQUE (rubric_id, ordinal)
);


-- ---------------------------------------------------------------------
-- Observations
-- ---------------------------------------------------------------------

-- One model response. `replicate` distinguishes repeated draws of the
-- same cell (the memory corpus has five per arm); the frontier corpus
-- has exactly one, so it defaults to 1 and the unique constraint still
-- holds. `letter` is the anonymised label the blind rater saw.
CREATE TABLE run (
    run_id       SERIAL       PRIMARY KEY,
    corpus_id    SMALLINT     NOT NULL REFERENCES corpus(corpus_id),
    model_id     INTEGER      NOT NULL REFERENCES model(model_id),
    stimulus_id  INTEGER      NOT NULL REFERENCES stimulus(stimulus_id),
    condition_id INTEGER      NOT NULL REFERENCES condition(condition_id),
    replicate    SMALLINT     NOT NULL DEFAULT 1 CHECK (replicate > 0),
    letter       TEXT,
    resp_chars   INTEGER      CHECK (resp_chars IS NULL OR resp_chars >= 0),
    source_file  TEXT,
    collected_at DATE,
    UNIQUE (model_id, stimulus_id, condition_id, replicate)
);

CREATE INDEX run_corpus_idx    ON run (corpus_id);
CREATE INDEX run_condition_idx ON run (condition_id);
CREATE INDEX run_model_idx     ON run (model_id);

-- Response text, kept in turn order so the prompt chips and the output
-- paragraphs the site renders survive the round trip.
CREATE TABLE response_segment (
    segment_id   SERIAL       PRIMARY KEY,
    run_id       INTEGER      NOT NULL REFERENCES run(run_id) ON DELETE CASCADE,
    ordinal      SMALLINT     NOT NULL,
    segment_type TEXT         NOT NULL CHECK (segment_type IN ('prompt', 'output')),
    body         TEXT         NOT NULL,
    UNIQUE (run_id, ordinal)
);

-- The many-to-many at the centre: each run scored by each rater on each
-- dimension. `grounded` carries the memory corpus's G/N judgment, which
-- attaches to one dimension rather than to the run as a whole; it is
-- NULL wherever the rubric does not use it.
CREATE TABLE score (
    score_id     SERIAL       PRIMARY KEY,
    run_id       INTEGER      NOT NULL REFERENCES run(run_id) ON DELETE CASCADE,
    rater_id     INTEGER      NOT NULL REFERENCES rater(rater_id),
    dimension_id INTEGER      NOT NULL REFERENCES dimension(dimension_id),
    value        SMALLINT     NOT NULL,
    grounded     BOOLEAN,
    rationale    TEXT,
    UNIQUE (run_id, rater_id, dimension_id)
);

CREATE INDEX score_run_idx   ON score (run_id);
CREATE INDEX score_rater_idx ON score (rater_id);
CREATE INDEX score_dim_idx   ON score (dimension_id);

-- Visitor ratings from the public comparison tool. Holistic, one number
-- per response, deliberately not per-dimension: asking a passer-by to
-- apply a four-dimension rubric would produce noise, not data.
--
-- Anonymous by construction. `session_token` is generated in the
-- browser, lives in sessionStorage only, and dies with the tab. There is
-- no IP column, no user agent, no free-text field, and nothing here can
-- be joined to a person.
CREATE TABLE visitor_rating (
    rating_id     BIGSERIAL   PRIMARY KEY,
    run_id        INTEGER     NOT NULL REFERENCES run(run_id) ON DELETE CASCADE,
    session_token TEXT        NOT NULL CHECK (char_length(session_token) BETWEEN 16 AND 64),
    rating        SMALLINT    NOT NULL CHECK (rating >= 0),
    scale_max     SMALLINT    NOT NULL CHECK (scale_max > 0),
    rated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (rating <= scale_max),
    -- one rating per response per session; a revisit updates rather than stacks
    UNIQUE (run_id, session_token)
);

CREATE INDEX visitor_rating_run_idx  ON visitor_rating (run_id);
CREATE INDEX visitor_rating_time_idx ON visitor_rating (rated_at);


-- ---------------------------------------------------------------------
-- Views — the joins nobody should have to retype
-- ---------------------------------------------------------------------

CREATE VIEW v_score AS
SELECT
    s.score_id,
    c.code            AS corpus,
    m.name            AS model,
    st.code           AS stimulus,
    cond.code         AS condition,
    cond.is_constrained,
    r.replicate,
    r.letter,
    r.resp_chars,
    ra.code           AS rater,
    ra.kind           AS rater_kind,
    d.code            AS dimension,
    d.label           AS dimension_label,
    s.value,
    s.grounded,
    rub.scale_max
FROM score s
JOIN run       r    ON r.run_id       = s.run_id
JOIN corpus    c    ON c.corpus_id    = r.corpus_id
JOIN model     m    ON m.model_id     = r.model_id
JOIN stimulus  st   ON st.stimulus_id = r.stimulus_id
JOIN condition cond ON cond.condition_id = r.condition_id
JOIN rater     ra   ON ra.rater_id    = s.rater_id
JOIN dimension d    ON d.dimension_id = s.dimension_id
JOIN rubric    rub  ON rub.rubric_id  = d.rubric_id;

-- Per run and rater: the rubric total, and how many dimensions it came
-- from. The count matters — a total of 6 from three dimensions is not
-- comparable to a total of 6 from four.
CREATE VIEW v_run_total AS
SELECT
    r.run_id,
    c.code   AS corpus,
    m.name   AS model,
    st.code  AS stimulus,
    cond.code AS condition,
    r.replicate,
    ra.code  AS rater,
    SUM(s.value)                       AS total,
    COUNT(*)                           AS dimensions_scored,
    MAX(rub.scale_max) * COUNT(*)      AS total_possible
FROM score s
JOIN run       r    ON r.run_id       = s.run_id
JOIN corpus    c    ON c.corpus_id    = r.corpus_id
JOIN model     m    ON m.model_id     = r.model_id
JOIN stimulus  st   ON st.stimulus_id = r.stimulus_id
JOIN condition cond ON cond.condition_id = r.condition_id
JOIN rater     ra   ON ra.rater_id    = s.rater_id
JOIN dimension d    ON d.dimension_id = s.dimension_id
JOIN rubric    rub  ON rub.rubric_id  = d.rubric_id
GROUP BY r.run_id, c.code, m.name, st.code, cond.code, r.replicate, ra.code;

COMMIT;
