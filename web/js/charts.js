// Small hand-written SVG charts. Each one paints into a container, wires its own hover,
// and leaves the tooltip to a single shared element.

const tip = () => document.getElementById('tip');

export function showTip(html, x, y) {
  const el = tip();
  el.innerHTML = html;
  el.hidden = false;
  const { width, height } = el.getBoundingClientRect();
  const left = x + 14 + width > window.innerWidth ? x - width - 14 : x + 14;
  const top = Math.max(6, Math.min(window.innerHeight - height - 6, y - height / 2));
  el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}

export const hideTip = () => { tip().hidden = true; };

function ticks(lo, hi, wanted = 4) {
  const span = hi - lo || Math.abs(hi) || 1;
  const raw = span / wanted;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const out = [];
  for (let v = Math.floor(lo / step) * step; v <= hi + step * 0.999; v += step) out.push(Number(v.toPrecision(10)));
  return out;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

function legendHtml(series) {
  if (series.length < 2) return '';
  return `<div class="legend">${series.map((s) => `
    <span class="key${s.dim ? ' is-dim' : ''}"><i style="background:${s.color}"></i>${esc(s.label)}</span>`).join('')}</div>`;
}

function tipRows(title, rows) {
  return `<div class="tip-title">${esc(title)}</div>${rows.map((r) => `
    <div class="tip-row">${r.color ? `<i style="background:${r.color}"></i>` : ''}<span>${esc(r.label)}</span><b>${esc(r.value)}</b></div>`).join('')}`;
}

// opts: x[], series[{label,color,values,dim}], format, formatAxis, height, partialFrom, baseline
export function lineChart(el, opts) {
  const { x, series, format, height = 190, partialFrom = Infinity, baseline = null } = opts;
  const axis = opts.formatAxis || format;
  const width = Math.max(150, el.clientWidth);
  const hasValues = series.some((s) => s.values.some(Number.isFinite));
  if (!hasValues) {
    el.innerHTML = '<p class="empty">Premalo poslov za izbrani filter.</p>';
    return;
  }
  const all = series.flatMap((s) => s.values.filter(Number.isFinite));
  if (baseline !== null) all.push(baseline);
  let lo = Math.min(...all), hi = Math.max(...all);
  if (opts.fromZero) lo = 0;
  const yTicks = ticks(lo, hi);
  lo = yTicks[0]; hi = yTicks[yTicks.length - 1];
  const m = { l: 46, r: 10, t: 10, b: 24 };
  const iw = width - m.l - m.r, ih = height - m.t - m.b;
  const px = (i) => m.l + (x.length > 1 ? (i / (x.length - 1)) * iw : iw / 2);
  const py = (v) => m.t + ih - ((v - lo) / (hi - lo || 1)) * ih;

  const grid = yTicks.map((t) => `
    <line class="grid" x1="${m.l}" x2="${width - m.r}" y1="${py(t)}" y2="${py(t)}"/>
    <text class="tick" x="${m.l - 7}" y="${py(t) + 3.5}" text-anchor="end">${esc(axis(t))}</text>`).join('');
  const every = Math.ceil(x.length / Math.max(2, Math.floor(iw / 58)));
  const xLabels = x.map((label, i) => (i % every === 0 ? `<text class="tick" x="${px(i)}" y="${height - 6}" text-anchor="middle">${esc(label)}</text>` : '')).join('');

  const lines = series.map((s) => {
    const solid = [], faint = [];
    let open = false;
    s.values.forEach((v, i) => {
      if (!Number.isFinite(v)) { open = false; return; }
      const cmd = `${open ? 'L' : 'M'}${px(i).toFixed(1)} ${py(v).toFixed(1)}`;
      if (i <= partialFrom) solid.push(cmd);
      if (i >= partialFrom) faint.push(`${faint.length ? 'L' : 'M'}${px(i).toFixed(1)} ${py(v).toFixed(1)}`);
      open = true;
    });
    const last = s.values.reduce((at, v, i) => (Number.isFinite(v) ? i : at), -1);
    const end = !s.dim && last >= 0
      ? `<circle class="dot" cx="${px(last)}" cy="${py(s.values[last])}" r="4" fill="${s.color}"/>` : '';
    return `<g class="${s.dim ? 'is-dim' : ''}">
      <path class="line" d="${solid.join('')}" stroke="${s.color}"/>
      ${faint.length > 1 ? `<path class="line is-partial" d="${faint.join('')}" stroke="${s.color}"/>` : ''}${end}</g>`;
  }).join('');

  const rule = baseline !== null ? `<line class="base" x1="${m.l}" x2="${width - m.r}" y1="${py(baseline)}" y2="${py(baseline)}"/>` : '';
  el.innerHTML = `${legendHtml(series)}
    <svg class="chart" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(opts.label || '')}">
      ${grid}${rule}${xLabels}${lines}
      <line class="cross" y1="${m.t}" y2="${m.t + ih}" visibility="hidden"/>
      <rect class="hit" x="${m.l}" y="${m.t}" width="${iw}" height="${ih}"/>
    </svg>`;

  const svg = el.querySelector('svg');
  const cross = svg.querySelector('.cross');
  const hit = svg.querySelector('.hit');
  hit.addEventListener('pointermove', (e) => {
    const box = svg.getBoundingClientRect();
    const i = Math.max(0, Math.min(x.length - 1, Math.round(((e.clientX - box.left - m.l) / iw) * (x.length - 1))));
    cross.setAttribute('x1', px(i));
    cross.setAttribute('x2', px(i));
    cross.setAttribute('visibility', 'visible');
    const rows = series
      .filter((s) => Number.isFinite(s.values[i]))
      .sort((a, b) => b.values[i] - a.values[i])
      .map((s) => ({ label: s.label, value: format(s.values[i]) + (s.notes?.[i] ? ` · ${s.notes[i]}` : ''), color: s.color }));
    showTip(tipRows(x[i] + (i >= partialFrom ? ' · nepopolno' : ''), rows.length ? rows : [{ label: 'Premalo poslov', value: '' }]), e.clientX, e.clientY);
  });
  hit.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); hideTip(); });
}

