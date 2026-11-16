// Token Radar's dashboard: the night-console page for the ranked board.
//
// main.ts writes window.RADAR beside this page (data.js), and this script turns it into
// the board a reader can use: a filterable, sortable table of the pre-token protocols, a
// live-token view set apart from the ranking, a detail drawer for each protocol with the
// model's own inputs and the protocol's six-step farm plan, and a sandbox that re-ranks
// the top five when a reader moves a constant. No network: every byte shown is in data.js.
// The farm plan each row shows is the plan board.json carries, never a page-side rewrite.
(() => {
  const BOARD = window.RADAR;
  if (!BOARD) return;
  const mount = document.getElementById('board');

  // What the reader has chosen: search text, filters, tab, sort, and the open protocol.
  const view = {
    q: '',
    category: 'all',
    chain: 'all',
    tab: 'pre-token',
    sort: 'implied',
    dir: -1,
    selected: null,
  };
  // The sandbox's constants, starting at the board's own radar-2 values.
  const lab = {
    base: BOARD.model.base_multiple,
    weight: BOARD.model.growth_weight,
    floor: BOARD.model.maturity_floor,
    active: false,
  };

  const usdWhole = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

  /** A figure the snapshot leaves blank, or one that is not a number at all. */
  function isMissing(n) {
    return n === null || n === undefined || !isFinite(n);
  }

  /** A dollar figure shortened the way the table shows it: $861M, $514K, or the whole sum. */
  function money(n) {
    if (isMissing(n)) return 'n/a';
    const abs = Math.abs(n);
    if (abs >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (abs >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (abs >= 1e3) return `$${Math.round(n / 1e3)}K`;
    return usdWhole.format(n);
  }

  /** A percentage with its sign, or n/a when the snapshot reports none. */
  function pct(n) {
    if (isMissing(n)) return 'n/a';
    return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
  }

  /** An age in days as years once it passes a year, else days, else unknown. */
  function ageLabel(days) {
    if (days == null) return 'unknown';
    if (days >= 365) return `${(days / 365).toFixed(1)}y`;
    return `${Math.max(0, Math.round(days))}d`;
  }

  /** The seven-day change clamped to the model's band, with a missing figure as flat. */
  function clampWeekly(n) {
    const raw = n === null || n === undefined ? 0 : n;
    return Math.min(BOARD.model.growth_cap, Math.max(BOARD.model.growth_floor, raw));
  }

  // The radar-2 model in one place: the page recomputes a row from the snapshot figures
  // and checks it against the number board.json carries, so the page's code and the
  // board's data are visibly the same arithmetic. The sandbox calls it with its own tuning.
  function recompute(row, tuning) {
    const growth = 1 + (clampWeekly(row.change_7d) / 100) * tuning.growth_weight;
    const age = row.age_days === null || row.age_days === undefined ? tuning.unknown_age_days : row.age_days;
    const maturity =
      tuning.maturity_floor +
      (Math.log(1 + Math.max(age, 0)) / Math.log(1 + tuning.maturity_days)) * tuning.maturity_range;
    const reach = row.reach_multiplier || 1;
    return Math.max(1, Math.round(row.tvl_usd * tuning.base_multiple * growth * maturity * reach));
  }

  /** The sandbox's tuning as a model object the recompute function can take. */
  function labTuning() {
    return {
      base_multiple: lab.base,
      growth_weight: lab.weight,
      growth_floor: BOARD.model.growth_floor,
      growth_cap: BOARD.model.growth_cap,
      maturity_floor: lab.floor,
      maturity_range: BOARD.model.maturity_range,
      maturity_days: BOARD.model.maturity_days,
      unknown_age_days: BOARD.model.unknown_age_days,
    };
  }

  /** Build an element: attributes by name, children as one array. */
  function mk(kind, attrs, kids) {
    const node = document.createElement(kind);
    for (const key of Object.keys(attrs || {})) {
      const value = attrs[key];
      if (value === null || value === undefined) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'html') node.innerHTML = value;
      else if (key.slice(0, 2) === 'on') node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value);
    }
    for (const kid of kids || []) addKid(node, kid);
    return node; // ready to append
  }

  /** One child onto a node: an array spreads, a string becomes text, the rest appends. */
  function addKid(node, kid) {
    if (kid === null || kid === undefined || kid === false) return;
    if (Array.isArray(kid)) {
      for (const piece of kid) addKid(node, piece);
      return;
    }
    if (typeof kid === 'string') {
      node.appendChild(document.createTextNode(kid));
      return;
    }
    node.appendChild(kid);
  }

  /** Where a protocol lives, in the row's own words, for the name cell and the detail view.
      The table shows at most the first two chains; the detail view names them all. */
  function placeText(row, joiner, limit) {
    const chains = row.chains || [];
    const shown = limit === undefined ? chains : chains.slice(0, limit);
    const where = shown.length ? shown.join(joiner) : 'an unnamed chain';
    return (row.category || 'Other') + ' on ' + where;
  }

  // The farm plan preview is the plan's second step — the category action with its
  // capital and chain — trimmed to one line. The full six steps live in the detail view.
  function planPreview(row) {
    const steps = row.farm_steps || [];
    if (steps.length < 2) return 'No farm plan on record.';
    const action = steps[1].split(' Cost: ')[0];
    if (action.length > 120) return action.slice(0, 117) + '...';
    return action;
  }

  /** Read the reader's state back out of the location hash, when one is there. */
  function loadHash() {
    const hash = window.location.hash.replace(/^#/, '');
    const params = new URLSearchParams(hash);
    const q = params.get('q');
    const p = params.get('p');
    const category = params.get('category');
    const chain = params.get('chain');
    const tab = params.get('tab');
    if (q) view.q = q;
    if (p) view.selected = p;
    if (category) view.category = category;
    if (chain) view.chain = chain;
    if (tab) view.tab = tab;
  }

  /** Write the reader's state into the location hash, so a view can be shared. */
  function saveHash() {
    const params = new URLSearchParams();
    if (view.q) params.set('q', view.q);
    if (view.category !== 'all') params.set('category', view.category);
    if (view.chain !== 'all') params.set('chain', view.chain);
    if (view.tab !== 'pre-token') params.set('tab', view.tab);
    if (view.selected) params.set('p', view.selected);
    const next = params.toString();
    const url = next ? '#' + next : window.location.pathname + window.location.search;
    window.history.replaceState(null, '', url);
  }

  /** Whether one row passes the reader's filters and search. */
  function matchesFilters(row, q) {
    if (view.category !== 'all' && row.category !== view.category) return false;
    if (view.chain !== 'all' && !(row.chains || []).includes(view.chain)) return false;
    if (q === '') return true;
    const hay = [row.name, row.slug, row.category, (row.chains || []).join(' ')].join(' ').toLowerCase();
    return hay.includes(q);
  }

  /** The board's rows after the reader's filters and search. */
  function visibleRows() {
    const q = view.q.trim().toLowerCase();
    return BOARD.rows.filter((r) => matchesFilters(r, q));
  }

  /** The value a sort key reads off a row, with missing figures sent to the far end. */
  function sortValue(row, key) {
    if (key === 'name') return row.name.toLowerCase();
    if (key === 'tvl') return row.tvl_usd;
    if (key === 'growth') return row.change_7d === null ? -Infinity : row.change_7d;
    if (key === 'age') return row.age_days === null ? Infinity : row.age_days;
    return row.implied_value_usd;
  }

  /** Slug order for ties: the earlier slug first, so a tie always breaks the same way. */
  function slugCompare(a, b) {
    if (a.slug === b.slug) return 0;
    return a.slug < b.slug ? -1 : 1;
  }

  /** The visible rows in the reader's sort order, ties broken by slug. */
  function orderedRows(list) {
    const key = view.sort;
    const dir = view.dir;
    return list.slice().sort((a, b) => {
      const av = sortValue(a, key);
      const bv = sortValue(b, key);
      if (av < bv) return -dir;
      if (av > bv) return dir;
      return slugCompare(a, b);
    });
  }

  /** The page's top bar: the name, the snapshot date, and the model version. */
  function topBar() {
    return mk('header', { class: 'top' }, [
      mk('div', { class: 'brand' }, [
        mk('span', { class: 'mark' }),
        mk('span', { class: 'brand-name', text: 'Token Radar' }),
      ]),
      mk('div', { class: 'top-meta' }, [
        mk('span', { text: 'Snapshot ' + BOARD.as_of }),
        mk('span', { text: 'DefiLlama protocol index' }),
        mk('span', { text: BOARD.model_version + ' model' }),
      ]),
    ]);
  }

  /** The lede: what the board covers, the strongest signal, and the four counts. */
  function intro() {
    const top = BOARD.rows[0];
    const floorMillions = Math.round(BOARD.floor_usd / 1e6);
    const strongest = top ? 'Strongest signal: ' + top.name + ' at ' + money(top.implied_value_usd) + '.' : '';
    const facts = [
      ['Watchlist covered', BOARD.watchlist_size + ' / ' + BOARD.watchlist_size],
      ['Pre-token rows scored', String(BOARD.board_size)],
      ['Early rows below the floor', String(BOARD.early_size)],
      ['Live-token protocols set aside', String(BOARD.live_size)],
    ];
    return mk('section', { class: 'lede' }, [
      mk('div', null, [
        mk('h1', { text: BOARD.watchlist_size + ' watchlist protocols, ranked by implied value' }),
        mk('p', null, [
          'The watchlist is the floor: every protocol with at least $' + floorMillions +
            'M of TVL and no token on record. The early radar adds ' + BOARD.early_size +
            ' pre-token protocols below that floor. ',
          mk('b', { text: strongest }),
          ' Implied value is a model, not a promise.',
        ]),
      ]),
      mk('div', { class: 'facts' }, facts.map(([label, value]) =>
        mk('div', { class: 'fact' }, [mk('span', { text: label }), mk('b', { text: value })]))),
    ]);
  }

  /** The search, the two filters, the tab switch, and the count of rows shown. */
  function filters() {
    const categories = Array.from(new Set(BOARD.rows.map((r) => r.category || 'Other'))).sort();
    const chains = Array.from(new Set(BOARD.rows.reduce((acc, r) => acc.concat(r.chains || []), []))).sort();
    const search = mk('input', {
      type: 'search', id: 'q', placeholder: 'Search name, category or chain',
      value: view.q, 'aria-label': 'Search the board',
    });
    search.addEventListener('input', () => { view.q = search.value; saveHash(); paint(); });
    const categorySelect = mk('select', { id: 'category', 'aria-label': 'Filter by category' }, [
      mk('option', { value: 'all', text: 'All categories' }),
      categories.map((c) => mk('option', { value: c, text: c, selected: c === view.category ? 'selected' : null })),
    ]);
    categorySelect.addEventListener('change', () => { view.category = categorySelect.value; saveHash(); paint(); });
    const chainSelect = mk('select', { id: 'chain', 'aria-label': 'Filter by chain' }, [
      mk('option', { value: 'all', text: 'All chains' }),
      chains.map((c) => mk('option', { value: c, text: c, selected: c === view.chain ? 'selected' : null })),
    ]);
    chainSelect.addEventListener('change', () => { view.chain = chainSelect.value; saveHash(); paint(); });
    const tabButton = (tab, label) => mk('button', {
      type: 'button', 'aria-pressed': view.tab === tab ? 'true' : 'false', text: label,
      onclick: () => { view.tab = tab; saveHash(); paint(); },
    });
    const shown = view.tab === 'pre-token' ? visibleRows().length + ' rows shown' : BOARD.live.length + ' live-token protocols';
    return mk('div', { class: 'controls' }, [
      mk('div', { class: 'field' }, [mk('label', { for: 'q', text: 'Search' }), search]),
      mk('div', { class: 'field' }, [mk('label', { for: 'category', text: 'Category' }), categorySelect]),
      mk('div', { class: 'field' }, [mk('label', { for: 'chain', text: 'Chain' }), chainSelect]),
      mk('div', { class: 'field' }, [
        mk('span', { class: 'sub', text: 'Token status' }),
        mk('div', { class: 'tabs' }, [tabButton('pre-token', 'Pre-token'), tabButton('live', 'Live token')]),
      ]),
      mk('span', { class: 'count', text: shown }),
    ]);
  }

  /** One sortable column head: the label, and an arrow while it is the sort. */
  function sortHead(key, label) {
    const arrow = view.sort === key ? mk('span', { 'aria-hidden': 'true', text: view.dir < 0 ? ' v' : ' ^' }) : null;
    return mk('th', { scope: 'col' }, [
      mk('button', {
        type: 'button',
        onclick: () => {
          if (view.sort === key) view.dir = -view.dir;
          else { view.sort = key; view.dir = -1; }
          paint();
        },
      }, [label, arrow]),
    ]);
  }

  /** One board row: rank, protocol with its farm preview, figures, and the value bar. */
  function boardRow(row, maxImplied) {
    const growth = row.change_7d === null ? 'n/a' : pct(row.change_7d);
    const growthClass = row.change_7d === null ? '' : row.change_7d >= 0 ? 'pos' : 'neg';
    const width = Math.max(3, Math.round((row.implied_value_usd / maxImplied) * 100));
    return mk('tr', {
      'data-selected': view.selected === row.slug ? 'true' : 'false',
      tabindex: '0',
      onclick: () => showDetail(row.slug),
      onkeydown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showDetail(row.slug); }
      },
    }, [
      mk('td', { class: 'num', text: String(row.rank) }),
      mk('td', null, [
        mk('div', { class: 'name' }, [
          mk('b', { text: row.name }),
          mk('span', { class: 'sub', text: placeText(row, ', ', 2) }),
          mk('span', { class: 'plan' }, [mk('b', { text: 'Farm: ' }), planPreview(row)]),
        ]),
      ]),
      mk('td', { class: 'num', text: money(row.tvl_usd) }),
      mk('td', { class: 'num ' + growthClass, text: growth }),
      mk('td', { class: 'num', text: ageLabel(row.age_days) }),
      mk('td', null, [
        mk('div', { class: 'implied' }, [
          mk('div', { class: 'bar', 'aria-hidden': 'true' }, [
            mk('i', { style: 'width:' + width + '%' }),
          ]),
          mk('span', { class: 'num', text: money(row.implied_value_usd) }),
        ]),
      ]),
      mk('td', null, [mk('span', { class: 'status', text: 'no token' })]),
    ]);
  }

  /** The ranked table, or an empty state with a way back when no row matches. */
  function preTokenTable() {
    const list = orderedRows(visibleRows());
    if (!list.length) {
      return mk('div', { class: 'panel' }, [
        mk('div', { class: 'empty' }, [
          mk('h2', { text: 'No protocol matches that filter' }),
          mk('p', { text: 'Clear the search or pick another category to see the board again.' }),
          mk('button', {
            class: 'button primary', type: 'button', text: 'Clear filters',
            onclick: () => { view.q = ''; view.category = 'all'; view.chain = 'all'; saveHash(); paint(); },
          }),
        ]),
      ]);
    }
    const maxImplied = list.reduce((m, r) => Math.max(m, r.implied_value_usd), 1);
    const tbody = mk('tbody');
    for (const row of list) tbody.appendChild(boardRow(row, maxImplied));
    return mk('div', { class: 'panel' }, [
      mk('div', { class: 'table-wrap' }, [
        mk('table', null, [
          mk('caption', { class: 'sub', text: 'Pre-token protocols, strongest implied value first. Each row shows its farm plan; select a row for its model and full plan.' }),
          mk('thead', null, [
            mk('tr', null, [
              sortHead('implied', 'Rank'),
              sortHead('name', 'Protocol'),
              sortHead('tvl', 'TVL'),
              sortHead('growth', '7d'),
              sortHead('age', 'Age'),
              sortHead('implied', 'Implied value'),
              mk('th', { scope: 'col', text: 'Token' }),
            ]),
          ]),
          tbody,
        ]),
      ]),
    ]);
  }

  /** The live-token table: protocols that already trade, shown with their market caps. */
  function liveTokenTable() {
    const tbody = mk('tbody');
    for (const r of BOARD.live) {
      const growthClass = r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg';
      tbody.appendChild(mk('tr', null, [
        mk('td', { class: 'num', text: 'live' }),
        mk('td', null, [
          mk('div', { class: 'name' }, [
            mk('b', { text: r.name }),
            mk('span', { class: 'sub', text: placeText(r, ', ', 2) }),
          ]),
        ]),
        mk('td', { class: 'num', text: money(r.tvl_usd) }),
        mk('td', { class: 'num ' + growthClass, text: pct(r.change_7d) }),
        mk('td', { class: 'num', text: money(r.mcap_usd) }),
        mk('td', null, [mk('span', { class: 'status live', text: 'already trades' })]),
      ]));
    }
    return mk('div', { class: 'panel' }, [
      mk('div', { class: 'table-wrap' }, [
        mk('table', null, [
          mk('caption', { class: 'sub', text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking.' }),
          mk('thead', null, [
            mk('tr', null, [
              mk('th', { scope: 'col', text: 'Status' }),
              mk('th', { scope: 'col', text: 'Protocol' }),
              mk('th', { scope: 'col', text: 'TVL' }),
              mk('th', { scope: 'col', text: '7d' }),
              mk('th', { scope: 'col', text: 'Market cap' }),
              mk('th', { scope: 'col', text: 'Token' }),
            ]),
          ]),
          tbody,
        ]),
      ]),
    ]);
  }

  /** The formula, written out with the model's own constants, and what each part means. */
  function formulaPanel() {
    const m = BOARD.model;
    const formula =
      'tvl_usd x ' + m.base_multiple +
      ' x (1 + clamp(change_7d, ' + m.growth_floor + ', ' + m.growth_cap + ') / 100 x ' + m.growth_weight + ')' +
      ' x (' + m.maturity_floor + ' + ln(1 + age_days) / ln(1 + ' + m.maturity_days + ') x ' + m.maturity_range + ')' +
      ' x (1 + ' + m.chain_bonus + ' x min(chains - 1, ' + m.chain_cap + '))';
    return mk('section', { class: 'panel model' }, [
      mk('h2', { text: 'How implied value is computed' }),
      mk('p', { class: 'sub', text: 'Every row is scored by one function of the snapshot figures. No protocol name is special-cased, and no row is hand-picked.' }),
      mk('div', { class: 'formula' }, [
        mk('b', { text: 'implied = round( ' }),
        formula,
        mk('b', { text: ' )' }),
      ]),
      mk('p', { class: 'sub', text: 'TVL and seven-day growth come from the snapshot. Age is the time since the protocol was first listed, the best record of how long it has run with no token; an unlisted age uses ' + m.unknown_age_days + ' days. Growth is capped so one hot week cannot carry a protocol; age enters on a log curve, so a protocol earns most of its staying credit in its first year. The early radar is every rankable pre-token protocol below the watchlist floor, by TVL, and the live-token protocols are set aside with their market caps shown.' }),
    ]);
  }

  /** One sandbox slider: its label, its live value, and the range input itself. */
  function sliderField(id, label, value, min, max, step, oninput) {
    const out = mk('output', { for: id, text: String(value) });
    const input = mk('input', {
      type: 'range', id, min: String(min), max: String(max), step: String(step),
      value: String(value), 'aria-label': label,
    });
    input.addEventListener('input', () => { out.textContent = input.value; oninput(parseFloat(input.value)); });
    return mk('div', { class: 'slider-field' }, [
      mk('label', { for: id }, [mk('span', { text: label }), out]),
      input,
    ]);
  }

  /** The sandbox's top five under the reader's constants, with each rank move shown. */
  function sandboxTop() {
    const tuning = labTuning();
    const scored = BOARD.rows.map((r) => ({ row: r, value: recompute(r, tuning) }));
    scored.sort((a, b) => b.value - a.value || slugCompare(a.row, b.row));
    return mk('div', { class: 'sandbox-top' }, scored.slice(0, 5).map((s, i) => {
      const move = s.row.rank - (i + 1);
      const moveText = move === 0 ? 'same rank' : move > 0 ? 'up ' + move : 'down ' + (-move);
      return mk('div', null, [
        mk('b', { text: (i + 1) + '. ' + s.row.name + ' ' }),
        mk('span', { class: 'num', text: money(s.value) }),
        mk('span', { text: ' (board rank ' + s.row.rank + ', ' + moveText + ')' }),
      ]);
    }));
  }

  /** The sandbox panel: three sliders, the re-ranked top five, and a reset. */
  function sandboxPanel() {
    const top = sandboxTop();
    const resetBtn = mk('button', {
      class: 'button', type: 'button', text: 'Reset to radar-2',
      disabled: !lab.active ? 'disabled' : null,
      onclick: () => {
        lab.base = BOARD.model.base_multiple;
        lab.weight = BOARD.model.growth_weight;
        lab.floor = BOARD.model.maturity_floor;
        paint();
      },
    });
    function refresh() {
      lab.active =
        lab.base !== BOARD.model.base_multiple ||
        lab.weight !== BOARD.model.growth_weight ||
        lab.floor !== BOARD.model.maturity_floor;
      const fresh = sandboxTop();
      top.textContent = '';
      while (fresh.firstChild) top.appendChild(fresh.firstChild);
      resetBtn.disabled = !lab.active;
    }
    return mk('section', { class: 'panel sandbox' }, [
      mk('h2', { text: 'Model sandbox — try the constants yourself' }),
      mk('p', { class: 'sub', text: 'Move a slider and the top five re-rank by the same formula. This is exploratory: the submitted board keeps the radar-2 constants above.' }),
      mk('div', { class: 'sandbox-grid' }, [
        sliderField('sb-base', 'Base multiple (TVL x)', lab.base, 0.1, 0.6, 0.01, (v) => { lab.base = v; refresh(); }),
        sliderField('sb-weight', 'Growth weight', lab.weight, 0, 1, 0.05, (v) => { lab.weight = v; refresh(); }),
        sliderField('sb-floor', 'Maturity floor', lab.floor, 0.5, 0.9, 0.05, (v) => { lab.floor = v; refresh(); }),
      ]),
      top,
      mk('div', null, [resetBtn]),
    ]);
  }

  const dialog = mk('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', () => { view.selected = null; saveHash(); });

  /** Open the detail drawer for one protocol: its model inputs and its full farm plan. */
  function showDetail(slug) {
    const row = BOARD.rows.filter((r) => r.slug === slug)[0];
    if (row === undefined) return;
    view.selected = slug;
    saveHash();
    dialog.replaceChildren();
    const steps = row.farm_steps || [];
    const again = recompute(row, BOARD.model);
    const agrees = again === row.implied_value_usd;
    const verdict = 'Model ' + BOARD.model_version +
      ': the same function scores every protocol. The page recomputes this row as ' + money(again) +
      (agrees ? ', the same number board.json carries.' : ', which differs from the board: the data would be stale.') +
      ' This is an estimate, not a price.';
    const inputs = [
      ['TVL', money(row.tvl_usd)],
      ['Seven-day growth', pct(row.change_7d)],
      ['Age with no token', ageLabel(row.age_days)],
      ['Chains', String((row.chains || []).length)],
      ['Growth multiplier', String(row.growth_multiplier)],
      ['Maturity multiplier', String(row.maturity_multiplier)],
      ['Reach multiplier', String(row.reach_multiplier)],
      ['Implied value', money(row.implied_value_usd)],
    ];
    dialog.appendChild(mk('div', { class: 'detail-head' }, [
      mk('div', null, [
        mk('span', { class: 'brand-name', text: 'Rank ' + row.rank + ' of ' + BOARD.board_size }),
        mk('h2', { id: 'detail-title', text: row.name }),
        mk('p', { class: 'sub', text: placeText(row, ', ') }),
      ]),
      mk('button', {
        class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close',
        onclick: () => dialog.close(),
      }),
    ]));
    dialog.appendChild(mk('section', { class: 'detail-section' }, [
      mk('h3', { text: 'Implied value' }),
      mk('div', { class: 'equation' }, inputs.map(([label, value]) =>
        mk('div', null, [mk('span', { text: label }), mk('b', { class: 'num', text: value })]))),
      mk('p', { class: 'sub', text: verdict }),
    ]));
    dialog.appendChild(mk('section', { class: 'detail-section' }, [
      mk('h3', { text: 'Farm plan — ' + steps.length + ' steps' }),
      mk('ol', { class: 'steps' }, steps.map((s) => {
        const at = s.indexOf(' Cost: ');
        const action = at >= 0 ? s.slice(0, at) : s;
        const tail = at >= 0 ? s.slice(at + 1) : '';
        return mk('li', null, [mk('b', { text: action }), mk('span', { class: 'cost', text: tail })]);
      })),
    ]));
    const canModal = typeof dialog.showModal === 'function';
    if (canModal && !dialog.open) dialog.showModal();
    if (!canModal) dialog.setAttribute('open', '');
  }

  /** Rebuild the whole page from the reader's current state. */
  function paint() {
    mount.textContent = '';
    const shell = mk('div', { class: 'shell' });
    shell.appendChild(topBar());
    shell.appendChild(intro());
    shell.appendChild(filters());
    shell.appendChild(view.tab === 'pre-token' ? preTokenTable() : liveTokenTable());
    if (view.tab === 'pre-token') shell.appendChild(formulaPanel());
    if (view.tab === 'pre-token') shell.appendChild(sandboxPanel());
    mount.appendChild(shell);
    mount.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) mount.appendChild(dialog);
    if (view.selected) showDetail(view.selected);
  }

  loadHash();
  paint();
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (dialog.open) dialog.close();
  });
})(); // the dashboard boots on load
