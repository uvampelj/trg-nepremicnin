import {
  HOUSE, KINDS, MARKETS, MIN_SAMPLE, TYPE_IDS, analyse, defaultState, housesByLand, loadDetails, loadStore,
  median, metricValue, quarterLabel, regions, select,
} from './store.js';
import { METRICS, count, money, percent, perM2, ratio } from './scale.js';
import { SalesMap } from './map.js';
import { hideTip, histogram, lineChart, showTip, stackedColumns, table } from './charts.js';

const $ = (id) => document.getElementById(id);
const seriesColor = (t) => `var(--s${t})`;
const LAND_TYPES = new Set([3, 4, 5, 6]);
const TIP_DEALS = 5;   // sales listed in the tooltip of a shared point
const TIP_FACTS = 7;   // facts about a single sale; the popup shows them all

let store, state, map, lists, stats, analysis;
let stackBy = 'n';
let rankBy = 'em';
let playTimer = null;

const themeNow = () => {
  const explicit = document.documentElement.dataset.theme;
  if (explicit) return explicit;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

function formatDate(stamp) {
  return `${Number(stamp.slice(6, 8))}. ${Number(stamp.slice(4, 6))}. ${stamp.slice(0, 4)}`;
}

// The date a sale reached ETN, kept as days before the newest entry.
function entryDate(age) {
  const stamp = store.meta.lastEntry;
  const day = new Date(Date.UTC(Number(stamp.slice(0, 4)), Number(stamp.slice(4, 6)) - 1, Number(stamp.slice(6, 8)) - age));
  return `${day.getUTCDate()}. ${day.getUTCMonth() + 1}. ${day.getUTCFullYear()}`;
}

const yearLabel = (y) => {
  const partial = y === store.lastYear && (store.meta.lastMonth % 12 !== 11 || store.firstPartialQuarter <= (y - store.firstYear) * 4 + 3);
  return `${y}${partial ? '*' : ''}`;
};

const typeName = (t) => store.meta.types[t];

function areaName(area) {
  if (!area) return 'Slovenija';
  if (area.level === 'o') return store.meta.municipalities[area.id];
  const home = store.meta.municipalities[store.meta.cadastralMunicipality[area.id]];
  return `${home ? `${home}, ` : ''}k. o. ${store.meta.cadastral[area.id]}`;
}

/* URL ------------------------------------------------------------------ */

const SETS = { t: 'types', k: 'kinds', r: 'markets', c: 'constructions', b: 'buildingTypes' };
const NUMS = { a0: 'minArea', a1: 'maxArea', z0: 'minLand', z1: 'maxLand', p0: 'minPrice', p1: 'maxPrice' };

function writeHash() {
  const d = defaultState(store);
  const q = new URLSearchParams();
  for (const [key, name] of Object.entries(SETS)) {
    const now = [...state[name]].sort().join(','), base = [...d[name]].sort().join(',');
    if (now !== base) q.set(key, now);
  }
  if (state.y0 !== d.y0 || state.y1 !== d.y1) q.set('y', `${state.y0}-${state.y1}`);
  if (state.b0 !== d.b0 || state.b1 !== d.b1) q.set('i', `${state.b0}-${state.b1}`);
  if (state.fresh) q.set('n', state.fresh);
  for (const [key, name] of Object.entries(NUMS)) if (state[name] !== null) q.set(key, state[name]);
  if (state.build !== 'all') q.set('g', state.build);
  if (state.includePart) q.set('dp', 1);
  if (state.includeBundle) q.set('pk', 1);
  if (state.area) q.set('a', `${state.area.level}${state.area.id}`);
  if (state.mode !== 'heat') q.set('m', state.mode);
  if (state.metric !== 'em') q.set('x', state.metric);
  if (state.level !== 'o') q.set('l', state.level);
  const hash = q.toString();
  history.replaceState(null, '', hash ? `#${hash}` : location.pathname + location.search);
}

function readHash() {
  const q = new URLSearchParams(location.hash.slice(1));
  const numbers = (text) => text.split(',').filter(Boolean).map(Number).filter(Number.isFinite);
  for (const [key, name] of Object.entries(SETS)) if (q.has(key)) state[name] = new Set(numbers(q.get(key)));
  if (q.has('y')) {
    const [a, b] = q.get('y').split('-').map(Number);
    if (a >= store.firstYear && b <= store.lastYear && a <= b) { state.y0 = a; state.y1 = b; }
  }
  if (q.has('i')) {
    const [a, b] = q.get('i').split('-').map(Number);
    if (a >= store.builtMin && b <= store.builtMax && a <= b) { state.b0 = a; state.b1 = b; }
  }
  if (['7', '30'].includes(q.get('n'))) state.fresh = Number(q.get('n'));
  for (const [key, name] of Object.entries(NUMS)) if (q.has(key)) state[name] = Number(q.get(key));
  if (['new', 'used'].includes(q.get('g'))) state.build = q.get('g');
  state.includePart = q.has('dp');
  state.includeBundle = q.has('pk');
  const area = /^([ok])(\d+)$/.exec(q.get('a') || '');
  if (area) state.area = { level: area[1], id: Number(area[2]) };
  if (['areas', 'points'].includes(q.get('m'))) state.mode = q.get('m');
  if (METRICS[q.get('x')]) state.metric = q.get('x');
  if (q.get('l') === 'k') state.level = 'k';
}

/* Filter controls ------------------------------------------------------- */

function chipGroup(host, options, set, withColor = false) {
  host.innerHTML = options.map(([id, label]) => `
    <button class="chip" type="button" data-id="${id}">${withColor ? `<i style="background:${seriesColor(id)}"></i>` : ''}${label}</button>`).join('');
  host.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    stopPlay();
    const id = Number(chip.dataset.id);
    if (!set().delete(id)) set().add(id);
    changed();
  });
}