// opts: x[], series[{label,color,values}], format, height
export function stackedColumns(el, opts) {
  const { x, series, format, height = 200 } = opts;
  const axis = opts.formatAxis || format;
  const width = Math.max(240, el.clientWidth);
  const totals = x.map((_, i) => series.reduce((sum, s) => sum + (s.values[i] || 0), 0));
  const max = Math.max(...totals);
  if (!max) {
    el.innerHTML = '<p class="empty">Ni poslov za izbrani filter.</p>';
    return;
  }
  const yTicks = ticks(0, max);
  const top = yTicks[yTicks.length - 1];
  const m = { l: 46, r: 6, t: 10, b: 24 };
  const iw = width - m.l - m.r, ih = height - m.t - m.b;
  const band = iw / x.length;
  const bar = Math.min(24, band * 0.62);
  const py = (v) => m.t + ih - (v / top) * ih;

  const grid = yTicks.map((t) => `
    <line class="grid" x1="${m.l}" x2="${width - m.r}" y1="${py(t)}" y2="${py(t)}"/>
    <text class="tick" x="${m.l - 7}" y="${py(t) + 3.5}" text-anchor="end">${esc(axis(t))}</text>`).join('');

  const columns = x.map((label, i) => {
    const cx = m.l + band * i + band / 2;
    const left = cx - bar / 2;
    let base = 0;
    const present = series.filter((s) => s.values[i] > 0);
    const marks = present.map((s, k) => {
      const v = s.values[i];
      const y1 = py(base + v), y0 = py(base);
      base += v;
      const gap = k === present.length - 1 ? 0 : 2;
      const h = Math.max(0.5, y0 - y1 - gap);
      const y = y1 + gap;
      if (k < present.length - 1) return `<rect x="${left}" y="${y}" width="${bar}" height="${h}" fill="${s.color}"/>`;
      const r = Math.min(4, h, bar / 2);
      return `<path d="M${left} ${y + h}V${y + r}Q${left} ${y} ${left + r} ${y}H${left + bar - r}Q${left + bar} ${y} ${left + bar} ${y + r}V${y + h}Z" fill="${s.color}"/>`;
    }).join('');
    return `${marks}<text class="tick" x="${cx}" y="${height - 6}" text-anchor="middle">${esc(label)}</text>
      <rect class="hit" data-i="${i}" x="${m.l + band * i}" y="${m.t}" width="${band}" height="${ih}"/>`;
  }).join('');

  el.innerHTML = `${legendHtml(series)}
    <svg class="chart" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(opts.label || '')}">${grid}${columns}</svg>`;
  el.querySelectorAll('.hit').forEach((r) => {
    r.addEventListener('pointermove', (e) => {
      const i = Number(r.dataset.i);
      const rows = series.filter((s) => s.values[i] > 0).reverse().map((s) => ({ label: s.label, value: format(s.values[i]), color: s.color }));
      rows.push({ label: 'Skupaj', value: format(totals[i]) });
      showTip(tipRows(x[i], rows), e.clientX, e.clientY);
    });
    r.addEventListener('pointerleave', hideTip);
  });
}

