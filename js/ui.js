// Malachite UI components (design handoff 3a): number pills, wedge rating
// slider, swipe-to-rate rows and the rankings podium.

import { fmt } from './scoring.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const haptic = () => { try { navigator.vibrate?.(6); } catch { /* not supported */ } };
const capture = (el, id) => { try { el.setPointerCapture(id); } catch { /* pointer already gone */ } };

// ---------- Number grammar ----------
// My rating: filled pill, 1 decimal. Unrated: dashed pill. Calculated: outlined
// pill with ø and 2 decimals. Elo: mono text, never a pill.
export const fmtCalc = (v) => (v == null ? '–' : v.toFixed(2));

export function ratingPill(v, { size = 'md', rateRef = null, compact = false } = {}) {
  const attrs = rateRef ? ` role="button" tabindex="0" data-rate="${rateRef}" aria-label="${v == null ? 'Rate' : `Rating ${fmt(v)}, change`}"` : '';
  if (v == null) return `<span class="pill unrated ${size}"${attrs}>${compact ? '+' : '+ Rate'}</span>`;
  return `<span class="pill rate ${size}"${attrs}>${fmt(v)}</span>`;
}

export function calcPill(v, { size = 'md' } = {}) {
  return `<span class="pill calc ${size}${v == null ? ' empty' : ''}">ø ${fmtCalc(v)}</span>`;
}

export function eloText(rec) {
  return `<span class="elo">Elo ${Math.round(rec.elo)} · ${rec.wins}W ${rec.losses}L</span>`;
}

export function changeText(from, to) {
  const dir = from == null ? '' : to > from ? ' <b class="up">↑</b>' : ' <b class="down">↓</b>';
  return `<span class="change">${from == null ? '<span class="muted">unrated</span>' : fmt(from)} → ${fmt(to)}${dir}</span>`;
}

// ---------- Wedge slider ----------
// 19 bars for 1.0 to 10.0 in half steps, rising in height and colour
// (Charcoal → Sea Green → Malachite). Drag or tap, snaps to half steps.
const BARS = 19;
const barValue = (i) => 1 + i * 0.5;
const barColor = (i) => { const t = i / (BARS - 1); return `oklch(${(0.42 + 0.37 * t).toFixed(3)} ${(0.02 + 0.19 * t).toFixed(3)} 145)`; };

export function wedge(value, onCommit, { size = 'md', onPreview } = {}) {
  const el = document.createElement('div');
  el.className = `wedge ${size}`;
  el.setAttribute('role', 'slider');
  el.setAttribute('aria-valuemin', '1');
  el.setAttribute('aria-valuemax', '10');
  el.tabIndex = 0;
  const [base, step] = size === 'lg' ? [14, 3.4] : [10, 2.6];
  el.innerHTML = `
    <div class="wedge-bars">${Array.from({ length: BARS }, (_, i) => `<span class="bar" style="height:${base + i * step}px;--c:${barColor(i)}"><i class="bubble"></i></span>`).join('')}</div>
    <div class="wedge-labels">${Array.from({ length: 10 }, (_, i) => `<span style="left:${(((i * 2 + 0.5) / BARS) * 100).toFixed(2)}%">${i + 1}</span>`).join('')}</div>`;
  const bars = [...el.querySelectorAll('.bar')];
  let current = value;

  const draw = (v) => {
    bars.forEach((b, i) => {
      b.classList.toggle('on', v != null && barValue(i) <= v);
      b.classList.toggle('cur', v != null && barValue(i) === v);
      b.querySelector('.bubble').textContent = v != null && barValue(i) === v ? fmt(v) : '';
    });
    el.setAttribute('aria-valuenow', v ?? '');
    el.setAttribute('aria-valuetext', v == null ? 'Not rated' : fmt(v));
  };
  const valueAt = (clientX) => {
    const r = el.querySelector('.wedge-bars').getBoundingClientRect();
    const i = Math.round(((clientX - r.left) / r.width) * BARS - 0.5);
    return barValue(Math.min(BARS - 1, Math.max(0, i)));
  };
  let dragging = false;
  const preview = (v) => { if (v !== current) { current = v; haptic(); draw(v); onPreview?.(v); } };
  el.addEventListener('pointerdown', (e) => {
    if (e.button) return;
    dragging = true;
    capture(el, e.pointerId);
    preview(valueAt(e.clientX));
  });
  el.addEventListener('pointermove', (e) => { if (dragging) preview(valueAt(e.clientX)); });
  const end = () => { if (!dragging) return; dragging = false; onCommit(current); };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('keydown', (e) => {
    const d = { ArrowRight: 0.5, ArrowUp: 0.5, ArrowLeft: -0.5, ArrowDown: -0.5 }[e.key];
    if (!d) return;
    e.preventDefault();
    const v = Math.min(10, Math.max(1, (current ?? 5.5) + d));
    preview(v);
    onCommit(v);
  });
  el.set = (v) => { current = v; draw(v); };
  draw(value);
  return el;
}