function checkGroup(host, options, set) {
  host.innerHTML = options.map(([id, label]) => `
    <label class="check"><input type="checkbox" data-id="${id}"><span>${label}</span></label>`).join('');
  host.addEventListener('change', (e) => {
    const id = Number(e.target.dataset.id);
    if (e.target.checked) set().add(id); else set().delete(id);
    changed();
  });
}

function segment(host, get, put) {
  host.addEventListener('click', (e) => {
    const button = e.target.closest('button');
    if (!button) return;
    put(button.dataset.v);
    changed();
  });
  host.sync = () => host.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.v === get()));
}

function rangePair(lowId, highId, min, max, put) {
  for (const id of [lowId, highId]) {
    const input = $(id);
    input.min = min;
    input.max = max;
    input.addEventListener('input', () => {
      stopPlay();
      const a = Number($(lowId).value), b = Number($(highId).value);
      put(Math.min(a, b), Math.max(a, b));
      changed();
    });
  }
}

function syncRange(trackId, lowId, highId, low, high, min, max) {
  $(lowId).value = low;
  $(highId).value = high;
  const span = max - min || 1;
  const track = $(trackId);
  track.style.setProperty('--from', `${((low - min) / span) * 100}%`);
  track.style.setProperty('--to', `${((high - min) / span) * 100}%`);
}

function builtLabel() {
  const from = state.b0 > store.builtMin, to = state.b1 < store.builtMax;
  if (from && to) return state.b0 === state.b1 ? `${state.b0}` : `${state.b0}–${state.b1}`;
  if (from) return `od ${state.b0}`;
  return to ? `do ${state.b1}` : 'vsa leta';
}

function openMethod(sectionId) {
  $('method').showModal();
  if (sectionId) $(sectionId).scrollIntoView();
}

function buildControls() {
  const { meta } = store;
  chipGroup($('f-types'), TYPE_IDS.map((t) => [t, typeName(t)]), () => state.types, true);
  const construction = Object.entries(meta.construction).filter(([id]) => Number(id) > 0);
  chipGroup($('f-constructions'), construction, () => state.constructions);
  const buildingTypes = Object.entries(meta.buildingTypes).filter(([id]) => Number(id) > 0);
  chipGroup($('f-building-types'), buildingTypes, () => state.buildingTypes);
  checkGroup($('f-kinds'), Object.entries(KINDS), () => state.kinds);
  checkGroup($('f-markets'), Object.entries(MARKETS), () => state.markets);

  segment($('f-build'), () => state.build, (v) => { state.build = v; });
  segment($('f-fresh'), () => String(state.fresh), (v) => {
    stopPlay();
    state.fresh = Number(v);
    // A heat surface needs neighbours, and a few new sales would leave the map blank.
    if (state.fresh && state.mode === 'heat') state.mode = 'points';
  });
  $('f-metric').innerHTML = Object.entries(METRICS).map(([id, m]) => `<button type="button" data-v="${id}">${m.label}</button>`).join('');
  segment($('f-mode'), () => state.mode, (v) => { state.mode = v; if (v === 'heat' && !METRICS[state.metric].heat) state.metric = 'em'; });
  segment($('f-metric'), () => state.metric, (v) => { state.metric = v; if (!METRICS[v].heat && state.mode === 'heat') state.mode = 'areas'; });
  segment($('f-level'), () => state.level, (v) => { state.level = v; });
  segment($('stack-by'), () => stackBy, (v) => { stackBy = v; });

  rangePair('y0', 'y1', store.firstYear, store.lastYear, (low, high) => { state.y0 = low; state.y1 = high; });
  rangePair('b0', 'b1', store.builtMin, store.builtMax, (low, high) => { state.b0 = low; state.b1 = high; });
  $('year-marks').innerHTML = Array.from({ length: store.lastYear - store.firstYear + 1 }, (_, i) => `<span>${String(store.firstYear + i).slice(2)}</span>`).join('');
  $('built-marks').innerHTML = `<span>do ${store.builtMin}</span><span>${store.builtMax}</span>`;
  $('play').addEventListener('click', togglePlay);

  const names = new Map();
  for (const [id, name] of Object.entries(meta.municipalities)) names.set(name, { level: 'o', id: Number(id) });
  for (const [id, name] of Object.entries(meta.cadastral)) {
    const home = meta.municipalities[meta.cadastralMunicipality[id]];
    names.set(`${home ? `${home}, ` : ''}${name} (k. o.)`, { level: 'k', id: Number(id) });
  }
  $('area-list').innerHTML = [...names.keys()].sort((a, b) => a.localeCompare(b, 'sl')).map((n) => `<option value="${n.replace(/"/g, '&quot;')}">`).join('');
  $('f-area').addEventListener('change', (e) => {
    const area = names.get(e.target.value);
    if (area) setArea(area, true);
    e.target.value = '';
  });
  $('area-chip').addEventListener('click', () => setArea(null, true));

  const bindNumber = (id, name) => $(id).addEventListener('change', (e) => {
    state[name] = e.target.value === '' ? null : Number(e.target.value);
    changed();
  });
  bindNumber('min-area', 'minArea');
  bindNumber('max-area', 'maxArea');
  bindNumber('min-land', 'minLand');
  bindNumber('max-land', 'maxLand');
  bindNumber('min-price', 'minPrice');
  bindNumber('max-price', 'maxPrice');
  $('include-part').addEventListener('change', (e) => { state.includePart = e.target.checked; changed(); });
  $('include-bundle').addEventListener('change', (e) => { state.includeBundle = e.target.checked; changed(); });
  $('reset').addEventListener('click', () => {
    stopPlay();
    const { mode, metric, level } = state;
    state = { ...defaultState(store), mode, metric, level };
    map.resetView();
    changed();
  });

  document.querySelectorAll('.card .view').forEach((button) => button.addEventListener('click', () => {
    const card = button.closest('.card');
    const showing = card.classList.toggle('show-table');
    button.textContent = showing ? 'Graf' : 'Tabela';
    card.querySelectorAll('.tabular').forEach((t) => { t.hidden = !showing; });
  }));

  $('open-method').addEventListener('click', () => openMethod());
  $('market-help').addEventListener('click', () => openMethod('m-market'));
  $('toggle-theme').addEventListener('click', () => {
    const next = themeNow() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('theme', next); } catch { /* storage may be blocked */ }
    map.setTheme(next);
  });
  $('download').addEventListener('click', downloadCsv);

  document.querySelector('.tabs').addEventListener('click', (e) => {
    const button = e.target.closest('button');
    if (!button) return;
    document.body.dataset.tab = button.dataset.tab;
    syncTabs();
    if (button.dataset.tab === 'map') requestAnimationFrame(() => map.resize());
    else if (button.dataset.tab === 'analysis') requestAnimationFrame(renderCharts);
  });
}

