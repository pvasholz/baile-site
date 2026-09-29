/**
 * POST /api/rate   (see `config.path` at the bottom of this file)
 *
 * Accepts one visitor rating from the comparison tool and inserts it.
 * Deliberately small, and deliberately incapable of doing anything else:
 * it cannot read ratings back, cannot touch any other table, and stores
 * nothing that identifies a person.
 *
 * Environment:
 *   NETLIFY_DATABASE_URL  Neon connection string (pooled endpoint)
 *   ALLOWED_ORIGIN        https://baile.institute
 *
 * Deploy notes: "Turning the ratings function on" in the top-level README.md.
 */

import { neon } from '@netlify/neon';

const sql = neon();                       // reads NETLIFY_DATABASE_URL

const ORIGIN = process.env.ALLOWED_ORIGIN || 'https://baile.institute';

// Tiny in-memory throttle. Serverless instances are short-lived and not
// shared, so this stops a casual click-loop rather than a determined
// attacker — the UNIQUE (run_id, session_token) constraint in the schema
// is what actually bounds the damage.
const seen = new Map();
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;

function cors(extra = {}) {
  return {
    'Access-Control-Allow-Origin': ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    ...extra,
  };
}

const fail = (status, message) =>
  new Response(JSON.stringify({ ok: false, error: message }), { status, headers: cors() });

function throttled(token) {
  const now = Date.now();
  const hits = (seen.get(token) || []).filter((t) => now - t < WINDOW_MS);
  hits.push(now);
  seen.set(token, hits);
  if (seen.size > 500) seen.clear();       // bound memory; correctness does not depend on this
  return hits.length > MAX_PER_WINDOW;
}

export default async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
  if (request.method !== 'POST') return fail(405, 'POST only');

  let body;
  try {
    body = await request.json();
  } catch {
    return fail(400, 'body must be JSON');
  }

  const { session, model, stimulus, condition, rating, scale_max } = body ?? {};

  // --- validation. Everything is checked here as well as in the schema,
  // --- because a 400 is a better answer than a constraint violation.
  if (typeof session !== 'string' || !/^[0-9a-f]{16,64}$/.test(session))
    return fail(400, 'bad session token');
  if (![model, stimulus, condition].every((v) => typeof v === 'string' && v.length > 0 && v.length <= 120))
    return fail(400, 'bad cell identifiers');
  if (!Number.isInteger(rating) || !Number.isInteger(scale_max)) return fail(400, 'ratings must be integers');
  if (scale_max < 1 || scale_max > 100) return fail(400, 'bad scale');
  if (rating < 0 || rating > scale_max) return fail(400, 'rating out of range');

  if (throttled(session)) return fail(429, 'slow down');

  try {
    // Resolve the cell to a run_id. If the triple does not name a real
    // run, reject rather than inventing one — an unmatched rating is a
    // bug somewhere, not data.
    const rows = await sql`
      SELECT r.run_id
        FROM run r
        JOIN model     m    ON m.model_id        = r.model_id
        JOIN stimulus  st   ON st.stimulus_id    = r.stimulus_id
        JOIN condition cond ON cond.condition_id = r.condition_id
       WHERE m.name = ${model}
         AND st.label = ${stimulus}
         AND LOWER(cond.code) = LOWER(${condition})
         AND r.corpus_id = 1
       LIMIT 1`;

    if (rows.length === 0) return fail(404, 'unknown cell');

    await sql`
      INSERT INTO visitor_rating (run_id, session_token, rating, scale_max)
      VALUES (${rows[0].run_id}, ${session}, ${rating}, ${scale_max})
      ON CONFLICT (run_id, session_token)
      DO UPDATE SET rating = EXCLUDED.rating, rated_at = now()`;

    return new Response(JSON.stringify({ ok: true }), { status: 201, headers: cors() });
  } catch (err) {
    console.error('rate insert failed', err);
    return fail(500, 'could not record rating');
  }
};

export const config = { path: '/api/rate' };