// opts: values[], from, to, step, marker{value,label}, reference{value,label}, color, format
export function histogram(el, opts) {
  const { values, from, to, step, color, marker, reference, format, height = 160 } = opts;
  if (values.length < 5) {
    el.innerHTML = '<p class="empty">Premalo poslov z znano vrednostjo GURS.</p>';
    return;
  }
  const bins = new Array(Math.round((to - from) / step)).fill(0);
  for (const v of values) {
    const at = Math.max(0, Math.min(bins.length - 1, Math.floor((v - from) / step)));
    bins[at]++;
  }
  const width = Math.max(240, el.clientWidth);
  const m = { l: 10, r: 10, t: 22, b: 24 };
  const iw = width - m.l - m.r, ih = height - m.t - m.b;
  const band = iw / bins.length;
  const max = Math.max(...bins);
  const px = (v) => m.l + ((v - from) / (to - from)) * iw;
  const bars = bins.map((n, i) => {
    const h = (n / max) * ih;
    const x = m.l + band * i + 1, w = Math.max(1, band - 2), y = m.t + ih - h;
    const r = Math.min(3, w / 2, h);
    return `<path d="M${x} ${y + h}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y + h}Z" fill="${color}"/>
      <rect class="hit" data-i="${i}" x="${m.l + band * i}" y="${m.t}" width="${band}" height="${ih}"/>`;
  }).join('');
  const labels = [];
  for (let v = from; v <= to + 1e-9; v += 0.5) {
    labels.push(`<text class="tick" x="${px(v)}" y="${height - 6}" text-anchor="middle">${format(v)}</text>`);
  }
  const flag = (item, cls, anchor) => `<line class="${cls}" x1="${px(item.value)}" x2="${px(item.value)}" y1="${m.t - 4}" y2="${m.t + ih}"/>
    <text class="flag" x="${px(item.value) + (anchor === 'end' ? -5 : 5)}" y="${m.t - 9}" text-anchor="${anchor}">${esc(item.label)}</text>`;
  const medianRight = marker.value >= reference.value;
  el.innerHTML = `<svg class="chart" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(opts.label || '')}">
      <line class="base-solid" x1="${m.l}" x2="${width - m.r}" y1="${m.t + ih}" y2="${m.t + ih}"/>${bars}${labels.join('')}
      ${flag(reference, 'base', medianRight ? 'end' : 'start')}${flag(marker, 'mark', medianRight ? 'start' : 'end')}
    </svg>`;
  el.querySelectorAll('.hit').forEach((r) => {
    r.addEventListener('pointermove', (e) => {
      const i = Number(r.dataset.i);
      const lo = from + i * step;
      const share = (bins[i] / values.length) * 100;
      showTip(tipRows(`${format(lo)} – ${format(lo + step)}`, [
        { label: 'Posli', value: bins[i].toLocaleString('sl-SI') },
        { label: 'Delež', value: `${share.toLocaleString('sl-SI', { maximumFractionDigits: 1 })} %` },
      ]), e.clientX, e.clientY);
    });
    r.addEventListener('pointerleave', hideTip);
  });
}

export function table(headers, rows) {
  return `<table class="data"><thead><tr>${headers.map((h, i) => `<th${i ? ' class="num"' : ''}>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((row) => `<tr>${row.map((c, i) => `<td${i ? ' class="num"' : ''}>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}
