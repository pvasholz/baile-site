-- =====================================================================
--  Ariel scoring database — analytical queries
--  PostgreSQL. Each block stands alone; run them individually.
-- =====================================================================


-- ---------------------------------------------------------------------
-- Q1. Coverage. Which cells exist, which are scored, which are neither.
--     The grid is ragged and the first job of any query set is to say so
--     out loud rather than let a later AVG() quietly skip the holes.
-- ---------------------------------------------------------------------
SELECT
    m.name                                                   AS model,
    st.label                                                 AS stimulus,
    COUNT(*) FILTER (WHERE NOT cond.is_constrained)          AS unconstrained_runs,
    COUNT(*) FILTER (WHERE cond.is_constrained)              AS ariel_runs,
    COUNT(*) FILTER (WHERE sc.run_id IS NOT NULL)            AS scored_runs
FROM run r
JOIN model     m    ON m.model_id        = r.model_id
JOIN stimulus  st   ON st.stimulus_id    = r.stimulus_id
JOIN condition cond ON cond.condition_id = r.condition_id
LEFT JOIN (SELECT DISTINCT run_id FROM score) sc ON sc.run_id = r.run_id
WHERE r.corpus_id = 1
GROUP BY m.name, st.label
ORDER BY m.name, st.label;


-- ---------------------------------------------------------------------
-- Q2. Frontier rank ordering, with the sample size attached.
--     n is 1 per cell. Reporting the mean without n would invite exactly
--     the reading the data cannot support, so n rides along.
-- ---------------------------------------------------------------------
SELECT
    model,
    COUNT(DISTINCT run_id)                     AS cells_scored,
    COUNT(*)                                   AS rater_totals,
    ROUND(AVG(total), 2)                       AS mean_total,
    MIN(total)                                 AS min_total,
    MAX(total)                                 AS max_total,
    MAX(total_possible)                        AS possible
FROM v_run_total
WHERE corpus = 'frontier'
GROUP BY model
ORDER BY mean_total DESC, model;


-- ---------------------------------------------------------------------
-- Q3. Dimension profile per model. Where a total hides its shape —
--     two models on the same total can fail in different places.
-- ---------------------------------------------------------------------
SELECT
    model,
    stimulus,
    rater,
    MAX(value) FILTER (WHERE dimension = 'closure')      AS d1_closure,
    MAX(value) FILTER (WHERE dimension = 'uncertainty')  AS d2_uncertainty,
    MAX(value) FILTER (WHERE dimension = 'substitution') AS d3_substitution,
    MAX(value) FILTER (WHERE dimension = 'selfassess')   AS d4_selfassess
FROM v_score
WHERE corpus = 'frontier'
GROUP BY model, stimulus, rater
ORDER BY model, stimulus, rater;


-- ---------------------------------------------------------------------
-- Q4. G-rate by arm, per rater — the memory corpus headline.
--     A "G" is a grounded refusal to settle; an "N" merely names the
--     uncertainty. Rates are per rater because the two raters disagree
--     often enough that a pooled figure would be misleading (see Q5).
-- ---------------------------------------------------------------------
SELECT
    cond.code                                         AS arm,
    ra.code                                           AS rater,
    COUNT(*)                                          AS n,
    COUNT(*) FILTER (WHERE s.grounded)                AS grounded,
    ROUND(100.0 * COUNT(*) FILTER (WHERE s.grounded) / COUNT(*), 1) AS g_rate_pct
FROM score s
JOIN dimension d    ON d.dimension_id  = s.dimension_id
JOIN run       r    ON r.run_id        = s.run_id
JOIN condition cond ON cond.condition_id = r.condition_id
JOIN rater     ra   ON ra.rater_id     = s.rater_id
WHERE d.code = 'D2' AND s.grounded IS NOT NULL
GROUP BY cond.code, ra.code
ORDER BY arm, rater;


