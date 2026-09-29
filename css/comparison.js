/* Baile Research Institute — Ariel response comparison
 * ----------------------------------------------------
 * All content lives in data/ariel-comparison.json. This file is presentation only.
 *
 * Scores are per rater: scores["Model||Text||Condition"][raterKey][dimKey].
 * The bars show the mean across raters; a tick on each bar marks each
 * rater's own score, so disagreement stays visible instead of being
 * averaged away. The scale, dimensions and raters all come from the JSON.
 *
 * display.hideUnscoredModels drops models with no scored cell from the
 * pickers. Their responses stay in the file for the database.
 */
(function () {
  'use strict';

  // The Netlify function (netlify/functions/rate.mjs). Set to null to stop
  // transmitting; the widget keeps working either way.
  var RATING_ENDPOINT = '/api/rate';
  var DATA_URL = 'data/ariel-comparison.json';

  var D = null;                    // loaded dataset
  var MODELS = [];                 // models offered in the pickers
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

  function raters() {
    return D.raters || [];
  }

  // Mean of the raters' scores on one dimension, or null if nobody scored it.
  function meanOf(sc, dimKey) {
    var sum = 0, n = 0;
    raters().forEach(function (r) {
      var v = sc[r.key] && sc[r.key][dimKey];
      if (typeof v === 'number') { sum += v; n++; }
    });
    return n ? sum / n : null;
  }

  function meanTotal(sc) {
    var t = 0;
    D.rubric.dimensions.forEach(function (d) { t += meanOf(sc, d.key) || 0; });
    return t;
  }

  function raterTotal(sc, raterKey) {
    var t = 0;
    D.rubric.dimensions.forEach(function (d) { t += sc[raterKey][d.key]; });
    return t;
  }

  function maxTotal() { return D.rubric.scaleMax * D.rubric.dimensions.length; }

  function fmt(x) { return x.toFixed(1); }

  var WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  function words(n) { return n < WORDS.length ? WORDS[n] : String(n); }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  function hasResponse(model, cond) {
    var segs = D.responses[key(model, state.text, cond)];
    return !!(segs && segs.length);
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
      MODELS.forEach(function (m) {
        var o = make('option', null, m);
        o.value = m;
        if (m === state[pair[0]]) o.selected = true;
        ms.appendChild(o);
      });
      cs.replaceChildren();
      D.conditions.forEach(function (c) {
        var label = hasResponse(state[pair[0]], c.key) ? c.label : c.label + ' — not collected';
        var o = make('option', null, label);
        o.value = c.key;
        if (c.key === state[pair[1]]) o.selected = true;
        cs.appendChild(o);
      });
      ms.onchange = function (e) { state[pair[0]] = e.target.value; resetRating(pair[2]); buildControls(); render(); };
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
    var wrap = make('p', 'cmp-total');
    wrap.appendChild(make('b', null, fmt(meanTotal(sc))));
    wrap.appendChild(document.createTextNode(' / ' + maxTotal() + ' average'));
    node.appendChild(wrap);

    var each = raters().filter(function (r) { return sc[r.key]; }).map(function (r) {
      return r.key + ' ' + raterTotal(sc, r.key);
    });
    node.appendChild(make('p', 'cmp-raters', each.join(' · ')));
  }

  function cell(side, sc, dim) {
    var val = sc ? meanOf(sc, dim.key) : null;
    var c = make('div', 'cmp-cell cmp-cell-' + side);
    var bw = make('div', 'cmp-barwrap');
    var tr = make('div', 'cmp-track');
    var fl = make('div', 'cmp-fill');
    fl.style.width = (val == null ? 0 : (val / D.rubric.scaleMax) * 100) + '%';
    tr.appendChild(fl);

    var v = make('span', 'cmp-val' + (val == null ? ' cmp-val-empty' : ''), val == null ? '—' : fmt(val));
    if (val == null) {
      v.setAttribute('aria-label', 'not scored');
    } else {
      // One tick per rater. Measured from the bar's origin, which is the
      // right edge on the left-hand panel (its bars grow leftward).
      var parts = [];
      raters().forEach(function (r) {
        var rv = sc[r.key] && sc[r.key][dim.key];
        if (typeof rv !== 'number') return;
        var t = make('span', 'cmp-tick');
        t.style.setProperty('--at', String(rv / D.rubric.scaleMax));
        tr.appendChild(t);
        parts.push(r.key + ' ' + rv);
      });
      var desc = dim.label + ': average ' + fmt(val) + ' of ' + D.rubric.scaleMax + ' (' + parts.join(', ') + ')';
      bw.title = desc;
      v.setAttribute('aria-label', desc);
    }
    bw.appendChild(tr);
    if (side === 'a') { c.appendChild(v); c.appendChild(bw); }
    else { c.appendChild(bw); c.appendChild(v); }
    return c;
  }

  function renderRows(aSc, bSc) {
    var rows = el('rows');
    rows.replaceChildren();
    D.rubric.dimensions.forEach(function (d) {
      var r = make('div', 'cmp-row');
      r.appendChild(cell('a', aSc, d));
      r.appendChild(make('div', 'cmp-dim', d.label));
      r.appendChild(cell('b', bSc, d));
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
    var max = maxTotal();

    rate.hidden = false;
    rate.replaceChildren();
    var p = make('p', 'cmp-rate-done');
    p.appendChild(document.createTextNode('You gave '));
    p.appendChild(make('b', null, given[side] + '/' + max));
    p.appendChild(document.createTextNode('; the raters averaged '));
    p.appendChild(make('b', null, fmt(meanTotal(D.scores[k])) + '/' + max));
    p.appendChild(document.createTextNode('. Thank you.'));
    rate.appendChild(p);
  }

  function buildRating(rate, side, k) {
    rate.hidden = false;
    rate.replaceChildren();

    var dims = D.rubric.dimensions.map(function (d) { return d.label.toLowerCase(); });
    var max = maxTotal();

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
      var dd = make('dd', null, d.blurb);
      if (d.anchors) {
        var ol = make('ul', 'cmp-anchors');
        for (var v = D.rubric.scaleMax; v >= (D.rubric.scaleMin || 0); v--) {
          if (d.anchors[v] == null) continue;
          var li = make('li');
          li.appendChild(make('b', null, String(v)));
          li.appendChild(document.createTextNode(' ' + d.anchors[v]));
          ol.appendChild(li);
        }
        dd.appendChild(ol);
      }
      dl.appendChild(dd);
    });
    if (D.rubric.note) text(el('rubricNote'), D.rubric.note);

    // Limitations: fill the figures from the data rather than hard-coding them.
    var rs = raters();
    var humans = rs.filter(function (r) { return r.kind === 'human'; }).length;
    text(el('lim-max'), String(D.rubric.scaleMax));
    text(el('lim-raters'), words(rs.length) + ' raters (' + words(humans) + ' human, ' +
      words(rs.length - humans) + ' model' + (rs.length - humans === 1 ? '' : 's') + ')');
    text(el('lim-hidden'), cap(words(D.models.length - MODELS.length)));
    var rel = D.reliability;
    el('lim-rel').hidden = !rel;
    if (rel) {
      text(el('lim-agree'), rel.all_three_agree_pct + '%');
      var low = null;
      D.rubric.dimensions.forEach(function (d) {
        var pd = rel.per_dimension && rel.per_dimension[d.key];
        if (pd && (!low || pd.exact3 < low.pct)) low = { label: d.label, pct: pd.exact3 };
      });
      text(el('lim-low'), low ? low.label.toLowerCase() + ' (' + low.pct + '%)' : '—');
    }
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
    var hide = D.display && D.display.hideUnscoredModels;
    MODELS = D.models.filter(function (m) {
      if (!hide) return true;
      return Object.keys(D.scores).some(function (k) { return k.split('||')[0] === m; });
    });
    state.text = D.texts[0];
    state.aCond = D.conditions[0].key;
    state.bCond = D.conditions[D.conditions.length - 1].key;
    // Open on a model that has both conditions, so the first view shows the
    // constraint's effect rather than a "not collected" panel.
    var both = MODELS.filter(function (m) {
      return hasResponse(m, state.aCond) && hasResponse(m, state.bCond);
    });
    state.aModel = state.bModel = both[0] || MODELS[0];
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
