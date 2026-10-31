// Number formats and the colour scales shared by the map and the charts.
import { quantile } from './store.js';

const whole = new Intl.NumberFormat('sl-SI', { maximumFractionDigits: 0, useGrouping: 'always' });
const oneDigit = new Intl.NumberFormat('sl-SI', { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: 'always' });
const twoDigits = new Intl.NumberFormat('sl-SI', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const count = (v) => whole.format(v);

export function money(v) {
  if (!Number.isFinite(v)) return '–';
  if (Math.abs(v) >= 1e9) return `${oneDigit.format(v / 1e9)} mrd €`;
  if (Math.abs(v) >= 1e6) return `${oneDigit.format(v / 1e6)} mio €`;
  return `${whole.format(v)} €`;
}

export function perM2(v) {
  if (!Number.isFinite(v)) return '–';
  if (v >= 100) return `${whole.format(v)} €/m²`;
  if (v >= 10) return `${oneDigit.format(v)} €/m²`;
  return `${twoDigits.format(v)} €/m²`;
}

export const percent = (v) => (Number.isFinite(v) ? `${v > 0 ? '+' : ''}${whole.format(v * 100)} %` : '–');
export const ratio = (v) => (Number.isFinite(v) ? twoDigits.format(v) : '–');

export const METRICS = {
  em: { label: '€/m²', title: 'Mediana cene na m²', format: perM2, diverging: false, heat: true },
  price: { label: 'Cena', title: 'Mediana pogodbene cene', format: money, diverging: false, heat: true },
  count: { label: 'Št. poslov', title: 'Število poslov', format: count, diverging: false, heat: true },
  growth: { label: 'Rast', title: 'Rast mediane €/m² v izbranem obdobju', format: percent, diverging: true, center: 0, heat: false },
  ratio: { label: 'Cena / GURS', title: 'Pogodbena cena / posplošena vrednost', format: ratio, diverging: true, center: 1, heat: true },
};

// Semantic heat for magnitude; lightness runs toward the surface so low values recede.
const RAMPS = {
  light: {
    seq: ['#fdeccb', '#fbd08a', '#f6ab5d', '#ec8142', '#d6582b', '#ac381c', '#742112'],
    div: ['#184f95', '#3987e5', '#9ec5f4', '#ece9e0', '#f4b8a0', '#e0663c', '#a82c14'],
  },
  dark: {
    seq: ['#51200f', '#7d2f13', '#ad4217', '#d9621f', '#f08a33', '#f8b562', '#fde0ae'],
    div: ['#6da7ec', '#3f7fd0', '#23508a', '#383835', '#8a3a1e', '#d0562a', '#f29468'],
  },
};

export const ramp = (theme, diverging) => RAMPS[theme][diverging ? 'div' : 'seq'];

// Seven classes: quantiles for magnitudes, symmetric around the neutral value for polarity.
export function classes(metric, values, theme) {
  const info = METRICS[metric];
  const palette = ramp(theme, info.diverging);
  const sorted = Float64Array.from(values.filter(Number.isFinite)).sort();
  if (!sorted.length) return null;
  let thresholds;
  if (info.diverging) {
    const spread = Float64Array.from(sorted, (v) => Math.abs(v - info.center)).sort();
    const reach = quantile(spread, 0.92) || 0.1;
    thresholds = [-5, -3, -1, 1, 3, 5].map((k) => info.center + (k / 6) * reach);
  } else {
    thresholds = [1, 2, 3, 4, 5, 6].map((k) => quantile(sorted, k / 7));
    thresholds = [...new Set(thresholds.map((v) => Number(v.toPrecision(2))))];
  }
  const steps = thresholds.length;
  const colorIndex = (bin) => (info.diverging ? bin : Math.round((bin * 6) / Math.max(steps, 1)));
  const bin = (v) => {
    let b = 0;
    while (b < steps && v >= thresholds[b]) b++;
    return b;
  };
  return {
    thresholds, palette,
    bin: (v) => colorIndex(bin(v)),
    color: (v) => palette[colorIndex(bin(v))],
    swatches: Array.from({ length: steps + 1 }, (_, b) => palette[colorIndex(b)]),
  };
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// 256-entry RGB lookup for the continuous heat surface.
export function lookup(colors) {
  const stops = colors.map(hexToRgb);
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const at = (i / 255) * (stops.length - 1);
    const low = Math.min(Math.floor(at), stops.length - 2);
    const mix = at - low;
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = stops[low][c] + (stops[low + 1][c] - stops[low][c]) * mix;
  }
  return lut;
}