function syncTabs() {
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-current', b.dataset.tab === document.body.dataset.tab));
}

function syncControls() {
  const mark = (host, set) => host.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', set.has(Number(c.dataset.id))));
  mark($('f-types'), state.types);
  mark($('f-constructions'), state.constructions);
  mark($('f-building-types'), state.buildingTypes);
  const tick = (host, set) => host.querySelectorAll('input').forEach((c) => { c.checked = set.has(Number(c.dataset.id)); });
  tick($('f-kinds'), state.kinds);
  tick($('f-markets'), state.markets);
  ['f-build', 'f-fresh', 'f-mode', 'f-metric', 'f-level', 'stack-by'].forEach((id) => $(id).sync());
  $('fresh-note').textContent = state.fresh
    ? `Vpisano v ETN od ${entryDate(state.fresh - 1)} do ${entryDate(0)}.`
    : `Zadnji vpis v ETN: ${entryDate(0)}.`;

  syncRange('year-range', 'y0', 'y1', state.y0, state.y1, store.firstYear, store.lastYear);
  syncRange('built-range', 'b0', 'b1', state.b0, state.b1, store.builtMin, store.builtMax);
  $('year-label').textContent = state.y0 === state.y1 ? `${state.y0}` : `${state.y0}–${state.y1}`;
  $('built-label').textContent = builtLabel();

  $('min-area').value = state.minArea ?? '';
  $('max-area').value = state.maxArea ?? '';
  $('min-land').value = state.minLand ?? '';
  $('max-land').value = state.maxLand ?? '';
  $('min-price').value = state.minPrice ?? '';
  $('max-price').value = state.maxPrice ?? '';
  $('include-part').checked = state.includePart;
  $('include-bundle').checked = state.includeBundle;

  const chip = $('area-chip');
  chip.hidden = !state.area;
  chip.textContent = state.area ? `${areaName(state.area)} ×` : '';

  const classesChosen = new Set([...state.types].map((t) => (LAND_TYPES.has(t) ? t : 0)));
  const hint = $('map-hint');
  hint.hidden = !(classesChosen.size > 1 && ['em', 'bm', 'growth'].includes(state.metric));
  hint.textContent = 'Izbrani tipi imajo različne cenovne ravni. €/m² primerjajte znotraj enega tipa.';
}

function setArea(area, focus) {
  const same = state.area && area && state.area.level === area.level && state.area.id === area.id;
  state.area = same ? null : area;
  if (focus) {
    if (state.area) map.focusArea(state.area);
    else map.resetView();
  }
  changed();
}