// Slider inside a labelled panel with a Clear action.
export function wedgePanel(label, value, onCommit, opts = {}) {
  const panel = document.createElement('div');
  panel.className = 'slider-panel';
  panel.innerHTML = `<div class="slider-head"><span class="label">${esc(label)}</span><button class="link" data-clear ${value == null ? 'hidden' : ''}>Clear</button></div>`;
  const w = wedge(value, (v) => { clear.hidden = v == null; onCommit(v); }, opts);
  const clear = panel.querySelector('[data-clear]');
  clear.onclick = () => { w.set(null); clear.hidden = true; onCommit(null); };
  panel.append(w);
  return panel;
}

// ---------- Swipe a list row left to rate it in place ----------
// Reveals three numbers (rating −1, current, +1). Keep dragging sideways over
// them and release to save, or tap one.
const CELL = 52;
export function enableSwipeRate(list, { getValue, onCommit }) {
  let g = null;
  let suppressClick = false;

  const cellsFor = (v) => {
    const c = v ?? 7;
    return [...new Set([c - 1, c, c + 1].map(x => Math.min(10, Math.max(1, x))))];
  };
  const close = (wrap) => { wrap.classList.remove('open'); wrap.querySelector('.row').style.transform = ''; };
  const closeAll = () => list.querySelectorAll('.swipe.open').forEach(close);

  const open = (wrap) => {
    const ref = wrap.dataset.swipe;
    const v = getValue(ref);
    const strip = wrap.querySelector('.swipe-strip');
    const cells = cellsFor(v);
    strip.style.width = `${cells.length * CELL}px`;
    strip.innerHTML = cells.map(x => `<button type="button" class="cell${x === v ? ' cur' : ''}" data-v="${x}">${fmt(x)}</button>`).join('');
    wrap.classList.add('open');
    wrap.querySelector('.row').style.transform = `translateX(-${cells.length * CELL}px)`;
  };
  const hotAt = (wrap, x, y) => {
    let hit = null;
    wrap.querySelectorAll('.cell').forEach(c => {
      const r = c.getBoundingClientRect();
      const on = x >= r.left && x <= r.right && y >= r.top - 20 && y <= r.bottom + 20;
      c.classList.toggle('hot', on);
      if (on) hit = c;
    });
    return hit;
  };

  list.addEventListener('pointerdown', (e) => {
    const wrap = e.target.closest('.swipe');
    if (!wrap || e.button || e.target.closest('.cell')) return;
    list.querySelectorAll('.swipe.open').forEach(w => { if (w !== wrap) close(w); });
    g = { wrap, x: e.clientX, y: e.clientY, active: false, id: e.pointerId, hot: null };
  });
  list.addEventListener('pointermove', (e) => {
    if (!g || e.pointerId !== g.id) return;
    const dx = g.x - e.clientX;
    const dy = Math.abs(e.clientY - g.y);
    if (!g.active) {
      if (dy > 12) { g = null; return; }
      if (dx > 14) {
        g.active = true;
        capture(g.wrap, e.pointerId);
        open(g.wrap);
        haptic();
      }
      return;
    }
    const hit = hotAt(g.wrap, e.clientX, e.clientY);
    if (hit !== g.hot) { g.hot = hit; if (hit) haptic(); }
  });
  const end = (e) => {
    if (!g || e.pointerId !== g.id) return;
    if (g.active) {
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 350);
      if (g.hot) {
        const ref = g.wrap.dataset.swipe;
        const v = Number(g.hot.dataset.v);
        close(g.wrap);
        onCommit(ref, v);
      }
    }
    g = null;
  };
  list.addEventListener('pointerup', end);
  list.addEventListener('pointercancel', end);
  list.addEventListener('click', (e) => {
    const cell = e.target.closest('.cell');
    if (cell) {
      e.preventDefault();
      const wrap = cell.closest('.swipe');
      close(wrap);
      onCommit(wrap.dataset.swipe, Number(cell.dataset.v));
      return;
    }
    if (suppressClick) { e.preventDefault(); e.stopPropagation(); return; }
    const openWrap = e.target.closest('.swipe.open');
    if (openWrap) { e.preventDefault(); e.stopPropagation(); close(openWrap); }
  }, true);
  document.addEventListener('pointerdown', (e) => { if (!list.contains(e.target)) closeAll(); });
}

// ---------- Podium (order 2, 1, 3) ----------
export function podium(entries) {
  // entries: [{ href, art, title, value }] for places 1..3
  const order = [1, 0, 2];
  return `<div class="podium">${order.filter(i => entries[i]).map(i => {
    const e = entries[i];
    return `<a class="pod p${i + 1}" href="${e.href}">${e.art}<span class="pod-title">${esc(e.title)}</span>
      <span class="pod-block"><b>${i + 1}</b><span>${e.value}</span></span></a>`;
  }).join('')}</div>`;
}
