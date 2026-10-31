// MapLibre map with three views of the same selection: a kernel-smoothed heat surface,
// area polygons and individual sales.
import { fromMercator, median, metricValue, quantile } from './store.js';
import { METRICS, classes, count, lookup, ramp } from './scale.js';

const STYLES = {
  light: 'https://tiles.openfreemap.org/styles/positron',
  dark: 'https://tiles.openfreemap.org/styles/dark',
};
const PAINT = {
  light: { background: '#f1ede3', water: '#cdd9dc', line: '#191814', noData: 'rgba(25,24,20,0.04)', accent: '#c8401a', ring: '#fbf9f4' },
  dark: { background: '#101419', water: '#0a0e12', line: '#eceae3', noData: 'rgba(236,234,227,0.04)', accent: '#f0743f', ring: '#14181d' },
};
const SLOVENIA = [[13.37, 45.42], [16.61, 46.88]];
const MAX_POINTS = 40000;
const HIT_PX = 8;         // dots are tiny at low zoom, so the cursor only has to come close
const KO_ZOOM = 9.8;      // from here a municipality fills the view, so its parts take over
const CELL_PX = 3;       // heat grid resolution in screen pixels
const BLUR_RADIUS = 4;    // box radius in cells; three passes approximate a Gaussian
const BLUR_PASSES = 3;
const MIN_SUPPORT = 1.15; // a pixel needs more than one sale nearby to be coloured
const MARGIN = 0.15;      // heat is drawn past the viewport so panning shows no edge

function boxBlur(src, dst, w, h, r) {
  const norm = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      dst[row + x] = sum * norm;
      sum += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += dst[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      src[y * w + x] = sum * norm;
      sum += dst[Math.min(h - 1, y + r + 1) * w + x] - dst[Math.max(0, y - r) * w + x];
    }
  }
}

export class SalesMap {
  constructor(container, store, handlers) {
    this.store = store;
    this.handlers = handlers;
    this.theme = handlers.theme;
    this.geo = {};
    this.view = null;
    this.ready = false;
    this.spots = new Map();
    this.zoomLevel = 'o';
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = 4;
    fetch('geo/slovenija.geojson').then((r) => r.json()).then((data) => {
      const rings = data.geometries.flatMap((g) => (g.type === 'Polygon' ? g.coordinates : g.coordinates.flat()));
      this.borderRings = rings.map((ring) => ring.map(([lon, lat]) => {
        const c = maplibregl.MercatorCoordinate.fromLngLat([lon, lat]);
        return [c.x, c.y];
      }));
      if (this.ready && this.view?.state.mode === 'heat') this.drawHeat();
    });

    this.map = new maplibregl.Map({
      container,
      style: STYLES[this.theme],
      bounds: SLOVENIA,
      fitBoundsOptions: { padding: 24 },
      minZoom: 6.5,
      maxZoom: 17,
      maxBounds: [[10.5, 44], [19, 48.2]],
      dragRotate: false,
      pitchWithRotate: false,
      attributionControl: { compact: true },
    });
    this.map.touchZoomRotate.disableRotation();
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    this.map.on('style.load', () => this.install());
    this.map.once('load', () => {
      // On a phone the open credits box would sit on top of the legend.
      if (matchMedia('(max-width: 1000px)').matches) {
        const credits = this.map.getContainer().querySelector('.maplibregl-ctrl-attrib');
        credits?.classList.remove('maplibregl-compact-show');
        credits?.removeAttribute('open');
      }
    });
    this.map.on('moveend', () => {
      // Only a crossing changes the level, so a level picked by hand stays while zooming.
      const level = this.map.getZoom() >= KO_ZOOM ? 'k' : 'o';
      const crossed = level !== this.zoomLevel;
      this.zoomLevel = level;
      if (!this.view || !this.ready) return;
      if (this.view.state.mode === 'heat') this.drawHeat();
      if (this.view.state.mode === 'points') this.drawPoints();
      if (crossed) this.handlers.onLevel(level);
    });
    this.bindPointer();
  }