function stopPlay() {
  if (!playTimer) return;
  clearInterval(playTimer);
  playTimer = null;
  const button = $('play');
  button.setAttribute('aria-pressed', 'false');
  button.querySelector('span').textContent = 'Predvajaj po letih';
}

function togglePlay() {
  if (playTimer) { stopPlay(); return; }
  const button = $('play');
  button.setAttribute('aria-pressed', 'true');
  button.querySelector('span').textContent = 'Ustavi';
  let year = state.y0 === state.y1 ? state.y0 : store.firstYear - 1;
  const step = () => {
    year = year >= store.lastYear ? store.firstYear : year + 1;
    state.y0 = state.y1 = year;
    changed();
  };
  step();
  playTimer = setInterval(step, 1500);
}

/* Rendering ------------------------------------------------------------- */

let queued = false;
function changed() {
  if (queued) return;
  queued = true;
  setTimeout(() => {
    queued = false;
    render();
  });
}

function render() {
  lists = select(store, state);
  analysis = analyse(store, state, lists);
  stats = regions(store, state, lists.map, state.level);
  syncControls();
  map.update({ state, list: lists.map, stats });
  renderKpis();
  renderCharts();
  renderLand();
  renderAreas();
  writeHash();
}

function renderKpis() {
  const a = analysis;
  const typesText = state.types.size === TYPE_IDS.length ? 'Vse nepremičnine'
    : state.types.size === 0 ? 'Brez izbranega tipa'
      : TYPE_IDS.filter((t) => state.types.has(t)).map(typeName).join(', ');
  $('scope').textContent = `${typesText} · ${areaName(state.area)} · ${state.y0 === state.y1 ? state.y0 : `${state.y0}–${state.y1}`}`;

  const latest = a.latest;
  const change = Number.isFinite(a.yoy)
    ? `<i aria-hidden="true">${a.yoy >= 0 ? '▲' : '▼'}</i> ${percent(a.yoy)} glede na prejšnje leto · ` : '';
  const delta = latest ? `<span class="delta">${change}${count(latest.nEm)} poslov</span>` : '';
  const withoutLand = state.types.has(HOUSE) && latest?.nBm >= MIN_SAMPLE
    ? `<span class="delta">Brez zemljišča približno ${perM2(latest.bm)}</span>` : '';
  const tile = (label, value, note = '') => `<div class="tile"><span>${label}</span><strong>${value}</strong>${note ? `<small>${note}</small>` : ''}</div>`;
  $('kpis').innerHTML = `
    <div class="hero">
      <span>Mediana cene na m²${latest ? `, ${yearLabel(latest.year)}` : ''}</span>
      <strong>${latest ? perM2(latest.em) : '–'}</strong>
      ${delta}${withoutLand}
    </div>
    ${tile('Posli', count(a.totals.n))}
    ${tile('Promet', money(a.totals.value))}
    ${tile('Rast', percent(a.growth), a.growthFrom && Number.isFinite(a.growth) ? `od ${a.growthFrom}` : '')}
    ${tile('Cena/GURS', ratio(a.latestRatio), latest ? `${yearLabel(latest.year)}` : '')}`;
}

