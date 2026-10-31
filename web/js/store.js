// Loads the sale records into typed arrays and answers every filter and aggregate
// in the browser, so a filter change never needs a server.

const FLAG_NEW = 1, FLAG_PART = 2, FLAG_BUNDLE = 4, FLAG_NO_PRICE = 32;

export const MIN_SAMPLE = 5;
const MIN_GROWTH_SAMPLE = 8;   // two small medians make a very noisy ratio

export const TYPE_IDS = [1, 2, 3, 4, 5, 6];

export const KINDS = {
  1: 'Prosti trg',
  2: 'Prostovoljna dražba',
  3: 'Izvršba, stečaj',
  4: 'Povezane osebe',
  5: 'Lizing',
};

export const MARKETS = {
  1: 'Tržen posel',
  2: 'Tržen, neustrezni podatki',
  5: 'V preverjanju',
  3: 'Drug posel',
  4: 'Neopredeljen',
};

export const PERIODS = [
  { id: 1, label: 'do 1918', lo: 1, hi: 1918 },
  { id: 2, label: '1919–45', lo: 1919, hi: 1945 },
  { id: 3, label: '1946–70', lo: 1946, hi: 1970 },
  { id: 4, label: '1971–90', lo: 1971, hi: 1990 },
  { id: 5, label: '1991–2010', lo: 1991, hi: 2010 },
  { id: 6, label: 'po 2010', lo: 2011, hi: 9999 },
];