  // Listeners outlive setStyle, so they are bound once rather than on every theme change.
  bindPointer() {
    const { map } = this;
    for (const level of ['o', 'k']) {
      const { fill } = this.ids(level);
      map.on('mousemove', fill, (e) => this.hoverArea(level, e));
      map.on('mouseleave', fill, () => this.leaveArea());
      map.on('click', fill, (e) => {
        if (!this.pointsOn()) this.handlers.onArea(level, e.features[0].id);
      });
    }
    map.on('mousemove', (e) => {
      if (this.pointsOn()) this.hoverSpot(e);
    });
    map.on('click', (e) => {
      const spot = this.pointsOn() ? this.spotAt(e.point) : null;
      if (!spot) return;
      this.opened = spot;
      this.handlers.onSpot(null);
      this.handlers.onDeal(spot);
    });
    for (const type of ['mouseout', 'movestart']) map.on(type, () => this.handlers.onSpot(null));
  }

  pointsOn() {
    return this.ready && this.view?.state.mode === 'points';
  }

  setTheme(theme) {
    this.theme = theme;
    this.ready = false;
    this.loaded = null;   // a new style starts with empty sources
    this.map.setStyle(STYLES[theme]);
  }

  async regionData(level) {
    const name = level === 'o' ? 'obcine' : 'ko';
    this.geo[name] ||= fetch(`geo/${name}.geojson`).then((r) => r.json());
    return this.geo[name];
  }

  async install() {
    const map = this.map;
    const paint = PAINT[this.theme];
    map.setPaintProperty('background', 'background-color', paint.background);
    if (map.getLayer('water')) map.setPaintProperty('water', 'fill-color', paint.water);
    this.localiseLabels();
    const labels = map.getStyle().layers.find((l) => /^(label_|place_)/.test(l.id))?.id;

    for (const level of ['o', 'k']) {
      const ids = this.ids(level);
      map.addSource(ids.source, { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, promoteId: 'id' });
      map.addLayer({
        id: ids.fill, type: 'fill', source: ids.source,
        paint: { 'fill-color': paint.noData, 'fill-opacity': 0 },
        layout: { visibility: 'none' },
      }, labels);
      map.addLayer({
        id: ids.line, type: 'line', source: ids.source,
        paint: {
          'line-color': paint.line,
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 7, 0.16, 12, 0.34],
          'line-width': ['interpolate', ['linear'], ['zoom'], 7, 0.35, 12, 1],
        },
        layout: { visibility: 'none' },
      }, labels);
    }

    map.addSource('heat', { type: 'canvas', canvas: this.canvas, coordinates: this.heatCorners || [[0, 1], [1, 1], [1, 0], [0, 0]], animate: false });
    map.addLayer({
      id: 'heat', type: 'raster', source: 'heat',
      paint: { 'raster-opacity': 0.86, 'raster-resampling': 'linear', 'raster-fade-duration': 0 },
      layout: { visibility: 'none' },
    }, labels);

    for (const level of ['o', 'k']) {
      const ids = this.ids(level);
      map.addLayer({
        id: ids.focus, type: 'line', source: ids.source,
        paint: {
          'line-color': paint.accent,
          'line-width': ['case', ['boolean', ['feature-state', 'selected'], false], 2.5, ['boolean', ['feature-state', 'hover'], false], 1.5, 0],
        },
        layout: { visibility: 'none' },
      });
    }

    map.addSource('border', { type: 'geojson', data: 'geo/slovenija.geojson' });
    map.addLayer({
      id: 'border', type: 'line', source: 'border',
      paint: { 'line-color': paint.line, 'line-opacity': 0.55, 'line-width': 1 },
    }, labels);