function renderCharts() {
  if (!analysis) return;
  const a = analysis;
  const chosen = TYPE_IDS.filter((t) => state.types.has(t));
  const partialIndex = a.quarters.indexOf(store.firstPartialQuarter);
  const partialFrom = partialIndex > 0 ? partialIndex - 1 : Infinity;
  const quarterNames = a.quarters.map((q) => quarterLabel(store, q));
  const yearNames = a.years.map(yearLabel);

  // Small multiples: land and flats live on different scales, so never one axis.
  const host = $('c-trend');
  const many = chosen.length > 1;
  host.classList.toggle('grid-2', many);
  host.innerHTML = chosen.length
    ? chosen.map((t) => `<div class="mini"><h4><i style="background:${seriesColor(t)}"></i>${typeName(t)}</h4><div id="mini-${t}"></div></div>`).join('')
    : '<p class="empty">Izberite vsaj en tip nepremičnine.</p>';
  for (const t of chosen) {
    const cells = a.byQuarterType.get(t) || [];
    // A small area rarely fills a quarter, so its line falls back to whole years.
    const sparse = cells.filter((c) => Number.isFinite(c.em)).length < cells.length / 2;
    const years = a.years.map((y) => a.byYearType.get(y * 10 + t));
    lineChart($(`mini-${t}`), {
      x: sparse ? yearNames : quarterNames,
      series: [{
        label: typeName(t),
        color: seriesColor(t),
        values: sparse ? years.map((c) => (c.nEm >= MIN_SAMPLE ? c.em : NaN)) : cells.map((c) => c.em),
        notes: (sparse ? years.map((c) => c.nEm) : cells.map((c) => c.n)).map((n) => `${count(n)} poslov`),
      }],
      format: perM2,
      formatAxis: compactAxis,
      partialFrom: sparse ? Infinity : partialFrom,
      height: many ? 140 : 190,
      label: `Mediana cene na m² po četrtletjih, ${typeName(t)}`,
    });
  }
  document.querySelector('#card-trend .tabular').innerHTML = table(
    ['Četrtletje', ...chosen.map(typeName)],
    quarterNames.map((q, i) => [q, ...chosen.map((t) => perM2(a.byQuarterType.get(t)?.[i]?.em))]),
  );

  // Index
  const indexSeries = TYPE_IDS.map((t) => {
    const raw = a.years.map((y) => {
      const cell = a.byYearType.get(y * 10 + t);
      return cell.nEm >= MIN_SAMPLE ? cell.em : NaN;
    });
    const base = raw.find(Number.isFinite);
    return { label: typeName(t), color: seriesColor(t), values: raw.map((v) => (v / base) * 100), dim: !state.types.has(t) };
  }).filter((s) => s.values.some(Number.isFinite));
  $('index-sub').textContent = `Mediana €/m², prvo leto izbora = 100. ${state.types.size < TYPE_IDS.length ? 'Neizbrani tipi so zbledeli.' : ''}`;
  const indexFormat = (v) => Math.round(v).toLocaleString('sl-SI');
  lineChart($('c-index'), { x: yearNames, series: indexSeries, format: indexFormat, baseline: 100, height: 200, label: 'Indeks cen po tipih' });
  document.querySelector('#card-index .tabular').innerHTML = table(
    ['Tip', ...yearNames],
    indexSeries.map((s) => [s.label, ...s.values.map((v) => (Number.isFinite(v) ? indexFormat(v) : '–'))]),
  );

  renderYoy();

  // Deals by type
  const value = (t, y) => {
    const cell = a.byYearType.get(y * 10 + t);
    return stackBy === 'n' ? cell.n : cell.value;
  };
  const stackSeries = TYPE_IDS.map((t) => ({ label: typeName(t), color: seriesColor(t), values: a.years.map((y) => value(t, y)) }));
  const stackFormat = stackBy === 'n' ? count : money;
  stackedColumns($('c-deals'), {
    x: yearNames, series: stackSeries, format: stackFormat, formatAxis: stackBy === 'n' ? compactAxis : moneyAxis, label: 'Posli po tipih in letih',
  });
  document.querySelector('#card-deals .tabular').innerHTML = table(
    ['Tip', ...yearNames],
    stackSeries.map((s) => [s.label, ...s.values.map(stackFormat)]),
  );

  // Price against valuation
  const ratioSeries = TYPE_IDS.map((t) => ({
    label: typeName(t),
    color: seriesColor(t),
    dim: !state.types.has(t),
    values: a.years.map((y) => {
      const cell = a.byYearType.get(y * 10 + t);
      return cell.nRatio >= MIN_SAMPLE ? cell.ratio : NaN;
    }),
  })).filter((s) => s.values.some(Number.isFinite));
  lineChart($('c-ratio'), { x: yearNames, series: ratioSeries, format: ratio, baseline: 1, height: 190, label: 'Razmerje pogodbene cene in vrednosti GURS' });
  document.querySelector('#card-ratio .tabular').innerHTML = table(
    ['Tip', ...yearNames],
    ratioSeries.map((s) => [s.label, ...s.values.map(ratio)]),
  );
  const mid = median(a.ratioValues);
  histogram($('c-hist'), {
    values: a.ratioValues, from: 0, to: 3, step: 0.1, color: 'var(--s1)',
    marker: { value: mid, label: `mediana ${ratio(mid)}` },
    reference: { value: 1, label: 'vrednost GURS' },
    format: (v) => v.toLocaleString('sl-SI', { maximumFractionDigits: 1 }),
    label: 'Porazdelitev razmerja pogodbene cene in vrednosti GURS',
  });
}

const compactAxis = (v) => {
  if (Math.abs(v) >= 100000) return `${Math.round(v / 1000).toLocaleString('sl-SI')} tis.`;
  return v.toLocaleString('sl-SI', { maximumFractionDigits: 2, useGrouping: 'always' });
};
const moneyAxis = (v) => (v >= 1e9 ? `${(v / 1e9).toLocaleString('sl-SI', { maximumFractionDigits: 1 })} mrd` : `${Math.round(v / 1e6).toLocaleString('sl-SI')} mio`);

function changeCell(change) {
  if (!Number.isFinite(change)) return '<td class="num">–</td>';
  const strength = Math.min(1, Math.abs(change) / 0.25);
  const tone = change >= 0 ? 'var(--up)' : 'var(--down)';
  return `<td class="num heat" style="--tone:${tone};--strength:${Math.round(strength * 62)}%">${percent(change)}</td>`;
}

function renderYoy() {
  const a = analysis;
  const years = a.years.slice(1);
  if (!years.length) {
    $('c-yoy').innerHTML = '<p class="empty">Izberite vsaj dve leti.</p>';
    return;
  }
  const cell = (t, y) => {
    const now = a.byYearType.get(y * 10 + t), prev = a.byYearType.get((y - 1) * 10 + t);
    return changeCell(now.nEm < 10 || prev.nEm < 10 ? NaN : now.em / prev.em - 1);
  };
  $('c-yoy').innerHTML = `<table class="data yoy">
    <thead><tr><th>Tip</th>${years.map((y) => `<th class="num">${yearLabel(y)}</th>`).join('')}</tr></thead>
    <tbody>${TYPE_IDS.map((t) => `<tr class="${state.types.has(t) ? '' : 'is-dim'}"><td><i style="background:${seriesColor(t)}"></i>${typeName(t)}</td>${years.map((y) => cell(t, y)).join('')}</tr>`).join('')}</tbody>
  </table>`;
}