async function json(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

function mercator(lon, lat) {
  const x = (lon + 180) / 360;
  const y = 0.5 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / (2 * Math.PI);
  return [x, y];
}

export function fromMercator(x, y) {
  return [x * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI];
}

export function median(values) {
  const n = values.length;
  if (!n) return NaN;
  const sorted = Float64Array.from(values).sort();
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

export function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const at = (sorted.length - 1) * q;
  const low = Math.floor(at);
  const high = Math.min(low + 1, sorted.length - 1);
  return sorted[low] + (sorted[high] - sorted[low]) * (at - low);
}

export async function loadStore() {
  const [deals, meta] = await Promise.all([json('data/deals.json'), json('data/meta.json')]);
  const c = deals.cols;
  const n = deals.n;
  const store = {
    n, meta,
    t: Uint8Array.from(c.t), m: Uint8Array.from(c.m), o: Uint16Array.from(c.o), k: Uint16Array.from(c.k),
    f: Uint8Array.from(c.f), v: Uint8Array.from(c.v), r: Uint8Array.from(c.r), b: Uint16Array.from(c.b),
    c: Uint8Array.from(c.c), s: Uint8Array.from(c.s), p: Float64Array.from(c.p), a: Float32Array.from(c.a),
    g: Float64Array.from(c.g), l: Float32Array.from(c.l),
    lon: new Float32Array(n), lat: new Float32Array(n), mx: new Float32Array(n), my: new Float32Array(n),
    em: new Float32Array(n), ratio: new Float32Array(n),
  };
  for (let i = 0; i < n; i++) {
    const lon = c.x[i] / 1e4, lat = c.y[i] / 1e4;
    store.lon[i] = lon;
    store.lat[i] = lat;
    if (lon) [store.mx[i], store.my[i]] = mercator(lon, lat);
    store.em[i] = store.f[i] & FLAG_NO_PRICE ? NaN : store.p[i] / store.a[i];
    const ratio = store.g[i] > 0 ? store.p[i] / store.g[i] : NaN;
    store.ratio[i] = ratio > 0.1 && ratio < 10 ? ratio : NaN;
  }
  store.firstYear = meta.firstYear;
  store.lastYear = meta.firstYear + Math.floor(meta.lastMonth / 12);
  store.firstPartialQuarter = findPartialQuarter(store);
  return store;
}

// Sales reach ETN months after signing, so the newest quarters look like a collapse.
// A quarter counts as unfinished while it holds clearly fewer sales than the year before it.
function findPartialQuarter(store) {
  const counts = new Int32Array(Math.floor(store.meta.lastMonth / 3) + 1);
  for (let i = 0; i < store.n; i++) counts[Math.floor(store.m[i] / 3)]++;
  let first = counts.length;
  for (let q = counts.length - 1; q >= 8; q--) {
    if (counts[q] < 0.75 * median(counts.subarray(q - 8, q - 4))) first = q; else break;
  }
  return first;
}

export const quarterLabel = (store, q) => `${store.firstYear + Math.floor(q / 4)} Q${(q % 4) + 1}`;

export function defaultState(store) {
  return {
    types: new Set([1]),
    y0: store.firstYear,
    y1: store.lastYear,
    kinds: new Set([1]),
    markets: new Set([1, 2, 5]),
    build: 'all',
    periods: new Set(),
    constructions: new Set(),
    buildingTypes: new Set(),
    minArea: null, maxArea: null, minPrice: null, maxPrice: null,
    includePart: false,
    includeBundle: false,
    area: null,
    mode: 'heat',
    metric: 'em',
    level: 'o',
  };
}

// base: passes every filter except property type (by-type charts need all six)
// map:  passes every filter except the selected area (the map always shows the country)
// sel:  passes everything
export function select(store, s) {
  const { n, t, m, f, v, r, b, c, s: bt, p, a, o, k } = store;
  const base = new Int32Array(n), map = new Int32Array(n), sel = new Int32Array(n);
  let nBase = 0, nMap = 0, nSel = 0;

  const m0 = (s.y0 - store.firstYear) * 12, m1 = (s.y1 - store.firstYear) * 12 + 11;
  const blocked = (s.includePart ? 0 : FLAG_PART) | (s.includeBundle ? 0 : FLAG_BUNDLE);
  const kinds = new Uint8Array(16), markets = new Uint8Array(16), types = new Uint8Array(8);
  s.kinds.forEach((x) => { kinds[x] = 1; });
  s.markets.forEach((x) => { markets[x] = 1; });
  s.types.forEach((x) => { types[x] = 1; });
  const areaKey = s.area ? (s.area.level === 'o' ? o : k) : null;
  const areaId = s.area ? s.area.id : 0;
  const periods = [...s.periods].map((id) => PERIODS.find((x) => x.id === id));
  const newOnly = s.build === 'new', usedOnly = s.build === 'used';

  for (let i = 0; i < n; i++) {
    if (m[i] < m0 || m[i] > m1) continue;
    if (f[i] & blocked) continue;
    if (!kinds[v[i]] || !markets[r[i]]) continue;
    if (newOnly && !(f[i] & FLAG_NEW)) continue;
    if (usedOnly && f[i] & FLAG_NEW) continue;
    if (s.constructions.size && !s.constructions.has(c[i])) continue;
    if (s.buildingTypes.size && !s.buildingTypes.has(bt[i])) continue;
    if (periods.length && !periods.some((x) => b[i] >= x.lo && b[i] <= x.hi)) continue;
    if (s.minArea !== null && a[i] < s.minArea) continue;
    if (s.maxArea !== null && a[i] > s.maxArea) continue;
    if (s.minPrice !== null && p[i] < s.minPrice) continue;
    if (s.maxPrice !== null && p[i] > s.maxPrice) continue;

    const inArea = !areaKey || areaKey[i] === areaId;
    if (inArea) base[nBase++] = i;
    if (types[t[i]]) {
      map[nMap++] = i;
      if (inArea) sel[nSel++] = i;
    }
  }
  return { base: base.subarray(0, nBase), map: map.subarray(0, nMap), sel: sel.subarray(0, nSel) };
}

const emptyCell = () => ({ n: 0, value: 0, em: [], price: [], ratio: [] });

function collect(cell, store, i) {
  cell.n++;
  cell.value += store.p[i];
  cell.price.push(store.p[i]);
  const em = store.em[i], ratio = store.ratio[i];
  if (em === em) cell.em.push(em);
  if (ratio === ratio) cell.ratio.push(ratio);
}

function summarise(cell) {
  return {
    n: cell.n,
    value: cell.value,
    nEm: cell.em.length,
    nRatio: cell.ratio.length,
    em: median(cell.em),
    price: median(cell.price),
    ratio: median(cell.ratio),
  };
}

export function analyse(store, s, lists) {
  const years = [];
  for (let y = s.y0; y <= s.y1; y++) years.push(y);

  // Year by type, from the list that ignores the type filter.
  const yearType = new Map();
  for (const y of years) for (const t of TYPE_IDS) yearType.set(y * 10 + t, emptyCell());
  for (const i of lists.base) {
    collect(yearType.get((store.firstYear + Math.floor(store.m[i] / 12)) * 10 + store.t[i]), store, i);
  }
  const byYearType = new Map();
  for (const [key, cell] of yearType) byYearType.set(key, summarise(cell));

  // Quarterly price per selected type.
  const q0 = (s.y0 - store.firstYear) * 4;
  const q1 = Math.min((s.y1 - store.firstYear) * 4 + 3, Math.floor(store.meta.lastMonth / 3));
  const quarters = [];
  for (let q = q0; q <= q1; q++) quarters.push(q);
  const quarterType = new Map();
  for (const t of s.types) quarterType.set(t, quarters.map(() => []));
  const total = emptyCell();
  const yearly = years.map(emptyCell);
  const ratioValues = [];
  for (const i of lists.sel) {
    const q = Math.floor(store.m[i] / 3);
    const em = store.em[i];
    if (em === em) quarterType.get(store.t[i])[q - q0].push(em);
    collect(total, store, i);
    collect(yearly[store.firstYear + Math.floor(store.m[i] / 12) - s.y0], store, i);
    if (store.ratio[i] === store.ratio[i]) ratioValues.push(store.ratio[i]);
  }
  const byQuarterType = new Map();
  for (const [t, cells] of quarterType) {
    byQuarterType.set(t, cells.map((values) => ({ n: values.length, em: values.length >= MIN_SAMPLE ? median(values) : NaN })));
  }

  const perYear = yearly.map(summarise);
  const totals = summarise(total);
  const usable = perYear.map((x, i) => ({ ...x, year: years[i] })).filter((x) => x.nEm >= MIN_SAMPLE);
  const last = usable[usable.length - 1], before = usable[usable.length - 2], first = usable[0];
  const usableRatio = perYear.filter((x) => x.nRatio >= MIN_SAMPLE);

  return {
    years, quarters, byYearType, byQuarterType, totals, perYear,
    latest: last || null,
    yoy: last && before ? last.em / before.em - 1 : NaN,
    growth: last && first && last !== first ? last.em / first.em - 1 : NaN,
    growthFrom: first ? first.year : null,
    latestRatio: usableRatio.length ? usableRatio[usableRatio.length - 1].ratio : NaN,
    ratioValues,
  };
}

export function regions(store, s, list, level) {
  const key = level === 'o' ? store.o : store.k;
  const groups = new Map();
  const firstMonth = (s.y0 - store.firstYear) * 12, lastYearMonth = (s.y1 - store.firstYear) * 12;
  for (const i of list) {
    const id = key[i];
    let g = groups.get(id);
    if (!g) groups.set(id, (g = { all: emptyCell(), first: [], last: [] }));
    collect(g.all, store, i);
    const em = store.em[i];
    if (em === em) {
      if (store.m[i] < firstMonth + 12) g.first.push(em);
      if (store.m[i] >= lastYearMonth) g.last.push(em);
    }
  }
  const out = new Map();
  const comparable = s.y1 > s.y0;
  for (const [id, g] of groups) {
    const rec = summarise(g.all);
    rec.growth = comparable && g.first.length >= MIN_GROWTH_SAMPLE && g.last.length >= MIN_GROWTH_SAMPLE
      ? median(g.last) / median(g.first) - 1 : NaN;
    out.set(id, rec);
  }
  return out;
}

export function metricValue(rec, metric) {
  if (!rec) return NaN;
  switch (metric) {
    case 'em': return rec.nEm >= MIN_SAMPLE ? rec.em : NaN;
    case 'price': return rec.n >= MIN_SAMPLE ? rec.price : NaN;
    case 'ratio': return rec.nRatio >= MIN_SAMPLE ? rec.ratio : NaN;
    case 'growth': return rec.growth;
    case 'count': return rec.n;
    default: return NaN;
  }
}

let details = null;
export function loadDetails() {
  details ||= json('data/details.json');
  return details;
}
