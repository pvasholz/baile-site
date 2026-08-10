/* Baile Research Institute — Ariel response comparison
 * ----------------------------------------------------
 * All content lives in data/ariel-comparison.json. This file is presentation only.
 *
 * To move from the 0–2 rubric to the 0–4 rubric, edit the JSON:
 *   rubric.scaleMax   2 -> 4
 *   rubric.dimensions relabel / re-key as needed
 *   scores            replace the values
 * Nothing in this file needs to change.
 *
 * To turn on rating collection, set RATING_ENDPOINT to your function URL.
 * While it is null the widget still works and simply does not transmit.
 */
(function () {
  'use strict';

  // Set to '/api/rate' once the Netlify function and Neon database are live.
  // While null the widget still works and simply does not transmit.
  var RATING_ENDPOINT = null;
  var DATA_URL = 'data/ariel-comparison.json';

  var D = null;                    // loaded dataset
  var state = { text: null, aModel: null, aCond: null, bModel: null, bCond: null };

  // Scores are always visible. Rating is an optional invitation, never a toll gate:
  // `offered` tracks whether the visitor has dismissed or answered the prompt for a side,
  // `given` holds their number once submitted.
  var dismissed = { a: false, b: false };
  var given = { a: null, b: null };
  var sessionToken = null;

  /* ---------- helpers ---------- */

  function key(model, text, cond) { return model + '||' + text + '||' + cond; }

  function el(id) { return document.getElementById(id); }

  function text(node, str) { node.textContent = str; return node; }

  function make(tag, cls, str) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (str != null) n.textContent = str;
    return n;
  }

  function condLabel(k) {
    for (var i = 0; i < D.conditions.length; i++) {
      if (D.conditions[i].key === k) return D.conditions[i].label;
    }
    return k;
  }

  function token() {
    if (sessionToken) return sessionToken;
    try {
      sessionToken = sessionStorage.getItem('br-rate-session');
    } catch (e) { /* storage blocked — fall through to a memory-only token */ }
    if (!sessionToken) {
      var buf = new Uint8Array(16);
      (window.crypto || window.msCrypto).getRandomValues(buf);
      sessionToken = Array.prototype.map
        .call(buf, function (b) { return ('0' + b.toString(16)).slice(-2); })
        .join('');
      try { sessionStorage.setItem('br-rate-session', sessionToken); } catch (e) {}
    }
    return sessionToken;
  }

  /* ---------- controls ---------- */

  function buildControls() {
    var seg = el('textSeg');
    seg.replaceChildren();
    D.texts.forEach(function (t) {
      var b = make('button', null, t);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', t === state.text ? 'true' : 'false');
      b.addEventListener('click', function () {
        state.text = t;
        resetRating();
        buildControls();
        render();
      });
      seg.appendChild(b);
    });

    [['aModel', 'aCond', 'a'], ['bModel', 'bCond', 'b']].forEach(function (pair) {
      var ms = el(pair[0]), cs = el(pair[1]);
      ms.replaceChildren();
      D.models.forEach(function (m) {
        var o = make('option', null, m);
        o.value = m;
        if (m === state[pair[0]]) o.selected = true;
        ms.appendChild(o);
      });
      cs.replaceChildren();
      D.conditions.forEach(function (c) {
        var o = make('option', null, c.label);
        o.value = c.key;
        if (c.key === state[pair[1]]) o.selected = true;
        cs.appendChild(o);
      });
      ms.onchange = function (e) { state[pair[0]] = e.target.value; resetRating(pair[2]); render(); };
      cs.onchange = function (e) { state[pair[1]] = e.target.value; resetRating(pair[2]); render(); };
    });
  }

  function resetRating(side) {
    if (side) { dismissed[side] = false; given[side] = null; }
    else { dismissed.a = dismissed.b = false; given.a = given.b = null; }
  }

  /* ---------- score board ---------- */

  function renderHead(node, model, cond, sc) {
    node.replaceChildren();
    node.appendChild(make('p', 'cmp-model', model));
    node.appendChild(make('p', 'cmp-cond', condLabel(cond)));

    if (!sc) {
      node.appendChild(make('p', 'cmp-unscored', 'Not scored under the rubric'));
      return;
    }
    var total = 0;
    D.rubric.dimensions.forEach(function (d) { total += sc[d.key]; });
    var max = D.rubric.scaleMax * D.rubric.dimensions.length;

    var wrap = make('p', 'cmp-total');
    var b = make('b', null, String(total));
    wrap.appendChild(b);
    wrap.appendChild(document.createTextNode(' / ' + max));
    node.appendChild(wrap);
  }

  function cell(side, val) {
    var c = make('div', 'cmp-cell cmp-cell-' + side);
    var bw = make('div', 'cmp-barwrap');
    var tr = make('div', 'cmp-track');
    var fl = make('div', 'cmp-fill');
    fl.style.width = (val == null ? 0 : (val / D.rubric.scaleMax) * 100) + '%';
    tr.appendChild(fl);
    bw.appendChild(tr);
    var v = make('span', 'cmp-val' + (val == null ? ' cmp-val-empty' : ''), val == null ? '—' : String(val));
    if (val == null) v.setAttribute('aria-label', 'not scored');
    if (side === 'a') { c.appendChild(v); c.appendChild(bw); }
    else { c.appendChild(bw); c.appendChild(v); }
    return c;
  }

  function renderRows(aSc, bSc) {
    var rows = el('rows');
    rows.replaceChildren();
    D.rubric.dimensions.forEach(function (d) {
      var r = make('div', 'cmp-row');
      r.appendChild(cell('a', aSc ? aSc[d.key] : null));
      r.appendChild(make('div', 'cmp-dim', d.label));
      r.appendChild(cell('b', bSc ? bSc[d.key] : null));
      rows.appendChild(r);
    });
  }

  /* ---------- response panels ---------- */

  function renderResponse(bodyId, tagId, rateId, side, model, cond) {
    var k = key(model, state.text, cond);
    var segs = D.responses[k];
    var body = el(bodyId);
    var rate = el(rateId);

    text(el(tagId), model + ' · ' + condLabel(cond));
    body.replaceChildren();

    if (!segs || !segs.length) {
      rate.hidden = true;
      body.appendChild(make('p', 'cmp-missing',
        'This run was not collected. There is no response to show for ' +
        model + ' on “' + state.text + '” in the ' + condLabel(cond).toLowerCase() + ' condition.'));
      return;
    }

    segs.forEach(function (s) {
      body.appendChild(make('p', s.type === 'prompt' ? 'cmp-prompt' : null, s.text));
    });

    // Optional rating. Scores above are already visible either way.
    if (!D.scores[k] || dismissed[side]) {
      rate.hidden = true;
      rate.replaceChildren();
    } else if (given[side] != null) {
      showOutcome(rate, side, k);
    } else {
      buildRating(rate, side, k);
    }
  }

  function showOutcome(rate, side, k) {
    var max = D.rubric.scaleMax * D.rubric.dimensions.length;
    var ours = 0;
    D.rubric.dimensions.forEach(function (d) { ours += D.scores[k][d.key]; });

    rate.hidden = false;
    rate.replaceChildren();
    var p = make('p', 'cmp-rate-done');
    p.appendChild(document.createTextNode('You gave '));
    p.appendChild(make('b', null, given[side] + '/' + max));
    p.appendChild(document.createTextNode('; the rubric total above is '));
    p.appendChild(make('b', null, ours + '/' + max));
    p.appendChild(document.createTextNode('. Thank you.'));
    rate.appendChild(p);
  }

  function buildRating(rate, side, k) {
    rate.hidden = false;
    rate.replaceChildren();

    var dims = D.rubric.dimensions.map(function (d) { return d.label.toLowerCase(); });
    var max = D.rubric.scaleMax * D.rubric.dimensions.length;

    rate.appendChild(make('p', 'cmp-rate-q',
      'Optional: how would you score this response yourself, against ' + dims.join(', ') +
      '? Out of ' + max + '.'));

    var scale = make('div', 'cmp-rate-scale');
    for (var i = 0; i <= max; i++) {
      (function (n) {
        var b = make('button', null, String(n));
        b.type = 'button';
        b.addEventListener('click', function () { submitRating(rate, side, k, n, max); });
        scale.appendChild(b);
      })(i);
    }
    var skip = make('button', 'cmp-rate-skip', 'No thanks');
    skip.type = 'button';
    skip.addEventListener('click', function () {
      dismissed[side] = true;
      rate.hidden = true;
      rate.replaceChildren();
    });
    scale.appendChild(skip);
    rate.appendChild(scale);
  }

  function submitRating(rate, side, k, n, max) {
    given[side] = n;
    var parts = k.split('||');

    if (RATING_ENDPOINT) {
      var payload = {
        session: token(),
        model: parts[0],
        stimulus: parts[1],
        condition: parts[2],
        rating: n,
        scale_max: max,
        rated_at: new Date().toISOString()
      };
      try {
        fetch(RATING_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          keepalive: true
        }).catch(function () { /* collection is best-effort; the page must not degrade */ });
      } catch (e) { /* ignore */ }
    }
    render();
  }

  /* ---------- rubric key ---------- */

  function renderRubric() {
    var dl = el('rubricDl');
    dl.replaceChildren();
    D.rubric.dimensions.forEach(function (d) {
      dl.appendChild(make('dt', null, d.label + '  (0–' + D.rubric.scaleMax + ')'));
      dl.appendChild(make('dd', null, d.blurb));
    });
    text(el('lim-max'), String(D.rubric.scaleMax));
  }

  /* ---------- main ---------- */

  function render() {
    var aK = key(state.aModel, state.text, state.aCond);
    var bK = key(state.bModel, state.text, state.bCond);
    var aSc = D.scores[aK] || null;
    var bSc = D.scores[bK] || null;

    renderHead(el('headA'), state.aModel, state.aCond, aSc);
    renderHead(el('headB'), state.bModel, state.bCond, bSc);
    renderRows(aSc, bSc);
    renderResponse('respA', 'rtagA', 'rateA', 'a', state.aModel, state.aCond);
    renderResponse('respB', 'rtagB', 'rateB', 'b', state.bModel, state.bCond);
  }

  function boot(data) {
    D = data;
    state.text = D.texts[0];
    state.aModel = D.models[0];
    state.bModel = D.models[0];
    state.aCond = D.conditions[0].key;
    state.bCond = D.conditions[D.conditions.length - 1].key;
    buildControls();
    renderRubric();
    render();
  }

  function fail(err) {
    var rows = el('rows');
    if (!rows) return;
    rows.replaceChildren();
    rows.appendChild(make('div', 'cmp-row',
      'The comparison data could not be loaded. If you are opening this file directly from ' +
      'disk, run a local server instead — browsers block fetch() on file:// URLs.'));
    if (window.console) console.error('[comparison]', err);
  }

  function init() {
    fetch(DATA_URL, { cache: 'no-cache' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(boot)
      .catch(fail);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