function renderLand() {
  const bands = housesByLand(store, lists.base);
  const rows = bands.filter((band) => band.n);
  // With a land filter on, the peers would all have about the same land.
  const landFiltered = state.minLand !== null || state.maxLand !== null;
  $('c-land').innerHTML = rows.length ? `<table class="data">
    <thead><tr><th>Zemljišče</th><th class="num">Posli</th><th class="num">Cena</th><th class="num">€/m²</th><th class="num">Proti podobnim</th></tr></thead>
    <tbody>${rows.map((band) => `<tr><td>${band.label}</td><td class="num">${count(band.n)}</td><td class="num">${money(band.price)}</td><td class="num">${perM2(band.em).replace(' €/m²', '')}</td>${changeCell(landFiltered ? NaN : band.peers)}</tr>`).join('')}</tbody>
  </table>` : '<p class="empty">V izboru ni hiš.</p>';
  $('land-note').hidden = !rows.length || bands[bands.length - 1].n > 0;
}

function renderAreas() {
  const { municipalities, cadastral, cadastralMunicipality } = store.meta;
  const names = state.level === 'o' ? municipalities : cadastral;
  // With a municipality or one of its parts chosen, the list shows that municipality's parts.
  const within = state.level === 'k' && state.area
    ? (state.area.level === 'o' ? state.area.id : cadastralMunicipality[state.area.id]) : null;
  $('areas-title').textContent = state.level === 'o' ? 'Občine' : `Katastrske občine${within ? `, ${municipalities[within]}` : ''}`;
  const columns = [
    ['n', 'Posli', count],
    ['em', '€/m²', (v) => perM2(v).replace(' €/m²', '')],
    ['growth', 'Rast', percent],
    ['ratio', 'Cena/GURS', ratio],
  ];
  const rows = [];
  for (const [id, rec] of stats) {
    if (!names[id] || rec.n < MIN_SAMPLE) continue;
    if (within && cadastralMunicipality[id] !== within) continue;
    rows.push({ id, name: names[id], rec });
  }
  const score = (r) => {
    const v = rankBy === 'n' ? r.rec.n : metricValue(r.rec, rankBy);
    return Number.isFinite(v) ? v : -Infinity;
  };
  rows.sort((a, b) => score(b) - score(a));
  const selected = (r) => state.area && state.area.level === state.level && state.area.id === r.id;
  const value = (r, key) => (key === 'n' ? r.rec.n : metricValue(r.rec, key));
  $('c-areas').innerHTML = `<table class="data ranks">
    <thead><tr><th>Območje</th>${columns.map(([key, label]) => `<th class="num"><button type="button" data-sort="${key}" aria-pressed="${rankBy === key}">${label}${rankBy === key ? ' ↓' : ''}</button></th>`).join('')}</tr></thead>
    <tbody>${rows.slice(0, 60).map((r) => `<tr data-id="${r.id}" tabindex="0" class="${selected(r) ? 'is-picked' : ''}"><td>${r.name}</td>${columns.map(([key, , format]) => `<td class="num">${format(value(r, key))}</td>`).join('')}</tr>`).join('')}</tbody>
  </table>${rows.length ? '' : '<p class="empty">Nobeno območje nima vsaj 5 poslov.</p>'}`;
}

function bindAreas() {
  const host = $('c-areas');
  const pick = (row) => setArea({ level: state.level, id: Number(row.dataset.id) }, true);
  host.addEventListener('click', (e) => {
    const sort = e.target.closest('[data-sort]');
    if (sort) {
      rankBy = sort.dataset.sort;
      renderAreas();
      return;
    }
    const row = e.target.closest('tr[data-id]');
    if (row) pick(row);
  });
  host.addEventListener('keydown', (e) => {
    const row = e.target.closest('tr[data-id]');
    if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); pick(row); }
  });
}

/* Map callbacks --------------------------------------------------------- */

const tipRow = (label, value) => `<div class="tip-row"><span>${label}</span><b>${value}</b></div>`;

function hoverArea(level, id, event) {
  if (!level) { hideTip(); return; }
  // The numbers in stats belong to the level on show, which can lag a zoom by one render.
  const rec = level === state.level ? stats?.get(id) : null;
  const body = rec ? [
    tipRow('Posli', count(rec.n)),
    tipRow('Mediana €/m²', perM2(metricValue(rec, 'em'))),
    state.types.has(HOUSE) ? tipRow('Brez zemljišča', perM2(metricValue(rec, 'bm'))) : '',
    tipRow('Mediana cene', money(metricValue(rec, 'price'))),
    tipRow('Rast', percent(rec.growth)),
    tipRow('Cena / GURS', ratio(metricValue(rec, 'ratio'))),
  ].join('') : tipRow('Posli', '0');
  showTip(`<div class="tip-title">${areaName({ level, id }) || ''}</div>${body}`, event.clientX, event.clientY);
}