    map.addSource('points', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'points', type: 'circle', source: 'points',
      paint: {
        'circle-color': ['get', 'c'],
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, 2, 11, 3.5, 15, 7],
        'circle-stroke-color': paint.ring,
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 7, 0.2, 13, 1.2],
      },
      layout: { visibility: 'none' },
    });

    this.ready = true;
    if (this.view) this.update(this.view);
  }

  // Slovene names where OpenStreetMap has them, and no country captions on a one-country map.
  localiseLabels() {
    for (const layer of this.map.getStyle().layers) {
      if (layer.type !== 'symbol' || !/^(label_|place_)/.test(layer.id)) continue;
      if (/country/.test(layer.id)) this.map.setLayoutProperty(layer.id, 'visibility', 'none');
      else this.map.setLayoutProperty(layer.id, 'text-field', ['coalesce', ['get', 'name:sl'], ['get', 'name']]);
    }
  }

  ids(level) {
    const name = level === 'o' ? 'obcine' : 'ko';
    return { source: name, fill: `${name}-fill`, line: `${name}-line`, focus: `${name}-focus` };
  }

  hoverArea(level, e) {
    if (this.pointsOn()) return;
    const id = e.features[0].id;
    const ids = this.ids(level);
    if (this.hovered && (this.hovered.id !== id || this.hovered.source !== ids.source)) {
      this.map.setFeatureState(this.hovered, { hover: false });
    }
    this.hovered = { source: ids.source, id };
    this.map.setFeatureState(this.hovered, { hover: true });
    this.map.getCanvas().style.cursor = 'pointer';
    this.handlers.onHover(level, id, e.originalEvent);
  }

  leaveArea() {
    if (!this.hovered) return;
    this.map.setFeatureState(this.hovered, { hover: false });
    this.hovered = null;
    this.map.getCanvas().style.cursor = '';
    this.handlers.onHover(null);
  }

  // The nearest dot under the cursor, as the list of sales it stands for.
  spotAt({ x, y }) {
    let nearest = null, best = Infinity;
    const box = [[x - HIT_PX, y - HIT_PX], [x + HIT_PX, y + HIT_PX]];
    for (const feature of this.map.queryRenderedFeatures(box, { layers: ['points'] })) {
      const at = this.map.project(feature.geometry.coordinates);
      const distance = (at.x - x) ** 2 + (at.y - y) ** 2;
      if (distance < best) { best = distance; nearest = feature; }
    }
    return (nearest && this.spots.get(nearest.properties.i)) || null;
  }

  hoverSpot(e) {
    const spot = this.spotAt(e.point);
    this.map.getCanvas().style.cursor = spot ? 'pointer' : '';
    const pinned = spot === this.opened && this.activePopup?.isOpen();
    this.handlers.onSpot(pinned ? null : spot, e.originalEvent);
  }

  // view: { state, list, stats, }
  async update(view) {
    this.view = view;
    if (!this.ready) return;
    const { state } = view;
    const map = this.map;
    const visible = (id, on) => map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    const inactive = state.level === 'o' ? 'k' : 'o';

    const active = this.ids(state.level);
    const off = this.ids(inactive);
    visible('heat', state.mode === 'heat');
    visible('points', state.mode === 'points');

    // The old level stays on show until the new one has arrived, so the map never goes empty.
    if (!this.loaded?.[state.level]) {
      const data = await this.regionData(state.level);
      map.getSource(active.source).setData(data);
      (this.loaded ||= {})[state.level] = true;
      if (this.view !== view) return;
    }

    for (const id of [off.fill, off.line, off.focus]) visible(id, false);
    for (const id of [active.fill, active.line, active.focus]) visible(id, true);
    this.paintAreas();
    this.markSelected();
    if (state.mode === 'heat') this.drawHeat();
    if (state.mode === 'points') this.drawPoints();
  }

  paintAreas() {
    const { state, stats } = this.view;
    const { metric, level, mode } = state;
    const map = this.map;
    const ids = this.ids(level);
    const colored = mode === 'areas';
    this.scale = null;

    const features = this.regionFeatures(level);
    const values = [];
    for (const [, rec] of stats) values.push(metricValue(rec, metric));
    const scale = colored ? classes(metric, values, this.theme) : null;
    this.scale = scale;

    for (const id of features) {
      const value = metricValue(stats.get(id), metric);
      map.setFeatureState({ source: ids.source, id }, { bin: scale && Number.isFinite(value) ? scale.bin(value) : -1 });
    }
    const palette = ramp(this.theme, METRICS[metric].diverging);
    map.setPaintProperty(ids.fill, 'fill-opacity', colored ? 0.88 : 0);
    map.setPaintProperty(ids.fill, 'fill-color', [
      'match', ['coalesce', ['feature-state', 'bin'], -1],
      ...palette.flatMap((color, i) => [i, color]),
      PAINT[this.theme].noData,
    ]);
    if (colored) this.handlers.onLegend(this.areaLegend(metric, scale));
  }

  regionFeatures(level) {
    const names = level === 'o' ? this.store.meta.municipalities : this.store.meta.cadastral;
    return Object.keys(names).map(Number);
  }

  markSelected() {
    const { state } = this.view;
    const ids = this.ids(state.level);
    if (this.selected) this.map.setFeatureState(this.selected, { selected: false });
    this.selected = null;
    if (state.area && state.area.level === state.level) {
      this.selected = { source: ids.source, id: state.area.id };
      this.map.setFeatureState(this.selected, { selected: true });
    }
  }

  async focusArea(area) {
    const data = await this.regionData(area.level);
    const feature = data.features.find((f) => f.properties.id === area.id);
    if (!feature) return;
    let [w, s, e, n] = [180, 90, -180, -90];
    const walk = (c) => {
      if (typeof c[0] === 'number') {
        w = Math.min(w, c[0]); e = Math.max(e, c[0]); s = Math.min(s, c[1]); n = Math.max(n, c[1]);
      } else c.forEach(walk);
    };
    walk(feature.geometry.coordinates);
    this.map.fitBounds([[w, s], [e, n]], { padding: 60, maxZoom: 13, duration: 700 });
  }

  resetView() {
    this.map.fitBounds(SLOVENIA, { padding: 24, duration: 700 });
  }

  areaLegend(metric, scale) {
    const info = METRICS[metric];
    if (!scale) return { title: info.title, empty: true };
    return { title: info.title, bins: scale.swatches, labels: scale.thresholds.map(info.format), note: 'Manj kot 5 poslov: brez barve' };
  }

  valueOf(metric, i) {
    const { store } = this;
    if (metric === 'em') return store.em[i];
    if (metric === 'bm') return store.bm[i];
    if (metric === 'price') return store.p[i];
    if (metric === 'ratio') return store.ratio[i];
    return NaN;
  }

  // Sale values are averaged in log space around each pixel, so one mansion cannot
  // repaint a village and the surface reads like a median rather than a mean.
  drawHeat() {
    const { state, list } = this.view;
    const { metric } = state;
    const info = METRICS[metric];
    const { store, map } = this;
    const heatMetric = info.heat ? metric : 'em';

    const box = map.getContainer().getBoundingClientRect();
    const w = Math.max(40, Math.round((box.width * (1 + 2 * MARGIN)) / CELL_PX));
    const h = Math.max(40, Math.round((box.height * (1 + 2 * MARGIN)) / CELL_PX));
    const bounds = map.getBounds();
    const a = maplibregl.MercatorCoordinate.fromLngLat(bounds.getNorthWest());
    const b = maplibregl.MercatorCoordinate.fromLngLat(bounds.getSouthEast());
    const spanX = b.x - a.x, spanY = b.y - a.y;
    const x0 = a.x - spanX * MARGIN, y0 = a.y - spanY * MARGIN;
    const dx = (spanX * (1 + 2 * MARGIN)) / w, dy = (spanY * (1 + 2 * MARGIN)) / h;

    const weight = new Float32Array(w * h), sum = new Float32Array(w * h), scratch = new Float32Array(w * h);
    const useValue = heatMetric !== 'count';
    const logs = [];
    for (let j = 0; j < list.length; j++) {
      const i = list[j];
      const col = Math.floor((store.mx[i] - x0) / dx), row = Math.floor((store.my[i] - y0) / dy);
      if (col < 0 || row < 0 || col >= w || row >= h) continue;
      if (useValue) {
        const value = this.valueOf(heatMetric, i);
        if (!(value > 0)) continue;
        const log = Math.log(value);
        sum[row * w + col] += log;
        logs.push(log);
      }
      weight[row * w + col] += 1;
    }

    for (let pass = 0; pass < BLUR_PASSES; pass++) {
      boxBlur(weight, scratch, w, h, BLUR_RADIUS);
      if (useValue) boxBlur(sum, scratch, w, h, BLUR_RADIUS);
    }

    // Weight is rescaled so one isolated sale peaks at 1, which keeps the fade independent of zoom.
    const size = 2 * BLUR_RADIUS + 1;
    const reach = 2 * Math.PI * ((BLUR_PASSES * (size * size - 1)) / 12);
    let lo, hi;
    const diverging = heatMetric === 'ratio';
    if (useValue) {
      const sorted = Float64Array.from(logs).sort();
      if (diverging) {
        const spread = quantile(Float64Array.from(sorted, Math.abs).sort(), 0.92) || 0.3;
        lo = -spread; hi = spread;
      } else {
        lo = quantile(sorted, 0.05); hi = quantile(sorted, 0.97);
      }
    } else {
      const positive = Float32Array.from(weight.filter((v) => v > 0)).sort();
      lo = 0; hi = quantile(positive, 0.985) || 1;
    }

    const lut = lookup(ramp(this.theme, diverging));
    const image = new ImageData(w, h);
    const pixels = image.data;
    const range = hi - lo || 1;
    for (let c = 0; c < w * h; c++) {
      const support = weight[c] * reach;
      if (support < MIN_SUPPORT) continue;
      const value = useValue ? sum[c] / weight[c] : weight[c];
      const t = Math.max(0, Math.min(1, (value - lo) / range));
      const shade = Math.round(t * 255) * 3;
      const p = c * 4;
      pixels[p] = lut[shade];
      pixels[p + 1] = lut[shade + 1];
      pixels[p + 2] = lut[shade + 2];
      pixels[p + 3] = 255 * Math.min(1, (support - MIN_SUPPORT) / 1.2);
    }

    this.canvas.width = w;
    this.canvas.height = h;
    const ctx = this.canvas.getContext('2d');
    ctx.putImageData(image, 0, 0);
    this.clipToBorder(ctx, x0, y0, dx, dy);
    const x1 = x0 + dx * w, y1 = y0 + dy * h;
    this.heatCorners = [fromMercator(x0, y0), fromMercator(x1, y0), fromMercator(x1, y1), fromMercator(x0, y1)];
    const source = map.getSource('heat');
    source.setCoordinates(this.heatCorners);
    source.play();
    source.pause();
    map.triggerRepaint();

    const show = (v) => METRICS[heatMetric].format(useValue ? Math.exp(v) : v);
    this.handlers.onLegend(useValue
      ? { title: METRICS[heatMetric].title, gradient: ramp(this.theme, diverging), low: show(lo), high: show(hi), note: heatMetric === metric ? 'Zglajeno okoli vsake točke' : 'Rast je na voljo pri prikazu Območja' }
      : { title: 'Gostota poslov', gradient: ramp(this.theme, false), low: 'manj', high: 'več', note: 'Zglajeno okoli vsake točke' });
  }

  clipToBorder(ctx, x0, y0, dx, dy) {
    if (!this.borderRings) return;
    ctx.globalCompositeOperation = 'destination-in';
    ctx.beginPath();
    for (const ring of this.borderRings) {
      ring.forEach(([mx, my], i) => {
        const x = (mx - x0) / dx, y = (my - y0) / dy;
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      });
      ctx.closePath();
    }
    ctx.fill('evenodd');
    ctx.globalCompositeOperation = 'source-over';
  }

  drawPoints() {
    const { state, list } = this.view;
    const { store, map } = this;
    const metric = METRICS[state.metric].heat && state.metric !== 'count' ? state.metric : 'em';
    const bounds = map.getBounds();
    const [w, s, e, n] = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];

    // Sales in one building share a coordinate, so one dot stands for all of them.
    const grouped = new Map();
    const values = [];
    let inView = 0;
    for (let j = 0; j < list.length; j++) {
      const i = list[j];
      if (!(store.lon[i] >= w && store.lon[i] <= e && store.lat[i] >= s && store.lat[i] <= n)) continue;
      inView++;
      const key = `${store.lon[i]},${store.lat[i]}`;
      const spot = grouped.get(key);
      if (spot) spot.push(i); else grouped.set(key, [i]);
      const v = this.valueOf(metric, i);
      if (v === v) values.push(v);
    }

    const spots = [...grouped.values()];
    const step = Math.max(1, spots.length / MAX_POINTS);
    const scale = classes(metric, values, this.theme);
    const features = [];
    this.spots = new Map();
    for (let at = 0; at < spots.length; at += step) {
      const spot = spots[Math.floor(at)].sort((a, b) => store.m[b] - store.m[a]);
      const [i] = spot;
      const v = median(spot.map((sale) => this.valueOf(metric, sale)).filter((value) => value === value));
      this.spots.set(i, spot);
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [store.lon[i], store.lat[i]] },
        properties: { i, c: scale && v === v ? scale.color(v) : '#8a877d' },
      });
    }
    map.getSource('points').setData({ type: 'FeatureCollection', features });
    const legend = this.areaLegend(metric, scale);
    legend.note = step > 1
      ? `Prikazanih ${count(features.length)} od ${count(spots.length)} lokacij. Približajte.`
      : `${count(inView)} poslov v pogledu. Kliknite točko.`;
    this.handlers.onLegend(legend);
  }

  popup(lngLat, html) {
    this.activePopup?.remove();
    this.activePopup = new maplibregl.Popup({ maxWidth: '300px', closeButton: true }).setLngLat(lngLat).setHTML(html).addTo(this.map);
    return this.activePopup.getElement();
  }

  resize() {
    this.map.resize();
  }
}