-- ---------------------------------------------------------------------
-- Q5. Inter-rater agreement on the G/N judgment, with Cohen's kappa.
--     Raw agreement flatters a lopsided marginal: one rater says G 54%
--     of the time, the other 26%, so chance agreement is high. Kappa
--     corrects for that, and is the number worth quoting.
-- ---------------------------------------------------------------------
WITH pairs AS (
    SELECT
        s.run_id,
        BOOL_OR(s.grounded) FILTER (WHERE ra.code = 'opus') AS opus_g,
        BOOL_OR(s.grounded) FILTER (WHERE ra.code = 'mimo') AS mimo_g
    FROM score s
    JOIN dimension d  ON d.dimension_id = s.dimension_id
    JOIN rater     ra ON ra.rater_id    = s.rater_id
    WHERE d.code = 'D2' AND s.grounded IS NOT NULL
    GROUP BY s.run_id
),
counts AS (
    SELECT
        COUNT(*)::numeric                                              AS n,
        COUNT(*) FILTER (WHERE opus_g AND mimo_g)::numeric             AS both_g,
        COUNT(*) FILTER (WHERE NOT opus_g AND NOT mimo_g)::numeric     AS both_n,
        COUNT(*) FILTER (WHERE opus_g)::numeric                        AS opus_g,
        COUNT(*) FILTER (WHERE mimo_g)::numeric                        AS mimo_g
    FROM pairs
),
k AS (
    -- NULLIF guards keep this returning a row rather than raising when the
    -- table is empty (n = 0) or the raters agree perfectly (p_chance = 1).
    SELECT
        n,
        both_g, both_n,
        (both_g + both_n) / NULLIF(n, 0)                               AS p_observed,
        ((opus_g / NULLIF(n, 0)) * (mimo_g / NULLIF(n, 0)))
          + ((1 - opus_g / NULLIF(n, 0)) * (1 - mimo_g / NULLIF(n, 0))) AS p_chance
    FROM counts
)
SELECT
    n                                        AS runs,
    both_g                                   AS agree_grounded,
    both_n                                   AS agree_named,
    ROUND(100 * p_observed, 1)               AS observed_agreement_pct,
    ROUND(100 * p_chance, 1)                 AS chance_agreement_pct,
    ROUND((p_observed - p_chance) / NULLIF(1 - p_chance, 0), 3) AS cohens_kappa
FROM k;


-- ---------------------------------------------------------------------
-- Q6. Where the raters part company, and in which direction.
--     Systematic disagreement (one rater consistently stricter) is a
--     different problem from noisy disagreement, and this separates them.
-- ---------------------------------------------------------------------
WITH pairs AS (
    SELECT
        r.run_id,
        r.letter,
        cond.code AS arm,
        MAX(s.value) FILTER (WHERE ra.code = 'opus') AS opus_d2,
        MAX(s.value) FILTER (WHERE ra.code = 'mimo') AS mimo_d2
    FROM score s
    JOIN dimension d    ON d.dimension_id  = s.dimension_id
    JOIN run       r    ON r.run_id        = s.run_id
    JOIN condition cond ON cond.condition_id = r.condition_id
    JOIN rater     ra   ON ra.rater_id     = s.rater_id
    WHERE d.code = 'D2'
    GROUP BY r.run_id, r.letter, cond.code
)
SELECT
    opus_d2 - mimo_d2        AS opus_minus_mimo,
    COUNT(*)                 AS runs,
    STRING_AGG(letter, ', ' ORDER BY letter) AS which
FROM pairs
GROUP BY opus_d2 - mimo_d2
ORDER BY opus_minus_mimo;