const dealDate = (d, i) => `${d.day[i]}. ${(store.m[i] % 12) + 1}. ${store.firstYear + Math.floor(store.m[i] / 12)}`;

function dealPlace(d, i) {
  const place = d.dict[d.place[i]], address = d.dict[d.address[i]];
  return [address, place && !address.startsWith(place) ? place : ''].filter(Boolean).join(', ') || store.meta.municipalities[store.o[i]] || '';
}

const squareMetres = (v) => `${v.toLocaleString('sl-SI', { maximumFractionDigits: 1, useGrouping: 'always' })} m²`;

function dealFacts(d, i) {
  const isLand = LAND_TYPES.has(store.t[i]);
  const farm = d.farm[i] ? `, od tega ${squareMetres(d.farm[i])} kmetijsko in gozd` : '';
  const facts = [
    ['Pogodba', dealDate(d, i)],
    ['Cena', money(store.p[i])],
    [isLand ? 'Površina' : 'Uporabna površina', store.a[i] ? squareMetres(store.a[i]) : ''],
    ['Skupna površina', store.d[i] > store.a[i] ? squareMetres(store.d[i]) : ''],
    ['Zemljišče', store.l[i] && !isLand ? squareMetres(store.l[i]) + farm : ''],
    ['Cena na m²', Number.isFinite(store.em[i]) ? perM2(store.em[i]) : ''],
    ['Brez zemljišča', store.t[i] === HOUSE && Number.isFinite(store.bm[i]) ? `približno ${perM2(store.bm[i])}` : ''],
    ['Vrednost GURS', store.g[i] ? money(store.g[i]) : ''],
    ['Od tega zemljišče', store.g[i] && store.h[i] && !isLand ? `${Math.round((store.h[i] / store.g[i]) * 100)} %` : ''],
    ['Cena / GURS', Number.isFinite(store.ratio[i]) ? ratio(store.ratio[i]) : ''],
    ['Leto izgradnje', store.b[i] || ''],
    ['Konstrukcija', store.c[i] ? store.meta.construction[store.c[i]] : ''],
    ['Posel', KINDS[store.v[i]]],
    ['Tržnost', MARKETS[store.r[i]]],
    ['Vpis v ETN', entryDate(store.u[i])],
  ];
  return facts.filter(([, value]) => value);
}

function dealWord(n) {
  const tail = n % 100;
  if (tail === 1) return 'posel';
  if (tail === 2) return 'posla';
  return tail === 3 || tail === 4 ? 'posli' : 'poslov';
}

let hoveredSpot = null;

async function hoverSpot(list, event) {
  hoveredSpot = list;
  if (!list) { hideTip(); return; }
  const d = await loadDetails();
  if (hoveredSpot !== list) return;
  const [i] = list;
  // Coordinates are rounded to about 10 m, so one dot can hold neighbouring house numbers.
  const oneAddress = new Set(list.map((sale) => dealPlace(d, sale).toLowerCase())).size === 1;
  const title = `<div class="tip-title">${oneAddress ? dealPlace(d, i) : store.meta.municipalities[store.o[i]]}</div>`;
  if (list.length === 1) {
    showTip(title + dealFacts(d, i).slice(0, TIP_FACTS).map(([label, value]) => tipRow(label, value)).join(''), event.clientX, event.clientY);
    return;
  }
  const rows = list.slice(0, TIP_DEALS).map((sale) => tipRow(
    [dealDate(d, sale), oneAddress ? '' : d.dict[d.address[sale]]].filter(Boolean).join(', '),
    money(store.p[sale]),
  ));
  if (list.length > TIP_DEALS) rows.push(tipRow('Starejši', `še ${count(list.length - TIP_DEALS)}`));
  const sub = `<div class="tip-sub">${count(list.length)} ${dealWord(list.length)} na tej točki. Kliknite za podrobnosti.</div>`;
  showTip(title + sub + rows.join(''), event.clientX, event.clientY);
}

function renderLegend(legend) {
  const host = $('legend');
  if (legend.empty) {
    host.innerHTML = `<h4>${legend.title}</h4><p>Ni dovolj podatkov.</p>`;
    return;
  }
  const scale = legend.gradient
    ? `<div class="gradient" style="background:linear-gradient(90deg,${legend.gradient.join(',')})"></div>
       <div class="ends"><span>${legend.low}</span><span>${legend.high}</span></div>`
    : `<div class="steps">${legend.bins.map((c) => `<i style="background:${c}"></i>`).join('')}</div>
       <div class="ends"><span>&lt; ${legend.labels[0]}</span><span>&ge; ${legend.labels[legend.labels.length - 1]}</span></div>`;
  host.innerHTML = `<h4>${legend.title}</h4>${scale}${legend.note ? `<p>${legend.note}</p>` : ''}`;
}

async function showDeal(list, at = 0) {
  const d = await loadDetails();
  const i = list[at];
  const parts = dealFacts(d, i).map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`);
  const newBuild = store.f[i] & 1 ? ' · novogradnja' : '';
  const pager = list.length > 1 ? `<div class="deal-pager">
    <button type="button" data-step="-1" aria-label="Prejšnji posel">‹</button>
    <span>${at + 1} od ${count(list.length)}</span>
    <button type="button" data-step="1" aria-label="Naslednji posel">›</button></div>` : '';
  const box = map.popup([store.lon[i], store.lat[i]], `<div class="deal">
    <p class="eyebrow">${typeName(store.t[i])}${newBuild}</p>
    <h4>${dealPlace(d, i)}</h4>
    <p class="deal-sub">${store.meta.municipalities[store.o[i]] || ''}${store.meta.cadastral[store.k[i]] ? ` · k. o. ${store.meta.cadastral[store.k[i]]}` : ''}</p>
    <dl>${parts.join('')}</dl>${pager}</div>`);
  for (const button of box.querySelectorAll('[data-step]')) {
    button.addEventListener('click', () => showDeal(list, (at + Number(button.dataset.step) + list.length) % list.length));
  }
}

async function downloadCsv() {
  const button = $('download');
  button.disabled = true;
  button.textContent = 'Pripravljam';
  const d = await loadDetails();
  const quote = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = ['id_posla;datum;tip;obcina;ko;naselje;naslov;cena_eur;povrsina_m2;skupna_povrsina_m2;zemljisce_m2;kmetijsko_gozd_m2;eur_m2;eur_m2_brez_zemljisca;vrednost_gurs_eur;vrednost_zemljisca_gurs_eur;cena_gurs;leto_izgradnje;vrsta_posla;trznost;vpis_etn'];
  for (const i of lists.sel) {
    const month = String((store.m[i] % 12) + 1).padStart(2, '0');
    const day = String(d.day[i]).padStart(2, '0');
    rows.push([
      d.id[i], `${store.firstYear + Math.floor(store.m[i] / 12)}-${month}-${day}`, typeName(store.t[i]),
      quote(store.meta.municipalities[store.o[i]]), quote(store.meta.cadastral[store.k[i]]),
      quote(d.dict[d.place[i]]), quote(d.dict[d.address[i]]), store.p[i], store.a[i] ? store.a[i].toFixed(1) : '',
      store.d[i] ? store.d[i].toFixed(1) : '', store.l[i] || '', d.farm[i] || '',
      Number.isFinite(store.em[i]) ? store.em[i].toFixed(2) : '',
      Number.isFinite(store.bm[i]) ? store.bm[i].toFixed(2) : '', store.g[i] || '', store.g[i] ? store.h[i] : '',
      Number.isFinite(store.ratio[i]) ? store.ratio[i].toFixed(3) : '', store.b[i] || '',
      quote(KINDS[store.v[i]]), quote(MARKETS[store.r[i]]), entryDate(store.u[i]),
    ].join(';'));
  }
  const url = URL.createObjectURL(new Blob([`﻿${rows.join('\n')}`], { type: 'text/csv;charset=utf-8' }));
  const link = Object.assign(document.createElement('a'), { href: url, download: 'kataster-cen-posli.csv' });
  link.click();
  URL.revokeObjectURL(url);
  button.disabled = false;
  button.textContent = 'Prenesi CSV';
}

/* Start ----------------------------------------------------------------- */

async function start() {
  store = await loadStore();
  state = defaultState(store);
  readHash();
  const { meta } = store;
  $('stamp').textContent = `Stanje ETN ${formatDate(meta.etnDate)}`;
  $('source').innerHTML = `Vir: Geodetska uprava Republike Slovenije, Evidenca trga nepremičnin (kupoprodajni posli), stanje ${formatDate(meta.etnDate)}; Evidenca vrednotenja, stanje ${formatDate(meta.evDate)}; Register prostorskih enot in kataster nepremičnin. Licenca <a href="https://creativecommons.org/licenses/by/4.0/deed.sl" rel="noopener">CC BY 4.0</a>. Neuradni prikaz, ni cenitev.`;

  buildControls();
  bindAreas();
  syncTabs();
  map = new SalesMap('map', store, {
    theme: themeNow(),
    onHover: hoverArea,
    onSpot: hoverSpot,
    onLegend: renderLegend,
    onLevel: (level) => { state.level = level; changed(); },
    onArea: (level, id) => {
      setArea({ level, id }, false);
      if (state.area) map.focusArea(state.area);   // a second click clears the choice and stays put
    },
    onDeal: showDeal,
  });
  render();
  $('loading').hidden = true;
  if (state.area) map.focusArea(state.area);

  let resizeQueued = false;
  new ResizeObserver(() => {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(() => { resizeQueued = false; renderCharts(); });
  }).observe(document.querySelector('.rail'));
}

start().catch((error) => {
  console.error(error);
  $('loading').innerHTML = '<span>Podatkov ni bilo mogoče naložiti. Osvežite stran.</span>';
});