-- ---------------------------------------------------------------------
-- Q7. Response length against grounding — the confound worth ruling out.
--     If longer answers simply score better, the arms are measuring
--     verbosity. Length bands are quartiles so the split is data-driven.
-- ---------------------------------------------------------------------
WITH banded AS (
    SELECT
        r.run_id,
        r.resp_chars,
        NTILE(4) OVER (ORDER BY r.resp_chars) AS quartile,
        BOOL_OR(s.grounded) FILTER (WHERE ra.code = 'opus') AS opus_g
    FROM run r
    JOIN score     s  ON s.run_id       = r.run_id
    JOIN dimension d  ON d.dimension_id = s.dimension_id
    JOIN rater     ra ON ra.rater_id    = s.rater_id
    WHERE r.corpus_id = 2 AND d.code = 'D2'
    GROUP BY r.run_id, r.resp_chars
)
SELECT
    quartile,
    COUNT(*)                                     AS n,
    MIN(resp_chars)                              AS min_chars,
    MAX(resp_chars)                              AS max_chars,
    COUNT(*) FILTER (WHERE opus_g)               AS grounded,
    ROUND(100.0 * COUNT(*) FILTER (WHERE opus_g) / COUNT(*), 1) AS g_rate_pct
FROM banded
GROUP BY quartile
ORDER BY quartile;


-- ---------------------------------------------------------------------
-- Q8. Arm ranking by mean D2, both raters pooled, with spread.
--     STDDEV over five replicates is the honest companion to the mean:
--     an arm that averages 2.6 with zero spread is a different claim
--     from one that averages 2.6 by swinging between 2 and 4.
-- ---------------------------------------------------------------------
SELECT
    cond.code                          AS arm,
    COUNT(*)                           AS observations,
    ROUND(AVG(s.value), 2)             AS mean_d2,
    ROUND(STDDEV_SAMP(s.value), 2)     AS sd_d2,
    MIN(s.value)                       AS min_d2,
    MAX(s.value)                       AS max_d2
FROM score s
JOIN dimension d    ON d.dimension_id  = s.dimension_id
JOIN run       r    ON r.run_id        = s.run_id
JOIN condition cond ON cond.condition_id = r.condition_id
WHERE d.code = 'D2'
GROUP BY cond.code
ORDER BY mean_d2 DESC, arm;


-- ---------------------------------------------------------------------
-- Q9. Visitor ratings against the house rubric.
--     Returns nothing until the site has collected some; that is the
--     correct behaviour, not a bug.
-- ---------------------------------------------------------------------
SELECT
    m.name                                  AS model,
    st.label                                AS stimulus,
    cond.label                              AS condition,
    COUNT(vr.rating_id)                     AS n_visitors,
    ROUND(AVG(vr.rating), 2)                AS visitor_mean,
    ROUND(STDDEV_SAMP(vr.rating), 2)        AS visitor_sd,
    rt.total                                AS house_total,
    ROUND(AVG(vr.rating) - rt.total, 2)     AS visitor_minus_house
FROM visitor_rating vr
JOIN run        r    ON r.run_id        = vr.run_id
JOIN model      m    ON m.model_id      = r.model_id
JOIN stimulus   st   ON st.stimulus_id  = r.stimulus_id
JOIN condition  cond ON cond.condition_id = r.condition_id
JOIN v_run_total rt  ON rt.run_id       = r.run_id
GROUP BY m.name, st.label, cond.label, rt.total
HAVING COUNT(vr.rating_id) > 0
ORDER BY n_visitors DESC, model;


-- ---------------------------------------------------------------------
-- Q10. Data integrity. Every row should come back zero; anything else
--      means the seed or a later insert broke an invariant the schema
--      cannot express as a constraint.
-- ---------------------------------------------------------------------
SELECT 'score outside its rubric scale' AS check_name, COUNT(*) AS violations
FROM score s
JOIN dimension d ON d.dimension_id = s.dimension_id
JOIN rubric   rb ON rb.rubric_id   = d.rubric_id
WHERE s.value < rb.scale_min OR s.value > rb.scale_max

UNION ALL
SELECT 'run scored on a dimension from another corpus', COUNT(*)
FROM score s
JOIN dimension d ON d.dimension_id = s.dimension_id
JOIN rubric   rb ON rb.rubric_id   = d.rubric_id
JOIN run      r  ON r.run_id       = s.run_id
WHERE rb.corpus_id <> r.corpus_id

UNION ALL
SELECT 'partially scored run (some dimensions missing)', COUNT(*)
FROM (
    SELECT s.run_id, s.rater_id, COUNT(*) AS scored,
           (SELECT COUNT(*) FROM dimension d2
             JOIN rubric rb2 ON rb2.rubric_id = d2.rubric_id
             JOIN run r2 ON r2.run_id = s.run_id
            WHERE rb2.corpus_id = r2.corpus_id) AS expected
    FROM score s
    GROUP BY s.run_id, s.rater_id
) t
WHERE scored <> expected

UNION ALL
SELECT 'G/N flag set on a dimension other than D2', COUNT(*)
FROM score s
JOIN dimension d ON d.dimension_id = s.dimension_id
WHERE s.grounded IS NOT NULL AND d.code <> 'D2'

UNION ALL
SELECT 'G/N inconsistent with the D2 value (G iff D2 >= 3)', COUNT(*)
FROM score s
JOIN dimension d ON d.dimension_id = s.dimension_id
WHERE d.code = 'D2' AND s.grounded IS NOT NULL
  AND s.grounded <> (s.value >= 3)

UNION ALL
-- A run may legitimately have scores but no transcript (rated, text not
-- published) or a transcript but no scores (collected, never rated).
-- A run with neither is an orphan and should not exist.
SELECT 'orphan run: neither transcript nor scores', COUNT(*)
FROM run r
WHERE NOT EXISTS (SELECT 1 FROM response_segment rs WHERE rs.run_id = r.run_id)
  AND NOT EXISTS (SELECT 1 FROM score sc WHERE sc.run_id = r.run_id)

UNION ALL
SELECT 'rater scored some but not all dimensions of a cell', COUNT(*)
FROM (
    SELECT s.run_id, s.rater_id, COUNT(DISTINCT s.dimension_id) AS n
    FROM score s GROUP BY s.run_id, s.rater_id
) t
JOIN run r ON r.run_id = t.run_id
JOIN rubric rb ON rb.corpus_id = r.corpus_id
WHERE t.n <> (SELECT COUNT(*) FROM dimension d WHERE d.rubric_id = rb.rubric_id);


-- ---------------------------------------------------------------------
-- Q11. Frontier inter-rater spread, per dimension.
--      Three raters on an ordinal 0–4 scale, so exact agreement and the
--      observed range say more than a correlation would. A dimension
--      where the raters never disagree AND never use the low end is not
--      reliable — it is inert, which is the story for D1 here.
-- ---------------------------------------------------------------------
WITH cell AS (
    SELECT
        s.run_id,
        d.code                       AS dimension,
        d.ordinal,
        MIN(s.value)                 AS lo,
        MAX(s.value)                 AS hi,
        COUNT(DISTINCT s.rater_id)   AS raters
    FROM score s
    JOIN dimension d ON d.dimension_id = s.dimension_id
    JOIN rubric   rb ON rb.rubric_id   = d.rubric_id
    WHERE rb.corpus_id = 1
    GROUP BY s.run_id, d.code, d.ordinal
)
SELECT
    dimension,
    COUNT(*)                                                   AS cells,
    ROUND(100.0 * COUNT(*) FILTER (WHERE lo = hi) / COUNT(*), 1) AS all_agree_pct,
    MAX(hi - lo)                                               AS max_spread,
    MIN(lo)                                                    AS lowest_used,
    MAX(hi)                                                    AS highest_used
FROM cell
WHERE raters > 1
GROUP BY dimension, ordinal
ORDER BY ordinal;


-- ---------------------------------------------------------------------
-- Q12. Rater severity on the frontier corpus. A consistent offset is a
--      calibration problem and can be corrected for; disagreement that
--      is not an offset cannot.
-- ---------------------------------------------------------------------
SELECT
    rater,
    COUNT(*)                       AS cells,
    ROUND(AVG(total), 2)           AS mean_total,
    MIN(total)                     AS min_total,
    MAX(total)                     AS max_total
FROM v_run_total
WHERE corpus = 'frontier'
GROUP BY rater
ORDER BY mean_total DESC;
